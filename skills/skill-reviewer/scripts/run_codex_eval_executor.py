#!/usr/bin/env python3
"""Execute one locked skill eval assignment with the local Codex CLI.

The adapter keeps the eval runtime agent-agnostic while turning Codex's
observable JSONL stream into the append-only Agent Trace contract. It records
the spawned process in a dispatch receipt and digest-binds the redacted source
stream. It never records hidden reasoning. ``--full-access`` is explicit and
is retained as ``local-unattested`` provenance rather than being presented as
sandbox proof.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from skill_eval_authority import safe_artifact, sha256_file
from skill_eval_contracts import ManifestError
from skill_eval_execution import (
    ManagedProviderProcess,
    ProviderSpec,
    build_provider_environment,
    compact_json,
    contains_credential,
    load_locked_assignment,
    redact_retained_credentials,
    redact_text,
    sanitize_observable,
    sha256_text,
)
from skill_eval_runtime import (
    finalize_execution,
    record_dispatch_receipt,
    record_trace_event,
)


CAPTURE_SOURCE = "provider_stream"
CODEX_TARGET = "codex-cli"
CODEX_HARNESS = "codex-exec-jsonl"
RAW_EVENT_ARTIFACT = "agent-source-events.jsonl"
SOURCE_FORMAT = "codex-exec-jsonl-v1"
STDERR_ARTIFACT = "codex-stderr.log"
LAST_MESSAGE_FALLBACK = "codex-last-message.md"
CODEX_PROVIDER = ProviderSpec(
    label="Codex",
    target=CODEX_TARGET,
    harness=CODEX_HARNESS,
    source_artifact=RAW_EVENT_ARTIFACT,
    source_format=SOURCE_FORMAT,
    stderr_artifact=STDERR_ARTIFACT,
    required_capabilities=("jsonl-agent-events",),
    full_access_capability="danger-full-access",
)
SKILL_ROOT_PATTERN = re.compile(r"^- `(?P<alias>r\d+)` = `(?P<root>[^`]+)`$", re.M)
SKILL_FILE_PATTERN = re.compile(r"\(file: (?P<path>[^)]+/SKILL\.md)\)")
NETWORK_COMMAND_PATTERN = re.compile(
    r"(?:^|[\s;&|])(?:curl|wget|ssh|scp|rsync)(?:\s|$)|"
    r"\bgit\s+(?:clone|fetch|pull|push)\b|"
    r"\b(?:npm|pnpm|yarn|pip|pip3|brew)\s+(?:add|install|update)\b",
    re.I,
)
EXTERNAL_SIDE_EFFECT_PATTERN = re.compile(
    r"\bgit\s+push\b|\bgh\s+pr\s+(?:create|merge)\b|"
    r"\b(?:lark|bytedcli)\b.*\b(?:send|create|update|delete|publish)\b",
    re.I,
)


def _prompt_input_texts(payload: Any) -> list[str]:
    if not isinstance(payload, list):
        raise ManifestError("Codex prompt-input inspection must return a JSON array")
    texts: list[str] = []
    for message in payload:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                texts.append(item["text"])
    return texts


def _parse_visible_skill_paths(payload: Any) -> tuple[list[str], str]:
    texts = _prompt_input_texts(payload)
    joined = "\n".join(texts)
    roots = {
        match.group("alias"): match.group("root")
        for match in SKILL_ROOT_PATTERN.finditer(joined)
    }
    paths: set[str] = set()
    for match in SKILL_FILE_PATTERN.finditer(joined):
        raw = match.group("path")
        first, separator, remainder = raw.partition("/")
        resolved = Path(roots[first]) / remainder if separator and first in roots else Path(raw)
        if resolved.is_absolute():
            paths.add(str(resolved.resolve(strict=False)))
    if "<skills_instructions>" in joined and not paths:
        raise ManifestError(
            "Codex exposed skills to the model, but their paths could not be isolated"
        )
    return sorted(paths), sha256_text(compact_json(payload))


def _run_prompt_input_probe(
    *,
    codex_bin: str,
    cwd: Path,
    environment: dict[str, str],
    skills_config: str | None = None,
) -> tuple[list[str], str]:
    command = [codex_bin, "debug", "prompt-input"]
    if skills_config is not None:
        command.extend(["-c", f"skills.config={skills_config}"])
    command.append("SKILL_EVAL_ISOLATION_PROBE")
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            text=True,
            capture_output=True,
            timeout=90,
            check=False,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ManifestError(f"unable to inspect Codex model-visible skills: {error}") from error
    if result.returncode != 0:
        diagnostic = (result.stderr or result.stdout).strip()[:1000]
        raise ManifestError(
            f"Codex model-visible skill inspection failed ({result.returncode}): {diagnostic}"
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ManifestError("Codex prompt-input inspection returned invalid JSON") from error
    return _parse_visible_skill_paths(payload)


def _toml_skill_config(paths: list[str]) -> str:
    # JSON string quoting is also valid for TOML basic strings.
    return "[" + ",".join(
        "{path=" + json.dumps(path, ensure_ascii=False) + ",enabled=false}"
        for path in paths
    ) + "]"


def isolate_model_visible_skills(
    *, codex_bin: str, cwd: Path, environment: dict[str, str]
) -> dict[str, Any]:
    visible, discovery_digest = _run_prompt_input_probe(
        codex_bin=codex_bin,
        cwd=cwd,
        environment=environment,
    )
    config = _toml_skill_config(visible)
    remaining, verification_digest = _run_prompt_input_probe(
        codex_bin=codex_bin,
        cwd=cwd,
        environment=environment,
        skills_config=config,
    )
    if remaining:
        raise ManifestError(
            "Codex skill isolation failed; model-visible skills remain enabled: "
            + ", ".join(remaining[:5])
        )
    return {
        "config": config,
        "disabled_count": len(visible),
        "disabled_paths_digest": sha256_text("\n".join(visible)),
        "discovery_digest": discovery_digest,
        "verification_digest": verification_digest,
    }


def _codex_version(codex_bin: str, *, environment: dict[str, str]) -> str:
    try:
        result = subprocess.run(
            [codex_bin, "--version"],
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable"
    return (result.stdout or result.stderr).strip()[:200] or "unavailable"


def _configuration_instruction(assignment: dict[str, Any]) -> str:
    configuration = assignment.get("configuration")
    if not isinstance(configuration, dict):
        raise ManifestError("assignment.configuration must be an object")
    kind = configuration.get("kind")
    skill_path = configuration.get("skill_path")
    if kind == "without_skill":
        if skill_path is not None:
            raise ManifestError("without_skill assignment must not expose a skill path")
        return (
            "实验臂：未使用 Skill。不要查找、加载或调用任何环境 Skill；"
            "只根据评测问题与声明的输入完成任务。"
        )
    if kind not in {"with_skill", "old_skill"} or not isinstance(skill_path, str):
        raise ManifestError("assignment configuration is not a supported eval arm")
    snapshot = Path(skill_path).resolve()
    if not (snapshot / "SKILL.md").is_file():
        raise ManifestError("locked skill snapshot is missing SKILL.md")
    label = "候选版 Skill" if kind == "with_skill" else "旧版 Skill 对照"
    return (
        f"实验臂：{label}。开始任务前必须读取并遵循且仅遵循这个锁定快照："
        f"{snapshot / 'SKILL.md'}。不要使用本机安装的同名或其他 Skill。"
    )


def build_executor_prompt(
    *, assignment: dict[str, Any], assignment_path: Path, repeat_root: Path, full_access: bool
) -> str:
    input_files = assignment.get("input_files")
    if not isinstance(input_files, list):
        raise ManifestError("assignment.input_files must be an array")
    inputs: list[str] = []
    for record in input_files:
        if not isinstance(record, dict) or not isinstance(record.get("path"), str):
            raise ManifestError("assignment input file record is invalid")
        inputs.append(f"- {record.get('relative_path')}: {record['path']}")
    expected = assignment.get("expected_artifacts")
    assert isinstance(expected, list)
    permissions = assignment.get("permissions")
    if not isinstance(permissions, dict):
        raise ManifestError("assignment.permissions must be an object")
    access_note = (
        "CLI 进程拥有 danger-full-access；这只是为了采集真实本地执行效果，不代表隔离。"
        if full_access
        else "CLI 使用 workspace-write 沙箱。"
    )
    return "\n".join(
        [
            "你是单个、已锁定 Skill Eval Case 的执行 Agent。",
            "这是行为评测，不是让你修改评测器、eval、基线、候选 Skill 或 Git 状态。",
            _configuration_instruction(assignment),
            "环境中所有自动发现的 Skill 已由执行框架禁用；不要绕过这项隔离。",
            access_note,
            f"评测身份：run={assignment.get('run_id')} case={assignment.get('case_id')} "
            f"arm={assignment.get('arm')} repeat={assignment.get('repeat')}",
            f"锁定 assignment（只含执行输入，不含答案）：{assignment_path.resolve()}",
            f"唯一可写执行目录：{repeat_root}",
            "声明的输入文件：",
            *(inputs or ["- 无"]),
            "必须保留的输出（相对于唯一可写目录）：",
            *(f"- {path}" for path in expected),
            "权限声明：" + compact_json(permissions),
            "只读取上面声明的 Skill 快照、assignment 和输入文件。不要读取 execution-plan.json、"
            "run-lock.json、evals.json、断言、expected/answer-key、其他实验臂或历史输出。",
            "只在唯一可写目录中写入声明的输出；不要访问网络、发送消息、安装依赖、提交或推送 Git，"
            "除非权限声明明确允许。",
            "不要递归启动完整的 review/evolution 流程，也不要声称批准发布；只完成下面的用户任务。",
            "不要输出或写入隐藏思维过程。可以留下可观察的命令、工具结果、产物和最终答复。",
            "\n用户任务：\n" + str(assignment.get("prompt")),
            "\n完成后，在最终可见答复中直接给出任务结果。执行框架会把最终答复保留为输出产物。",
        ]
    )


def _relative_refs(item: dict[str, Any], repeat_root: Path) -> list[str]:
    candidates: list[str] = []
    changes = item.get("changes")
    if isinstance(changes, list):
        for change in changes:
            if isinstance(change, dict) and isinstance(change.get("path"), str):
                candidates.append(change["path"])
    if isinstance(item.get("path"), str):
        candidates.append(item["path"])
    refs: set[str] = set()
    for raw in candidates:
        path = Path(raw)
        absolute = path if path.is_absolute() else repeat_root / path
        try:
            refs.add(absolute.resolve(strict=False).relative_to(repeat_root).as_posix())
        except ValueError:
            continue
    return sorted(refs)


def _event_status(item: dict[str, Any]) -> str:
    exit_code = item.get("exit_code")
    if isinstance(exit_code, int):
        return "completed" if exit_code == 0 else "failed"
    raw = item.get("status")
    if raw in {"completed", "failed", "timed_out", "interrupted", "running"}:
        return str(raw)
    return "completed"


def _short_command(command: Any) -> str:
    value = command if isinstance(command, str) else compact_json(command)
    value = " ".join(value.split())
    return value[:180] + ("…" if len(value) > 180 else "")


def _map_codex_event(
    *, event: dict[str, Any], source_index: int, repeat_root: Path
) -> dict[str, Any] | None:
    event_type = event.get("type")
    base = {
        "source_event_index": source_index,
        "source_event_type": event_type,
    }
    if event_type == "thread.started":
        return {
            "kind": "tool_call",
            "summary": "Codex CLI 会话已启动",
            "status": "completed",
            "details": {**base, "thread_id": event.get("thread_id")},
            "artifact_refs": [],
        }
    if event_type == "turn.started":
        return {
            "kind": "tool_call",
            "summary": "Codex 开始执行当前 Eval Case",
            "status": "running",
            "details": base,
            "artifact_refs": [],
        }
    if event_type == "turn.completed":
        return {
            "kind": "tool_call",
            "summary": "Codex 已结束当前回合并上报用量",
            "status": "completed",
            "details": {**base, "usage": sanitize_observable(event.get("usage", {}))},
            "artifact_refs": [],
        }
    if event_type in {"turn.failed", "error"}:
        return {
            "kind": "error",
            "summary": "Codex 执行过程中报告错误",
            "status": "failed",
            "details": {**base, "error": sanitize_observable(event.get("error", event))},
            "artifact_refs": [],
        }
    if event_type != "item.completed":
        return None
    item = event.get("item")
    if not isinstance(item, dict):
        return {
            "kind": "error",
            "summary": "Codex 返回了无效的完成事件",
            "status": "failed",
            "details": base,
            "artifact_refs": [],
        }
    item_type = item.get("type")
    item_base = {
        **base,
        "source_item_id": item.get("id"),
        "source_item_type": item_type,
    }
    if item_type == "reasoning":
        return None
    if item_type == "agent_message":
        content = item.get("text", item.get("content", ""))
        return {
            "kind": "agent_message",
            "summary": "Agent 产生了一条可见答复",
            "status": _event_status(item),
            "details": {**item_base, "role": "assistant", "content": sanitize_observable(content)},
            "artifact_refs": [],
        }
    if item_type == "command_execution":
        command = item.get("command", item.get("argv", ""))
        return {
            "kind": "command",
            "summary": "执行命令：" + _short_command(command),
            "status": _event_status(item),
            "details": {**item_base, **sanitize_observable(item)},
            "artifact_refs": [],
        }
    if item_type == "file_change":
        refs = _relative_refs(item, repeat_root)
        return {
            "kind": "artifact_written" if refs else "tool_call",
            "summary": "Agent 写入了文件" if refs else "Codex 报告了文件变更",
            "status": _event_status(item),
            "details": {**item_base, **sanitize_observable(item)},
            "artifact_refs": refs,
        }
    if item_type == "error":
        return {
            "kind": "error",
            "summary": "Codex 返回了执行错误",
            "status": "failed",
            "details": {**item_base, **sanitize_observable(item)},
            "artifact_refs": [],
        }
    return {
        "kind": "tool_call",
        "summary": f"Codex 完成可观察事件：{item_type or 'unknown'}",
        "status": _event_status(item),
        "details": {**item_base, **sanitize_observable(item)},
        "artifact_refs": _relative_refs(item, repeat_root),
    }


def _command_from_event(event: dict[str, Any]) -> tuple[str, int | None] | None:
    if event.get("type") != "item.completed":
        return None
    item = event.get("item")
    if not isinstance(item, dict) or item.get("type") != "command_execution":
        return None
    raw = item.get("command", item.get("argv"))
    command = raw if isinstance(raw, str) else compact_json(raw)
    exit_code = item.get("exit_code")
    return command, exit_code if isinstance(exit_code, int) else None


def _observed_policy_findings(
    *, commands: list[tuple[str, int | None]], permissions: dict[str, Any]
) -> tuple[list[str], list[str]]:
    forbidden: list[str] = []
    side_effects: list[str] = []
    for command, exit_code in commands:
        short = _short_command(command)
        if permissions.get("network") == "deny" and NETWORK_COMMAND_PATTERN.search(command):
            forbidden.append(f"检测到 network=deny 下的联网型命令：{short}")
        if (
            permissions.get("external_side_effects") == "deny"
            and EXTERNAL_SIDE_EFFECT_PATTERN.search(command)
        ):
            forbidden.append(f"检测到 external_side_effects=deny 下的外部变更命令：{short}")
            if exit_code == 0:
                side_effects.append(f"外部变更命令执行成功：{short}")
    return list(dict.fromkeys(forbidden)), list(dict.fromkeys(side_effects))


def _record(
    *, assignment_path: Path, workspace: Path, mapped: dict[str, Any]
) -> dict[str, Any]:
    return record_trace_event(
        assignment_path=assignment_path,
        workspace=workspace,
        kind=str(mapped["kind"]),
        summary=str(mapped["summary"]),
        status=str(mapped["status"]),
        details=dict(mapped["details"]),
        artifact_refs=list(mapped["artifact_refs"]),
        capture_source=CAPTURE_SOURCE,
    )


def run_executor(args: argparse.Namespace) -> dict[str, Any]:
    workspace = args.workspace.resolve()
    assignment_path = args.assignment.resolve()
    provider_environment = build_provider_environment(
        pass_env=args.pass_env,
        credential_env=args.credential_env,
    )
    locked = load_locked_assignment(
        assignment_path=assignment_path,
        workspace=workspace,
        provider=CODEX_PROVIDER,
        full_access=args.full_access,
    )
    assignment = locked.assignment
    repeat_root = locked.repeat_root
    profile = locked.profile
    sandbox_mode = "danger-full-access" if args.full_access else "workspace-write"
    skill_isolation = isolate_model_visible_skills(
        codex_bin=args.codex_bin,
        cwd=repeat_root,
        environment=provider_environment.values,
    )
    expected = list(assignment["expected_artifacts"])
    last_message_relative = (
        "outputs/response.md" if "outputs/response.md" in expected else LAST_MESSAGE_FALLBACK
    )
    last_message_path = safe_artifact(repeat_root, last_message_relative)
    last_message_path.parent.mkdir(parents=True, exist_ok=True)
    prompt = build_executor_prompt(
        assignment=assignment,
        assignment_path=assignment_path,
        repeat_root=repeat_root,
        full_access=args.full_access,
    )
    timeout = int(assignment.get("timeout_seconds", 300))
    if args.timeout_seconds is not None:
        if args.timeout_seconds < 1:
            raise ManifestError("--timeout-seconds must be positive")
        timeout = min(timeout, args.timeout_seconds)
    command = [
        args.codex_bin,
        "--sandbox",
        sandbox_mode,
        "--ask-for-approval",
        "never",
        "-c",
        f"skills.config={skill_isolation['config']}",
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "-C",
        str(repeat_root),
        "--output-last-message",
        str(last_message_path),
    ]
    if args.model:
        command.extend(["--model", args.model])
    command.append(prompt)

    record_trace_event(
        assignment_path=assignment_path,
        workspace=workspace,
        kind="execution_started",
        summary="Codex CLI Eval 执行已开始",
        status="running",
        details={},
        artifact_refs=[],
        capture_source=CAPTURE_SOURCE,
    )
    _record(
        assignment_path=assignment_path,
        workspace=workspace,
        mapped={
            "kind": "tool_call",
            "summary": "执行框架完成 Codex 与环境 Skill 隔离检查",
            "status": "completed",
            "details": {
                "executor": CODEX_HARNESS,
                "codex_version": _codex_version(
                    args.codex_bin,
                    environment=provider_environment.values,
                ),
                "sandbox_mode": sandbox_mode,
                "approval_policy": "never",
                "isolation_claim": profile.get("isolation"),
                "permission_enforcement": (
                    "instruction-and-observable-trace-only"
                    if args.full_access
                    else "codex-workspace-write"
                ),
                "ambient_skills_disabled": skill_isolation["disabled_count"],
                "ambient_skill_paths_digest": skill_isolation["disabled_paths_digest"],
                "prompt_input_discovery_digest": skill_isolation["discovery_digest"],
                "prompt_input_verification_digest": skill_isolation["verification_digest"],
                "provider_env_name_count": provider_environment.passed_name_count,
                "provider_credential_name_count": (
                    provider_environment.credential_name_count
                ),
                "provider_declared_env_digest": (
                    provider_environment.declared_names_digest
                ),
            },
            "artifact_refs": [],
        },
    )

    raw_path = repeat_root / RAW_EVENT_ARTIFACT
    stderr_path = repeat_root / STDERR_ARTIFACT
    raw_count = 0
    normalized_count = 0
    parse_errors = 0
    provider_failure_events = 0
    credential_observation_count = 0
    stderr_credential_observation_count = 0
    commands: list[tuple[str, int | None]] = []
    usage: dict[str, Any] = {}
    pending_items: dict[str, dict[str, Any]] = {}
    started = time.monotonic()
    source_stream_hasher = hashlib.sha256()

    def redact_stderr_line(line: str) -> str:
        nonlocal stderr_credential_observation_count
        redacted = redact_text(line, provider_environment.credential_values)
        if redacted != line:
            stderr_credential_observation_count += 1
        return redacted

    try:
        with ManagedProviderProcess(
            command=command,
            cwd=repeat_root,
            environment=provider_environment.values,
            timeout_seconds=timeout,
            redact_stderr=redact_stderr_line,
        ) as process:
            record_dispatch_receipt(
                assignment_path=assignment_path,
                workspace=workspace,
                dispatch_id="dispatch-"
                + sha256_text(
                    "|".join(
                        [
                            str(assignment.get("run_id")),
                            str(assignment.get("case_id")),
                            str(assignment.get("arm")),
                            str(assignment.get("repeat")),
                            str(process.pid),
                            str(time.time_ns()),
                        ]
                    )
                )[:20],
                worker_id=f"pid:{process.pid}",
                batch_id=args.batch_id,
            )

            with raw_path.open("w", encoding="utf-8") as raw_handle:
                for line in process.stdout:
                    raw_count += 1
                    source_stream_hasher.update(line.encode("utf-8"))
                    stripped = line.strip()
                    if not stripped:
                        continue
                    line_contains_credential = (
                        redact_text(stripped, provider_environment.credential_values)
                        != stripped
                    )
                    if line_contains_credential:
                        credential_observation_count += 1
                    try:
                        event = json.loads(stripped)
                    except json.JSONDecodeError:
                        parse_errors += 1
                        raw_handle.write(
                            compact_json(
                                {
                                    "type": "unparseable",
                                    "source_event_index": raw_count,
                                    "source_sha256": sha256_text(stripped),
                                    "source_bytes": len(line.encode("utf-8")),
                                }
                            )
                            + "\n"
                        )
                        raw_handle.flush()
                        _record(
                            assignment_path=assignment_path,
                            workspace=workspace,
                            mapped={
                                "kind": "error",
                                "summary": "Codex JSONL 中出现无法解析的事件",
                                "status": "failed",
                                "details": {
                                    "source_event_index": raw_count,
                                    "source_sha256": sha256_text(stripped),
                                    "source_bytes": len(line.encode("utf-8")),
                                },
                                "artifact_refs": [],
                            },
                        )
                        normalized_count += 1
                        continue
                    if not line_contains_credential and contains_credential(
                        event,
                        provider_environment.credential_values,
                    ):
                        credential_observation_count += 1
                    event = sanitize_observable(
                        event,
                        credential_values=provider_environment.credential_values,
                    )
                    if not isinstance(event, dict):
                        parse_errors += 1
                        raw_handle.write(
                            compact_json(
                                {
                                    "type": "invalid",
                                    "source_event_index": raw_count,
                                    "source_sha256": sha256_text(stripped),
                                }
                            )
                            + "\n"
                        )
                        raw_handle.flush()
                        continue
                    if event.get("type") in {"turn.failed", "error"}:
                        provider_failure_events += 1
                    raw_handle.write(compact_json(event) + "\n")
                    raw_handle.flush()
                    if event.get("type") == "item.started" and isinstance(
                        event.get("item"), dict
                    ):
                        item = event["item"]
                        item_id = item.get("id")
                        if isinstance(item_id, str):
                            pending_items[item_id] = item
                    if event.get("type") == "item.completed" and isinstance(
                        event.get("item"), dict
                    ):
                        item_id = event["item"].get("id")
                        if isinstance(item_id, str):
                            pending_items.pop(item_id, None)
                    command_observation = _command_from_event(event)
                    if command_observation is not None:
                        commands.append(command_observation)
                    if event.get("type") == "turn.completed" and isinstance(
                        event.get("usage"), dict
                    ):
                        usage = event["usage"]
                    mapped = _map_codex_event(
                        event=event,
                        source_index=raw_count,
                        repeat_root=repeat_root,
                    )
                    if mapped is not None:
                        _record(
                            assignment_path=assignment_path,
                            workspace=workspace,
                            mapped=mapped,
                        )
                        normalized_count += 1
            return_code = process.wait()
            timed_out = process.timed_out
            stderr_text = process.stderr_text
            stderr_line_count = process.stderr_line_count
    except OSError as error:
        _record(
            assignment_path=assignment_path,
            workspace=workspace,
            mapped={
                "kind": "error",
                "summary": "无法启动本地 Codex CLI",
                "status": "failed",
                "details": {"error_type": type(error).__name__, "message": str(error)},
                "artifact_refs": [],
            },
        )
        return finalize_execution(
            assignment_path=assignment_path,
            workspace=workspace,
            status="failed",
            metrics={
                "duration_seconds": round(time.monotonic() - started, 3),
                "provider_env_name_count": provider_environment.passed_name_count,
                "provider_credential_name_count": (
                    provider_environment.credential_name_count
                ),
            },
            forbidden_actions=[],
            side_effects=[],
            capture_source=CAPTURE_SOURCE,
        )

    for item_id, item in pending_items.items():
        command_value = item.get("command", item.get("argv", ""))
        if item.get("type") == "command_execution":
            commands.append((command_value if isinstance(command_value, str) else compact_json(command_value), None))
        _record(
            assignment_path=assignment_path,
            workspace=workspace,
            mapped={
                "kind": "error",
                "summary": "Codex 事件在执行结束前未完成",
                "status": "timed_out" if timed_out else "failed",
                "details": {
                    "source_item_id": item_id,
                    "source_item_type": item.get("type"),
                    "observable_item": sanitize_observable(item),
                },
                "artifact_refs": [],
            },
        )
        normalized_count += 1

    if stderr_text:
        stderr_path.write_text(stderr_text, encoding="utf-8")
    trace_relative = locked.trace_path.relative_to(repeat_root).as_posix()
    credential_leak_paths = redact_retained_credentials(
        root=repeat_root,
        relative_paths=[
            RAW_EVENT_ARTIFACT,
            STDERR_ARTIFACT,
            trace_relative,
            last_message_relative,
            *expected,
        ],
        credential_values=provider_environment.credential_values,
    )
    credential_leak_count = (
        credential_observation_count
        + stderr_credential_observation_count
        + len(credential_leak_paths)
    )
    if credential_leak_count:
        _record(
            assignment_path=assignment_path,
            workspace=workspace,
            mapped={
                "kind": "error",
                "summary": "执行框架检测到并移除了供应商凭据",
                "status": "failed",
                "details": {
                    "credential_observation_count": credential_observation_count,
                    "stderr_credential_observation_count": (
                        stderr_credential_observation_count
                    ),
                    "redacted_artifact_paths": credential_leak_paths,
                },
                "artifact_refs": credential_leak_paths,
            },
        )
        normalized_count += 1
    raw_digest = sha256_file(raw_path)
    retained_source_stream_digest = (
        raw_digest
        if credential_observation_count
        else source_stream_hasher.hexdigest()
    )
    retained_event_count = sum(
        1 for line in raw_path.read_text(encoding="utf-8").splitlines() if line.strip()
    )
    _record(
        assignment_path=assignment_path,
        workspace=workspace,
        mapped={
            "kind": "artifact_written",
            "summary": "已保留 Codex 原始 JSONL 事件流",
            "status": "completed",
            "details": {
                "path": RAW_EVENT_ARTIFACT,
                "digest": raw_digest,
                "size": raw_path.stat().st_size,
                "source_event_count": raw_count,
                "retained_event_count": retained_event_count,
                "source_stream_digest": retained_source_stream_digest,
                "redaction": "private-reasoning-fields-removed",
                "adapter": CODEX_TARGET,
                "format": SOURCE_FORMAT,
            },
            "artifact_refs": [RAW_EVENT_ARTIFACT],
        },
    )
    normalized_count += 1
    if stderr_path.is_file():
        _record(
            assignment_path=assignment_path,
            workspace=workspace,
            mapped={
                "kind": "artifact_written",
                "summary": "已保留 Codex CLI 诊断日志",
                "status": "completed",
                "details": {
                    "path": STDERR_ARTIFACT,
                    "digest": sha256_file(stderr_path),
                    "size": stderr_path.stat().st_size,
                    "line_count": stderr_line_count,
                },
                "artifact_refs": [STDERR_ARTIFACT],
            },
        )
        normalized_count += 1

    missing_artifacts = [
        relative for relative in expected if not safe_artifact(repeat_root, relative).is_file()
    ]
    if missing_artifacts:
        _record(
            assignment_path=assignment_path,
            workspace=workspace,
            mapped={
                "kind": "error",
                "summary": "Codex 未生成全部声明输出",
                "status": "failed",
                "details": {"missing_artifacts": missing_artifacts},
                "artifact_refs": [],
            },
        )
        normalized_count += 1
    permissions = assignment.get("permissions")
    assert isinstance(permissions, dict)
    forbidden_actions, side_effects = _observed_policy_findings(
        commands=commands,
        permissions=permissions,
    )
    if credential_leak_count:
        forbidden_actions.append(
            "provider credential appeared in retained output; exact values were redacted"
        )
    if timed_out:
        final_status = "timed_out"
    elif (
        return_code != 0
        or provider_failure_events
        or parse_errors
        or missing_artifacts
        or credential_leak_count
    ):
        final_status = "failed"
    else:
        final_status = "completed"
    metrics: dict[str, Any] = {
        "duration_seconds": round(time.monotonic() - started, 3),
        "codex_exit_code": return_code,
        "source_event_count": raw_count,
        "normalized_event_count": normalized_count,
        "jsonl_parse_error_count": parse_errors,
        "provider_failure_event_count": provider_failure_events,
        "ambient_skills_disabled": skill_isolation["disabled_count"],
        "full_access_enabled": 1 if args.full_access else 0,
        "credential_leak_count": credential_leak_count,
        "provider_env_name_count": provider_environment.passed_name_count,
        "provider_credential_name_count": provider_environment.credential_name_count,
    }
    for key, value in usage.items():
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            metrics[f"usage_{key}"] = value
    return finalize_execution(
        assignment_path=assignment_path,
        workspace=workspace,
        status=final_status,
        metrics=metrics,
        forbidden_actions=forbidden_actions,
        side_effects=side_effects,
        capture_source=CAPTURE_SOURCE,
        source_trace={
            "artifact": RAW_EVENT_ARTIFACT,
            "digest": raw_digest,
            "source_stream_digest": retained_source_stream_digest,
            "source_event_count": raw_count,
            "retained_event_count": retained_event_count,
            "redaction": "private-reasoning-fields-removed",
            "adapter": CODEX_TARGET,
            "format": SOURCE_FORMAT,
        },
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run one locked skill eval assignment with local Codex JSONL tracing."
    )
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--assignment", type=Path, required=True)
    parser.add_argument("--codex-bin", default="codex")
    parser.add_argument("--model")
    parser.add_argument(
        "--pass-env",
        action="append",
        default=[],
        metavar="NAME",
        help="Pass one named host environment value to Codex (repeatable).",
    )
    parser.add_argument(
        "--credential-env",
        action="append",
        default=[],
        metavar="NAME",
        help=(
            "Pass one named credential to Codex and fail if its value reaches retained "
            "output (repeatable)."
        ),
    )
    parser.add_argument(
        "--batch-id",
        help="Optional paired-dispatch batch identifier shared across arms for one repeat.",
    )
    parser.add_argument(
        "--full-access",
        action="store_true",
        help="Use Codex danger-full-access with approval policy never; retained as local-unattested.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        help="Optionally reduce, but never extend, the timeout locked in the assignment.",
    )
    return parser.parse_args(argv)


def _interrupt_provider(_signum: int, _frame: object) -> None:
    raise KeyboardInterrupt


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _interrupt_provider)
    try:
        result = run_executor(args)
    except KeyboardInterrupt:
        print("error: Codex provider execution interrupted", file=sys.stderr)
        return 130
    except ManifestError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    return 0 if result.get("status") == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

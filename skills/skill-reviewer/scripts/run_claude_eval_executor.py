#!/usr/bin/env python3
"""Execute one locked eval assignment with Claude Code stream-json tracing.

This provider adapter converts Claude Code's observable stream into the shared
``skill-reviewer.agent-trace-event`` contract. The core runtime and Dashboard
never parse Claude-specific events. Private thinking blocks are redacted before
the retained source stream is written.
"""

from __future__ import annotations

import argparse
import json
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from skill_eval_authority import safe_artifact, verify_locked_inputs
from skill_eval_contracts import ManifestError
from skill_eval_execution import (
    ProviderSpec,
    ProviderStreamResult,
    build_provider_environment,
    capture_provider_jsonl,
    finalize_provider_capture,
    load_locked_assignment,
    run_provider_process,
    sanitize_observable,
)
from skill_eval_grading import (
    finalize_execution,
    record_dispatch_receipt,
    record_trace_event,
)


CAPTURE_SOURCE = "provider_stream"
CLAUDE_TARGET = "claude-code"
CLAUDE_HARNESS = "claude-stream-json"
SOURCE_FORMAT = "claude-stream-json-v1"
SOURCE_EVENT_ARTIFACT = "agent-source-events.jsonl"
STDERR_ARTIFACT = "claude-stderr.log"
CLAUDE_PROVIDER = ProviderSpec(
    label="Claude",
    target=CLAUDE_TARGET,
    harness=CLAUDE_HARNESS,
    source_artifact=SOURCE_EVENT_ARTIFACT,
    source_format=SOURCE_FORMAT,
    stderr_artifact=STDERR_ARTIFACT,
    required_capabilities=("source-event-stream",),
)


def _claude_version(claude_bin: str, *, environment: dict[str, str]) -> str:
    try:
        result = subprocess.run(
            [claude_bin, "--version"],
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
            "只根据评测问题与声明输入完成任务。"
        )
    if kind not in {"with_skill", "old_skill"} or not isinstance(skill_path, str):
        raise ManifestError("assignment configuration is not a supported eval arm")
    skill_file = Path(skill_path).resolve() / "SKILL.md"
    if not skill_file.is_file():
        raise ManifestError("locked skill snapshot is missing SKILL.md")
    label = "候选版 Skill" if kind == "with_skill" else "旧版 Skill 对照"
    return (
        f"实验臂：{label}。开始任务前必须使用 Read 读取并且仅遵循锁定快照 "
        f"{skill_file}。不要使用本机安装的 Skill。"
    )


def _executor_prompt(
    *, assignment: dict[str, Any], assignment_path: Path, repeat_root: Path
) -> str:
    input_files = assignment.get("input_files")
    if not isinstance(input_files, list):
        raise ManifestError("assignment.input_files must be an array")
    inputs = [
        f"- {record.get('relative_path')}: {record.get('path')}"
        for record in input_files
        if isinstance(record, dict)
    ]
    expected = assignment.get("expected_artifacts")
    assert isinstance(expected, list)
    return "\n".join(
        [
            "你是一个已锁定 Skill Eval Case 的执行 Agent。",
            "不要修改评测器、Eval、基线、候选 Skill、快照或 Git 状态。",
            _configuration_instruction(assignment),
            "Claude Code 已使用 safe mode、禁用 slash commands，并仅开放 Read。",
            f"评测身份：run={assignment.get('run_id')} case={assignment.get('case_id')} "
            f"arm={assignment.get('arm')} repeat={assignment.get('repeat')}",
            f"锁定 assignment：{assignment_path}",
            f"唯一可写执行目录：{repeat_root}",
            "声明输入：",
            *(inputs or ["- 无"]),
            "必须生成的输出：",
            *(f"- {path}" for path in expected),
            "执行框架会把你的最终可见回复绑定到 outputs/response.md（若声明）。",
            "不得给出整体发布结论，不得递归运行完整 reviewer/evolution 流程。",
            "用户任务：",
            str(assignment.get("prompt")),
        ]
    )


def _mapped_events(event: dict[str, Any], source_index: int) -> list[dict[str, Any]]:
    event_type = event.get("type")
    mapped: list[dict[str, Any]] = []
    if event_type == "system" and event.get("subtype") == "init":
        mapped.append(
            {
                "kind": "tool_call",
                "summary": "Claude Code session initialized",
                "status": "completed",
                "details": {
                    "source_event_index": source_index,
                    "session_id": event.get("session_id"),
                    "model": event.get("model"),
                    "tools": sanitize_observable(event.get("tools", [])),
                },
                "artifact_refs": [],
            }
        )
    message = event.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type in {"thinking", "reasoning"}:
                continue
            if block_type == "text" and isinstance(block.get("text"), str):
                mapped.append(
                    {
                        "kind": "agent_message",
                        "summary": "Claude Code produced an observable message",
                        "status": "completed",
                        "details": {
                            "source_event_index": source_index,
                            "text": block["text"],
                        },
                        "artifact_refs": [],
                    }
                )
            elif block_type == "tool_use":
                mapped.append(
                    {
                        "kind": "tool_call",
                        "summary": f"Claude Code invoked {block.get('name', 'a tool')}",
                        "status": "running",
                        "details": {
                            "source_event_index": source_index,
                            "tool_use_id": block.get("id"),
                            "tool": block.get("name"),
                            "input": sanitize_observable(block.get("input", {})),
                        },
                        "artifact_refs": [],
                    }
                )
            elif block_type == "tool_result":
                is_error = block.get("is_error") is True
                mapped.append(
                    {
                        "kind": "tool_call",
                        "summary": "Claude Code tool result observed",
                        "status": "failed" if is_error else "completed",
                        "details": {
                            "source_event_index": source_index,
                            "tool_use_id": block.get("tool_use_id"),
                            "is_error": is_error,
                            "content": sanitize_observable(block.get("content")),
                        },
                        "artifact_refs": [],
                    }
                )
    if event_type == "result":
        result = event.get("result")
        mapped.append(
            {
                "kind": "agent_message" if isinstance(result, str) and result else "tool_call",
                "summary": "Claude Code completed the Eval assignment",
                "status": "failed" if event.get("is_error") is True else "completed",
                "details": {
                    "source_event_index": source_index,
                    "session_id": event.get("session_id"),
                    "subtype": event.get("subtype"),
                    "result": result if isinstance(result, str) else None,
                    "duration_ms": event.get("duration_ms"),
                    "total_cost_usd": event.get("total_cost_usd"),
                },
                "artifact_refs": [],
            }
        )
    return mapped


def _record(
    *, assignment_path: Path, workspace: Path, mapped: dict[str, Any]
) -> None:
    record_trace_event(
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
        provider=CLAUDE_PROVIDER,
        verify_plan=verify_locked_inputs,
    )
    assignment = locked.assignment
    repeat_root = locked.repeat_root
    profile = locked.profile
    timeout = int(assignment.get("timeout_seconds", 300))
    if args.timeout_seconds is not None:
        if args.timeout_seconds < 1:
            raise ManifestError("--timeout-seconds must be positive")
        timeout = min(timeout, args.timeout_seconds)
    command = [
        args.claude_bin,
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--safe-mode",
        "--disable-slash-commands",
        "--no-chrome",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "Read",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
    ]
    readable_dirs = sorted(
        {
            str(Path(path).resolve() if Path(path).is_dir() else Path(path).resolve().parent)
            for path in assignment.get("readable_paths", [])
            if isinstance(path, str)
        }
    )
    if readable_dirs:
        command.extend(["--add-dir", *readable_dirs])
    if args.model:
        command.extend(["--model", args.model])
    if args.max_budget_usd is not None:
        command.extend(["--max-budget-usd", str(args.max_budget_usd)])
    command.append(
        _executor_prompt(
            assignment=assignment,
            assignment_path=assignment_path,
            repeat_root=repeat_root,
        )
    )

    record_trace_event(
        assignment_path=assignment_path,
        workspace=workspace,
        kind="execution_started",
        summary="Claude Code Eval execution started",
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
            "summary": "Execution harness configured Claude Code isolation",
            "status": "completed",
            "details": {
                "executor": CLAUDE_HARNESS,
                "claude_version": _claude_version(
                    args.claude_bin,
                    environment=provider_environment.values,
                ),
                "safe_mode": True,
                "slash_commands_disabled": True,
                "allowed_tools": ["Read"],
                "isolation_claim": profile.get("isolation"),
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

    source_path = repeat_root / SOURCE_EVENT_ARTIFACT
    stderr_path = repeat_root / STDERR_ARTIFACT
    started = time.monotonic()
    normalized_count = 0
    final_result: str | None = None
    result_is_error = False
    usage: dict[str, Any] = {}
    started = time.monotonic()
    stream_result: ProviderStreamResult | None = None

    def on_started(provider_pid: int, dispatch_id: str) -> None:
        record_dispatch_receipt(
            assignment_path=assignment_path,
            workspace=workspace,
            dispatch_id=dispatch_id,
            worker_id=f"pid:{provider_pid}",
            batch_id=args.batch_id,
        )

    def on_source_event(event: dict[str, Any], source_index: int) -> None:
        nonlocal normalized_count, final_result, result_is_error, usage
        if event.get("type") == "result":
            result_is_error = event.get("is_error") is True
            if isinstance(event.get("result"), str):
                final_result = event["result"]
            if isinstance(event.get("usage"), dict):
                usage = event["usage"]
        for mapped in _mapped_events(event, source_index):
            _record(
                assignment_path=assignment_path,
                workspace=workspace,
                mapped=mapped,
            )
            normalized_count += 1

    def consume_stdout(stdout: Any) -> None:
        nonlocal stream_result
        stream_result = capture_provider_jsonl(
            source=stdout,
            destination=source_path,
            credential_values=provider_environment.credential_values,
            on_event=on_source_event,
        )

    try:
        process_result = run_provider_process(
            command=command,
            cwd=repeat_root,
            environment=provider_environment,
            timeout_seconds=timeout,
            assignment=assignment,
            on_started=on_started,
            consume_stdout=consume_stdout,
        )
        return_code = process_result.return_code
        timed_out = process_result.timed_out
        stderr_line_count = process_result.stderr_line_count
        stderr_credential_observation_count = (
            process_result.stderr_credential_observation_count
        )
        if stream_result is None:
            raise ManifestError("Claude source stream capture did not complete")
        source_count = stream_result.source_event_count
        parse_errors = stream_result.parse_error_count
        credential_observation_count = stream_result.credential_observation_count
    except OSError as error:
        _record(
            assignment_path=assignment_path,
            workspace=workspace,
            mapped={
                "kind": "error",
                "summary": "Unable to start Claude Code",
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

    expected = list(assignment.get("expected_artifacts", []))
    if final_result and not result_is_error and "outputs/response.md" in expected:
        response_path = safe_artifact(repeat_root, "outputs/response.md")
        response_path.write_text(final_result.rstrip() + "\n", encoding="utf-8")
    capture = finalize_provider_capture(
        root=repeat_root,
        source_path=source_path,
        stderr_path=stderr_path,
        trace_path=locked.trace_path,
        retained_paths=expected,
        environment=provider_environment,
        process=process_result,
        source_stream_digest=stream_result.source_stream_digest,
        credential_observation_count=credential_observation_count,
    )
    credential_leak_paths = list(capture.credential_leak_paths)
    credential_leak_count = capture.credential_leak_count
    source_digest = capture.source_digest
    retained_source_stream_digest = capture.retained_source_stream_digest
    retained_count = capture.retained_event_count
    if credential_leak_count:
        _record(
            assignment_path=assignment_path,
            workspace=workspace,
            mapped={
                "kind": "error",
                "summary": "Execution harness detected and removed a provider credential",
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
    _record(
        assignment_path=assignment_path,
        workspace=workspace,
        mapped={
            "kind": "artifact_written",
            "summary": "Retained redacted Claude Code source event stream",
            "status": "completed",
            "details": {
                "path": SOURCE_EVENT_ARTIFACT,
                "digest": source_digest,
                "size": source_path.stat().st_size,
                "source_event_count": source_count,
                "retained_event_count": retained_count,
                "source_stream_digest": retained_source_stream_digest,
                "redaction": "private-reasoning-fields-removed",
                "adapter": CLAUDE_TARGET,
                "format": SOURCE_FORMAT,
            },
            "artifact_refs": [SOURCE_EVENT_ARTIFACT],
        },
    )
    normalized_count += 1
    if stderr_path.is_file():
        _record(
            assignment_path=assignment_path,
            workspace=workspace,
            mapped={
                "kind": "artifact_written",
                "summary": "Retained redacted Claude Code diagnostic log",
                "status": "completed",
                "details": {
                    "path": STDERR_ARTIFACT,
                    "digest": capture.stderr_digest,
                    "size": stderr_path.stat().st_size,
                    "line_count": stderr_line_count,
                },
                "artifact_refs": [STDERR_ARTIFACT],
            },
        )
        normalized_count += 1
    missing_artifacts = [
        relative
        for relative in expected
        if not safe_artifact(repeat_root, relative).is_file()
    ]
    if missing_artifacts:
        _record(
            assignment_path=assignment_path,
            workspace=workspace,
            mapped={
                "kind": "error",
                "summary": "Claude Code did not produce every declared output",
                "status": "failed",
                "details": {"missing_artifacts": missing_artifacts},
                "artifact_refs": [],
            },
        )
    forbidden_actions: list[str] = []
    if credential_leak_count:
        forbidden_actions.append(
            "provider credential appeared in retained output; exact values were redacted"
        )
    if timed_out:
        final_status = "timed_out"
    elif (
        return_code != 0
        or result_is_error
        or parse_errors
        or missing_artifacts
        or not final_result
        or credential_leak_count
    ):
        final_status = "failed"
    else:
        final_status = "completed"
    metrics: dict[str, Any] = {
        "duration_seconds": round(time.monotonic() - started, 3),
        "claude_exit_code": return_code,
        "source_event_count": source_count,
        "normalized_event_count": normalized_count,
        "jsonl_parse_error_count": parse_errors,
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
        side_effects=[],
        capture_source=CAPTURE_SOURCE,
        source_trace={
            "artifact": SOURCE_EVENT_ARTIFACT,
            "digest": source_digest,
            "adapter": CLAUDE_TARGET,
            "format": SOURCE_FORMAT,
            "source_stream_digest": retained_source_stream_digest,
            "source_event_count": source_count,
            "retained_event_count": retained_count,
            "redaction": "private-reasoning-fields-removed",
        },
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--assignment", type=Path, required=True)
    parser.add_argument("--claude-bin", default="claude")
    parser.add_argument("--model")
    parser.add_argument(
        "--pass-env",
        action="append",
        default=[],
        metavar="NAME",
        help="Pass one named host environment value to Claude Code (repeatable).",
    )
    parser.add_argument(
        "--credential-env",
        action="append",
        default=[],
        metavar="NAME",
        help=(
            "Pass one named credential to Claude Code and fail if its value reaches "
            "retained output (repeatable)."
        ),
    )
    parser.add_argument("--max-budget-usd", type=float)
    parser.add_argument("--timeout-seconds", type=int)
    parser.add_argument("--batch-id")
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
        print(
            json.dumps({"error": "Claude provider execution interrupted"}),
            file=sys.stderr,
        )
        return 130
    except (ManifestError, OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result.get("status") == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

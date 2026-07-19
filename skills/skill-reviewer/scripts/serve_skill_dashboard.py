#!/usr/bin/env python3
"""Serve immutable evidence plus an external, append-only action task gateway."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import sys
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import RLock
from urllib.parse import unquote, urlparse

from skill_eval_contracts import (
    DASHBOARD_AGENT_HANDOFF_CONTRACT,
    DASHBOARD_SESSION_CONTRACT,
)


class DashboardServerError(ValueError):
    """Raised when the read-only dashboard cannot be served safely."""


DIFF_ID_PATTERN = re.compile(r"[a-f0-9]{24}")
DIGEST_PATTERN = re.compile(r"[a-f0-9]{64}")
IDEMPOTENCY_KEY_PATTERN = re.compile(r"[A-Za-z0-9_.:-]{8,128}")
ACTION_ID_PATTERN = re.compile(r"[a-z][a-z0-9_]{2,63}")
TASK_ID_PATTERN = re.compile(r"task-[a-f0-9]{16}")
ACTION_REQUEST_LIMIT_BYTES = 16 * 1024
SESSION_TOKEN_HEADER = "X-Skill-Reviewer-Session"
SESSION_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{32,256}")
DASHBOARD_DIFF_RENDER_LIMIT_BYTES = 512 * 1024
DASHBOARD_EVIDENCE_SOURCE_LIMIT_BYTES = 2 * 1024 * 1024
DASHBOARD_EVIDENCE_PREVIEW_LIMIT_BYTES = 256 * 1024
# A single source byte can occupy six bytes when JSON escapes a control
# character (for example, ``\u0001``). Keep a bounded raw-file guard without
# rejecting otherwise valid 512 KiB UTF-8 previews after serialization.
DASHBOARD_DIFF_PAYLOAD_FILE_LIMIT_BYTES = (
    2 * DASHBOARD_DIFF_RENDER_LIMIT_BYTES * 6 + 128 * 1024
)
DASHBOARD_CONTENT_SECURITY_POLICY = "; ".join(
    (
        "default-src 'self'",
        "style-src 'self'",
        # Pierre Diffs renders isolated theme styles and grid measurements in
        # shadow DOM. Keep scripts strict while allowing only dynamic CSS.
        "style-src-elem 'self' 'unsafe-inline'",
        "style-src-attr 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "worker-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    )
)
PERMISSIONS_POLICY = (
    "camera=(), microphone=(), geolocation=(), usb=(), payment=(), "
    "interest-cohort=()"
)


def _validated_session_token(raw: str) -> str:
    if not SESSION_TOKEN_PATTERN.fullmatch(raw):
        raise DashboardServerError("dashboard session token is invalid")
    return raw


def _validated_static_ui_root(raw: Path | None) -> Path | None:
    if raw is None:
        return None
    if raw.is_symlink() or not raw.is_dir():
        raise DashboardServerError("local Dashboard UI root is not a safe directory")
    root = raw.resolve()
    index = root / "index.html"
    if index.is_symlink() or not index.is_file() or index.resolve().parent != root:
        raise DashboardServerError("local Dashboard UI root has no safe index.html")
    return root


def _is_loopback_hostname(hostname: str | None) -> bool:
    if not hostname:
        return False
    normalized = hostname.strip("[]").lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def validate_loopback_bind_host(host: str) -> None:
    if not _is_loopback_hostname(host):
        raise DashboardServerError(
            "dashboard control plane must bind to localhost or a loopback IP"
        )


def _normalize_origin(raw: str) -> str:
    parsed = urlparse(raw)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise DashboardServerError(f"dashboard origin is invalid: {raw}")
    return f"{parsed.scheme}://{parsed.netloc}"


def _request_loopback_origin(raw: str | None) -> str | None:
    if not raw:
        return None
    try:
        parsed = urlparse(f"//{raw}")
        port = parsed.port
    except ValueError:
        return None
    if (
        not _is_loopback_hostname(parsed.hostname)
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        return None
    hostname = parsed.hostname
    assert hostname is not None
    authority = f"[{hostname}]" if ":" in hostname else hostname
    if port is not None:
        authority = f"{authority}:{port}"
    return f"http://{authority}"


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _validated_task_root(workspace: Path, task_root: Path) -> Path:
    workspace = workspace.resolve()
    unresolved = task_root.absolute()
    raw_task_root = str(unresolved)
    if len(raw_task_root) > 4096 or any(
        ord(character) < 32 or ord(character) == 127
        for character in raw_task_root
    ):
        raise DashboardServerError("dashboard action task root is not display-safe")
    if unresolved.is_symlink():
        raise DashboardServerError("dashboard action task root cannot be a symlink")
    task_root = unresolved.resolve()
    if task_root == workspace or workspace in task_root.parents:
        raise DashboardServerError(
            "dashboard action tasks must be stored outside the evidence workspace"
        )
    if task_root.exists() and (task_root.is_symlink() or not task_root.is_dir()):
        raise DashboardServerError("dashboard action task root is not a safe directory")
    return task_root


def _task_digest(record: dict[str, object]) -> str:
    payload = {key: value for key, value in record.items() if key != "digest"}
    return _sha256_bytes(_canonical_json(payload))


def agent_handoff(task_root: Path) -> dict[str, object]:
    """Describe the real browser-to-Agent boundary without implying delivery."""

    return {
        "contract": DASHBOARD_AGENT_HANDOFF_CONTRACT,
        "mode": "durable_local_ledger",
        "agent_session_state": "unbound",
        "can_wake_agent_session": False,
        "persists_after_agent_session_end": True,
        "task_root": str(task_root),
    }


def _load_action_tasks(task_root: Path) -> list[dict[str, object]]:
    if not task_root.exists():
        return []
    if task_root.is_symlink() or not task_root.is_dir():
        raise DashboardServerError("dashboard action task root changed identity")
    tasks: list[dict[str, object]] = []
    previous_digest: str | None = None
    for sequence, path in enumerate(sorted(task_root.glob("*.json")), start=1):
        if path.is_symlink() or not path.is_file() or path.parent != task_root:
            raise DashboardServerError("dashboard action task ledger contains an unsafe entry")
        try:
            task = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise DashboardServerError(
                f"dashboard action task is invalid: {path.name}"
            ) from error
        if not isinstance(task, dict) or task.get("contract") != (
            "skill-reviewer.dashboard-action-task"
        ):
            raise DashboardServerError(
                f"dashboard action task contract is invalid: {path.name}"
            )
        if set(task) != {
            "contract",
            "sequence",
            "created_at",
            "previous_digest",
            "run_id",
            "dashboard_digest",
            "expected_next_action",
            "action_id",
            "owner",
            "requested_by",
            "status",
            "delivery_mode",
            "agent_session_id",
            "human_confirmation_required",
            "evidence_ids",
            "idempotency_key",
            "id",
            "digest",
        }:
            raise DashboardServerError("dashboard action task fields are invalid")
        evidence_ids = task.get("evidence_ids")
        if (
            not isinstance(task.get("created_at"), str)
            or not isinstance(task.get("run_id"), str)
            or not task.get("run_id")
            or not isinstance(task.get("expected_next_action"), str)
            or not task.get("expected_next_action")
            or not isinstance(task.get("dashboard_digest"), str)
            or not DIGEST_PATTERN.fullmatch(str(task.get("dashboard_digest")))
            or not isinstance(task.get("action_id"), str)
            or not ACTION_ID_PATTERN.fullmatch(str(task.get("action_id")))
            or task.get("owner") != "lead_agent"
            or task.get("requested_by") != "human_reviewer"
            or task.get("status") != "awaiting_agent"
            or task.get("delivery_mode") != "durable_local_ledger"
            or task.get("agent_session_id") is not None
            or not isinstance(task.get("human_confirmation_required"), bool)
            or not isinstance(evidence_ids, list)
            or len(evidence_ids) > 32
            or any(not isinstance(value, str) or not value for value in evidence_ids)
            or len(set(evidence_ids)) != len(evidence_ids)
            or not isinstance(task.get("idempotency_key"), str)
            or not IDEMPOTENCY_KEY_PATTERN.fullmatch(
                str(task.get("idempotency_key"))
            )
            or not isinstance(task.get("id"), str)
            or not TASK_ID_PATTERN.fullmatch(str(task.get("id")))
        ):
            raise DashboardServerError("dashboard action task binding is invalid")
        if task.get("sequence") != sequence:
            raise DashboardServerError("dashboard action task sequence is not contiguous")
        if task.get("previous_digest") != previous_digest:
            raise DashboardServerError("dashboard action task digest chain is broken")
        digest = task.get("digest")
        if not isinstance(digest, str) or digest != _task_digest(task):
            raise DashboardServerError("dashboard action task digest is invalid")
        expected_name = f"{sequence:06d}-{task.get('id')}.json"
        if path.name != expected_name:
            raise DashboardServerError("dashboard action task filename is invalid")
        tasks.append(task)
        previous_digest = digest
    return tasks


def _action_task_log(
    *, task_root: Path, run_id: str, dashboard_digest: str
) -> dict[str, object]:
    tasks = [
        task for task in _load_action_tasks(task_root) if task.get("run_id") == run_id
    ]
    return {
        "contract": "skill-reviewer.dashboard-action-task-log",
        "run_id": run_id,
        "owner": "lead_agent",
        "evidence_mutation": False,
        "eval_mutation": False,
        "current_dashboard_digest": dashboard_digest,
        "handoff": agent_handoff(task_root),
        "tasks": tasks,
    }


def _validate_action_request(
    *, payload: object, data: dict[str, object]
) -> tuple[dict[str, object], dict[str, object]]:
    if not isinstance(payload, dict):
        raise DashboardServerError("dashboard action request must be a JSON object")
    expected_keys = {
        "contract",
        "run_id",
        "action_id",
        "expected_next_action",
        "evidence_ids",
        "idempotency_key",
    }
    if set(payload) != expected_keys:
        raise DashboardServerError("dashboard action request fields are invalid")
    if payload.get("contract") != "skill-reviewer.dashboard-action-request":
        raise DashboardServerError("dashboard action request contract is invalid")
    run = data.get("run")
    run_id = run.get("id") if isinstance(run, dict) else None
    if not isinstance(run_id, str) or payload.get("run_id") != run_id:
        raise DashboardServerError("dashboard action request run is stale")
    action_center = data.get("action_center")
    if not isinstance(action_center, dict):
        raise DashboardServerError("dashboard action center is unavailable")
    task_gateway = action_center.get("task_gateway")
    if (
        not isinstance(task_gateway, dict)
        or task_gateway.get("handoff_mode") != "durable_local_ledger"
        or task_gateway.get("can_wake_agent_session") is not False
        or task_gateway.get("persists_after_agent_session_end") is not True
        or task_gateway.get("evidence_mutation") is not False
        or task_gateway.get("eval_mutation") is not False
    ):
        raise DashboardServerError(
            "dashboard action gateway does not declare the durable handoff boundary"
        )
    next_action = action_center.get("next_action")
    if (
        not isinstance(next_action, str)
        or payload.get("expected_next_action") != next_action
    ):
        raise DashboardServerError("dashboard action request state is stale")
    action_id = payload.get("action_id")
    if not isinstance(action_id, str) or not ACTION_ID_PATTERN.fullmatch(action_id):
        raise DashboardServerError("dashboard action id is invalid")
    actions = action_center.get("actions")
    action = next(
        (
            item
            for item in actions
            if isinstance(item, dict) and item.get("id") == action_id
        ),
        None,
    ) if isinstance(actions, list) else None
    if not isinstance(action, dict) or action.get("available") is not True:
        raise DashboardServerError("dashboard action is not available in this state")
    if action.get("requestable") is not True:
        raise DashboardServerError(
            "dashboard action is automatic and cannot be requested by the browser"
        )
    if action.get("owner") != "lead_agent":
        raise DashboardServerError("dashboard action does not belong to the lead agent")
    idempotency_key = payload.get("idempotency_key")
    if not isinstance(idempotency_key, str) or not IDEMPOTENCY_KEY_PATTERN.fullmatch(
        idempotency_key
    ):
        raise DashboardServerError("dashboard action idempotency key is invalid")
    raw_evidence_ids = payload.get("evidence_ids")
    if (
        not isinstance(raw_evidence_ids, list)
        or len(raw_evidence_ids) > 32
        or any(not isinstance(value, str) or not value for value in raw_evidence_ids)
        or len(set(raw_evidence_ids)) != len(raw_evidence_ids)
    ):
        raise DashboardServerError("dashboard action evidence references are invalid")
    spine = data.get("spine")
    known_evidence_ids = {
        item.get("id")
        for item in spine
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    } if isinstance(spine, list) else set()
    if not set(raw_evidence_ids).issubset(known_evidence_ids):
        raise DashboardServerError("dashboard action cites unknown evidence")
    projected_evidence_ids = action.get("evidence_ids")
    if (
        not isinstance(projected_evidence_ids, list)
        or any(
            not isinstance(value, str) or not value
            for value in projected_evidence_ids
        )
        or raw_evidence_ids != projected_evidence_ids
    ):
        raise DashboardServerError(
            "dashboard action evidence does not match the state projection"
        )
    return payload, action


def _append_action_task(
    *,
    task_root: Path,
    request: dict[str, object],
    action: dict[str, object],
    dashboard_digest: str,
) -> tuple[dict[str, object], bool]:
    task_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if task_root.is_symlink():
        raise DashboardServerError("dashboard action task root changed identity")
    task_root.chmod(0o700)
    tasks = _load_action_tasks(task_root)
    for task in tasks:
        if (
            task.get("run_id") == request.get("run_id")
            and task.get("idempotency_key") == request.get("idempotency_key")
        ):
            if task.get("action_id") != request.get("action_id"):
                raise DashboardServerError(
                    "dashboard action idempotency key was reused for another action"
                )
            return task, False
    for task in tasks:
        if (
            task.get("run_id") == request.get("run_id")
            and task.get("dashboard_digest") == dashboard_digest
            and task.get("expected_next_action")
            == request.get("expected_next_action")
            and task.get("action_id") == request.get("action_id")
            and task.get("evidence_ids") == request.get("evidence_ids")
            and task.get("status") == "awaiting_agent"
        ):
            # A browser refresh or repeated click must not manufacture several
            # indistinguishable handoffs for the same authoritative state.
            return task, False
    sequence = len(tasks) + 1
    previous_digest = tasks[-1].get("digest") if tasks else None
    record: dict[str, object] = {
        "contract": "skill-reviewer.dashboard-action-task",
        "sequence": sequence,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "previous_digest": previous_digest,
        "run_id": request["run_id"],
        "dashboard_digest": dashboard_digest,
        "expected_next_action": request["expected_next_action"],
        "action_id": request["action_id"],
        "owner": "lead_agent",
        "requested_by": "human_reviewer",
        "status": "awaiting_agent",
        "delivery_mode": "durable_local_ledger",
        "agent_session_id": None,
        "human_confirmation_required": action.get(
            "human_confirmation_required", False
        ),
        "evidence_ids": request["evidence_ids"],
        "idempotency_key": request["idempotency_key"],
    }
    identity_digest = _sha256_bytes(
        _canonical_json(
            {
                "run_id": request["run_id"],
                "action_id": request["action_id"],
                "idempotency_key": request["idempotency_key"],
                "dashboard_digest": dashboard_digest,
            }
        )
    )
    record["id"] = f"task-{identity_digest[:16]}"
    digest = _task_digest(record)
    record["digest"] = digest
    path = task_root / f"{sequence:06d}-{record['id']}.json"
    temporary = task_root / f".{path.name}.{os.getpid()}.tmp"
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o400)
        # Publish without overwrite: an existing path means the append-only
        # ledger changed outside the serialized server task lock.
        os.link(temporary, path)
        temporary.unlink()
    except OSError as error:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise DashboardServerError("dashboard action task could not be retained") from error
    return record, True


def _load_dashboard_snapshot(
    data_path: Path,
) -> tuple[dict[str, object], bytes]:
    try:
        body = data_path.read_bytes()
        data = json.loads(body.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DashboardServerError(f"dashboard read model is invalid: {error}") from error
    if not isinstance(data, dict) or data.get("contract") != (
        "skill-reviewer.dashboard-data"
    ):
        raise DashboardServerError(
            "dashboard read model contract must be skill-reviewer.dashboard-data"
        )
    return data, body


def _load_dashboard_data(data_path: Path) -> dict[str, object]:
    data, _body = _load_dashboard_snapshot(data_path)
    return data


def _validated_diff_routes(
    workspace: Path, data: dict[str, object]
) -> dict[str, tuple[Path, str]]:
    raw_diffs = data.get("diffs", [])
    if not isinstance(raw_diffs, list):
        raise DashboardServerError("dashboard diffs must be an array")
    payload_root = workspace / "dashboard-diffs"
    routes: dict[str, tuple[Path, str]] = {}
    for index, raw_diff in enumerate(raw_diffs):
        if not isinstance(raw_diff, dict):
            raise DashboardServerError(f"dashboard diff {index} must be an object")
        render_mode = raw_diff.get("render_mode")
        content_url = raw_diff.get("content_url")
        if render_mode not in {"lazy", "summary", "binary"}:
            raise DashboardServerError(
                f"dashboard diff {index} render mode is invalid"
            )
        payload_digest = raw_diff.get("payload_digest")
        if render_mode != "lazy":
            if content_url is not None or payload_digest is not None:
                raise DashboardServerError(
                    f"dashboard diff {index} exposes a payload outside lazy mode"
                )
            continue
        diff_id = raw_diff.get("id")
        if not isinstance(diff_id, str) or not DIFF_ID_PATTERN.fullmatch(diff_id):
            raise DashboardServerError(f"dashboard diff {index} id is invalid")
        expected_url = f"/dashboard-diffs/{diff_id}.json"
        if content_url != expected_url:
            raise DashboardServerError(
                f"dashboard diff {index} content URL is invalid"
            )
        if not isinstance(payload_digest, str) or not DIGEST_PATTERN.fullmatch(
            payload_digest
        ):
            raise DashboardServerError(
                f"dashboard diff {index} payload digest is invalid"
            )
        old_size = raw_diff.get("old_size")
        new_size = raw_diff.get("new_size")
        if any(
            type(size) is not int
            or size < 0
            or size > DASHBOARD_DIFF_RENDER_LIMIT_BYTES
            for size in (old_size, new_size)
        ):
            raise DashboardServerError(
                f"dashboard diff {index} preview size is invalid"
            )
        payload_path = payload_root / f"{diff_id}.json"
        if (
            payload_path.is_symlink()
            or not payload_path.is_file()
            or payload_path.resolve().parent != payload_root.resolve()
        ):
            raise DashboardServerError(
                f"dashboard diff payload does not exist: {payload_path}"
            )
        if payload_path.stat().st_size > DASHBOARD_DIFF_PAYLOAD_FILE_LIMIT_BYTES:
            raise DashboardServerError(
                f"dashboard diff payload exceeds the bounded preview limit: {payload_path}"
            )
        if _sha256_file(payload_path) != payload_digest:
            raise DashboardServerError(
                f"dashboard diff payload digest does not match its metadata: {payload_path}"
            )
        try:
            payload = json.loads(payload_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise DashboardServerError(
                f"dashboard diff payload is invalid: {payload_path}: {error}"
            ) from error
        if not isinstance(payload, dict) or any(
            payload.get(key) != expected
            for key, expected in (
                ("contract", "skill-reviewer.dashboard-diff"),
                ("id", diff_id),
                ("path", raw_diff.get("path")),
                ("old_digest", raw_diff.get("old_digest")),
                ("new_digest", raw_diff.get("new_digest")),
            )
        ):
            raise DashboardServerError(
                f"dashboard diff payload is not bound to its metadata: {payload_path}"
            )
        old_content = payload.get("old_content")
        new_content = payload.get("new_content")
        if (
            not isinstance(old_content, str)
            or not isinstance(new_content, str)
            or len(old_content.encode("utf-8")) != old_size
            or len(new_content.encode("utf-8")) != new_size
        ):
            raise DashboardServerError(
                f"dashboard diff payload size is not bound to its metadata: {payload_path}"
            )
        routes[expected_url] = (payload_path, payload_digest)
    return routes


def _validated_evidence_routes(
    workspace: Path, data: dict[str, object]
) -> dict[str, tuple[Path, str, str, int]]:
    raw_spine = data.get("spine", [])
    if not isinstance(raw_spine, list):
        raise DashboardServerError("dashboard spine must be an array")
    routes: dict[str, tuple[Path, str, str, int]] = {}
    workspace_root = workspace.resolve()
    for index, raw_node in enumerate(raw_spine):
        if not isinstance(raw_node, dict):
            raise DashboardServerError(f"dashboard spine node {index} must be an object")
        content_url = raw_node.get("content_url")
        if content_url is None:
            continue
        node_id = raw_node.get("id")
        relative_path = raw_node.get("path")
        digest = raw_node.get("content_digest")
        size = raw_node.get("content_size")
        if not isinstance(node_id, str) or not node_id:
            raise DashboardServerError(f"dashboard evidence node {index} id is invalid")
        route_id = hashlib.sha256(node_id.encode("utf-8")).hexdigest()[:24]
        expected_url = f"/dashboard-evidence/{route_id}.json"
        if content_url != expected_url:
            raise DashboardServerError(
                f"dashboard evidence node {index} content URL is invalid"
            )
        if not isinstance(relative_path, str) or not relative_path:
            raise DashboardServerError(
                f"dashboard evidence node {index} path is invalid"
            )
        relative = Path(relative_path)
        if relative.is_absolute() or ".." in relative.parts:
            raise DashboardServerError(
                f"dashboard evidence node {index} path leaves the workspace"
            )
        candidate = workspace / relative
        current = workspace
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise DashboardServerError(
                    f"dashboard evidence node {index} path contains a symbolic link"
                )
        try:
            candidate.resolve().relative_to(workspace_root)
        except ValueError as error:
            raise DashboardServerError(
                f"dashboard evidence node {index} path leaves the workspace"
            ) from error
        if not candidate.is_file():
            raise DashboardServerError(
                f"dashboard evidence node {index} source does not exist"
            )
        if not isinstance(digest, str) or not DIGEST_PATTERN.fullmatch(digest):
            raise DashboardServerError(
                f"dashboard evidence node {index} digest is invalid"
            )
        if (
            type(size) is not int
            or size < 0
            or size > DASHBOARD_EVIDENCE_SOURCE_LIMIT_BYTES
            or candidate.stat().st_size != size
        ):
            raise DashboardServerError(
                f"dashboard evidence node {index} size is invalid"
            )
        if _sha256_file(candidate) != digest:
            raise DashboardServerError(
                f"dashboard evidence node {index} digest does not match its source"
            )
        try:
            candidate.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            raise DashboardServerError(
                f"dashboard evidence node {index} source is not UTF-8 text"
            ) from error
        binding = (candidate, node_id, digest, size)
        previous = routes.get(expected_url)
        if previous is not None and previous != binding:
            raise DashboardServerError("dashboard evidence route collision")
        routes[expected_url] = binding
    return routes


def _evidence_media_type(path: Path) -> str:
    if path.suffix.lower() == ".md":
        return "text/markdown"
    if path.suffix.lower() in {".json", ".jsonl"}:
        return "application/json"
    return mimetypes.guess_type(path.name)[0] or "text/plain"


def _render_evidence_payload(
    binding: tuple[Path, str, str, int]
) -> bytes:
    path, node_id, expected_digest, expected_size = binding
    try:
        if path.is_symlink() or not path.is_file():
            raise DashboardServerError("dashboard evidence source changed after validation")
        raw = path.read_bytes()
    except OSError as error:
        raise DashboardServerError("dashboard evidence source is unavailable") from error
    if len(raw) != expected_size or _sha256_bytes(raw) != expected_digest:
        raise DashboardServerError("dashboard evidence source changed after validation")
    try:
        full_text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise DashboardServerError("dashboard evidence source is no longer UTF-8") from error
    truncated = len(raw) > DASHBOARD_EVIDENCE_PREVIEW_LIMIT_BYTES
    content = (
        raw[:DASHBOARD_EVIDENCE_PREVIEW_LIMIT_BYTES].decode("utf-8", errors="ignore")
        if truncated
        else full_text
    )
    return json.dumps(
        {
            "contract": "skill-reviewer.dashboard-evidence",
            "node_id": node_id,
            "path": str(path.name),
            "media_type": _evidence_media_type(path),
            "content": content,
            "digest": expected_digest,
            "size": expected_size,
            "truncated": truncated,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def validate_sources(
    workspace: Path, task_root: Path | None = None
) -> dict[str, object]:
    workspace = workspace.resolve()
    task_root = _validated_task_root(
        workspace,
        task_root
        if task_root is not None
        else workspace.parent / f"{workspace.name}.dashboard-actions",
    )
    data_path = workspace / "dashboard-data.json"
    if not data_path.is_file():
        raise DashboardServerError(
            f"dashboard read model does not exist: {data_path}"
        )
    data = _load_dashboard_data(data_path)
    diff_routes = _validated_diff_routes(workspace, data)
    evidence_routes = _validated_evidence_routes(workspace, data)
    tasks = _load_action_tasks(task_root)
    return {
        "ok": True,
        "dashboard_hosted": False,
        "evidence_uploaded": False,
        "evidence_read_only": True,
        "action_requests_enabled": True,
        "agent_handoff": agent_handoff(task_root),
        "workspace": str(workspace),
        "task_root": str(task_root),
        "run_id": data.get("run", {}).get("id")
        if isinstance(data.get("run"), dict)
        else None,
        "lazy_diff_count": len(diff_routes),
        "evidence_preview_count": len(evidence_routes),
        "action_task_count": len(tasks),
    }


def create_handler(
    workspace: Path,
    task_root: Path | None = None,
    *,
    session_token: str,
    static_ui_root: Path | None = None,
) -> type[BaseHTTPRequestHandler]:
    workspace = workspace.resolve()
    task_root = _validated_task_root(
        workspace,
        task_root
        if task_root is not None
        else workspace.parent / f"{workspace.name}.dashboard-actions",
    )
    token = _validated_session_token(session_token)
    ui_root = _validated_static_ui_root(static_ui_root)
    data_path = workspace / "dashboard-data.json"
    snapshot_data, snapshot_body = _load_dashboard_snapshot(data_path)
    initial_diff_routes = _validated_diff_routes(workspace, snapshot_data)
    initial_evidence_routes = _validated_evidence_routes(workspace, snapshot_data)
    snapshot_digest = _sha256_bytes(snapshot_body)
    known_diff_routes = dict(initial_diff_routes)
    known_evidence_routes = dict(initial_evidence_routes)
    snapshot_lock = RLock()
    task_lock = RLock()

    def refresh_snapshot() -> bytes:
        nonlocal snapshot_data, snapshot_body, snapshot_digest
        with snapshot_lock:
            next_data, next_body = _load_dashboard_snapshot(data_path)
            next_digest = _sha256_bytes(next_body)
            if next_digest == snapshot_digest:
                return snapshot_body
            next_routes = _validated_diff_routes(workspace, next_data)
            next_evidence_routes = _validated_evidence_routes(workspace, next_data)
            for route, binding in next_routes.items():
                previous = known_diff_routes.get(route)
                if previous is not None and previous[1] != binding[1]:
                    raise DashboardServerError(
                        f"dashboard diff route changed content identity: {route}"
                    )
            known_diff_routes.update(next_routes)
            for route, binding in next_evidence_routes.items():
                previous = known_evidence_routes.get(route)
                if previous is not None and previous[1:] != binding[1:]:
                    raise DashboardServerError(
                        f"dashboard evidence route changed content identity: {route}"
                    )
            known_evidence_routes.update(next_evidence_routes)
            snapshot_data = next_data
            snapshot_body = next_body
            snapshot_digest = next_digest
            return snapshot_body

    def current_snapshot() -> tuple[dict[str, object], str]:
        refresh_snapshot()
        with snapshot_lock:
            return snapshot_data, snapshot_digest

    def action_task_log_body() -> bytes:
        data, dashboard_digest = current_snapshot()
        run = data.get("run")
        run_id = run.get("id") if isinstance(run, dict) else None
        if not isinstance(run_id, str):
            raise DashboardServerError("dashboard run id is unavailable")
        with task_lock:
            return _canonical_json(
                _action_task_log(
                    task_root=task_root,
                    run_id=run_id,
                    dashboard_digest=dashboard_digest,
                )
            )

    def resolve_diff_route(request_path: str) -> tuple[Path, str] | None:
        with snapshot_lock:
            return known_diff_routes.get(request_path)

    def resolve_evidence_route(
        request_path: str,
    ) -> tuple[Path, str, str, int] | None:
        with snapshot_lock:
            return known_evidence_routes.get(request_path)

    class Handler(BaseHTTPRequestHandler):
        server_version = "SkillReviewerDashboard"
        sys_version = ""

        def _origin_context(self) -> tuple[bool, str | None]:
            host_origin = _request_loopback_origin(self.headers.get("Host"))
            if host_origin is None:
                return False, None
            fetch_site = self.headers.get("Sec-Fetch-Site", "").strip().lower()
            if fetch_site not in {"", "none", "same-origin"}:
                return False, None
            raw_origin = self.headers.get("Origin")
            if raw_origin is None:
                return True, None
            try:
                origin = _normalize_origin(raw_origin)
            except DashboardServerError:
                return False, None
            return origin == host_origin, origin

        def _request_context(self) -> tuple[bool, str | None]:
            trusted_origin, origin = self._origin_context()
            if not trusted_origin:
                return False, origin
            provided = self.headers.get(SESSION_TOKEN_HEADER, "")
            return secrets.compare_digest(provided, token), origin

        def _security_headers(self) -> None:
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("Permissions-Policy", PERMISSIONS_POLICY)
            self.send_header(
                "Content-Security-Policy", DASHBOARD_CONTENT_SECURITY_POLICY
            )

        def _send_json_error(
            self,
            status: HTTPStatus,
            message: str,
            origin: str | None = None,
        ) -> None:
            body = _canonical_json({"ok": False, "error": message})
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._security_headers()
            self.end_headers()
            self.wfile.write(body)

        def _session_description(self) -> bytes:
            data, _ = current_snapshot()
            run = data.get("run")
            run_id = run.get("id") if isinstance(run, dict) else None
            return _canonical_json(
                {
                    "contract": DASHBOARD_SESSION_CONTRACT,
                    "run_id": run_id,
                    "session_transport": "fragment-to-header",
                    "session_header": SESSION_TOKEN_HEADER,
                    "evidence_read_only": True,
                    "eval_mutation": False,
                    "action_requests_enabled": True,
                    "data_endpoint": "/dashboard-data.json",
                    "action_request_endpoint": "/dashboard-action-requests",
                    "action_audit_endpoint": "/dashboard-action-requests.json",
                    "agent_handoff": agent_handoff(task_root),
                }
            )

        def _resolve_static_ui(self, request_path: str) -> Path | None:
            if ui_root is None:
                return None
            if request_path == "/skill-reviewer":
                return ui_root / "index.html"
            if not request_path.startswith("/skill-reviewer/"):
                return None
            relative_text = request_path.removeprefix("/skill-reviewer/")
            if (
                len(relative_text) > 512
                or "\x00" in relative_text
                or "\\" in relative_text
            ):
                raise DashboardServerError("local Dashboard asset path is invalid")
            relative = Path(relative_text or "index.html")
            if relative.is_absolute() or ".." in relative.parts:
                raise DashboardServerError("local Dashboard asset path is invalid")
            candidate = ui_root / relative
            current = ui_root
            for part in relative.parts:
                current = current / part
                if current.is_symlink():
                    raise DashboardServerError("local Dashboard assets cannot use symlinks")
            resolved = candidate.resolve()
            if ui_root not in resolved.parents:
                raise DashboardServerError("local Dashboard asset leaves its root")
            if not resolved.is_file():
                raise FileNotFoundError(request_path)
            return resolved

        def _serve_static_ui(self, include_body: bool, request_path: str) -> bool:
            if _request_loopback_origin(self.headers.get("Host")) is None:
                self._send_json_error(
                    HTTPStatus.FORBIDDEN,
                    "dashboard control plane Host is not loopback",
                )
                return True
            try:
                path = self._resolve_static_ui(request_path)
            except DashboardServerError as error:
                self._send_json_error(HTTPStatus.BAD_REQUEST, str(error))
                return True
            except FileNotFoundError:
                self._send_json_error(HTTPStatus.NOT_FOUND, "route not found")
                return True
            if path is None:
                return False
            try:
                body = path.read_bytes()
            except OSError:
                self._send_json_error(HTTPStatus.NOT_FOUND, "route not found")
                return True
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self._security_headers()
            self.end_headers()
            if include_body:
                self.wfile.write(body)
            return True

        def _resolve_request(
            self,
        ) -> tuple[Path | None, str, str | None, bytes | None]:
            request_path = unquote(urlparse(self.path).path)
            if request_path in {"/", "/dashboard-session.json"}:
                return (
                    None,
                    "application/json; charset=utf-8",
                    None,
                    self._session_description(),
                )
            if request_path == "/dashboard-data.json":
                return (
                    None,
                    "application/json; charset=utf-8",
                    None,
                    refresh_snapshot(),
                )
            if request_path == "/dashboard-action-requests.json":
                return (
                    None,
                    "application/json; charset=utf-8",
                    None,
                    action_task_log_body(),
                )
            diff_route = resolve_diff_route(request_path)
            if diff_route is not None:
                path, payload_digest = diff_route
                return (
                    path,
                    "application/json; charset=utf-8",
                    payload_digest,
                    None,
                )
            if request_path.startswith("/dashboard-diffs/"):
                raise DashboardServerError(
                    "diff payload is not registered by the dashboard read model"
                )
            evidence_route = resolve_evidence_route(request_path)
            if evidence_route is not None:
                return (
                    None,
                    "application/json; charset=utf-8",
                    None,
                    _render_evidence_payload(evidence_route),
                )
            if request_path.startswith("/dashboard-evidence/"):
                raise DashboardServerError(
                    "evidence content is not registered by the dashboard read model"
                )
            raise FileNotFoundError(request_path)

        def _serve(self, include_body: bool) -> None:
            request_path = unquote(urlparse(self.path).path)
            if self._serve_static_ui(include_body, request_path):
                return
            trusted, origin = self._request_context()
            if not trusted:
                self._send_json_error(
                    HTTPStatus.FORBIDDEN,
                    "dashboard control-plane session is not authorized",
                    origin,
                )
                return
            try:
                path, content_type, expected_digest, body = self._resolve_request()
            except DashboardServerError as error:
                self._send_json_error(HTTPStatus.BAD_REQUEST, str(error), origin)
                return
            except FileNotFoundError:
                self._send_json_error(HTTPStatus.NOT_FOUND, "route not found", origin)
                return
            if path is not None and not path.is_file():
                self._send_json_error(HTTPStatus.NOT_FOUND, "route not found", origin)
                return
            try:
                if path is not None and expected_digest is not None and (
                    path.is_symlink()
                    or path.stat().st_size > DASHBOARD_DIFF_PAYLOAD_FILE_LIMIT_BYTES
                ):
                    raise DashboardServerError(
                        "dashboard diff payload changed after validation"
                    )
                if body is None and path is not None:
                    body = path.read_bytes()
                if body is None:
                    raise DashboardServerError("dashboard response has no body")
                if expected_digest is not None and (
                    len(body) > DASHBOARD_DIFF_PAYLOAD_FILE_LIMIT_BYTES
                    or _sha256_bytes(body) != expected_digest
                ):
                    raise DashboardServerError(
                        "dashboard diff payload digest changed after validation"
                    )
            except DashboardServerError as error:
                self._send_json_error(HTTPStatus.BAD_REQUEST, str(error), origin)
                return
            except OSError:
                self._send_json_error(HTTPStatus.NOT_FOUND, "route not found", origin)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self._security_headers()
            self.end_headers()
            if include_body:
                self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
            self._serve(include_body=True)

        def do_HEAD(self) -> None:  # noqa: N802 - stdlib callback name
            self._serve(include_body=False)

        def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib callback name
            trusted, origin = self._origin_context()
            if not trusted or origin is None:
                self._send_json_error(
                    HTTPStatus.FORBIDDEN,
                    "dashboard control-plane preflight is not same-origin",
                )
                return
            request_path = unquote(urlparse(self.path).path)
            is_action = request_path == "/dashboard-action-requests"
            is_read = (
                request_path
                in {
                    "/",
                    "/dashboard-session.json",
                    "/dashboard-data.json",
                    "/dashboard-action-requests.json",
                }
                or request_path.startswith("/dashboard-diffs/")
                or request_path.startswith("/dashboard-evidence/")
            )
            if not is_action and not is_read:
                self._send_json_error(HTTPStatus.NOT_FOUND, "route not found", origin)
                return
            allowed_methods = "POST, OPTIONS" if is_action else "GET, HEAD, OPTIONS"
            requested_method = self.headers.get("Access-Control-Request-Method")
            allowed_method_set = {
                method.strip() for method in allowed_methods.split(",")
            }
            if requested_method and requested_method not in allowed_method_set:
                self._send_json_error(
                    HTTPStatus.METHOD_NOT_ALLOWED,
                    "requested control-plane method is not allowed",
                    origin,
                )
                return
            requested_headers = {
                value.strip().lower()
                for value in self.headers.get(
                    "Access-Control-Request-Headers", ""
                ).split(",")
                if value.strip()
            }
            allowed_headers = {SESSION_TOKEN_HEADER.lower()}
            if is_action:
                allowed_headers.add("content-type")
            if (
                SESSION_TOKEN_HEADER.lower() not in requested_headers
                or not requested_headers.issubset(allowed_headers)
            ):
                self._send_json_error(
                    HTTPStatus.FORBIDDEN,
                    "dashboard control-plane preflight headers are not trusted",
                    origin,
                )
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Length", "0")
            self.send_header("Allow", allowed_methods)
            self._security_headers()
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
            trusted, origin = self._request_context()
            if not trusted:
                self._send_json_error(
                    HTTPStatus.FORBIDDEN,
                    "dashboard action request session is not authorized",
                    origin,
                )
                return
            request_path = unquote(urlparse(self.path).path)
            if request_path != "/dashboard-action-requests":
                self._send_json_error(
                    HTTPStatus.METHOD_NOT_ALLOWED,
                    "evidence routes are read-only",
                    origin,
                )
                return
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0]
            if content_type.strip().lower() != "application/json":
                self._send_json_error(
                    HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                    "dashboard action requests require application/json",
                    origin,
                )
                return
            try:
                content_length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                content_length = -1
            if content_length < 0 or content_length > ACTION_REQUEST_LIMIT_BYTES:
                self._send_json_error(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    "dashboard action request exceeds the bounded size",
                    origin,
                )
                return
            try:
                raw = self.rfile.read(content_length)
                if len(raw) != content_length:
                    raise DashboardServerError(
                        "dashboard action request body is incomplete"
                    )
                payload = json.loads(raw.decode("utf-8"))
                data, dashboard_digest = current_snapshot()
                request, action = _validate_action_request(
                    payload=payload,
                    data=data,
                )
                with task_lock:
                    task, created = _append_action_task(
                        task_root=task_root,
                        request=request,
                        action=action,
                        dashboard_digest=dashboard_digest,
                    )
                if created:
                    print(
                        json.dumps(
                            {
                                "event": "dashboard_agent_handoff_saved",
                                "task_id": task.get("id"),
                                "run_id": task.get("run_id"),
                                "action_id": task.get("action_id"),
                                "expected_next_action": task.get(
                                    "expected_next_action"
                                ),
                                "task_root": str(task_root),
                            },
                            ensure_ascii=False,
                        ),
                        file=sys.stderr,
                        flush=True,
                    )
                response = _canonical_json(
                    {
                        "contract": "skill-reviewer.dashboard-action-task-response",
                        "created": created,
                        "task": task,
                        "handoff": agent_handoff(task_root),
                    }
                )
            except (UnicodeDecodeError, json.JSONDecodeError, DashboardServerError) as error:
                self._send_json_error(HTTPStatus.BAD_REQUEST, str(error), origin)
                return
            self.send_response(HTTPStatus.CREATED if created else HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(response)))
            self._security_headers()
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, format: str, *args: object) -> None:
            print(f"dashboard {self.address_string()} {format % args}", file=sys.stderr)

    return Handler


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument(
        "--task-root",
        type=Path,
        help="Append-only task ledger outside the immutable run workspace.",
    )
    parser.add_argument(
        "--ui-dir",
        type=Path,
        help="Trusted local UI build. Normal users should use start_skill_dashboard.py.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4174)
    parser.add_argument("--check", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        validate_loopback_bind_host(args.host)
        report = validate_sources(args.workspace, args.task_root)
        if args.check:
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 0
        session_token = secrets.token_urlsafe(32)
        handler = create_handler(
            args.workspace,
            args.task_root,
            session_token=session_token,
            static_ui_root=args.ui_dir,
        )
        server = ThreadingHTTPServer((args.host, args.port), handler)
    except (DashboardServerError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 2
    host, port = server.server_address[:2]
    authority = f"[{host}]" if ":" in str(host) else str(host)
    origin = f"http://{authority}:{port}"
    print(
        json.dumps(
            {
                **report,
                "url": origin,
                "base_url": origin,
                "data_url": f"{origin}/dashboard-data.json",
                "session_url": f"{origin}/dashboard-session.json",
                "session_token": session_token,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

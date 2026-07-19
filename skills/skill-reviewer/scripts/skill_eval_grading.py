#!/usr/bin/env python3
"""Retain, validate, and grade observable Skill Eval execution evidence."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import math
import os
import re
from pathlib import Path
from typing import Any, Iterable

from skill_eval_authority import (
    DISPATCH_OBSERVATIONS,
    TRACE_CAPTURE_SOURCE_PATTERN,
    load_json,
    load_json_value,
    reject_json_constant,
    require_finite_json,
    require_number,
    require_real_directory,
    require_string,
    safe_artifact,
    sha256_file,
    sha256_json,
    trace_assignment_context,
    validate_artifact_path,
    verify_locked_inputs,
    write_json,
)
from skill_eval_contracts import (
    ASSIGNMENT_CONTRACT,
    DETERMINISTIC_ASSERTION_TYPES,
    DISPATCH_RECEIPT_CONTRACT,
    EXECUTION_CONTRACT,
    ManifestError,
    PLAN_CONTRACT,
    SEMANTIC_ASSERTION_TYPES,
    SEMANTIC_JUDGMENT_CONTRACT,
    TRACE_EVENT_CONTRACT,
    VERIFICATION_CONTRACT,
)
from skill_eval_measurement import assess_runtime_measurement, evaluate_text_assertion

MAX_PAIRED_DISPATCH_SKEW_MS = 5_000
RESERVED_ARM_RESULT_FIELDS = {
    "arm",
    "complete",
    "passed",
    "required_pass_rate",
    "forbidden_actions",
    "side_effects",
    "binding_errors",
    "repeats",
    "artifacts",
}
EXECUTION_FIELDS = {
    "contract",
    "run_id",
    "case_id",
    "arm",
    "repeat",
    "assignment_digest",
    "execution_profile_digest",
    "status",
    "forbidden_actions",
    "side_effects",
    "metrics",
    "artifact_digests",
    "dispatch",
    "source_trace",
    "trace",
}
DISPATCH_RECEIPT_FIELDS = {
    "contract",
    "run_id",
    "case_id",
    "arm",
    "repeat",
    "assignment_digest",
    "execution_profile_digest",
    "provider",
    "harness",
    "observation",
    "dispatch_id",
    "worker_id",
    "batch_id",
    "dispatched_at",
}
DISPATCH_DESCRIPTOR_FIELDS = {
    "artifact",
    "digest",
    "provider",
    "harness",
    "observation",
    "dispatch_id",
    "worker_id",
    "batch_id",
    "dispatched_at",
}
SOURCE_TRACE_DESCRIPTOR_FIELDS = {
    "artifact",
    "digest",
    "adapter",
    "format",
    "source_stream_digest",
    "source_event_count",
    "retained_event_count",
    "redaction",
}
TRACE_DESCRIPTOR_FIELDS = {
    "artifact",
    "digest",
    "capture_source",
    "source_trace_required",
    "complete",
    "event_count",
    "started_at",
    "finished_at",
    "duration_ms",
}
TRACE_EVENT_FIELDS = {
    "contract",
    "event_id",
    "run_id",
    "case_id",
    "arm",
    "repeat",
    "sequence",
    "occurred_at",
    "elapsed_ms",
    "kind",
    "status",
    "summary",
    "details",
    "artifact_refs",
}
TRACE_EVENT_KINDS = {
    "execution_started",
    "file_read",
    "tool_call",
    "command",
    "agent_message",
    "artifact_written",
    "error",
    "execution_finished",
}
TRACE_FORBIDDEN_DETAIL_KEYS = {
    "analysis",
    "chain_of_thought",
    "private_reasoning",
    "reasoning",
    "signature",
    "thinking",
    "thought",
    "thoughts",
}

def _trace_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _parse_trace_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _expected_dispatch_observation(profile: dict[str, Any]) -> str:
    observation = profile.get("dispatch_observation")
    if observation not in DISPATCH_OBSERVATIONS:
        raise ManifestError("execution profile dispatch_observation is invalid")
    return str(observation)


def _bound_execution_profile(
    *, assignment_path: Path, workspace: Path, assignment: dict[str, Any]
) -> dict[str, Any]:
    plan_path = safe_artifact(workspace, "execution-plan.json")
    lock_path = safe_artifact(workspace, "run-lock.json")
    if not plan_path.is_file() or not lock_path.is_file():
        raise ManifestError("dispatch receipt requires execution-plan.json and run-lock.json")
    plan = load_json(plan_path)
    lock = load_json(lock_path)
    relative_assignment = assignment_path.resolve().relative_to(workspace).as_posix()
    assignment_digests = lock.get("assignment_digests")
    if (
        not isinstance(assignment_digests, dict)
        or assignment_digests.get(relative_assignment) != sha256_file(assignment_path)
    ):
        raise ManifestError("dispatch assignment digest does not match the run lock")
    if lock.get("plan_digest") != sha256_file(plan_path):
        raise ManifestError("dispatch execution plan digest does not match the run lock")
    profile = plan.get("execution_profile")
    if not isinstance(profile, dict):
        raise ManifestError("dispatch execution profile is missing")
    if profile.get("digest") != assignment.get("execution_profile_digest"):
        raise ManifestError("dispatch execution profile digest is stale")
    if plan.get("run_id") != assignment.get("run_id"):
        raise ManifestError("dispatch assignment and plan identities do not match")
    return profile


def record_dispatch_receipt(
    *,
    assignment_path: Path,
    workspace: Path,
    dispatch_id: str,
    worker_id: str,
    batch_id: str | None = None,
) -> dict[str, Any]:
    workspace = workspace.resolve()
    assignment_path = assignment_path.resolve()
    assignment, repeat_root, _trace_path = trace_assignment_context(
        assignment_path=assignment_path, workspace=workspace
    )
    profile = _bound_execution_profile(
        assignment_path=assignment_path,
        workspace=workspace,
        assignment=assignment,
    )
    normalized_dispatch_id = require_string(dispatch_id, "dispatch_id")
    normalized_worker_id = require_string(worker_id, "worker_id")
    if len(normalized_dispatch_id) > 256 or len(normalized_worker_id) > 256:
        raise ManifestError("dispatch_id and worker_id must not exceed 256 characters")
    normalized_batch_id = (
        require_string(batch_id, "batch_id")
        if batch_id is not None
        else "batch-"
        + sha256_json(
            {
                "run_id": assignment.get("run_id"),
                "case_id": assignment.get("case_id"),
                "repeat": assignment.get("repeat"),
            }
        )[:20]
    )
    if len(normalized_batch_id) > 256:
        raise ManifestError("batch_id must not exceed 256 characters")
    artifact = validate_artifact_path(
        assignment.get("dispatch_artifact"), "assignment.dispatch_artifact"
    )
    receipt_path = safe_artifact(repeat_root, artifact)
    if receipt_path.exists() or receipt_path.is_symlink():
        raise ManifestError("dispatch receipt is already recorded")
    receipt = {
        "contract": DISPATCH_RECEIPT_CONTRACT,
        "run_id": assignment.get("run_id"),
        "case_id": assignment.get("case_id"),
        "arm": assignment.get("arm"),
        "repeat": assignment.get("repeat"),
        "assignment_digest": sha256_file(assignment_path),
        "execution_profile_digest": assignment.get("execution_profile_digest"),
        "provider": profile.get("target"),
        "harness": profile.get("harness"),
        "observation": _expected_dispatch_observation(profile),
        "dispatch_id": normalized_dispatch_id,
        "worker_id": normalized_worker_id,
        "batch_id": normalized_batch_id,
        "dispatched_at": _trace_timestamp(),
    }
    write_json(receipt_path, receipt)
    return receipt


def _dispatch_descriptor(
    *, assignment: dict[str, Any], repeat_root: Path
) -> dict[str, Any] | None:
    artifact = validate_artifact_path(
        assignment.get("dispatch_artifact"), "assignment.dispatch_artifact"
    )
    receipt_path = safe_artifact(repeat_root, artifact)
    if not receipt_path.is_file():
        return None
    receipt = load_json(receipt_path)
    return {
        "artifact": artifact,
        "digest": sha256_file(receipt_path),
        **{
            key: receipt.get(key)
            for key in (
                "provider",
                "harness",
                "observation",
                "dispatch_id",
                "worker_id",
                "batch_id",
                "dispatched_at",
            )
        },
    }


def _validate_dispatch_receipt(
    *,
    repeat_root: Path,
    descriptor: Any,
    assignment: dict[str, Any],
    assignment_digest: str,
    execution_profile: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    expected_artifact = validate_artifact_path(
        assignment.get("dispatch_artifact"), "assignment.dispatch_artifact"
    )
    if not isinstance(descriptor, dict):
        return {"artifact": expected_artifact}, ["execution dispatch receipt is missing"]
    unsupported = sorted(set(descriptor) - DISPATCH_DESCRIPTOR_FIELDS)
    if unsupported:
        errors.append(
            "execution dispatch descriptor contains unsupported fields: "
            + ", ".join(unsupported)
        )
    missing = sorted(DISPATCH_DESCRIPTOR_FIELDS - set(descriptor))
    if missing:
        errors.append(
            "execution dispatch descriptor is missing fields: " + ", ".join(missing)
        )
    if descriptor.get("artifact") != expected_artifact:
        errors.append("execution dispatch artifact does not match the locked assignment")
    receipt_path = safe_artifact(repeat_root, expected_artifact)
    if not receipt_path.is_file():
        return dict(descriptor), [*errors, "dispatch-receipt.json is missing"]
    actual_digest = sha256_file(receipt_path)
    if descriptor.get("digest") != actual_digest:
        errors.append("dispatch receipt digest is missing or mismatched")
    try:
        receipt = load_json(receipt_path)
    except ManifestError as error:
        return {**descriptor, "digest": actual_digest}, [*errors, str(error)]
    unsupported_receipt = sorted(set(receipt) - DISPATCH_RECEIPT_FIELDS)
    if unsupported_receipt:
        errors.append(
            "dispatch receipt contains unsupported fields: "
            + ", ".join(unsupported_receipt)
        )
    missing_receipt = sorted(DISPATCH_RECEIPT_FIELDS - set(receipt))
    if missing_receipt:
        errors.append("dispatch receipt is missing fields: " + ", ".join(missing_receipt))
    expected_identity = {
        "contract": DISPATCH_RECEIPT_CONTRACT,
        "run_id": assignment.get("run_id"),
        "case_id": assignment.get("case_id"),
        "arm": assignment.get("arm"),
        "repeat": assignment.get("repeat"),
        "assignment_digest": assignment_digest,
        "execution_profile_digest": assignment.get("execution_profile_digest"),
        "provider": execution_profile.get("target"),
        "harness": execution_profile.get("harness"),
        "observation": _expected_dispatch_observation(execution_profile),
    }
    for key, expected_value in expected_identity.items():
        if receipt.get(key) != expected_value:
            errors.append(f"dispatch receipt {key} does not match the locked execution")
    for key in (
        "provider",
        "harness",
        "observation",
        "dispatch_id",
        "worker_id",
        "batch_id",
        "dispatched_at",
    ):
        if descriptor.get(key) != receipt.get(key):
            errors.append(f"execution dispatch {key} does not match its receipt")
    if receipt.get("observation") not in DISPATCH_OBSERVATIONS:
        errors.append("dispatch receipt observation is invalid")
    for key in ("dispatch_id", "worker_id", "batch_id"):
        if not isinstance(receipt.get(key), str) or not receipt.get(key):
            errors.append(f"dispatch receipt {key} is invalid")
    if _parse_trace_timestamp(receipt.get("dispatched_at")) is None:
        errors.append("dispatch receipt dispatched_at is invalid")
    return {**descriptor, "digest": actual_digest}, errors


def _validate_source_trace(
    *,
    repeat_root: Path,
    descriptor: Any,
    assignment: dict[str, Any],
    trace_events: list[dict[str, Any]],
    required: bool,
    expected_adapter: str | None,
    expected_format: str | None,
) -> tuple[dict[str, Any] | None, list[str]]:
    errors: list[str] = []
    locked_artifact = assignment.get("source_trace_artifact")
    expected_artifact = (
        validate_artifact_path(
            locked_artifact,
            "assignment.source_trace_artifact",
        )
        if locked_artifact is not None
        else None
    )
    if descriptor is None:
        return None, ["required source trace descriptor is missing"] if required else []
    if not isinstance(descriptor, dict):
        return None, ["execution source_trace must be an object or null"]
    if expected_artifact is None:
        return dict(descriptor), [
            "execution source_trace is present but the locked profile declares no source stream"
        ]
    unsupported = sorted(set(descriptor) - SOURCE_TRACE_DESCRIPTOR_FIELDS)
    if unsupported:
        errors.append(
            "execution source trace contains unsupported fields: "
            + ", ".join(unsupported)
        )
    missing = sorted(SOURCE_TRACE_DESCRIPTOR_FIELDS - set(descriptor))
    if missing:
        errors.append("execution source trace is missing fields: " + ", ".join(missing))
    if descriptor.get("artifact") != expected_artifact:
        errors.append("execution source trace artifact does not match the locked assignment")
    source_path = safe_artifact(repeat_root, expected_artifact)
    if not source_path.is_file():
        return dict(descriptor), [*errors, "source trace artifact is missing"]
    actual_digest = sha256_file(source_path)
    if descriptor.get("digest") != actual_digest:
        errors.append("source trace digest is missing or mismatched")
    if descriptor.get("adapter") != expected_adapter:
        errors.append("source trace adapter does not match the locked execution profile")
    if descriptor.get("format") != expected_format:
        errors.append("source trace format does not match the locked execution profile")
    source_stream_digest = descriptor.get("source_stream_digest")
    if not isinstance(source_stream_digest, str) or not re.fullmatch(
        r"[a-f0-9]{64}", source_stream_digest
    ):
        errors.append("source trace source_stream_digest is invalid")
    source_event_count = descriptor.get("source_event_count")
    retained_event_count = descriptor.get("retained_event_count")
    if (
        not isinstance(source_event_count, int)
        or isinstance(source_event_count, bool)
        or source_event_count < 0
    ):
        errors.append("source trace source_event_count is invalid")
    if (
        not isinstance(retained_event_count, int)
        or isinstance(retained_event_count, bool)
        or retained_event_count < 0
    ):
        errors.append("source trace retained_event_count is invalid")
    try:
        retained_lines = [
            line
            for line in source_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        actual_retained_count = len(retained_lines)
    except (OSError, UnicodeDecodeError) as error:
        errors.append(f"source trace artifact is unreadable: {error}")
        actual_retained_count = None
        retained_lines = []
    for index, line in enumerate(retained_lines, start=1):
        try:
            event = json.loads(line, parse_constant=reject_json_constant)
            require_finite_json(event, f"source trace line {index}")
        except (json.JSONDecodeError, ValueError, ManifestError) as error:
            errors.append(f"source trace line {index} is invalid JSON: {error}")
            continue
        if not isinstance(event, dict):
            errors.append(f"source trace line {index} must be an object")
            continue
        forbidden_keys = sorted(_forbidden_trace_detail_keys(event))
        if forbidden_keys:
            errors.append(
                f"source trace line {index} contains private-reasoning fields: "
                + ", ".join(forbidden_keys)
            )
        pending: list[Any] = [event]
        while pending:
            value = pending.pop()
            if isinstance(value, dict):
                if value.get("type") == "reasoning" and value.get("redacted") is not True:
                    errors.append(
                        f"source trace line {index} contains unredacted reasoning"
                    )
                    break
                if value.get("type") == "thinking" and value.get("redacted") is not True:
                    errors.append(
                        f"source trace line {index} contains unredacted thinking"
                    )
                    break
                pending.extend(value.values())
            elif isinstance(value, list):
                pending.extend(value)
    if actual_retained_count is not None and retained_event_count != actual_retained_count:
        errors.append("source trace retained_event_count does not match the artifact")
    if (
        isinstance(source_event_count, int)
        and isinstance(retained_event_count, int)
        and source_event_count < retained_event_count
    ):
        errors.append("source trace source_event_count is smaller than retained events")
    if descriptor.get("redaction") != "private-reasoning-fields-removed":
        errors.append("source trace redaction contract is invalid")
    matching_events = [
        event
        for event in trace_events
        if event.get("kind") == "artifact_written"
        and expected_artifact in event.get("artifact_refs", [])
    ]
    if not matching_events:
        errors.append("agent trace is missing source trace artifact provenance")
    elif not any(
        isinstance(event.get("details"), dict)
        and event["details"].get("digest") == descriptor.get("digest")
        and event["details"].get("source_stream_digest")
        == descriptor.get("source_stream_digest")
        and event["details"].get("source_event_count")
        == descriptor.get("source_event_count")
        and event["details"].get("retained_event_count")
        == descriptor.get("retained_event_count")
        and event["details"].get("redaction") == descriptor.get("redaction")
        and event["details"].get("adapter") == descriptor.get("adapter")
        and event["details"].get("format") == descriptor.get("format")
        for event in matching_events
    ):
        errors.append("source trace descriptor is not bound to its artifact event")
    return {**descriptor, "digest": actual_digest}, errors


def _forbidden_trace_detail_keys(value: Any) -> set[str]:
    forbidden: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = str(key).strip().lower().replace("-", "_")
            if normalized in TRACE_FORBIDDEN_DETAIL_KEYS:
                forbidden.add(str(key))
            forbidden.update(_forbidden_trace_detail_keys(item))
    elif isinstance(value, list):
        for item in value:
            forbidden.update(_forbidden_trace_detail_keys(item))
    return forbidden


def _read_trace_jsonl(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    events: list[dict[str, Any]] = []
    errors: list[str] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        return [], [f"agent trace is unreadable: {error}"]
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            errors.append(f"agent trace line {line_number} is empty")
            continue
        try:
            value = json.loads(line, parse_constant=reject_json_constant)
            require_finite_json(value, f"agent trace line {line_number}")
        except (json.JSONDecodeError, ValueError, ManifestError) as error:
            errors.append(f"agent trace line {line_number} is invalid JSON: {error}")
            continue
        if not isinstance(value, dict):
            errors.append(f"agent trace line {line_number} must be an object")
            continue
        events.append(value)
    return events, errors


def _validate_agent_trace(
    *,
    trace_path: Path,
    descriptor: Any,
    expected_identity: dict[str, Any],
    expected_status: Any,
    expected_artifact: str,
    expected_capture_source: str,
    source_trace_required: bool,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
    errors: list[str] = []
    if not isinstance(descriptor, dict):
        return [], {}, ["execution trace must be an object"]
    unsupported = sorted(set(descriptor) - TRACE_DESCRIPTOR_FIELDS)
    if unsupported:
        errors.append(
            "execution trace contains unsupported fields: " + ", ".join(unsupported)
        )
    missing = sorted(TRACE_DESCRIPTOR_FIELDS - set(descriptor))
    if missing:
        errors.append("execution trace is missing fields: " + ", ".join(missing))
    if descriptor.get("artifact") != expected_artifact:
        errors.append("execution trace artifact does not match the locked assignment")
    if descriptor.get("capture_source") != expected_capture_source:
        errors.append(
            "execution trace capture_source does not match the locked execution profile"
        )
    if descriptor.get("source_trace_required") is not source_trace_required:
        errors.append(
            "execution trace source_trace_required does not match the locked execution profile"
        )
    if descriptor.get("complete") is not True:
        errors.append("execution trace is not finalized")
    if not trace_path.is_file():
        return [], dict(descriptor), [*errors, "agent-trace.jsonl is missing"]

    actual_digest = sha256_file(trace_path)
    if descriptor.get("digest") != actual_digest:
        errors.append("execution trace digest is missing or mismatched")
    events, parse_errors = _read_trace_jsonl(trace_path)
    errors.extend(parse_errors)
    seen_ids: set[str] = set()
    previous_elapsed = -1
    for index, event in enumerate(events, start=1):
        unsupported_event_fields = sorted(set(event) - TRACE_EVENT_FIELDS)
        if unsupported_event_fields:
            errors.append(
                f"agent trace event {index} contains unsupported fields: "
                + ", ".join(unsupported_event_fields)
            )
        missing_event_fields = sorted(TRACE_EVENT_FIELDS - set(event))
        if missing_event_fields:
            errors.append(
                f"agent trace event {index} is missing fields: "
                + ", ".join(missing_event_fields)
            )
        if event.get("contract") != TRACE_EVENT_CONTRACT:
            errors.append(f"agent trace event {index} contract is invalid")
        for key, expected_value in expected_identity.items():
            if event.get(key) != expected_value:
                errors.append(
                    f"agent trace event {index} {key} does not match the locked assignment"
                )
        if event.get("sequence") != index:
            errors.append(f"agent trace event {index} sequence is not contiguous")
        event_id = event.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            errors.append(f"agent trace event {index} event_id is invalid")
        elif event_id in seen_ids:
            errors.append(f"agent trace event {index} event_id is duplicated")
        else:
            seen_ids.add(event_id)
        if event.get("kind") not in TRACE_EVENT_KINDS:
            errors.append(f"agent trace event {index} kind is invalid")
        if _parse_trace_timestamp(event.get("occurred_at")) is None:
            errors.append(f"agent trace event {index} occurred_at is invalid")
        elapsed = event.get("elapsed_ms")
        if not isinstance(elapsed, int) or isinstance(elapsed, bool) or elapsed < 0:
            errors.append(f"agent trace event {index} elapsed_ms is invalid")
        elif elapsed < previous_elapsed:
            errors.append(f"agent trace event {index} elapsed_ms is not monotonic")
        else:
            previous_elapsed = elapsed
        if not isinstance(event.get("status"), str) or not event.get("status"):
            errors.append(f"agent trace event {index} status is invalid")
        if not isinstance(event.get("summary"), str) or not event.get("summary"):
            errors.append(f"agent trace event {index} summary is invalid")
        details = event.get("details")
        if not isinstance(details, dict):
            errors.append(f"agent trace event {index} details must be an object")
        else:
            forbidden_keys = sorted(_forbidden_trace_detail_keys(details))
            if forbidden_keys:
                errors.append(
                    f"agent trace event {index} contains private-reasoning fields: "
                    + ", ".join(forbidden_keys)
                )
        artifact_refs = event.get("artifact_refs")
        if not isinstance(artifact_refs, list) or not all(
            isinstance(value, str) and value for value in artifact_refs
        ):
            errors.append(
                f"agent trace event {index} artifact_refs must be an array of paths"
            )

    if not events:
        errors.append("agent trace contains no events")
    else:
        first = events[0]
        last = events[-1]
        if first.get("kind") != "execution_started":
            errors.append("agent trace must start with execution_started")
        if last.get("kind") != "execution_finished":
            errors.append("agent trace must end with execution_finished")
        if last.get("status") != expected_status:
            errors.append("agent trace final status does not match execution status")
        if descriptor.get("started_at") != first.get("occurred_at"):
            errors.append("execution trace started_at does not match the first event")
        if descriptor.get("finished_at") != last.get("occurred_at"):
            errors.append("execution trace finished_at does not match the final event")
        if descriptor.get("duration_ms") != last.get("elapsed_ms"):
            errors.append("execution trace duration_ms does not match the final event")
        if not any(
            event.get("kind")
            in {
                "file_read",
                "tool_call",
                "command",
                "agent_message",
                "artifact_written",
                "error",
            }
            for event in events
        ):
            errors.append("agent trace contains no observable Agent action")
        first_details = first.get("details")
        if (
            not isinstance(first_details, dict)
            or first_details.get("capture_source") != descriptor.get("capture_source")
        ):
            errors.append("execution trace capture_source is not bound to its first event")
    if descriptor.get("event_count") != len(events):
        errors.append("execution trace event_count does not match the JSONL record")
    duration = descriptor.get("duration_ms")
    if not isinstance(duration, int) or isinstance(duration, bool) or duration < 0:
        errors.append("execution trace duration_ms is invalid")
    return events, {**descriptor, "digest": actual_digest}, errors


def _trace_event_ids_by_artifact(
    events: Iterable[dict[str, Any]],
) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for event in events:
        event_id = event.get("event_id")
        if event.get("kind") != "artifact_written" or not isinstance(event_id, str):
            continue
        refs = event.get("artifact_refs")
        if not isinstance(refs, list):
            continue
        for ref in refs:
            if isinstance(ref, str) and ref:
                result.setdefault(ref, []).append(event_id)
    return result


def _append_trace_event(path: Path, event: dict[str, Any]) -> None:
    if path.is_symlink() or path.parent.resolve() != path.parent:
        raise ManifestError(f"refusing to append through a symbolic link: {path}")
    try:
        payload = json.dumps(
            event, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ) + "\n"
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except (OSError, TypeError, ValueError) as error:
        raise ManifestError(f"unable to append Agent trace event: {path}") from error


def _new_trace_event(
    *,
    assignment: dict[str, Any],
    sequence: int,
    started_at: str,
    kind: str,
    status: str,
    summary: str,
    details: dict[str, Any],
    artifact_refs: list[str],
) -> dict[str, Any]:
    occurred_at = _trace_timestamp()
    started = _parse_trace_timestamp(started_at)
    occurred = _parse_trace_timestamp(occurred_at)
    elapsed_ms = (
        max(0, int((occurred - started).total_seconds() * 1000))
        if started is not None and occurred is not None
        else 0
    )
    identity = {
        "run_id": assignment.get("run_id"),
        "case_id": assignment.get("case_id"),
        "arm": assignment.get("arm"),
        "repeat": assignment.get("repeat"),
    }
    event_id = "event-{:04d}-{}".format(
        sequence,
        sha256_json(
            {
                **identity,
                "sequence": sequence,
                "occurred_at": occurred_at,
                "kind": kind,
                "summary": summary,
            }
        )[:12],
    )
    return {
        "contract": TRACE_EVENT_CONTRACT,
        "event_id": event_id,
        **identity,
        "sequence": sequence,
        "occurred_at": occurred_at,
        "elapsed_ms": elapsed_ms,
        "kind": kind,
        "status": status,
        "summary": summary,
        "details": details,
        "artifact_refs": artifact_refs,
    }


def record_trace_event(
    *,
    assignment_path: Path,
    workspace: Path,
    kind: str,
    summary: str,
    status: str,
    details: dict[str, Any],
    artifact_refs: list[str],
    capture_source: str | None,
) -> dict[str, Any]:
    if kind not in TRACE_EVENT_KINDS:
        raise ManifestError(f"unsupported Agent trace event kind: {kind}")
    if not summary.strip():
        raise ManifestError("Agent trace event summary must not be empty")
    if not isinstance(details, dict):
        raise ManifestError("Agent trace event details must be an object")
    forbidden_keys = sorted(_forbidden_trace_detail_keys(details))
    if forbidden_keys:
        raise ManifestError(
            "Agent trace must not contain private-reasoning fields: "
            + ", ".join(forbidden_keys)
        )
    normalized_artifact_refs = [
        validate_artifact_path(value, "Agent trace artifact reference")
        for value in artifact_refs
    ]
    assignment, _repeat_root, trace_path = trace_assignment_context(
        assignment_path=assignment_path, workspace=workspace
    )
    if capture_source is None:
        execution_profile = _bound_execution_profile(
            assignment_path=assignment_path.resolve(),
            workspace=workspace.resolve(),
            assignment=assignment,
        )
        capture_source = require_string(
            execution_profile.get("trace", {}).get("capture_source"),
            "execution_profile.trace.capture_source",
        )
    if TRACE_CAPTURE_SOURCE_PATTERN.fullmatch(capture_source) is None:
        raise ManifestError(f"unsupported Agent trace capture source: {capture_source}")
    events: list[dict[str, Any]] = []
    if trace_path.exists():
        events, errors = _read_trace_jsonl(trace_path)
        if errors:
            raise ManifestError("existing Agent trace is invalid: " + "; ".join(errors))
        if events and events[-1].get("kind") == "execution_finished":
            raise ManifestError("Agent trace is already finalized")
        if (
            events
            and isinstance(events[0].get("details"), dict)
            and events[0]["details"].get("capture_source") != capture_source
        ):
            raise ManifestError("Agent trace capture source cannot change during execution")
    if not events:
        started_at = _trace_timestamp()
        start_event = _new_trace_event(
            assignment=assignment,
            sequence=1,
            started_at=started_at,
            kind="execution_started",
            status="running",
            summary="Agent execution started",
            details={"capture_source": capture_source},
            artifact_refs=[],
        )
        # Preserve an exact zero origin even if timestamp formatting takes time.
        start_event["elapsed_ms"] = 0
        _append_trace_event(trace_path, start_event)
        events.append(start_event)
    elif kind == "execution_started":
        raise ManifestError("Agent trace already has an execution_started event")
    if kind == "execution_started":
        return events[0]
    started_at = str(events[0].get("occurred_at"))
    event = _new_trace_event(
        assignment=assignment,
        sequence=len(events) + 1,
        started_at=started_at,
        kind=kind,
        status=status,
        summary=summary.strip(),
        details=details,
        artifact_refs=normalized_artifact_refs,
    )
    _append_trace_event(trace_path, event)
    return event


def finalize_execution(
    *,
    assignment_path: Path,
    workspace: Path,
    status: str,
    metrics: dict[str, Any],
    forbidden_actions: list[str],
    side_effects: list[str],
    capture_source: str | None,
    source_trace: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if status not in {"completed", "failed", "timed_out", "interrupted"}:
        raise ManifestError(f"unsupported execution status: {status}")
    assignment, repeat_root, trace_path = trace_assignment_context(
        assignment_path=assignment_path, workspace=workspace
    )
    execution_profile = _bound_execution_profile(
        assignment_path=assignment_path.resolve(),
        workspace=workspace.resolve(),
        assignment=assignment,
    )
    trace_profile = execution_profile.get("trace")
    if not isinstance(trace_profile, dict):
        raise ManifestError("execution profile trace contract is missing")
    expected_capture_source = require_string(
        trace_profile.get("capture_source"),
        "execution_profile.trace.capture_source",
    )
    if capture_source is None:
        capture_source = expected_capture_source
    if capture_source != expected_capture_source:
        raise ManifestError(
            "execution capture source does not match the locked execution profile"
        )
    source_profile = trace_profile.get("source")
    if source_profile is not None and not isinstance(source_profile, dict):
        raise ManifestError("execution profile trace source contract is invalid")
    execution_path = safe_artifact(
        repeat_root,
        validate_artifact_path(
            assignment.get("execution_artifact"), "assignment.execution_artifact"
        ),
    )
    if execution_path.exists() or execution_path.is_symlink():
        raise ManifestError("execution.json is already finalized")
    artifact_digests: dict[str, str] = {}
    expected_artifacts = assignment.get("expected_artifacts")
    if not isinstance(expected_artifacts, list) or not all(
        isinstance(value, str) for value in expected_artifacts
    ):
        raise ManifestError("assignment.expected_artifacts must be an array of paths")
    artifact_ownership = assignment.get("artifact_ownership")
    if (
        not isinstance(artifact_ownership, dict)
        or artifact_ownership.get("worker") != expected_artifacts
        or not isinstance(artifact_ownership.get("framework"), list)
        or not isinstance(artifact_ownership.get("asserted_framework"), list)
    ):
        raise ManifestError("assignment artifact ownership does not match expected artifacts")
    existing_events, existing_errors = (
        _read_trace_jsonl(trace_path) if trace_path.is_file() else ([], [])
    )
    if existing_errors:
        raise ManifestError("existing Agent trace is invalid: " + "; ".join(existing_errors))
    recorded_refs = {
        ref
        for event in existing_events
        if event.get("kind") == "artifact_written"
        for ref in event.get("artifact_refs", [])
        if isinstance(ref, str)
    }
    for artifact in expected_artifacts:
        artifact_path = safe_artifact(repeat_root, artifact)
        if not artifact_path.is_file():
            continue
        digest = sha256_file(artifact_path)
        artifact_digests[artifact] = digest
        if artifact not in recorded_refs:
            record_trace_event(
                assignment_path=assignment_path,
                workspace=workspace,
                kind="artifact_written",
                summary=f"Retained output artifact: {artifact}",
                status="completed",
                details={
                    "path": artifact,
                    "digest": digest,
                    "size": artifact_path.stat().st_size,
                },
                artifact_refs=[artifact],
                capture_source=capture_source,
            )
    record_trace_event(
        assignment_path=assignment_path,
        workspace=workspace,
        kind="execution_finished",
        summary=f"Agent execution finished with status: {status}",
        status=status,
        details={
            "forbidden_action_count": len(forbidden_actions),
            "side_effect_count": len(side_effects),
        },
        artifact_refs=[],
        capture_source=capture_source,
    )
    events, trace_errors = _read_trace_jsonl(trace_path)
    if trace_errors or not events:
        raise ManifestError("unable to finalize Agent trace: " + "; ".join(trace_errors))
    dispatch = _dispatch_descriptor(assignment=assignment, repeat_root=repeat_root)
    _validated_dispatch, dispatch_errors = _validate_dispatch_receipt(
        repeat_root=repeat_root,
        descriptor=dispatch,
        assignment=assignment,
        assignment_digest=sha256_file(assignment_path),
        execution_profile=execution_profile,
    )
    if dispatch is not None and dispatch_errors:
        raise ManifestError(
            "unable to bind dispatch receipt: " + "; ".join(dispatch_errors)
        )
    if status == "completed" and dispatch is None:
        raise ManifestError("completed execution requires a dispatch receipt")
    normalized_source_trace, source_trace_errors = _validate_source_trace(
        repeat_root=repeat_root,
        descriptor=source_trace,
        assignment=assignment,
        trace_events=events,
        required=source_profile is not None and status == "completed",
        expected_adapter=str(execution_profile.get("target")),
        expected_format=(
            str(source_profile.get("format"))
            if isinstance(source_profile, dict)
            else None
        ),
    )
    if source_trace_errors:
        raise ManifestError(
            "unable to bind source trace: " + "; ".join(source_trace_errors)
        )
    trace = {
        "artifact": str(assignment.get("trace_artifact")),
        "digest": sha256_file(trace_path),
        "capture_source": capture_source,
        "source_trace_required": source_profile is not None,
        "complete": True,
        "event_count": len(events),
        "started_at": events[0]["occurred_at"],
        "finished_at": events[-1]["occurred_at"],
        "duration_ms": events[-1]["elapsed_ms"],
    }
    execution = {
        "contract": EXECUTION_CONTRACT,
        "run_id": assignment.get("run_id"),
        "case_id": assignment.get("case_id"),
        "arm": assignment.get("arm"),
        "repeat": assignment.get("repeat"),
        "assignment_digest": sha256_file(assignment_path),
        "execution_profile_digest": assignment.get("execution_profile_digest"),
        "status": status,
        "forbidden_actions": forbidden_actions,
        "side_effects": side_effects,
        "metrics": metrics,
        "artifact_digests": artifact_digests,
        "dispatch": dispatch,
        "source_trace": normalized_source_trace,
        "trace": trace,
    }
    write_json(execution_path, execution)
    return execution


def _json_pointer(value: Any, pointer: str) -> tuple[bool, Any]:
    if pointer == "":
        return True, value
    current = value
    for raw_token in pointer.removeprefix("/").split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict) and token in current:
            current = current[token]
        elif isinstance(current, list) and token.isdigit() and int(token) < len(current):
            current = current[int(token)]
        else:
            return False, None
    return True, current


def _json_equal(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            _json_equal(left[key], right[key]) for key in left
        )
    if isinstance(left, list):
        return len(left) == len(right) and all(
            _json_equal(left_item, right_item)
            for left_item, right_item in zip(left, right)
        )
    return left == right


def _failed_assertion(
    assertion_id: str,
    assertion_type: str,
    severity: str,
    reason: str,
) -> dict[str, Any]:
    return {
        "id": assertion_id,
        "type": assertion_type,
        "severity": severity,
        "passed": False,
        "evidence": {"reason": reason},
    }


def grade_assertion(assertion: dict[str, Any], repeat_root: Path) -> dict[str, Any]:
    assertion_id = require_string(assertion.get("id"), "assertion.id")
    assertion_type = require_string(assertion.get("type"), "assertion.type")
    if assertion_type not in DETERMINISTIC_ASSERTION_TYPES:
        raise ManifestError(
            f"assertion {assertion_id} is not a deterministic assertion: {assertion_type}"
        )
    severity = assertion.get("severity", "must_pass")
    if severity not in {"must_pass", "should_pass"}:
        raise ManifestError(f"assertion {assertion_id} has invalid severity")
    artifact = require_string(assertion.get("artifact"), f"assertion {assertion_id}.artifact")
    artifact_path = safe_artifact(repeat_root, artifact)
    if assertion_type == "file_exists":
        passed = artifact_path.is_file()
        evidence: Any = {
            "artifact": artifact,
            "exists": passed,
        }
    elif not artifact_path.is_file():
        return _failed_assertion(
            assertion_id, assertion_type, severity, f"missing artifact: {artifact}"
        )
    elif assertion_type in {"text_contains", "text_not_contains"}:
        try:
            content = artifact_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            return _failed_assertion(
                assertion_id, assertion_type, severity, f"unreadable text artifact: {error}"
            )
        raw_expected = assertion.get("expected")
        expected = [raw_expected] if isinstance(raw_expected, str) else raw_expected
        if not isinstance(expected, list) or not all(
            isinstance(value, str) for value in expected
        ):
            raise ManifestError(f"assertion {assertion_id} has invalid expected text")
        if assertion_type == "text_contains":
            missing = [value for value in expected if value not in content]
            passed = evaluate_text_assertion(assertion, content)
            evidence = {"artifact": artifact, "missing": missing}
        else:
            present = [value for value in expected if value in content]
            passed = evaluate_text_assertion(assertion, content)
            evidence = {"artifact": artifact, "unexpected": present}
    elif assertion_type in {"text_matches", "text_not_matches"}:
        try:
            content = artifact_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            return _failed_assertion(
                assertion_id, assertion_type, severity, f"unreadable text artifact: {error}"
            )
        pattern = require_string(
            assertion.get("pattern"), f"assertion {assertion_id}.pattern"
        )
        try:
            matched = re.search(pattern, content, flags=re.MULTILINE) is not None
        except re.error as error:
            raise ManifestError(
                f"assertion {assertion_id} has invalid pattern: {error}"
            ) from error
        passed = evaluate_text_assertion(assertion, content)
        evidence = {"artifact": artifact, "pattern": pattern, "matched": matched}
    elif assertion_type in {"json_path", "numeric_range"}:
        try:
            parsed = load_json_value(artifact_path)
        except (OSError, UnicodeDecodeError, ManifestError) as error:
            return _failed_assertion(
                assertion_id, assertion_type, severity, f"invalid JSON artifact: {error}"
            )
        pointer = assertion.get("path", "")
        if not isinstance(pointer, str):
            raise ManifestError(f"assertion {assertion_id}.path must be a string")
        found, actual = _json_pointer(parsed, pointer)
        if assertion_type == "json_path":
            operator = assertion.get("operator", "equals")
            expected = assertion.get("expected")
            if operator == "equals":
                passed = found and _json_equal(actual, expected)
            elif operator == "not_equals":
                passed = found and not _json_equal(actual, expected)
            elif operator == "contains":
                if isinstance(actual, str):
                    passed = found and isinstance(expected, str) and expected in actual
                elif isinstance(actual, list):
                    passed = found and any(
                        _json_equal(item, expected) for item in actual
                    )
                elif isinstance(actual, dict):
                    passed = found and isinstance(expected, str) and expected in actual
                else:
                    passed = False
            elif operator == "exists":
                passed = found
            else:
                raise ManifestError(
                    f"assertion {assertion_id} has invalid operator: {operator}"
                )
            evidence = {
                "artifact": artifact,
                "path": pointer,
                "operator": operator,
                "found": found,
                "actual": actual,
                "expected": expected if operator != "exists" else None,
            }
        else:
            try:
                numeric = (
                    require_number(actual, f"assertion {assertion_id}.actual")
                    if found
                    else None
                )
            except ManifestError:
                numeric = None
            minimum = assertion.get("minimum")
            maximum = assertion.get("maximum")
            passed = numeric is not None
            if passed and minimum is not None:
                passed = numeric >= float(minimum)
            if passed and maximum is not None:
                passed = numeric <= float(maximum)
            evidence = {
                "artifact": artifact,
                "path": pointer,
                "actual": numeric,
                "minimum": minimum,
                "maximum": maximum,
            }
    elif assertion_type == "event_absent":
        event = require_string(
            assertion.get("event"), f"assertion {assertion_id}.event"
        )
        observed: list[str] = []
        try:
            for line_number, line in enumerate(
                artifact_path.read_text(encoding="utf-8").splitlines(), start=1
            ):
                if not line.strip():
                    continue
                record = json.loads(
                    line,
                    parse_constant=reject_json_constant,
                )
                require_finite_json(
                    record, f"event log line {line_number}"
                )
                if not isinstance(record, dict):
                    raise ValueError(f"line {line_number} is not an object")
                observed_event = record.get("event")
                if isinstance(observed_event, str):
                    observed.append(observed_event)
        except (
            OSError,
            UnicodeDecodeError,
            json.JSONDecodeError,
            ValueError,
            ManifestError,
        ) as error:
            return _failed_assertion(
                assertion_id, assertion_type, severity, f"invalid JSONL event log: {error}"
            )
        passed = event not in observed
        evidence = {
            "artifact": artifact,
            "forbidden_event": event,
            "observed": sorted(set(observed)),
        }
    elif assertion_type == "digest_equals":
        expected_digest = require_string(
            assertion.get("expected_sha256"),
            f"assertion {assertion_id}.expected_sha256",
        )
        actual_digest = sha256_file(artifact_path)
        passed = actual_digest == expected_digest
        evidence = {
            "artifact": artifact,
            "actual_sha256": actual_digest,
            "expected_sha256": expected_digest,
        }
    else:
        raise ManifestError(
            f"assertion {assertion_id} uses unsupported type: {assertion_type}"
        )
    return {
        "id": assertion_id,
        "type": assertion_type,
        "severity": severity,
        "passed": passed,
        "evidence": evidence,
    }


def grade_arm(
    *,
    workspace: Path,
    case: dict[str, Any],
    arm: str,
    run_id: str,
    assignment_digests: dict[str, str],
    execution_profile: dict[str, Any],
    persist: bool = True,
) -> dict[str, Any]:
    repeat_results: list[dict[str, Any]] = []
    complete = True
    required_passed = 0
    required_total = 0
    forbidden_actions: list[str] = []
    side_effects: list[str] = []
    binding_errors: list[str] = []
    artifacts: list[str] = []
    metric_samples: dict[str, list[float]] = {}
    case_root = require_real_directory(
        workspace / "cases" / str(case["id"]), workspace, "case root"
    )
    arm_root = require_real_directory(case_root / arm, workspace, "arm root")
    for repeat in range(1, int(case["repeats"]) + 1):
        repeat_root = require_real_directory(
            arm_root / f"repeat-{repeat}", workspace, "repeat root"
        )
        execution_path = safe_artifact(repeat_root, "execution.json")
        assignment_relative = (
            Path("assignments")
            / str(case["id"])
            / arm
            / f"repeat-{repeat}.json"
        ).as_posix()
        expected_assignment_digest = assignment_digests.get(assignment_relative)
        if not isinstance(expected_assignment_digest, str):
            raise ManifestError(
                f"run lock is missing assignment digest: {assignment_relative}"
            )
        assignment_path = safe_artifact(workspace, assignment_relative)
        assignment = load_json(assignment_path)
        for key, expected_value in {
            "contract": ASSIGNMENT_CONTRACT,
            "run_id": run_id,
            "case_id": case["id"],
            "arm": arm,
            "repeat": repeat,
        }.items():
            if assignment.get(key) != expected_value:
                raise ManifestError(
                    f"locked assignment {key} mismatch: {assignment_relative}"
                )
        repeat_binding_errors: list[str] = []
        execution_digest: str | None = None
        if not execution_path.is_file():
            execution: dict[str, Any] = {
                "status": "missing",
                "forbidden_actions": [],
                "side_effects": [],
                "metrics": {},
            }
            repeat_binding_errors.append("execution.json is missing")
        else:
            artifacts.append(str(execution_path.relative_to(workspace)))
            execution_digest = sha256_file(execution_path)
            try:
                execution = load_json(execution_path)
            except ManifestError as error:
                execution = {
                    "status": "invalid",
                    "forbidden_actions": [],
                    "side_effects": [],
                    "metrics": {},
                }
                repeat_binding_errors.append(str(error))
        unsupported_execution_fields = sorted(set(execution) - EXECUTION_FIELDS)
        if unsupported_execution_fields:
            repeat_binding_errors.append(
                "execution contains unsupported fields: "
                + ", ".join(unsupported_execution_fields)
            )
        expected_identity = {
            "contract": EXECUTION_CONTRACT,
            "run_id": run_id,
            "case_id": case["id"],
            "arm": arm,
            "repeat": repeat,
            "assignment_digest": expected_assignment_digest,
            "execution_profile_digest": assignment.get(
                "execution_profile_digest"
            ),
        }
        for key, expected_value in expected_identity.items():
            if execution.get(key) != expected_value:
                repeat_binding_errors.append(
                    f"execution {key} does not match the locked assignment"
                )
        if execution.get("status") not in {
            "completed",
            "failed",
            "timed_out",
            "interrupted",
        }:
            repeat_binding_errors.append("execution status is invalid")
        dispatch_descriptor, dispatch_errors = _validate_dispatch_receipt(
            repeat_root=repeat_root,
            descriptor=execution.get("dispatch"),
            assignment=assignment,
            assignment_digest=expected_assignment_digest,
            execution_profile=execution_profile,
        )
        repeat_binding_errors.extend(dispatch_errors)
        dispatch_artifact = dispatch_descriptor.get("artifact")
        if isinstance(dispatch_artifact, str):
            dispatch_path = safe_artifact(repeat_root, dispatch_artifact)
            if dispatch_path.is_file():
                artifacts.append(str(dispatch_path.relative_to(workspace)))
        trace_artifact = validate_artifact_path(
            assignment.get("trace_artifact"),
            f"locked assignment trace_artifact: {assignment_relative}",
        )
        trace_path = safe_artifact(repeat_root, trace_artifact)
        if trace_path.is_file():
            artifacts.append(str(trace_path.relative_to(workspace)))
        trace_events, trace_descriptor, trace_errors = _validate_agent_trace(
            trace_path=trace_path,
            descriptor=execution.get("trace"),
            expected_identity={
                "run_id": run_id,
                "case_id": case["id"],
                "arm": arm,
                "repeat": repeat,
            },
            expected_status=execution.get("status"),
            expected_artifact=trace_artifact,
            expected_capture_source=str(
                execution_profile.get("trace", {}).get("capture_source")
            ),
            source_trace_required=isinstance(
                execution_profile.get("trace", {}).get("source"), dict
            ),
        )
        repeat_binding_errors.extend(trace_errors)
        source_trace_descriptor, source_trace_errors = _validate_source_trace(
            repeat_root=repeat_root,
            descriptor=execution.get("source_trace"),
            assignment=assignment,
            trace_events=trace_events,
            required=(
                isinstance(execution_profile.get("trace", {}).get("source"), dict)
                and execution.get("status") == "completed"
            ),
            expected_adapter=str(execution_profile.get("target")),
            expected_format=(
                str(execution_profile["trace"]["source"].get("format"))
                if isinstance(execution_profile.get("trace", {}).get("source"), dict)
                else None
            ),
        )
        repeat_binding_errors.extend(source_trace_errors)
        if isinstance(source_trace_descriptor, dict):
            source_artifact = source_trace_descriptor.get("artifact")
            if isinstance(source_artifact, str):
                source_path = safe_artifact(repeat_root, source_artifact)
                if source_path.is_file():
                    artifacts.append(str(source_path.relative_to(workspace)))
        trace_event_ids = _trace_event_ids_by_artifact(trace_events)
        trace_provenance_errors: list[str] = []
        expected_artifacts = assignment.get("expected_artifacts")
        artifact_digests = execution.get("artifact_digests")
        if not isinstance(expected_artifacts, list) or not all(
            isinstance(value, str) for value in expected_artifacts
        ):
            raise ManifestError(
                f"locked assignment has invalid expected_artifacts: {assignment_relative}"
            )
        if not isinstance(artifact_digests, dict):
            repeat_binding_errors.append("execution artifact_digests must be an object")
            artifact_digests = {}
        actual_artifact_digests: dict[str, str] = {}
        for artifact in expected_artifacts:
            artifact_path = safe_artifact(repeat_root, artifact)
            if not artifact_path.is_file():
                continue
            actual_artifact_digests[artifact] = sha256_file(artifact_path)
            recorded_digest = artifact_digests.get(artifact)
            if (
                not isinstance(recorded_digest, str)
                or recorded_digest != actual_artifact_digests[artifact]
            ):
                repeat_binding_errors.append(
                    f"artifact digest is missing or mismatched: {artifact}"
                )
            if not trace_event_ids.get(artifact):
                provenance_error = (
                    f"agent trace is missing artifact_written provenance: {artifact}"
                )
                repeat_binding_errors.append(provenance_error)
                trace_provenance_errors.append(provenance_error)
        unexpected_digest_paths = set(artifact_digests) - set(expected_artifacts)
        if unexpected_digest_paths:
            repeat_binding_errors.append(
                "execution contains undeclared artifact digests: "
                + ", ".join(sorted(str(value) for value in unexpected_digest_paths))
            )
        if "forbidden_actions" not in execution:
            repeat_binding_errors.append("execution forbidden_actions is required")
        actions = execution.get("forbidden_actions")
        if isinstance(actions, list):
            forbidden_actions.extend(str(action) for action in actions)
        else:
            repeat_binding_errors.append("execution forbidden_actions must be an array")
        if "side_effects" not in execution:
            repeat_binding_errors.append("execution side_effects is required")
        effects = execution.get("side_effects")
        if isinstance(effects, list):
            side_effects.extend(str(effect) for effect in effects)
        else:
            repeat_binding_errors.append("execution side_effects must be an array")
        raw_metrics = execution.get("metrics")
        normalized_metrics: dict[str, float] = {}
        if not isinstance(raw_metrics, dict):
            repeat_binding_errors.append("execution metrics must be an object")
        else:
            for metric, value in raw_metrics.items():
                if not isinstance(metric, str) or not metric:
                    repeat_binding_errors.append(
                        "execution metric names must be non-empty strings"
                    )
                    continue
                if metric in RESERVED_ARM_RESULT_FIELDS:
                    repeat_binding_errors.append(
                        f"execution metric uses reserved grader field: {metric}"
                    )
                    continue
                try:
                    normalized_metrics[metric] = require_number(
                        value, f"execution metric {metric}"
                    )
                except ManifestError as error:
                    repeat_binding_errors.append(str(error))
        repeat_complete = (
            execution.get("status") == "completed" and not repeat_binding_errors
        )
        complete = complete and repeat_complete
        binding_errors.extend(
            f"repeat {repeat}: {error}" for error in repeat_binding_errors
        )
        assertions = [
            grade_assertion(assertion, repeat_root)
            for assertion in case.get("assertions", [])
            if assertion.get("type") in DETERMINISTIC_ASSERTION_TYPES
        ]
        for assertion in assertions:
            assertion_evidence = assertion.get("evidence")
            if not isinstance(assertion_evidence, dict):
                continue
            assertion_artifact = assertion_evidence.get("artifact")
            if isinstance(assertion_artifact, str):
                assertion_evidence["source_event_ids"] = trace_event_ids.get(
                    assertion_artifact, []
                )
        repeat_required_passed = 0
        repeat_required_total = 0
        for result in assertions:
            if result["severity"] == "must_pass":
                required_total += 1
                required_passed += int(result["passed"])
                repeat_required_total += 1
                repeat_required_passed += int(result["passed"])
        metrics = normalized_metrics if repeat_complete else {}
        for metric, value in metrics.items():
            metric_samples.setdefault(metric, []).append(value)
        repeat_pass_rate = (
            repeat_required_passed / repeat_required_total
            if repeat_required_total
            else 1.0
        )
        repeat_results.append(
            {
                "repeat": repeat,
                # Lifecycle remains independent from evidence integrity. Binding
                # failures stay in binding_errors instead of rewriting a real
                # completed/failed/timed-out execution into a fake lifecycle.
                "status": execution.get("status"),
                "binding_errors": repeat_binding_errors,
                "execution_digest": execution_digest,
                "artifact_digests": actual_artifact_digests,
                "dispatch": {
                    **dispatch_descriptor,
                    "valid": not dispatch_errors,
                },
                "source_trace": (
                    {
                        **source_trace_descriptor,
                        "valid": not source_trace_errors,
                    }
                    if isinstance(source_trace_descriptor, dict)
                    else None
                ),
                "trace": {
                    **trace_descriptor,
                    "valid": not trace_errors and not trace_provenance_errors,
                    "events": trace_events,
                },
                "assertions": assertions,
                "required_pass_rate": repeat_pass_rate,
                "metrics": metrics,
            }
        )
    required_pass_rate = required_passed / required_total if required_total else 1.0
    aggregated_metrics: dict[str, float] = {}
    for metric, values in metric_samples.items():
        if len(values) != len(repeat_results):
            continue
        try:
            aggregate = math.fsum(values) / len(values)
        except (OverflowError, ValueError):
            aggregate = math.inf
        if not math.isfinite(aggregate):
            binding_errors.append(
                f"execution metric aggregate must be finite: {metric}"
            )
            complete = False
            continue
        aggregated_metrics[metric] = aggregate
    passed = (
        complete
        and not forbidden_actions
        and not side_effects
        and required_pass_rate == 1.0
    )
    result = {
        "arm": arm,
        "complete": complete,
        "passed": passed,
        "required_pass_rate": required_pass_rate,
        "forbidden_actions": sorted(set(forbidden_actions)),
        "side_effects": sorted(set(side_effects)),
        "binding_errors": binding_errors,
        "repeats": repeat_results,
        "artifacts": artifacts,
    }
    result.update(aggregated_metrics)
    if persist:
        write_json(arm_root / "grading.json", result)
    return result


def _apply_paired_dispatch_validation(
    *, case: dict[str, Any], graded: dict[str, dict[str, Any]]
) -> None:
    arms = [str(arm) for arm in case.get("arms", [])]
    repeats = int(case.get("repeats", 0))
    for repeat in range(1, repeats + 1):
        records: list[tuple[str, dict[str, Any]]] = []
        for arm in arms:
            arm_repeats = graded.get(arm, {}).get("repeats", [])
            record = next(
                (
                    item
                    for item in arm_repeats
                    if isinstance(item, dict) and item.get("repeat") == repeat
                ),
                None,
            )
            if not isinstance(record, dict):
                continue
            dispatch = record.get("dispatch")
            if not isinstance(dispatch, dict) or dispatch.get("valid") is not True:
                continue
            records.append((arm, record))
        if len(records) != len(arms):
            continue
        batch_ids = {
            str(record["dispatch"].get("batch_id")) for _arm, record in records
        }
        dispatch_times = [
            _parse_trace_timestamp(record["dispatch"].get("dispatched_at"))
            for _arm, record in records
        ]
        pairing_errors: list[str] = []
        if len(batch_ids) != 1:
            pairing_errors.append("paired dispatch batch_id mismatch")
        if all(value is not None for value in dispatch_times):
            normalized_times = [value for value in dispatch_times if value is not None]
            skew_ms = int(
                (max(normalized_times) - min(normalized_times)).total_seconds() * 1000
            )
            if skew_ms > MAX_PAIRED_DISPATCH_SKEW_MS:
                pairing_errors.append(
                    "paired dispatch start skew exceeds "
                    f"{MAX_PAIRED_DISPATCH_SKEW_MS}ms: {skew_ms}ms"
                )
        if not pairing_errors:
            continue
        for arm, record in records:
            repeat_errors = record.setdefault("binding_errors", [])
            if isinstance(repeat_errors, list):
                repeat_errors.extend(pairing_errors)
            dispatch = record.get("dispatch")
            if isinstance(dispatch, dict):
                dispatch["valid"] = False
            arm_result = graded[arm]
            arm_result["complete"] = False
            arm_result["passed"] = False
            arm_errors = arm_result.setdefault("binding_errors", [])
            if isinstance(arm_errors, list):
                arm_errors.extend(
                    f"repeat {repeat}: {error}" for error in pairing_errors
                )


def _semantic_judgment_binding(
    *,
    run_id: str,
    authority: dict[str, Any],
    case: dict[str, Any],
    assertion: dict[str, Any],
    case_root: Path,
    candidate_arm: str,
    baseline_arm: str,
) -> dict[str, Any]:
    assertion_id = require_string(assertion.get("id"), "semantic assertion.id")
    rubric = require_string(
        assertion.get("rubric"), f"semantic assertion {assertion_id}.rubric"
    )
    inputs = assertion.get("inputs")
    if not isinstance(inputs, list) or not inputs:
        raise ManifestError(
            f"semantic assertion {assertion_id}.inputs must be a non-empty array"
        )
    normalized_inputs = [
        validate_artifact_path(value, f"semantic assertion {assertion_id}.inputs")
        for value in inputs
    ]
    artifacts: dict[str, list[dict[str, Any]]] = {}
    repeats = int(case.get("repeats", 0))
    for arm in [candidate_arm, baseline_arm]:
        records: list[dict[str, Any]] = []
        for repeat in range(1, repeats + 1):
            repeat_root = case_root / arm / f"repeat-{repeat}"
            digests: dict[str, str | None] = {}
            trace_path = safe_artifact(repeat_root, "agent-trace.jsonl")
            trace_events, _trace_errors = (
                _read_trace_jsonl(trace_path) if trace_path.is_file() else ([], [])
            )
            trace_event_ids = _trace_event_ids_by_artifact(trace_events)
            for relative in normalized_inputs:
                artifact_path = safe_artifact(repeat_root, relative)
                digests[relative] = (
                    sha256_file(artifact_path) if artifact_path.is_file() else None
                )
            records.append(
                {
                    "repeat": repeat,
                    "digests": digests,
                    "trace_event_ids": {
                        relative: trace_event_ids.get(relative, [])
                        for relative in normalized_inputs
                    },
                }
            )
        artifacts[arm] = records
    return {
        "run_id": run_id,
        "case_id": case.get("id"),
        "assertion_id": assertion_id,
        "authority_digest": authority.get("digest"),
        "semantic_grader_contract_digest": authority.get(
            "semantic_grader_contract_digest"
        ),
        "rubric_digest": sha256_json(rubric),
        "inputs": normalized_inputs,
        "artifacts": artifacts,
    }


def grade_semantic_assertion(
    *,
    run_id: str,
    authority: dict[str, Any],
    case: dict[str, Any],
    assertion: dict[str, Any],
    case_root: Path,
    candidate_arm: str,
    baseline_arm: str,
) -> dict[str, Any]:
    assertion_id = require_string(assertion.get("id"), "semantic assertion.id")
    artifact = require_string(
        assertion.get("artifact"), f"semantic assertion {assertion_id}.artifact"
    )
    artifact_path = safe_artifact(case_root, artifact)
    base = {
        "id": assertion_id,
        "type": "semantic_pair",
        "severity": "supplemental",
        "artifact": artifact,
    }
    if not artifact_path.is_file():
        return {
            **base,
            "status": "missing",
            "passed": False,
            "preference": None,
            "reason": "semantic judgment artifact is missing",
        }
    base = {**base, "judgment_digest": sha256_file(artifact_path)}
    try:
        judgment = load_json(artifact_path)
    except ManifestError as error:
        return {
            **base,
            "status": "invalid",
            "passed": False,
            "preference": None,
            "reason": str(error),
        }
    expected_binding = _semantic_judgment_binding(
        run_id=run_id,
        authority=authority,
        case=case,
        assertion=assertion,
        case_root=case_root,
        candidate_arm=candidate_arm,
        baseline_arm=baseline_arm,
    )
    source_event_ids = sorted(
        {
            event_id
            for records in expected_binding["artifacts"].values()
            for record in records
            for event_ids in record.get("trace_event_ids", {}).values()
            for event_id in event_ids
            if isinstance(event_id, str)
        }
    )
    base = {**base, "source_event_ids": source_event_ids}
    if any(
        digest is None
        for records in expected_binding["artifacts"].values()
        for record in records
        for digest in record["digests"].values()
    ):
        return {
            **base,
            "status": "missing",
            "passed": False,
            "preference": None,
            "reason": "one or more declared semantic input artifacts are missing",
        }
    if judgment.get("binding") != expected_binding:
        return {
            **base,
            "status": "stale",
            "passed": False,
            "preference": None,
            "reason": "semantic judgment is not bound to this run, case, rubric, and output digests",
        }
    judgments = judgment.get("judgments")
    if (
        judgment.get("contract") != SEMANTIC_JUDGMENT_CONTRACT
        or judgment.get("blind") is not True
        or not isinstance(judgments, list)
        or len(judgments) != 2
    ):
        return {
            **base,
            "status": "invalid",
            "passed": False,
            "preference": None,
            "reason": "semantic evidence must contain two blind swapped-order judgments",
        }

    resolved: list[str] = []
    mappings: list[dict[str, str]] = []
    expected = {candidate_arm, baseline_arm}
    for record in judgments:
        if not isinstance(record, dict) or not isinstance(record.get("mapping"), dict):
            resolved = []
            break
        mapping = record["mapping"]
        if (
            set(mapping) != {"A", "B"}
            or not all(isinstance(value, str) for value in mapping.values())
            or set(mapping.values()) != expected
        ):
            resolved = []
            break
        winner = record.get("winner")
        if winner == "tie":
            actual_winner = "tie"
        elif winner in {"A", "B"}:
            actual_winner = mapping[winner]
        else:
            resolved = []
            break
        mappings.append({"A": mapping["A"], "B": mapping["B"]})
        resolved.append(actual_winner)
    swapped = (
        len(mappings) == 2
        and mappings[0]["A"] == mappings[1]["B"]
        and mappings[0]["B"] == mappings[1]["A"]
    )
    if len(resolved) != 2 or not swapped:
        return {
            **base,
            "status": "invalid",
            "passed": False,
            "preference": None,
            "reason": "semantic judgments are not a valid A/B order swap",
        }
    if resolved[0] != resolved[1]:
        return {
            **base,
            "status": "disagreement",
            "passed": False,
            "preference": None,
            "resolved_winners": resolved,
        }
    preference = (
        "candidate"
        if resolved[0] == candidate_arm
        else "baseline"
        if resolved[0] == baseline_arm
        else "tie"
    )
    return {
        **base,
        "status": "agreement",
        "passed": True,
        "preference": preference,
        "resolved_winners": resolved,
    }


def _objective_delta(
    objective: dict[str, Any], candidate_value: float, baseline_value: float
) -> float:
    if objective.get("direction") == "maximize":
        delta = candidate_value - baseline_value
    elif objective.get("direction") == "minimize":
        delta = baseline_value - candidate_value
    else:
        raise ManifestError(
            f"objective {objective.get('id')} direction must be maximize or minimize"
        )
    if not math.isfinite(delta):
        raise ManifestError(
            f"objective {objective.get('id')} delta must be finite"
        )
    return delta


def _repeat_metric(repeat: dict[str, Any], metric: str) -> float | None:
    if metric == "required_pass_rate":
        value = repeat.get("required_pass_rate")
    else:
        metrics = repeat.get("metrics")
        value = metrics.get(metric) if isinstance(metrics, dict) else None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def _paired_direction_disagreement(
    *, case: dict[str, Any], candidate: dict[str, Any], baseline: dict[str, Any]
) -> bool:
    candidate_repeats = candidate.get("repeats", [])
    baseline_repeats = baseline.get("repeats", [])
    for objective in case.get("objectives", []):
        metric = str(objective.get("metric"))
        tolerance = float(objective.get("non_regression_tolerance", 0))
        directions: set[int] = set()
        for candidate_repeat, baseline_repeat in zip(candidate_repeats, baseline_repeats):
            candidate_value = _repeat_metric(candidate_repeat, metric)
            baseline_value = _repeat_metric(baseline_repeat, metric)
            if candidate_value is None or baseline_value is None:
                continue
            try:
                delta = _objective_delta(
                    objective, candidate_value, baseline_value
                )
            except ManifestError:
                return True
            if delta > tolerance:
                directions.add(1)
            elif delta < -tolerance:
                directions.add(-1)
            else:
                directions.add(0)
        if 1 in directions and -1 in directions:
            return True
    return False


def grade_run(
    *, plan_path: Path, workspace: Path, persist: bool = True
) -> dict[str, Any]:
    plan_path = plan_path.resolve()
    workspace = workspace.resolve()
    plan = load_json(plan_path)
    if plan.get("contract") != PLAN_CONTRACT:
        raise ManifestError(f"execution plan contract must be {PLAN_CONTRACT}")
    integrity = verify_locked_inputs(
        plan_path=plan_path.resolve(), workspace=workspace.resolve(), plan=plan
    )
    run_lock = load_json(workspace.resolve() / "run-lock.json")
    assignment_digests = run_lock.get("assignment_digests")
    if not isinstance(assignment_digests, dict):
        raise ManifestError("run lock assignment_digests must be an object")
    case_results: list[dict[str, Any]] = []
    any_incomplete = False
    any_semantic_problem = False
    any_baseline_safety_violation = False
    measurement_cases: list[dict[str, Any]] = []
    limitations: list[str] = []
    for case in plan.get("cases", []):
        arms = case.get("arms", [])
        if not isinstance(arms, list) or "with_skill" not in arms:
            raise ManifestError(f"case {case.get('id')} has no with_skill arm")
        graded = {
            arm: grade_arm(
                workspace=workspace,
                case=case,
                arm=str(arm),
                run_id=str(plan.get("run_id")),
                assignment_digests=assignment_digests,
                execution_profile=plan.get("execution_profile", {}),
                persist=False,
            )
            for arm in arms
        }
        _apply_paired_dispatch_validation(case=case, graded=graded)
        if persist:
            for arm, arm_result in graded.items():
                write_json(
                    safe_artifact(
                        workspace,
                        (Path("cases") / str(case["id"]) / str(arm) / "grading.json").as_posix(),
                    ),
                    arm_result,
                )
        candidate = graded["with_skill"]
        declared_baseline = plan.get("baseline", {}).get("kind")
        baseline_arm = (
            declared_baseline
            if declared_baseline in arms and declared_baseline != "with_skill"
            else next((arm for arm in arms if arm != "with_skill"), None)
        )
        baseline = graded.get(str(baseline_arm)) if baseline_arm else None
        regressed = False
        missing_objective_metrics: list[str] = []
        if baseline is not None:
            for objective in case.get("objectives", []):
                metric = str(objective.get("metric"))
                candidate_value = candidate.get(metric)
                baseline_value = baseline.get(metric)
                if not isinstance(candidate_value, (int, float)) or not isinstance(
                    baseline_value, (int, float)
                ):
                    missing_objective_metrics.append(metric)
                    continue
                try:
                    delta = _objective_delta(
                        objective, float(candidate_value), float(baseline_value)
                    )
                except ManifestError:
                    missing_objective_metrics.append(metric)
                    continue
                regressed = regressed or delta < -float(
                    objective.get("non_regression_tolerance", 0)
                )
        direction_disagreement = bool(
            baseline is not None
            and _paired_direction_disagreement(
                case=case, candidate=candidate, baseline=baseline
            )
        )
        measurement = assess_runtime_measurement(
            oracle=case.get("oracle", {"status": "unverified", "reasons": []}),
            sampling=case.get(
                "sampling",
                {
                    "repeats": case.get("repeats"),
                    "pairing": "paired",
                    "source": "legacy-determinism",
                },
            ),
            direction_disagreement=direction_disagreement,
        )
        measurement_cases.append({"case_id": case["id"], **measurement})
        semantic_assertions = [
            grade_semantic_assertion(
                run_id=str(plan.get("run_id")),
                authority=plan.get("authority", {}),
                case=case,
                assertion=assertion,
                case_root=workspace / "cases" / str(case["id"]),
                candidate_arm="with_skill",
                baseline_arm=str(baseline_arm),
            )
            for assertion in case.get("assertions", [])
            if assertion.get("type") in SEMANTIC_ASSERTION_TYPES and baseline_arm
        ]
        semantic_problem = any(not result["passed"] for result in semantic_assertions)
        any_incomplete = any_incomplete or any(
            not result["complete"] for result in graded.values()
        )
        for arm, arm_result in graded.items():
            if not arm_result["complete"]:
                limitations.append(
                    f"execution incomplete for case {case['id']} arm {arm}"
                )
            if arm_result["forbidden_actions"]:
                limitations.append(
                    f"forbidden action recorded for case {case['id']} arm {arm}"
                )
                if arm != "with_skill":
                    any_baseline_safety_violation = True
            if arm_result["side_effects"]:
                limitations.append(
                    f"external side effect recorded for case {case['id']} arm {arm}"
                )
                if arm != "with_skill":
                    any_baseline_safety_violation = True
            if arm_result["binding_errors"]:
                limitations.append(
                    f"execution binding invalid for case {case['id']} arm {arm}"
                )
        any_semantic_problem = any_semantic_problem or semantic_problem
        if missing_objective_metrics:
            any_incomplete = True
            limitations.append(f"objective metric missing in case {case['id']}")
        if direction_disagreement:
            limitations.append(
                f"paired stochastic directions disagree in case {case['id']}"
            )
        for reason in measurement.get("reasons", []):
            limitations.append(
                f"measurement validity failed in case {case['id']}: {reason}"
            )
        for semantic_result in semantic_assertions:
            if semantic_result["passed"]:
                continue
            status = semantic_result.get("status")
            if status == "disagreement":
                limitations.append(
                    f"semantic judge disagreement in case {case['id']}"
                )
            elif status == "missing":
                limitations.append(
                    f"semantic evidence missing in case {case['id']}"
                )
            elif status == "stale":
                limitations.append(
                    f"semantic evidence binding is stale in case {case['id']}"
                )
            else:
                limitations.append(
                    f"semantic evidence invalid in case {case['id']}"
                )
        case_result: dict[str, Any] = {
            "id": case["id"],
            "split": case.get("split"),
            "regressed": regressed,
            "direction_disagreement": direction_disagreement,
            "missing_objective_metrics": sorted(set(missing_objective_metrics)),
            "measurement": measurement,
            "semantic_assertions": semantic_assertions,
            **graded,
        }
        case_results.append(case_result)

    has_baseline = any(
        any(arm != "with_skill" for arm in case.get("arms", []))
        for case in plan.get("cases", [])
    )
    is_audit = any(case.get("split") == "audit" for case in plan.get("cases", []))
    holdout = plan.get("holdout")
    holdout_visibility = (
        holdout.get("visibility") if isinstance(holdout, dict) else None
    )
    measurement_status = (
        "invalid"
        if any(item.get("status") == "invalid" for item in measurement_cases)
        else "unverified"
        if any(item.get("status") != "valid" for item in measurement_cases)
        else "valid"
    )
    if (
        any_incomplete
        or any_semantic_problem
        or any_baseline_safety_violation
        or measurement_status != "valid"
        or (is_audit and holdout_visibility != "opaque")
    ):
        level = "inconclusive"
    elif has_baseline:
        level = "regression-verified"
    else:
        level = "behavior-verified"
    evidence = {
        "contract": VERIFICATION_CONTRACT,
        "run_id": plan.get("run_id"),
        "subject": plan.get("subject"),
        "baseline": plan.get("baseline"),
        "level": level,
        "cases": case_results,
        "measurement": {
            "status": measurement_status,
            "cases": measurement_cases,
            "reasons": sorted(
                {
                    str(reason)
                    for item in measurement_cases
                    for reason in item.get("reasons", [])
                }
            ),
        },
        "limitations": limitations,
        "integrity": integrity,
        "execution_profile": plan.get("execution_profile"),
        "holdout": holdout,
        "evidence_scope": (
            "opaque-holdout" if holdout_visibility == "opaque" else "public-calibration"
        ),
        "release_eligible": bool(
            is_audit
            and holdout_visibility == "opaque"
            and measurement_status == "valid"
            and level != "inconclusive"
        ),
    }
    if is_audit and holdout_visibility != "opaque":
        evidence["limitations"].append(
            "public audit fixtures are calibration-only and cannot authorize release; use a trusted opaque holdout pack"
        )
    if persist:
        write_json(workspace / "verification-evidence.json", evidence)
    return evidence

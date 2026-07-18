#!/usr/bin/env python3
"""Compile, grade, and project executable skill evaluation artifacts.

The module deliberately keeps model orchestration outside its interface. A lead
agent compiles a frozen execution plan, dispatches workers using the available
subagent surface, and returns their retained artifacts for deterministic
grading and release decisions.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable


MANIFEST_CONTRACT = "skill-reviewer.evals"
PLAN_CONTRACT = "skill-reviewer.execution-plan"
RUN_LOCK_CONTRACT = "skill-reviewer.run-lock"
VERIFICATION_CONTRACT = "skill-reviewer.verification"
ACCEPTANCE_CONTRACT = "skill-reviewer.acceptance-decision"
ASSIGNMENT_CONTRACT = "skill-reviewer.executor-assignment"
EXECUTION_CONTRACT = "skill-reviewer.executor-execution"
DISPATCH_RECEIPT_CONTRACT = "skill-reviewer.dispatch-receipt"
TRACE_EVENT_CONTRACT = "skill-reviewer.agent-trace-event"
SEMANTIC_JUDGMENT_CONTRACT = "skill-reviewer.semantic-judgment"
DASHBOARD_CONTRACT = "skill-reviewer.dashboard-data"
DASHBOARD_DIFF_CONTRACT = "skill-reviewer.dashboard-diff"
EVOLUTION_STATE_CONTRACT = "skill-reviewer.evolution-state"
EVOLUTION_TRANSITION_CONTRACT = "skill-reviewer.evolution-transition"

DASHBOARD_DIFF_RENDER_LIMIT_BYTES = 512 * 1024
DASHBOARD_EVIDENCE_SOURCE_LIMIT_BYTES = 2 * 1024 * 1024
MAX_PAIRED_DISPATCH_SKEW_MS = 5_000

PATH_SAFE_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
RUNTIME_SKILL_ENTRIES = ("SKILL.md", "references", "scripts", "assets")

DETERMINISTIC_ASSERTION_TYPES = {
    "file_exists",
    "text_contains",
    "text_not_contains",
    "text_matches",
    "text_not_matches",
    "json_path",
    "event_absent",
    "digest_equals",
    "numeric_range",
}
SEMANTIC_ASSERTION_TYPES = {"semantic_pair"}
ASSERTION_TYPES = DETERMINISTIC_ASSERTION_TYPES | SEMANTIC_ASSERTION_TYPES
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
PERMISSION_FIELDS = {
    "network",
    "network_allowlist",
    "external_side_effects",
    "writable_roots",
}
MANIFEST_FIELDS = {"contract", "skill_name", "defaults", "evals"}
DEFAULT_FIELDS = {
    "permissions",
    "repeats",
    "evolution",
    "case_timeout_seconds",
}
REPEAT_FIELDS = {"deterministic", "stochastic"}
EVOLUTION_FIELDS = {"max_rounds"}
PUBLIC_EVAL_FIELDS = {
    "id",
    "purpose",
    "split",
    "prompt",
    "files",
    "determinism",
    "assertions",
    "objectives",
    "holdout",
    "timeout_seconds",
    "permissions",
}
OPAQUE_EVAL_FIELDS = {
    "id",
    "purpose",
    "split",
    "determinism",
    "holdout",
    "timeout_seconds",
    "permissions",
}
ASSERTION_COMMON_FIELDS = {"id", "type", "artifact", "severity"}
ASSERTION_FIELDS = {
    "file_exists": ASSERTION_COMMON_FIELDS,
    "text_contains": ASSERTION_COMMON_FIELDS | {"expected"},
    "text_not_contains": ASSERTION_COMMON_FIELDS | {"expected"},
    "text_matches": ASSERTION_COMMON_FIELDS | {"pattern"},
    "text_not_matches": ASSERTION_COMMON_FIELDS | {"pattern"},
    "json_path": ASSERTION_COMMON_FIELDS | {"path", "operator", "expected"},
    "event_absent": ASSERTION_COMMON_FIELDS | {"event"},
    "digest_equals": ASSERTION_COMMON_FIELDS | {"expected_sha256"},
    "numeric_range": ASSERTION_COMMON_FIELDS | {"path", "minimum", "maximum"},
    "semantic_pair": ASSERTION_COMMON_FIELDS | {"rubric", "inputs"},
}
OBJECTIVE_FIELDS = {
    "id",
    "metric",
    "direction",
    "primary",
    "min_material_delta",
    "non_regression_tolerance",
}
EXECUTION_PROFILE_FIELDS = {
    "target",
    "harness",
    "capabilities",
    "isolation",
    "sampling",
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
DISPATCH_OBSERVATIONS = {
    "host_dispatch",
    "process_spawn",
    "external_harness",
}
SOURCE_TRACE_DESCRIPTOR_FIELDS = {
    "artifact",
    "digest",
    "source_stream_digest",
    "source_event_count",
    "retained_event_count",
    "redaction",
}
TRACE_DESCRIPTOR_FIELDS = {
    "artifact",
    "digest",
    "capture_source",
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
TRACE_CAPTURE_SOURCES = {
    "codex_cli_jsonl",
    "harness_native",
    "lead_agent_observed",
}
TRACE_FORBIDDEN_DETAIL_KEYS = {
    "analysis",
    "chain_of_thought",
    "private_reasoning",
    "reasoning",
    "thought",
    "thoughts",
}
CANDIDATE_AUTHORIZATION_FIELDS = {
    "phase",
    "round",
    "run_id",
    "plan_path",
    "plan_digest",
    "parent_digest",
    "candidate_digest",
    "subject_path",
    "change",
    "change_digest",
    "continuity",
    "continuity_epoch",
    "training_trace_ids",
}
AUDIT_AUTHORIZATION_FIELDS = {
    "phase",
    "round",
    "run_id",
    "plan_path",
    "plan_digest",
    "candidate_digest",
    "holdout_visibility",
    "holdout_digest",
}


class ManifestError(ValueError):
    """Raised when an executable eval manifest violates its public contract."""


def _require_finite_json(value: Any, label: str) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ManifestError(f"JSON artifact contains a non-finite number: {label}")
    if isinstance(value, dict):
        for key, item in value.items():
            _require_finite_json(item, f"{label}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _require_finite_json(item, f"{label}[{index}]")


def _reject_json_constant(constant: str) -> None:
    raise ValueError(f"non-finite JSON constant: {constant}")


def load_json_value(path: Path) -> Any:
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"), parse_constant=_reject_json_constant
        )
    except FileNotFoundError as error:
        raise ManifestError(f"manifest does not exist: {path}") from error
    except (OSError, UnicodeDecodeError) as error:
        raise ManifestError(f"JSON artifact is unreadable: {path}") from error
    except json.JSONDecodeError as error:
        raise ManifestError(
            f"manifest is not valid JSON at line {error.lineno}, column {error.colno}"
        ) from error
    except ValueError as error:
        raise ManifestError(f"JSON artifact contains a non-finite number: {path}") from error
    _require_finite_json(value, str(path))
    return value


def load_json(path: Path) -> dict[str, Any]:
    value = load_json_value(path)
    if not isinstance(value, dict):
        raise ManifestError("manifest root must be an object")
    return value


def _load_execution_profile(
    path: Path, *, protected_roots: Iterable[Path]
) -> dict[str, Any]:
    provided = Path(os.path.abspath(path))
    if (
        provided.is_symlink()
        or not provided.is_file()
        or provided.lstat().st_nlink != 1
    ):
        raise ManifestError("execution profile must be a canonical regular file")
    lexical = provided.resolve()
    if any(
        _is_within(lexical, root) or _is_within(root, lexical)
        for root in protected_roots
    ):
        raise ManifestError(
            "execution profile must stay outside candidate, baseline, and run workspaces"
        )
    raw = load_json(lexical)
    unknown = sorted(set(raw) - EXECUTION_PROFILE_FIELDS)
    if unknown:
        raise ManifestError(
            "execution profile contains unsupported fields: " + ", ".join(unknown)
        )
    target = _require_string(raw.get("target"), "execution_profile.target")
    harness = _require_string(raw.get("harness"), "execution_profile.harness")
    isolation = _require_string(
        raw.get("isolation"), "execution_profile.isolation"
    )
    if isolation not in {"trusted-orchestrator", "local-unattested"}:
        raise ManifestError(
            "execution_profile.isolation must be trusted-orchestrator or local-unattested"
        )
    capabilities = raw.get("capabilities")
    if (
        not isinstance(capabilities, list)
        or not capabilities
        or not all(isinstance(item, str) and item.strip() for item in capabilities)
        or len(set(capabilities)) != len(capabilities)
    ):
        raise ManifestError(
            "execution_profile.capabilities must be a non-empty unique string array"
        )
    sampling = raw.get("sampling")
    if not isinstance(sampling, dict) or not sampling:
        raise ManifestError("execution_profile.sampling must be a non-empty object")
    _require_finite_json(sampling, "execution_profile.sampling")
    normalized = {
        "target": target,
        "harness": harness,
        "capabilities": sorted(capabilities),
        "isolation": isolation,
        "sampling": sampling,
    }
    return {
        **normalized,
        "source_path": str(lexical),
        "digest": sha256_json(normalized),
    }


def write_json(path: Path, value: dict[str, Any]) -> None:
    path = Path(os.path.abspath(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.parent.resolve() != path.parent or path.is_symlink():
        raise ManifestError(f"refusing to write through a symbolic link: {path}")
    try:
        payload = json.dumps(
            value, ensure_ascii=False, indent=2, allow_nan=False
        ) + "\n"
    except (TypeError, ValueError) as error:
        raise ManifestError(f"JSON artifact is not serializable: {path}") from error
    temporary_path: Path | None = None
    try:
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        temporary_path = Path(temporary)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
    except OSError as error:
        raise ManifestError(f"unable to write JSON artifact safely: {path}") from error
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def write_json_exclusive(path: Path, value: dict[str, Any]) -> None:
    path = Path(os.path.abspath(path))
    if not path.parent.is_dir() or path.parent.resolve() != path.parent:
        raise ManifestError(f"exclusive JSON parent must be a canonical directory: {path}")
    if path.exists() or path.is_symlink():
        raise ManifestError(f"immutable JSON artifact already exists: {path}")
    try:
        payload = json.dumps(
            value, ensure_ascii=False, indent=2, allow_nan=False
        ) + "\n"
    except (TypeError, ValueError) as error:
        raise ManifestError(f"JSON artifact is not serializable: {path}") from error
    temporary_path: Path | None = None
    try:
        staging_root = path.parent.parent / ".transition-staging"
        if not staging_root.is_dir() or staging_root.resolve() != staging_root:
            raise ManifestError(
                f"exclusive JSON staging directory is invalid: {staging_root}"
            )
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=staging_root
        )
        temporary_path = Path(temporary)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        temporary_path.chmod(0o444)
        os.link(temporary_path, path, follow_symlinks=False)
        temporary_path.unlink()
        temporary_path = None
    except FileExistsError as error:
        raise ManifestError(f"immutable JSON artifact already exists: {path}") from error
    except OSError as error:
        raise ManifestError(f"unable to create immutable JSON artifact: {path}") from error
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise ManifestError(f"artifact is unreadable: {path}") from error
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def sha256_runtime_file(path: Path) -> str:
    return sha256_json(
        {
            "kind": "file",
            "content_sha256": sha256_file(path),
            "read_execute_bits": stat.S_IMODE(path.stat().st_mode) & 0o555,
        }
    )


def sha256_runtime_directory(path: Path) -> str:
    return sha256_json(
        {
            "kind": "directory",
            "read_execute_bits": stat.S_IMODE(path.stat().st_mode) & 0o555,
        }
    )


def iter_subject_files(root: Path) -> Iterable[Path]:
    ignored_directories = {
        ".git",
        ".playwright-cli",
        "node_modules",
        "__pycache__",
        "coverage",
        ".codex-eval-workspace",
        "skill-reviewer-workspace",
    }
    files: list[Path] = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        current_path = Path(current)
        retained_directories: list[str] = []
        for name in sorted(directory_names):
            path = current_path / name
            if name in ignored_directories:
                continue
            if path.is_symlink():
                raise ManifestError(f"subject tree contains a symbolic link: {path}")
            retained_directories.append(name)
        directory_names[:] = retained_directories
        for name in sorted(file_names):
            if name == ".DS_Store":
                continue
            path = current_path / name
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                raise ManifestError(f"subject tree contains a symbolic link: {path}")
            if not stat.S_ISREG(metadata.st_mode):
                raise ManifestError(f"subject tree contains a special file: {path}")
            if metadata.st_nlink != 1:
                raise ManifestError(f"subject tree contains a hard-linked file: {path}")
            files.append(path)
    yield from sorted(files)


def sha256_tree(root: Path) -> str:
    if not root.is_dir():
        raise ManifestError(f"subject is not a directory: {root}")
    digest = hashlib.sha256()
    for path in iter_subject_files(root):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        content = path.read_bytes()
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def iter_strict_files(
    root: Path, label: str, *, allow_hardlinks: bool = False
) -> Iterable[Path]:
    if root.is_symlink() or not root.is_dir():
        raise ManifestError(f"{label} must be a real directory: {root}")
    for path in sorted(root.rglob("*")):
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise ManifestError(f"{label} contains a symbolic link: {path}")
        if stat.S_ISDIR(metadata.st_mode):
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise ManifestError(f"{label} contains a special file: {path}")
        if metadata.st_nlink != 1 and not allow_hardlinks:
            raise ManifestError(f"{label} contains a hard-linked file: {path}")
        if path.is_file():
            yield path


def sha256_strict_tree(root: Path, label: str) -> str:
    return sha256_json(strict_tree_manifest(root, label))


def strict_tree_manifest(root: Path, label: str) -> dict[str, str]:
    if root.is_symlink() or not root.is_dir():
        raise ManifestError(f"{label} must be a real directory: {root}")
    records: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        metadata = path.lstat()
        relative = path.relative_to(root).as_posix()
        if stat.S_ISLNK(metadata.st_mode):
            raise ManifestError(f"{label} contains a symbolic link: {path}")
        if stat.S_ISDIR(metadata.st_mode):
            records[f"{relative}/"] = sha256_runtime_directory(path)
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise ManifestError(f"{label} contains a special file: {path}")
        if metadata.st_nlink != 1:
            raise ManifestError(f"{label} contains a hard-linked file: {path}")
        records[relative] = sha256_runtime_file(path)
    return records


def _require_read_only_tree(root: Path, label: str) -> None:
    for path in [root, *sorted(root.rglob("*"))]:
        if path.lstat().st_mode & 0o222:
            raise ManifestError(f"{label} must be read-only: {path}")


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _ensure_empty_workspace(
    workspace: Path, protected_roots: Iterable[Path]
) -> None:
    resolved = workspace.resolve()
    for root in protected_roots:
        protected = root.resolve()
        if _is_within(resolved, protected) or _is_within(protected, resolved):
            raise ManifestError(
                "workspace must not overlap protected package or run directories"
            )
    if resolved.exists():
        if not resolved.is_dir():
            raise ManifestError("workspace must be an empty directory")
        if any(resolved.iterdir()):
            raise ManifestError("workspace must be empty before compilation")


def _make_read_only(root: Path) -> None:
    paths = sorted(root.rglob("*"), key=lambda path: len(path.parts), reverse=True)
    for path in [*paths, root]:
        path.chmod(path.stat().st_mode & ~0o222)


def _normalize_generated_directories(root: Path) -> None:
    for path in [root, *sorted(root.rglob("*"))]:
        if path.is_dir():
            path.chmod(0o555)


def _materialize_skill_snapshot(source: Path, destination: Path) -> str:
    if destination.exists():
        raise ManifestError(f"skill snapshot already exists: {destination}")
    destination.mkdir(parents=True)
    for entry_name in RUNTIME_SKILL_ENTRIES:
        source_entry = source / entry_name
        if not source_entry.exists():
            continue
        if source_entry.is_symlink():
            raise ManifestError(
                f"runtime skill snapshot entry contains a symbolic link: {entry_name}"
            )
        source_metadata = source_entry.lstat()
        destination_entry = destination / entry_name
        if stat.S_ISREG(source_metadata.st_mode):
            if source_metadata.st_nlink != 1:
                raise ManifestError(
                    f"runtime skill snapshot entry is hard-linked: {entry_name}"
                )
            safe_source = _safe_subject_file(
                source, entry_name, "runtime skill snapshot entry"
            )
            shutil.copy2(safe_source, destination_entry)
            continue
        if not stat.S_ISDIR(source_metadata.st_mode):
            raise ManifestError(
                f"runtime skill snapshot entry must be a file or directory: {entry_name}"
            )
        strict_tree_manifest(
            source_entry, f"runtime skill snapshot entry {entry_name}"
        )
        destination_entry.mkdir(parents=True)
        source_directories = [source_entry]
        for source_path in sorted(source_entry.rglob("*")):
            if not source_path.is_dir():
                continue
            source_directories.append(source_path)
            destination_directory = destination_entry / source_path.relative_to(
                source_entry
            )
            destination_directory.mkdir(parents=True, exist_ok=True)
        for source_file in iter_strict_files(
            source_entry, f"runtime skill snapshot entry {entry_name}"
        ):
            relative = source_file.relative_to(source_entry)
            safe_source = _safe_subject_file(
                source, (Path(entry_name) / relative).as_posix(), "runtime skill snapshot entry"
            )
            destination_file = destination_entry / relative
            destination_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(safe_source, destination_file)
        for source_directory in source_directories:
            target_directory = destination_entry / source_directory.relative_to(
                source_entry
            )
            target_directory.chmod(
                stat.S_IMODE(source_directory.stat().st_mode) | 0o200
            )
    if not (destination / "SKILL.md").is_file():
        raise ManifestError("skill snapshot requires SKILL.md")
    digest = runtime_skill_digest(destination)
    _make_read_only(destination)
    return digest


def _build_authority(subject: Path, manifest_path: Path) -> dict[str, Any]:
    eval_root = manifest_path.parent.resolve()
    if not _is_within(eval_root, subject):
        raise ManifestError("eval authority must stay inside the subject directory")
    semantic_contract_path = (
        Path(__file__).resolve().parents[1]
        / "references"
        / "semantic-grader-contract.md"
    )
    if not semantic_contract_path.is_file():
        raise ManifestError("semantic grader contract is missing")
    manifest = load_json(manifest_path)
    authoritative_fixture_digests: dict[str, str] = {}
    development_fixture_digests: dict[str, str] = {}
    raw_evals = manifest.get("evals")
    authoritative_evals: list[dict[str, Any]] = []
    development_evals: list[dict[str, Any]] = []
    if isinstance(raw_evals, list):
        for raw_case in raw_evals:
            if not isinstance(raw_case, dict):
                continue
            target_evals = (
                development_evals
                if raw_case.get("split") == "development"
                else authoritative_evals
            )
            target_evals.append(raw_case)
            if not isinstance(raw_case.get("files", []), list):
                continue
            holdout = raw_case.get("holdout", {})
            if isinstance(holdout, dict) and holdout.get("visibility") == "opaque":
                continue
            target_digests = (
                development_fixture_digests
                if raw_case.get("split") == "development"
                else authoritative_fixture_digests
            )
            for relative in raw_case.get("files", []):
                if not isinstance(relative, str):
                    continue
                target_digests[relative] = sha256_runtime_file(
                    _safe_subject_file(subject, relative, "declared eval fixture")
                )
    shared_manifest = {
        key: value for key, value in manifest.items() if key != "evals"
    }
    identity = {
        "authoritative_manifest_digest": sha256_json(
            {**shared_manifest, "evals": authoritative_evals}
        ),
        "authoritative_fixture_digests": dict(
            sorted(authoritative_fixture_digests.items())
        ),
        "grader_digest": sha256_file(Path(__file__).resolve()),
        "semantic_grader_contract_digest": sha256_file(semantic_contract_path),
    }
    development_identity = {
        "development_manifest_digest": sha256_json(
            {**shared_manifest, "evals": development_evals}
        ),
        "development_fixture_digests": dict(
            sorted(development_fixture_digests.items())
        ),
    }
    return {
        **identity,
        **development_identity,
        "evals_root": str(eval_root),
        "grader_path": str(Path(__file__).resolve()),
        "semantic_grader_contract_path": str(semantic_contract_path),
        "digest": sha256_json(identity),
        "development_digest": sha256_json(development_identity),
    }


def _require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{label} must be a non-empty string")
    return value.strip()


def _reject_unsupported_fields(
    value: dict[str, Any], allowed: set[str], label: str
) -> None:
    unsupported = sorted(set(value) - allowed)
    if unsupported:
        raise ManifestError(
            f"{label} contains unsupported fields: {', '.join(unsupported)}"
        )


def _safe_subject_file(subject: Path, relative: str, label: str) -> Path:
    subject = subject.resolve()
    path = Path(os.path.abspath(subject / relative))
    try:
        relative_path = path.relative_to(subject)
    except ValueError as error:
        raise ManifestError(f"{label} escapes the subject directory: {relative}") from error
    current = subject
    for part in relative_path.parts:
        current = current / part
        if current.is_symlink():
            raise ManifestError(f"{label} contains a symbolic link: {relative}")
    if not path.is_file() or path.resolve() != path:
        raise ManifestError(f"{label} does not exist: {relative}")
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ManifestError(f"{label} must be a regular file: {relative}")
    if metadata.st_nlink != 1:
        raise ManifestError(f"{label} must not be hard-linked: {relative}")
    return path


def _validate_artifact_path(value: Any, label: str) -> str:
    relative = _require_string(value, label)
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise ManifestError(f"{label} must stay inside its execution root")
    return path.as_posix()


def _require_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ManifestError(f"{label} must be a number")
    try:
        numeric = float(value)
    except OverflowError as error:
        raise ManifestError(f"{label} must be finite") from error
    if not math.isfinite(numeric):
        raise ManifestError(f"{label} must be finite")
    return numeric


def _validate_assertions(assertions: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(assertions, list) or not assertions:
        raise ManifestError(f"{label} must be a non-empty array")
    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, assertion in enumerate(assertions):
        assertion_label = f"{label}[{index}]"
        if not isinstance(assertion, dict):
            raise ManifestError(f"{assertion_label} must be an object")
        assertion_id = _require_string(assertion.get("id"), f"{assertion_label}.id")
        if assertion_id in seen:
            raise ManifestError(f"duplicate assertion id in {label}: {assertion_id}")
        seen.add(assertion_id)
        assertion_type = assertion.get("type")
        if assertion_type not in ASSERTION_TYPES:
            raise ManifestError(
                f"{assertion_label} uses unsupported assertion type: {assertion_type}"
            )
        _reject_unsupported_fields(
            assertion, ASSERTION_FIELDS[assertion_type], assertion_label
        )
        artifact = _validate_artifact_path(
            assertion.get("artifact"), f"{assertion_label}.artifact"
        )
        severity = assertion.get("severity", "must_pass")
        allowed_severities = (
            {"supplemental"}
            if assertion_type in SEMANTIC_ASSERTION_TYPES
            else {"must_pass", "should_pass"}
        )
        if severity not in allowed_severities:
            raise ManifestError(
                f"{assertion_label}.severity must be one of {sorted(allowed_severities)}"
            )
        if assertion_type in {"text_contains", "text_not_contains"}:
            expected = assertion.get("expected")
            if isinstance(expected, str):
                expected_values = [expected]
            elif isinstance(expected, list) and all(
                isinstance(value, str) and value for value in expected
            ):
                expected_values = expected
            else:
                raise ManifestError(
                    f"{assertion_label}.expected must be a string or non-empty string array"
                )
            if not expected_values:
                raise ManifestError(f"{assertion_label}.expected must not be empty")
        elif assertion_type in {"text_matches", "text_not_matches"}:
            pattern = _require_string(
                assertion.get("pattern"), f"{assertion_label}.pattern"
            )
            try:
                re.compile(pattern)
            except re.error as error:
                raise ManifestError(
                    f"{assertion_label}.pattern is invalid: {error}"
                ) from error
        elif assertion_type == "json_path":
            pointer = _require_string(
                assertion.get("path"), f"{assertion_label}.path"
            )
            if pointer != "" and not pointer.startswith("/"):
                raise ManifestError(
                    f"{assertion_label}.path must be an RFC 6901 JSON Pointer"
                )
            operator = assertion.get("operator", "equals")
            if operator not in {"equals", "not_equals", "contains", "exists"}:
                raise ManifestError(
                    f"{assertion_label}.operator must be equals, not_equals, contains, or exists"
                )
            if operator != "exists" and "expected" not in assertion:
                raise ManifestError(f"{assertion_label}.expected is required")
        elif assertion_type == "event_absent":
            _require_string(assertion.get("event"), f"{assertion_label}.event")
        elif assertion_type == "digest_equals":
            digest = _require_string(
                assertion.get("expected_sha256"),
                f"{assertion_label}.expected_sha256",
            )
            if not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ManifestError(
                    f"{assertion_label}.expected_sha256 must be a lowercase SHA-256 digest"
                )
        elif assertion_type == "numeric_range":
            if "minimum" not in assertion and "maximum" not in assertion:
                raise ManifestError(
                    f"{assertion_label} requires minimum and/or maximum"
                )
            if "minimum" in assertion:
                _require_number(assertion["minimum"], f"{assertion_label}.minimum")
            if "maximum" in assertion:
                _require_number(assertion["maximum"], f"{assertion_label}.maximum")
            pointer = assertion.get("path")
            if pointer is not None and (
                not isinstance(pointer, str) or (pointer and not pointer.startswith("/"))
            ):
                raise ManifestError(
                    f"{assertion_label}.path must be an RFC 6901 JSON Pointer"
                )
        elif assertion_type == "semantic_pair":
            rubric = _require_string(
                assertion.get("rubric"), f"{assertion_label}.rubric"
            )
            inputs = assertion.get("inputs")
            if not isinstance(inputs, list) or not inputs:
                raise ManifestError(
                    f"{assertion_label}.inputs must be a non-empty array"
                )
            normalized_inputs = [
                _validate_artifact_path(value, f"{assertion_label}.inputs[{index}]")
                for index, value in enumerate(inputs)
            ]
            if len(set(normalized_inputs)) != len(normalized_inputs):
                raise ManifestError(f"{assertion_label}.inputs must be unique")
            assertion = {
                **assertion,
                "rubric": rubric,
                "inputs": normalized_inputs,
            }
        normalized.append({**assertion, "artifact": artifact, "severity": severity})
    return normalized


def _validate_objectives(objectives: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(objectives, list) or not objectives:
        raise ManifestError(f"{label} must be a non-empty array")
    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, objective in enumerate(objectives):
        objective_label = f"{label}[{index}]"
        if not isinstance(objective, dict):
            raise ManifestError(f"{objective_label} must be an object")
        _reject_unsupported_fields(objective, OBJECTIVE_FIELDS, objective_label)
        objective_id = _require_string(objective.get("id"), f"{objective_label}.id")
        if objective_id in seen:
            raise ManifestError(f"duplicate objective id in {label}: {objective_id}")
        seen.add(objective_id)
        metric = _require_string(objective.get("metric"), f"{objective_label}.metric")
        if not re.fullmatch(r"[a-z][a-z0-9_]*", metric):
            raise ManifestError(f"{objective_label}.metric must be snake_case")
        direction = objective.get("direction")
        if direction not in {"maximize", "minimize"}:
            raise ManifestError(
                f"{objective_label}.direction must be maximize or minimize"
            )
        material = _require_number(
            objective.get("min_material_delta", 0),
            f"{objective_label}.min_material_delta",
        )
        tolerance = _require_number(
            objective.get("non_regression_tolerance", 0),
            f"{objective_label}.non_regression_tolerance",
        )
        if material < 0 or tolerance < 0:
            raise ManifestError(
                f"{objective_label} deltas and tolerances must be non-negative"
            )
        primary = objective.get("primary", True)
        if not isinstance(primary, bool):
            raise ManifestError(f"{objective_label}.primary must be boolean")
        if primary and material <= 0:
            raise ManifestError(
                f"{objective_label}.min_material_delta must be greater than zero for a primary objective"
            )
        normalized.append(
            {
                **objective,
                "id": objective_id,
                "metric": metric,
                "direction": direction,
                "primary": primary,
                "min_material_delta": material,
                "non_regression_tolerance": tolerance,
            }
        )
    return normalized


def _normalize_permissions(
    raw: dict[str, Any],
    label: str,
    inherited: dict[str, Any] | None = None,
) -> dict[str, Any]:
    unknown = sorted(set(raw) - PERMISSION_FIELDS)
    if unknown:
        raise ManifestError(
            f"{label} contains unsupported fields: {', '.join(unknown)}"
        )
    merged = {**(inherited or {}), **raw}
    network = merged.get("network")
    if network not in {"deny", "allowlist"}:
        raise ManifestError(f"{label}.network must be deny or allowlist")
    if merged.get("external_side_effects", "deny") != "deny":
        raise ManifestError(f"{label}.external_side_effects must remain deny")
    writable_roots = merged.get("writable_roots")
    if not isinstance(writable_roots, list) or not writable_roots:
        raise ManifestError(f"{label}.writable_roots must be a non-empty array")
    normalized = {
        "network": network,
        "external_side_effects": "deny",
        "writable_roots": [
            _validate_artifact_path(
                raw_root, f"{label}.writable_roots[{index}]"
            )
            for index, raw_root in enumerate(writable_roots)
        ],
    }
    if network == "allowlist":
        allowlist = merged.get("network_allowlist")
        if not isinstance(allowlist, list) or not allowlist or not all(
            isinstance(value, str) and value.strip() for value in allowlist
        ):
            raise ManifestError(
                f"{label}.network_allowlist must be a non-empty string array when network is allowlist"
            )
        normalized["network_allowlist"] = list(allowlist)
    elif "network_allowlist" in raw:
        raise ManifestError(
            f"{label}.network_allowlist is allowed only when network is allowlist"
        )
    return normalized


def validate_manifest(manifest: dict[str, Any], subject: Path) -> list[dict[str, Any]]:
    _reject_unsupported_fields(manifest, MANIFEST_FIELDS, "manifest")
    if manifest.get("contract") != MANIFEST_CONTRACT:
        raise ManifestError(f"contract must be {MANIFEST_CONTRACT}")
    _require_string(manifest.get("skill_name"), "skill_name")
    defaults = manifest.get("defaults")
    if not isinstance(defaults, dict):
        raise ManifestError("defaults must be an object")
    _reject_unsupported_fields(defaults, DEFAULT_FIELDS, "defaults")
    repeats = defaults.get("repeats")
    if not isinstance(repeats, dict):
        raise ManifestError("defaults.repeats must be an object")
    _reject_unsupported_fields(repeats, REPEAT_FIELDS, "defaults.repeats")
    for key, expected in (("deterministic", 1), ("stochastic", 3)):
        value = repeats.get(key)
        if not isinstance(value, int) or value < 1:
            raise ManifestError(f"defaults.repeats.{key} must be a positive integer")
        if value != expected:
            raise ManifestError(f"defaults.repeats.{key} must be {expected}")
    evolution = defaults.get("evolution")
    if not isinstance(evolution, dict):
        raise ManifestError("defaults.evolution must be an object")
    _reject_unsupported_fields(evolution, EVOLUTION_FIELDS, "defaults.evolution")
    if evolution.get("max_rounds") != 3:
        raise ManifestError("defaults.evolution.max_rounds must be 3")
    default_timeout = defaults.get("case_timeout_seconds")
    if (
        not isinstance(default_timeout, int)
        or isinstance(default_timeout, bool)
        or default_timeout <= 0
    ):
        raise ManifestError(
            "defaults.case_timeout_seconds must be a positive integer"
        )
    raw_permissions = defaults.get("permissions")
    if not isinstance(raw_permissions, dict):
        raise ManifestError("defaults.permissions must be an object")
    permissions = _normalize_permissions(raw_permissions, "defaults.permissions")

    evals = manifest.get("evals")
    if not isinstance(evals, list) or not evals:
        raise ManifestError("evals must be a non-empty array")
    seen_ids: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(evals):
        label = f"evals[{index}]"
        if not isinstance(item, dict):
            raise ManifestError(f"{label} must be an object")
        eval_id = _require_string(item.get("id"), f"{label}.id")
        if not PATH_SAFE_SLUG.fullmatch(eval_id):
            raise ManifestError(
                f"{label}.id must be a path-safe lowercase kebab-case slug"
            )
        if eval_id in seen_ids:
            raise ManifestError(f"duplicate eval id: {eval_id}")
        seen_ids.add(eval_id)
        split = item.get("split")
        if split not in {"development", "selection", "audit"}:
            raise ManifestError(
                f"{label}.split must be development, selection, or audit"
            )
        determinism = item.get("determinism")
        if determinism not in {"deterministic", "stochastic"}:
            raise ManifestError(
                f"{label}.determinism must be deterministic or stochastic"
            )
        _require_string(item.get("purpose"), f"{label}.purpose")
        raw_holdout = item.get("holdout", {"visibility": "public"})
        if not isinstance(raw_holdout, dict):
            raise ManifestError(f"{label}.holdout must be an object")
        holdout_unknown = sorted(set(raw_holdout) - {"visibility", "asset_id"})
        if holdout_unknown:
            raise ManifestError(
                f"{label}.holdout contains unsupported fields: "
                + ", ".join(holdout_unknown)
            )
        visibility = raw_holdout.get("visibility", "public")
        if visibility not in {"public", "opaque"}:
            raise ManifestError(
                f"{label}.holdout.visibility must be public or opaque"
            )
        if visibility == "opaque":
            if split != "audit":
                raise ManifestError(
                    f"{label}.holdout.visibility opaque is allowed only for audit"
                )
            exposed_oracle_fields = sorted(
                {"prompt", "files", "assertions", "objectives"} & set(item)
            )
            if exposed_oracle_fields:
                raise ManifestError(
                    f"{label} opaque audit must not expose oracle fields: "
                    + ", ".join(exposed_oracle_fields)
                )
            _reject_unsupported_fields(item, OPAQUE_EVAL_FIELDS, label)
            asset_id = _require_string(
                raw_holdout.get("asset_id"), f"{label}.holdout.asset_id"
            )
            if not PATH_SAFE_SLUG.fullmatch(asset_id):
                raise ManifestError(
                    f"{label}.holdout.asset_id must be a path-safe lowercase kebab-case slug"
                )
            holdout = {"visibility": "opaque", "asset_id": asset_id}
            prompt: str | None = None
            file_records: list[dict[str, Any]] = []
            assertions: list[dict[str, Any]] = []
            objectives: list[dict[str, Any]] = []
        else:
            _reject_unsupported_fields(item, PUBLIC_EVAL_FIELDS, label)
            if "asset_id" in raw_holdout:
                raise ManifestError(
                    f"{label}.holdout.asset_id is allowed only for opaque holdout"
                )
            holdout = {"visibility": "public", "asset_id": None}
            prompt = _require_string(item.get("prompt"), f"{label}.prompt")
            files = item.get("files", [])
            if not isinstance(files, list) or not all(
                isinstance(value, str) for value in files
            ):
                raise ManifestError(f"{label}.files must be an array of paths")
            files = [
                _validate_artifact_path(value, f"{label}.files[{file_index}]")
                for file_index, value in enumerate(files)
            ]
            if len(set(files)) != len(files):
                raise ManifestError(f"{label}.files must be unique")
            file_records = [
                {
                    "path": relative,
                    "digest": sha256_runtime_file(
                        _safe_subject_file(subject, relative, f"{label}.files")
                    ),
                }
                for relative in files
            ]
            assertions = _validate_assertions(
                item.get("assertions"), f"{label}.assertions"
            )
            if not any(
                assertion.get("type") in DETERMINISTIC_ASSERTION_TYPES
                and assertion.get("severity") == "must_pass"
                for assertion in assertions
            ):
                raise ManifestError(
                    f"{label}.assertions requires at least one deterministic must_pass assertion"
                )
            objectives = _validate_objectives(
                item.get("objectives"), f"{label}.objectives"
            )
        timeout_seconds = item.get("timeout_seconds", default_timeout)
        if (
            not isinstance(timeout_seconds, int)
            or isinstance(timeout_seconds, bool)
            or timeout_seconds <= 0
        ):
            raise ManifestError(f"{label}.timeout_seconds must be a positive integer")
        item_permissions = item.get("permissions", {})
        if not isinstance(item_permissions, dict):
            raise ManifestError(f"{label}.permissions must be an object")
        resolved_permissions = _normalize_permissions(
            item_permissions, f"{label}.permissions", permissions
        )
        normalized.append(
            {
                **item,
                **({"prompt": prompt} if prompt is not None else {}),
                "files": file_records,
                "holdout": holdout,
                "assertions": assertions,
                "objectives": objectives,
                "repeats": repeats[determinism],
                "timeout_seconds": timeout_seconds,
                "permissions": resolved_permissions,
            }
        )
    return normalized


def _resolve_holdout_cases(
    cases: list[dict[str, Any]],
    *,
    subject: Path,
    holdout_pack_path: Path | None,
    protected_roots: Iterable[Path],
) -> tuple[list[dict[str, Any]], dict[str, Any], dict[tuple[str, str], Path]]:
    visibilities = {
        str(case.get("holdout", {}).get("visibility", "public")) for case in cases
    }
    if len(visibilities) != 1:
        raise ManifestError("one execution split cannot mix public and opaque holdout")
    visibility = next(iter(visibilities))
    if visibility == "public":
        if holdout_pack_path is not None:
            raise ManifestError("--holdout-pack is allowed only for an opaque audit")
        return (
            cases,
            {
                "visibility": "public",
                "issuer": None,
                "source_path": None,
                "digest": None,
            },
            {
                (str(case["id"]), str(record["path"])): _safe_subject_file(
                    subject, str(record["path"]), "public eval fixture"
                )
                for case in cases
                for record in case.get("files", [])
            },
        )
    if visibility != "opaque":
        raise ManifestError("holdout visibility is invalid")
    if holdout_pack_path is None:
        raise ManifestError("an opaque audit requires --holdout-pack")
    provided = Path(os.path.abspath(holdout_pack_path))
    if (
        provided.is_symlink()
        or not provided.is_file()
        or provided.lstat().st_nlink != 1
    ):
        raise ManifestError("holdout pack must be a canonical regular file")
    pack_path = provided.resolve()
    if any(
        _is_within(pack_path, root) or _is_within(root, pack_path)
        for root in protected_roots
    ):
        raise ManifestError(
            "holdout pack must stay outside candidate, baseline, and run workspaces"
        )
    pack = load_json(pack_path)
    if set(pack) != {"issuer", "assets"}:
        raise ManifestError("holdout pack must contain only issuer and assets")
    issuer = _require_string(pack.get("issuer"), "holdout_pack.issuer")
    assets = pack.get("assets")
    if not isinstance(assets, dict):
        raise ManifestError("holdout_pack.assets must be an object")
    resolved_cases: list[dict[str, Any]] = []
    sources: dict[tuple[str, str], Path] = {}
    fixture_digests: dict[str, str] = {}
    for case in cases:
        case_id = str(case["id"])
        asset_id = _require_string(
            case.get("holdout", {}).get("asset_id"),
            f"eval {case_id}.holdout.asset_id",
        )
        asset = assets.get(asset_id)
        if not isinstance(asset, dict) or set(asset) != {
            "prompt",
            "files",
            "assertions",
            "objectives",
        }:
            raise ManifestError(f"opaque holdout asset is missing or invalid: {asset_id}")
        prompt = _require_string(
            asset.get("prompt"), f"holdout_pack.assets.{asset_id}.prompt"
        )
        asset_files = asset.get("files")
        if not isinstance(asset_files, dict):
            raise ManifestError(f"opaque holdout asset files are invalid: {asset_id}")
        logical_paths = [
            _validate_artifact_path(
                logical_path,
                f"holdout_pack.assets.{asset_id}.files.{logical_path}",
            )
            for logical_path in asset_files
        ]
        if len(set(logical_paths)) != len(logical_paths):
            raise ManifestError(f"opaque holdout asset files are duplicated: {asset_id}")
        assertions = _validate_assertions(
            asset.get("assertions"),
            f"holdout_pack.assets.{asset_id}.assertions",
        )
        if not any(
            assertion.get("type") in DETERMINISTIC_ASSERTION_TYPES
            and assertion.get("severity") == "must_pass"
            for assertion in assertions
        ):
            raise ManifestError(
                f"holdout_pack.assets.{asset_id}.assertions requires at least one deterministic must_pass assertion"
            )
        objectives = _validate_objectives(
            asset.get("objectives"),
            f"holdout_pack.assets.{asset_id}.objectives",
        )
        resolved_records: list[dict[str, Any]] = []
        for logical_path in logical_paths:
            source_value = asset_files.get(logical_path)
            if not isinstance(source_value, str) or not source_value:
                raise ManifestError(
                    f"opaque holdout source is invalid: {case_id}/{logical_path}"
                )
            source_provided = Path(source_value)
            if not source_provided.is_absolute():
                raise ManifestError("opaque holdout sources must use absolute paths")
            if (
                source_provided.is_symlink()
                or not source_provided.is_file()
                or source_provided.lstat().st_nlink != 1
            ):
                raise ManifestError("opaque holdout source must be a regular file")
            source = source_provided.resolve()
            if any(
                _is_within(source, root) or _is_within(root, source)
                for root in protected_roots
            ):
                raise ManifestError(
                    "opaque holdout sources must stay outside candidate, baseline, and run workspaces"
                )
            digest = sha256_runtime_file(source)
            resolved_records.append({"path": logical_path, "digest": digest})
            sources[(case_id, logical_path)] = source
            fixture_digests[f"{case_id}/{logical_path}"] = digest
        resolved_cases.append(
            {
                **case,
                "prompt": prompt,
                "files": resolved_records,
                "assertions": assertions,
                "objectives": objectives,
            }
        )
    pack_identity = {
        "pack_digest": sha256_file(pack_path),
        "fixture_digests": dict(sorted(fixture_digests.items())),
    }
    return (
        resolved_cases,
        {
            "visibility": "opaque",
            "issuer": issuer,
            "source_path": str(pack_path),
            "digest": sha256_json(pack_identity),
        },
        sources,
    )


def _cases_with_execution_arms(
    cases: list[dict[str, Any]], baseline_kind: str
) -> list[dict[str, Any]]:
    default_arms = (
        ["with_skill", "old_skill"]
        if baseline_kind == "old_skill"
        else ["with_skill", "without_skill"]
    )
    cases_with_arms: list[dict[str, Any]] = []
    for case in cases:
        arms = list(default_arms)
        without_skill_config = case.get("without_skill", {})
        if not isinstance(without_skill_config, dict):
            raise ManifestError(
                f"eval {case['id']}.without_skill must be an object when present"
            )
        extra: dict[str, Any] = {}
        if case["split"] == "audit" and baseline_kind == "old_skill":
            applicable = without_skill_config.get("applicable", True)
            if not isinstance(applicable, bool):
                raise ManifestError(
                    f"eval {case['id']}.without_skill.applicable must be boolean"
                )
            if applicable:
                arms.append("without_skill")
            else:
                extra["without_skill_na_reason"] = _require_string(
                    without_skill_config.get("reason"),
                    f"eval {case['id']}.without_skill.reason",
                )
        cases_with_arms.append({**case, **extra, "arms": arms})
    return cases_with_arms


def _declared_executor_artifacts(case: dict[str, Any]) -> list[str]:
    return list(
        dict.fromkeys(
            artifact
            for assertion in case.get("assertions", [])
            for artifact in (
                [str(assertion["artifact"])]
                if assertion.get("type") in DETERMINISTIC_ASSERTION_TYPES
                else [str(value) for value in assertion.get("inputs", [])]
                if assertion.get("type") in SEMANTIC_ASSERTION_TYPES
                else []
            )
        )
    )


def _runtime_skill_file_digests(source: Path) -> dict[str, str]:
    records: dict[str, str] = {}
    for entry_name in RUNTIME_SKILL_ENTRIES:
        source_entry = source / entry_name
        if not source_entry.exists():
            continue
        if source_entry.is_symlink():
            raise ManifestError(
                f"runtime skill snapshot entry contains a symbolic link: {entry_name}"
            )
        source_metadata = source_entry.lstat()
        if stat.S_ISREG(source_metadata.st_mode):
            if source_metadata.st_nlink != 1:
                raise ManifestError(
                    f"runtime skill snapshot entry is hard-linked: {entry_name}"
                )
            source_file = _safe_subject_file(
                source, entry_name, "runtime skill snapshot entry"
            )
            records[entry_name] = sha256_runtime_file(source_file)
            continue
        if not stat.S_ISDIR(source_metadata.st_mode):
            raise ManifestError(
                f"runtime skill snapshot entry must be a file or directory: {entry_name}"
            )
        records[f"{entry_name}/"] = sha256_runtime_directory(source_entry)
        for relative, digest in strict_tree_manifest(
            source_entry, f"runtime skill snapshot entry {entry_name}"
        ).items():
            records[f"{entry_name}/{relative}"] = digest
    if "SKILL.md" not in records:
        raise ManifestError("skill snapshot requires SKILL.md")
    return records


def runtime_skill_digest(source: Path) -> str:
    return sha256_json(_runtime_skill_file_digests(source))


def compile_manifest(
    *,
    manifest_path: Path,
    subject: Path,
    workspace: Path,
    execution_profile_path: Path,
    holdout_pack_path: Path | None = None,
    baseline_kind: str,
    baseline_path: Path | None = None,
    splits: list[str] | None = None,
    case_ids: list[str] | None = None,
) -> dict[str, Any]:
    manifest_path = manifest_path.resolve()
    subject = subject.resolve()
    expected_manifest = (subject / "evals" / "evals.json").resolve()
    if manifest_path != expected_manifest:
        raise ManifestError("manifest must be the subject's evals/evals.json")
    manifest = load_json(manifest_path)
    cases = validate_manifest(manifest, subject)
    selected_splits = list(dict.fromkeys(splits or []))
    if len(selected_splits) != 1 or selected_splits[0] not in {
        "development",
        "selection",
        "audit",
    }:
        raise ManifestError("compile requires exactly one --split")
    selected_split = selected_splits[0]
    requested_case_ids = list(dict.fromkeys(case_ids or []))
    available_case_ids = {str(case["id"]) for case in cases}
    unknown_case_ids = [
        case_id for case_id in requested_case_ids if case_id not in available_case_ids
    ]
    if unknown_case_ids:
        raise ManifestError(
            f"unknown eval case id: {', '.join(unknown_case_ids)}"
        )
    split_case_ids = {
        str(case["id"]) for case in cases if case["split"] == selected_split
    }
    wrong_split_case_ids = [
        case_id for case_id in requested_case_ids if case_id not in split_case_ids
    ]
    if wrong_split_case_ids:
        raise ManifestError(
            f"eval case is not in the selected {selected_split} split: "
            + ", ".join(wrong_split_case_ids)
        )
    if (
        selected_split in {"selection", "audit"}
        and requested_case_ids
        and set(requested_case_ids) != split_case_ids
    ):
        raise ManifestError(
            f"{selected_split} must execute the complete split; --case is only for development screening"
        )
    cases = [
        case
        for case in cases
        if case["split"] in selected_splits
        and (not requested_case_ids or case["id"] in requested_case_ids)
    ]
    if not cases:
        raise ManifestError("selected split has no eval cases")

    if baseline_kind == "old_skill":
        if baseline_path is None:
            raise ManifestError("--baseline-path is required for old_skill")
        baseline_path = baseline_path.resolve()
        baseline = {
            "kind": "old_skill",
            "path": str(baseline_path),
            "digest": runtime_skill_digest(baseline_path),
        }
    elif baseline_kind == "without_skill":
        baseline = {"kind": "without_skill", "path": None, "digest": None}
    else:
        raise ManifestError("baseline kind must be old_skill or without_skill")

    if selected_split in {"selection", "audit"} and baseline_kind != "old_skill":
        raise ManifestError(f"{selected_split} requires an old_skill baseline")

    protected_roots = [subject]
    if baseline_path is not None:
        protected_roots.append(baseline_path)
    _ensure_empty_workspace(workspace, protected_roots)
    execution_profile = _load_execution_profile(
        execution_profile_path,
        protected_roots=[*protected_roots, workspace.resolve()],
    )
    cases, holdout, fixture_sources = _resolve_holdout_cases(
        cases,
        subject=subject,
        holdout_pack_path=holdout_pack_path,
        protected_roots=[*protected_roots, workspace.resolve()],
    )
    manifest_digest = sha256_file(manifest_path)
    subject_digest = runtime_skill_digest(subject)
    authority = _build_authority(subject, manifest_path)

    cases_with_arms = _cases_with_execution_arms(cases, baseline_kind)

    workspace = workspace.resolve()
    run_seed = "|".join(
        [
            subject_digest,
            str(authority["digest"]),
            str(authority["development_digest"]),
            str(baseline.get("digest")),
            str(execution_profile["digest"]),
            str(holdout["digest"]),
            selected_split,
            ",".join(str(case["id"]) for case in cases),
        ]
    ).encode("utf-8")
    run_id = f"run-{hashlib.sha256(run_seed).hexdigest()[:20]}"
    snapshot_records: dict[str, dict[str, Any]] = {}
    for case in cases_with_arms:
        for arm in case["arms"]:
            if arm == "without_skill":
                continue
            source = subject if arm == "with_skill" else baseline_path
            source_digest = (
                subject_digest if arm == "with_skill" else baseline.get("digest")
            )
            if source is None:
                raise ManifestError(f"skill snapshot source is missing for arm {arm}")
            for repeat in range(1, int(case["repeats"]) + 1):
                snapshot_key = f"{case['id']}/{arm}/repeat-{repeat}"
                snapshot_path = _safe_artifact(
                    workspace, f"skill-snapshots/{snapshot_key}"
                )
                snapshot_records[snapshot_key] = {
                    "case_id": case["id"],
                    "arm": arm,
                    "repeat": repeat,
                    "path": str(snapshot_path),
                    "digest": _materialize_skill_snapshot(source, snapshot_path),
                    "source_digest": source_digest,
                }
    snapshot_root = workspace / "skill-snapshots"
    if snapshot_root.exists():
        _make_read_only(snapshot_root)
    for record in snapshot_records.values():
        current = Path(str(record["path"]))
        while current != snapshot_root:
            current.chmod(0o555)
            current = current.parent
    snapshot_root.chmod(0o555)
    skill_snapshot_tree_digest = sha256_json(
        strict_tree_manifest(snapshot_root, "skill snapshot tree")
    )
    plan = {
        "contract": PLAN_CONTRACT,
        "run_id": run_id,
        "manifest": {
            "path": str(manifest_path),
            "digest": manifest_digest,
            "contract": MANIFEST_CONTRACT,
        },
        "subject": {"path": str(subject), "digest": subject_digest},
        "baseline": baseline,
        "authority": authority,
        "execution_profile": execution_profile,
        "holdout": holdout,
        "skill_snapshots": snapshot_records,
        "skill_snapshot_tree_digest": skill_snapshot_tree_digest,
        "splits": selected_splits,
        "case_ids": [str(case["id"]) for case in cases],
        "cases": cases_with_arms,
    }
    plan_path = workspace / "execution-plan.json"
    (workspace / "inputs").mkdir(parents=True, exist_ok=True)
    input_copy_digests: dict[str, str] = {}
    assignment_digests: dict[str, str] = {}
    for case in cases_with_arms:
        expected_artifacts = _declared_executor_artifacts(case)
        for arm in case["arms"]:
            for repeat in range(1, int(case["repeats"]) + 1):
                if arm == "without_skill":
                    configuration = {
                        "kind": "without_skill",
                        "skill_path": None,
                        "snapshot_digest": None,
                        "source_digest": None,
                    }
                else:
                    snapshot_key = f"{case['id']}/{arm}/repeat-{repeat}"
                    snapshot_record = snapshot_records[snapshot_key]
                    configuration = {
                        "kind": arm,
                        "skill_path": snapshot_record["path"],
                        "snapshot_digest": snapshot_record["digest"],
                        "source_digest": snapshot_record["source_digest"],
                    }
                relative_path = Path("assignments") / str(case["id"]) / str(arm) / (
                    f"repeat-{repeat}.json"
                )
                repeat_root = (
                    workspace
                    / "cases"
                    / str(case["id"])
                    / str(arm)
                    / f"repeat-{repeat}"
                )
                repeat_root.mkdir(parents=True, exist_ok=False)
                input_files: list[dict[str, Any]] = []
                input_root = _safe_artifact(
                    workspace,
                    (
                        Path("inputs")
                        / str(case["id"])
                        / str(arm)
                        / f"repeat-{repeat}"
                    ).as_posix(),
                )
                for record in case.get("files", []):
                    input_relative = (
                        Path("inputs")
                        / str(case["id"])
                        / str(arm)
                        / f"repeat-{repeat}"
                        / "package"
                        / str(record["path"])
                    )
                    source_path = fixture_sources[
                        (str(case["id"]), str(record["path"]))
                    ]
                    isolated_path = _safe_artifact(
                        workspace, input_relative.as_posix()
                    )
                    isolated_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source_path, isolated_path)
                    isolated_path.chmod(isolated_path.stat().st_mode & ~0o222)
                    digest = sha256_runtime_file(isolated_path)
                    input_copy_digests[input_relative.as_posix()] = digest
                    input_files.append(
                        {
                            "relative_path": record["path"],
                            "path": str(isolated_path),
                            "digest": digest,
                        }
                    )
                if input_root.exists():
                    _make_read_only(input_root)
                assignment = {
                    "contract": ASSIGNMENT_CONTRACT,
                    "run_id": run_id,
                    "case_id": case["id"],
                    "arm": arm,
                    "repeat": repeat,
                    "repeat_count": case["repeats"],
                    "prompt": case["prompt"],
                    "timeout_seconds": case["timeout_seconds"],
                    "configuration": configuration,
                    "input_files": input_files,
                    "readable_paths": [
                        *(
                            [str(configuration["skill_path"])]
                            if configuration["skill_path"]
                            else []
                        ),
                        *(str(record["path"]) for record in input_files),
                    ],
                    "permissions": case["permissions"],
                    "execution_profile_digest": execution_profile["digest"],
                    "writable_root": str(repeat_root.resolve()),
                    "execution_artifact": "execution.json",
                    "dispatch_artifact": "dispatch-receipt.json",
                    "source_trace_artifact": "codex-events.jsonl",
                    "trace_artifact": "agent-trace.jsonl",
                    "expected_artifacts": expected_artifacts,
                }
                assignment_path = workspace / relative_path
                write_json(assignment_path, assignment)
                assignment_digests[relative_path.as_posix()] = sha256_file(
                    assignment_path
                )
    isolated_inputs_root = workspace / "inputs"
    _make_read_only(isolated_inputs_root)
    _normalize_generated_directories(isolated_inputs_root)
    input_tree_digest = sha256_json(
        strict_tree_manifest(isolated_inputs_root, "isolated input tree")
    )
    plan["input_tree_digest"] = input_tree_digest
    write_json(plan_path, plan)
    run_lock = {
        "contract": RUN_LOCK_CONTRACT,
        "run_id": run_id,
        "plan_digest": sha256_file(plan_path),
        "manifest_digest": manifest_digest,
        "subject_digest": subject_digest,
        "baseline": baseline,
        "authority": authority,
        "execution_profile": execution_profile,
        "holdout": holdout,
        "skill_snapshot_digests": {
            arm: record["digest"] for arm, record in snapshot_records.items()
        },
        "skill_snapshot_tree_digest": skill_snapshot_tree_digest,
        "input_tree_digest": input_tree_digest,
        "fixture_digests": {
            record["path"]: record["digest"]
            for item in cases
            for record in item["files"]
        },
        "assignment_digests": assignment_digests,
        "input_copy_digests": input_copy_digests,
    }
    write_json(workspace / "run-lock.json", run_lock)
    return plan


def _safe_artifact(root: Path, relative: str) -> Path:
    resolved_root = root.resolve()
    lexical = Path(os.path.abspath(root / relative))
    try:
        relative_path = lexical.relative_to(resolved_root)
    except ValueError as error:
        raise ManifestError(f"artifact path escapes its execution root: {relative}") from error
    current = resolved_root
    for part in relative_path.parts:
        current = current / part
        if current.is_symlink():
            raise ManifestError(f"artifact path contains a symbolic link: {relative}")
    if lexical.exists():
        if lexical.resolve() != lexical:
            raise ManifestError(f"artifact path is not canonical: {relative}")
        metadata = lexical.lstat()
        if stat.S_ISREG(metadata.st_mode) and metadata.st_nlink != 1:
            raise ManifestError(f"artifact path is hard-linked: {relative}")
        if not (
            stat.S_ISREG(metadata.st_mode) or stat.S_ISDIR(metadata.st_mode)
        ):
            raise ManifestError(f"artifact path is a special file: {relative}")
    return lexical


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
    target = profile.get("target")
    harness = profile.get("harness")
    if target == "codex-cli" and harness == "codex-exec-jsonl":
        return "process_spawn"
    if target == "native-agent" and harness == "lead-agent-dispatch":
        return "host_dispatch"
    return "external_harness"


def _bound_execution_profile(
    *, assignment_path: Path, workspace: Path, assignment: dict[str, Any]
) -> dict[str, Any]:
    plan_path = _safe_artifact(workspace, "execution-plan.json")
    lock_path = _safe_artifact(workspace, "run-lock.json")
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
    assignment, repeat_root, _trace_path = _trace_assignment_context(
        assignment_path=assignment_path, workspace=workspace
    )
    profile = _bound_execution_profile(
        assignment_path=assignment_path,
        workspace=workspace,
        assignment=assignment,
    )
    normalized_dispatch_id = _require_string(dispatch_id, "dispatch_id")
    normalized_worker_id = _require_string(worker_id, "worker_id")
    if len(normalized_dispatch_id) > 256 or len(normalized_worker_id) > 256:
        raise ManifestError("dispatch_id and worker_id must not exceed 256 characters")
    normalized_batch_id = (
        _require_string(batch_id, "batch_id")
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
    artifact = _validate_artifact_path(
        assignment.get("dispatch_artifact"), "assignment.dispatch_artifact"
    )
    receipt_path = _safe_artifact(repeat_root, artifact)
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
    artifact = _validate_artifact_path(
        assignment.get("dispatch_artifact"), "assignment.dispatch_artifact"
    )
    receipt_path = _safe_artifact(repeat_root, artifact)
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
    expected_artifact = _validate_artifact_path(
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
    receipt_path = _safe_artifact(repeat_root, expected_artifact)
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
) -> tuple[dict[str, Any] | None, list[str]]:
    errors: list[str] = []
    expected_artifact = _validate_artifact_path(
        assignment.get("source_trace_artifact"),
        "assignment.source_trace_artifact",
    )
    if descriptor is None:
        return None, ["Codex source trace descriptor is missing"] if required else []
    if not isinstance(descriptor, dict):
        return None, ["execution source_trace must be an object or null"]
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
    source_path = _safe_artifact(repeat_root, expected_artifact)
    if not source_path.is_file():
        return dict(descriptor), [*errors, "Codex source trace artifact is missing"]
    actual_digest = sha256_file(source_path)
    if descriptor.get("digest") != actual_digest:
        errors.append("source trace digest is missing or mismatched")
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
            event = json.loads(line, parse_constant=_reject_json_constant)
            _require_finite_json(event, f"source trace line {index}")
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
            value = json.loads(line, parse_constant=_reject_json_constant)
            _require_finite_json(value, f"agent trace line {line_number}")
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
    if descriptor.get("capture_source") not in TRACE_CAPTURE_SOURCES:
        errors.append("execution trace capture_source is invalid")
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


def _trace_assignment_context(
    *, assignment_path: Path, workspace: Path
) -> tuple[dict[str, Any], Path, Path]:
    workspace = workspace.resolve()
    assignment = load_json(assignment_path)
    if assignment.get("contract") != ASSIGNMENT_CONTRACT:
        raise ManifestError(f"assignment contract must be {ASSIGNMENT_CONTRACT}")
    case_id = _require_string(assignment.get("case_id"), "assignment.case_id")
    arm = _require_string(assignment.get("arm"), "assignment.arm")
    repeat = assignment.get("repeat")
    if not isinstance(repeat, int) or isinstance(repeat, bool) or repeat < 1:
        raise ManifestError("assignment.repeat must be a positive integer")
    expected_assignment = _safe_artifact(
        workspace,
        (Path("assignments") / case_id / arm / f"repeat-{repeat}.json").as_posix(),
    )
    if assignment_path.resolve() != expected_assignment.resolve():
        raise ManifestError("assignment path does not match its bound identity")
    repeat_root = _require_real_directory(
        workspace / "cases" / case_id / arm / f"repeat-{repeat}",
        workspace,
        "repeat root",
    )
    writable_root = Path(
        _require_string(assignment.get("writable_root"), "assignment.writable_root")
    ).resolve()
    if writable_root != repeat_root:
        raise ManifestError("assignment writable_root does not match its repeat root")
    trace_artifact = _validate_artifact_path(
        assignment.get("trace_artifact"), "assignment.trace_artifact"
    )
    return assignment, repeat_root, _safe_artifact(repeat_root, trace_artifact)


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
    capture_source: str,
) -> dict[str, Any]:
    if kind not in TRACE_EVENT_KINDS:
        raise ManifestError(f"unsupported Agent trace event kind: {kind}")
    if capture_source not in TRACE_CAPTURE_SOURCES:
        raise ManifestError(f"unsupported Agent trace capture source: {capture_source}")
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
        _validate_artifact_path(value, "Agent trace artifact reference")
        for value in artifact_refs
    ]
    assignment, _repeat_root, trace_path = _trace_assignment_context(
        assignment_path=assignment_path, workspace=workspace
    )
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
    capture_source: str,
    source_trace: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if status not in {"completed", "failed", "timed_out", "interrupted"}:
        raise ManifestError(f"unsupported execution status: {status}")
    assignment, repeat_root, trace_path = _trace_assignment_context(
        assignment_path=assignment_path, workspace=workspace
    )
    execution_path = _safe_artifact(
        repeat_root,
        _validate_artifact_path(
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
        artifact_path = _safe_artifact(repeat_root, artifact)
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
    execution_profile = _bound_execution_profile(
        assignment_path=assignment_path.resolve(),
        workspace=workspace.resolve(),
        assignment=assignment,
    )
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
        required=capture_source == "codex_cli_jsonl" and status == "completed",
    )
    if source_trace_errors:
        raise ManifestError(
            "unable to bind source trace: " + "; ".join(source_trace_errors)
        )
    trace = {
        "artifact": str(assignment.get("trace_artifact")),
        "digest": sha256_file(trace_path),
        "capture_source": capture_source,
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
    assertion_id = _require_string(assertion.get("id"), "assertion.id")
    assertion_type = _require_string(assertion.get("type"), "assertion.type")
    if assertion_type not in DETERMINISTIC_ASSERTION_TYPES:
        raise ManifestError(
            f"assertion {assertion_id} is not a deterministic assertion: {assertion_type}"
        )
    severity = assertion.get("severity", "must_pass")
    if severity not in {"must_pass", "should_pass"}:
        raise ManifestError(f"assertion {assertion_id} has invalid severity")
    artifact = _require_string(assertion.get("artifact"), f"assertion {assertion_id}.artifact")
    artifact_path = _safe_artifact(repeat_root, artifact)
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
            passed = not missing
            evidence = {"artifact": artifact, "missing": missing}
        else:
            present = [value for value in expected if value in content]
            passed = not present
            evidence = {"artifact": artifact, "unexpected": present}
    elif assertion_type in {"text_matches", "text_not_matches"}:
        try:
            content = artifact_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            return _failed_assertion(
                assertion_id, assertion_type, severity, f"unreadable text artifact: {error}"
            )
        pattern = _require_string(
            assertion.get("pattern"), f"assertion {assertion_id}.pattern"
        )
        try:
            matched = re.search(pattern, content, flags=re.MULTILINE) is not None
        except re.error as error:
            raise ManifestError(
                f"assertion {assertion_id} has invalid pattern: {error}"
            ) from error
        passed = matched if assertion_type == "text_matches" else not matched
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
                    _require_number(actual, f"assertion {assertion_id}.actual")
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
        event = _require_string(
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
                    parse_constant=_reject_json_constant,
                )
                _require_finite_json(
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
        expected_digest = _require_string(
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
    case_root = _require_real_directory(
        workspace / "cases" / str(case["id"]), workspace, "case root"
    )
    arm_root = _require_real_directory(case_root / arm, workspace, "arm root")
    for repeat in range(1, int(case["repeats"]) + 1):
        repeat_root = _require_real_directory(
            arm_root / f"repeat-{repeat}", workspace, "repeat root"
        )
        execution_path = _safe_artifact(repeat_root, "execution.json")
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
        assignment_path = _safe_artifact(workspace, assignment_relative)
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
            dispatch_path = _safe_artifact(repeat_root, dispatch_artifact)
            if dispatch_path.is_file():
                artifacts.append(str(dispatch_path.relative_to(workspace)))
        trace_artifact = _validate_artifact_path(
            assignment.get("trace_artifact"),
            f"locked assignment trace_artifact: {assignment_relative}",
        )
        trace_path = _safe_artifact(repeat_root, trace_artifact)
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
        )
        repeat_binding_errors.extend(trace_errors)
        source_trace_descriptor, source_trace_errors = _validate_source_trace(
            repeat_root=repeat_root,
            descriptor=execution.get("source_trace"),
            assignment=assignment,
            trace_events=trace_events,
            required=trace_descriptor.get("capture_source") == "codex_cli_jsonl",
        )
        repeat_binding_errors.extend(source_trace_errors)
        if isinstance(source_trace_descriptor, dict):
            source_artifact = source_trace_descriptor.get("artifact")
            if isinstance(source_artifact, str):
                source_path = _safe_artifact(repeat_root, source_artifact)
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
            artifact_path = _safe_artifact(repeat_root, artifact)
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
                    normalized_metrics[metric] = _require_number(
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
                "status": execution.get("status")
                if not repeat_binding_errors
                else "invalid",
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
            record["status"] = "invalid"
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
    assertion_id = _require_string(assertion.get("id"), "semantic assertion.id")
    rubric = _require_string(
        assertion.get("rubric"), f"semantic assertion {assertion_id}.rubric"
    )
    inputs = assertion.get("inputs")
    if not isinstance(inputs, list) or not inputs:
        raise ManifestError(
            f"semantic assertion {assertion_id}.inputs must be a non-empty array"
        )
    normalized_inputs = [
        _validate_artifact_path(value, f"semantic assertion {assertion_id}.inputs")
        for value in inputs
    ]
    artifacts: dict[str, list[dict[str, Any]]] = {}
    repeats = int(case.get("repeats", 0))
    for arm in [candidate_arm, baseline_arm]:
        records: list[dict[str, Any]] = []
        for repeat in range(1, repeats + 1):
            repeat_root = case_root / arm / f"repeat-{repeat}"
            digests: dict[str, str | None] = {}
            trace_path = _safe_artifact(repeat_root, "agent-trace.jsonl")
            trace_events, _trace_errors = (
                _read_trace_jsonl(trace_path) if trace_path.is_file() else ([], [])
            )
            trace_event_ids = _trace_event_ids_by_artifact(trace_events)
            for relative in normalized_inputs:
                artifact_path = _safe_artifact(repeat_root, relative)
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
    assertion_id = _require_string(assertion.get("id"), "semantic assertion.id")
    artifact = _require_string(
        assertion.get("artifact"), f"semantic assertion {assertion_id}.artifact"
    )
    artifact_path = _safe_artifact(case_root, artifact)
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
    if case.get("determinism") != "stochastic":
        return False
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


def _strict_tree_file_digests(root: Path) -> dict[str, str]:
    if not root.exists():
        return {}
    if not root.is_dir() or root.is_symlink():
        raise ManifestError(f"locked tree must be a real directory: {root}")
    return {
        path.relative_to(root).as_posix(): sha256_file(path)
        for path in iter_strict_files(root, "locked tree")
    }


def _require_real_directory(path: Path, root: Path, label: str) -> Path:
    root = root.resolve()
    lexical = Path(os.path.abspath(path))
    try:
        relative = lexical.relative_to(root)
    except ValueError as error:
        raise ManifestError(f"{label} escapes the run workspace") from error
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ManifestError(f"{label} contains a symbolic link: {current}")
    if not lexical.is_dir() or lexical.resolve() != lexical:
        raise ManifestError(f"{label} must be a canonical real directory")
    return lexical


def verify_locked_inputs(
    *, plan_path: Path, workspace: Path, plan: dict[str, Any]
) -> dict[str, Any]:
    workspace = workspace.resolve()
    plan_path = plan_path.resolve()
    if plan_path != workspace / "execution-plan.json":
        raise ManifestError("execution plan path is not canonical")
    lock_path = _safe_artifact(workspace, "run-lock.json")
    if not lock_path.is_file():
        raise ManifestError("run-lock.json is required before grading")
    lock = load_json(lock_path)
    if lock.get("contract") != RUN_LOCK_CONTRACT:
        raise ManifestError(f"run lock contract must be {RUN_LOCK_CONTRACT}")

    manifest = plan.get("manifest")
    subject = plan.get("subject")
    baseline = plan.get("baseline")
    if (
        not isinstance(manifest, dict)
        or not isinstance(subject, dict)
        or not isinstance(baseline, dict)
    ):
        raise ManifestError(
            "execution plan is missing manifest, subject, or baseline metadata"
        )
    subject_path = Path(
        _require_string(subject.get("path"), "plan.subject.path")
    ).resolve()
    manifest_path = Path(
        _require_string(manifest.get("path"), "plan.manifest.path")
    ).resolve()
    if manifest_path != (subject_path / "evals" / "evals.json").resolve():
        raise ManifestError("execution plan manifest path is not canonical")
    if not manifest_path.is_file():
        raise ManifestError("locked eval manifest changed or disappeared")
    manifest_digest = sha256_file(manifest_path)
    subject_digest = runtime_skill_digest(subject_path)
    if not subject_path.is_dir() or subject_digest != subject.get("digest"):
        raise ManifestError("locked subject changed or disappeared")

    recomputed_authority = _build_authority(subject_path, manifest_path)
    authority = plan.get("authority")
    if authority != recomputed_authority:
        raise ManifestError("locked eval or grader authority changed after compilation")

    execution_profile = plan.get("execution_profile")
    if not isinstance(execution_profile, dict):
        raise ManifestError("execution plan is missing the execution profile")

    baseline_kind = baseline.get("kind")
    baseline_path: Path | None = None
    if baseline_kind == "old_skill":
        baseline_path = Path(
            _require_string(baseline.get("path"), "plan.baseline.path")
        ).resolve()
        baseline_digest = runtime_skill_digest(baseline_path)
        expected_baseline = {
            "kind": "old_skill",
            "path": str(baseline_path),
            "digest": baseline_digest,
        }
        if not baseline_path.is_dir() or baseline != expected_baseline:
            raise ManifestError("locked old_skill baseline changed or disappeared")
    elif baseline_kind == "without_skill":
        baseline_digest = None
        expected_baseline = {
            "kind": "without_skill",
            "path": None,
            "digest": None,
        }
        if baseline != expected_baseline:
            raise ManifestError("without_skill baseline metadata is invalid")
    else:
        raise ManifestError("execution plan baseline kind is invalid")

    splits = plan.get("splits")
    case_ids = plan.get("case_ids")
    if (
        not isinstance(splits, list)
        or len(splits) != 1
        or splits[0] not in {"development", "selection", "audit"}
        or not isinstance(case_ids, list)
        or not case_ids
        or not all(isinstance(case_id, str) for case_id in case_ids)
        or len(set(case_ids)) != len(case_ids)
    ):
        raise ManifestError("execution plan split and case ids are invalid")
    selected_split = splits[0]
    if selected_split in {"selection", "audit"} and baseline_kind != "old_skill":
        raise ManifestError(f"{selected_split} requires an old_skill baseline")
    protected_roots = [subject_path]
    if baseline_path is not None:
        protected_roots.append(baseline_path)
    if any(
        _is_within(workspace, root) or _is_within(root, workspace)
        for root in protected_roots
    ):
        raise ManifestError(
            "run workspace overlaps the candidate or baseline package"
        )
    profile_path = Path(
        _require_string(
            execution_profile.get("source_path"),
            "plan.execution_profile.source_path",
        )
    )
    expected_execution_profile = _load_execution_profile(
        profile_path,
        protected_roots=[*protected_roots, workspace],
    )
    if execution_profile != expected_execution_profile:
        raise ManifestError("locked execution profile changed after compilation")
    manifest_cases = validate_manifest(load_json(manifest_path), subject_path)
    all_split_case_ids = [
        str(case["id"])
        for case in manifest_cases
        if case["split"] == selected_split
    ]
    if selected_split in {"selection", "audit"} and case_ids != all_split_case_ids:
        raise ManifestError(f"{selected_split} plan does not cover the complete split")
    expected_cases_without_arms = [
        case
        for case in manifest_cases
        if case["split"] == selected_split and case["id"] in set(case_ids)
    ]
    if [case["id"] for case in expected_cases_without_arms] != case_ids:
        raise ManifestError("execution plan case ids do not match manifest order")
    planned_holdout = plan.get("holdout")
    if not isinstance(planned_holdout, dict):
        raise ManifestError("execution plan is missing holdout authority")
    holdout_source = planned_holdout.get("source_path")
    expected_cases_without_arms, expected_holdout, _fixture_sources = (
        _resolve_holdout_cases(
            expected_cases_without_arms,
            subject=subject_path,
            holdout_pack_path=Path(holdout_source)
            if isinstance(holdout_source, str)
            else None,
            protected_roots=[*protected_roots, workspace],
        )
    )
    if planned_holdout != expected_holdout:
        raise ManifestError("locked holdout authority changed after compilation")
    expected_cases = _cases_with_execution_arms(
        expected_cases_without_arms, str(baseline_kind)
    )
    if plan.get("cases") != expected_cases:
        raise ManifestError("execution plan cases do not match the pinned manifest")

    run_seed = "|".join(
        [
            subject_digest,
            str(recomputed_authority["digest"]),
            str(recomputed_authority["development_digest"]),
            str(baseline_digest),
            str(expected_execution_profile["digest"]),
            str(expected_holdout["digest"]),
            selected_split,
            ",".join(case_ids),
        ]
    ).encode("utf-8")
    expected_run_id = f"run-{hashlib.sha256(run_seed).hexdigest()[:20]}"
    if plan.get("run_id") != expected_run_id:
        raise ManifestError("execution plan run id is not derived from pinned inputs")

    snapshots = plan.get("skill_snapshots")
    if not isinstance(snapshots, dict):
        raise ManifestError("skill snapshot authority is missing")
    expected_snapshots: dict[str, dict[str, Any]] = {}
    expected_snapshot_digests: dict[str, str] = {}
    expected_snapshot_tree_manifest: dict[str, str] = {}
    for case in expected_cases:
        for arm in case["arms"]:
            if arm == "without_skill":
                continue
            source = subject_path if arm == "with_skill" else baseline_path
            source_digest = subject_digest if arm == "with_skill" else baseline_digest
            if source is None:
                raise ManifestError(f"skill snapshot source is missing for arm {arm}")
            source_files = _runtime_skill_file_digests(source)
            for repeat in range(1, int(case["repeats"]) + 1):
                key = f"{case['id']}/{arm}/repeat-{repeat}"
                snapshot_path = workspace / "skill-snapshots" / key
                snapshot_files = strict_tree_manifest(
                    snapshot_path, f"locked skill snapshot {key}"
                )
                if snapshot_files != source_files:
                    raise ManifestError(f"locked skill snapshot changed: {key}")
                snapshot_digest = runtime_skill_digest(snapshot_path)
                expected_snapshots[key] = {
                    "case_id": case["id"],
                    "arm": arm,
                    "repeat": repeat,
                    "path": str(snapshot_path),
                    "digest": snapshot_digest,
                    "source_digest": source_digest,
                }
                expected_snapshot_digests[key] = snapshot_digest
                prefix = Path()
                for part in Path(key).parts:
                    prefix /= part
                    expected_snapshot_tree_manifest[f"{prefix.as_posix()}/"] = (
                        sha256_json(
                            {"kind": "directory", "read_execute_bits": 0o555}
                        )
                    )
                expected_snapshot_tree_manifest.update(
                    {
                        f"{key}/{relative}": digest
                        for relative, digest in source_files.items()
                    }
                )
    snapshot_root = workspace / "skill-snapshots"
    _require_read_only_tree(snapshot_root, "skill snapshot tree")
    actual_snapshot_tree_manifest = strict_tree_manifest(
        snapshot_root, "skill snapshot tree"
    )
    if actual_snapshot_tree_manifest != expected_snapshot_tree_manifest:
        raise ManifestError("skill snapshot tree contains undeclared entries")
    expected_snapshot_tree_digest = sha256_json(expected_snapshot_tree_manifest)
    if snapshots != expected_snapshots:
        raise ManifestError("execution plan skill snapshots are not canonical")

    expected_input_tree_manifest: dict[str, str] = {}
    for case in expected_cases:
        for arm in case["arms"]:
            for repeat in range(1, int(case["repeats"]) + 1):
                for record in case.get("files", []):
                    relative_input = (
                        Path(str(case["id"]))
                        / str(arm)
                        / f"repeat-{repeat}"
                        / "package"
                        / str(record["path"])
                    )
                    prefix = Path()
                    for part in relative_input.parts[:-1]:
                        prefix /= part
                        expected_input_tree_manifest[f"{prefix.as_posix()}/"] = (
                            sha256_json(
                                {"kind": "directory", "read_execute_bits": 0o555}
                            )
                        )
                    expected_input_tree_manifest[relative_input.as_posix()] = record[
                        "digest"
                    ]
    input_root = workspace / "inputs"
    _require_read_only_tree(input_root, "isolated input tree")
    if strict_tree_manifest(input_root, "isolated input tree") != (
        expected_input_tree_manifest
    ):
        raise ManifestError("isolated input tree contains undeclared entries")
    expected_input_tree_digest = sha256_json(expected_input_tree_manifest)

    expected_plan = {
        "contract": PLAN_CONTRACT,
        "run_id": expected_run_id,
        "manifest": {
            "path": str(manifest_path),
            "digest": manifest_digest,
            "contract": MANIFEST_CONTRACT,
        },
        "subject": {"path": str(subject_path), "digest": subject_digest},
        "baseline": expected_baseline,
        "authority": recomputed_authority,
        "execution_profile": expected_execution_profile,
        "holdout": expected_holdout,
        "skill_snapshots": expected_snapshots,
        "skill_snapshot_tree_digest": expected_snapshot_tree_digest,
        "input_tree_digest": expected_input_tree_digest,
        "splits": [selected_split],
        "case_ids": case_ids,
        "cases": expected_cases,
    }
    if plan != expected_plan:
        raise ManifestError("execution plan does not match the manifest-derived contract")

    assignment_digests: dict[str, str] = {}
    input_copy_digests: dict[str, str] = {}
    expected_assignment_files: dict[str, str] = {}
    for case in expected_cases:
        expected_artifacts = _declared_executor_artifacts(case)
        for arm in case["arms"]:
            for repeat in range(1, int(case["repeats"]) + 1):
                if arm == "without_skill":
                    configuration = {
                        "kind": "without_skill",
                        "skill_path": None,
                        "snapshot_digest": None,
                        "source_digest": None,
                    }
                else:
                    key = f"{case['id']}/{arm}/repeat-{repeat}"
                    snapshot = expected_snapshots[key]
                    configuration = {
                        "kind": arm,
                        "skill_path": snapshot["path"],
                        "snapshot_digest": snapshot["digest"],
                        "source_digest": snapshot["source_digest"],
                    }
                repeat_root = (
                    workspace
                    / "cases"
                    / str(case["id"])
                    / str(arm)
                    / f"repeat-{repeat}"
                )
                input_files: list[dict[str, Any]] = []
                for record in case.get("files", []):
                    input_relative = (
                        Path("inputs")
                        / str(case["id"])
                        / str(arm)
                        / f"repeat-{repeat}"
                        / "package"
                        / str(record["path"])
                    ).as_posix()
                    isolated_path = workspace / input_relative
                    if (
                        not isolated_path.is_file()
                        or sha256_runtime_file(isolated_path) != record["digest"]
                    ):
                        raise ManifestError(f"locked isolated input changed: {input_relative}")
                    input_copy_digests[input_relative] = record["digest"]
                    input_files.append(
                        {
                            "relative_path": record["path"],
                            "path": str(isolated_path),
                            "digest": record["digest"],
                        }
                    )
                assignment_relative = (
                    Path("assignments")
                    / str(case["id"])
                    / str(arm)
                    / f"repeat-{repeat}.json"
                ).as_posix()
                assignment_path = workspace / assignment_relative
                expected_assignment = {
                    "contract": ASSIGNMENT_CONTRACT,
                    "run_id": expected_run_id,
                    "case_id": case["id"],
                    "arm": arm,
                    "repeat": repeat,
                    "repeat_count": case["repeats"],
                    "prompt": case["prompt"],
                    "timeout_seconds": case["timeout_seconds"],
                    "configuration": configuration,
                    "input_files": input_files,
                    "readable_paths": [
                        *(
                            [str(configuration["skill_path"])]
                            if configuration["skill_path"]
                            else []
                        ),
                        *(str(record["path"]) for record in input_files),
                    ],
                    "permissions": case["permissions"],
                    "execution_profile_digest": expected_execution_profile["digest"],
                    "writable_root": str(repeat_root.resolve()),
                    "execution_artifact": "execution.json",
                    "dispatch_artifact": "dispatch-receipt.json",
                    "source_trace_artifact": "codex-events.jsonl",
                    "trace_artifact": "agent-trace.jsonl",
                    "expected_artifacts": expected_artifacts,
                }
                if not assignment_path.is_file() or load_json(
                    assignment_path
                ) != expected_assignment:
                    raise ManifestError(
                        f"executor assignment does not match pinned inputs: {assignment_relative}"
                    )
                digest = sha256_file(assignment_path)
                assignment_digests[assignment_relative] = digest
                expected_assignment_files[
                    assignment_relative.removeprefix("assignments/")
                ] = digest
    if _strict_tree_file_digests(workspace / "assignments") != expected_assignment_files:
        raise ManifestError("assignment tree contains undeclared files")

    fixture_digests = {
        record["path"]: record["digest"]
        for case in expected_cases_without_arms
        for record in case["files"]
    }
    expected_lock = {
        "contract": RUN_LOCK_CONTRACT,
        "run_id": expected_run_id,
        "plan_digest": sha256_file(plan_path),
        "manifest_digest": manifest_digest,
        "subject_digest": subject_digest,
        "baseline": expected_baseline,
        "authority": recomputed_authority,
        "execution_profile": expected_execution_profile,
        "holdout": expected_holdout,
        "skill_snapshot_digests": expected_snapshot_digests,
        "skill_snapshot_tree_digest": expected_snapshot_tree_digest,
        "input_tree_digest": expected_input_tree_digest,
        "fixture_digests": fixture_digests,
        "assignment_digests": assignment_digests,
        "input_copy_digests": input_copy_digests,
    }
    if lock != expected_lock:
        raise ManifestError("run lock does not match the manifest-derived contract")
    return {
        "locked": True,
        "verified": True,
        "run_lock": str(lock_path.resolve()),
        "run_lock_digest": sha256_file(lock_path),
        "plan_digest": expected_lock["plan_digest"],
        "authority_digest": recomputed_authority["digest"],
    }


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
    all_with_skill_passed = True
    any_regression = False
    any_direction_disagreement = False
    any_semantic_problem = False
    any_safety_violation = False
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
                    _safe_artifact(
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
                any_safety_violation = True
            if arm_result["side_effects"]:
                limitations.append(
                    f"external side effect recorded for case {case['id']} arm {arm}"
                )
                any_safety_violation = True
            if arm_result["binding_errors"]:
                limitations.append(
                    f"execution binding invalid for case {case['id']} arm {arm}"
                )
        all_with_skill_passed = all_with_skill_passed and candidate["passed"]
        any_regression = any_regression or regressed
        any_direction_disagreement = any_direction_disagreement or direction_disagreement
        any_semantic_problem = any_semantic_problem or semantic_problem
        if missing_objective_metrics:
            any_incomplete = True
            limitations.append(f"objective metric missing in case {case['id']}")
        if direction_disagreement:
            limitations.append(
                f"paired stochastic directions disagree in case {case['id']}"
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
    if (
        any_incomplete
        or not all_with_skill_passed
        or any_regression
        or any_direction_disagreement
        or any_semantic_problem
        or any_safety_violation
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
        "limitations": limitations,
        "integrity": integrity,
        "execution_profile": plan.get("execution_profile"),
        "holdout": holdout,
        "evidence_scope": (
            "opaque-holdout" if holdout_visibility == "opaque" else "public-calibration"
        ),
        "release_eligible": bool(
            is_audit and holdout_visibility == "opaque" and level != "inconclusive"
        ),
    }
    if is_audit and holdout_visibility != "opaque":
        evidence["limitations"].append(
            "public audit fixtures are calibration-only and cannot authorize release; use a trusted opaque holdout pack"
        )
    if persist:
        write_json(workspace / "verification-evidence.json", evidence)
    return evidence


def _baseline_result(
    case_result: dict[str, Any], preferred: str | None = None
) -> tuple[str | None, dict[str, Any] | None]:
    if preferred and preferred != "with_skill":
        value = case_result.get(preferred)
        if isinstance(value, dict):
            return preferred, value
    for key, value in case_result.items():
        if key in {"with_skill", "old_skill", "without_skill"} and key != "with_skill":
            if isinstance(value, dict):
                return key, value
    return None, None


def _compute_decision_core(
    *, plan: dict[str, Any], evidence: dict[str, Any], iteration: int, phase: str
) -> dict[str, Any]:
    evidence_cases = {
        str(item.get("id")): item
        for item in evidence.get("cases", [])
        if isinstance(item, dict)
    }
    hard_gates: list[dict[str, Any]] = []
    objective_results: list[dict[str, Any]] = []
    opaque_holdout = (
        phase == "audit"
        and isinstance(plan.get("holdout"), dict)
        and plan["holdout"].get("visibility") == "opaque"
    )
    if phase == "audit":
        hard_gates.append(
            {
                "id": "audit:opaque-holdout",
                "passed": opaque_holdout,
                "reason": (
                    "audit fixtures are bound to a trusted opaque holdout pack"
                    if opaque_holdout
                    else "public calibration fixtures cannot authorize release"
                ),
            }
        )
    for case in plan.get("cases", []):
        case_id = str(case.get("id"))
        result = evidence_cases.get(case_id)
        if result is None:
            hard_gates.append(
                {
                    "id": f"{case_id}:evidence-present",
                    "passed": False,
                    "reason": "missing case evidence",
                }
            )
            continue
        candidate = result.get("with_skill")
        preferred_baseline = plan.get("baseline", {}).get("kind")
        baseline_arm, baseline = _baseline_result(result, preferred_baseline)
        candidate_valid = (
            isinstance(candidate, dict)
            and candidate.get("complete") is True
            and candidate.get("passed") is True
            and not candidate.get("forbidden_actions")
            and not candidate.get("side_effects")
        )
        hard_gates.append(
            {
                "id": f"{case_id}:candidate-required-assertions",
                "passed": candidate_valid,
                "reason": "candidate artifacts complete and required assertions pass"
                if candidate_valid
                else "candidate evidence is incomplete or a required assertion failed",
            }
        )
        for paired_arm in ("old_skill", "without_skill"):
            if paired_arm == baseline_arm or paired_arm not in result:
                continue
            paired = result.get(paired_arm)
            paired_complete = (
                isinstance(paired, dict)
                and paired.get("complete") is True
                and not paired.get("forbidden_actions")
                and not paired.get("side_effects")
            )
            hard_gates.append(
                {
                    "id": f"{case_id}:paired-{paired_arm}-complete",
                    "passed": paired_complete,
                    "reason": f"{paired_arm} artifacts are complete and safe"
                    if paired_complete
                    else f"{paired_arm} artifacts are missing, incomplete, or unsafe",
                }
            )
        baseline_valid = (
            isinstance(baseline, dict)
            and baseline.get("complete") is True
            and not baseline.get("forbidden_actions")
            and not baseline.get("side_effects")
        )
        hard_gates.append(
            {
                "id": f"{case_id}:paired-baseline-complete",
                "passed": baseline_valid,
                "reason": f"{baseline_arm or 'baseline'} artifacts are complete and safe"
                if baseline_valid
                else "paired baseline artifacts are missing, incomplete, or unsafe",
            }
        )
        no_forbidden = (
            isinstance(candidate, dict)
            and not candidate.get("forbidden_actions")
            and not candidate.get("side_effects")
        )
        hard_gates.append(
            {
                "id": f"{case_id}:forbidden-actions",
                "passed": no_forbidden,
                "reason": "no forbidden action or external side effect observed"
                if no_forbidden
                else "forbidden action or external side effect observed",
            }
        )
        if not isinstance(candidate, dict) or not isinstance(baseline, dict):
            continue
        for objective in case.get("objectives", []):
            metric = _require_string(objective.get("metric"), "objective.metric")
            candidate_value = candidate.get(metric)
            baseline_value = baseline.get(metric)
            unusable_metrics = result.get("missing_objective_metrics", [])
            if (
                metric in unusable_metrics
                or not isinstance(candidate_value, (int, float))
                or not isinstance(baseline_value, (int, float))
            ):
                hard_gates.append(
                    {
                        "id": f"{case_id}:{objective.get('id')}:metric-present",
                        "passed": False,
                        "reason": f"metric {metric} is missing from paired evidence",
                    }
                )
                continue
            delta = _objective_delta(
                objective, float(candidate_value), float(baseline_value)
            )
            tolerance = float(objective.get("non_regression_tolerance", 0))
            material_delta = float(objective.get("min_material_delta", 0))
            objective_results.append(
                {
                    "case_id": case_id,
                    "id": objective.get("id"),
                    "metric": metric,
                    "direction": objective.get("direction"),
                    "primary": objective.get("primary", True),
                    "candidate": candidate_value,
                    "baseline": baseline_value,
                    "delta": delta,
                    "non_regressed": delta >= -tolerance,
                    "materially_improved": delta >= material_delta,
                    "non_regression_tolerance": tolerance,
                    "min_material_delta": material_delta,
                }
            )

    hard_gates_passed = all(item["passed"] for item in hard_gates)
    pareto_admissible = bool(objective_results) and all(
        item["non_regressed"] for item in objective_results
    )
    material_improvement = any(
        item["primary"] and item["materially_improved"] for item in objective_results
    )
    evidence_inconclusive = evidence.get("level") == "inconclusive"
    accepted = not evidence_inconclusive and hard_gates_passed and pareto_admissible
    if phase == "selection":
        accepted = accepted and material_improvement
    if evidence_inconclusive:
        status = "inconclusive"
    elif not hard_gates_passed or not pareto_admissible:
        status = "rejected"
    elif phase == "selection" and not material_improvement:
        status = "no-change"
    else:
        status = "accepted"
    return {
        "contract": ACCEPTANCE_CONTRACT,
        "run_id": plan.get("run_id"),
        "iteration": iteration,
        "phase": phase,
        "status": status,
        "accepted": accepted,
        "hard_gates_passed": hard_gates_passed,
        "pareto_admissible": pareto_admissible,
        "material_improvement": material_improvement,
        "release_eligible": bool(phase == "audit" and accepted and opaque_holdout),
        "hard_gates": hard_gates,
        "objectives": objective_results,
        "reason": {
            "accepted": "candidate passed every hard gate, did not regress, and materially improved a primary objective",
            "rejected": "candidate failed a hard gate or regressed on a declared objective",
            "no-change": "candidate produced no material primary-objective improvement",
            "inconclusive": "retained evidence cannot support an acceptance decision",
        }[status]
        if phase == "selection" or status != "accepted"
        else "candidate passed the one-shot audit hard gates without regression",
    }


def decide_candidate(
    *,
    plan_path: Path,
    evidence_path: Path,
    workspace: Path,
    iteration: int,
    phase: str,
) -> dict[str, Any]:
    if phase not in {"selection", "audit"}:
        raise ManifestError("decision phase must be selection or audit")
    workspace = workspace.resolve()
    plan_path = plan_path.resolve()
    evidence_path = evidence_path.resolve()
    if plan_path != workspace / "execution-plan.json":
        raise ManifestError("decision plan must be the workspace execution-plan.json")
    if evidence_path != workspace / "verification-evidence.json":
        raise ManifestError(
            "decision evidence must be the workspace verification-evidence.json"
        )
    plan = load_json(plan_path)
    if plan.get("contract") != PLAN_CONTRACT:
        raise ManifestError(f"execution plan contract must be {PLAN_CONTRACT}")
    plan_splits = plan.get("splits")
    if plan_splits != [phase] or any(
        case.get("split") != phase for case in plan.get("cases", [])
    ):
        raise ManifestError(
            f"{phase} decisions require a plan containing only the {phase} split"
        )
    evidence = grade_run(plan_path=plan_path, workspace=workspace)
    if evidence.get("contract") != VERIFICATION_CONTRACT:
        raise ManifestError(f"verification evidence contract must be {VERIFICATION_CONTRACT}")
    if plan.get("run_id") != evidence.get("run_id"):
        raise ManifestError("execution plan and evidence use different run ids")
    if iteration < 1:
        raise ManifestError("iteration must be a positive integer")
    integrity = evidence.get("integrity")
    if not isinstance(integrity, dict) or integrity.get("verified") is not True:
        raise ManifestError("decision requires verified locked evidence")

    decision = {
        **_compute_decision_core(
            plan=plan, evidence=evidence, iteration=iteration, phase=phase
        ),
        "plan_path": str(plan_path),
        "plan_digest": sha256_file(plan_path),
        "evidence_path": str(evidence_path),
        "evidence_digest": sha256_file(evidence_path),
        "evidence_level": evidence.get("level"),
        "authority_digest": plan.get("authority", {}).get("digest"),
        "subject": plan.get("subject"),
        "baseline": plan.get("baseline"),
    }
    write_json(
        workspace
        / f"iteration-{iteration}"
        / ("acceptance-decision.json" if phase == "selection" else "audit-decision.json"),
        decision,
    )
    return decision


def _validate_bound_decision(
    decision: dict[str, Any], decision_path: Path
) -> tuple[dict[str, Any], dict[str, Any]]:
    if decision.get("contract") != ACCEPTANCE_CONTRACT:
        raise ManifestError(f"acceptance decision contract must be {ACCEPTANCE_CONTRACT}")
    plan_path = Path(
        _require_string(decision.get("plan_path"), "decision.plan_path")
    )
    evidence_path = Path(
        _require_string(decision.get("evidence_path"), "decision.evidence_path")
    )
    if not plan_path.is_file() or sha256_file(plan_path) != decision.get(
        "plan_digest"
    ):
        raise ManifestError("decision plan digest is missing or mismatched")
    if not evidence_path.is_file() or sha256_file(evidence_path) != decision.get(
        "evidence_digest"
    ):
        raise ManifestError("decision evidence digest is missing or mismatched")
    plan = load_json(plan_path)
    evidence = load_json(evidence_path)
    if plan.get("contract") != PLAN_CONTRACT:
        raise ManifestError(f"execution plan contract must be {PLAN_CONTRACT}")
    if evidence.get("contract") != VERIFICATION_CONTRACT:
        raise ManifestError(f"verification evidence contract must be {VERIFICATION_CONTRACT}")
    if not (
        decision.get("run_id") == plan.get("run_id") == evidence.get("run_id")
    ):
        raise ManifestError("decision, plan, and evidence use different run ids")
    plan_authority = plan.get("authority")
    plan_subject = plan.get("subject")
    plan_baseline = plan.get("baseline")
    if not all(
        isinstance(value, dict)
        for value in (plan_authority, plan_subject, plan_baseline)
    ):
        raise ManifestError("decision plan authority, subject, and baseline must be objects")
    if decision.get("authority_digest") != plan_authority.get("digest"):
        raise ManifestError("decision authority digest does not match its plan")
    if decision.get("subject") != plan_subject:
        raise ManifestError("decision subject does not match its plan")
    if decision.get("baseline") != plan_baseline:
        raise ManifestError("decision baseline does not match its plan")
    integrity = evidence.get("integrity")
    if (
        not isinstance(integrity, dict)
        or integrity.get("verified") is not True
        or integrity.get("plan_digest") != decision.get("plan_digest")
    ):
        raise ManifestError("decision evidence is not bound to a verified plan")
    if decision.get("evidence_level") != evidence.get("level"):
        raise ManifestError("decision evidence level does not match retained evidence")
    phase = decision.get("phase")
    if phase not in {"selection", "audit"} or plan.get("splits") != [phase]:
        raise ManifestError("decision phase does not match its single-split plan")
    iteration = decision.get("iteration")
    if not isinstance(iteration, int) or isinstance(iteration, bool) or iteration < 1:
        raise ManifestError("decision iteration must be a positive integer")
    run_workspace = plan_path.parent.resolve()
    if plan_path.resolve() != run_workspace / "execution-plan.json":
        raise ManifestError("decision plan path is not canonical")
    if evidence_path.resolve() != run_workspace / "verification-evidence.json":
        raise ManifestError("decision evidence path is not canonical")
    expected_decision_path = run_workspace / f"iteration-{iteration}" / (
        "acceptance-decision.json" if phase == "selection" else "audit-decision.json"
    )
    if decision_path.resolve() != expected_decision_path:
        raise ManifestError("decision artifact path is not canonical")
    fresh_evidence = grade_run(
        plan_path=plan_path.resolve(), workspace=run_workspace, persist=False
    )
    if fresh_evidence != evidence:
        raise ManifestError(
            "decision evidence does not match freshly graded locked artifacts"
        )
    expected_core = _compute_decision_core(
        plan=plan, evidence=fresh_evidence, iteration=iteration, phase=phase
    )
    if any(decision.get(key) != value for key, value in expected_core.items()):
        raise ManifestError(
            "decision payload does not match its bound plan and evidence"
        )
    if not decision_path.is_file():
        raise ManifestError("decision artifact does not exist")
    return plan, fresh_evidence


def _plan_snapshot_path(plan: dict[str, Any], arm: str) -> Path:
    snapshots = plan.get("skill_snapshots")
    if not isinstance(snapshots, dict):
        raise ManifestError("candidate plan is missing skill snapshots")
    records = [
        record
        for record in snapshots.values()
        if isinstance(record, dict) and record.get("arm") == arm
    ]
    if not records:
        raise ManifestError(f"candidate plan has no {arm} snapshot")
    path = Path(_require_string(records[0].get("path"), f"{arm} snapshot.path"))
    expected_digest = records[0].get("digest")
    if not path.is_dir() or runtime_skill_digest(path) != expected_digest:
        raise ManifestError(f"candidate plan {arm} snapshot changed")
    return path


def _candidate_change(
    *, parent_snapshot: Path, candidate_snapshot: Path
) -> dict[str, Any]:
    parent_files = _runtime_skill_file_digests(parent_snapshot)
    candidate_files = _runtime_skill_file_digests(candidate_snapshot)
    added = sorted(set(candidate_files) - set(parent_files))
    removed = sorted(set(parent_files) - set(candidate_files))
    modified = sorted(
        path
        for path in set(parent_files) & set(candidate_files)
        if parent_files[path] != candidate_files[path]
    )
    change = {"added": added, "removed": removed, "modified": modified}
    return {**change, "digest": sha256_json(change)}


def _prepare_dashboard_diff_payload_root(workspace: Path) -> Path:
    payload_root = workspace / "dashboard-diffs"
    if payload_root.exists():
        if (
            payload_root.is_symlink()
            or not payload_root.is_dir()
            or payload_root.resolve() != payload_root
        ):
            raise ManifestError("dashboard diff payload root must be a canonical directory")
        for entry in payload_root.iterdir():
            if (
                entry.is_symlink()
                or not entry.is_file()
                or entry.parent.resolve() != payload_root
                or not re.fullmatch(r"[a-f0-9]{24}\.json", entry.name)
            ):
                raise ManifestError("dashboard diff payload root contains an invalid entry")
    else:
        payload_root.mkdir()
    return payload_root


def _dashboard_diff_text(path: Path) -> tuple[str | None, int]:
    size = path.stat().st_size
    if size > DASHBOARD_DIFF_RENDER_LIMIT_BYTES:
        return None, size
    raw = path.read_bytes()
    if len(raw) > DASHBOARD_DIFF_RENDER_LIMIT_BYTES:
        raise ManifestError("dashboard diff source grew while projecting")
    try:
        return raw.decode("utf-8"), len(raw)
    except UnicodeDecodeError:
        return None, len(raw)


def _dashboard_skill_diffs(
    plan: dict[str, Any], *, workspace: Path
) -> list[dict[str, Any]]:
    payload_root = _prepare_dashboard_diff_payload_root(workspace)
    if plan.get("baseline", {}).get("kind") != "old_skill":
        return []
    old_snapshot = _plan_snapshot_path(plan, "old_skill")
    new_snapshot = _plan_snapshot_path(plan, "with_skill")
    old_files = {
        path: digest
        for path, digest in _runtime_skill_file_digests(old_snapshot).items()
        if not path.endswith("/")
    }
    new_files = {
        path: digest
        for path, digest in _runtime_skill_file_digests(new_snapshot).items()
        if not path.endswith("/")
    }
    rows: list[dict[str, Any]] = []
    for relative_path in sorted(set(old_files) | set(new_files)):
        old_digest = old_files.get(relative_path)
        new_digest = new_files.get(relative_path)
        if old_digest == new_digest:
            continue
        if old_digest is None:
            status = "added"
        elif new_digest is None:
            status = "removed"
        else:
            status = "modified"
        binary = False
        oversized = False
        contents: dict[str, str] = {"old": "", "new": ""}
        sizes: dict[str, int] = {"old": 0, "new": 0}
        for side, snapshot, digest in (
            ("old", old_snapshot, old_digest),
            ("new", new_snapshot, new_digest),
        ):
            if digest is None:
                continue
            source = _safe_subject_file(
                snapshot, relative_path, f"dashboard {side} diff source"
            )
            text, size = _dashboard_diff_text(source)
            sizes[side] = size
            if size > DASHBOARD_DIFF_RENDER_LIMIT_BYTES:
                oversized = True
            elif text is None:
                binary = True
            else:
                contents[side] = text
        diff_id = sha256_json(
            {
                "path": relative_path,
                "old_digest": old_digest,
                "new_digest": new_digest,
            }
        )[:24]
        render_mode = "summary" if oversized else "binary" if binary else "lazy"
        content_url = (
            f"/dashboard-diffs/{diff_id}.json" if render_mode == "lazy" else None
        )
        payload_digest: str | None = None
        if content_url is not None:
            payload_path = payload_root / f"{diff_id}.json"
            write_json(
                payload_path,
                {
                    "contract": DASHBOARD_DIFF_CONTRACT,
                    "id": diff_id,
                    "path": relative_path,
                    "old_digest": old_digest,
                    "new_digest": new_digest,
                    "old_content": contents["old"],
                    "new_content": contents["new"],
                },
            )
            payload_digest = sha256_file(payload_path)
        rows.append(
            {
                "id": diff_id,
                "path": relative_path,
                "status": status,
                "old_digest": old_digest,
                "new_digest": new_digest,
                "old_size": sizes["old"],
                "new_size": sizes["new"],
                "binary": binary,
                "render_mode": render_mode,
                "content_url": content_url,
                "payload_digest": payload_digest,
                "summary": (
                    f"Interactive preview omitted because one side exceeds {DASHBOARD_DIFF_RENDER_LIMIT_BYTES} bytes; full evidence remains bound by digest."
                    if oversized
                    else "Binary content is retained by digest and is not rendered."
                    if binary
                    else None
                ),
            }
        )
    return rows


def _candidate_authorization(
    *,
    plan: dict[str, Any],
    plan_path: Path,
    round_number: int,
    parent_digest: str,
    parent_snapshot: Path,
    continuity: str,
    continuity_epoch: int,
    training_trace_ids: list[str],
) -> dict[str, Any]:
    candidate = plan.get("subject")
    if not isinstance(candidate, dict):
        raise ManifestError("candidate plan subject is missing")
    candidate_digest = _require_string(
        candidate.get("digest"), "plan.subject.digest"
    )
    change = _candidate_change(
        parent_snapshot=parent_snapshot,
        candidate_snapshot=_plan_snapshot_path(plan, "with_skill"),
    )
    return {
        "phase": "selection",
        "round": round_number,
        "run_id": _require_string(plan.get("run_id"), "plan.run_id"),
        "plan_path": str(plan_path.resolve()),
        "plan_digest": sha256_file(plan_path.resolve()),
        "parent_digest": parent_digest,
        "candidate_digest": candidate_digest,
        "subject_path": _require_string(candidate.get("path"), "plan.subject.path"),
        "change": {
            "added": change["added"],
            "removed": change["removed"],
            "modified": change["modified"],
        },
        "change_digest": change["digest"],
        "continuity": continuity,
        "continuity_epoch": continuity_epoch,
        "training_trace_ids": training_trace_ids,
    }


def _normalize_training_trace_ids(values: list[str] | None) -> list[str]:
    trace_ids = list(values or [])
    if (
        not all(isinstance(value, str) and value.strip() for value in trace_ids)
        or len(set(trace_ids)) != len(trace_ids)
    ):
        raise ManifestError("training trace ids must be unique non-empty strings")
    return trace_ids


def _audit_authorization(
    *, plan: dict[str, Any], plan_path: Path, round_number: int
) -> dict[str, Any]:
    subject = plan.get("subject")
    if not isinstance(subject, dict):
        raise ManifestError("audit plan subject is missing")
    holdout = plan.get("holdout")
    if not isinstance(holdout, dict):
        raise ManifestError("audit plan holdout is missing")
    return {
        "phase": "audit",
        "round": round_number,
        "run_id": _require_string(plan.get("run_id"), "plan.run_id"),
        "plan_path": str(plan_path.resolve()),
        "plan_digest": sha256_file(plan_path.resolve()),
        "candidate_digest": _require_string(
            subject.get("digest"), "plan.subject.digest"
        ),
        "holdout_visibility": holdout.get("visibility"),
        "holdout_digest": holdout.get("digest"),
    }


def initialize_evolution(*, plan_path: Path, workspace: Path) -> dict[str, Any]:
    plan_path = plan_path.resolve()
    plan = load_json(plan_path)
    if plan.get("contract") != PLAN_CONTRACT:
        raise ManifestError(f"execution plan contract must be {PLAN_CONTRACT}")
    if plan.get("splits") != ["selection"]:
        raise ManifestError("evolution must initialize from a selection plan")
    subject = plan.get("subject")
    baseline = plan.get("baseline")
    if not isinstance(subject, dict) or not isinstance(baseline, dict):
        raise ManifestError("evolution plan is missing subject or baseline metadata")
    subject_path = Path(
        _require_string(subject.get("path"), "plan.subject.path")
    )
    baseline_path = Path(
        _require_string(baseline.get("path"), "plan.baseline.path")
    )
    workspace = workspace.resolve()
    _ensure_empty_workspace(
        workspace, [subject_path, baseline_path, plan_path.parent]
    )
    verify_locked_inputs(
        plan_path=plan_path, workspace=plan_path.parent, plan=plan
    )
    authority_digest = _require_string(
        plan.get("authority", {}).get("digest"), "plan.authority.digest"
    )
    execution_profile_digest = _require_string(
        plan.get("execution_profile", {}).get("digest"),
        "plan.execution_profile.digest",
    )
    if (
        not isinstance(baseline, dict)
        or baseline.get("kind") != "old_skill"
        or not isinstance(baseline.get("digest"), str)
    ):
        raise ManifestError("evolution requires a pinned old_skill baseline")
    state_path = workspace / "evolution-state.json"
    if state_path.exists():
        raise ManifestError("evolution-state.json already exists")
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "transitions").mkdir(exist_ok=False)
    (workspace / ".transition-staging").mkdir(exist_ok=False)
    evolution_id = f"evo-{sha256_json({'authority': authority_digest, 'baseline': baseline.get('digest')})[:20]}"
    initial_authorization = _candidate_authorization(
        plan=plan,
        plan_path=plan_path,
        round_number=1,
        parent_digest=str(baseline["digest"]),
        parent_snapshot=_plan_snapshot_path(plan, "old_skill"),
        continuity="continue",
        continuity_epoch=1,
        training_trace_ids=[],
    )
    state = {
        "contract": EVOLUTION_STATE_CONTRACT,
        "evolution_id": evolution_id,
        "authority_digest": authority_digest,
        "execution_profile_digest": execution_profile_digest,
        "baseline": baseline,
        "initialized_from_plan": str(plan_path.resolve()),
        "control_workspace": str(workspace),
        "max_rounds": 3,
        "current_round": 1,
        "status": "optimizing",
        "next_action": "run_authorized_selection",
        "terminal": False,
        "audit_consumed": False,
        "selected_subject_digest": None,
        "authorized_query": initial_authorization,
        "selection_query_count": 1,
        "audit_query_count": 0,
        "continuity_epoch": 1,
        "candidate_lineage": [initial_authorization],
        "rejected_candidates": [],
        "optimizer_rejected_buffer": [],
        "seen_run_ids": [],
        "history": [],
        "journal_head_digest": None,
    }
    write_json(state_path, state)
    return state


def authorize_evolution(
    *,
    state_path: Path,
    plan_path: Path,
    parent_digest: str | None,
    training_trace_ids: list[str] | None,
    continuity: str,
) -> dict[str, Any]:
    state_path = Path(os.path.abspath(state_path))
    if state_path.is_symlink():
        raise ManifestError("evolution state path must not be a symbolic link")
    state_path = state_path.resolve()
    plan_path = plan_path.resolve()
    state = load_json(state_path)
    plan = load_json(plan_path)
    if state.get("contract") != EVOLUTION_STATE_CONTRACT:
        raise ManifestError(f"evolution state contract must be {EVOLUTION_STATE_CONTRACT}")
    if plan.get("contract") != PLAN_CONTRACT:
        raise ManifestError(f"execution plan contract must be {PLAN_CONTRACT}")
    verify_locked_inputs(plan_path=plan_path, workspace=plan_path.parent, plan=plan)
    _validate_evolution_state(state, plan, state_path, plan_path)
    if state.get("terminal") is True:
        raise ManifestError("evolution is already terminal")
    if state.get("authorized_query") is not None:
        raise ManifestError("the current round already has an authorized evaluation query")
    if state.get("authority_digest") != plan.get("authority", {}).get("digest"):
        raise ManifestError("evolution authority changed; user confirmation requires a new run")
    if state.get("baseline") != plan.get("baseline"):
        raise ManifestError("accepted old_skill baseline changed during evolution")
    if state.get("execution_profile_digest") != plan.get(
        "execution_profile", {}
    ).get("digest"):
        raise ManifestError("execution profile changed during evolution")
    round_number = int(state.get("current_round", 0))
    splits = plan.get("splits")
    trace_ids = _normalize_training_trace_ids(training_trace_ids)
    if state.get("status") == "optimizing":
        if splits != ["selection"]:
            raise ManifestError("optimizing evolution can authorize only selection")
        if parent_digest is None:
            raise ManifestError("selection authorization requires --parent-digest")
        if continuity not in {"continue", "reset"}:
            raise ManifestError("continuity must be continue or reset")
        baseline_digest = _require_string(
            state.get("baseline", {}).get("digest"), "state.baseline.digest"
        )
        if parent_digest != baseline_digest:
            raise ManifestError(
                "selection candidates must branch from the accepted baseline; rejected candidates cannot become parents"
            )
        lineage = state.get("candidate_lineage")
        if not isinstance(lineage, list):
            raise ManifestError("candidate_lineage must be an array")
        if int(state.get("selection_query_count", 0)) >= int(
            state.get("max_rounds", 3)
        ):
            raise ManifestError("selection query budget is exhausted")
        if any(
            isinstance(record, dict) and record.get("run_id") == plan.get("run_id")
            for record in lineage
        ):
            raise ManifestError("selection run is already present in candidate lineage")
        parent_snapshot = _plan_snapshot_path(plan, "old_skill")
        epoch = int(state.get("continuity_epoch", 1))
        authorization = _candidate_authorization(
            plan=plan,
            plan_path=plan_path,
            round_number=round_number,
            parent_digest=parent_digest,
            parent_snapshot=parent_snapshot,
            continuity=continuity,
            continuity_epoch=epoch,
            training_trace_ids=trace_ids,
        )
        topology_changed = bool(
            authorization["change"]["added"]
            or authorization["change"]["removed"]
        )
        if topology_changed and continuity != "reset":
            raise ManifestError(
                "topology-changing candidates require --continuity reset"
            )
        if continuity == "reset":
            epoch += 1
            state["continuity_epoch"] = epoch
            state["optimizer_rejected_buffer"] = []
            authorization["continuity_epoch"] = epoch
        lineage.append(authorization)
        state["candidate_lineage"] = lineage
        state["selection_query_count"] = int(
            state.get("selection_query_count", 0)
        ) + 1
        state["authorized_query"] = authorization
        state["next_action"] = "run_authorized_selection"
    elif state.get("status") == "awaiting-audit":
        if splits != ["audit"]:
            raise ManifestError("awaiting-audit evolution can authorize only audit")
        if parent_digest is not None or trace_ids:
            raise ManifestError("audit query binding cannot carry optimizer lineage")
        if continuity != "continue":
            raise ManifestError("audit query binding cannot reset continuity")
        if int(state.get("audit_query_count", 0)) != 0:
            raise ManifestError("audit query may be bound only once")
        subject_digest = plan.get("subject", {}).get("digest")
        if subject_digest != state.get("selected_subject_digest"):
            raise ManifestError("audit subject is not the accepted selection candidate")
        authorization = _audit_authorization(
            plan=plan, plan_path=plan_path, round_number=round_number
        )
        state["audit_query_count"] = 1
        state["authorized_query"] = authorization
        state["next_action"] = "run_authorized_audit"
    else:
        raise ManifestError("evolution state cannot authorize another query")
    write_json(state_path, state)
    return state


def advance_evolution(*, state_path: Path, decision_path: Path) -> dict[str, Any]:
    state_path = Path(os.path.abspath(state_path))
    if state_path.is_symlink():
        raise ManifestError("evolution state path must not be a symbolic link")
    state_path = state_path.resolve()
    decision_path = decision_path.resolve()
    state = load_json(state_path)
    decision = load_json(decision_path)
    if state.get("contract") != EVOLUTION_STATE_CONTRACT:
        raise ManifestError(f"evolution state contract must be {EVOLUTION_STATE_CONTRACT}")
    plan, _evidence = _validate_bound_decision(decision, decision_path)
    if state.get("authority_digest") != decision.get("authority_digest"):
        raise ManifestError("evolution authority changed; user confirmation requires a new run")
    if state.get("baseline") != decision.get("baseline"):
        raise ManifestError("accepted old_skill baseline changed during evolution")
    if state.get("execution_profile_digest") != plan.get(
        "execution_profile", {}
    ).get("digest"):
        raise ManifestError("execution profile changed during evolution")
    decision_plan_path = Path(
        _require_string(decision.get("plan_path"), "decision.plan_path")
    ).resolve()
    _validate_evolution_state(
        state, plan, state_path, decision_plan_path
    )
    staging_root = Path(
        _require_string(state.get("control_workspace"), "state.control_workspace")
    ) / ".transition-staging"
    for staged in staging_root.iterdir():
        staged.unlink()
    # The journal is the recovery source if a process stopped after appending a
    # transition but before replacing the derived state projection.
    write_json(state_path, state)
    if state.get("terminal") is True:
        raise ManifestError("evolution is already terminal")
    phase = decision.get("phase")
    iteration = decision.get("iteration")
    if phase not in {"selection", "audit"}:
        raise ManifestError("decision phase must be selection or audit")
    if iteration != state.get("current_round"):
        raise ManifestError("decision iteration does not match the current evolution round")
    seen_run_ids = state.get("seen_run_ids")
    if not isinstance(seen_run_ids, list):
        raise ManifestError("evolution seen_run_ids must be an array")
    run_id = _require_string(decision.get("run_id"), "decision.run_id")
    if run_id in seen_run_ids:
        raise ManifestError("the same evaluation run cannot advance evolution twice")
    authorized_query = state.get("authorized_query")
    if (
        not isinstance(authorized_query, dict)
        or authorized_query.get("phase") != phase
        or authorized_query.get("round") != iteration
        or authorized_query.get("run_id") != run_id
        or authorized_query.get("plan_digest") != sha256_file(decision_plan_path)
        or authorized_query.get("plan_path") != str(decision_plan_path)
    ):
        raise ManifestError("decision is not the authorized evaluation query")

    history = state.get("history")
    if not isinstance(history, list):
        raise ManifestError("evolution state history must be an array")
    if not history:
        initialized_plan = load_json(
            Path(
                _require_string(
                    state.get("initialized_from_plan"),
                    "state.initialized_from_plan",
                )
            )
        )
        if initialized_plan.get("run_id") != run_id:
            raise ManifestError(
                "the first evolution decision must use the initialization run"
            )
    history.append(
        {
            "phase": phase,
            "iteration": iteration,
            "run_id": run_id,
            "subject_digest": plan.get("subject", {}).get("digest"),
            "status": decision.get("status"),
            "accepted": decision.get("accepted") is True,
            "decision_path": str(decision_path.resolve()),
            "decision_digest": sha256_file(decision_path),
            "authorization": dict(authorized_query),
        }
    )

    if phase == "selection":
        if state.get("status") != "optimizing":
            raise ManifestError("selection decisions are allowed only while optimizing")
        if decision.get("accepted") is True:
            state.update(
                {
                    "status": "awaiting-audit",
                    "next_action": "prepare_audit",
                    "terminal": False,
                    "selected_subject_digest": plan.get("subject", {}).get("digest"),
                }
            )
        elif int(state.get("current_round", 0)) >= int(state.get("max_rounds", 3)):
            state.update(
                {"status": "exhausted", "next_action": "stop", "terminal": True}
            )
        else:
            state.update(
                {
                    "current_round": int(state["current_round"]) + 1,
                    "status": "optimizing",
                    "next_action": "propose_candidate",
                    "terminal": False,
                }
            )
        if decision.get("accepted") is not True:
            rejected_record = {
                "round": iteration,
                "run_id": run_id,
                "candidate_digest": plan.get("subject", {}).get("digest"),
                "status": decision.get("status"),
                "reason": decision.get("reason"),
                "decision_digest": sha256_file(decision_path),
                "objective_deltas": [
                    {
                        "case_id": objective.get("case_id"),
                        "id": objective.get("id"),
                        "delta": objective.get("delta"),
                    }
                    for objective in decision.get("objectives", [])
                    if isinstance(objective, dict)
                ],
                "continuity_epoch": authorized_query.get("continuity_epoch"),
            }
            rejected_candidates = state.get("rejected_candidates")
            optimizer_buffer = state.get("optimizer_rejected_buffer")
            if not isinstance(rejected_candidates, list) or not isinstance(
                optimizer_buffer, list
            ):
                raise ManifestError("rejected candidate buffers must be arrays")
            state["rejected_candidates"] = [*rejected_candidates, rejected_record]
            state["optimizer_rejected_buffer"] = [*optimizer_buffer, rejected_record]
    else:
        if state.get("status") != "awaiting-audit":
            raise ManifestError("audit is allowed only after a selection candidate is accepted")
        if state.get("audit_consumed") is True:
            raise ManifestError("audit may run only once")
        if plan.get("subject", {}).get("digest") != state.get(
            "selected_subject_digest"
        ):
            raise ManifestError("audit subject is not the accepted selection candidate")
        audit_passed = decision.get("accepted") is True
        state.update(
            {
                "status": "audit-passed" if audit_passed else "audit-failed",
                "next_action": (
                    "request_user_release" if audit_passed else "stop"
                ),
                "terminal": True,
                "audit_consumed": True,
            }
        )
    state["history"] = history
    state["seen_run_ids"] = [*seen_run_ids, run_id]
    state["authorized_query"] = None
    transition_path = _safe_artifact(
        Path(_require_string(state.get("control_workspace"), "state.control_workspace"))
        / "transitions",
        f"{len(history):04d}.json",
    )
    write_json_exclusive(
        transition_path,
        {
            "contract": EVOLUTION_TRANSITION_CONTRACT,
            "sequence": len(history),
            "previous_digest": state.get("journal_head_digest"),
            "record": history[-1],
        },
    )
    state["journal_head_digest"] = sha256_file(transition_path)
    write_json(state_path, state)
    return state


def _load_optional_json(path: Path) -> dict[str, Any] | None:
    return load_json(path) if path.is_file() else None


def _decision_sort_key(decision: dict[str, Any]) -> tuple[int, int]:
    iteration = decision.get("iteration")
    return (
        int(iteration) if isinstance(iteration, int) else 0,
        1 if decision.get("phase") == "audit" else 0,
    )


def _arm_metrics(arm: dict[str, Any]) -> dict[str, float]:
    return {
        key: float(value)
        for key, value in arm.items()
        if key not in RESERVED_ARM_RESULT_FIELDS
        and isinstance(value, (int, float))
        and not isinstance(value, bool)
    }


def _validate_authorization_plan(
    authorization: dict[str, Any],
    *,
    expected_split: str,
    authority_digest: str,
    baseline: dict[str, Any],
    execution_profile_digest: str,
    label: str,
) -> tuple[Path, dict[str, Any]]:
    plan_path = Path(
        _require_string(authorization.get("plan_path"), f"{label}.plan_path")
    )
    if (
        not plan_path.is_absolute()
        or plan_path.is_symlink()
        or not plan_path.is_file()
        or plan_path.resolve() != plan_path
        or plan_path.name != "execution-plan.json"
    ):
        raise ManifestError(f"{label} plan path is not canonical")
    if sha256_file(plan_path) != authorization.get("plan_digest"):
        raise ManifestError(f"{label} plan digest is invalid")
    plan = load_json(plan_path)
    if (
        plan.get("contract") != PLAN_CONTRACT
        or plan.get("splits") != [expected_split]
        or plan.get("run_id") != authorization.get("run_id")
        or plan.get("authority", {}).get("digest") != authority_digest
        or plan.get("baseline") != baseline
        or plan.get("execution_profile", {}).get("digest")
        != execution_profile_digest
    ):
        raise ManifestError(f"{label} plan does not match evolution authority")
    verify_locked_inputs(
        plan_path=plan_path, workspace=plan_path.parent, plan=plan
    )
    return plan_path, plan


def _authorization_binds_exact_plan(
    authorization: dict[str, Any], plan_path: Path
) -> bool:
    canonical_plan_path = plan_path.resolve()
    return (
        authorization.get("plan_path") == str(canonical_plan_path)
        and authorization.get("plan_digest") == sha256_file(canonical_plan_path)
    )


def _validate_candidate_lineage(
    lineage: list[Any],
    *,
    authority_digest: str,
    baseline: dict[str, Any],
    execution_profile_digest: str,
    initialized_run_id: str,
) -> dict[str, dict[str, Any]]:
    if not lineage or len(lineage) > 3:
        raise ManifestError("candidate lineage must contain one to three queries")
    baseline_digest = _require_string(
        baseline.get("digest"), "state.baseline.digest"
    )
    by_run_id: dict[str, dict[str, Any]] = {}
    previous_epoch: int | None = None
    for index, raw_record in enumerate(lineage):
        label = f"candidate_lineage[{index}]"
        if not isinstance(raw_record, dict) or set(raw_record) != CANDIDATE_AUTHORIZATION_FIELDS:
            raise ManifestError(f"{label} contract is invalid")
        record = raw_record
        expected_round = index + 1
        if (
            record.get("phase") != "selection"
            or record.get("round") != expected_round
            or record.get("parent_digest") != baseline_digest
        ):
            raise ManifestError(f"{label} phase, round, or parent is invalid")
        run_id = _require_string(record.get("run_id"), f"{label}.run_id")
        if run_id in by_run_id or (index == 0 and run_id != initialized_run_id):
            raise ManifestError("candidate lineage run sequence is invalid")
        plan_path, candidate_plan = _validate_authorization_plan(
            record,
            expected_split="selection",
            authority_digest=authority_digest,
            baseline=baseline,
            execution_profile_digest=execution_profile_digest,
            label=label,
        )
        subject = candidate_plan.get("subject")
        if not isinstance(subject, dict) or (
            record.get("candidate_digest") != subject.get("digest")
            or record.get("subject_path") != subject.get("path")
        ):
            raise ManifestError(f"{label} candidate identity is invalid")
        change = _candidate_change(
            parent_snapshot=_plan_snapshot_path(candidate_plan, "old_skill"),
            candidate_snapshot=_plan_snapshot_path(candidate_plan, "with_skill"),
        )
        expected_change = {
            "added": change["added"],
            "removed": change["removed"],
            "modified": change["modified"],
        }
        if (
            record.get("change") != expected_change
            or record.get("change_digest") != change["digest"]
        ):
            raise ManifestError(f"{label} change evidence is invalid")
        trace_ids = record.get("training_trace_ids")
        if not isinstance(trace_ids, list) or _normalize_training_trace_ids(trace_ids) != trace_ids:
            raise ManifestError(f"{label} training trace ids are invalid")
        continuity = record.get("continuity")
        epoch = record.get("continuity_epoch")
        if continuity not in {"continue", "reset"} or not isinstance(epoch, int):
            raise ManifestError(f"{label} continuity is invalid")
        if index == 0:
            if continuity != "continue" or epoch != 1:
                raise ManifestError("initial candidate must start continuity epoch 1")
        elif continuity == "reset":
            if epoch != int(previous_epoch) + 1:
                raise ManifestError(f"{label} reset epoch is invalid")
        elif epoch != previous_epoch:
            raise ManifestError(f"{label} continuity epoch is invalid")
        if index > 0 and (change["added"] or change["removed"]) and continuity != "reset":
            raise ManifestError(
                f"{label} topology change is missing a continuity reset"
            )
        previous_epoch = epoch
        by_run_id[run_id] = {"authorization": record, "plan": candidate_plan, "path": plan_path}
    return by_run_id


def _validate_audit_authorization(
    authorization: dict[str, Any],
    *,
    authority_digest: str,
    baseline: dict[str, Any],
    execution_profile_digest: str,
    round_number: int,
    selected_subject_digest: str,
    label: str,
) -> tuple[Path, dict[str, Any]]:
    if set(authorization) != AUDIT_AUTHORIZATION_FIELDS:
        raise ManifestError(f"{label} contract is invalid")
    plan_path, audit_plan = _validate_authorization_plan(
        authorization,
        expected_split="audit",
        authority_digest=authority_digest,
        baseline=baseline,
        execution_profile_digest=execution_profile_digest,
        label=label,
    )
    expected = _audit_authorization(
        plan=audit_plan, plan_path=plan_path, round_number=round_number
    )
    if authorization != expected or authorization.get(
        "candidate_digest"
    ) != selected_subject_digest:
        raise ManifestError(f"{label} is not bound to the selected candidate")
    return plan_path, audit_plan


def _validate_evolution_state(
    state: dict[str, Any],
    plan: dict[str, Any],
    state_path: Path,
    plan_path: Path,
) -> list[tuple[Path, dict[str, Any]]]:
    if state.get("contract") != EVOLUTION_STATE_CONTRACT:
        raise ManifestError(f"evolution state contract must be {EVOLUTION_STATE_CONTRACT}")
    plan_authority = plan.get("authority")
    baseline = plan.get("baseline")
    subject = plan.get("subject")
    if not all(
        isinstance(value, dict)
        for value in (plan_authority, baseline, subject)
    ):
        raise ManifestError("dashboard plan authority, subject, and baseline must be objects")
    authority_digest = _require_string(
        plan_authority.get("digest"), "plan.authority.digest"
    )
    execution_profile_digest = _require_string(
        plan.get("execution_profile", {}).get("digest"),
        "plan.execution_profile.digest",
    )
    control_workspace = Path(
        _require_string(state.get("control_workspace"), "state.control_workspace")
    )
    if not control_workspace.is_absolute():
        raise ManifestError("state.control_workspace must be an absolute path")
    control_workspace = _require_real_directory(
        control_workspace,
        Path(control_workspace.anchor),
        "evolution control workspace",
    )
    canonical_state_path = _safe_artifact(
        control_workspace, "evolution-state.json"
    )
    if state_path.is_symlink() or state_path.resolve() != canonical_state_path:
        raise ManifestError(
            "evolution state must stay at its canonical control workspace path"
        )
    transitions_root = _require_real_directory(
        control_workspace / "transitions",
        control_workspace,
        "evolution transition journal",
    )
    staging_root = _require_real_directory(
        control_workspace / ".transition-staging",
        control_workspace,
        "evolution transition staging",
    )
    if state.get("authority_digest") != authority_digest:
        raise ManifestError("dashboard state authority does not match the current run")
    if state.get("baseline") != baseline:
        raise ManifestError("dashboard state baseline does not match the current run")
    if state.get("execution_profile_digest") != execution_profile_digest:
        raise ManifestError("dashboard state execution profile does not match the current run")
    if state.get("max_rounds") != 3:
        raise ManifestError("dashboard state max_rounds must be 3")
    expected_evolution_id = f"evo-{sha256_json({'authority': authority_digest, 'baseline': baseline.get('digest') if isinstance(baseline, dict) else None})[:20]}"
    if state.get("evolution_id") != expected_evolution_id:
        raise ManifestError("dashboard state evolution id is invalid")

    initialized_plan_path = Path(
        _require_string(
            state.get("initialized_from_plan"), "state.initialized_from_plan"
        )
    )
    if not initialized_plan_path.is_file():
        raise ManifestError("dashboard state initialization plan does not exist")
    initialized_plan = load_json(initialized_plan_path)
    initialized_authority = initialized_plan.get("authority")
    initialized_subject = initialized_plan.get("subject")
    initialized_baseline = initialized_plan.get("baseline")
    initialized_execution_profile = initialized_plan.get("execution_profile")
    if (
        initialized_plan.get("contract") != PLAN_CONTRACT
        or not isinstance(initialized_authority, dict)
        or not isinstance(initialized_subject, dict)
        or not isinstance(initialized_baseline, dict)
        or initialized_authority.get("digest") != authority_digest
        or initialized_baseline != baseline
        or initialized_plan.get("splits") != ["selection"]
        or not isinstance(initialized_execution_profile, dict)
        or initialized_execution_profile.get("digest") != execution_profile_digest
    ):
        raise ManifestError("dashboard state initialization plan does not match")
    protected_roots = [
        Path(_require_string(subject.get("path"), "plan.subject.path")),
        plan_path.resolve().parent,
        Path(_require_string(initialized_subject.get("path"), "initialized subject.path")),
        initialized_plan_path.parent,
    ]
    for baseline_record, label in (
        (baseline, "plan.baseline.path"),
        (initialized_baseline, "initialized baseline.path"),
    ):
        if baseline_record.get("kind") == "old_skill":
            protected_roots.append(
                Path(_require_string(baseline_record.get("path"), label))
            )
    if any(
        _is_within(control_workspace, root)
        or _is_within(root, control_workspace)
        for root in protected_roots
    ):
        raise ManifestError(
            "evolution control workspace overlaps a candidate, baseline, or run workspace"
        )

    state_history = state.get("history")
    seen_run_ids = state.get("seen_run_ids")
    if not isinstance(state_history, list) or not isinstance(seen_run_ids, list):
        raise ManifestError("dashboard state history and seen_run_ids must be arrays")
    if (
        not all(isinstance(run_id, str) and run_id for run_id in seen_run_ids)
        or len(set(seen_run_ids)) != len(seen_run_ids)
    ):
        raise ManifestError("dashboard state contains duplicate run ids")
    candidate_lineage = state.get("candidate_lineage")
    rejected_candidates = state.get("rejected_candidates")
    optimizer_rejected_buffer = state.get("optimizer_rejected_buffer")
    if not all(
        isinstance(value, list)
        for value in (
            candidate_lineage,
            rejected_candidates,
            optimizer_rejected_buffer,
        )
    ):
        raise ManifestError("evolution lineage and rejected buffers must be arrays")
    if (
        state.get("selection_query_count") != len(candidate_lineage)
        or not 1 <= len(candidate_lineage) <= 3
        or state.get("audit_query_count") not in {0, 1}
        or not isinstance(state.get("continuity_epoch"), int)
        or int(state.get("continuity_epoch")) < 1
    ):
        raise ManifestError("evolution query accounting is invalid")
    lineage_by_run_id = _validate_candidate_lineage(
        candidate_lineage,
        authority_digest=authority_digest,
        baseline=baseline,
        execution_profile_digest=execution_profile_digest,
        initialized_run_id=_require_string(
            initialized_plan.get("run_id"), "initialized plan.run_id"
        ),
    )
    lineage_run_ids = list(lineage_by_run_id)
    if state.get("continuity_epoch") != candidate_lineage[-1].get(
        "continuity_epoch"
    ):
        raise ManifestError("evolution continuity epoch does not match lineage")

    staging_files: list[Path] = []
    for staging_path in staging_root.iterdir():
        metadata = staging_path.lstat()
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISREG(metadata.st_mode)
            or not staging_path.name.endswith(".tmp")
        ):
            raise ManifestError("evolution transition staging contains an invalid entry")
        staging_files.append(staging_path)
    journal_paths = list(
        iter_strict_files(
            transitions_root, "evolution journal", allow_hardlinks=True
        )
    )
    actual_names = [
        path.relative_to(transitions_root).as_posix() for path in journal_paths
    ]
    if actual_names != [
        f"{index:04d}.json" for index in range(1, len(journal_paths) + 1)
    ]:
        raise ManifestError("evolution transition journal sequence is invalid")
    journal_history: list[dict[str, Any]] = []
    journal_digests: list[str] = []
    previous_digest: str | None = None
    for index, path in enumerate(journal_paths, start=1):
        metadata = path.lstat()
        if metadata.st_nlink not in {1, 2}:
            raise ManifestError("evolution transition journal link count is invalid")
        if metadata.st_nlink == 2 and not any(
            candidate.lstat().st_dev == metadata.st_dev
            and candidate.lstat().st_ino == metadata.st_ino
            for candidate in staging_files
        ):
            raise ManifestError(
                "evolution transition journal has an unbound hard link"
            )
        if path.stat().st_mode & 0o222:
            raise ManifestError("evolution transition journal must be read-only")
        transition = load_json(path)
        record = transition.get("record")
        if (
            transition.get("contract") != EVOLUTION_TRANSITION_CONTRACT
            or transition.get("sequence") != index
            or transition.get("previous_digest") != previous_digest
            or not isinstance(record, dict)
        ):
            raise ManifestError("evolution transition journal record is invalid")
        journal_history.append(record)
        previous_digest = sha256_file(path)
        journal_digests.append(previous_digest)
    if (
        len(state_history) > len(journal_history)
        or state_history != journal_history[: len(state_history)]
    ):
        raise ManifestError(
            "evolution state history is not a prefix of its transition journal"
        )
    history = journal_history
    state_history_length = len(state_history)

    projection: dict[str, Any] = {
        "current_round": 1,
        "status": "optimizing",
        "next_action": "run_authorized_selection",
        "terminal": False,
        "audit_consumed": False,
        "selected_subject_digest": None,
    }
    validated: list[tuple[Path, dict[str, Any]]] = []
    history_run_ids: list[str] = []
    selection_history_run_ids: list[str] = []
    audit_history_count = 0
    reconstructed_rejected: list[dict[str, Any]] = []
    state_projection = dict(projection) if state_history_length == 0 else None
    rejected_projection: list[dict[str, Any]] | None = (
        [] if state_history_length == 0 else None
    )
    for index, record in enumerate(history):
        decision_path = Path(
            _require_string(
                record.get("decision_path"),
                f"state.history[{index}].decision_path",
            )
        ).resolve()
        if not decision_path.is_file() or sha256_file(decision_path) != record.get(
            "decision_digest"
        ):
            raise ManifestError("dashboard state decision digest is missing or mismatched")
        decision = load_json(decision_path)
        decision_plan, _ = _validate_bound_decision(decision, decision_path)
        decision_plan_path = Path(
            _require_string(decision.get("plan_path"), "decision.plan_path")
        ).resolve()
        run_id = _require_string(decision.get("run_id"), "decision.run_id")
        expected_record = {
            "phase": decision.get("phase"),
            "iteration": decision.get("iteration"),
            "run_id": run_id,
            "subject_digest": decision_plan.get("subject", {}).get("digest"),
            "status": decision.get("status"),
            "accepted": decision.get("accepted") is True,
            "decision_path": str(decision_path),
            "decision_digest": sha256_file(decision_path),
            "authorization": record.get("authorization"),
        }
        if record != expected_record:
            raise ManifestError("dashboard state history does not match its decision")
        authorization = record.get("authorization")
        if not isinstance(authorization, dict):
            raise ManifestError("dashboard history is missing audit query binding")
        if decision.get("phase") == "selection":
            lineage_entry = lineage_by_run_id.get(run_id)
            if (
                lineage_entry is None
                or authorization != lineage_entry["authorization"]
                or decision_plan != lineage_entry["plan"]
                or decision_plan_path != lineage_entry["path"]
            ):
                raise ManifestError(
                    "dashboard selection history is not bound to candidate lineage"
                )
            selection_history_run_ids.append(run_id)
        elif decision.get("phase") == "audit":
            authorized_plan_path, authorized_plan = _validate_audit_authorization(
                authorization,
                authority_digest=authority_digest,
                baseline=baseline,
                execution_profile_digest=execution_profile_digest,
                round_number=int(projection["current_round"]),
                selected_subject_digest=_require_string(
                    projection.get("selected_subject_digest"),
                    "selected subject digest",
                ),
                label=f"state.history[{index}].authorization",
            )
            if (
                decision_plan_path != authorized_plan_path
                or decision_plan != authorized_plan
            ):
                raise ManifestError(
                    "dashboard audit history is not bound to the exact authorized plan"
                )
            audit_history_count += 1
        else:
            raise ManifestError("dashboard history decision phase is invalid")
        if decision.get("authority_digest") != authority_digest:
            raise ManifestError("dashboard history decision changed eval authority")
        if decision.get("baseline") != baseline:
            raise ManifestError("dashboard history decision changed the baseline")
        if decision.get("iteration") != projection["current_round"]:
            raise ManifestError("dashboard history iteration is out of sequence")
        phase = decision.get("phase")
        if phase == "selection":
            if projection["status"] != "optimizing":
                raise ManifestError("dashboard history contains an invalid selection transition")
            if decision.get("accepted") is True:
                projection.update(
                    {
                        "status": "awaiting-audit",
                        "next_action": "prepare_audit",
                        "terminal": False,
                        "selected_subject_digest": decision_plan.get("subject", {}).get(
                            "digest"
                        ),
                    }
                )
            elif projection["current_round"] >= 3:
                projection.update(
                    {"status": "exhausted", "next_action": "stop", "terminal": True}
                )
            else:
                projection["current_round"] += 1
                projection["next_action"] = "propose_candidate"
            if decision.get("accepted") is not True:
                reconstructed_rejected.append(
                    {
                        "round": decision.get("iteration"),
                        "run_id": run_id,
                        "candidate_digest": decision_plan.get("subject", {}).get(
                            "digest"
                        ),
                        "status": decision.get("status"),
                        "reason": decision.get("reason"),
                        "decision_digest": sha256_file(decision_path),
                        "objective_deltas": [
                            {
                                "case_id": objective.get("case_id"),
                                "id": objective.get("id"),
                                "delta": objective.get("delta"),
                            }
                            for objective in decision.get("objectives", [])
                            if isinstance(objective, dict)
                        ],
                        "continuity_epoch": authorization.get("continuity_epoch"),
                    }
                )
        elif phase == "audit":
            if (
                projection["status"] != "awaiting-audit"
                or projection["audit_consumed"] is True
                or decision_plan.get("subject", {}).get("digest")
                != projection["selected_subject_digest"]
            ):
                raise ManifestError("dashboard history contains an invalid audit transition")
            projection.update(
                {
                    "status": "audit-passed"
                    if decision.get("accepted") is True
                    else "audit-failed",
                    "next_action": (
                        "request_user_release"
                        if decision.get("accepted") is True
                        else "stop"
                    ),
                    "terminal": True,
                    "audit_consumed": True,
                }
            )
        else:
            raise ManifestError("dashboard history decision phase is invalid")
        history_run_ids.append(run_id)
        validated.append((decision_path, decision))
        if index + 1 == state_history_length:
            state_projection = dict(projection)
            rejected_projection = list(reconstructed_rejected)

    if history and history_run_ids[0] != initialized_plan.get("run_id"):
        raise ManifestError("dashboard state history does not start from its initialization run")
    if seen_run_ids != history_run_ids[:state_history_length]:
        raise ManifestError("dashboard state seen_run_ids do not match decision history")
    if state_projection is None:
        raise ManifestError("evolution state projection could not be reconstructed")
    active_authorization = state.get("authorized_query")
    if active_authorization is not None and not isinstance(active_authorization, dict):
        raise ManifestError("authorized query must be an object or null")
    consumed_prefix = set(history_run_ids[:state_history_length])
    if isinstance(active_authorization, dict):
        active_run_id = _require_string(
            active_authorization.get("run_id"), "authorized_query.run_id"
        )
        if active_run_id in consumed_prefix:
            raise ManifestError("authorized query has already been consumed")
        active_phase = active_authorization.get("phase")
        if active_phase == "selection" and state_projection["status"] == "optimizing":
            lineage_entry = lineage_by_run_id.get(active_run_id)
            if (
                lineage_entry is None
                or active_authorization != lineage_entry["authorization"]
                or active_authorization.get("round")
                != state_projection["current_round"]
                or not _authorization_binds_exact_plan(
                    active_authorization, plan_path
                )
            ):
                raise ManifestError(
                    "active selection query is not bound to candidate lineage"
                )
            state_projection["next_action"] = "run_authorized_selection"
            if active_run_id not in set(history_run_ids):
                projection["next_action"] = "run_authorized_selection"
        elif (
            active_phase == "audit"
            and state_projection["status"] == "awaiting-audit"
        ):
            _validate_audit_authorization(
                active_authorization,
                authority_digest=authority_digest,
                baseline=baseline,
                execution_profile_digest=execution_profile_digest,
                round_number=int(state_projection["current_round"]),
                selected_subject_digest=_require_string(
                    state_projection.get("selected_subject_digest"),
                    "selected subject digest",
                ),
                label="authorized_query",
            )
            if not _authorization_binds_exact_plan(active_authorization, plan_path):
                raise ManifestError(
                    "active audit query is not bound to the exact authorized plan"
                )
            state_projection["next_action"] = "run_authorized_audit"
            if active_run_id not in set(history_run_ids):
                projection["next_action"] = "run_authorized_audit"
        else:
            raise ManifestError("authorized query does not match evolution state")
    expected_lineage_run_ids = list(selection_history_run_ids)
    if (
        isinstance(active_authorization, dict)
        and active_authorization.get("phase") == "selection"
        and active_authorization.get("run_id") not in expected_lineage_run_ids
    ):
        expected_lineage_run_ids.append(str(active_authorization["run_id"]))
    if lineage_run_ids != expected_lineage_run_ids:
        raise ManifestError("candidate lineage contains an unauthorized branch")
    expected_audit_query_count = int(
        audit_history_count > 0
        or (
            isinstance(active_authorization, dict)
            and active_authorization.get("phase") == "audit"
        )
    )
    if state.get("audit_query_count") != expected_audit_query_count:
        raise ManifestError("audit query accounting is invalid")
    if rejected_projection is None or rejected_candidates != rejected_projection:
        raise ManifestError("rejected candidate history does not match decisions")
    expected_optimizer_buffer = [
        item
        for item in rejected_projection
        if item.get("continuity_epoch") == state.get("continuity_epoch")
    ]
    if optimizer_rejected_buffer != expected_optimizer_buffer:
        raise ManifestError("optimizer rejected buffer does not match its continuity epoch")
    for key, expected in state_projection.items():
        if state.get(key) != expected:
            raise ManifestError(f"dashboard state field is inconsistent: {key}")
    state_head_digest = (
        journal_digests[state_history_length - 1]
        if state_history_length
        else None
    )
    if state.get("journal_head_digest") != state_head_digest:
        raise ManifestError("evolution transition journal head is inconsistent")
    state["history"] = history
    state["seen_run_ids"] = history_run_ids
    state["journal_head_digest"] = journal_digests[-1] if journal_digests else None
    state["rejected_candidates"] = reconstructed_rejected
    current_epoch = int(state.get("continuity_epoch", 1))
    state["optimizer_rejected_buffer"] = [
        item
        for item in reconstructed_rejected
        if item.get("continuity_epoch") == current_epoch
    ]
    if isinstance(state.get("authorized_query"), dict) and state[
        "authorized_query"
    ].get("run_id") in set(history_run_ids):
        state["authorized_query"] = None
    state.update(projection)
    return validated


def _discover_local_decisions(workspace: Path) -> set[Path]:
    decisions: set[Path] = set()
    for entry in workspace.iterdir():
        if not entry.name.startswith("iteration-"):
            continue
        if entry.is_symlink() or not entry.is_dir() or entry.resolve() != entry:
            raise ManifestError(
                f"dashboard iteration path must be a canonical directory: {entry}"
            )
        for artifact in entry.iterdir():
            if not artifact.name.endswith("decision.json"):
                continue
            if (
                artifact.is_symlink()
                or not artifact.is_file()
                or artifact.resolve() != artifact
            ):
                raise ManifestError(
                    f"dashboard decision path must be a canonical file: {artifact}"
                )
            decisions.add(artifact)
    return decisions


def _dashboard_evidence_fields(
    *,
    workspace: Path,
    node_id: str,
    relative_path: str,
    visible: bool,
) -> dict[str, Any]:
    """Bind a dashboard node to one bounded UTF-8 source artifact.

    Opaque holdout content deliberately stays unavailable to the dashboard so
    the evolution loop cannot learn the hidden prompt or its expected output.
    The server later resolves only these registered, digest-bound routes.
    """

    if not visible:
        return {"content_unavailable_reason": "opaque"}
    if Path(relative_path).is_absolute():
        return {}
    artifact_path = _safe_artifact(workspace, relative_path)
    if not artifact_path.is_file():
        return {}
    size = artifact_path.stat().st_size
    if size > DASHBOARD_EVIDENCE_SOURCE_LIMIT_BYTES:
        return {
            "content_size": size,
            "content_unavailable_reason": "too_large",
        }
    raw = artifact_path.read_bytes()
    if len(raw) != size:
        raise ManifestError("dashboard evidence source changed while projecting")
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        return {
            "content_size": size,
            "content_unavailable_reason": "binary",
        }
    route_id = hashlib.sha256(node_id.encode("utf-8")).hexdigest()[:24]
    return {
        "content_url": f"/dashboard-evidence/{route_id}.json",
        "content_digest": hashlib.sha256(raw).hexdigest(),
        "content_size": size,
    }


def _dashboard_action_center(
    *,
    state: dict[str, Any] | None,
    decisions: list[dict[str, Any]],
    case_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Project a control-plane handoff without granting mutation authority."""
    selection_decision = next(
        (
            decision
            for decision in reversed(decisions)
            if decision.get("phase") == "selection"
        ),
        None,
    )
    decision_status = (
        str(selection_decision.get("status"))
        if isinstance(selection_decision, dict)
        else "pending"
    )
    hard_gates = (
        [
            gate
            for gate in selection_decision.get("hard_gates", [])
            if isinstance(gate, dict)
        ]
        if isinstance(selection_decision, dict)
        else []
    )
    objectives = (
        [
            objective
            for objective in selection_decision.get("objectives", [])
            if isinstance(objective, dict)
        ]
        if isinstance(selection_decision, dict)
        else []
    )
    primary_objectives = [
        objective for objective in objectives if objective.get("primary") is not False
    ]
    hard_gates_passed = sum(gate.get("passed") is True for gate in hard_gates)
    non_regressed = sum(
        objective.get("non_regressed") is True for objective in objectives
    )
    materially_improved = sum(
        objective.get("materially_improved") is True
        for objective in primary_objectives
    )

    def criterion_status(*, passed: bool | None, total: int) -> str:
        if passed is None or total == 0:
            return "pending"
        return "satisfied" if passed else "failed"

    acceptance = {
        "status": decision_status,
        "accepted": selection_decision.get("accepted")
        if isinstance(selection_decision, dict)
        else None,
        "decision_run_id": selection_decision.get("run_id")
        if isinstance(selection_decision, dict)
        else None,
        "criteria": [
            {
                "id": "hard_gates",
                "status": criterion_status(
                    passed=selection_decision.get("hard_gates_passed")
                    if isinstance(selection_decision, dict)
                    else None,
                    total=len(hard_gates),
                ),
                "passed": hard_gates_passed,
                "total": len(hard_gates),
                "evidence_ids": [
                    f"gate:{gate.get('id')}" for gate in hard_gates
                ],
            },
            {
                "id": "pareto",
                "status": criterion_status(
                    passed=selection_decision.get("pareto_admissible")
                    if isinstance(selection_decision, dict)
                    else None,
                    total=len(objectives),
                ),
                "passed": non_regressed,
                "total": len(objectives),
                "evidence_ids": [
                    f"case:{objective.get('case_id')}" for objective in objectives
                ],
            },
            {
                "id": "material_improvement",
                "status": criterion_status(
                    passed=selection_decision.get("material_improvement")
                    if isinstance(selection_decision, dict)
                    else None,
                    total=len(primary_objectives),
                ),
                "passed": materially_improved,
                "total": len(primary_objectives),
                "evidence_ids": [
                    f"case:{objective.get('case_id')}"
                    for objective in primary_objectives
                ],
            },
        ],
    }

    next_action = str(state.get("next_action")) if state else "review_evidence"
    signals: dict[str, list[str]] = {
        "skill": [],
        "eval": [],
        "execution_environment": [],
        "evidence": [],
        "human": [],
    }
    evidence_ids: dict[str, set[str]] = {key: set() for key in signals}
    for case in case_rows:
        case_id = str(case.get("id"))
        candidate = next(
            (
                arm
                for arm in case.get("arms", [])
                if isinstance(arm, dict) and arm.get("id") == "with_skill"
            ),
            None,
        )
        arms = [arm for arm in case.get("arms", []) if isinstance(arm, dict)]
        if any(arm.get("binding_errors") for arm in arms):
            signals["execution_environment"].append("binding_error")
            evidence_ids["execution_environment"].add(f"case:{case_id}")
        if not isinstance(candidate, dict) or candidate.get("complete") is not True:
            signals["evidence"].append("candidate_evidence_incomplete")
            evidence_ids["evidence"].add(f"case:{case_id}")
        elif candidate.get("passed") is not True:
            signals["skill"].append("required_assertion_failed")
            evidence_ids["skill"].add(f"case:{case_id}")
        if isinstance(candidate, dict) and (
            candidate.get("forbidden_actions") or candidate.get("side_effects")
        ):
            signals["skill"].append("unsafe_behavior_observed")
            evidence_ids["skill"].add(f"case:{case_id}")
        if case.get("regressed") is True:
            signals["skill"].append("objective_regressed")
            evidence_ids["skill"].add(f"case:{case_id}")
        if case.get("direction_disagreement") is True:
            signals["skill"].append("stochastic_direction_disagreement")
            evidence_ids["skill"].add(f"case:{case_id}")
        if case.get("missing_objective_metrics"):
            signals["eval"].append("objective_metric_unavailable")
            evidence_ids["eval"].add(f"case:{case_id}")
        for arm in arms:
            if arm.get("id") != "with_skill" and arm.get("complete") is not True:
                signals["evidence"].append("baseline_evidence_incomplete")
                evidence_ids["evidence"].add(f"case:{case_id}")

    if isinstance(selection_decision, dict):
        if selection_decision.get("pareto_admissible") is False and objectives:
            signals["skill"].append("pareto_regression")
            evidence_ids["skill"].update(
                f"case:{objective.get('case_id')}" for objective in objectives
            )
        if (
            selection_decision.get("material_improvement") is False
            and primary_objectives
        ):
            signals["skill"].append("material_improvement_missing")
            evidence_ids["skill"].update(
                f"case:{objective.get('case_id')}"
                for objective in primary_objectives
            )
        if not objectives:
            signals["eval"].append("objective_evidence_missing")
        for gate in hard_gates:
            if gate.get("passed") is True:
                continue
            gate_id = str(gate.get("id"))
            if gate_id.endswith(":metric-present"):
                signals["eval"].append("declared_metric_missing")
                evidence_ids["eval"].add(f"gate:{gate_id}")
            elif ":paired-" in gate_id or gate_id.endswith(":evidence-present"):
                signals["evidence"].append("paired_evidence_missing")
                evidence_ids["evidence"].add(f"gate:{gate_id}")

    if next_action == "request_user_release":
        signals["human"].append("release_confirmation_required")

    for category in signals:
        signals[category] = sorted(set(signals[category]))

    if signals["human"]:
        primary_attribution: str | None = "human"
    elif signals["execution_environment"]:
        primary_attribution = "execution_environment"
    elif signals["evidence"]:
        primary_attribution = "evidence"
    elif signals["skill"]:
        primary_attribution = "skill"
    elif signals["eval"]:
        primary_attribution = "eval"
    else:
        primary_attribution = None

    attribution_items = []
    for category in ("skill", "eval", "execution_environment", "evidence", "human"):
        if category == primary_attribution:
            status = "waiting" if category == "human" else "primary"
        elif signals[category]:
            status = "contributing"
        else:
            status = "clear"
        attribution_items.append(
            {
                "id": category,
                "status": status,
                "signals": signals[category],
                "evidence_ids": sorted(evidence_ids[category]),
            }
        )

    failed_evidence_ids = sorted(
        {
            evidence_id
            for category_ids in evidence_ids.values()
            for evidence_id in category_ids
        }
    )
    acceptance_evidence_ids = sorted(
        {
            evidence_id
            for criterion in acceptance["criteria"]
            for evidence_id in criterion["evidence_ids"]
        }
    )
    action_requirements = {
        "generate_candidate": next_action == "propose_candidate",
        "prepare_audit": next_action == "prepare_audit",
        "rerun_execution": next_action
        in {"run_authorized_selection", "run_authorized_audit"},
        "propose_eval_change": bool(signals["eval"])
        and decision_status in {"rejected", "inconclusive", "no-change"},
        "request_release_confirmation": next_action == "request_user_release",
    }
    recommended_action = {
        "propose_candidate": "generate_candidate",
        "prepare_audit": "prepare_audit",
        "run_authorized_selection": "rerun_execution",
        "run_authorized_audit": "rerun_execution",
        "request_user_release": "request_release_confirmation",
    }.get(next_action)
    if primary_attribution == "eval" and action_requirements["propose_eval_change"]:
        recommended_action = "propose_eval_change"

    automatic_action_ids = {
        "generate_candidate",
        "prepare_audit",
        "rerun_execution",
    }
    requestable_action_ids = {
        "propose_eval_change",
        "request_release_confirmation",
    }

    actions = []
    for action_id in (
        "generate_candidate",
        "prepare_audit",
        "rerun_execution",
        "propose_eval_change",
        "request_release_confirmation",
    ):
        actions.append(
            {
                "id": action_id,
                "available": action_requirements[action_id],
                "recommended": action_id == recommended_action,
                "owner": "lead_agent",
                "execution_mode": (
                    "automatic" if action_id in automatic_action_ids else "request"
                ),
                "requestable": action_id in requestable_action_ids,
                "human_confirmation_required": action_id
                in {
                    "propose_eval_change",
                    "request_release_confirmation",
                },
                "evidence_ids": acceptance_evidence_ids
                if action_id in {"prepare_audit", "request_release_confirmation"}
                else failed_evidence_ids,
            }
        )

    if recommended_action == "propose_eval_change":
        continuation = {
            "mode": "human_required",
            "owner": "human",
            "reason": "eval_change_confirmation",
        }
    elif next_action == "request_user_release":
        continuation = {
            "mode": "human_required",
            "owner": "human",
            "reason": "release_confirmation",
        }
    elif next_action == "review_evidence":
        continuation = {
            "mode": "human_required",
            "owner": "human",
            "reason": "evidence_review",
        }
    elif next_action == "stop":
        continuation = {
            "mode": "stopped",
            "owner": "lead_agent",
            "reason": "terminal_state",
        }
    else:
        continuation = {
            "mode": "automatic",
            "owner": "lead_agent",
            "reason": "within_locked_authority",
        }

    return {
        "next_action": next_action,
        "owner": "lead_agent",
        "continuation": continuation,
        "acceptance": acceptance,
        "attribution": {
            "primary": primary_attribution,
            "items": attribution_items,
        },
        "actions": actions,
        "task_gateway": {
            "request_endpoint": "/dashboard-action-requests",
            "audit_endpoint": "/dashboard-action-requests.json",
            "evidence_mutation": False,
            "eval_mutation": False,
            "handoff_mode": "durable_local_ledger",
            "can_wake_agent_session": False,
            "persists_after_agent_session_end": True,
        },
    }


_DASHBOARD_PASS_STATUSES = {
    "accepted",
    "audit-passed",
    "behavior-verified",
    "passed",
    "regression-verified",
    "retained",
}


def _dashboard_status_passed(status: object) -> bool:
    return str(status).lower() in _DASHBOARD_PASS_STATUSES


def _dashboard_case_id_for_gate(
    gate_label: object, case_ids: list[str]
) -> str | None:
    label = str(gate_label)
    matches = [
        case_id
        for case_id in case_ids
        if label == case_id or label.startswith(f"{case_id}:")
    ]
    return max(matches, key=len) if matches else None


def _dashboard_order_spine(
    spine: list[dict[str, Any]], case_rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Project the evidence index into a stable, parent-before-child audit tree.

    The spine remains a lossless evidence index. This function only fixes its
    structural semantics: case-scoped gates belong to their scenario, and the
    serialized order must never be used as a substitute for the parent graph.
    """

    case_ids = [str(row.get("id")) for row in case_rows]
    for node in spine:
        if node.get("kind") != "gate":
            continue
        declared_case_id = node.get("case_id")
        case_id = (
            str(declared_case_id)
            if declared_case_id in case_ids
            else _dashboard_case_id_for_gate(node.get("label"), case_ids)
        )
        if case_id is not None:
            node["case_id"] = case_id
            node["parent_id"] = f"case:{case_id}"

    nodes_by_parent: dict[str | None, list[tuple[int, dict[str, Any]]]] = {}
    for index, node in enumerate(spine):
        parent_id = node.get("parent_id")
        nodes_by_parent.setdefault(
            str(parent_id) if parent_id is not None else None, []
        ).append((index, node))

    kind_priority = {
        "run": 0,
        "case": 1,
        "gate": 2,
        "assertion": 3,
        "artifact": 4,
        "iteration": 5,
    }
    arm_priority = {"with_skill": 0, "old_skill": 1, "without_skill": 2}

    def order_key(
        item: tuple[int, dict[str, Any]]
    ) -> tuple[int, int, int, int, int]:
        index, node = item
        kind = str(node.get("kind"))
        arm = node.get("arm")
        failed_first = 0 if not _dashboard_status_passed(node.get("status")) else 1
        if kind in {"assertion", "artifact"} and isinstance(arm, str):
            # Keep the candidate and every baseline in contiguous visual lanes.
            # The browser can then introduce one explicit arm boundary instead
            # of presenting paired evidence as a duplicated flat list.
            return (
                3,
                arm_priority.get(arm, 90),
                0 if kind == "assertion" else 1,
                failed_first,
                index,
            )
        return (kind_priority.get(kind, 99), 99, 0, failed_first, index)

    ordered: list[dict[str, Any]] = []
    visited: set[str] = set()

    def visit(node: dict[str, Any]) -> None:
        node_id = str(node.get("id"))
        if node_id in visited:
            return
        visited.add(node_id)
        ordered.append(node)
        for _index, child in sorted(nodes_by_parent.get(node_id, []), key=order_key):
            visit(child)

    for _index, root in sorted(nodes_by_parent.get(None, []), key=order_key):
        visit(root)
    # Invalid or orphaned nodes stay visible for audit instead of disappearing.
    for _index, node in sorted(enumerate(spine), key=order_key):
        visit(node)
    return ordered


def _dashboard_review_outline(
    *,
    spine: list[dict[str, Any]],
    case_rows: list[dict[str, Any]],
    release_eligible: bool,
    action_center: dict[str, Any],
) -> dict[str, Any]:
    """Build the human review interface; the browser must not infer decisions.

    The immutable spine answers "what evidence exists". The review outline
    answers the different product question "what should a reviewer decide and
    in what order should they inspect the evidence".
    """

    nodes_by_id = {str(node.get("id")): node for node in spine}
    nodes_by_parent: dict[str, list[dict[str, Any]]] = {}
    for node in spine:
        parent_id = node.get("parent_id")
        if parent_id is not None:
            nodes_by_parent.setdefault(str(parent_id), []).append(node)
    scenario_rows: list[dict[str, Any]] = []
    blockers: list[dict[str, Any]] = []
    passed_gate_ids: list[str] = []
    passed_case_ids: list[str] = []
    scoped_gate_ids: set[str] = set()
    attribution = action_center.get("attribution", {})
    primary_attribution = (
        attribution.get("primary") if isinstance(attribution, dict) else None
    )
    next_action = action_center.get("next_action")
    acceptance = action_center.get("acceptance", {})
    acceptance_criteria = (
        acceptance.get("criteria", []) if isinstance(acceptance, dict) else []
    )
    failed_acceptance_criteria = [
        criterion
        for criterion in acceptance_criteria
        if isinstance(criterion, dict) and criterion.get("status") == "failed"
    ]

    for case in case_rows:
        case_id = str(case.get("id"))
        case_node_id = f"case:{case_id}"
        children = nodes_by_parent.get(case_node_id, [])
        gate_ids = [
            str(node.get("id")) for node in children if node.get("kind") == "gate"
        ]
        scoped_gate_ids.update(gate_ids)
        check_ids = [
            str(node.get("id"))
            for node in children
            if node.get("kind") == "assertion"
        ]
        artifact_ids = [
            str(node.get("id"))
            for node in children
            if node.get("kind") == "artifact"
        ]
        failed_gate_ids = [
            node_id
            for node_id in gate_ids
            if not _dashboard_status_passed(nodes_by_id[node_id].get("status"))
        ]
        failed_check_ids = [
            node_id
            for node_id in check_ids
            if not _dashboard_status_passed(nodes_by_id[node_id].get("status"))
            and nodes_by_id[node_id].get("arm") in {None, "with_skill"}
        ]
        missing_artifact_ids = [
            node_id
            for node_id in artifact_ids
            if str(nodes_by_id[node_id].get("status")).lower() == "missing"
            and nodes_by_id[node_id].get("arm") in {None, "with_skill"}
        ]
        failed_paths = {
            str(nodes_by_id[node_id].get("path"))
            for node_id in failed_check_ids
            if nodes_by_id[node_id].get("path")
        }
        source_evidence_ids = [
            node_id
            for node_id in artifact_ids
            if nodes_by_id[node_id].get("path") in failed_paths
            and str(nodes_by_id[node_id].get("status")).lower() != "missing"
        ]
        scenario_rows.append(
            {
                "case_id": case_id,
                "status": case.get("status"),
                "gate_ids": gate_ids,
                "check_ids": check_ids,
                "artifact_ids": artifact_ids,
            }
        )
        blocking = (
            not _dashboard_status_passed(case.get("status"))
            or bool(failed_gate_ids)
            or bool(failed_check_ids)
            or bool(missing_artifact_ids)
        )
        if blocking:
            blockers.append(
                {
                    "id": f"blocker:{case_id}",
                    "kind": "scenario",
                    "case_id": case_id,
                    "status": "failed"
                    if failed_gate_ids or failed_check_ids or missing_artifact_ids
                    else case.get("status"),
                    "gate_ids": failed_gate_ids,
                    "failed_check_ids": failed_check_ids,
                    "missing_artifact_ids": missing_artifact_ids,
                    "source_evidence_ids": source_evidence_ids,
                    "criterion_ids": [],
                    "evidence_ids": [
                        case_node_id,
                        *failed_gate_ids,
                        *failed_check_ids,
                        *missing_artifact_ids,
                        *source_evidence_ids,
                    ],
                    "attribution": primary_attribution,
                    "next_action": next_action,
                }
            )
        else:
            passed_case_ids.append(case_node_id)
        passed_gate_ids.extend(
            node_id
            for node_id in gate_ids
            if _dashboard_status_passed(nodes_by_id[node_id].get("status"))
        )

    unscoped_failed_gates = [
        node
        for node in spine
        if node.get("kind") == "gate"
        and str(node.get("id")) not in scoped_gate_ids
        and not _dashboard_status_passed(node.get("status"))
    ]
    for gate in unscoped_failed_gates:
        gate_id = str(gate.get("id"))
        blockers.append(
            {
                "id": f"blocker:{gate_id}",
                "kind": "criterion",
                "case_id": None,
                "status": gate.get("status"),
                "gate_ids": [gate_id],
                "failed_check_ids": [],
                "missing_artifact_ids": [],
                "source_evidence_ids": [],
                "criterion_ids": ["hard_gates"],
                "evidence_ids": [gate_id],
                "attribution": primary_attribution,
                "next_action": next_action,
            }
        )

    represented_hard_gate = any(blocker["gate_ids"] for blocker in blockers)
    for criterion in failed_acceptance_criteria:
        criterion_id = str(criterion.get("id"))
        if criterion_id == "hard_gates" and represented_hard_gate:
            continue
        evidence_ids = [
            str(node_id)
            for node_id in criterion.get("evidence_ids", [])
            if str(node_id) in nodes_by_id
        ]
        blockers.append(
            {
                "id": f"blocker:criterion:{criterion_id}",
                "kind": "criterion",
                "case_id": None,
                "status": "failed",
                "gate_ids": [],
                "failed_check_ids": [],
                "missing_artifact_ids": [],
                "source_evidence_ids": [],
                "criterion_ids": [criterion_id],
                "evidence_ids": evidence_ids,
                "attribution": primary_attribution,
                "next_action": next_action,
            }
        )

    scenario_blockers = [
        blocker for blocker in blockers if blocker.get("kind") == "scenario"
    ]
    criterion_blockers = [
        blocker for blocker in blockers if blocker.get("kind") == "criterion"
    ]

    if release_eligible:
        decision_status = "ready"
        decision_reason = "release_conditions_met"
    elif any(blocker["gate_ids"] for blocker in blockers):
        decision_status = "blocked"
        decision_reason = "release_gate_failed"
    elif scenario_blockers:
        decision_status = "blocked"
        decision_reason = "scenario_failed"
    elif criterion_blockers:
        decision_status = "blocked"
        decision_reason = "candidate_acceptance_failed"
    elif next_action in {"prepare_audit", "run_authorized_audit"}:
        decision_status = "inconclusive"
        decision_reason = "audit_required"
    else:
        decision_status = "inconclusive"
        decision_reason = "evidence_incomplete"

    return {
        "contract": "skill-reviewer.dashboard-review",
        "decision": {
            "status": decision_status,
            "reason": decision_reason,
            "release_eligible": release_eligible,
            "blocking_scenario_count": sum(
                blocker.get("case_id") is not None
                for blocker in scenario_blockers
            ),
            "blocking_gate_count": sum(
                len(blocker.get("gate_ids", [])) for blocker in blockers
            ),
        },
        "blockers": blockers,
        "safeguards": {
            "passed_gate_ids": passed_gate_ids,
            "passed_case_ids": passed_case_ids,
        },
        "scenarios": scenario_rows,
        "next_action": next_action,
        "attribution": primary_attribution,
    }


def _dashboard_release_eligible(decision: dict[str, Any] | None) -> bool:
    """Derive release readiness only from a validated audit acceptance decision."""

    return bool(
        isinstance(decision, dict)
        and decision.get("phase") == "audit"
        and decision.get("status") == "accepted"
        and decision.get("accepted") is True
        and decision.get("release_eligible") is True
    )


def project_dashboard(
    *, workspace: Path, output: Path, state_path: Path | None = None
) -> dict[str, Any]:
    workspace = workspace.resolve()
    output = output.resolve()
    if output != workspace / "dashboard-data.json":
        raise ManifestError(
            "dashboard output must be the run workspace dashboard-data.json"
        )
    plan_path = workspace / "execution-plan.json"
    plan = load_json(plan_path)
    if plan.get("contract") != PLAN_CONTRACT:
        raise ManifestError(f"execution plan contract must be {PLAN_CONTRACT}")
    projected_integrity = verify_locked_inputs(
        plan_path=plan_path, workspace=workspace, plan=plan
    )
    evidence_path = workspace / "verification-evidence.json"
    local_decision_paths = _discover_local_decisions(workspace)
    has_execution_artifacts = any(workspace.glob("cases/**/execution.json"))
    evidence = (
        grade_run(plan_path=plan_path, workspace=workspace, persist=False)
        if evidence_path.is_file() or local_decision_paths or has_execution_artifacts
        else None
    )
    raw_state_path = Path(
        os.path.abspath(
            state_path
            if state_path is not None
            else workspace / "evolution-state.json"
        )
    )
    if raw_state_path.is_symlink():
        raise ManifestError("dashboard evolution state path must not be a symbolic link")
    resolved_state_path = raw_state_path.resolve()
    if state_path is not None and not resolved_state_path.is_file():
        raise ManifestError("explicit dashboard evolution state does not exist")
    state = _load_optional_json(resolved_state_path)
    state_decisions = (
        _validate_evolution_state(
            state, plan, resolved_state_path, plan_path
        )
        if state
        else []
    )
    if state is not None:
        initialized_plan = load_json(
            Path(
                _require_string(
                    state.get("initialized_from_plan"),
                    "state.initialized_from_plan",
                )
            )
        )
        seen_run_ids = state.get("seen_run_ids", [])
        active_query = state.get("authorized_query")
        current_state_run_id = (
            active_query.get("run_id")
            if isinstance(active_query, dict)
            else seen_run_ids[-1]
            if seen_run_ids
            else initialized_plan.get("run_id")
        )
        if plan.get("run_id") != current_state_run_id:
            raise ManifestError(
                "dashboard state does not identify the current run"
            )
        state_history = state.get("history", [])
        current_authorization = (
            active_query
            if isinstance(active_query, dict)
            else state_history[-1].get("authorization")
            if state_history and isinstance(state_history[-1], dict)
            else None
        )
        if (
            not isinstance(current_authorization, dict)
            or not _authorization_binds_exact_plan(current_authorization, plan_path)
        ):
            raise ManifestError(
                "dashboard state is not bound to the exact authorized plan"
            )
    decisions: list[dict[str, Any]] = []
    decision_paths = set(local_decision_paths)
    decision_paths.update(path for path, _ in state_decisions)
    for decision_path in sorted(decision_paths):
        decision = load_json(decision_path)
        _validate_bound_decision(decision, decision_path)
        if _is_within(decision_path, workspace) and decision.get("run_id") != plan.get(
            "run_id"
        ):
            raise ManifestError("workspace decision does not belong to the current run")
        decisions.append(
            {
                **decision,
                "artifact": str(decision_path.relative_to(workspace))
                if _is_within(decision_path, workspace)
                else str(decision_path),
            }
        )
    decisions.sort(key=_decision_sort_key)
    current_decisions = [
        decision
        for decision in decisions
        if decision.get("run_id") == plan.get("run_id")
    ]
    latest_decision = current_decisions[-1] if current_decisions else None
    evidence_cases = {
        str(item.get("id")): item
        for item in (evidence or {}).get("cases", [])
        if isinstance(item, dict)
    }
    planned_case_ids = [
        str(item.get("id"))
        for item in plan.get("cases", [])
        if isinstance(item, dict)
    ]

    spine: list[dict[str, Any]] = [
        {
            "id": f"run:{plan.get('run_id')}",
            "kind": "run",
            "parent_id": None,
            "label": str(plan.get("run_id")),
            "status": (
                state.get("status")
                if state
                else latest_decision.get("status")
                if latest_decision
                else (evidence or {}).get("level", "planned")
            ),
        }
    ]
    if latest_decision:
        for gate in latest_decision.get("hard_gates", []):
            if not isinstance(gate, dict):
                continue
            gate_id = str(gate.get("id"))
            gate_case_id = _dashboard_case_id_for_gate(
                gate_id, planned_case_ids
            )
            spine.append(
                {
                    "id": f"gate:{gate_id}",
                    "kind": "gate",
                    "parent_id": f"case:{gate_case_id}"
                    if gate_case_id is not None
                    else f"run:{plan.get('run_id')}",
                    "case_id": gate_case_id,
                    "label": gate_id,
                    "status": "passed" if gate.get("passed") is True else "failed",
                    "detail": gate.get("reason"),
                }
            )
    elif evidence and isinstance(evidence.get("integrity"), dict):
        spine.append(
            {
                "id": "gate:integrity",
                "kind": "gate",
                "parent_id": f"run:{plan.get('run_id')}",
                "label": "Frozen inputs",
                "status": "passed"
                if evidence["integrity"].get("verified") is True
                else "failed",
            }
        )
    for decision in decisions:
        decision_run_id = str(decision.get("run_id"))
        decision_node_id = (
            f"iteration:{decision_run_id}:{decision.get('iteration')}:{decision.get('phase')}"
        )
        decision_artifact = decision.get("artifact")
        decision_node = {
                "id": decision_node_id,
                "kind": "iteration",
                "parent_id": f"run:{plan.get('run_id')}",
                "label": f"Round {decision.get('iteration')} · {decision.get('phase')} · {decision_run_id[-8:]}",
                "status": decision.get("status"),
                "artifact": decision_artifact,
                "path": decision_artifact,
            }
        if isinstance(decision_artifact, str):
            decision_node.update(
                _dashboard_evidence_fields(
                    workspace=workspace,
                    node_id=decision_node_id,
                    relative_path=decision_artifact,
                    visible=True,
                )
            )
        spine.append(decision_node)

    case_rows: list[dict[str, Any]] = []
    for planned_case in plan.get("cases", []):
        case_id = str(planned_case.get("id"))
        holdout_visibility = planned_case.get("holdout", {}).get(
            "visibility", "public"
        )
        content_visible = holdout_visibility == "public"
        declared_assertions = {
            str(assertion.get("id")): assertion
            for assertion in planned_case.get("assertions", [])
            if isinstance(assertion, dict)
        }
        result = evidence_cases.get(case_id, {})
        candidate = result.get("with_skill")
        semantic_assertions = result.get("semantic_assertions", [])
        semantic_blocked = any(
            isinstance(assertion, dict) and assertion.get("passed") is not True
            for assertion in semantic_assertions
        ) if isinstance(semantic_assertions, list) else True
        paired_blocked = any(
            not isinstance(result.get(str(arm_id)), dict)
            or result[str(arm_id)].get("complete") is not True
            or bool(result[str(arm_id)].get("forbidden_actions"))
            or bool(result[str(arm_id)].get("side_effects"))
            or bool(result[str(arm_id)].get("binding_errors"))
            for arm_id in planned_case.get("arms", [])
            if arm_id != "with_skill"
        )
        if not isinstance(candidate, dict):
            case_status = "pending"
        elif candidate.get("complete") is not True:
            case_status = "incomplete"
        elif (
            candidate.get("passed") is not True
            or result.get("regressed") is True
            or result.get("direction_disagreement") is True
            or bool(result.get("missing_objective_metrics"))
            or semantic_blocked
            or paired_blocked
        ):
            case_status = "failed"
        else:
            case_status = "passed"
        case_node_id = f"case:{case_id}"
        spine.append(
            {
                "id": case_node_id,
                "kind": "case",
                "parent_id": f"run:{plan.get('run_id')}",
                "label": case_id,
                "status": case_status,
                "split": planned_case.get("split"),
            }
        )
        arms: list[dict[str, Any]] = []
        for arm_id in planned_case.get("arms", []):
            raw_arm = result.get(str(arm_id))
            arm = raw_arm if isinstance(raw_arm, dict) else {}
            assertion_count = 0
            passed_assertions = 0
            execution_rows: list[dict[str, Any]] = []
            artifact_paths: set[str] = set(
                str(value) for value in arm.get("artifacts", []) if isinstance(value, str)
            )
            for repeat in arm.get("repeats", []):
                if not isinstance(repeat, dict):
                    continue
                repeat_number = repeat.get("repeat")
                repeat_assertions = [
                    assertion
                    for assertion in repeat.get("assertions", [])
                    if isinstance(assertion, dict)
                ]
                raw_trace = repeat.get("trace")
                trace_events = (
                    raw_trace.get("events", [])
                    if isinstance(raw_trace, dict)
                    and isinstance(raw_trace.get("events"), list)
                    else []
                )
                projected_trace = None
                if isinstance(raw_trace, dict):
                    projected_trace = {
                        key: raw_trace.get(key)
                        for key in (
                            "artifact",
                            "digest",
                            "capture_source",
                            "complete",
                            "valid",
                            "event_count",
                            "started_at",
                            "finished_at",
                            "duration_ms",
                        )
                    }
                    projected_trace["events"] = [
                        event
                        if content_visible
                        else {
                            "contract": event.get("contract"),
                            "event_id": event.get("event_id"),
                            "run_id": event.get("run_id"),
                            "case_id": event.get("case_id"),
                            "arm": event.get("arm"),
                            "repeat": event.get("repeat"),
                            "sequence": event.get("sequence"),
                            "occurred_at": event.get("occurred_at"),
                            "elapsed_ms": event.get("elapsed_ms"),
                            "kind": event.get("kind"),
                            "status": event.get("status"),
                            "summary": "Opaque holdout event retained; content is hidden.",
                            "details": {},
                            "artifact_refs": [],
                        }
                        for event in trace_events
                        if isinstance(event, dict)
                    ]
                raw_dispatch = repeat.get("dispatch")
                projected_dispatch = (
                    {
                        key: raw_dispatch.get(key)
                        for key in (
                            "artifact",
                            "digest",
                            "valid",
                            "provider",
                            "harness",
                            "observation",
                            "dispatch_id",
                            "worker_id",
                            "batch_id",
                            "dispatched_at",
                        )
                    }
                    if isinstance(raw_dispatch, dict)
                    else None
                )
                raw_source_trace = repeat.get("source_trace")
                projected_source_trace = (
                    {
                        key: raw_source_trace.get(key)
                        for key in (
                            "artifact",
                            "digest",
                            "valid",
                            "source_stream_digest",
                            "source_event_count",
                            "retained_event_count",
                            "redaction",
                        )
                    }
                    if isinstance(raw_source_trace, dict)
                    else None
                )
                execution_rows.append(
                    {
                        "repeat": repeat_number,
                        "status": repeat.get("status"),
                        "binding_error_count": len(
                            repeat.get("binding_errors", [])
                            if isinstance(repeat.get("binding_errors"), list)
                            else []
                        ),
                        "execution_digest": repeat.get("execution_digest"),
                        "artifact_count": len(
                            repeat.get("artifact_digests", {})
                            if isinstance(repeat.get("artifact_digests"), dict)
                            else {}
                        ),
                        "assertions": {
                            "passed": sum(
                                assertion.get("passed") is True
                                for assertion in repeat_assertions
                            ),
                            "total": len(repeat_assertions),
                        },
                        "required_pass_rate": repeat.get("required_pass_rate"),
                        "metrics": repeat.get("metrics", {})
                        if isinstance(repeat.get("metrics"), dict)
                        else {},
                        "dispatch": projected_dispatch,
                        "source_trace": projected_source_trace,
                        "trace": projected_trace,
                    }
                )
                for assertion in repeat.get("assertions", []):
                    if not isinstance(assertion, dict):
                        continue
                    assertion_count += 1
                    passed_assertions += int(assertion.get("passed") is True)
                    assertion_node_id = (
                        f"assertion:{case_id}:{arm_id}:{repeat_number}:{assertion.get('id')}"
                    )
                    declared_assertion = declared_assertions.get(
                        str(assertion.get("id")), {}
                    )
                    assertion_evidence = assertion.get("evidence")
                    assertion_path = (
                        f"cases/{case_id}/{arm_id}/repeat-{repeat_number}/"
                        f"{assertion_evidence['artifact']}"
                        if isinstance(assertion_evidence, dict)
                        and isinstance(assertion_evidence.get("artifact"), str)
                        else None
                    )
                    assertion_node = {
                            "id": assertion_node_id,
                            "kind": "assertion",
                            "parent_id": case_node_id,
                            "label": str(assertion.get("id")),
                            "status": "passed"
                            if assertion.get("passed") is True
                            else "failed",
                            "arm": arm_id,
                            "repeat": repeat_number,
                            "assertion_type": assertion.get("type"),
                            "assertion_rule": {
                                key: declared_assertion[key]
                                for key in (
                                    "severity",
                                    "artifact",
                                    "expected",
                                    "pattern",
                                    "rubric",
                                    "inputs",
                                )
                                if key in declared_assertion
                                and (content_visible or key in {"severity", "artifact"})
                            },
                            "assertion_evidence": assertion_evidence
                            if content_visible
                            else {},
                            "path": assertion_path,
                        }
                    if assertion_path is not None:
                        assertion_node.update(
                            _dashboard_evidence_fields(
                                workspace=workspace,
                                node_id=assertion_node_id,
                                relative_path=assertion_path,
                                visible=content_visible,
                            )
                        )
                    spine.append(assertion_node)
                    if isinstance(assertion_evidence, dict) and isinstance(
                        assertion_evidence.get("artifact"), str
                    ):
                        artifact_paths.add(
                            f"cases/{case_id}/{arm_id}/repeat-{repeat_number}/"
                            f"{assertion_evidence['artifact']}"
                        )
            for artifact_index, artifact_path in enumerate(sorted(artifact_paths)):
                artifact_node_id = f"artifact:{case_id}:{arm_id}:{artifact_index}"
                artifact_exists = _safe_artifact(
                    workspace, artifact_path
                ).is_file()
                artifact_node = {
                        "id": artifact_node_id,
                        "kind": "artifact",
                        "parent_id": case_node_id,
                        "label": Path(artifact_path).name,
                        "status": "retained" if artifact_exists else "missing",
                        "arm": arm_id,
                        "path": artifact_path,
                    }
                artifact_node.update(
                    _dashboard_evidence_fields(
                        workspace=workspace,
                        node_id=artifact_node_id,
                        relative_path=artifact_path,
                        visible=content_visible,
                    )
                )
                spine.append(artifact_node)
            arms.append(
                {
                    "id": arm_id,
                    "complete": arm.get("complete") is True,
                    "passed": arm.get("passed") is True,
                    "required_pass_rate": arm.get("required_pass_rate"),
                    "forbidden_actions": arm.get("forbidden_actions", []),
                    "side_effects": arm.get("side_effects", []),
                    "binding_errors": arm.get("binding_errors", []),
                    "metrics": _arm_metrics(arm),
                    "assertions": {
                        "passed": passed_assertions,
                        "total": assertion_count,
                    },
                    "artifact_count": len(artifact_paths),
                    "executions": execution_rows,
                }
            )
        if isinstance(semantic_assertions, list):
            for semantic in semantic_assertions:
                if not isinstance(semantic, dict):
                    continue
                semantic_id = str(semantic.get("id"))
                semantic_status = str(semantic.get("status", "invalid"))
                semantic_node_id = f"assertion:{case_id}:semantic:{semantic_id}"
                declared_semantic = declared_assertions.get(semantic_id, {})
                artifact = semantic.get("artifact")
                semantic_artifact_path = (
                    f"cases/{case_id}/{artifact}"
                    if isinstance(artifact, str)
                    else None
                )
                semantic_node = {
                        "id": semantic_node_id,
                        "kind": "assertion",
                        "parent_id": case_node_id,
                        "label": semantic_id,
                        "status": "passed"
                        if semantic.get("passed") is True
                        else semantic_status,
                        "assertion_type": "semantic_pair",
                        "detail": semantic.get("reason") if content_visible else None,
                        "assertion_rule": {
                            key: declared_semantic[key]
                            for key in (
                                "severity",
                                "artifact",
                                "rubric",
                                "inputs",
                            )
                            if key in declared_semantic
                            and (content_visible or key in {"severity", "artifact"})
                        },
                        "assertion_evidence": {
                            key: semantic[key]
                            for key in (
                                "status",
                                "passed",
                                "preference",
                                "reason",
                                "resolved_winners",
                                "source_event_ids",
                            )
                            if key in semantic and content_visible
                        },
                        "path": semantic_artifact_path,
                    }
                if semantic_artifact_path is not None:
                    semantic_node.update(
                        _dashboard_evidence_fields(
                            workspace=workspace,
                            node_id=semantic_node_id,
                            relative_path=semantic_artifact_path,
                            visible=content_visible,
                        )
                    )
                spine.append(semantic_node)
                if isinstance(artifact, str):
                    artifact_path = f"cases/{case_id}/{artifact}"
                    artifact_node_id = f"artifact:{case_id}:semantic:{semantic_id}"
                    artifact_node = {
                            "id": artifact_node_id,
                            "kind": "artifact",
                            "parent_id": case_node_id,
                            "label": Path(artifact).name,
                            "status": "retained"
                            if (workspace / artifact_path).is_file()
                            else "missing",
                            "path": artifact_path,
                        }
                    artifact_node.update(
                        _dashboard_evidence_fields(
                            workspace=workspace,
                            node_id=artifact_node_id,
                            relative_path=artifact_path,
                            visible=content_visible,
                        )
                    )
                    spine.append(artifact_node)
        case_rows.append(
            {
                "id": case_id,
                "purpose": planned_case.get("purpose"),
                "prompt": planned_case.get("prompt") if content_visible else None,
                "input_files": [
                    str(item.get("path"))
                    if isinstance(item, dict) and isinstance(item.get("path"), str)
                    else str(item)
                    for item in planned_case.get("files", [])
                ]
                if content_visible
                else [],
                "split": planned_case.get("split"),
                "determinism": planned_case.get("determinism"),
                "repeats": planned_case.get("repeats"),
                "holdout_visibility": holdout_visibility,
                "status": case_status,
                "regressed": result.get("regressed") is True,
                "direction_disagreement": result.get("direction_disagreement") is True,
                "missing_objective_metrics": result.get(
                    "missing_objective_metrics", []
                ),
                "arms": arms,
                "semantic_assertions": [
                    {
                        key: semantic[key]
                        for key in (
                            "id",
                            "status",
                            "passed",
                            "preference",
                            "artifact",
                            "resolved_winners",
                            "source_event_ids",
                        )
                        if key in semantic
                    }
                    for semantic in semantic_assertions
                    if isinstance(semantic, dict)
                ]
                if isinstance(semantic_assertions, list) and not content_visible
                else semantic_assertions
                if isinstance(semantic_assertions, list)
                else [],
            }
        )

    hard_gates = (
        latest_decision.get("hard_gates", []) if latest_decision else []
    )
    raw_execution_profile = plan.get("execution_profile")
    execution_profile = (
        {
            key: raw_execution_profile.get(key)
            for key in (
                "target",
                "harness",
                "capabilities",
                "isolation",
                "sampling",
                "digest",
            )
        }
        if isinstance(raw_execution_profile, dict)
        else None
    )
    raw_holdout = plan.get("holdout")
    holdout = (
        {
            key: raw_holdout.get(key)
            for key in ("visibility", "issuer", "digest")
        }
        if isinstance(raw_holdout, dict)
        else None
    )
    lineage = [
        {
            key: record.get(key)
            for key in (
                "round",
                "run_id",
                "parent_digest",
                "candidate_digest",
                "change",
                "change_digest",
                "continuity",
                "continuity_epoch",
                "training_trace_ids",
            )
        }
        for record in (state or {}).get("candidate_lineage", [])
        if isinstance(record, dict)
    ]
    raw_active_query = (state or {}).get("authorized_query")
    active_query = (
        {
            key: raw_active_query.get(key)
            for key in (
                "phase",
                "round",
                "run_id",
                "candidate_digest",
                "holdout_visibility",
            )
        }
        if isinstance(raw_active_query, dict)
        else None
    )
    skill_diffs = _dashboard_skill_diffs(plan, workspace=workspace)
    spine = _dashboard_order_spine(spine, case_rows)
    release_eligible = _dashboard_release_eligible(latest_decision)
    summary = {
        "case_count": len(case_rows),
        "candidate_passed": sum(row["status"] == "passed" for row in case_rows),
        "candidate_failed": sum(
            row["status"] in {"failed", "incomplete"} for row in case_rows
        ),
        "hard_gates_passed": sum(
            isinstance(gate, dict) and gate.get("passed") is True
            for gate in hard_gates
        ),
        "hard_gates_total": len(hard_gates),
        "decision_status": latest_decision.get("status")
        if latest_decision
        else None,
        "current_round": state.get("current_round") if state else None,
        "max_rounds": state.get("max_rounds") if state else 3,
        "selection_queries": state.get("selection_query_count") if state else 0,
        "audit_queries": state.get("audit_query_count") if state else 0,
        "rejected_candidates": len(state.get("rejected_candidates", []))
        if state
        else 0,
        "continuity_epoch": state.get("continuity_epoch") if state else None,
    }
    action_center = _dashboard_action_center(
        state=state,
        decisions=decisions,
        case_rows=case_rows,
    )
    review = _dashboard_review_outline(
        spine=spine,
        case_rows=case_rows,
        release_eligible=release_eligible,
        action_center=action_center,
    )
    data = {
        "contract": DASHBOARD_CONTRACT,
        "schema_version": 2,
        "generated_at": None,
        "refresh_interval_ms": 3000,
        "run": {
            "id": plan.get("run_id"),
            "status": (
                state.get("status")
                if state
                else latest_decision.get("status")
                if latest_decision
                else (evidence or {}).get("level", "planned")
            ),
            "verification_level": (evidence or {}).get("level", "not-run"),
            "manifest": plan.get("manifest"),
            "subject": plan.get("subject"),
            "baseline": plan.get("baseline"),
            "splits": plan.get("splits", []),
            "control_anchor": "local/trusted" if state else None,
            "execution_profile": execution_profile,
            "holdout": holdout,
            "evidence_scope": (evidence or {}).get(
                "evidence_scope",
                "opaque-holdout"
                if (holdout or {}).get("visibility") == "opaque"
                else "public-calibration",
            ),
            "release_eligible": release_eligible,
            "integrity": (evidence or {}).get("integrity", projected_integrity),
        },
        "summary": summary,
        "evolution": {
            "active_query": active_query,
            "selection_query_limit": state.get("max_rounds", 3) if state else 3,
            "audit_query_limit": 1,
            "candidate_lineage": lineage,
            "rejected_candidates": state.get("rejected_candidates", [])
            if state
            else [],
        },
        "action_center": action_center,
        "review": review,
        "cases": case_rows,
        "diffs": skill_diffs,
        "iterations": decisions,
        "spine": spine,
        "limitations": [
            *(evidence or {}).get("limitations", []),
            *(
                [
                    "evolution control anchor is local/trusted; same-owner anti-replay requires an external append-only anchor"
                ]
                if state
                else []
            ),
        ],
    }
    write_json(output, data)
    return data


def _parse_cli_object(raw: str, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw, parse_constant=_reject_json_constant)
        _require_finite_json(value, label)
    except (json.JSONDecodeError, ValueError, ManifestError) as error:
        raise ManifestError(f"{label} must be a finite JSON object: {error}") from error
    if not isinstance(value, dict):
        raise ManifestError(f"{label} must be a JSON object")
    return value


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    compile_parser = subparsers.add_parser("compile")
    compile_parser.add_argument("--manifest", type=Path, required=True)
    compile_parser.add_argument("--subject", type=Path, required=True)
    compile_parser.add_argument("--execution-profile", type=Path, required=True)
    compile_parser.add_argument("--holdout-pack", type=Path)
    compile_parser.add_argument(
        "--baseline-kind", choices=["old_skill", "without_skill"], required=True
    )
    compile_parser.add_argument(
        "--case",
        action="append",
        dest="case_ids",
        help="Narrow a development screen; selection/audit must remain complete.",
    )
    compile_parser.add_argument("--baseline-path", type=Path)
    compile_parser.add_argument(
        "--split",
        action="append",
        choices=["development", "selection", "audit"],
        dest="splits",
        help="Compile exactly one data split.",
    )
    compile_parser.add_argument("--workspace", type=Path, required=True)
    grade_parser = subparsers.add_parser("grade")
    grade_parser.add_argument("--plan", type=Path, required=True)
    grade_parser.add_argument("--workspace", type=Path, required=True)
    dispatch_parser = subparsers.add_parser(
        "record-dispatch",
        help="Record a harness-observed worker dispatch for one locked execution cell.",
    )
    dispatch_parser.add_argument("--workspace", type=Path, required=True)
    dispatch_parser.add_argument("--assignment", type=Path, required=True)
    dispatch_parser.add_argument("--dispatch-id", required=True)
    dispatch_parser.add_argument("--worker-id", required=True)
    dispatch_parser.add_argument("--batch-id")
    trace_parser = subparsers.add_parser(
        "trace-event",
        help="Append one observable Agent event to the bound execution trace.",
    )
    trace_parser.add_argument("--workspace", type=Path, required=True)
    trace_parser.add_argument("--assignment", type=Path, required=True)
    trace_parser.add_argument("--kind", choices=sorted(TRACE_EVENT_KINDS), required=True)
    trace_parser.add_argument("--summary", required=True)
    trace_parser.add_argument("--status", default="completed")
    trace_parser.add_argument("--details-json", default="{}")
    trace_parser.add_argument(
        "--artifact-ref", action="append", dest="artifact_refs", default=[]
    )
    trace_parser.add_argument(
        "--capture-source",
        choices=sorted(TRACE_CAPTURE_SOURCES),
        default="lead_agent_observed",
    )
    finalize_parser = subparsers.add_parser(
        "finalize-execution",
        help="Finalize the append-only Agent trace and write execution.json.",
    )
    finalize_parser.add_argument("--workspace", type=Path, required=True)
    finalize_parser.add_argument("--assignment", type=Path, required=True)
    finalize_parser.add_argument(
        "--status",
        choices=["completed", "failed", "timed_out", "interrupted"],
        required=True,
    )
    finalize_parser.add_argument("--metrics-json", default="{}")
    finalize_parser.add_argument(
        "--forbidden-action", action="append", dest="forbidden_actions", default=[]
    )
    finalize_parser.add_argument(
        "--side-effect", action="append", dest="side_effects", default=[]
    )
    finalize_parser.add_argument(
        "--capture-source",
        choices=sorted(TRACE_CAPTURE_SOURCES),
        default="lead_agent_observed",
    )
    decide_parser = subparsers.add_parser("decide")
    decide_parser.add_argument("--plan", type=Path, required=True)
    decide_parser.add_argument("--evidence", type=Path, required=True)
    decide_parser.add_argument("--workspace", type=Path, required=True)
    decide_parser.add_argument("--iteration", type=int, required=True)
    decide_parser.add_argument(
        "--phase", choices=["selection", "audit"], default="selection"
    )
    evolution_init_parser = subparsers.add_parser("evolution-init")
    evolution_init_parser.add_argument("--plan", type=Path, required=True)
    evolution_init_parser.add_argument("--workspace", type=Path, required=True)
    evolution_advance_parser = subparsers.add_parser("evolution-advance")
    evolution_advance_parser.add_argument("--state", type=Path, required=True)
    evolution_advance_parser.add_argument("--decision", type=Path, required=True)
    evolution_authorize_parser = subparsers.add_parser("evolution-authorize")
    evolution_authorize_parser.add_argument("--state", type=Path, required=True)
    evolution_authorize_parser.add_argument("--plan", type=Path, required=True)
    evolution_authorize_parser.add_argument("--parent-digest")
    evolution_authorize_parser.add_argument(
        "--training-trace", action="append", dest="training_trace_ids"
    )
    evolution_authorize_parser.add_argument(
        "--continuity", choices=["continue", "reset"], default="continue"
    )
    dashboard_parser = subparsers.add_parser("project-dashboard")
    dashboard_parser.add_argument("--workspace", type=Path, required=True)
    dashboard_parser.add_argument("--output", type=Path, required=True)
    dashboard_parser.add_argument("--state", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        if args.command == "compile":
            result = compile_manifest(
                manifest_path=args.manifest,
                subject=args.subject,
                workspace=args.workspace,
                execution_profile_path=args.execution_profile,
                holdout_pack_path=args.holdout_pack,
                baseline_kind=args.baseline_kind,
                baseline_path=args.baseline_path,
                splits=args.splits,
                case_ids=args.case_ids,
            )
        elif args.command == "grade":
            result = grade_run(plan_path=args.plan, workspace=args.workspace)
        elif args.command == "record-dispatch":
            result = record_dispatch_receipt(
                assignment_path=args.assignment,
                workspace=args.workspace,
                dispatch_id=args.dispatch_id,
                worker_id=args.worker_id,
                batch_id=args.batch_id,
            )
        elif args.command == "trace-event":
            result = record_trace_event(
                assignment_path=args.assignment,
                workspace=args.workspace,
                kind=args.kind,
                summary=args.summary,
                status=args.status,
                details=_parse_cli_object(args.details_json, "--details-json"),
                artifact_refs=args.artifact_refs,
                capture_source=args.capture_source,
            )
        elif args.command == "finalize-execution":
            result = finalize_execution(
                assignment_path=args.assignment,
                workspace=args.workspace,
                status=args.status,
                metrics=_parse_cli_object(args.metrics_json, "--metrics-json"),
                forbidden_actions=args.forbidden_actions,
                side_effects=args.side_effects,
                capture_source=args.capture_source,
            )
        elif args.command == "decide":
            result = decide_candidate(
                plan_path=args.plan,
                evidence_path=args.evidence,
                workspace=args.workspace,
                iteration=args.iteration,
                phase=args.phase,
            )
        elif args.command == "evolution-init":
            result = initialize_evolution(
                plan_path=args.plan, workspace=args.workspace
            )
        elif args.command == "evolution-advance":
            result = advance_evolution(
                state_path=args.state, decision_path=args.decision
            )
        elif args.command == "evolution-authorize":
            result = authorize_evolution(
                state_path=args.state,
                plan_path=args.plan,
                parent_digest=args.parent_digest,
                training_trace_ids=args.training_trace_ids,
                continuity=args.continuity,
            )
        elif args.command == "project-dashboard":
            result = project_dashboard(
                workspace=args.workspace, output=args.output, state_path=args.state
            )
        else:  # pragma: no cover - argparse rejects unknown commands
            raise AssertionError(args.command)
    except ManifestError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

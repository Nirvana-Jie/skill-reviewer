#!/usr/bin/env python3
"""Compile, grade, and project executable skill evaluation artifacts.

The module deliberately keeps model orchestration outside its interface. A lead
agent compiles a frozen execution plan, dispatches workers using the available
subagent surface, and returns their retained artifacts for deterministic
grading and release decisions.
"""

from __future__ import annotations

import argparse
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


MANIFEST_SCHEMA = "skill-reviewer.evals.v2"
PLAN_SCHEMA = "skill-reviewer.execution-plan.v1"
RUN_LOCK_SCHEMA = "skill-reviewer.run-lock.v1"
VERIFICATION_SCHEMA = "skill-reviewer.verification.v1"
ACCEPTANCE_SCHEMA = "skill-reviewer.acceptance-decision.v1"
ASSIGNMENT_SCHEMA = "skill-reviewer.executor-assignment.v1"
EXECUTION_SCHEMA = "skill-reviewer.executor-execution.v1"
SEMANTIC_JUDGMENT_SCHEMA = "skill-reviewer.semantic-judgment.v1"
DASHBOARD_SCHEMA = "skill-reviewer.dashboard-data.v1"
EVOLUTION_STATE_SCHEMA = "skill-reviewer.evolution-state.v1"
EVOLUTION_TRANSITION_SCHEMA = "skill-reviewer.evolution-transition.v1"

PATH_SAFE_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
RUNTIME_SKILL_ENTRIES = ("SKILL.md", "references", "scripts", "assets")

DETERMINISTIC_ASSERTION_TYPES = {
    "file_exists",
    "text_contains",
    "text_not_contains",
    "text_matches",
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
    declared_fixture_digests: dict[str, str] = {}
    raw_evals = manifest.get("evals")
    if isinstance(raw_evals, list):
        for raw_case in raw_evals:
            if not isinstance(raw_case, dict) or not isinstance(
                raw_case.get("files", []), list
            ):
                continue
            for relative in raw_case.get("files", []):
                if not isinstance(relative, str):
                    continue
                declared_fixture_digests[relative] = sha256_runtime_file(
                    _safe_subject_file(subject, relative, "declared eval fixture")
                )
    identity = {
        "manifest_digest": sha256_file(manifest_path),
        "evals_digest": sha256_strict_tree(eval_root, "eval authority"),
        "declared_fixture_digests": dict(sorted(declared_fixture_digests.items())),
        "grader_digest": sha256_file(Path(__file__).resolve()),
        "semantic_grader_contract_digest": sha256_file(semantic_contract_path),
    }
    return {
        **identity,
        "evals_root": str(eval_root),
        "grader_path": str(Path(__file__).resolve()),
        "semantic_grader_contract_path": str(semantic_contract_path),
        "digest": sha256_json(identity),
    }


def _require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{label} must be a non-empty string")
    return value.strip()


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
        elif assertion_type == "text_matches":
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
    if manifest.get("schema_version") != MANIFEST_SCHEMA:
        raise ManifestError(f"schema_version must be {MANIFEST_SCHEMA}")
    _require_string(manifest.get("skill_name"), "skill_name")
    defaults = manifest.get("defaults")
    if not isinstance(defaults, dict):
        raise ManifestError("defaults must be an object")
    repeats = defaults.get("repeats")
    if not isinstance(repeats, dict):
        raise ManifestError("defaults.repeats must be an object")
    for key, expected in (("deterministic", 1), ("stochastic", 3)):
        value = repeats.get(key)
        if not isinstance(value, int) or value < 1:
            raise ManifestError(f"defaults.repeats.{key} must be a positive integer")
        if value != expected:
            raise ManifestError(f"defaults.repeats.{key} must be {expected}")
    evolution = defaults.get("evolution")
    if not isinstance(evolution, dict) or evolution.get("max_rounds") != 3:
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
        _require_string(item.get("prompt"), f"{label}.prompt")
        files = item.get("files", [])
        if not isinstance(files, list) or not all(isinstance(value, str) for value in files):
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
        assertions = _validate_assertions(item.get("assertions"), f"{label}.assertions")
        if not any(
            assertion.get("type") in DETERMINISTIC_ASSERTION_TYPES
            and assertion.get("severity") == "must_pass"
            for assertion in assertions
        ):
            raise ManifestError(
                f"{label}.assertions requires at least one deterministic must_pass assertion"
            )
        objectives = _validate_objectives(item.get("objectives"), f"{label}.objectives")
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
                "files": file_records,
                "assertions": assertions,
                "objectives": objectives,
                "repeats": repeats[determinism],
                "timeout_seconds": timeout_seconds,
                "permissions": resolved_permissions,
            }
        )
    return normalized


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
    manifest_digest = sha256_file(manifest_path)
    subject_digest = runtime_skill_digest(subject)
    authority = _build_authority(subject, manifest_path)

    cases_with_arms = _cases_with_execution_arms(cases, baseline_kind)

    workspace = workspace.resolve()
    run_seed = "|".join(
        [
            subject_digest,
            str(authority["digest"]),
            str(baseline.get("digest")),
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
        "schema_version": PLAN_SCHEMA,
        "run_id": run_id,
        "manifest": {
            "path": str(manifest_path),
            "digest": manifest_digest,
            "schema_version": MANIFEST_SCHEMA,
        },
        "subject": {"path": str(subject), "digest": subject_digest},
        "baseline": baseline,
        "authority": authority,
        "skill_snapshots": snapshot_records,
        "skill_snapshot_tree_digest": skill_snapshot_tree_digest,
        "splits": selected_splits,
        "case_ids": [str(case["id"]) for case in cases],
        "cases": cases_with_arms,
        "agent_provenance": None,
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
                    source_path = _safe_subject_file(
                        subject, str(record["path"]), "eval input"
                    )
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
                    "schema_version": ASSIGNMENT_SCHEMA,
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
                    "writable_root": str(repeat_root.resolve()),
                    "execution_artifact": "execution.json",
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
        "schema_version": RUN_LOCK_SCHEMA,
        "run_id": run_id,
        "plan_digest": sha256_file(plan_path),
        "manifest_digest": manifest_digest,
        "subject_digest": subject_digest,
        "baseline": baseline,
        "authority": authority,
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
    elif assertion_type == "text_matches":
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
        passed = matched
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
            "schema_version": ASSIGNMENT_SCHEMA,
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
        expected_identity = {
            "schema_version": EXECUTION_SCHEMA,
            "run_id": run_id,
            "case_id": case["id"],
            "arm": arm,
            "repeat": repeat,
            "assignment_digest": expected_assignment_digest,
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
            for relative in normalized_inputs:
                artifact_path = _safe_artifact(repeat_root, relative)
                digests[relative] = (
                    sha256_file(artifact_path) if artifact_path.is_file() else None
                )
            records.append({"repeat": repeat, "digests": digests})
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
        judgment.get("schema_version") != SEMANTIC_JUDGMENT_SCHEMA
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
    if lock.get("schema_version") != RUN_LOCK_SCHEMA:
        raise ManifestError(f"run lock schema must be {RUN_LOCK_SCHEMA}")

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
    expected_cases = _cases_with_execution_arms(
        expected_cases_without_arms, str(baseline_kind)
    )
    if plan.get("cases") != expected_cases:
        raise ManifestError("execution plan cases do not match the pinned manifest")

    run_seed = "|".join(
        [
            subject_digest,
            str(recomputed_authority["digest"]),
            str(baseline_digest),
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
        "schema_version": PLAN_SCHEMA,
        "run_id": expected_run_id,
        "manifest": {
            "path": str(manifest_path),
            "digest": manifest_digest,
            "schema_version": MANIFEST_SCHEMA,
        },
        "subject": {"path": str(subject_path), "digest": subject_digest},
        "baseline": expected_baseline,
        "authority": recomputed_authority,
        "skill_snapshots": expected_snapshots,
        "skill_snapshot_tree_digest": expected_snapshot_tree_digest,
        "input_tree_digest": expected_input_tree_digest,
        "splits": [selected_split],
        "case_ids": case_ids,
        "cases": expected_cases,
        "agent_provenance": None,
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
                    "schema_version": ASSIGNMENT_SCHEMA,
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
                    "writable_root": str(repeat_root.resolve()),
                    "execution_artifact": "execution.json",
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
        "schema_version": RUN_LOCK_SCHEMA,
        "run_id": expected_run_id,
        "plan_digest": sha256_file(plan_path),
        "manifest_digest": manifest_digest,
        "subject_digest": subject_digest,
        "baseline": expected_baseline,
        "authority": recomputed_authority,
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
    if plan.get("schema_version") != PLAN_SCHEMA:
        raise ManifestError(f"execution plan schema must be {PLAN_SCHEMA}")
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
                persist=persist,
            )
            for arm in arms
        }
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
    if (
        any_incomplete
        or not all_with_skill_passed
        or any_regression
        or any_direction_disagreement
        or any_semantic_problem
        or any_safety_violation
    ):
        level = "inconclusive"
    elif has_baseline:
        level = "regression-verified"
    else:
        level = "behavior-verified"
    evidence = {
        "schema_version": VERIFICATION_SCHEMA,
        "run_id": plan.get("run_id"),
        "subject": plan.get("subject"),
        "baseline": plan.get("baseline"),
        "level": level,
        "cases": case_results,
        "limitations": limitations,
        "integrity": integrity,
        "agent_provenance": plan.get("agent_provenance"),
    }
    if any(case.get("split") == "audit" for case in plan.get("cases", [])):
        evidence["limitations"].append(
            "public audit fixtures are not a hidden holdout; hidden release evidence requires a trusted external runner"
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
        "schema_version": ACCEPTANCE_SCHEMA,
        "run_id": plan.get("run_id"),
        "iteration": iteration,
        "phase": phase,
        "status": status,
        "accepted": accepted,
        "hard_gates_passed": hard_gates_passed,
        "pareto_admissible": pareto_admissible,
        "material_improvement": material_improvement,
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
    if plan.get("schema_version") != PLAN_SCHEMA:
        raise ManifestError(f"execution plan schema must be {PLAN_SCHEMA}")
    plan_splits = plan.get("splits")
    if plan_splits != [phase] or any(
        case.get("split") != phase for case in plan.get("cases", [])
    ):
        raise ManifestError(
            f"{phase} decisions require a plan containing only the {phase} split"
        )
    evidence = grade_run(plan_path=plan_path, workspace=workspace)
    if evidence.get("schema_version") != VERIFICATION_SCHEMA:
        raise ManifestError(f"verification evidence schema must be {VERIFICATION_SCHEMA}")
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
    if decision.get("schema_version") != ACCEPTANCE_SCHEMA:
        raise ManifestError(f"acceptance decision schema must be {ACCEPTANCE_SCHEMA}")
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
    if plan.get("schema_version") != PLAN_SCHEMA:
        raise ManifestError(f"execution plan schema must be {PLAN_SCHEMA}")
    if evidence.get("schema_version") != VERIFICATION_SCHEMA:
        raise ManifestError(f"verification evidence schema must be {VERIFICATION_SCHEMA}")
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


def initialize_evolution(*, plan_path: Path, workspace: Path) -> dict[str, Any]:
    plan_path = plan_path.resolve()
    plan = load_json(plan_path)
    if plan.get("schema_version") != PLAN_SCHEMA:
        raise ManifestError(f"execution plan schema must be {PLAN_SCHEMA}")
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
    state = {
        "schema_version": EVOLUTION_STATE_SCHEMA,
        "evolution_id": evolution_id,
        "authority_digest": authority_digest,
        "baseline": baseline,
        "initialized_from_plan": str(plan_path.resolve()),
        "control_workspace": str(workspace),
        "max_rounds": 3,
        "current_round": 1,
        "status": "optimizing",
        "next_action": "propose_candidate",
        "terminal": False,
        "audit_consumed": False,
        "selected_subject_digest": None,
        "seen_run_ids": [],
        "history": [],
        "journal_head_digest": None,
    }
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
    if state.get("schema_version") != EVOLUTION_STATE_SCHEMA:
        raise ManifestError(f"evolution state schema must be {EVOLUTION_STATE_SCHEMA}")
    plan, _evidence = _validate_bound_decision(decision, decision_path)
    if state.get("authority_digest") != decision.get("authority_digest"):
        raise ManifestError("evolution authority changed; user confirmation requires a new run")
    if state.get("baseline") != decision.get("baseline"):
        raise ManifestError("accepted old_skill baseline changed during evolution")
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
        }
    )

    if phase == "selection":
        if state.get("status") != "optimizing":
            raise ManifestError("selection decisions are allowed only while optimizing")
        if decision.get("accepted") is True:
            state.update(
                {
                    "status": "awaiting-audit",
                    "next_action": "run_audit",
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
    else:
        if state.get("status") != "awaiting-audit":
            raise ManifestError("audit is allowed only after a selection candidate is accepted")
        if state.get("audit_consumed") is True:
            raise ManifestError("audit may run only once")
        if plan.get("subject", {}).get("digest") != state.get(
            "selected_subject_digest"
        ):
            raise ManifestError("audit subject is not the accepted selection candidate")
        released = decision.get("accepted") is True
        state.update(
            {
                "status": "released" if released else "audit-failed",
                "next_action": "stop",
                "terminal": True,
                "audit_consumed": True,
            }
        )
    state["history"] = history
    state["seen_run_ids"] = [*seen_run_ids, run_id]
    transition_path = _safe_artifact(
        Path(_require_string(state.get("control_workspace"), "state.control_workspace"))
        / "transitions",
        f"{len(history):04d}.json",
    )
    write_json_exclusive(
        transition_path,
        {
            "schema_version": EVOLUTION_TRANSITION_SCHEMA,
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


def _validate_evolution_state(
    state: dict[str, Any],
    plan: dict[str, Any],
    state_path: Path,
    plan_path: Path,
) -> list[tuple[Path, dict[str, Any]]]:
    if state.get("schema_version") != EVOLUTION_STATE_SCHEMA:
        raise ManifestError(f"evolution state schema must be {EVOLUTION_STATE_SCHEMA}")
    plan_authority = plan.get("authority")
    baseline = plan.get("baseline")
    subject = plan.get("subject")
    if not all(
        isinstance(value, dict)
        for value in (plan_authority, baseline, subject)
    ):
        raise ManifestError("dashboard plan authority, subject, and baseline must be objects")
    authority_digest = plan_authority.get("digest")
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
    if (
        initialized_plan.get("schema_version") != PLAN_SCHEMA
        or not isinstance(initialized_authority, dict)
        or not isinstance(initialized_subject, dict)
        or not isinstance(initialized_baseline, dict)
        or initialized_authority.get("digest") != authority_digest
        or initialized_baseline != baseline
        or initialized_plan.get("splits") != ["selection"]
    ):
        raise ManifestError("dashboard state initialization plan is incompatible")
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
            transition.get("schema_version") != EVOLUTION_TRANSITION_SCHEMA
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
        "next_action": "propose_candidate",
        "terminal": False,
        "audit_consumed": False,
        "selected_subject_digest": None,
    }
    validated: list[tuple[Path, dict[str, Any]]] = []
    history_run_ids: list[str] = []
    state_projection = dict(projection) if state_history_length == 0 else None
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
        }
        if record != expected_record:
            raise ManifestError("dashboard state history does not match its decision")
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
                        "next_action": "run_audit",
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
                    "status": "released"
                    if decision.get("accepted") is True
                    else "audit-failed",
                    "next_action": "stop",
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

    if history and history_run_ids[0] != initialized_plan.get("run_id"):
        raise ManifestError("dashboard state history does not start from its initialization run")
    if seen_run_ids != history_run_ids[:state_history_length]:
        raise ManifestError("dashboard state seen_run_ids do not match decision history")
    if state_projection is None:
        raise ManifestError("evolution state projection could not be reconstructed")
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
    if plan.get("schema_version") != PLAN_SCHEMA:
        raise ManifestError(f"execution plan schema must be {PLAN_SCHEMA}")
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
        current_state_run_id = (
            seen_run_ids[-1] if seen_run_ids else initialized_plan.get("run_id")
        )
        if plan.get("run_id") != current_state_run_id:
            raise ManifestError(
                "dashboard state does not identify the current run"
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
            spine.append(
                {
                    "id": f"gate:{gate.get('id')}",
                    "kind": "gate",
                    "parent_id": f"run:{plan.get('run_id')}",
                    "label": str(gate.get("id")),
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
        spine.append(
            {
                "id": f"iteration:{decision_run_id}:{decision.get('iteration')}:{decision.get('phase')}",
                "kind": "iteration",
                "parent_id": f"run:{plan.get('run_id')}",
                "label": f"Round {decision.get('iteration')} · {decision.get('phase')} · {decision_run_id[-8:]}",
                "status": decision.get("status"),
                "artifact": decision.get("artifact"),
            }
        )

    case_rows: list[dict[str, Any]] = []
    for planned_case in plan.get("cases", []):
        case_id = str(planned_case.get("id"))
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
            artifact_paths: set[str] = set(
                str(value) for value in arm.get("artifacts", []) if isinstance(value, str)
            )
            for repeat in arm.get("repeats", []):
                if not isinstance(repeat, dict):
                    continue
                repeat_number = repeat.get("repeat")
                for assertion in repeat.get("assertions", []):
                    if not isinstance(assertion, dict):
                        continue
                    assertion_count += 1
                    passed_assertions += int(assertion.get("passed") is True)
                    assertion_node_id = (
                        f"assertion:{case_id}:{arm_id}:{repeat_number}:{assertion.get('id')}"
                    )
                    spine.append(
                        {
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
                        }
                    )
                    assertion_evidence = assertion.get("evidence")
                    if isinstance(assertion_evidence, dict) and isinstance(
                        assertion_evidence.get("artifact"), str
                    ):
                        artifact_paths.add(
                            f"cases/{case_id}/{arm_id}/repeat-{repeat_number}/"
                            f"{assertion_evidence['artifact']}"
                        )
            for artifact_index, artifact_path in enumerate(sorted(artifact_paths)):
                spine.append(
                    {
                        "id": f"artifact:{case_id}:{arm_id}:{artifact_index}",
                        "kind": "artifact",
                        "parent_id": case_node_id,
                        "label": Path(artifact_path).name,
                        "status": "retained",
                        "arm": arm_id,
                        "path": artifact_path,
                    }
                )
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
                }
            )
        if isinstance(semantic_assertions, list):
            for semantic in semantic_assertions:
                if not isinstance(semantic, dict):
                    continue
                semantic_id = str(semantic.get("id"))
                semantic_status = str(semantic.get("status", "invalid"))
                semantic_node_id = f"assertion:{case_id}:semantic:{semantic_id}"
                spine.append(
                    {
                        "id": semantic_node_id,
                        "kind": "assertion",
                        "parent_id": case_node_id,
                        "label": semantic_id,
                        "status": "passed"
                        if semantic.get("passed") is True
                        else semantic_status,
                        "assertion_type": "semantic_pair",
                        "detail": semantic.get("reason"),
                    }
                )
                artifact = semantic.get("artifact")
                if isinstance(artifact, str):
                    artifact_path = f"cases/{case_id}/{artifact}"
                    spine.append(
                        {
                            "id": f"artifact:{case_id}:semantic:{semantic_id}",
                            "kind": "artifact",
                            "parent_id": case_node_id,
                            "label": Path(artifact).name,
                            "status": "retained"
                            if (workspace / artifact_path).is_file()
                            else "missing",
                            "path": artifact_path,
                        }
                    )
        case_rows.append(
            {
                "id": case_id,
                "purpose": planned_case.get("purpose"),
                "split": planned_case.get("split"),
                "determinism": planned_case.get("determinism"),
                "repeats": planned_case.get("repeats"),
                "status": case_status,
                "regressed": result.get("regressed") is True,
                "direction_disagreement": result.get("direction_disagreement") is True,
                "missing_objective_metrics": result.get(
                    "missing_objective_metrics", []
                ),
                "arms": arms,
                "semantic_assertions": semantic_assertions
                if isinstance(semantic_assertions, list)
                else [],
            }
        )

    hard_gates = (
        latest_decision.get("hard_gates", []) if latest_decision else []
    )
    data = {
        "schema_version": DASHBOARD_SCHEMA,
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
            "subject": plan.get("subject"),
            "baseline": plan.get("baseline"),
            "splits": plan.get("splits", []),
            "control_anchor": "local/trusted" if state else None,
            "integrity": (evidence or {}).get("integrity", projected_integrity),
        },
        "summary": {
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
        },
        "cases": case_rows,
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


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    compile_parser = subparsers.add_parser("compile")
    compile_parser.add_argument("--manifest", type=Path, required=True)
    compile_parser.add_argument("--subject", type=Path, required=True)
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
                baseline_kind=args.baseline_kind,
                baseline_path=args.baseline_path,
                splits=args.splits,
                case_ids=args.case_ids,
            )
        elif args.command == "grade":
            result = grade_run(plan_path=args.plan, workspace=args.workspace)
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

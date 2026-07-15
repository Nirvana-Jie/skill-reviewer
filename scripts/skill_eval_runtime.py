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
import re
import shutil
import sys
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


class ManifestError(ValueError):
    """Raised when an executable eval manifest violates its public contract."""


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ManifestError(f"manifest does not exist: {path}") from error
    except json.JSONDecodeError as error:
        raise ManifestError(
            f"manifest is not valid JSON at line {error.lineno}, column {error.colno}"
        ) from error
    if not isinstance(value, dict):
        raise ManifestError("manifest root must be an object")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def iter_subject_files(root: Path) -> Iterable[Path]:
    ignored_parts = {
        ".git",
        ".playwright-cli",
        "node_modules",
        "__pycache__",
        ".DS_Store",
        "coverage",
        "dist",
        "build",
        ".codex-eval-workspace",
        "skill-reviewer-workspace",
    }
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        if ignored_parts.intersection(path.relative_to(root).parts):
            continue
        yield path


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


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _ensure_empty_workspace(workspace: Path, subject: Path) -> None:
    resolved = workspace.resolve()
    if _is_within(resolved, subject):
        raise ManifestError("workspace must be outside the subject directory")
    if resolved.exists():
        if not resolved.is_dir():
            raise ManifestError("workspace must be an empty directory")
        if any(resolved.iterdir()):
            raise ManifestError("workspace must be empty before compilation")


def _make_read_only(root: Path) -> None:
    for path in root.rglob("*"):
        if path.is_file():
            path.chmod(path.stat().st_mode & ~0o222)


def _materialize_skill_snapshot(source: Path, destination: Path) -> str:
    if destination.exists():
        raise ManifestError(f"skill snapshot already exists: {destination}")
    destination.mkdir(parents=True)
    for entry_name in RUNTIME_SKILL_ENTRIES:
        source_entry = source / entry_name
        if not source_entry.exists():
            continue
        destination_entry = destination / entry_name
        if source_entry.is_file():
            safe_source = _safe_subject_file(
                source, entry_name, "runtime skill snapshot entry"
            )
            shutil.copy2(safe_source, destination_entry)
            continue
        if not source_entry.is_dir():
            raise ManifestError(
                f"runtime skill snapshot entry must be a file or directory: {entry_name}"
            )
        for source_file in iter_subject_files(source_entry):
            relative = source_file.relative_to(source_entry)
            safe_source = _safe_subject_file(
                source, (Path(entry_name) / relative).as_posix(), "runtime skill snapshot entry"
            )
            destination_file = destination_entry / relative
            destination_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(safe_source, destination_file)
    if not (destination / "SKILL.md").is_file():
        raise ManifestError("skill snapshot requires SKILL.md")
    digest = sha256_tree(destination)
    _make_read_only(destination)
    return digest


def _build_authority(subject: Path, manifest_path: Path) -> dict[str, Any]:
    eval_root = manifest_path.parent.resolve()
    if not _is_within(eval_root, subject):
        raise ManifestError("eval authority must stay inside the subject directory")
    identity = {
        "manifest_digest": sha256_file(manifest_path),
        "evals_digest": sha256_tree(eval_root),
        "grader_digest": sha256_file(Path(__file__).resolve()),
    }
    return {
        **identity,
        "evals_root": str(eval_root),
        "grader_path": str(Path(__file__).resolve()),
        "digest": sha256_json(identity),
    }


def _require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{label} must be a non-empty string")
    return value.strip()


def _safe_subject_file(subject: Path, relative: str, label: str) -> Path:
    path = (subject / relative).resolve()
    try:
        path.relative_to(subject.resolve())
    except ValueError as error:
        raise ManifestError(f"{label} escapes the subject directory: {relative}") from error
    if not path.is_file():
        raise ManifestError(f"{label} does not exist: {relative}")
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
    return float(value)


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
    raw_permissions = defaults.get("permissions")
    if not isinstance(raw_permissions, dict) or raw_permissions.get("network") not in {
        "deny",
        "allowlist",
    }:
        raise ManifestError("defaults.permissions.network must be deny or allowlist")
    permissions = {"external_side_effects": "deny", **raw_permissions}
    if permissions.get("external_side_effects") != "deny":
        raise ManifestError("defaults.permissions.external_side_effects must be deny")
    writable_roots = permissions.get("writable_roots")
    if not isinstance(writable_roots, list) or not writable_roots:
        raise ManifestError("defaults.permissions.writable_roots must be a non-empty array")
    for index, raw_root in enumerate(writable_roots):
        _validate_artifact_path(
            raw_root, f"defaults.permissions.writable_roots[{index}]"
        )
    if permissions.get("network") == "allowlist":
        allowlist = permissions.get("network_allowlist")
        if not isinstance(allowlist, list) or not allowlist or not all(
            isinstance(value, str) and value.strip() for value in allowlist
        ):
            raise ManifestError(
                "defaults.permissions.network_allowlist must be a non-empty string array when network is allowlist"
            )

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
        file_records = [
            {
                "path": relative,
                "digest": sha256_file(
                    _safe_subject_file(subject, relative, f"{label}.files")
                ),
            }
            for relative in files
        ]
        assertions = _validate_assertions(item.get("assertions"), f"{label}.assertions")
        objectives = _validate_objectives(item.get("objectives"), f"{label}.objectives")
        item_permissions = item.get("permissions", {})
        if not isinstance(item_permissions, dict):
            raise ManifestError(f"{label}.permissions must be an object")
        resolved_permissions = {**permissions, **item_permissions}
        if resolved_permissions.get("network") not in {"deny", "allowlist"}:
            raise ManifestError(
                f"{label}.permissions.network must be deny or allowlist"
            )
        if resolved_permissions.get("external_side_effects") != "deny":
            raise ManifestError(
                f"{label}.permissions.external_side_effects must remain deny"
            )
        resolved_writable_roots = resolved_permissions.get("writable_roots")
        if not isinstance(resolved_writable_roots, list) or not resolved_writable_roots:
            raise ManifestError(
                f"{label}.permissions.writable_roots must be a non-empty array"
            )
        for root_index, raw_root in enumerate(resolved_writable_roots):
            _validate_artifact_path(
                raw_root,
                f"{label}.permissions.writable_roots[{root_index}]",
            )
        if resolved_permissions.get("network") == "allowlist":
            allowlist = resolved_permissions.get("network_allowlist")
            if not isinstance(allowlist, list) or not allowlist or not all(
                isinstance(value, str) and value.strip() for value in allowlist
            ):
                raise ManifestError(
                    f"{label}.permissions.network_allowlist must be a non-empty string array"
                )
        normalized.append(
            {
                **item,
                "files": file_records,
                "assertions": assertions,
                "objectives": objectives,
                "repeats": repeats[determinism],
                "permissions": resolved_permissions,
            }
        )
    return normalized


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
    cases = [
        case
        for case in cases
        if case["split"] in selected_splits
        and (not requested_case_ids or case["id"] in requested_case_ids)
    ]
    if not cases:
        raise ManifestError("selected split has no eval cases")
    _ensure_empty_workspace(workspace, subject)
    manifest_digest = sha256_file(manifest_path)
    subject_digest = sha256_tree(subject)
    authority = _build_authority(subject, manifest_path)

    if baseline_kind == "old_skill":
        if baseline_path is None:
            raise ManifestError("--baseline-path is required for old_skill")
        baseline_path = baseline_path.resolve()
        baseline = {
            "kind": "old_skill",
            "path": str(baseline_path),
            "digest": sha256_tree(baseline_path),
        }
        default_arms = ["with_skill", "old_skill"]
    elif baseline_kind == "without_skill":
        baseline = {"kind": "without_skill", "path": None, "digest": None}
        default_arms = ["with_skill", "without_skill"]
    else:
        raise ManifestError("baseline kind must be old_skill or without_skill")

    if selected_split in {"selection", "audit"} and baseline_kind != "old_skill":
        raise ManifestError(f"{selected_split} requires an old_skill baseline")

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
    candidate_snapshot = _safe_artifact(workspace, "skill-snapshots/with_skill")
    snapshot_records["with_skill"] = {
        "path": str(candidate_snapshot),
        "digest": _materialize_skill_snapshot(subject, candidate_snapshot),
        "source_digest": subject_digest,
    }
    if baseline_kind == "old_skill" and baseline_path is not None:
        baseline_snapshot = _safe_artifact(workspace, "skill-snapshots/old_skill")
        snapshot_records["old_skill"] = {
            "path": str(baseline_snapshot),
            "digest": _materialize_skill_snapshot(baseline_path, baseline_snapshot),
            "source_digest": baseline.get("digest"),
        }
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
        "splits": selected_splits,
        "case_ids": [str(case["id"]) for case in cases],
        "cases": cases_with_arms,
        "agent_provenance": None,
    }
    plan_path = workspace / "execution-plan.json"
    write_json(plan_path, plan)
    input_copy_digests: dict[str, str] = {}
    assignment_digests: dict[str, str] = {}
    for case in cases_with_arms:
        expected_artifacts = list(
            dict.fromkeys(
                str(assertion["artifact"])
                for assertion in case.get("assertions", [])
                if assertion.get("type") in DETERMINISTIC_ASSERTION_TYPES
            )
        )
        for arm in case["arms"]:
            if arm == "with_skill":
                configuration = {
                    "kind": "with_skill",
                    "skill_path": snapshot_records["with_skill"]["path"],
                    "snapshot_digest": snapshot_records["with_skill"]["digest"],
                    "source_digest": subject_digest,
                }
            elif arm == "old_skill":
                configuration = {
                    "kind": "old_skill",
                    "skill_path": snapshot_records["old_skill"]["path"],
                    "snapshot_digest": snapshot_records["old_skill"]["digest"],
                    "source_digest": baseline.get("digest"),
                }
            else:
                configuration = {
                    "kind": "without_skill",
                    "skill_path": None,
                    "snapshot_digest": None,
                    "source_digest": None,
                }
            for repeat in range(1, int(case["repeats"]) + 1):
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
                    digest = sha256_file(isolated_path)
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
    path = (root / relative).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as error:
        raise ManifestError(f"artifact path escapes its execution root: {relative}") from error
    return path


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
            parsed = json.loads(artifact_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
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
                passed = found and actual == expected
            elif operator == "not_equals":
                passed = found and actual != expected
            elif operator == "contains":
                passed = found and isinstance(actual, (str, list, dict)) and expected in actual
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
            numeric = (
                float(actual)
                if found and isinstance(actual, (int, float)) and not isinstance(actual, bool)
                else None
            )
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
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise ValueError(f"line {line_number} is not an object")
                observed_event = record.get("event")
                if isinstance(observed_event, str):
                    observed.append(observed_event)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
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
    for repeat in range(1, int(case["repeats"]) + 1):
        repeat_root = workspace / "cases" / str(case["id"]) / arm / f"repeat-{repeat}"
        execution_path = repeat_root / "execution.json"
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
        for artifact in expected_artifacts:
            artifact_path = _safe_artifact(repeat_root, artifact)
            if not artifact_path.is_file():
                continue
            recorded_digest = artifact_digests.get(artifact)
            if not isinstance(recorded_digest, str) or recorded_digest != sha256_file(
                artifact_path
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
        if not isinstance(execution.get("metrics"), dict):
            repeat_binding_errors.append("execution metrics must be an object")
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
        metrics: dict[str, float] = {}
        raw_metrics = execution.get("metrics", {})
        if repeat_complete and isinstance(raw_metrics, dict):
            for metric, value in raw_metrics.items():
                if (
                    isinstance(metric, str)
                    and isinstance(value, (int, float))
                    and not isinstance(value, bool)
                ):
                    metrics[metric] = float(value)
                    metric_samples.setdefault(metric, []).append(float(value))
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
                "assertions": assertions,
                "required_pass_rate": repeat_pass_rate,
                "metrics": metrics,
            }
        )
    required_pass_rate = required_passed / required_total if required_total else 1.0
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
    for metric, values in metric_samples.items():
        if len(values) == len(repeat_results):
            result[metric] = sum(values) / len(values)
    write_json(workspace / "cases" / str(case["id"]) / arm / "grading.json", result)
    return result


def grade_semantic_assertion(
    *, assertion: dict[str, Any], case_root: Path, candidate_arm: str, baseline_arm: str
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
        if set(mapping) != {"A", "B"} or set(mapping.values()) != expected:
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
        return candidate_value - baseline_value
    if objective.get("direction") == "minimize":
        return baseline_value - candidate_value
    raise ManifestError(
        f"objective {objective.get('id')} direction must be maximize or minimize"
    )


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
            delta = _objective_delta(objective, candidate_value, baseline_value)
            if delta > tolerance:
                directions.add(1)
            elif delta < -tolerance:
                directions.add(-1)
            else:
                directions.add(0)
        if 1 in directions and -1 in directions:
            return True
    return False


def verify_locked_inputs(
    *, plan_path: Path, workspace: Path, plan: dict[str, Any]
) -> dict[str, Any]:
    lock_path = workspace / "run-lock.json"
    if not lock_path.is_file():
        raise ManifestError("run-lock.json is required before grading")
    lock = load_json(lock_path)
    if lock.get("schema_version") != RUN_LOCK_SCHEMA:
        raise ManifestError(f"run lock schema must be {RUN_LOCK_SCHEMA}")
    if lock.get("run_id") != plan.get("run_id"):
        raise ManifestError("execution plan and run lock use different run ids")
    if lock.get("plan_digest") != sha256_file(plan_path):
        raise ManifestError("locked execution plan changed after compilation")

    manifest = plan.get("manifest")
    subject = plan.get("subject")
    baseline = plan.get("baseline")
    if not isinstance(manifest, dict) or not isinstance(subject, dict):
        raise ManifestError("execution plan is missing locked manifest or subject metadata")
    manifest_path = Path(_require_string(manifest.get("path"), "plan.manifest.path"))
    if not manifest_path.is_file() or sha256_file(manifest_path) != lock.get(
        "manifest_digest"
    ):
        raise ManifestError("locked eval manifest changed or disappeared")
    subject_path = Path(_require_string(subject.get("path"), "plan.subject.path"))
    if not subject_path.is_dir() or sha256_tree(subject_path) != lock.get("subject_digest"):
        raise ManifestError("locked subject changed or disappeared")
    if subject.get("digest") != lock.get("subject_digest"):
        raise ManifestError("execution plan subject digest does not match run lock")

    authority = plan.get("authority")
    locked_authority = lock.get("authority")
    if not isinstance(authority, dict) or authority != locked_authority:
        raise ManifestError("execution plan authority does not match run lock")
    recomputed_authority = _build_authority(subject_path, manifest_path)
    if recomputed_authority != authority:
        raise ManifestError("locked eval or grader authority changed after compilation")

    if isinstance(baseline, dict) and baseline.get("kind") == "old_skill":
        baseline_path = Path(
            _require_string(baseline.get("path"), "plan.baseline.path")
        )
        if not baseline_path.is_dir() or sha256_tree(baseline_path) != baseline.get(
            "digest"
        ):
            raise ManifestError("locked old_skill baseline changed or disappeared")
        if baseline.get("digest") != lock.get("baseline", {}).get("digest"):
            raise ManifestError("execution plan baseline digest does not match run lock")

    snapshots = plan.get("skill_snapshots")
    locked_snapshot_digests = lock.get("skill_snapshot_digests")
    if not isinstance(snapshots, dict) or not isinstance(
        locked_snapshot_digests, dict
    ):
        raise ManifestError("skill snapshot authority is missing")
    for arm, record in snapshots.items():
        if not isinstance(arm, str) or not isinstance(record, dict):
            raise ManifestError("skill snapshot records must be objects")
        snapshot_path = Path(
            _require_string(record.get("path"), f"skill_snapshots.{arm}.path")
        )
        if not _is_within(snapshot_path, workspace):
            raise ManifestError(f"skill snapshot escapes the run workspace: {arm}")
        expected_digest = locked_snapshot_digests.get(arm)
        if (
            not isinstance(expected_digest, str)
            or record.get("digest") != expected_digest
            or sha256_tree(snapshot_path) != expected_digest
        ):
            raise ManifestError(f"locked skill snapshot changed: {arm}")

    fixture_digests = lock.get("fixture_digests", {})
    if not isinstance(fixture_digests, dict):
        raise ManifestError("run lock fixture_digests must be an object")
    for relative, expected_digest in fixture_digests.items():
        if not isinstance(relative, str) or not isinstance(expected_digest, str):
            raise ManifestError("run lock fixture digest entries must be strings")
        fixture_path = _safe_subject_file(
            subject_path, relative, "run lock fixture"
        )
        if sha256_file(fixture_path) != expected_digest:
            raise ManifestError(f"locked fixture changed: {relative}")
    assignment_digests = lock.get("assignment_digests", {})
    if not isinstance(assignment_digests, dict) or not assignment_digests:
        raise ManifestError("run lock assignment_digests must be a non-empty object")
    for relative, expected_digest in assignment_digests.items():
        if not isinstance(relative, str) or not isinstance(expected_digest, str):
            raise ManifestError("run lock assignment digest entries must be strings")
        assignment_path = _safe_artifact(workspace, relative)
        if not assignment_path.is_file() or sha256_file(assignment_path) != expected_digest:
            raise ManifestError(f"locked executor assignment changed: {relative}")
    input_copy_digests = lock.get("input_copy_digests", {})
    if not isinstance(input_copy_digests, dict):
        raise ManifestError("run lock input_copy_digests must be an object")
    for relative, expected_digest in input_copy_digests.items():
        if not isinstance(relative, str) or not isinstance(expected_digest, str):
            raise ManifestError("run lock input copy digest entries must be strings")
        input_path = _safe_artifact(workspace, relative)
        if not input_path.is_file() or sha256_file(input_path) != expected_digest:
            raise ManifestError(f"locked isolated input changed: {relative}")
    return {
        "locked": True,
        "verified": True,
        "run_lock": str(lock_path.resolve()),
        "run_lock_digest": sha256_file(lock_path),
        "plan_digest": lock.get("plan_digest"),
        "authority_digest": authority.get("digest"),
    }


def grade_run(*, plan_path: Path, workspace: Path) -> dict[str, Any]:
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
        missing_objective_metric = False
        if baseline is not None:
            for objective in case.get("objectives", []):
                metric = str(objective.get("metric"))
                candidate_value = candidate.get(metric)
                baseline_value = baseline.get(metric)
                if not isinstance(candidate_value, (int, float)) or not isinstance(
                    baseline_value, (int, float)
                ):
                    missing_objective_metric = True
                    continue
                delta = _objective_delta(
                    objective, float(candidate_value), float(baseline_value)
                )
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
        if missing_objective_metric:
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
            else:
                limitations.append(
                    f"semantic evidence invalid in case {case['id']}"
                )
        case_result: dict[str, Any] = {
            "id": case["id"],
            "split": case.get("split"),
            "regressed": regressed,
            "direction_disagreement": direction_disagreement,
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
                {"id": f"{case_id}:evidence-present", "passed": False, "reason": "missing case evidence"}
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
                    "reason": f"{paired_arm} artifacts are complete"
                    if paired_complete
                    else f"{paired_arm} artifacts are missing or incomplete",
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
                "reason": f"{baseline_arm or 'baseline'} artifacts are complete"
                if baseline_valid
                else "paired baseline artifacts are missing or incomplete",
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
            if not isinstance(candidate_value, (int, float)) or not isinstance(
                baseline_value, (int, float)
            ):
                hard_gates.append(
                    {
                        "id": f"{case_id}:{objective.get('id')}:metric-present",
                        "passed": False,
                        "reason": f"metric {metric} is missing from paired evidence",
                    }
                )
                continue
            direction = objective.get("direction")
            if direction == "maximize":
                delta = float(candidate_value) - float(baseline_value)
            elif direction == "minimize":
                delta = float(baseline_value) - float(candidate_value)
            else:
                raise ManifestError(
                    f"objective {objective.get('id')} direction must be maximize or minimize"
                )
            tolerance = float(objective.get("non_regression_tolerance", 0))
            material_delta = float(objective.get("min_material_delta", 0))
            objective_results.append(
                {
                    "case_id": case_id,
                    "id": objective.get("id"),
                    "metric": metric,
                    "direction": direction,
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
    decision = {
        "schema_version": ACCEPTANCE_SCHEMA,
        "run_id": plan.get("run_id"),
        "plan_path": str(plan_path),
        "plan_digest": sha256_file(plan_path),
        "evidence_path": str(evidence_path),
        "evidence_digest": sha256_file(evidence_path),
        "evidence_level": evidence.get("level"),
        "authority_digest": plan.get("authority", {}).get("digest"),
        "subject": plan.get("subject"),
        "baseline": plan.get("baseline"),
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
    if decision.get("authority_digest") != plan.get("authority", {}).get("digest"):
        raise ManifestError("decision authority digest does not match its plan")
    if decision.get("subject") != plan.get("subject"):
        raise ManifestError("decision subject does not match its plan")
    if decision.get("baseline") != plan.get("baseline"):
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
    hard_gates = decision.get("hard_gates")
    objectives = decision.get("objectives")
    if not isinstance(hard_gates, list) or not isinstance(objectives, list):
        raise ManifestError("decision hard gates and objectives must be arrays")
    hard_gates_passed = bool(hard_gates) and all(
        isinstance(item, dict) and item.get("passed") is True for item in hard_gates
    )
    pareto_admissible = bool(objectives) and all(
        isinstance(item, dict) and item.get("non_regressed") is True
        for item in objectives
    )
    material_improvement = any(
        isinstance(item, dict)
        and item.get("primary") is True
        and item.get("materially_improved") is True
        for item in objectives
    )
    if (
        decision.get("hard_gates_passed") is not hard_gates_passed
        or decision.get("pareto_admissible") is not pareto_admissible
        or decision.get("material_improvement") is not material_improvement
    ):
        raise ManifestError("decision summary does not match its gates and objectives")
    expected_accepted = (
        evidence.get("level") != "inconclusive"
        and hard_gates_passed
        and pareto_admissible
        and (phase == "audit" or material_improvement)
    )
    if decision.get("accepted") is not expected_accepted:
        raise ManifestError("decision accepted flag is inconsistent")
    if expected_accepted:
        expected_status = "accepted"
    elif evidence.get("level") == "inconclusive":
        expected_status = "inconclusive"
    elif not hard_gates_passed or not pareto_admissible:
        expected_status = "rejected"
    else:
        expected_status = "no-change"
    if decision.get("status") != expected_status:
        raise ManifestError("decision status is inconsistent")
    if not decision_path.is_file():
        raise ManifestError("decision artifact does not exist")
    return plan, evidence


def initialize_evolution(*, plan_path: Path, workspace: Path) -> dict[str, Any]:
    plan_path = plan_path.resolve()
    plan = load_json(plan_path)
    if plan.get("schema_version") != PLAN_SCHEMA:
        raise ManifestError(f"execution plan schema must be {PLAN_SCHEMA}")
    if plan.get("splits") != ["selection"]:
        raise ManifestError("evolution must initialize from a selection plan")
    verify_locked_inputs(
        plan_path=plan_path, workspace=plan_path.parent, plan=plan
    )
    authority_digest = _require_string(
        plan.get("authority", {}).get("digest"), "plan.authority.digest"
    )
    baseline = plan.get("baseline")
    if (
        not isinstance(baseline, dict)
        or baseline.get("kind") != "old_skill"
        or not isinstance(baseline.get("digest"), str)
    ):
        raise ManifestError("evolution requires a pinned old_skill baseline")
    state_path = workspace / "evolution-state.json"
    if state_path.exists():
        raise ManifestError("evolution-state.json already exists")
    evolution_id = f"evo-{sha256_json({'authority': authority_digest, 'baseline': baseline.get('digest')})[:20]}"
    state = {
        "schema_version": EVOLUTION_STATE_SCHEMA,
        "evolution_id": evolution_id,
        "authority_digest": authority_digest,
        "baseline": baseline,
        "initialized_from_plan": str(plan_path.resolve()),
        "max_rounds": 3,
        "current_round": 1,
        "status": "optimizing",
        "next_action": "propose_candidate",
        "terminal": False,
        "audit_consumed": False,
        "selected_subject_digest": None,
        "seen_run_ids": [],
        "history": [],
    }
    write_json(state_path, state)
    return state


def advance_evolution(*, state_path: Path, decision_path: Path) -> dict[str, Any]:
    state = load_json(state_path)
    decision = load_json(decision_path)
    if state.get("schema_version") != EVOLUTION_STATE_SCHEMA:
        raise ManifestError(f"evolution state schema must be {EVOLUTION_STATE_SCHEMA}")
    plan, _evidence = _validate_bound_decision(decision, decision_path)
    if state.get("authority_digest") != decision.get("authority_digest"):
        raise ManifestError("evolution authority changed; user confirmation requires a new run")
    if state.get("baseline") != decision.get("baseline"):
        raise ManifestError("accepted old_skill baseline changed during evolution")
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
    reserved = {
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
    return {
        key: float(value)
        for key, value in arm.items()
        if key not in reserved
        and isinstance(value, (int, float))
        and not isinstance(value, bool)
    }


def project_dashboard(
    *, workspace: Path, output: Path, state_path: Path | None = None
) -> dict[str, Any]:
    workspace = workspace.resolve()
    plan_path = workspace / "execution-plan.json"
    plan = load_json(plan_path)
    if plan.get("schema_version") != PLAN_SCHEMA:
        raise ManifestError(f"execution plan schema must be {PLAN_SCHEMA}")
    evidence = _load_optional_json(workspace / "verification-evidence.json")
    resolved_state_path = (
        state_path.resolve() if state_path is not None else workspace / "evolution-state.json"
    )
    state = _load_optional_json(resolved_state_path)
    if state is not None and state.get("schema_version") != EVOLUTION_STATE_SCHEMA:
        raise ManifestError(f"evolution state schema must be {EVOLUTION_STATE_SCHEMA}")
    decisions: list[dict[str, Any]] = []
    decision_paths = set(workspace.glob("iteration-*/*decision.json"))
    if state is not None:
        for record in state.get("history", []):
            if isinstance(record, dict) and isinstance(record.get("decision_path"), str):
                decision_paths.add(Path(record["decision_path"]).resolve())
    for decision_path in sorted(decision_paths):
        decision = load_json(decision_path)
        if decision.get("schema_version") != ACCEPTANCE_SCHEMA:
            raise ManifestError(f"acceptance decision schema must be {ACCEPTANCE_SCHEMA}")
        decisions.append(
            {
                **decision,
                "artifact": str(decision_path.relative_to(workspace))
                if _is_within(decision_path, workspace)
                else str(decision_path),
            }
        )
    decisions.sort(key=_decision_sort_key)
    latest_decision = decisions[-1] if decisions else None
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
        spine.append(
            {
                "id": f"iteration:{decision.get('iteration')}:{decision.get('phase')}",
                "kind": "iteration",
                "parent_id": f"run:{plan.get('run_id')}",
                "label": f"Round {decision.get('iteration')} · {decision.get('phase')}",
                "status": decision.get("status"),
                "artifact": decision.get("artifact"),
            }
        )

    case_rows: list[dict[str, Any]] = []
    for planned_case in plan.get("cases", []):
        case_id = str(planned_case.get("id"))
        result = evidence_cases.get(case_id, {})
        candidate = result.get("with_skill")
        if not isinstance(candidate, dict):
            case_status = "pending"
        elif candidate.get("complete") is not True:
            case_status = "incomplete"
        elif candidate.get("passed") is True and not result.get(
            "direction_disagreement"
        ):
            case_status = "passed"
        else:
            case_status = "failed"
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
                "arms": arms,
                "semantic_assertions": result.get("semantic_assertions", []),
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
            "integrity": (evidence or {}).get("integrity"),
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
        "limitations": (evidence or {}).get("limitations", []),
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
        help="Compile only this eval case; repeat the flag for more cases.",
    )
    compile_parser.add_argument("--baseline-path", type=Path)
    compile_parser.add_argument(
        "--split",
        action="append",
        choices=["development", "selection", "audit"],
        dest="splits",
        help="Compile only this data split; repeat the flag to select more than one.",
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

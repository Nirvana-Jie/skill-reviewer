#!/usr/bin/env python3
"""Compile and verify executable Eval authority from pinned source inputs.

This deep module owns Manifest normalization, immutable file identity, frozen
plan compilation, and full lock reconstruction. It has no provider, grading,
evolution, or Dashboard behavior, so package lint and every executor can apply
the same fail-closed authority before external work begins.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import stat
import tempfile
from pathlib import Path
from typing import Any, Iterable

from skill_eval_contracts import (
    ASSIGNMENT_CONTRACT,
    DETERMINISTIC_ASSERTION_TYPES,
    MANIFEST_CONTRACT,
    ManifestError,
    PLAN_CONTRACT,
    RUN_LOCK_CONTRACT,
    SEMANTIC_ASSERTION_TYPES,
)
from skill_eval_evidence import build_artifact_ownership
from skill_eval_measurement import (
    CALIBRATION_FIELDS,
    TEXT_ASSERTION_TYPES,
    assess_oracle,
    evaluate_text_assertion,
    normalize_sampling,
)


PATH_SAFE_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
ASSERTION_TYPES = DETERMINISTIC_ASSERTION_TYPES | SEMANTIC_ASSERTION_TYPES
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
    "sampling",
}
OPAQUE_EVAL_FIELDS = {
    "id",
    "purpose",
    "split",
    "determinism",
    "holdout",
    "timeout_seconds",
    "permissions",
    "sampling",
}
ASSERTION_COMMON_FIELDS = {"id", "type", "artifact", "severity"}
ASSERTION_FIELDS = {
    "file_exists": ASSERTION_COMMON_FIELDS,
    "text_contains": ASSERTION_COMMON_FIELDS | {"expected", "calibration"},
    "text_not_contains": ASSERTION_COMMON_FIELDS | {"expected", "calibration"},
    "text_matches": ASSERTION_COMMON_FIELDS | {"pattern", "calibration"},
    "text_not_matches": ASSERTION_COMMON_FIELDS | {"pattern", "calibration"},
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


def require_finite_json(value: Any, label: str) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ManifestError(f"JSON artifact contains a non-finite number: {label}")
    if isinstance(value, dict):
        for key, item in value.items():
            require_finite_json(item, f"{label}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            require_finite_json(item, f"{label}[{index}]")


def reject_json_constant(constant: str) -> None:
    raise ValueError(f"non-finite JSON constant: {constant}")


def load_json_value(path: Path) -> Any:
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=reject_json_constant,
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
        raise ManifestError(
            f"JSON artifact contains a non-finite number: {path}"
        ) from error
    require_finite_json(value, str(path))
    return value


def load_json(path: Path) -> dict[str, Any]:
    value = load_json_value(path)
    if not isinstance(value, dict):
        raise ManifestError("manifest root must be an object")
    return value


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


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{label} must be a non-empty string")
    return value.strip()


def reject_unsupported_fields(
    value: dict[str, Any], allowed: set[str], label: str
) -> None:
    unsupported = sorted(set(value) - allowed)
    if unsupported:
        raise ManifestError(
            f"{label} contains unsupported fields: {', '.join(unsupported)}"
        )


def safe_subject_file(subject: Path, relative: str, label: str) -> Path:
    subject = subject.resolve()
    path = Path(os.path.abspath(subject / relative))
    try:
        relative_path = path.relative_to(subject)
    except ValueError as error:
        raise ManifestError(
            f"{label} escapes the subject directory: {relative}"
        ) from error
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


def safe_artifact(root: Path, relative: str) -> Path:
    resolved_root = root.resolve()
    lexical = Path(os.path.abspath(root / relative))
    try:
        relative_path = lexical.relative_to(resolved_root)
    except ValueError as error:
        raise ManifestError(
            f"artifact path escapes its execution root: {relative}"
        ) from error
    current = resolved_root
    for part in relative_path.parts:
        current = current / part
        if current.is_symlink():
            raise ManifestError(
                f"artifact path contains a symbolic link: {relative}"
            )
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


def require_real_directory(path: Path, root: Path, label: str) -> Path:
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


def validate_artifact_path(value: Any, label: str) -> str:
    relative = require_string(value, label)
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise ManifestError(f"{label} must stay inside its execution root")
    return path.as_posix()


def require_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ManifestError(f"{label} must be a number")
    try:
        numeric = float(value)
    except OverflowError as error:
        raise ManifestError(f"{label} must be finite") from error
    if not math.isfinite(numeric):
        raise ManifestError(f"{label} must be finite")
    return numeric


def trace_assignment_context(
    *, assignment_path: Path, workspace: Path
) -> tuple[dict[str, Any], Path, Path]:
    workspace = workspace.resolve()
    assignment = load_json(assignment_path)
    if assignment.get("contract") != ASSIGNMENT_CONTRACT:
        raise ManifestError(f"assignment contract must be {ASSIGNMENT_CONTRACT}")
    case_id = require_string(assignment.get("case_id"), "assignment.case_id")
    arm = require_string(assignment.get("arm"), "assignment.arm")
    repeat = assignment.get("repeat")
    if not isinstance(repeat, int) or isinstance(repeat, bool) or repeat < 1:
        raise ManifestError("assignment.repeat must be a positive integer")
    expected_assignment = safe_artifact(
        workspace,
        (Path("assignments") / case_id / arm / f"repeat-{repeat}.json").as_posix(),
    )
    if assignment_path.resolve() != expected_assignment.resolve():
        raise ManifestError("assignment path does not match its bound identity")
    repeat_root = require_real_directory(
        workspace / "cases" / case_id / arm / f"repeat-{repeat}",
        workspace,
        "repeat root",
    )
    writable_root = Path(
        require_string(assignment.get("writable_root"), "assignment.writable_root")
    ).resolve()
    if writable_root != repeat_root:
        raise ManifestError(
            "assignment writable_root does not match its repeat root"
        )
    trace_artifact = validate_artifact_path(
        assignment.get("trace_artifact"), "assignment.trace_artifact"
    )
    return assignment, repeat_root, safe_artifact(repeat_root, trace_artifact)


def validate_assertions(assertions: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(assertions, list) or not assertions:
        raise ManifestError(f"{label} must be a non-empty array")
    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, assertion in enumerate(assertions):
        assertion_label = f"{label}[{index}]"
        if not isinstance(assertion, dict):
            raise ManifestError(f"{assertion_label} must be an object")
        assertion_id = require_string(assertion.get("id"), f"{assertion_label}.id")
        if assertion_id in seen:
            raise ManifestError(f"duplicate assertion id in {label}: {assertion_id}")
        seen.add(assertion_id)
        assertion_type = assertion.get("type")
        if assertion_type not in ASSERTION_TYPES:
            raise ManifestError(
                f"{assertion_label} uses unsupported assertion type: {assertion_type}"
            )
        reject_unsupported_fields(
            assertion, ASSERTION_FIELDS[assertion_type], assertion_label
        )
        artifact = validate_artifact_path(
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
            pattern = require_string(
                assertion.get("pattern"), f"{assertion_label}.pattern"
            )
            try:
                re.compile(pattern)
            except re.error as error:
                raise ManifestError(
                    f"{assertion_label}.pattern is invalid: {error}"
                ) from error
        elif assertion_type == "json_path":
            pointer = require_string(
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
            require_string(assertion.get("event"), f"{assertion_label}.event")
        elif assertion_type == "digest_equals":
            digest = require_string(
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
                require_number(assertion["minimum"], f"{assertion_label}.minimum")
            if "maximum" in assertion:
                require_number(assertion["maximum"], f"{assertion_label}.maximum")
            pointer = assertion.get("path")
            if pointer is not None and (
                not isinstance(pointer, str)
                or (pointer and not pointer.startswith("/"))
            ):
                raise ManifestError(
                    f"{assertion_label}.path must be an RFC 6901 JSON Pointer"
                )
        elif assertion_type == "semantic_pair":
            rubric = require_string(
                assertion.get("rubric"), f"{assertion_label}.rubric"
            )
            inputs = assertion.get("inputs")
            if not isinstance(inputs, list) or not inputs:
                raise ManifestError(
                    f"{assertion_label}.inputs must be a non-empty array"
                )
            normalized_inputs = [
                validate_artifact_path(value, f"{assertion_label}.inputs[{index}]")
                for index, value in enumerate(inputs)
            ]
            if len(set(normalized_inputs)) != len(normalized_inputs):
                raise ManifestError(f"{assertion_label}.inputs must be unique")
            assertion = {
                **assertion,
                "rubric": rubric,
                "inputs": normalized_inputs,
            }
        if assertion_type in TEXT_ASSERTION_TYPES and "calibration" in assertion:
            calibration = assertion.get("calibration")
            if not isinstance(calibration, dict):
                raise ManifestError(
                    f"{assertion_label}.calibration must be an object"
                )
            reject_unsupported_fields(
                calibration,
                CALIBRATION_FIELDS,
                f"{assertion_label}.calibration",
            )
            normalized_calibration: dict[str, list[str]] = {}
            for field in ("pass_examples", "fail_examples"):
                examples = calibration.get(field)
                if not isinstance(examples, list) or not examples or not all(
                    isinstance(example, str) and example for example in examples
                ):
                    raise ManifestError(
                        f"{assertion_label}.calibration.{field} must be a non-empty string array"
                    )
                normalized_calibration[field] = list(examples)
            assertion = {**assertion, "calibration": normalized_calibration}
            failed_pass = [
                index
                for index, example in enumerate(
                    normalized_calibration["pass_examples"]
                )
                if not evaluate_text_assertion(assertion, example)
            ]
            failed_fail = [
                index
                for index, example in enumerate(
                    normalized_calibration["fail_examples"]
                )
                if evaluate_text_assertion(assertion, example)
            ]
            if failed_pass or failed_fail:
                failures = [
                    *(f"pass_examples[{index}]" for index in failed_pass),
                    *(f"fail_examples[{index}]" for index in failed_fail),
                ]
                raise ManifestError(
                    f"{assertion_label}.calibration failed the declared predicate: "
                    + ", ".join(failures)
                )
        normalized.append({**assertion, "artifact": artifact, "severity": severity})
    return normalized


def validate_objectives(objectives: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(objectives, list) or not objectives:
        raise ManifestError(f"{label} must be a non-empty array")
    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, objective in enumerate(objectives):
        objective_label = f"{label}[{index}]"
        if not isinstance(objective, dict):
            raise ManifestError(f"{objective_label} must be an object")
        reject_unsupported_fields(objective, OBJECTIVE_FIELDS, objective_label)
        objective_id = require_string(objective.get("id"), f"{objective_label}.id")
        if objective_id in seen:
            raise ManifestError(f"duplicate objective id in {label}: {objective_id}")
        seen.add(objective_id)
        metric = require_string(objective.get("metric"), f"{objective_label}.metric")
        if not re.fullmatch(r"[a-z][a-z0-9_]*", metric):
            raise ManifestError(f"{objective_label}.metric must be snake_case")
        direction = objective.get("direction")
        if direction not in {"maximize", "minimize"}:
            raise ManifestError(
                f"{objective_label}.direction must be maximize or minimize"
            )
        material = require_number(
            objective.get("min_material_delta", 0),
            f"{objective_label}.min_material_delta",
        )
        tolerance = require_number(
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
            validate_artifact_path(raw_root, f"{label}.writable_roots[{index}]")
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
    """Validate and normalize the sole executable Eval Manifest authority."""

    reject_unsupported_fields(manifest, MANIFEST_FIELDS, "manifest")
    if manifest.get("contract") != MANIFEST_CONTRACT:
        raise ManifestError(f"contract must be {MANIFEST_CONTRACT}")
    require_string(manifest.get("skill_name"), "skill_name")
    defaults = manifest.get("defaults")
    if not isinstance(defaults, dict):
        raise ManifestError("defaults must be an object")
    reject_unsupported_fields(defaults, DEFAULT_FIELDS, "defaults")
    repeats = defaults.get("repeats")
    if not isinstance(repeats, dict):
        raise ManifestError("defaults.repeats must be an object")
    reject_unsupported_fields(repeats, REPEAT_FIELDS, "defaults.repeats")
    for key, expected in (("deterministic", 1), ("stochastic", 3)):
        value = repeats.get(key)
        if not isinstance(value, int) or value < 1:
            raise ManifestError(
                f"defaults.repeats.{key} must be a positive integer"
            )
        if value != expected:
            raise ManifestError(f"defaults.repeats.{key} must be {expected}")
    evolution = defaults.get("evolution")
    if not isinstance(evolution, dict):
        raise ManifestError("defaults.evolution must be an object")
    reject_unsupported_fields(evolution, EVOLUTION_FIELDS, "defaults.evolution")
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
        eval_id = require_string(item.get("id"), f"{label}.id")
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
        try:
            sampling = normalize_sampling(
                item.get("sampling"),
                legacy_repeats=int(repeats[determinism]),
                determinism=str(determinism),
            )
        except ValueError as error:
            raise ManifestError(f"{label}.{error}") from error
        require_string(item.get("purpose"), f"{label}.purpose")
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
            reject_unsupported_fields(item, OPAQUE_EVAL_FIELDS, label)
            asset_id = require_string(
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
            reject_unsupported_fields(item, PUBLIC_EVAL_FIELDS, label)
            if "asset_id" in raw_holdout:
                raise ManifestError(
                    f"{label}.holdout.asset_id is allowed only for opaque holdout"
                )
            holdout = {"visibility": "public", "asset_id": None}
            prompt = require_string(item.get("prompt"), f"{label}.prompt")
            files = item.get("files", [])
            if not isinstance(files, list) or not all(
                isinstance(value, str) for value in files
            ):
                raise ManifestError(f"{label}.files must be an array of paths")
            files = [
                validate_artifact_path(value, f"{label}.files[{file_index}]")
                for file_index, value in enumerate(files)
            ]
            if len(set(files)) != len(files):
                raise ManifestError(f"{label}.files must be unique")
            file_records = [
                {
                    "path": relative,
                    "digest": sha256_runtime_file(
                        safe_subject_file(subject, relative, f"{label}.files")
                    ),
                }
                for relative in files
            ]
            assertions = validate_assertions(
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
            objectives = validate_objectives(
                item.get("objectives"), f"{label}.objectives"
            )
        oracle = assess_oracle(assertions)
        if (
            split in {"selection", "audit"}
            and visibility == "public"
            and oracle["status"] != "valid"
        ):
            raise ManifestError(
                f"{label}.assertions must calibrate every must_pass text predicate before {split}: "
                + ", ".join(oracle["reasons"])
            )
        timeout_seconds = item.get("timeout_seconds", default_timeout)
        if (
            not isinstance(timeout_seconds, int)
            or isinstance(timeout_seconds, bool)
            or timeout_seconds <= 0
        ):
            raise ManifestError(
                f"{label}.timeout_seconds must be a positive integer"
            )
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
                "sampling": sampling,
                "oracle": oracle,
                "repeats": sampling["repeats"],
                "timeout_seconds": timeout_seconds,
                "permissions": resolved_permissions,
            }
        )
    return normalized


# Frozen plan compilation and manifest-derived lock verification.
RUNTIME_SKILL_ENTRIES = ("SKILL.md", "references", "scripts", "assets")
EXECUTION_PROFILE_FIELDS = {
    "target",
    "harness",
    "dispatch_observation",
    "trace",
    "capabilities",
    "isolation",
    "sampling",
}
EXECUTION_PROFILE_TRACE_FIELDS = {"capture_source", "source"}
EXECUTION_PROFILE_SOURCE_FIELDS = {"artifact", "format"}
DISPATCH_OBSERVATIONS = {
    "host_dispatch",
    "process_spawn",
    "external_harness",
}
TRACE_CAPTURE_SOURCE_PATTERN = re.compile(r"[a-z][a-z0-9_.-]{0,63}")


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
        path_is_within(lexical, root) or path_is_within(root, lexical)
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
    target = require_string(raw.get("target"), "execution_profile.target")
    harness = require_string(raw.get("harness"), "execution_profile.harness")
    dispatch_observation = require_string(
        raw.get("dispatch_observation"),
        "execution_profile.dispatch_observation",
    )
    if dispatch_observation not in DISPATCH_OBSERVATIONS:
        raise ManifestError(
            "execution_profile.dispatch_observation must be host_dispatch, "
            "process_spawn, or external_harness"
        )
    trace = raw.get("trace")
    if not isinstance(trace, dict):
        raise ManifestError("execution_profile.trace must be an object")
    unknown_trace = sorted(set(trace) - EXECUTION_PROFILE_TRACE_FIELDS)
    if unknown_trace:
        raise ManifestError(
            "execution_profile.trace contains unsupported fields: "
            + ", ".join(unknown_trace)
        )
    missing_trace = sorted(EXECUTION_PROFILE_TRACE_FIELDS - set(trace))
    if missing_trace:
        raise ManifestError(
            "execution_profile.trace is missing fields: " + ", ".join(missing_trace)
        )
    capture_source = require_string(
        trace.get("capture_source"), "execution_profile.trace.capture_source"
    )
    if TRACE_CAPTURE_SOURCE_PATTERN.fullmatch(capture_source) is None:
        raise ManifestError(
            "execution_profile.trace.capture_source must be a lowercase trace adapter slug"
        )
    source = trace.get("source")
    normalized_source: dict[str, str] | None
    if source is None:
        normalized_source = None
    elif isinstance(source, dict):
        unknown_source = sorted(set(source) - EXECUTION_PROFILE_SOURCE_FIELDS)
        if unknown_source:
            raise ManifestError(
                "execution_profile.trace.source contains unsupported fields: "
                + ", ".join(unknown_source)
            )
        missing_source = sorted(EXECUTION_PROFILE_SOURCE_FIELDS - set(source))
        if missing_source:
            raise ManifestError(
                "execution_profile.trace.source is missing fields: "
                + ", ".join(missing_source)
            )
        normalized_source = {
            "artifact": validate_artifact_path(
                source.get("artifact"), "execution_profile.trace.source.artifact"
            ),
            "format": require_string(
                source.get("format"), "execution_profile.trace.source.format"
            ),
        }
    else:
        raise ManifestError("execution_profile.trace.source must be an object or null")
    isolation = require_string(
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
    require_finite_json(sampling, "execution_profile.sampling")
    normalized = {
        "target": target,
        "harness": harness,
        "dispatch_observation": dispatch_observation,
        "trace": {
            "capture_source": capture_source,
            "source": normalized_source,
        },
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


def path_is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def require_empty_workspace(
    workspace: Path, protected_roots: Iterable[Path]
) -> None:
    resolved = workspace.resolve()
    for root in protected_roots:
        protected = root.resolve()
        if path_is_within(resolved, protected) or path_is_within(protected, resolved):
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
            safe_source = safe_subject_file(
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
            safe_source = safe_subject_file(
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
    if not path_is_within(eval_root, subject):
        raise ManifestError("eval authority must stay inside the subject directory")
    semantic_contract_path = (
        Path(__file__).resolve().parents[1]
        / "assets"
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
                    safe_subject_file(subject, relative, "declared eval fixture")
                )
    shared_manifest = {
        key: value for key, value in manifest.items() if key != "evals"
    }
    scripts_root = Path(__file__).resolve().parent
    grader_files = {
        name: sha256_file(scripts_root / name)
        for name in (
            "skill_eval_authority.py",
            "skill_eval_contracts.py",
            "skill_eval_decision.py",
            "skill_eval_evidence.py",
            "skill_eval_grading.py",
            "skill_eval_measurement.py",
        )
    }
    identity = {
        "authoritative_manifest_digest": sha256_json(
            {**shared_manifest, "evals": authoritative_evals}
        ),
        "authoritative_fixture_digests": dict(
            sorted(authoritative_fixture_digests.items())
        ),
        "grader_digest": sha256_json(grader_files),
        "grader_files": grader_files,
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
        "grader_path": str(scripts_root / "skill_eval_grading.py"),
        "semantic_grader_contract_path": str(semantic_contract_path),
        "digest": sha256_json(identity),
        "development_digest": sha256_json(development_identity),
    }


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
                (str(case["id"]), str(record["path"])): safe_subject_file(
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
        path_is_within(pack_path, root) or path_is_within(root, pack_path)
        for root in protected_roots
    ):
        raise ManifestError(
            "holdout pack must stay outside candidate, baseline, and run workspaces"
        )
    pack = load_json(pack_path)
    if set(pack) != {"issuer", "assets"}:
        raise ManifestError("holdout pack must contain only issuer and assets")
    issuer = require_string(pack.get("issuer"), "holdout_pack.issuer")
    assets = pack.get("assets")
    if not isinstance(assets, dict):
        raise ManifestError("holdout_pack.assets must be an object")
    resolved_cases: list[dict[str, Any]] = []
    sources: dict[tuple[str, str], Path] = {}
    fixture_digests: dict[str, str] = {}
    for case in cases:
        case_id = str(case["id"])
        asset_id = require_string(
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
        prompt = require_string(
            asset.get("prompt"), f"holdout_pack.assets.{asset_id}.prompt"
        )
        asset_files = asset.get("files")
        if not isinstance(asset_files, dict):
            raise ManifestError(f"opaque holdout asset files are invalid: {asset_id}")
        logical_paths = [
            validate_artifact_path(
                logical_path,
                f"holdout_pack.assets.{asset_id}.files.{logical_path}",
            )
            for logical_path in asset_files
        ]
        if len(set(logical_paths)) != len(logical_paths):
            raise ManifestError(f"opaque holdout asset files are duplicated: {asset_id}")
        assertions = validate_assertions(
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
        objectives = validate_objectives(
            asset.get("objectives"),
            f"holdout_pack.assets.{asset_id}.objectives",
        )
        oracle = assess_oracle(assertions)
        if oracle["status"] != "valid":
            raise ManifestError(
                f"holdout_pack.assets.{asset_id}.assertions must calibrate every must_pass text predicate: "
                + ", ".join(oracle["reasons"])
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
                path_is_within(source, root) or path_is_within(root, source)
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
                "oracle": oracle,
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
                extra["without_skill_na_reason"] = require_string(
                    without_skill_config.get("reason"),
                    f"eval {case['id']}.without_skill.reason",
                )
        cases_with_arms.append({**case, **extra, "arms": arms})
    return cases_with_arms


def _artifact_ownership(
    case: dict[str, Any], execution_profile: dict[str, Any]
) -> dict[str, Any]:
    ownership = build_artifact_ownership(case, execution_profile)
    if not isinstance(ownership.get("worker"), list) or not isinstance(
        ownership.get("framework"), list
    ):
        raise ManifestError("artifact ownership contract is invalid")
    return ownership


def runtime_skill_file_digests(source: Path) -> dict[str, str]:
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
            source_file = safe_subject_file(
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
    return sha256_json(runtime_skill_file_digests(source))


def locked_skill_snapshot_path(plan: dict[str, Any], arm: str) -> Path:
    """Resolve an arm's immutable Skill snapshot and verify its bound digest."""

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
    path = Path(require_string(records[0].get("path"), f"{arm} snapshot.path"))
    expected_digest = records[0].get("digest")
    if not path.is_dir() or runtime_skill_digest(path) != expected_digest:
        raise ManifestError(f"candidate plan {arm} snapshot changed")
    return path


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
    require_empty_workspace(workspace, protected_roots)
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
                snapshot_path = safe_artifact(
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
        artifact_ownership = _artifact_ownership(case, execution_profile)
        expected_artifacts = artifact_ownership["worker"]
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
                input_root = safe_artifact(
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
                    isolated_path = safe_artifact(
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
                    "source_trace_artifact": (
                        execution_profile["trace"]["source"]["artifact"]
                        if execution_profile["trace"]["source"] is not None
                        else None
                    ),
                    "trace_artifact": "agent-trace.jsonl",
                    "artifact_ownership": artifact_ownership,
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


def _strict_tree_file_digests(root: Path) -> dict[str, str]:
    if not root.exists():
        return {}
    if not root.is_dir() or root.is_symlink():
        raise ManifestError(f"locked tree must be a real directory: {root}")
    return {
        path.relative_to(root).as_posix(): sha256_file(path)
        for path in iter_strict_files(root, "locked tree")
    }


def verify_locked_inputs(
    *, plan_path: Path, workspace: Path, plan: dict[str, Any]
) -> dict[str, Any]:
    workspace = workspace.resolve()
    plan_path = plan_path.resolve()
    if plan_path != workspace / "execution-plan.json":
        raise ManifestError("execution plan path is not canonical")
    lock_path = safe_artifact(workspace, "run-lock.json")
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
        require_string(subject.get("path"), "plan.subject.path")
    ).resolve()
    manifest_path = Path(
        require_string(manifest.get("path"), "plan.manifest.path")
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
            require_string(baseline.get("path"), "plan.baseline.path")
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
        path_is_within(workspace, root) or path_is_within(root, workspace)
        for root in protected_roots
    ):
        raise ManifestError(
            "run workspace overlaps the candidate or baseline package"
        )
    profile_path = Path(
        require_string(
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
            source_files = runtime_skill_file_digests(source)
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
        artifact_ownership = _artifact_ownership(case, expected_execution_profile)
        expected_artifacts = artifact_ownership["worker"]
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
                    "source_trace_artifact": (
                        expected_execution_profile["trace"]["source"]["artifact"]
                        if expected_execution_profile["trace"]["source"] is not None
                        else None
                    ),
                    "trace_artifact": "agent-trace.jsonl",
                    "artifact_ownership": artifact_ownership,
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

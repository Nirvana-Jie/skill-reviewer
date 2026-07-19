#!/usr/bin/env python3
"""Executable Eval Manifest and immutable file-identity authority.

This deep module owns the public Manifest schema and its normalization.  It has
no workspace, provider, grading, evolution, or Dashboard behavior, allowing the
package linter and Runtime façade to depend on the same deterministic authority
without loading one another.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
from pathlib import Path
from typing import Any

from skill_eval_contracts import (
    ASSIGNMENT_CONTRACT,
    MANIFEST_CONTRACT,
    ManifestError,
)
from skill_eval_measurement import (
    CALIBRATION_FIELDS,
    TEXT_ASSERTION_TYPES,
    assess_oracle,
    evaluate_text_assertion,
    normalize_sampling,
)


PATH_SAFE_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
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

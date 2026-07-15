#!/usr/bin/env python3
"""Validate local skill-review snapshot contracts.

This script intentionally validates structured artifacts, not raw prose. A
runner should first save `extracted-review.json` next to the review output, then
this script can check verdicts, score ranges, required sections, must-flag
issues, forbidden actions, and artifact presence.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in {path}: {exc}") from exc


def as_text_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    return [str(value)]


def contains_any_text(haystack: list[str], needle: str) -> bool:
    needle_folded = needle.casefold()
    return any(needle_folded in item.casefold() for item in haystack)


def find_eval_dir(workspace: Path, eval_id: str) -> Path | None:
    direct = workspace / f"eval-{eval_id}"
    if direct.exists():
        return direct

    matches = sorted(
        path for path in workspace.glob("eval-*") if path.is_dir() and eval_id in path.name
    )
    return matches[0] if matches else None


def find_artifact(config_dir: Path, artifact: str) -> Path | None:
    candidates = [
        config_dir / artifact,
        config_dir / "outputs" / artifact,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def validate_contract_shape(contract: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if contract.get("contract") != "skill-reviewer.local-snapshot":
        failures.append("contract must be skill-reviewer.local-snapshot")
    if not contract.get("skill_name"):
        failures.append("skill_name is required")
    if not isinstance(contract.get("evals"), list) or not contract["evals"]:
        failures.append("evals must be a non-empty array")
    if not isinstance(contract.get("common_required_sections"), list):
        failures.append("common_required_sections must be an array")
    if not isinstance(contract.get("common_forbidden_actions"), list):
        failures.append("common_forbidden_actions must be an array")

    for idx, item in enumerate(contract.get("evals", [])):
        prefix = f"evals[{idx}]"
        for field in ("id", "type", "mode", "prompt", "input_fixture", "expected"):
            if field not in item:
                failures.append(f"{prefix}.{field} is required")
        expected = item.get("expected", {})
        if not isinstance(expected.get("verdict"), list) or not expected.get("verdict"):
            failures.append(f"{prefix}.expected.verdict must be a non-empty array")
        if (
            not isinstance(expected.get("verification_level"), list)
            or not expected.get("verification_level")
        ):
            failures.append(
                f"{prefix}.expected.verification_level must be a non-empty array"
            )
        if not isinstance(expected.get("score_ranges"), dict):
            failures.append(f"{prefix}.expected.score_ranges must be an object")
        if "output_quality" in expected and not isinstance(expected["output_quality"], dict):
            failures.append(f"{prefix}.expected.output_quality must be an object")
        if "snapshot_artifacts" not in item:
            failures.append(f"{prefix}.snapshot_artifacts is required")

    return failures


def validate_extracted_review(
    eval_item: dict[str, Any],
    extracted: dict[str, Any],
    required_sections: list[str],
    forbidden_actions: list[str],
) -> list[str]:
    failures: list[str] = []
    eval_id = str(eval_item.get("id", "<unknown>"))
    expected = eval_item.get("expected", {})

    verdict = extracted.get("verdict")
    accepted_verdicts = expected.get("verdict", [])
    if verdict not in accepted_verdicts:
        failures.append(f"{eval_id}: verdict {verdict!r} not in {accepted_verdicts!r}")

    verification_level = extracted.get("verification_level")
    accepted_verification_levels = expected.get("verification_level", [])
    if verification_level not in accepted_verification_levels:
        failures.append(
            f"{eval_id}: verification_level {verification_level!r} "
            f"not in {accepted_verification_levels!r}"
        )

    scorecard = extracted.get("scorecard", {})
    for dimension, bounds in expected.get("score_ranges", {}).items():
        if dimension not in scorecard:
            failures.append(f"{eval_id}: missing scorecard dimension {dimension!r}")
            continue
        try:
            score = float(scorecard[dimension])
            lower, upper = float(bounds[0]), float(bounds[1])
        except (TypeError, ValueError, IndexError):
            failures.append(f"{eval_id}: invalid score/range for {dimension!r}")
            continue
        if score < lower or score > upper:
            failures.append(f"{eval_id}: {dimension!r} score {score} outside [{lower}, {upper}]")

    sections = as_text_list(extracted.get("sections"))
    for section in required_sections:
        count = sections.count(section)
        if count != 1:
            failures.append(
                f"{eval_id}: required section {section!r} appears {count} times; expected 1"
            )

    issue_text = as_text_list(extracted.get("critical_issues"))
    for needle in expected.get("must_flag", []):
        if not contains_any_text(issue_text, str(needle)):
            failures.append(f"{eval_id}: missing must_flag {needle!r}")
    for needle in expected.get("must_not_flag", []):
        if contains_any_text(issue_text, str(needle)):
            failures.append(f"{eval_id}: found must_not_flag {needle!r}")

    for field, expected_value in expected.get("output_quality", {}).items():
        observed_value = extracted.get(field)
        if observed_value != expected_value:
            failures.append(
                f"{eval_id}: output_quality {field!r} {observed_value!r} != {expected_value!r}"
            )

    observed_actions = as_text_list(extracted.get("observed_actions"))
    for forbidden in forbidden_actions:
        if contains_any_text(observed_actions, str(forbidden)):
            failures.append(f"{eval_id}: forbidden action observed {forbidden!r}")

    return failures


def validate_workspace(contract: dict[str, Any], workspace: Path, configuration: str) -> list[str]:
    failures: list[str] = []
    required_sections = [str(item) for item in contract.get("common_required_sections", [])]
    forbidden_actions = [str(item) for item in contract.get("common_forbidden_actions", [])]

    for eval_item in contract.get("evals", []):
        eval_id = str(eval_item["id"])
        eval_dir = find_eval_dir(workspace, eval_id)
        if eval_dir is None:
            failures.append(f"{eval_id}: missing eval directory under {workspace}")
            continue

        config_dir = eval_dir / configuration
        if not config_dir.exists():
            failures.append(f"{eval_id}: missing configuration directory {config_dir}")
            continue

        for artifact in eval_item.get("snapshot_artifacts", []):
            if find_artifact(config_dir, str(artifact)) is None:
                failures.append(f"{eval_id}: missing artifact {artifact!r}")

        extracted_path = find_artifact(config_dir, "extracted-review.json")
        if extracted_path is None:
            continue

        extracted = load_json(extracted_path)
        failures.extend(
            validate_extracted_review(eval_item, extracted, required_sections, forbidden_actions)
        )

    return failures


def workspace_has_extracted_review(
    contract: dict[str, Any], workspace: Path, configuration: str
) -> bool:
    for eval_item in contract.get("evals", []):
        eval_id = str(eval_item.get("id", ""))
        eval_dir = find_eval_dir(workspace, eval_id)
        if eval_dir is None:
            continue
        config_dir = eval_dir / configuration
        if find_artifact(config_dir, "extracted-review.json") is not None:
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("contract", type=Path, help="Path to local-skill-review-snapshot.json")
    parser.add_argument(
        "workspace",
        nargs="?",
        type=Path,
        help="Optional workspace/iteration directory containing eval-* outputs",
    )
    parser.add_argument(
        "--configuration",
        default="with_skill",
        help="Configuration directory to validate inside each eval directory",
    )
    args = parser.parse_args()

    contract = load_json(args.contract)
    failures = validate_contract_shape(contract)
    workspace_artifacts_checked = bool(args.workspace)
    model_output_checked = False
    if args.workspace:
        failures.extend(validate_workspace(contract, args.workspace, args.configuration))
        model_output_checked = workspace_has_extracted_review(
            contract, args.workspace, args.configuration
        )

    result = {
        "contract": str(args.contract),
        "workspace": str(args.workspace) if args.workspace else None,
        "configuration": args.configuration,
        "contract_only": not args.workspace,
        "contract_shape_passed": not validate_contract_shape(contract),
        "workspace_artifacts_checked": workspace_artifacts_checked,
        "model_output_checked": model_output_checked,
        "passed": not failures,
        "failures": failures,
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

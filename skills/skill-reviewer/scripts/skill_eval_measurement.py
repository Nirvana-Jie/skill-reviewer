#!/usr/bin/env python3
"""Pure measurement-validity rules for executable Skill evals.

This module intentionally knows nothing about workspaces, agents, or evolution
state.  It answers the smaller question that must be settled first: does the
declared deterministic oracle distinguish known-good output from known-bad
output, and is the selected sampling policy internally coherent?
"""

from __future__ import annotations

import re
from typing import Any


TEXT_ASSERTION_TYPES = {
    "text_contains",
    "text_not_contains",
    "text_matches",
    "text_not_matches",
}
CALIBRATION_FIELDS = {"pass_examples", "fail_examples"}


def evaluate_text_assertion(assertion: dict[str, Any], content: str) -> bool:
    """Apply the exact runtime text predicate to one calibration example."""

    assertion_type = assertion.get("type")
    if assertion_type in {"text_contains", "text_not_contains"}:
        raw_expected = assertion.get("expected")
        expected = [raw_expected] if isinstance(raw_expected, str) else raw_expected
        if not isinstance(expected, list) or not all(
            isinstance(value, str) for value in expected
        ):
            raise ValueError("expected must be a string or string array")
        contains_all = all(value in content for value in expected)
        return (
            contains_all
            if assertion_type == "text_contains"
            else not any(value in content for value in expected)
        )
    if assertion_type in {"text_matches", "text_not_matches"}:
        pattern = assertion.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            raise ValueError("pattern must be a non-empty string")
        matched = re.search(pattern, content, flags=re.MULTILINE) is not None
        return matched if assertion_type == "text_matches" else not matched
    raise ValueError(f"unsupported text assertion type: {assertion_type}")


def calibrate_assertion(assertion: dict[str, Any]) -> dict[str, Any]:
    """Return a content-free calibration result for one text assertion."""

    assertion_id = str(assertion.get("id", ""))
    if assertion.get("type") not in TEXT_ASSERTION_TYPES:
        return {
            "assertion_id": assertion_id,
            "status": "not_applicable",
            "pass_example_count": 0,
            "fail_example_count": 0,
            "failed_pass_examples": [],
            "failed_fail_examples": [],
        }
    calibration = assertion.get("calibration")
    if not isinstance(calibration, dict):
        return {
            "assertion_id": assertion_id,
            "status": "unverified",
            "pass_example_count": 0,
            "fail_example_count": 0,
            "failed_pass_examples": [],
            "failed_fail_examples": [],
        }
    pass_examples = calibration.get("pass_examples", [])
    fail_examples = calibration.get("fail_examples", [])
    failed_pass = [
        index
        for index, example in enumerate(pass_examples)
        if not evaluate_text_assertion(assertion, example)
    ]
    failed_fail = [
        index
        for index, example in enumerate(fail_examples)
        if evaluate_text_assertion(assertion, example)
    ]
    return {
        "assertion_id": assertion_id,
        "status": "invalid" if failed_pass or failed_fail else "valid",
        "pass_example_count": len(pass_examples),
        "fail_example_count": len(fail_examples),
        "failed_pass_examples": failed_pass,
        "failed_fail_examples": failed_fail,
    }

def assess_oracle(assertions: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate must-pass text calibration without exposing example text."""

    checks = [
        calibrate_assertion(assertion)
        for assertion in assertions
        if assertion.get("severity", "must_pass") == "must_pass"
        and assertion.get("type") in TEXT_ASSERTION_TYPES
    ]
    if any(check["status"] == "invalid" for check in checks):
        status = "invalid"
    elif any(check["status"] == "unverified" for check in checks):
        status = "unverified"
    else:
        status = "valid"
    reasons: list[str] = []
    for check in checks:
        if check["status"] == "invalid":
            reasons.append(f"assertion_calibration_failed:{check['assertion_id']}")
        elif check["status"] == "unverified":
            reasons.append(f"assertion_calibration_missing:{check['assertion_id']}")
    return {
        "status": status,
        "required_text_assertions": len(checks),
        "calibrated_text_assertions": sum(
            check["status"] == "valid" for check in checks
        ),
        "checks": checks,
        "reasons": reasons,
    }


def normalize_sampling(
    raw: object,
    *,
    legacy_repeats: int,
    determinism: str,
) -> dict[str, Any]:
    """Separate sampling from the legacy output-variability classification."""

    if raw is None:
        return {
            "repeats": legacy_repeats,
            "pairing": "paired",
            "source": "legacy-determinism",
        }
    if not isinstance(raw, dict):
        raise ValueError("sampling must be an object")
    unknown = sorted(set(raw) - {"repeats", "pairing"})
    if unknown:
        raise ValueError("sampling contains unsupported fields: " + ", ".join(unknown))
    repeats = raw.get("repeats")
    if (
        not isinstance(repeats, int)
        or isinstance(repeats, bool)
        or repeats < 1
        or repeats > 10
    ):
        raise ValueError("sampling.repeats must be an integer from 1 to 10")
    pairing = raw.get("pairing", "paired")
    if pairing != "paired":
        raise ValueError("sampling.pairing must be paired")
    if determinism == "stochastic" and repeats < 3:
        raise ValueError("stochastic evals require at least three sampling repeats")
    return {"repeats": repeats, "pairing": pairing, "source": "explicit"}


def assess_runtime_measurement(
    *,
    oracle: dict[str, Any],
    sampling: dict[str, Any],
    direction_disagreement: bool,
) -> dict[str, Any]:
    """Combine frozen-oracle and observed paired-sampling validity."""

    oracle_status = str(oracle.get("status", "unverified"))
    sampling_status = "invalid" if direction_disagreement else "valid"
    reasons = list(oracle.get("reasons", []))
    if direction_disagreement:
        reasons.append("paired_sampling_direction_disagreement")
    if "invalid" in {oracle_status, sampling_status}:
        status = "invalid"
    elif oracle_status != "valid":
        status = "unverified"
    else:
        status = "valid"
    return {
        "status": status,
        "oracle": oracle,
        "sampling": {
            "status": sampling_status,
            "repeats": sampling.get("repeats"),
            "pairing": sampling.get("pairing"),
            "source": sampling.get("source"),
            "direction_disagreement": direction_disagreement,
        },
        "reasons": sorted(set(str(reason) for reason in reasons)),
    }

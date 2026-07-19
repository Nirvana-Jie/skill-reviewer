#!/usr/bin/env python3
"""Artifact-ownership rules for retained Agent execution evidence."""

from __future__ import annotations

from typing import Any


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


def declared_assertion_artifacts(case: dict[str, Any]) -> list[str]:
    """Return every artifact read by a declared deterministic or semantic oracle."""

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


def build_artifact_ownership(
    case: dict[str, Any], execution_profile: dict[str, Any]
) -> dict[str, Any]:
    """Partition asserted artifacts into Agent-owned and framework-owned sets."""

    framework = {
        "execution.json": "framework_execution",
        "dispatch-receipt.json": "framework_dispatch",
        "agent-trace.jsonl": "framework_trace",
    }
    trace = execution_profile.get("trace")
    source = trace.get("source") if isinstance(trace, dict) else None
    if isinstance(source, dict) and isinstance(source.get("artifact"), str):
        framework[str(source["artifact"])] = "provider_source_trace"
    declared = declared_assertion_artifacts(case)
    worker = [artifact for artifact in declared if artifact not in framework]
    asserted_framework = [artifact for artifact in declared if artifact in framework]
    return {
        "worker": worker,
        "framework": [
            {"artifact": artifact, "role": role}
            for artifact, role in sorted(framework.items())
        ],
        "asserted_framework": asserted_framework,
    }

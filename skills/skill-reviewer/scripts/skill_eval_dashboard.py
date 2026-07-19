#!/usr/bin/env python3
"""Project immutable Eval evidence into the Dashboard decision read model."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from skill_eval_authority import (
    load_json,
    locked_skill_snapshot_path,
    require_string,
    runtime_skill_file_digests,
    safe_artifact,
    safe_subject_file,
    sha256_file,
    sha256_json,
    verify_locked_inputs,
    write_json,
)
from skill_eval_contracts import (
    DASHBOARD_CONTRACT,
    DASHBOARD_DIFF_CONTRACT,
    ManifestError,
    PLAN_CONTRACT,
)
from skill_eval_decision import load_dashboard_decision_context
from skill_eval_grading import RESERVED_ARM_RESULT_FIELDS, grade_run

DASHBOARD_DIFF_RENDER_LIMIT_BYTES = 512 * 1024
DASHBOARD_EVIDENCE_SOURCE_LIMIT_BYTES = 2 * 1024 * 1024

_DASHBOARD_PASS_STATUSES = {
    "accepted",
    "audit-passed",
    "behavior-verified",
    "passed",
    "regression-verified",
    "retained",
}


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


def _arm_metrics(arm: dict[str, Any]) -> dict[str, float]:
    return {
        key: float(value)
        for key, value in arm.items()
        if key not in RESERVED_ARM_RESULT_FIELDS
        and isinstance(value, (int, float))
        and not isinstance(value, bool)
    }


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
    old_snapshot = locked_skill_snapshot_path(plan, "old_skill")
    new_snapshot = locked_skill_snapshot_path(plan, "with_skill")
    old_files = {
        path: digest
        for path, digest in runtime_skill_file_digests(old_snapshot).items()
        if not path.endswith("/")
    }
    new_files = {
        path: digest
        for path, digest in runtime_skill_file_digests(new_snapshot).items()
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
            source = safe_subject_file(
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
    artifact_path = safe_artifact(workspace, relative_path)
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
        measurement = case.get("measurement")
        measurement_valid = (
            isinstance(measurement, dict)
            and measurement.get("status") == "valid"
        )
        if not measurement_valid:
            status = (
                str(measurement.get("status"))
                if isinstance(measurement, dict)
                else "unverified"
            )
            signals["eval"].append(f"measurement_{status}")
            evidence_ids["eval"].add(f"case:{case_id}")
        if any(arm.get("binding_errors") for arm in arms):
            signals["execution_environment"].append("binding_error")
            evidence_ids["execution_environment"].add(f"case:{case_id}")
        if not isinstance(candidate, dict) or candidate.get("complete") is not True:
            signals["evidence"].append("candidate_evidence_incomplete")
            evidence_ids["evidence"].add(f"case:{case_id}")
        elif candidate.get("passed") is not True and measurement_valid:
            signals["skill"].append("required_assertion_failed")
            evidence_ids["skill"].add(f"case:{case_id}")
        if isinstance(candidate, dict) and (
            candidate.get("forbidden_actions") or candidate.get("side_effects")
        ):
            signals["skill"].append("unsafe_behavior_observed")
            evidence_ids["skill"].add(f"case:{case_id}")
        if case.get("regressed") is True and measurement_valid:
            signals["skill"].append("objective_regressed")
            evidence_ids["skill"].add(f"case:{case_id}")
        if case.get("direction_disagreement") is True:
            signals["eval"].append("paired_sampling_direction_disagreement")
            evidence_ids["eval"].add(f"case:{case_id}")
        if case.get("missing_objective_metrics"):
            signals["eval"].append("objective_metric_unavailable")
            evidence_ids["eval"].add(f"case:{case_id}")
        for arm in arms:
            if arm.get("id") != "with_skill" and arm.get("complete") is not True:
                signals["evidence"].append("baseline_evidence_incomplete")
                evidence_ids["evidence"].add(f"case:{case_id}")

    if isinstance(selection_decision, dict):
        decision_measurement_valid = (
            selection_decision.get("measurement_validity") == "valid"
        )
        if (
            decision_measurement_valid
            and selection_decision.get("pareto_admissible") is False
            and objectives
        ):
            signals["skill"].append("pareto_regression")
            evidence_ids["skill"].update(
                f"case:{objective.get('case_id')}" for objective in objectives
            )
        if (
            decision_measurement_valid
            and selection_decision.get("material_improvement") is False
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
            if gate_id == "measurement:valid":
                signals["eval"].append("measurement_gate_failed")
                evidence_ids["eval"].add(f"gate:{gate_id}")
            elif gate_id.endswith(":metric-present"):
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
        and (
            decision_status in {"rejected", "inconclusive", "no-change", "invalid"}
            or next_action == "propose_eval_change"
        ),
        "request_release_confirmation": next_action == "request_user_release",
    }
    recommended_action = {
        "propose_candidate": "generate_candidate",
        "prepare_audit": "prepare_audit",
        "run_authorized_selection": "rerun_execution",
        "run_authorized_audit": "rerun_execution",
        "request_user_release": "request_release_confirmation",
        "propose_eval_change": "propose_eval_change",
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
    measurement_invalid = any(
        not isinstance(case.get("measurement"), dict)
        or case["measurement"].get("status") != "valid"
        for case in case_rows
    )

    if release_eligible:
        decision_status = "ready"
        decision_reason = "release_conditions_met"
    elif measurement_invalid:
        decision_status = "inconclusive"
        decision_reason = "measurement_invalid"
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
    decision_context = load_dashboard_decision_context(
        plan=plan,
        plan_path=plan_path,
        workspace=workspace,
        state_path=state_path,
        local_decision_paths=local_decision_paths,
    )
    state = decision_context.state
    decisions = decision_context.decisions
    latest_decision = decision_context.latest_decision
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
        result_measurement = result.get("measurement")
        case_measurement = (
            result_measurement
            if isinstance(result_measurement, dict)
            else {
                "status": "unverified" if evidence is not None else "pending",
                "oracle": planned_case.get(
                    "oracle", {"status": "unverified", "reasons": []}
                ),
                "sampling": {
                    **planned_case.get("sampling", {}),
                    "status": "pending",
                    "direction_disagreement": False,
                },
                "reasons": [],
            }
        )
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
        elif case_measurement.get("status") != "valid":
            case_status = "measurement-invalid"
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
                    trace_capture_source = raw_trace.get("capture_source")
                    projected_trace = {
                        key: raw_trace.get(key)
                        for key in (
                            "artifact",
                            "digest",
                            "capture_source",
                            "source_trace_required",
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
                            "details": (
                                {"capture_source": trace_capture_source}
                                if event_index == 0
                                and isinstance(trace_capture_source, str)
                                else {}
                            ),
                            "artifact_refs": [],
                        }
                        for event_index, event in enumerate(
                            event
                            for event in trace_events
                            if isinstance(event, dict)
                        )
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
                            "adapter",
                            "format",
                            "source_stream_digest",
                            "source_event_count",
                            "retained_event_count",
                            "redaction",
                            "source_agent",
                            "registry_entry_digest",
                            "runtime_binding_digest",
                            "agent_version",
                            "executable_digest",
                            "argv_digest",
                            "parser_id",
                            "parser_version",
                            "parser_digest",
                            "contract_urls",
                            "adapter_maturity",
                            "source_contract_version",
                            "contract_stability",
                            "evidence_authority",
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
                artifact_exists = safe_artifact(
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
                "measurement": case_measurement,
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
                "adapter_id",
                "target",
                "harness",
                "dispatch_observation",
                "trace",
                "capabilities",
                "isolation",
                "sampling",
                "digest",
            )
        }
        | (
            {"adapter_binding": raw_execution_profile["adapter_binding"]}
            if isinstance(raw_execution_profile.get("adapter_binding"), dict)
            else {}
        )
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
        "invalid_experiments": len(state.get("invalid_experiments", []))
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
        "schema_version": 3,
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
            "measurement": (evidence or {}).get(
                "measurement",
                {
                    "status": "pending",
                    "cases": [
                        {
                            "case_id": str(case.get("id")),
                            "status": "pending",
                            "oracle": case.get("oracle"),
                            "sampling": {
                                **case.get("sampling", {}),
                                "status": "pending",
                                "direction_disagreement": False,
                            },
                            "reasons": [],
                        }
                        for case in plan.get("cases", [])
                        if isinstance(case, dict)
                    ],
                    "reasons": [],
                },
            ),
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
            "invalid_experiments": state.get("invalid_experiments", [])
            if state
            else [],
        },
        "action_center": action_center,
        "review": review,
        "cases": case_rows,
        "diffs": skill_diffs,
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

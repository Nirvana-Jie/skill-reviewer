#!/usr/bin/env python3
"""Apply acceptance gates and govern bounded Skill evolution state."""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path
from typing import Any

from skill_eval_authority import (
    _ensure_empty_workspace,
    _is_within,
    _runtime_skill_file_digests,
    iter_strict_files,
    load_json,
    require_real_directory,
    require_string,
    runtime_skill_digest,
    safe_artifact,
    safe_subject_file,
    sha256_file,
    sha256_json,
    verify_locked_inputs,
    write_json,
    write_json_exclusive,
)
from skill_eval_contracts import (
    ACCEPTANCE_CONTRACT,
    DASHBOARD_DIFF_CONTRACT,
    EVOLUTION_STATE_CONTRACT,
    EVOLUTION_TRANSITION_CONTRACT,
    ManifestError,
    PLAN_CONTRACT,
    VERIFICATION_CONTRACT,
)
from skill_eval_grading import RESERVED_ARM_RESULT_FIELDS, _objective_delta, grade_run

DASHBOARD_DIFF_RENDER_LIMIT_BYTES = 512 * 1024
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
    measurement = evidence.get("measurement")
    measurement_status = (
        str(measurement.get("status"))
        if isinstance(measurement, dict)
        else "unverified"
    )
    measurement_valid = measurement_status == "valid"
    hard_gates.append(
        {
            "id": "measurement:valid",
            "passed": measurement_valid,
            "reason": (
                "oracle calibration and paired sampling are valid"
                if measurement_valid
                else f"measurement is {measurement_status}; candidate quality cannot be attributed"
            ),
        }
    )
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
            metric = require_string(objective.get("metric"), "objective.metric")
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
    accepted = (
        measurement_valid
        and not evidence_inconclusive
        and hard_gates_passed
        and pareto_admissible
    )
    if phase == "selection":
        accepted = accepted and material_improvement
    if not measurement_valid:
        status = "invalid"
    elif evidence_inconclusive:
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
        "measurement_validity": measurement_status,
        "hard_gates": hard_gates,
        "objectives": objective_results,
        "reason": {
            "accepted": "candidate passed every hard gate, did not regress, and materially improved a primary objective",
            "rejected": "candidate failed a hard gate or regressed on a declared objective",
            "no-change": "candidate produced no material primary-objective improvement",
            "inconclusive": "retained evidence cannot support an acceptance decision",
            "invalid": "the oracle or paired sampling is invalid, so this experiment cannot judge candidate quality",
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
        require_string(decision.get("plan_path"), "decision.plan_path")
    )
    evidence_path = Path(
        require_string(decision.get("evidence_path"), "decision.evidence_path")
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
    path = Path(require_string(records[0].get("path"), f"{arm} snapshot.path"))
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
    candidate_digest = require_string(
        candidate.get("digest"), "plan.subject.digest"
    )
    change = _candidate_change(
        parent_snapshot=parent_snapshot,
        candidate_snapshot=_plan_snapshot_path(plan, "with_skill"),
    )
    return {
        "phase": "selection",
        "round": round_number,
        "run_id": require_string(plan.get("run_id"), "plan.run_id"),
        "plan_path": str(plan_path.resolve()),
        "plan_digest": sha256_file(plan_path.resolve()),
        "parent_digest": parent_digest,
        "candidate_digest": candidate_digest,
        "subject_path": require_string(candidate.get("path"), "plan.subject.path"),
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
        "run_id": require_string(plan.get("run_id"), "plan.run_id"),
        "plan_path": str(plan_path.resolve()),
        "plan_digest": sha256_file(plan_path.resolve()),
        "candidate_digest": require_string(
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
        require_string(subject.get("path"), "plan.subject.path")
    )
    baseline_path = Path(
        require_string(baseline.get("path"), "plan.baseline.path")
    )
    workspace = workspace.resolve()
    _ensure_empty_workspace(
        workspace, [subject_path, baseline_path, plan_path.parent]
    )
    verify_locked_inputs(
        plan_path=plan_path, workspace=plan_path.parent, plan=plan
    )
    authority_digest = require_string(
        plan.get("authority", {}).get("digest"), "plan.authority.digest"
    )
    execution_profile_digest = require_string(
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
        "invalid_experiments": [],
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
        baseline_digest = require_string(
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
        require_string(decision.get("plan_path"), "decision.plan_path")
    ).resolve()
    _validate_evolution_state(
        state, plan, state_path, decision_plan_path
    )
    staging_root = Path(
        require_string(state.get("control_workspace"), "state.control_workspace")
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
    run_id = require_string(decision.get("run_id"), "decision.run_id")
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
                require_string(
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
    experiment_invalid = decision.get("status") == "invalid"
    if experiment_invalid:
        invalid_experiments = state.get("invalid_experiments")
        if not isinstance(invalid_experiments, list):
            raise ManifestError("invalid_experiments must be an array")
        state["invalid_experiments"] = [
            *invalid_experiments,
            {
                "phase": phase,
                "round": iteration,
                "run_id": run_id,
                "candidate_digest": plan.get("subject", {}).get("digest"),
                "measurement_validity": decision.get("measurement_validity"),
                "reason": decision.get("reason"),
                "decision_digest": sha256_file(decision_path),
            },
        ]

    if phase == "selection":
        if state.get("status") != "optimizing":
            raise ManifestError("selection decisions are allowed only while optimizing")
        if experiment_invalid:
            state.update(
                {
                    "status": "measurement-invalid",
                    "next_action": "propose_eval_change",
                    "terminal": True,
                }
            )
        elif decision.get("accepted") is True:
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
        if decision.get("accepted") is not True and not experiment_invalid:
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
                "status": (
                    "measurement-invalid"
                    if experiment_invalid
                    else "audit-passed"
                    if audit_passed
                    else "audit-failed"
                ),
                "next_action": (
                    "propose_eval_change"
                    if experiment_invalid
                    else "request_user_release"
                    if audit_passed
                    else "stop"
                ),
                "terminal": True,
                "audit_consumed": True,
            }
        )
    state["history"] = history
    state["seen_run_ids"] = [*seen_run_ids, run_id]
    state["authorized_query"] = None
    transition_path = safe_artifact(
        Path(require_string(state.get("control_workspace"), "state.control_workspace"))
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
        require_string(authorization.get("plan_path"), f"{label}.plan_path")
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
    baseline_digest = require_string(
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
        run_id = require_string(record.get("run_id"), f"{label}.run_id")
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
    authority_digest = require_string(
        plan_authority.get("digest"), "plan.authority.digest"
    )
    execution_profile_digest = require_string(
        plan.get("execution_profile", {}).get("digest"),
        "plan.execution_profile.digest",
    )
    control_workspace = Path(
        require_string(state.get("control_workspace"), "state.control_workspace")
    )
    if not control_workspace.is_absolute():
        raise ManifestError("state.control_workspace must be an absolute path")
    control_workspace = require_real_directory(
        control_workspace,
        Path(control_workspace.anchor),
        "evolution control workspace",
    )
    canonical_state_path = safe_artifact(
        control_workspace, "evolution-state.json"
    )
    if state_path.is_symlink() or state_path.resolve() != canonical_state_path:
        raise ManifestError(
            "evolution state must stay at its canonical control workspace path"
        )
    transitions_root = require_real_directory(
        control_workspace / "transitions",
        control_workspace,
        "evolution transition journal",
    )
    staging_root = require_real_directory(
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
        require_string(
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
        Path(require_string(subject.get("path"), "plan.subject.path")),
        plan_path.resolve().parent,
        Path(require_string(initialized_subject.get("path"), "initialized subject.path")),
        initialized_plan_path.parent,
    ]
    for baseline_record, label in (
        (baseline, "plan.baseline.path"),
        (initialized_baseline, "initialized baseline.path"),
    ):
        if baseline_record.get("kind") == "old_skill":
            protected_roots.append(
                Path(require_string(baseline_record.get("path"), label))
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
    invalid_experiments = state.get("invalid_experiments")
    if not all(
        isinstance(value, list)
        for value in (
            candidate_lineage,
            rejected_candidates,
            optimizer_rejected_buffer,
            invalid_experiments,
        )
    ):
        raise ManifestError(
            "evolution lineage, rejected buffers, and invalid experiments must be arrays"
        )
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
        initialized_run_id=require_string(
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
    reconstructed_invalid: list[dict[str, Any]] = []
    state_projection = dict(projection) if state_history_length == 0 else None
    rejected_projection: list[dict[str, Any]] | None = (
        [] if state_history_length == 0 else None
    )
    invalid_projection: list[dict[str, Any]] | None = (
        [] if state_history_length == 0 else None
    )
    for index, record in enumerate(history):
        decision_path = Path(
            require_string(
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
            require_string(decision.get("plan_path"), "decision.plan_path")
        ).resolve()
        run_id = require_string(decision.get("run_id"), "decision.run_id")
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
                selected_subject_digest=require_string(
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
        experiment_invalid = decision.get("status") == "invalid"
        if phase == "selection":
            if projection["status"] != "optimizing":
                raise ManifestError("dashboard history contains an invalid selection transition")
            if experiment_invalid:
                projection.update(
                    {
                        "status": "measurement-invalid",
                        "next_action": "propose_eval_change",
                        "terminal": True,
                    }
                )
            elif decision.get("accepted") is True:
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
            if decision.get("accepted") is not True and not experiment_invalid:
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
                    "status": (
                        "measurement-invalid"
                        if experiment_invalid
                        else "audit-passed"
                        if decision.get("accepted") is True
                        else "audit-failed"
                    ),
                    "next_action": (
                        "propose_eval_change"
                        if experiment_invalid
                        else "request_user_release"
                        if decision.get("accepted") is True
                        else "stop"
                    ),
                    "terminal": True,
                    "audit_consumed": True,
                }
            )
        else:
            raise ManifestError("dashboard history decision phase is invalid")
        if experiment_invalid:
            reconstructed_invalid.append(
                {
                    "phase": phase,
                    "round": decision.get("iteration"),
                    "run_id": run_id,
                    "candidate_digest": decision_plan.get("subject", {}).get(
                        "digest"
                    ),
                    "measurement_validity": decision.get(
                        "measurement_validity"
                    ),
                    "reason": decision.get("reason"),
                    "decision_digest": sha256_file(decision_path),
                }
            )
        history_run_ids.append(run_id)
        validated.append((decision_path, decision))
        if index + 1 == state_history_length:
            state_projection = dict(projection)
            rejected_projection = list(reconstructed_rejected)
            invalid_projection = list(reconstructed_invalid)

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
        active_run_id = require_string(
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
                selected_subject_digest=require_string(
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
    if invalid_projection is None or invalid_experiments != invalid_projection:
        raise ManifestError("invalid experiment history does not match decisions")
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
    state["invalid_experiments"] = reconstructed_invalid
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

#!/usr/bin/env python3
"""Stable CLI façade for executable Skill Eval operations.

Domain implementation lives in authority, grading, decision, and Dashboard
modules. This file preserves the installed command and public Python imports.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

from skill_eval_authority import (
    compile_manifest,
    reject_json_constant,
    require_finite_json,
)
from skill_eval_contracts import ManifestError
from skill_eval_dashboard import project_dashboard
from skill_eval_decision import (
    advance_evolution,
    authorize_evolution,
    decide_candidate,
    initialize_evolution,
)
from skill_eval_grading import (
    TRACE_EVENT_KINDS,
    finalize_execution,
    grade_run,
    record_dispatch_receipt,
    record_trace_event,
)

def _parse_cli_object(raw: str, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw, parse_constant=reject_json_constant)
        require_finite_json(value, label)
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
        help="Lowercase adapter slug; defaults to the locked execution profile.",
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
        help="Lowercase adapter slug; defaults to the locked execution profile.",
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

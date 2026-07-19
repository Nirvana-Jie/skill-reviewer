#!/usr/bin/env python3
"""Execute every locked eval cell through paired local Codex processes.

This is the provider-specific fan-out layer for ``codex-cli`` plans. The core
runtime remains provider-agnostic: this command validates the immutable plan,
starts every arm for one case/repeat batch before waiting for any arm, lets the
single-cell adapter retain dispatch/source provenance, and grades the complete
run after all batches finish.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from skill_eval_runtime import (
    ManifestError,
    grade_run,
    load_json,
    verify_locked_inputs,
    write_json,
)


SUMMARY_CONTRACT = "skill-reviewer.codex-dispatch-summary"
CODEX_TARGET = "codex-cli"
CODEX_HARNESS = "codex-exec-jsonl"


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _batch_id(run_id: str, case_id: str, repeat: int) -> str:
    seed = f"{run_id}|{case_id}|{repeat}".encode("utf-8")
    return f"batch-{hashlib.sha256(seed).hexdigest()[:20]}"


def _load_locked_plan(workspace: Path) -> tuple[Path, dict[str, Any]]:
    workspace = workspace.resolve()
    plan_path = workspace / "execution-plan.json"
    if not plan_path.is_file():
        raise ManifestError("execution-plan.json is required")
    plan = load_json(plan_path)
    verify_locked_inputs(plan_path=plan_path, workspace=workspace, plan=plan)
    profile = plan.get("execution_profile")
    if not isinstance(profile, dict):
        raise ManifestError("execution plan is missing its execution profile")
    if profile.get("target") != CODEX_TARGET or profile.get("harness") != CODEX_HARNESS:
        raise ManifestError(
            f"Codex plan execution requires target={CODEX_TARGET} and harness={CODEX_HARNESS}"
        )
    if profile.get("isolation") != "local-unattested":
        raise ManifestError(
            "Codex plan execution requires isolation=local-unattested"
        )
    return plan_path, plan


def _plan_batches(
    *, plan: dict[str, Any], workspace: Path
) -> list[dict[str, Any]]:
    run_id = str(plan.get("run_id"))
    batches: list[dict[str, Any]] = []
    for case in plan.get("cases", []):
        if not isinstance(case, dict):
            raise ManifestError("execution plan contains an invalid case")
        case_id = case.get("id")
        arms = case.get("arms")
        repeats = case.get("repeats")
        if (
            not isinstance(case_id, str)
            or not isinstance(arms, list)
            or not arms
            or not all(isinstance(arm, str) for arm in arms)
            or not isinstance(repeats, int)
            or isinstance(repeats, bool)
            or repeats < 1
        ):
            raise ManifestError(f"execution plan case is invalid: {case_id}")
        for repeat in range(1, repeats + 1):
            assignments: list[dict[str, str]] = []
            for arm in arms:
                assignment_path = (
                    workspace
                    / "assignments"
                    / case_id
                    / arm
                    / f"repeat-{repeat}.json"
                )
                if not assignment_path.is_file():
                    raise ManifestError(f"locked assignment is missing: {assignment_path}")
                assignments.append(
                    {"arm": arm, "assignment": str(assignment_path.resolve())}
                )
            batches.append(
                {
                    "batch_id": _batch_id(run_id, case_id, repeat),
                    "case_id": case_id,
                    "repeat": repeat,
                    "assignments": assignments,
                }
            )
    if not batches:
        raise ManifestError("execution plan contains no dispatchable cells")
    return batches


def _executor_command(
    *, args: argparse.Namespace, assignment: str, batch_id: str
) -> list[str]:
    executor = Path(__file__).resolve().with_name("run_codex_eval_executor.py")
    command = [
        sys.executable,
        str(executor),
        "--workspace",
        str(args.workspace.resolve()),
        "--assignment",
        assignment,
        "--codex-bin",
        args.codex_bin,
        "--batch-id",
        batch_id,
    ]
    if args.model:
        command.extend(["--model", args.model])
    if args.full_access:
        command.append("--full-access")
    if args.timeout_seconds is not None:
        command.extend(["--timeout-seconds", str(args.timeout_seconds)])
    return command


def _run_batch(*, args: argparse.Namespace, batch: dict[str, Any]) -> dict[str, Any]:
    assignments = batch["assignments"]
    if len(assignments) > args.max_workers:
        raise ManifestError(
            f"batch {batch['batch_id']} has {len(assignments)} paired arms but "
            f"--max-workers is {args.max_workers}; refusing to serialize paired arms"
        )
    started_at = _timestamp()
    processes: list[tuple[dict[str, str], subprocess.Popen[str]]] = []
    try:
        for cell in assignments:
            process = subprocess.Popen(
                _executor_command(
                    args=args,
                    assignment=cell["assignment"],
                    batch_id=str(batch["batch_id"]),
                ),
                cwd=args.workspace.resolve(),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            processes.append((cell, process))
    except OSError as error:
        for _cell, process in processes:
            process.kill()
            process.wait()
        raise ManifestError(f"unable to start paired Codex executors: {error}") from error

    results: list[dict[str, Any]] = []
    for cell, process in processes:
        stdout, stderr = process.communicate()
        result: dict[str, Any] = {
            "arm": cell["arm"],
            "assignment": cell["assignment"],
            "exit_code": process.returncode,
        }
        if stdout.strip():
            try:
                payload = json.loads(stdout)
            except json.JSONDecodeError:
                result["diagnostic"] = "executor returned non-JSON stdout"
            else:
                if isinstance(payload, dict):
                    result["execution_status"] = payload.get("status")
                    result["trace_digest_pending"] = payload.get("trace", {}).get(
                        "digest"
                    ) if isinstance(payload.get("trace"), dict) else None
        if stderr.strip():
            result["stderr"] = stderr.strip()[:2000]
        results.append(result)
    return {
        "batch_id": batch["batch_id"],
        "case_id": batch["case_id"],
        "repeat": batch["repeat"],
        "started_at": started_at,
        "finished_at": _timestamp(),
        "cells": results,
    }


def run_plan(args: argparse.Namespace) -> dict[str, Any]:
    workspace = args.workspace.resolve()
    plan_path, plan = _load_locked_plan(workspace)
    summary_path = workspace / "codex-dispatch-summary.json"
    if summary_path.exists() or summary_path.is_symlink():
        raise ManifestError(
            "codex-dispatch-summary.json already exists; recompile a fresh immutable run"
        )
    batches = _plan_batches(plan=plan, workspace=workspace)
    started_at = _timestamp()
    summary: dict[str, Any] = {
        "contract": SUMMARY_CONTRACT,
        "run_id": plan.get("run_id"),
        "plan": str(plan_path),
        "status": "running",
        "started_at": started_at,
        "finished_at": None,
        "execution_count": sum(len(batch["assignments"]) for batch in batches),
        "failed_count": 0,
        "batches": [],
        "evidence": None,
    }
    write_json(summary_path, summary)
    try:
        for batch in batches:
            batch_result = _run_batch(args=args, batch=batch)
            summary["batches"].append(batch_result)
            summary["failed_count"] = sum(
                cell.get("exit_code") != 0
                for retained_batch in summary["batches"]
                for cell in retained_batch["cells"]
            )
            write_json(summary_path, summary)
        grade_run(plan_path=plan_path, workspace=workspace)
        summary["evidence"] = str((workspace / "verification-evidence.json").resolve())
        summary["status"] = (
            "completed" if summary["failed_count"] == 0 else "failed"
        )
    except (ManifestError, OSError) as error:
        summary["status"] = "failed"
        summary["error"] = str(error)
        summary["finished_at"] = _timestamp()
        write_json(summary_path, summary)
        raise
    summary["finished_at"] = _timestamp()
    write_json(summary_path, summary)
    return summary


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--codex-bin", default="codex")
    parser.add_argument("--model")
    parser.add_argument(
        "--full-access",
        action="store_true",
        help="Pass explicit danger-full-access to every locked cell executor.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        help="Optionally reduce, but never extend, each assignment timeout.",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        choices=[1, 2, 3],
        default=3,
        help="Maximum processes in one paired batch; batches are never serialized by arm.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        result = run_plan(args)
    except ManifestError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    return 0 if result.get("status") == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

import { describe, expect, it } from "vitest";

import { buildEvalExecutionTrace } from "./eval-execution-trace";
import type { DashboardData } from "./types";

function traceData(): DashboardData {
  return {
    contract: "skill-reviewer.dashboard-data",
    generated_at: null,
    refresh_interval_ms: 3000,
    run: {
      id: "run-trace",
      status: "completed",
      verification_level: "behavior-verified",
      manifest: { path: "/skill/evals/evals.json", digest: "a".repeat(64) },
      execution_profile: { digest: "b".repeat(64) },
      splits: ["selection"],
      evidence_scope: "public-calibration",
      release_eligible: false,
      integrity: {
        locked: true,
        verified: true,
        plan_digest: "c".repeat(64),
      },
    },
    summary: {
      case_count: 1,
      candidate_passed: 0,
      candidate_failed: 1,
      hard_gates_passed: 0,
      hard_gates_total: 1,
      decision_status: "rejected",
      current_round: 1,
      max_rounds: 3,
      selection_queries: 1,
      audit_queries: 0,
      rejected_candidates: 1,
      continuity_epoch: 1,
    },
    evolution: {
      active_query: null,
      selection_query_limit: 3,
      audit_query_limit: 1,
      candidate_lineage: [],
      rejected_candidates: [],
    },
    action_center: {
      next_action: "propose_candidate",
      owner: "lead_agent",
      acceptance: {
        status: "rejected",
        accepted: false,
        decision_run_id: "run-trace",
        criteria: [],
      },
      attribution: { primary: "skill", items: [] },
      actions: [],
      task_gateway: {
        request_endpoint: "/dashboard-action-requests",
        audit_endpoint: "/dashboard-action-requests.json",
        evidence_mutation: false,
        eval_mutation: false,
      },
    },
    cases: [
      {
        id: "quality",
        split: "selection",
        determinism: "deterministic",
        repeats: 1,
        holdout_visibility: "public",
        status: "failed",
        regressed: false,
        direction_disagreement: false,
        missing_objective_metrics: [],
        arms: [
          {
            id: "with_skill",
            complete: true,
            passed: false,
            required_pass_rate: 0,
            metrics: {},
            assertions: { passed: 0, total: 1 },
            artifact_count: 2,
            executions: [
              {
                repeat: 1,
                status: "completed",
                binding_error_count: 0,
                execution_digest: "d".repeat(64),
                artifact_count: 2,
                assertions: { passed: 0, total: 1 },
                required_pass_rate: 0,
                metrics: {},
              },
            ],
          },
        ],
        semantic_assertions: [],
      },
    ],
    diffs: [],
    iterations: [],
    spine: [
      {
        id: "run:run-trace",
        kind: "run",
        parent_id: null,
        label: "run-trace",
        status: "completed",
      },
      {
        id: "gate:quality:candidate-required-assertions",
        kind: "gate",
        parent_id: "run:run-trace",
        label: "quality:candidate-required-assertions",
        status: "failed",
      },
      {
        id: "case:quality",
        kind: "case",
        parent_id: "run:run-trace",
        label: "quality",
        status: "failed",
      },
      {
        id: "assertion:quality:with_skill:1:response-exists",
        kind: "assertion",
        parent_id: "case:quality",
        label: "response-exists",
        status: "failed",
        arm: "with_skill",
        repeat: 1,
      },
    ],
    limitations: [],
  };
}

describe("buildEvalExecutionTrace", () => {
  it("projects a failed but fully verifiable eval execution", () => {
    const trace = buildEvalExecutionTrace(traceData(), "quality");

    expect(trace).toMatchObject({
      expectedExecutions: 1,
      observedExecutions: 1,
      confidence: "verified",
      deterministicAssertions: { passed: 0, total: 1 },
    });
    expect(trace?.failedAssertionNodes.map((node) => node.id)).toEqual([
      "assertion:quality:with_skill:1:response-exists",
    ]);
    expect(trace?.gateNodes).toHaveLength(1);
  });

  it("reports missing repeat evidence instead of presenting an inferred run", () => {
    const data = traceData();
    data.cases[0]!.arms[0]!.executions = [];

    const trace = buildEvalExecutionTrace(data, "quality");

    expect(trace?.confidence).toBe("partial");
    expect(trace?.gaps).toContain("execution_count");
    expect(trace?.observedExecutions).toBe(0);
  });

  it("rejects duplicate repeat numbers even when the aggregate count matches", () => {
    const data = traceData();
    data.cases[0]!.repeats = 2;
    const firstExecution = data.cases[0]!.arms[0]!.executions![0]!;
    data.cases[0]!.arms[0]!.executions = [
      firstExecution,
      { ...firstExecution, execution_digest: "e".repeat(64) },
    ];

    const trace = buildEvalExecutionTrace(data, "quality");

    expect(trace?.observedExecutions).toBe(2);
    expect(trace?.confidence).toBe("partial");
    expect(trace?.gaps).toContain("execution_count");
  });

  it("requires a valid execution digest before claiming a fully bound trace", () => {
    const data = traceData();
    data.cases[0]!.arms[0]!.executions![0]!.execution_digest = "not-a-digest";

    const trace = buildEvalExecutionTrace(data, "quality");

    expect(trace?.confidence).toBe("partial");
    expect(trace?.gaps).toContain("execution_integrity");
  });
});

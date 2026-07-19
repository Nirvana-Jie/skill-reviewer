import { describe, expect, it } from "vitest";

import { buildReviewViewModel } from "./review-view-model";
import { agentDispatchReceiptFixture } from "./test-fixtures";
import type {
  AgentExecutionTrace,
  DashboardData,
  DashboardExecution,
} from "./types";

function trace(arm: string, repeat: number): AgentExecutionTrace {
  const startedAt = "2026-07-19T00:00:00.000Z";
  const finishedAt = "2026-07-19T00:00:00.020Z";
  return {
    artifact: "agent-trace.jsonl",
    digest: (arm === "with_skill" ? "a" : "b").repeat(64),
    capture_source: "harness_native",
    source_trace_required: false,
    complete: true,
    valid: true,
    event_count: 2,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: 20,
    events: [
      {
        contract: "skill-reviewer.agent-trace-event",
        event_id: `${arm}-${repeat}-start`,
        run_id: "run-review-model",
        case_id: "selection-quality",
        arm,
        repeat,
        sequence: 1,
        occurred_at: startedAt,
        elapsed_ms: 0,
        kind: "execution_started",
        status: "running",
        summary: "Agent execution started",
        details: { capture_source: "harness_native" },
        artifact_refs: [],
      },
      {
        contract: "skill-reviewer.agent-trace-event",
        event_id: `${arm}-${repeat}-finish`,
        run_id: "run-review-model",
        case_id: "selection-quality",
        arm,
        repeat,
        sequence: 2,
        occurred_at: finishedAt,
        elapsed_ms: 20,
        kind: "execution_finished",
        status: "completed",
        summary: "Agent execution finished",
        details: {},
        artifact_refs: [],
      },
    ],
  };
}

function execution(arm: string, repeat: number): DashboardExecution {
  return {
    repeat,
    status: "completed",
    binding_error_count: 0,
    execution_digest: String(repeat).repeat(64),
    artifact_count: 0,
    assertions: { passed: 1, total: 1 },
    required_pass_rate: 1,
    metrics: {},
    trace: trace(arm, repeat),
  };
}

function validMeasurement(repeats: number) {
  return {
    status: "valid" as const,
    oracle: {
      status: "valid" as const,
      required_text_assertions: 1,
      calibrated_text_assertions: 1,
      checks: [],
      reasons: [],
    },
    sampling: {
      status: "valid" as const,
      repeats,
      pairing: "paired",
      source: "explicit",
      direction_disagreement: false,
    },
    reasons: [],
  };
}

function dashboardFixture(): DashboardData {
  return {
    contract: "skill-reviewer.dashboard-data",
    generated_at: null,
    refresh_interval_ms: 3000,
    run: {
      id: "run-review-model",
      status: "awaiting-audit",
      verification_level: "regression-verified",
      splits: ["selection"],
      evidence_scope: "public-calibration",
      release_eligible: false,
      measurement: {
        status: "valid",
        cases: [{ case_id: "selection-quality", ...validMeasurement(3) }],
        reasons: [],
      },
    },
    summary: {
      case_count: 1,
      candidate_passed: 1,
      candidate_failed: 0,
      hard_gates_passed: 0,
      hard_gates_total: 0,
      decision_status: "accepted",
      current_round: 1,
      max_rounds: 3,
      selection_queries: 1,
      audit_queries: 0,
      rejected_candidates: 0,
      continuity_epoch: 1,
    },
    evolution: {
      selection_query_limit: 3,
      audit_query_limit: 1,
      candidate_lineage: [],
      rejected_candidates: [],
    },
    action_center: {
      next_action: "prepare_audit",
      owner: "lead_agent",
      continuation: {
        mode: "automatic",
        owner: "lead_agent",
        reason: "within_locked_authority",
      },
      acceptance: {
        status: "accepted",
        accepted: true,
        decision_run_id: "run-review-model",
        criteria: [],
      },
      attribution: { primary: null, items: [] },
      actions: [],
      task_gateway: {
        request_endpoint: "/dashboard-action-requests",
        audit_endpoint: "/dashboard-action-requests.json",
        evidence_mutation: false,
        eval_mutation: false,
        handoff_mode: "durable_local_ledger",
        can_wake_agent_session: false,
        persists_after_agent_session_end: true,
      },
    },
    review: {
      contract: "skill-reviewer.dashboard-review",
      decision: {
        status: "inconclusive",
        reason: "audit_required",
        release_eligible: false,
        blocking_scenario_count: 0,
        blocking_gate_count: 0,
      },
      blockers: [],
      safeguards: { passed_gate_ids: [], passed_case_ids: ["selection-quality"] },
      scenarios: [],
      next_action: "prepare_audit",
      attribution: null,
    },
    cases: [
      {
        id: "selection-quality",
        split: "selection",
        determinism: "stochastic",
        repeats: 3,
        holdout_visibility: "public",
        status: "passed",
        measurement: validMeasurement(3),
        regressed: false,
        direction_disagreement: false,
        missing_objective_metrics: [],
        arms: ["with_skill", "old_skill"].map((arm) => ({
          id: arm,
          complete: true,
          passed: true,
          required_pass_rate: 1,
          metrics: {},
          assertions: { passed: 3, total: 3 },
          artifact_count: 0,
          executions: [1, 2, 3].map((repeat) => execution(arm, repeat)),
        })),
        semantic_assertions: [],
      },
    ],
    diffs: [],
    spine: [],
    limitations: ["Release audit has not run."],
  };
}

function markReleaseReady(fixture: DashboardData): void {
  fixture.run.manifest = {
    path: "evals/evals.json",
    digest: "c".repeat(64),
  };
  fixture.run.integrity = {
    locked: true,
    verified: true,
    plan_digest: "d".repeat(64),
  };
  fixture.run.execution_profile = {
    target: "native-agent",
    harness: "lead-agent-dispatch",
    dispatch_observation: "host_dispatch",
    trace: { capture_source: "harness_native", source: null },
    capabilities: ["filesystem"],
    isolation: "trusted-orchestrator",
    sampling: { policy: "orchestrator-default" },
    digest: "e".repeat(64),
  };
  fixture.run.release_eligible = true;
  fixture.run.evidence_scope = "opaque-holdout";
  fixture.run.holdout = {
    visibility: "opaque",
    issuer: "trusted-eval-service",
    digest: "f".repeat(64),
  };
  fixture.summary.candidate_passed = fixture.summary.case_count;
  fixture.summary.candidate_failed = 0;
  fixture.summary.hard_gates_passed = 1;
  fixture.summary.hard_gates_total = 1;
  fixture.review.decision = {
    status: "ready",
    reason: "release_conditions_met",
    release_eligible: true,
    blocking_scenario_count: 0,
    blocking_gate_count: 0,
  };
  fixture.review.blockers = [];
  fixture.action_center.acceptance = {
    status: "accepted",
    accepted: true,
    decision_run_id: fixture.run.id,
    criteria: ["hard_gates", "pareto", "material_improvement"].map((id) => ({
      id: id as "hard_gates" | "pareto" | "material_improvement",
      status: "satisfied" as const,
      passed: 1,
      total: 1,
      evidence_ids: [],
    })),
  };
  for (const item of fixture.cases) {
    for (const arm of item.arms) {
      for (const itemExecution of arm.executions ?? []) {
        itemExecution.dispatch = agentDispatchReceiptFixture({
          digest: `${itemExecution.repeat}`.repeat(64),
          dispatch_id: `${arm.id}-${itemExecution.repeat}`,
          worker_id: `worker-${arm.id}-${itemExecution.repeat}`,
          batch_id: `batch-${item.id}-${itemExecution.repeat}`,
        });
      }
    }
  }
}

describe("review view model", () => {
  it("does not present complete trace capture as complete release evidence", () => {
    const model = buildReviewViewModel(dashboardFixture());

    expect(model.execution).toEqual({
      captured: 6,
      expected: 6,
      status: "complete",
      tone: "neutral",
    });
    expect(model.evidence).toEqual({
      status: "partial",
      tone: "warn",
    });
    expect(model.decision.tone).toBe("warn");
  });

  it("does not emit success semantics when decision fields conflict", () => {
    const fixture = dashboardFixture();
    fixture.review.decision = {
      ...fixture.review.decision,
      status: "ready",
      reason: "audit_required",
      release_eligible: false,
    };

    expect(buildReviewViewModel(fixture).decision.tone).toBe("warn");
  });

  it("fails closed when run and review release eligibility disagree", () => {
    const fixture = dashboardFixture();
    fixture.review.decision = {
      ...fixture.review.decision,
      status: "ready",
      reason: "release_conditions_met",
      release_eligible: true,
    };
    fixture.run.release_eligible = false;

    expect(buildReviewViewModel(fixture).decision.tone).toBe("warn");
  });

  it("requires verified run integrity and dispatch evidence before release success", () => {
    const fixture = dashboardFixture();
    fixture.run.release_eligible = true;
    fixture.review.decision = {
      ...fixture.review.decision,
      status: "ready",
      reason: "release_conditions_met",
      release_eligible: true,
    };

    const model = buildReviewViewModel(fixture);

    expect(model.execution.status).toBe("complete");
    expect(model.evidence).toEqual({ status: "partial", tone: "warn" });
    expect(model.decision.tone).toBe("warn");
  });

  it("only emits release success when every release invariant agrees", () => {
    const fixture = dashboardFixture();
    markReleaseReady(fixture);

    expect(buildReviewViewModel(fixture).decision.tone).toBe("good");

    fixture.review.blockers = [
      {
        id: "blocker:criterion:hard_gates",
        kind: "criterion",
        case_id: null,
        status: "failed",
        gate_ids: [],
        failed_check_ids: [],
        missing_artifact_ids: [],
        source_evidence_ids: [],
        criterion_ids: ["hard_gates"],
        evidence_ids: [],
        attribution: "skill",
        next_action: "propose_candidate",
      },
    ];

    expect(buildReviewViewModel(fixture).decision.tone).toBe("warn");

    fixture.review.blockers = [];
    fixture.action_center.acceptance.criteria =
      fixture.action_center.acceptance.criteria.filter(
        (criterion) => criterion.id !== "pareto",
      );
    expect(buildReviewViewModel(fixture).decision.tone).toBe("warn");
  });

  it("requires a trusted opaque holdout before showing release success", () => {
    const fixture = dashboardFixture();
    markReleaseReady(fixture);

    expect(buildReviewViewModel(fixture).decision.tone).toBe("good");

    fixture.run.evidence_scope = "public-calibration";
    fixture.run.holdout = {
      visibility: "public",
      issuer: null,
      digest: null,
    };

    expect(buildReviewViewModel(fixture).decision.tone).toBe("warn");
  });

  it("never presents candidate success when measurement validity fails", () => {
    const fixture = dashboardFixture();
    markReleaseReady(fixture);
    fixture.run.measurement = {
      status: "invalid",
      cases: [
        {
          case_id: "selection-quality",
          ...validMeasurement(3),
          status: "invalid",
          reasons: ["assertion_calibration_failed:created-set-data"],
        },
      ],
      reasons: ["assertion_calibration_failed:created-set-data"],
    };
    fixture.cases[0].measurement = {
      ...validMeasurement(3),
      status: "invalid",
      reasons: ["assertion_calibration_failed:created-set-data"],
    };

    const model = buildReviewViewModel(fixture);

    expect(model.measurement).toEqual({ status: "invalid", tone: "warn" });
    expect(model.decision.tone).toBe("warn");
    expect(model.evidence.status).toBe("partial");
  });

  it("keeps evidence partial when a failed scenario has an incomplete arm", () => {
    const fixture = dashboardFixture();
    fixture.review.decision = {
      ...fixture.review.decision,
      status: "blocked",
      reason: "scenario_failed",
    };
    fixture.cases[0].arms[1].complete = false;

    const model = buildReviewViewModel(fixture);

    expect(model.execution.status).toBe("complete");
    expect(model.evidence).toEqual({ status: "partial", tone: "warn" });
    expect(model.decision.tone).toBe("bad");
  });

  it("treats absent execution traces as missing evidence even if decision fields say ready", () => {
    const fixture = dashboardFixture();
    fixture.review.decision = {
      ...fixture.review.decision,
      status: "ready",
      reason: "release_conditions_met",
      release_eligible: true,
    };
    for (const arm of fixture.cases[0].arms) arm.executions = [];

    const model = buildReviewViewModel(fixture);

    expect(model.execution).toMatchObject({
      captured: 0,
      expected: 6,
      status: "partial",
      tone: "warn",
    });
    expect(model.evidence).toEqual({ status: "missing", tone: "warn" });
    expect(model.decision.tone).toBe("warn");
  });
});

import { describe, expect, it } from "vitest";

import {
  buildEvalExecutionTrace,
  buildTraceAttentionSummary,
  buildTraceCaseIndex,
  buildTraceExecutionMatrix,
  classifyTraceExecutor,
  groupAssertionComparisons,
  resolveTraceEventSemantics,
} from "./eval-execution-trace";
import { agentDispatchReceiptFixture } from "./test-fixtures";
import type { DashboardData, SpineNode } from "./types";

function agentTrace() {
  return {
    artifact: "agent-trace.jsonl",
    digest: "e".repeat(64),
    capture_source: "harness_native" as const,
    source_trace_required: false,
    complete: true,
    valid: true,
    event_count: 3,
    started_at: "2026-07-16T00:00:00.000Z",
    finished_at: "2026-07-16T00:00:00.020Z",
    duration_ms: 20,
    events: [
      {
        contract: "skill-reviewer.agent-trace-event" as const,
        event_id: "event-1",
        run_id: "run-trace",
        case_id: "quality",
        arm: "with_skill",
        repeat: 1,
        sequence: 1,
        occurred_at: "2026-07-16T00:00:00.000Z",
        elapsed_ms: 0,
        kind: "execution_started" as const,
        status: "running",
        summary: "Agent execution started",
        details: { capture_source: "harness_native" },
        artifact_refs: [],
      },
      {
        contract: "skill-reviewer.agent-trace-event" as const,
        event_id: "event-2",
        run_id: "run-trace",
        case_id: "quality",
        arm: "with_skill",
        repeat: 1,
        sequence: 2,
        occurred_at: "2026-07-16T00:00:00.010Z",
        elapsed_ms: 10,
        kind: "tool_call" as const,
        status: "completed",
        summary: "Read the candidate Skill package",
        details: { tool: "read", path: "SKILL.md" },
        artifact_refs: [],
      },
      {
        contract: "skill-reviewer.agent-trace-event" as const,
        event_id: "event-3",
        run_id: "run-trace",
        case_id: "quality",
        arm: "with_skill",
        repeat: 1,
        sequence: 3,
        occurred_at: "2026-07-16T00:00:00.020Z",
        elapsed_ms: 20,
        kind: "execution_finished" as const,
        status: "completed",
        summary: "Agent execution finished",
        details: {},
        artifact_refs: [],
      },
    ],
  };
}

function dispatchReceipt() {
  return agentDispatchReceiptFixture();
}

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
      continuation: {
        mode: "automatic",
        owner: "lead_agent",
        reason: "within_locked_authority",
      },
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
        handoff_mode: "durable_local_ledger",
        can_wake_agent_session: false,
        persists_after_agent_session_end: true,
      },
    },
    review: {
      contract: "skill-reviewer.dashboard-review",
      decision: {
        status: "blocked",
        reason: "release_gate_failed",
        release_eligible: false,
        blocking_scenario_count: 1,
        blocking_gate_count: 1,
      },
      blockers: [
        {
          id: "blocker:quality",
          kind: "scenario",
          case_id: "quality",
          status: "failed",
          gate_ids: ["gate:quality:candidate-required-assertions"],
          failed_check_ids: [
            "assertion:quality:with_skill:1:response-exists",
          ],
          missing_artifact_ids: [],
          source_evidence_ids: [],
          criterion_ids: [],
          evidence_ids: [
            "case:quality",
            "gate:quality:candidate-required-assertions",
            "assertion:quality:with_skill:1:response-exists",
          ],
          attribution: "skill",
          next_action: "propose_candidate",
        },
      ],
      safeguards: { passed_gate_ids: [], passed_case_ids: [] },
      scenarios: [
        {
          case_id: "quality",
          status: "failed",
          gate_ids: ["gate:quality:candidate-required-assertions"],
          check_ids: ["assertion:quality:with_skill:1:response-exists"],
          artifact_ids: [],
        },
      ],
      next_action: "propose_candidate",
      attribution: "skill",
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
                dispatch: dispatchReceipt(),
                trace: agentTrace(),
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
        parent_id: "case:quality",
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

describe("trace event semantics", () => {
  it("keeps lifecycle completion separate from a failed observed check", () => {
    const completedEvent = agentTrace().events[1];
    const failedCheckEvent = {
      ...completedEvent,
      summary: "Static analysis completed with findings",
      details: {
        static_analysis_passed: false,
        error_count: 4,
      },
    };

    expect(resolveTraceEventSemantics(completedEvent)).toEqual({
      lifecycle: "completed",
      result: "unknown",
      evidence: "complete",
      tone: "neutral",
    });
    expect(resolveTraceEventSemantics(failedCheckEvent)).toEqual({
      lifecycle: "completed",
      result: "failed",
      evidence: "complete",
      tone: "bad",
    });
  });
});

describe("buildEvalExecutionTrace", () => {
  it("projects a failed but fully verifiable eval execution", () => {
    const trace = buildEvalExecutionTrace(traceData(), "quality");

    expect(trace).toMatchObject({
      expectedExecutions: 1,
      observedExecutions: 1,
      capturedTraces: 1,
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

  it("does not count a present but invalid Trace as captured evidence", () => {
    const data = traceData();
    data.cases[0]!.arms[0]!.executions![0]!.trace!.valid = false;

    const trace = buildEvalExecutionTrace(data, "quality");
    const index = buildTraceCaseIndex(data.cases);

    expect(trace?.capturedTraces).toBe(0);
    expect(trace?.gaps).toContain("trace_integrity");
    expect(index[0]).toMatchObject({ capturedTraces: 0, needsAttention: true });
  });

  it("never upgrades an execution summary into a real Agent trace", () => {
    const data = traceData();
    data.cases[0]!.arms[0]!.executions![0]!.trace = null;

    const trace = buildEvalExecutionTrace(data, "quality");

    expect(trace?.capturedTraces).toBe(0);
    expect(trace?.confidence).toBe("partial");
    expect(trace?.gaps).toContain("trace_capture");
  });
});

describe("execution trace navigation", () => {
  it("ranks failed checks, evidence gaps, comparison differences, and slow executions", () => {
    const data = traceData();
    const execution = data.cases[0]!.arms[0]!.executions![0]!;
    execution.trace!.duration_ms = 6000;
    execution.trace!.events[1]!.details = {
      static_analysis_passed: false,
      error_count: 4,
    };
    const trace = buildEvalExecutionTrace(data, "quality");
    if (!trace) throw new Error("trace fixture did not build");

    expect(buildTraceAttentionSummary(trace)).toEqual(
      expect.objectContaining({
        failedChecks: 1,
        failedEvents: 1,
        evidenceGaps: 0,
        slowThresholdMs: 5000,
        slowExecutions: [
          expect.objectContaining({ arm: "with_skill", repeat: 1, durationMs: 6000 }),
        ],
      }),
    );
  });

  it("keeps malformed invalid Trace events out of trusted attention statistics", () => {
    const data = traceData();
    const execution = data.cases[0]!.arms[0]!.executions![0]!;
    execution.trace = {
      valid: false,
      artifact: "agent-trace.jsonl",
      events: [{ status: null, details: "untrusted diagnostic payload" }],
    };
    const trace = buildEvalExecutionTrace(data, "quality");
    if (!trace) throw new Error("trace fixture did not build");

    expect(buildTraceAttentionSummary(trace)).toEqual(
      expect.objectContaining({
        failedEvents: 0,
        slowExecutions: [],
      }),
    );
  });

  it("summarizes every case by planned cells, retained traces, and total duration", () => {
    const data = traceData();
    const selectedCase = data.cases[0]!;
    selectedCase.repeats = 3;
    const candidateExecution = selectedCase.arms[0]!.executions![0]!;
    selectedCase.arms[0]!.executions = [1, 2, 3].map((repeat) => ({
      ...candidateExecution,
      repeat,
      execution_digest: String(repeat).repeat(64),
      trace: {
        ...agentTrace(),
        digest: String(repeat + 3).repeat(64),
        duration_ms: repeat * 10,
      },
    }));
    selectedCase.arms.push({
      ...selectedCase.arms[0]!,
      id: "old_skill",
      executions: [1, 2, 3].map((repeat) => ({
        ...candidateExecution,
        repeat,
        execution_digest: String(repeat + 6).repeat(64),
        trace:
          repeat === 2
            ? null
            : {
                ...agentTrace(),
                digest: ["a", "b", "c"][repeat - 1]!.repeat(64),
                duration_ms: repeat * 20,
              },
      })),
    });

    expect(buildTraceCaseIndex(data.cases)).toEqual([
      expect.objectContaining({
        id: "quality",
        expectedExecutions: 6,
        observedExecutions: 6,
        capturedTraces: 5,
        durationMs: 140,
        needsAttention: true,
      }),
    ]);
  });

  it("builds a repeat-by-arm matrix without inventing a missing execution", () => {
    const data = traceData();
    const selectedCase = data.cases[0]!;
    selectedCase.repeats = 2;
    const candidateExecution = selectedCase.arms[0]!.executions![0]!;
    selectedCase.arms[0]!.executions = [
      candidateExecution,
      {
        ...candidateExecution,
        repeat: 2,
        execution_digest: "f".repeat(64),
      },
    ];
    selectedCase.arms.push({
      ...selectedCase.arms[0]!,
      id: "old_skill",
      executions: [
        {
          ...candidateExecution,
          execution_digest: "9".repeat(64),
        },
      ],
    });
    const trace = buildEvalExecutionTrace(data, "quality")!;

    const matrix = buildTraceExecutionMatrix(trace);

    expect(matrix.map((row) => row.repeat)).toEqual([1, 2]);
    expect(matrix[0]?.cells.map((cell) => cell.arm.id)).toEqual([
      "with_skill",
      "old_skill",
    ]);
    expect(matrix[1]?.cells[0]?.execution?.repeat).toBe(2);
    expect(matrix[1]?.cells[1]?.execution).toBeNull();
  });

  it("separates the lead dispatcher from the Agent that executes an eval cell", () => {
    expect(classifyTraceExecutor(null)).toEqual({
      kind: "unrecorded",
      role: "eval_executor",
      dispatchedBy: "lead_agent",
      dispatchBound: false,
      nestedAgentEvents: false,
      target: null,
      harness: null,
    });
    expect(classifyTraceExecutor({ capabilities: [] })).toEqual(
      expect.objectContaining({ kind: "unrecorded" }),
    );
    expect(
      classifyTraceExecutor({
        target: "native-agent",
        harness: "lead-agent-dispatch",
        capabilities: ["jsonl-agent-events"],
      }),
    ).toEqual({
      kind: "declared_agent_profile",
      role: "eval_executor",
      dispatchedBy: "lead_agent",
      dispatchBound: false,
      nestedAgentEvents: false,
      target: "native-agent",
      harness: "lead-agent-dispatch",
    });
    expect(
      classifyTraceExecutor(
        {
          target: "native-agent",
          harness: "lead-agent-dispatch",
          capabilities: ["jsonl-agent-events"],
        },
        {
          dispatch: agentDispatchReceiptFixture({
            digest: "d".repeat(64),
            dispatch_id: "dispatch-native-1",
            worker_id: "worker-native-1",
            batch_id: "batch-quality-1",
          }),
        },
      ),
    ).toEqual({
      kind: "native_subagent",
      role: "eval_executor",
      dispatchedBy: "lead_agent",
      dispatchBound: true,
      nestedAgentEvents: false,
      target: "native-agent",
      harness: "lead-agent-dispatch",
    });
    expect(
      classifyTraceExecutor({
        target: "codex-cli",
        harness: "codex-exec-jsonl",
        capabilities: ["jsonl-agent-events", "nested-agent-events"],
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "declared_agent_profile",
        dispatchBound: false,
        nestedAgentEvents: true,
      }),
    );
    expect(
      classifyTraceExecutor({
        target: "third-party-agent",
        harness: "remote-eval-harness",
        capabilities: ["jsonl-agent-events"],
      }),
    ).toEqual({
      kind: "declared_agent_profile",
      role: "eval_executor",
      dispatchedBy: "lead_agent",
      dispatchBound: false,
      nestedAgentEvents: false,
      target: "third-party-agent",
      harness: "remote-eval-harness",
    });
    expect(
      classifyTraceExecutor(
        {
          target: "claude-code",
          harness: "claude-stream-json",
          capabilities: ["jsonl-agent-events"],
        },
        {
          dispatch: agentDispatchReceiptFixture({
            provider: "claude-code",
            harness: "claude-stream-json",
            observation: "process_spawn",
          }),
        },
      ),
    ).toEqual({
      kind: "local_agent_process",
      role: "eval_executor",
      dispatchedBy: "lead_agent",
      dispatchBound: true,
      nestedAgentEvents: false,
      target: "claude-code",
      harness: "claude-stream-json",
    });
    expect(
      classifyTraceExecutor(
        {
          target: "third-party-agent",
          harness: "remote-eval-harness",
          capabilities: ["jsonl-agent-events"],
        },
        {
          dispatch: agentDispatchReceiptFixture({
            provider: "unexpected-agent",
            harness: "remote-eval-harness",
            observation: "external_harness",
          }),
        },
      ),
    ).toEqual(
      expect.objectContaining({
        kind: "declared_agent_profile",
        dispatchBound: false,
      }),
    );
  });
});

describe("groupAssertionComparisons", () => {
  const assertion = (
    arm: "with_skill" | "old_skill",
    status: "passed" | "failed",
    repeat = 1,
  ): SpineNode => ({
    id: `assertion:quality:${arm}:${repeat}:no-false-claim`,
    kind: "assertion",
    parent_id: "case:quality",
    label: "no-false-claim",
    status,
    arm,
    repeat,
    assertion_type: "text_not_contains",
    assertion_rule: { artifact: "outputs/response.md" },
  });

  it("groups candidate and baseline observations into one logical check", () => {
    const groups = groupAssertionComparisons(
      [
        assertion("with_skill", "failed"),
        assertion("old_skill", "failed"),
      ],
      ["with_skill", "old_skill"],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      label: "no-false-claim",
      conclusion: "both_failed",
      needsAttention: true,
    });
    expect(groups[0]?.lanes).toEqual([
      expect.objectContaining({ arm: "with_skill", state: "failed" }),
      expect.objectContaining({ arm: "old_skill", state: "failed" }),
    ]);
  });

  it("keeps passed counterpart evidence visible when only one arm fails", () => {
    const groups = groupAssertionComparisons(
      [
        assertion("with_skill", "passed"),
        assertion("old_skill", "failed"),
      ],
      ["with_skill", "old_skill"],
    );

    expect(groups[0]?.conclusion).toBe("candidate_improved");
    expect(groups[0]?.needsAttention).toBe(false);
    expect(groups[0]?.lanes[0]?.nodes[0]?.status).toBe("passed");
    expect(groups[0]?.lanes[1]?.nodes[0]?.status).toBe("failed");
  });

  it("marks repeat disagreement as mixed instead of flattening observations", () => {
    const groups = groupAssertionComparisons(
      [
        assertion("with_skill", "passed", 1),
        assertion("with_skill", "failed", 2),
        assertion("old_skill", "passed", 1),
        assertion("old_skill", "passed", 2),
      ],
      ["with_skill", "old_skill"],
    );

    expect(groups[0]?.lanes[0]).toMatchObject({
      arm: "with_skill",
      state: "mixed",
    });
    expect(groups[0]?.conclusion).toBe("mixed");
  });
});

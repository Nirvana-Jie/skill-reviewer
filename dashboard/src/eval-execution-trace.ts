import type {
  AgentDispatchReceipt,
  AgentExecutionTrace,
  AgentTraceEvent,
  DashboardArm,
  DashboardCase,
  DashboardData,
  DashboardExecution,
  SpineNode,
} from "./types";

export type TraceLifecycleState =
  | "running"
  | "completed"
  | "interrupted"
  | "unknown";
export type TraceBusinessResult = "passed" | "failed" | "unknown";
export type TraceEvidenceQuality = "complete" | "partial" | "missing";
export type TraceSemanticTone = "good" | "bad" | "warn" | "neutral";

export interface TraceEventSemantics {
  lifecycle: TraceLifecycleState;
  result: TraceBusinessResult;
  evidence: TraceEvidenceQuality;
  tone: TraceSemanticTone;
}

function detailsContainFailedCheck(details: Record<string, unknown>): boolean {
  return Object.entries(details).some(([key, value]) => {
    const normalized = key.toLowerCase();
    if (
      value === false &&
      /(?:^|_)(?:passed|success|successful|ok|valid)$/.test(normalized)
    ) {
      return true;
    }
    if (
      typeof value === "number" &&
      value > 0 &&
      /(?:^|_)(?:error|errors|failure|failures)_?count$/.test(normalized)
    ) {
      return true;
    }
    if (
      normalized === "exit_code" &&
      typeof value === "number" &&
      value !== 0
    ) {
      return true;
    }
    return false;
  });
}

export function resolveTraceEventSemantics(
  event: Pick<AgentTraceEvent, "kind" | "status" | "details">,
): TraceEventSemantics {
  const status = event.status.trim().toLowerCase();
  const lifecycle: TraceLifecycleState = ["running", "started"].includes(status)
    ? "running"
    : ["timed_out", "interrupted", "cancelled", "canceled"].includes(status)
      ? "interrupted"
      : [
            "completed",
            "passed",
            "failed",
            "rejected",
            "invalid",
            "retained",
            "agreement",
          ].includes(status) || event.kind === "execution_finished"
        ? "completed"
        : "unknown";
  const evidence: TraceEvidenceQuality =
    event.details.evidence_missing === true
      ? "missing"
      : event.details.evidence_complete === false
        ? "partial"
        : "complete";
  const failed =
    event.kind === "error" ||
    ["failed", "rejected", "regressed", "invalid", "timed_out", "interrupted"].includes(
      status,
    ) ||
    detailsContainFailedCheck(event.details);
  const passed =
    !failed && ["passed", "retained", "agreement"].includes(status);
  const result: TraceBusinessResult = failed
    ? "failed"
    : passed
      ? "passed"
      : "unknown";
  const tone: TraceSemanticTone =
    result === "failed"
      ? "bad"
      : evidence !== "complete"
        ? "warn"
        : result === "passed"
          ? "good"
          : "neutral";
  return { lifecycle, result, evidence, tone };
}

export type ExecutionTraceGap =
  | "manifest"
  | "plan_lock"
  | "execution_profile"
  | "execution_count"
  | "dispatch_receipt"
  | "execution_integrity"
  | "source_trace"
  | "trace_capture"
  | "trace_integrity";

export type AssertionLaneState = "passed" | "failed" | "mixed" | "missing";

export type AssertionComparisonConclusion =
  | "candidate_improved"
  | "candidate_regressed"
  | "both_passed"
  | "both_failed"
  | "mixed"
  | "incomplete"
  | "unpaired";

export interface AssertionComparisonLane {
  arm: string;
  state: AssertionLaneState;
  nodes: SpineNode[];
}

export interface AssertionComparisonGroup {
  id: string;
  label: string;
  nodes: SpineNode[];
  lanes: AssertionComparisonLane[];
  conclusion: AssertionComparisonConclusion;
  needsAttention: boolean;
}

export interface EvalExecutionTrace {
  case: DashboardCase;
  caseNode: SpineNode | null;
  runNode: SpineNode | null;
  caseNodes: SpineNode[];
  assertionNodes: SpineNode[];
  failedAssertionNodes: SpineNode[];
  assertionGroups: AssertionComparisonGroup[];
  attentionAssertionGroups: AssertionComparisonGroup[];
  artifactNodes: SpineNode[];
  gateNodes: SpineNode[];
  arms: DashboardArm[];
  expectedExecutions: number;
  observedExecutions: number;
  capturedTraces: number;
  deterministicAssertions: { passed: number; total: number };
  semanticAssertions: { passed: number; total: number };
  confidence: "verified" | "partial";
  gaps: ExecutionTraceGap[];
}

export interface SlowTraceExecution {
  arm: string;
  repeat: number;
  durationMs: number;
}

export interface TraceAttentionSummary {
  failedChecks: number;
  failedEvents: number;
  evidenceGaps: number;
  comparisonDifferences: number;
  slowThresholdMs: number;
  slowExecutions: SlowTraceExecution[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function buildTraceAttentionSummary(
  trace: EvalExecutionTrace,
): TraceAttentionSummary {
  const executions = trace.arms.flatMap((arm) =>
    (arm.executions ?? []).map((execution) => ({ arm, execution })),
  );
  const capturedExecutions = executions.filter(
    (
      item,
    ): item is { arm: DashboardArm; execution: InspectableTraceExecution } =>
      hasInspectableTraceExecution(item.execution),
  );
  const durations = capturedExecutions.map(
    ({ execution }) => execution.trace.duration_ms,
  );
  // Use a robust relative threshold, capped by an absolute 5 s usability bound.
  // The 1 s floor prevents tiny fixture variance from being labeled slow.
  const slowThresholdMs = Math.max(
    1000,
    Math.min(5000, median(durations) * 2),
  );
  const slowExecutions = capturedExecutions
    .flatMap(({ arm, execution }) => {
      const durationMs = execution.trace.duration_ms;
      return durationMs >= slowThresholdMs
        ? [{ arm: arm.id, repeat: execution.repeat, durationMs }]
        : [];
    });
  const failedEvents = capturedExecutions.reduce(
    (count, { execution }) =>
      count +
      execution.trace.events.filter(
        (event) => resolveTraceEventSemantics(event).result === "failed",
      ).length,
    0,
  );
  const comparisonDifferences = trace.assertionGroups.filter((group) => {
    const laneStates = new Set(group.lanes.map((lane) => lane.state));
    return group.lanes.length > 1 && laneStates.size > 1;
  }).length;

  return {
    failedChecks:
      trace.attentionAssertionGroups.length +
      trace.case.semantic_assertions.filter((assertion) => !assertion.passed).length,
    failedEvents,
    evidenceGaps: trace.gaps.length,
    comparisonDifferences,
    slowThresholdMs,
    slowExecutions,
  };
}

export interface TraceCaseIndexEntry {
  id: string;
  case: DashboardCase;
  expectedExecutions: number;
  observedExecutions: number;
  capturedTraces: number;
  durationMs: number;
  needsAttention: boolean;
}

export interface TraceExecutionMatrixCell {
  arm: DashboardArm;
  execution: DashboardExecution | null;
}

export interface TraceExecutionMatrixRow {
  repeat: number;
  cells: TraceExecutionMatrixCell[];
}

export type TraceExecutorKind =
  | "native_subagent"
  | "local_agent_process"
  | "declared_agent_profile"
  | "external_agent_harness"
  | "unrecorded";

export interface TraceExecutorContext {
  kind: TraceExecutorKind;
  role: "eval_executor";
  dispatchedBy: "lead_agent";
  dispatchBound: boolean;
  nestedAgentEvents: boolean;
  target: string | null;
  harness: string | null;
}

type ExecutionProfile = NonNullable<DashboardData["run"]["execution_profile"]>;

export function buildTraceCaseIndex(
  cases: DashboardCase[],
): TraceCaseIndexEntry[] {
  return cases.map((item) => {
    const executions = item.arms.flatMap((arm) => arm.executions ?? []);
    const expectedExecutions = item.repeats * item.arms.length;
    const capturedExecutions = executions.filter(hasInspectableTraceExecution);
    const capturedTraces = capturedExecutions.length;
    return {
      id: item.id,
      case: item,
      expectedExecutions,
      observedExecutions: executions.length,
      capturedTraces,
      durationMs: capturedExecutions.reduce(
        (total, execution) => total + (execution.trace?.duration_ms ?? 0),
        0,
      ),
      needsAttention:
        expectedExecutions === 0 ||
        item.status !== "passed" ||
        executions.length !== expectedExecutions ||
        capturedTraces !== expectedExecutions,
    };
  });
}

export function buildTraceExecutionMatrix(
  trace: EvalExecutionTrace,
): TraceExecutionMatrixRow[] {
  return Array.from({ length: trace.case.repeats }, (_, index) => {
    const repeat = index + 1;
    return {
      repeat,
      cells: trace.arms.map((arm) => ({
        arm,
        execution:
          (arm.executions ?? []).find(
            (execution) => execution.repeat === repeat,
          ) ?? null,
      })),
    };
  });
}

export function classifyTraceExecutor(
  profile: Pick<ExecutionProfile, "target" | "harness" | "capabilities"> | null | undefined,
  execution?: Pick<DashboardExecution, "dispatch"> | null,
): TraceExecutorContext {
  const target = profile?.target ?? null;
  const harness = profile?.harness ?? null;
  const dispatch = execution?.dispatch;
  const dispatchBound = Boolean(
    dispatch?.valid === true &&
      dispatch.provider === target &&
      dispatch.harness === harness,
  );
  let kind: TraceExecutorKind =
    target || harness ? "declared_agent_profile" : "unrecorded";
  if (dispatchBound) {
    kind =
      dispatch?.observation === "process_spawn"
        ? "local_agent_process"
        : dispatch?.observation === "host_dispatch"
          ? "native_subagent"
          : "external_agent_harness";
  }
  return {
    kind,
    role: "eval_executor",
    dispatchedBy: "lead_agent",
    dispatchBound,
    nestedAgentEvents: profile?.capabilities?.includes("nested-agent-events") ?? false,
    target,
    harness,
  };
}

function assertionGroupId(node: SpineNode): string {
  return [
    node.label,
    node.assertion_type ?? "unknown",
    node.assertion_rule?.artifact ?? node.artifact ?? "",
  ].join(":");
}

function assertionLaneState(nodes: SpineNode[]): AssertionLaneState {
  if (nodes.length === 0) return "missing";
  const passed = nodes.filter(
    (node) => node.status.toLowerCase() === "passed",
  ).length;
  if (passed === nodes.length) return "passed";
  if (passed === 0) return "failed";
  return "mixed";
}

function comparisonConclusion(
  lanes: AssertionComparisonLane[],
): AssertionComparisonConclusion {
  const candidate = lanes.find((lane) => lane.arm === "with_skill");
  const baseline =
    lanes.find((lane) => lane.arm === "old_skill") ??
    lanes.find((lane) => lane.arm === "without_skill");
  if (!candidate || !baseline) return "unpaired";
  if (candidate.state === "missing" || baseline.state === "missing") {
    return "incomplete";
  }
  if (candidate.state === "mixed" || baseline.state === "mixed") {
    return "mixed";
  }
  if (candidate.state === "passed" && baseline.state === "failed") {
    return "candidate_improved";
  }
  if (candidate.state === "failed" && baseline.state === "passed") {
    return "candidate_regressed";
  }
  if (candidate.state === "passed" && baseline.state === "passed") {
    return "both_passed";
  }
  return "both_failed";
}

export function groupAssertionComparisons(
  nodes: SpineNode[],
  armOrder: string[],
): AssertionComparisonGroup[] {
  const grouped = new Map<string, SpineNode[]>();
  nodes.forEach((node) => {
    const id = assertionGroupId(node);
    grouped.set(id, [...(grouped.get(id) ?? []), node]);
  });

  return Array.from(grouped, ([id, groupNodes]) => {
    const observedArms = groupNodes
      .map((node) => node.arm)
      .filter((arm): arm is string => Boolean(arm));
    const arms = [...new Set([...armOrder, ...observedArms])];
    const lanes = arms.map((arm) => {
      const laneNodes = groupNodes
        .filter((node) => node.arm === arm)
        .sort((left, right) => (left.repeat ?? 0) - (right.repeat ?? 0));
      return {
        arm,
        nodes: laneNodes,
        state: assertionLaneState(laneNodes),
      } satisfies AssertionComparisonLane;
    });
    const conclusion = comparisonConclusion(lanes);
    const needsAttention = !["candidate_improved", "both_passed"].includes(
      conclusion,
    );
    return {
      id,
      label: groupNodes[0]?.label ?? id,
      nodes: groupNodes,
      lanes,
      conclusion,
      needsAttention,
    } satisfies AssertionComparisonGroup;
  });
}

function belongsToCase(
  node: SpineNode,
  caseNodeId: string,
  nodesById: Map<string, SpineNode>,
): boolean {
  let parentId = node.parent_id;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    if (parentId === caseNodeId) return true;
    visited.add(parentId);
    parentId = nodesById.get(parentId)?.parent_id ?? null;
  }
  return false;
}

type ValidAgentExecutionTrace = Extract<AgentExecutionTrace, { valid: true }>;
type ValidAgentDispatchReceipt = Extract<AgentDispatchReceipt, { valid: true }>;

export type VerifiedTraceExecution = DashboardExecution & {
  dispatch: ValidAgentDispatchReceipt;
  trace: ValidAgentExecutionTrace;
};

export type InspectableTraceExecution = DashboardExecution & {
  trace: ValidAgentExecutionTrace;
};

export function hasInspectableTraceExecution(
  execution: NonNullable<DashboardArm["executions"]>[number],
): execution is InspectableTraceExecution {
  return (
    execution.trace?.complete === true &&
    execution.trace.valid === true &&
    execution.trace.events.length > 0 &&
    /^[a-f0-9]{64}$/i.test(execution.trace.digest ?? "")
  );
}

export function isVerifiedTraceExecution(
  execution: NonNullable<DashboardArm["executions"]>[number],
): execution is VerifiedTraceExecution {
  return (
    execution.status === "completed" &&
    execution.binding_error_count === 0 &&
    /^[a-f0-9]{64}$/i.test(execution.execution_digest ?? "") &&
    execution.dispatch?.valid === true &&
    /^[a-f0-9]{64}$/i.test(execution.dispatch.digest ?? "") &&
    execution.trace?.complete === true &&
    execution.trace.valid === true &&
    (execution.trace.source_trace_required !== true ||
      (execution.source_trace?.valid === true &&
        /^[a-f0-9]{64}$/i.test(execution.source_trace.digest ?? ""))) &&
    /^[a-f0-9]{64}$/i.test(execution.trace.digest ?? "")
  );
}

function armHasExactRepeatCoverage(
  arm: DashboardArm,
  expectedRepeats: number,
): boolean {
  const observedRepeats = (arm.executions ?? [])
    .map((execution) => execution.repeat)
    .sort((left, right) => left - right);
  return (
    expectedRepeats > 0 &&
    observedRepeats.length === expectedRepeats &&
    observedRepeats.every((repeat, index) => repeat === index + 1)
  );
}

export function buildEvalExecutionTrace(
  data: DashboardData,
  caseId: string | null | undefined,
): EvalExecutionTrace | null {
  const selectedCase =
    data.cases.find((item) => item.id === caseId) ?? data.cases[0];
  if (!selectedCase) return null;

  const nodesById = new Map(data.spine.map((node) => [node.id, node]));
  const caseNode = nodesById.get(`case:${selectedCase.id}`) ?? null;
  const runNode =
    data.spine.find((node) => node.kind === "run" && node.parent_id === null) ??
    null;
  const caseNodes = caseNode
    ? data.spine.filter(
        (node) =>
          node.id !== caseNode.id && belongsToCase(node, caseNode.id, nodesById),
      )
    : [];
  const assertionNodes = caseNodes.filter((node) => node.kind === "assertion");
  const artifactNodes = caseNodes.filter((node) => node.kind === "artifact");
  const gatePrefix = `gate:${selectedCase.id}:`;
  const gateNodes = data.spine.filter(
    (node) => node.kind === "gate" && node.id.startsWith(gatePrefix),
  );
  const executions = selectedCase.arms.flatMap((arm) => arm.executions ?? []);
  const expectedExecutions = selectedCase.repeats * selectedCase.arms.length;
  const gaps: ExecutionTraceGap[] = [];

  if (!data.run.manifest?.digest) gaps.push("manifest");
  if (
    data.run.integrity?.locked !== true ||
    data.run.integrity?.verified !== true ||
    !data.run.integrity?.plan_digest
  ) {
    gaps.push("plan_lock");
  }
  if (!data.run.execution_profile?.digest) gaps.push("execution_profile");
  if (
    expectedExecutions === 0 ||
    selectedCase.arms.some(
      (arm) => !armHasExactRepeatCoverage(arm, selectedCase.repeats),
    )
  ) {
    gaps.push("execution_count");
  }
  if (executions.some((execution) => !isVerifiedTraceExecution(execution))) {
    gaps.push("execution_integrity");
  }
  if (executions.some((execution) => execution.dispatch?.valid !== true)) {
    gaps.push("dispatch_receipt");
  }
  if (
    executions.some(
      (execution) =>
        execution.trace?.source_trace_required === true &&
        execution.source_trace?.valid !== true,
    )
  ) {
    gaps.push("source_trace");
  }
  if (executions.some((execution) => !execution.trace)) {
    gaps.push("trace_capture");
  }
  if (
    executions.some(
      (execution) =>
        execution.trace &&
        (execution.trace.valid !== true ||
          execution.trace.complete !== true ||
          execution.trace.events.length === 0 ||
          execution.trace.event_count !== execution.trace.events.length),
    )
  ) {
    gaps.push("trace_integrity");
  }
  const assertionGroups = groupAssertionComparisons(
    assertionNodes.filter((node) => Boolean(node.arm)),
    selectedCase.arms.map((arm) => arm.id),
  );

  return {
    case: selectedCase,
    caseNode,
    runNode,
    caseNodes,
    assertionNodes,
    failedAssertionNodes: assertionNodes.filter(
      (node) => node.status.toLowerCase() !== "passed",
    ),
    assertionGroups,
    attentionAssertionGroups: assertionGroups.filter(
      (group) => group.needsAttention,
    ),
    artifactNodes,
    gateNodes,
    arms: selectedCase.arms,
    expectedExecutions,
    observedExecutions: executions.length,
    capturedTraces: executions.filter(hasInspectableTraceExecution).length,
    deterministicAssertions: selectedCase.arms.reduce(
      (summary, arm) => ({
        passed: summary.passed + arm.assertions.passed,
        total: summary.total + arm.assertions.total,
      }),
      { passed: 0, total: 0 },
    ),
    semanticAssertions: {
      passed: selectedCase.semantic_assertions.filter(
        (assertion) => assertion.passed,
      ).length,
      total: selectedCase.semantic_assertions.length,
    },
    confidence: gaps.length === 0 ? "verified" : "partial",
    gaps,
  };
}

export function firstArmEvidenceId(
  trace: EvalExecutionTrace,
  armId: string,
): string | null {
  return (
    trace.failedAssertionNodes.find((node) => node.arm === armId)?.id ??
    trace.assertionNodes.find((node) => node.arm === armId)?.id ??
    trace.artifactNodes.find((node) => node.arm === armId)?.id ??
    trace.caseNode?.id ??
    null
  );
}

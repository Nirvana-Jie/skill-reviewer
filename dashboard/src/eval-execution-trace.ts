import type {
  DashboardArm,
  DashboardCase,
  DashboardData,
  DashboardExecution,
  SpineNode,
} from "./types";

export type ExecutionTraceGap =
  | "manifest"
  | "plan_lock"
  | "execution_profile"
  | "execution_count"
  | "execution_integrity"
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
  | "external_agent_harness"
  | "unrecognized_profile"
  | "unrecorded";

export interface TraceExecutorContext {
  kind: TraceExecutorKind;
  role: "eval_executor";
  dispatchedBy: "lead_agent";
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
    const verifiedExecutions = executions.filter(isVerifiedTraceExecution);
    const capturedTraces = verifiedExecutions.length;
    return {
      id: item.id,
      case: item,
      expectedExecutions,
      observedExecutions: executions.length,
      capturedTraces,
      durationMs: verifiedExecutions.reduce(
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
): TraceExecutorContext {
  const target = profile?.target ?? null;
  const harness = profile?.harness ?? null;
  let kind: TraceExecutorKind =
    target || harness ? "external_agent_harness" : "unrecorded";
  if (target === "codex-cli" && harness === "codex-exec-jsonl") {
    kind = "local_agent_process";
  } else if (target === "native-agent" && harness === "lead-agent-dispatch") {
    kind = "native_subagent";
  } else if (
    target === "codex-cli" ||
    target === "native-agent" ||
    harness === "codex-exec-jsonl" ||
    harness === "lead-agent-dispatch"
  ) {
    kind = "unrecognized_profile";
  }
  return {
    kind,
    role: "eval_executor",
    dispatchedBy: "lead_agent",
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

export function isVerifiedTraceExecution(
  execution: NonNullable<DashboardArm["executions"]>[number],
): boolean {
  return (
    execution.status === "completed" &&
    execution.binding_error_count === 0 &&
    /^[a-f0-9]{64}$/i.test(execution.execution_digest ?? "") &&
    execution.trace?.complete === true &&
    execution.trace.valid === true &&
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
    capturedTraces: executions.filter(isVerifiedTraceExecution).length,
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

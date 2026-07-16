import type {
  DashboardArm,
  DashboardCase,
  DashboardData,
  SpineNode,
} from "./types";

export type ExecutionTraceGap =
  | "manifest"
  | "plan_lock"
  | "execution_profile"
  | "execution_count"
  | "execution_integrity"
  | "evidence_nodes";

export interface EvalExecutionTrace {
  case: DashboardCase;
  caseNode: SpineNode | null;
  runNode: SpineNode | null;
  caseNodes: SpineNode[];
  assertionNodes: SpineNode[];
  failedAssertionNodes: SpineNode[];
  artifactNodes: SpineNode[];
  gateNodes: SpineNode[];
  arms: DashboardArm[];
  expectedExecutions: number;
  observedExecutions: number;
  deterministicAssertions: { passed: number; total: number };
  semanticAssertions: { passed: number; total: number };
  confidence: "verified" | "partial";
  gaps: ExecutionTraceGap[];
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

function executionIsBound(
  execution: NonNullable<DashboardArm["executions"]>[number],
): boolean {
  return (
    execution.status === "completed" &&
    execution.binding_error_count === 0 &&
    /^[a-f0-9]{64}$/i.test(execution.execution_digest ?? "")
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
  if (executions.some((execution) => !executionIsBound(execution))) {
    gaps.push("execution_integrity");
  }
  if (!caseNode || caseNodes.length === 0) gaps.push("evidence_nodes");

  return {
    case: selectedCase,
    caseNode,
    runNode,
    caseNodes,
    assertionNodes,
    failedAssertionNodes: assertionNodes.filter(
      (node) => node.status.toLowerCase() !== "passed",
    ),
    artifactNodes,
    gateNodes,
    arms: selectedCase.arms,
    expectedExecutions,
    observedExecutions: executions.length,
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

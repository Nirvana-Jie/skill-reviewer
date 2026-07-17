import type { SpineNode } from "./types";

const armRank: Record<string, number> = {
  with_skill: 1,
  old_skill: 2,
  without_skill: 3,
};

function caseChildRank(node: SpineNode): [number, number] {
  if (node.kind === "gate") return [0, 0];
  if (node.arm) {
    return [armRank[node.arm] ?? 4, node.kind === "artifact" ? 1 : 0];
  }
  return [5, node.kind === "artifact" ? 1 : 0];
}

export interface EvidenceComparisonPair {
  key: string;
  candidate: SpineNode | null;
  baseline: SpineNode | null;
}

export type EvidenceDisplayItem =
  | {
      type: "node";
      key: string;
      node: SpineNode;
    }
  | {
      type: "comparison";
      key: string;
      parentId: string;
      candidateArm: "with_skill";
      baselineArm: string;
      candidateNodes: SpineNode[];
      baselineNodes: SpineNode[];
      pairs: EvidenceComparisonPair[];
    };

const baselineArmRank: Record<string, number> = {
  old_skill: 1,
  without_skill: 2,
};

function comparisonKey(node: SpineNode): string {
  if (node.arm) {
    const armSegment = `:${node.arm}:`;
    if (node.id.includes(armSegment)) {
      return node.id.replace(armSegment, ":<arm>:");
    }
  }
  return [
    node.kind,
    node.repeat ?? "",
    node.assertion_type ?? "",
    node.label,
    node.path?.replace(/\/(with_skill|old_skill|without_skill)\//, "/<arm>/") ?? "",
  ].join(":");
}

function pairArmNodes(
  candidateNodes: SpineNode[],
  baselineNodes: SpineNode[],
): EvidenceComparisonPair[] {
  const baselineQueues = new Map<string, SpineNode[]>();
  baselineNodes.forEach((node) => {
    const key = comparisonKey(node);
    const queue = baselineQueues.get(key) ?? [];
    queue.push(node);
    baselineQueues.set(key, queue);
  });

  const pairs: EvidenceComparisonPair[] = candidateNodes.map((candidate) => {
    const key = comparisonKey(candidate);
    const queue = baselineQueues.get(key) ?? [];
    const baseline = queue.shift() ?? null;
    if (queue.length === 0) baselineQueues.delete(key);
    return { key, candidate, baseline };
  });

  baselineNodes.forEach((baseline) => {
    const key = comparisonKey(baseline);
    const queue = baselineQueues.get(key);
    if (!queue?.includes(baseline)) return;
    pairs.push({ key, candidate: null, baseline });
    queue.splice(queue.indexOf(baseline), 1);
    if (queue.length === 0) baselineQueues.delete(key);
  });
  return pairs;
}

/**
 * Converts arm-specific case evidence into paired visual rows. A comparison is
 * emitted only when both a candidate and one baseline arm are present; partial
 * or single-arm evidence remains in the ordinary hierarchy instead of
 * pretending that a comparison exists.
 */
export function buildEvidenceDisplayItems(
  nodes: SpineNode[],
): EvidenceDisplayItem[] {
  const armNodesByParent = new Map<string, SpineNode[]>();
  nodes.forEach((node) => {
    if (!node.arm || !node.parent_id) return;
    const siblings = armNodesByParent.get(node.parent_id) ?? [];
    siblings.push(node);
    armNodesByParent.set(node.parent_id, siblings);
  });

  const comparisons = new Map<
    string,
    Extract<EvidenceDisplayItem, { type: "comparison" }>
  >();
  armNodesByParent.forEach((armNodes, parentId) => {
    const candidateNodes = armNodes.filter((node) => node.arm === "with_skill");
    const baselineArm = [...new Set(
      armNodes
        .map((node) => node.arm)
        .filter((arm): arm is string => Boolean(arm && arm !== "with_skill")),
    )].sort(
      (left, right) =>
        (baselineArmRank[left] ?? 99) - (baselineArmRank[right] ?? 99),
    )[0];
    if (candidateNodes.length === 0 || !baselineArm) return;
    const baselineNodes = armNodes.filter((node) => node.arm === baselineArm);
    if (baselineNodes.length === 0) return;
    comparisons.set(parentId, {
      type: "comparison",
      key: `comparison:${parentId}:${baselineArm}`,
      parentId,
      candidateArm: "with_skill",
      baselineArm,
      candidateNodes,
      baselineNodes,
      pairs: pairArmNodes(candidateNodes, baselineNodes),
    });
  });

  const emittedComparisons = new Set<string>();
  return nodes.flatMap((node): EvidenceDisplayItem[] => {
    const comparison = node.parent_id
      ? comparisons.get(node.parent_id)
      : undefined;
    const belongsToComparison =
      comparison &&
      (node.arm === comparison.candidateArm ||
        node.arm === comparison.baselineArm);
    if (!belongsToComparison || !comparison) {
      return [{ type: "node", key: node.id, node }];
    }
    if (emittedComparisons.has(comparison.key)) return [];
    emittedComparisons.add(comparison.key);
    return [comparison];
  });
}

/**
 * Rebuild the evidence spine as a stable pre-order tree. Case children are
 * grouped by experimental arm so historical projections can be paired into
 * stable candidate-versus-baseline rows even when the raw order interleaves
 * observations.
 */
export function orderEvidenceSpineNodes(nodes: SpineNode[]): SpineNode[] {
  const originalIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string | null, SpineNode[]>();

  nodes.forEach((node) => {
    const siblings = childrenByParent.get(node.parent_id) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parent_id, siblings);
  });

  const ordered: SpineNode[] = [];
  const visited = new Set<string>();

  const visit = (node: SpineNode) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    ordered.push(node);

    const children = [...(childrenByParent.get(node.id) ?? [])];
    if (node.kind === "case") {
      children.sort((left, right) => {
        const [leftArm, leftKind] = caseChildRank(left);
        const [rightArm, rightKind] = caseChildRank(right);
        return (
          leftArm - rightArm ||
          leftKind - rightKind ||
          (originalIndex.get(left.id) ?? 0) -
            (originalIndex.get(right.id) ?? 0)
        );
      });
    } else {
      children.sort(
        (left, right) =>
          (originalIndex.get(left.id) ?? 0) -
          (originalIndex.get(right.id) ?? 0),
      );
    }
    children.forEach(visit);
  };

  const roots = nodes.filter(
    (node) => node.parent_id === null || !nodesById.has(node.parent_id),
  );
  roots.forEach(visit);
  nodes.forEach(visit);
  return ordered;
}

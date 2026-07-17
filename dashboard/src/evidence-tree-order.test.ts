import { describe, expect, it } from "vitest";

import {
  buildEvidenceDisplayItems,
  orderEvidenceSpineNodes,
} from "./evidence-tree-order";
import type { SpineNode } from "./types";

function node(
  id: string,
  kind: SpineNode["kind"],
  parentId: string | null,
  arm?: string,
): SpineNode {
  return {
    id,
    kind,
    parent_id: parentId,
    label: id,
    status: "passed",
    arm,
  };
}

describe("orderEvidenceSpineNodes", () => {
  it("groups a historical interleaved case into candidate then baseline lanes", () => {
    const nodes = [
      node("run", "run", null),
      node("case", "case", "run"),
      node("gate", "gate", "case"),
      node("old-failed", "assertion", "case", "old_skill"),
      node("candidate-a", "assertion", "case", "with_skill"),
      node("old-a", "assertion", "case", "old_skill"),
      node("candidate-artifact", "artifact", "case", "with_skill"),
      node("old-artifact", "artifact", "case", "old_skill"),
    ];

    expect(orderEvidenceSpineNodes(nodes).map((item) => item.id)).toEqual([
      "run",
      "case",
      "gate",
      "candidate-a",
      "candidate-artifact",
      "old-failed",
      "old-a",
      "old-artifact",
    ]);
  });

  it("keeps non-case sibling order and preserves orphaned evidence", () => {
    const nodes = [
      node("run", "run", null),
      node("iteration", "iteration", "run"),
      node("case", "case", "run"),
      node("orphan", "artifact", "missing", "with_skill"),
    ];

    expect(orderEvidenceSpineNodes(nodes).map((item) => item.id)).toEqual([
      "run",
      "iteration",
      "case",
      "orphan",
    ]);
  });
});

describe("buildEvidenceDisplayItems", () => {
  it("pairs candidate and old-skill evidence by semantic node identity", () => {
    const nodes = orderEvidenceSpineNodes([
      node("run", "run", null),
      node("case", "case", "run"),
      node("assertion:case:old_skill:1:response", "assertion", "case", "old_skill"),
      node("assertion:case:with_skill:1:response", "assertion", "case", "with_skill"),
      node("artifact:case:with_skill:0", "artifact", "case", "with_skill"),
      node("artifact:case:old_skill:0", "artifact", "case", "old_skill"),
      node("assertion:case:with_skill:1:candidate-only", "assertion", "case", "with_skill"),
    ]);

    const items = buildEvidenceDisplayItems(nodes);
    expect(items.map((item) => item.type)).toEqual([
      "node",
      "node",
      "comparison",
    ]);
    const comparison = items[2];
    expect(comparison?.type).toBe("comparison");
    if (!comparison || comparison.type !== "comparison") return;
    expect(comparison.baselineArm).toBe("old_skill");
    expect(comparison.pairs).toHaveLength(3);
    expect(comparison.pairs[0]).toEqual(
      expect.objectContaining({
        candidate: expect.objectContaining({
          id: "assertion:case:with_skill:1:response",
        }),
        baseline: expect.objectContaining({
          id: "assertion:case:old_skill:1:response",
        }),
      }),
    );
    expect(
      comparison.pairs.find(
        (pair) =>
          pair.candidate?.id ===
          "assertion:case:with_skill:1:candidate-only",
      ),
    ).toEqual(
      expect.objectContaining({
        candidate: expect.objectContaining({
          id: "assertion:case:with_skill:1:candidate-only",
        }),
        baseline: null,
      }),
    );
  });

  it("does not invent a comparison for single-arm evidence", () => {
    const nodes = [
      node("run", "run", null),
      node("case", "case", "run"),
      node("artifact:case:with_skill:0", "artifact", "case", "with_skill"),
    ];

    expect(buildEvidenceDisplayItems(nodes).map((item) => item.type)).toEqual([
      "node",
      "node",
      "node",
    ]);
  });

  it("uses without-skill as the comparison baseline when no old skill exists", () => {
    const items = buildEvidenceDisplayItems([
      node("case", "case", null),
      node("assertion:case:with_skill:1:response", "assertion", "case", "with_skill"),
      node("assertion:case:without_skill:1:response", "assertion", "case", "without_skill"),
    ]);
    const comparison = items[1];
    expect(comparison?.type).toBe("comparison");
    if (!comparison || comparison.type !== "comparison") return;
    expect(comparison.baselineArm).toBe("without_skill");
    expect(comparison.pairs[0]?.baseline?.arm).toBe("without_skill");
  });
});

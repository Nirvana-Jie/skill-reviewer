import { describe, expect, it } from "vitest";

import {
  buildDiffTree,
  directoryAncestorIds,
  flattenDiffTree,
} from "./diff-tree";
import type { DashboardDiff } from "./types";

function diff(id: string, path: string): DashboardDiff {
  return {
    id,
    path,
    status: "modified",
    old_digest: null,
    new_digest: null,
    old_size: 1,
    new_size: 2,
    binary: false,
    render_mode: "summary",
    content_url: null,
    payload_digest: null,
  };
}

describe("diff tree", () => {
  const diffs = [
    diff("root", "SKILL.md"),
    diff("workflow", "references/evolution/workflow.md"),
    diff("rubric", "references/review-rubric.md"),
    diff("runner", "scripts/run.py"),
  ];

  it("groups paths into sorted directories and counts descendant files", () => {
    const tree = buildDiffTree(diffs);

    expect(tree.fileCount).toBe(4);
    expect(tree.children.map((node) => node.name)).toEqual([
      "references",
      "scripts",
      "SKILL.md",
    ]);
    const references = tree.children[0];
    expect(references).toMatchObject({
      kind: "directory",
      id: "directory:references",
      fileCount: 2,
    });
    if (references?.kind !== "directory") throw new Error("expected directory");
    expect(references.children.map((node) => node.name)).toEqual([
      "evolution",
      "review-rubric.md",
    ]);
  });

  it("collapses a directory while search can force matching branches open", () => {
    const tree = buildDiffTree(diffs);
    const collapsed = new Set(["directory:references"]);

    expect(
      flattenDiffTree(tree, collapsed).map(({ node }) => node.path),
    ).toEqual(["references", "scripts", "scripts/run.py", "SKILL.md"]);
    expect(
      flattenDiffTree(tree, collapsed, true).map(({ node }) => node.path),
    ).toContain("references/evolution/workflow.md");
  });

  it("returns every directory that must be opened to reveal a file", () => {
    expect(
      directoryAncestorIds("references/evolution/workflow.md"),
    ).toEqual([
      "directory:references",
      "directory:references/evolution",
    ]);
    expect(directoryAncestorIds("SKILL.md")).toEqual([]);
  });
});

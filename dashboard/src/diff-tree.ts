import type { DashboardDiff } from "./types";

export interface DiffTreeFile {
  kind: "file";
  id: string;
  name: string;
  path: string;
  diff: DashboardDiff;
}

export interface DiffTreeDirectory {
  kind: "directory";
  id: string;
  name: string;
  path: string;
  fileCount: number;
  children: DiffTreeNode[];
}

export type DiffTreeNode = DiffTreeDirectory | DiffTreeFile;

export interface DiffTreeRow {
  node: DiffTreeNode;
  depth: number;
}

interface MutableDirectory {
  name: string;
  path: string;
  directories: Map<string, MutableDirectory>;
  files: DiffTreeFile[];
}

function directoryId(path: string): string {
  return `directory:${path}`;
}

function finalizeDirectory(directory: MutableDirectory): DiffTreeDirectory {
  const directories = Array.from(directory.directories.values())
    .map(finalizeDirectory)
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [...directory.files].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const children: DiffTreeNode[] = [...directories, ...files];
  return {
    kind: "directory",
    id: directoryId(directory.path),
    name: directory.name,
    path: directory.path,
    fileCount: children.reduce(
      (count, child) =>
        count + (child.kind === "directory" ? child.fileCount : 1),
      0,
    ),
    children,
  };
}

export function buildDiffTree(diffs: DashboardDiff[]): DiffTreeDirectory {
  const root: MutableDirectory = {
    name: "",
    path: "",
    directories: new Map(),
    files: [],
  };

  diffs.forEach((diff) => {
    const segments = diff.path.split("/").filter(Boolean);
    const name = segments.pop() ?? diff.path;
    let current = root;
    segments.forEach((segment) => {
      const path = current.path ? `${current.path}/${segment}` : segment;
      let child = current.directories.get(segment);
      if (!child) {
        child = {
          name: segment,
          path,
          directories: new Map(),
          files: [],
        };
        current.directories.set(segment, child);
      }
      current = child;
    });
    current.files.push({
      kind: "file",
      id: `file:${diff.id}`,
      name,
      path: diff.path,
      diff,
    });
  });

  return finalizeDirectory(root);
}

export function flattenDiffTree(
  root: DiffTreeDirectory,
  collapsedDirectoryIds: ReadonlySet<string>,
  forceExpand = false,
): DiffTreeRow[] {
  const rows: DiffTreeRow[] = [];

  const visit = (node: DiffTreeNode, depth: number) => {
    rows.push({ node, depth });
    if (
      node.kind === "directory" &&
      (forceExpand || !collapsedDirectoryIds.has(node.id))
    ) {
      node.children.forEach((child) => visit(child, depth + 1));
    }
  };

  root.children.forEach((child) => visit(child, 0));
  return rows;
}

export function directoryAncestorIds(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.map((_, index) =>
    directoryId(segments.slice(0, index + 1).join("/")),
  );
}

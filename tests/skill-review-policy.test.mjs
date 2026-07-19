import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(repoRoot, "skills", "skill-reviewer", "SKILL.md");
const referencePath = (name) =>
  join(repoRoot, "skills", "skill-reviewer", "references", name);
const referencesRoot = dirname(referencePath("placeholder"));
const scriptsRoot = join(repoRoot, "skills", "skill-reviewer", "scripts");

function filesBelow(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesBelow(root, path));
      continue;
    }
    files.push(relative(root, path).split(sep).join("/"));
  }
  return files.sort();
}

function section(markdown, start, end) {
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`missing section boundary: ${start} -> ${end}`);
  }
  return markdown.slice(startIndex, endIndex);
}

function localSkillEvalImports(source) {
  return [...source.matchAll(/from\s+["']\.\/(skill-eval-[a-z-]+)\.mjs["']/g)]
    .map((match) => match[1]);
}

describe("Skill Reviewer execution policy", () => {
  it("keeps Review read-only and reserves workers for explicit Verify or Evolve", () => {
    const skill = readFileSync(skillPath, "utf8");
    const branchPolicy = section(
      skill,
      "### 1. Pin the subject and branch",
      "### 2. Run the package-facts axis",
    );
    const normalizedPolicy = branchPolicy.replace(/\s+/g, " ");

    expect(branchPolicy).toContain("**Review (default)**");
    expect(normalizedPolicy).toContain("does not compile an Eval workspace or dispatch a worker");
    expect(branchPolicy).toContain("**Verify (explicit)**");
    expect(branchPolicy).toContain("**Evolve (explicit)**");
    expect(skill.replace(/\s+/g, " ")).toContain(
      "Prefer skill-creator for creating, editing, or openly optimizing a Skill",
    );
    expect(skill).not.toContain(
      "For a full/readiness branch, auto-discover and execute a valid manifest.",
    );
  });

  it("keeps mode and verification-level semantics single-sourced in SKILL.md", () => {
    const skill = readFileSync(skillPath, "utf8");
    const evolution = readFileSync(referencePath("evolution-workflow.md"), "utf8");
    const verification = readFileSync(
      referencePath("verification-workflow.md"),
      "utf8",
    );
    const rubric = readFileSync(referencePath("review-rubric.md"), "utf8");
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedRubric = rubric.replace(/\s+/g, " ");
    const normalizedVerification = verification.replace(/\s+/g, " ");

    expect(evolution).not.toContain("A full review may automatically execute");
    expect(verification).not.toContain("when a full review must execute");
    expect(normalizedSkill).toContain(
      "Review keeps verification `not-run`; requested Verify or Evolve reports `inconclusive`",
    );
    expect(normalizedRubric).toContain(
      "`SKILL.md` owns mode selection and verification-level semantics",
    );
    expect(normalizedVerification).toContain(
      "`SKILL.md` owns mode selection and verification-level semantics",
    );
    expect(verification).not.toContain("`not-run`");
    expect(rubric).not.toContain("`not-run`");
  });

  it("keeps the model-facing skill interface closed and deliberately small", () => {
    const skill = readFileSync(skillPath, "utf8");
    const referenceNames = filesBelow(referencesRoot);

    expect(referenceNames).toEqual([
      "evolution-workflow.md",
      "output-contract.md",
      "review-rubric.md",
      "verification-workflow.md",
    ]);
    expect(skill.split(/\r?\n/).length).toBeLessThanOrEqual(240);
    expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(16 * 1024);
    let totalReferenceBytes = 0;
    for (const name of referenceNames) {
      const reference = readFileSync(referencePath(name), "utf8");
      const bytes = Buffer.byteLength(reference);
      totalReferenceBytes += bytes;
      expect(
        reference.split(/\r?\n/).length,
        `${name} exceeds the branch reference budget`,
      ).toBeLessThanOrEqual(180);
      expect(bytes, `${name} exceeds the branch byte budget`).toBeLessThanOrEqual(
        12 * 1024,
      );
    }
    expect(totalReferenceBytes).toBeLessThanOrEqual(32 * 1024);
  });

  it("keeps runtime domain imports public and acyclic", () => {
    const domainFiles = filesBelow(scriptsRoot).filter((name) =>
      /^lib\/skill-eval-[a-z-]+\.mjs$/.test(name),
    );
    const moduleNames = new Set(
      domainFiles.map((name) => name.split("/").at(-1).replace(/\.mjs$/, "")),
    );
    const graph = new Map();

    for (const name of domainFiles) {
      const moduleName = name.split("/").at(-1).replace(/\.mjs$/, "");
      const imports = localSkillEvalImports(
        readFileSync(join(scriptsRoot, name), "utf8"),
      );
      graph.set(
        moduleName,
        imports.filter((dependency) => moduleNames.has(dependency)),
      );
    }

    const visited = new Set();
    const active = new Set();
    const cycles = [];
    function visit(moduleName, path = []) {
      if (active.has(moduleName)) {
        cycles.push([...path, moduleName].join(" -> "));
        return;
      }
      if (visited.has(moduleName)) return;
      active.add(moduleName);
      for (const dependency of graph.get(moduleName) ?? []) {
        visit(dependency, [...path, moduleName]);
      }
      active.delete(moduleName);
      visited.add(moduleName);
    }
    for (const moduleName of graph.keys()) visit(moduleName);

    expect(cycles).toEqual([]);
  });

  it("opens the Dashboard only on explicit request and keeps it out of review authority", () => {
    const skill = readFileSync(skillPath, "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const chineseReadme = readFileSync(join(repoRoot, "README.zh-CN.md"), "utf8");
    const dashboard = section(
      skill,
      "### Dashboard",
      "### 6. Emit the review",
    ).replace(/\s+/g, " ");

    expect(dashboard).toContain("only when the user explicitly requests it");
    expect(dashboard).toContain("does not grade, mutate evidence, or authorize release");
    expect(dashboard).not.toContain("structured question");
    expect(dashboard).not.toContain("Action Center");
    expect(readme).not.toContain("standalone structured choice");
    expect(chineseReadme).not.toContain("结构化问题");
  });

  it("keeps the Dashboard release manifest drift guard in deterministic CI", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github", "workflows", "static-checks.yml"),
      "utf8",
    ).replace(/\s+/g, " ");

    expect(workflow).toContain(
      "cmp skills/skill-reviewer/assets/dashboard-ui-bundle.json",
    );
    expect(workflow).toContain(
      "--manifest skills/skill-reviewer/assets/dashboard-ui-bundle.json",
    );
  });
});

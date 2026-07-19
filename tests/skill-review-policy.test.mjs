import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(repoRoot, "skills", "skill-reviewer", "SKILL.md");
const referencePath = (name) =>
  join(repoRoot, "skills", "skill-reviewer", "references", name);

function section(markdown, start, end) {
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`missing section boundary: ${start} -> ${end}`);
  }
  return markdown.slice(startIndex, endIndex);
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
    expect(skill).not.toContain(
      "For a full/readiness branch, auto-discover and execute a valid manifest.",
    );
  });

  it("keeps the Review execution boundary consistent across runtime references", () => {
    const skill = readFileSync(skillPath, "utf8");
    const evolution = readFileSync(referencePath("evolution-workflow.md"), "utf8");
    const executableEvals = readFileSync(
      referencePath("executable-evals.md"),
      "utf8",
    );
    const rubric = readFileSync(referencePath("review-rubric.md"), "utf8");
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedRubric = rubric.replace(/\s+/g, " ");

    expect(evolution).not.toContain("A full review may automatically execute");
    expect(executableEvals).not.toContain("when a full review must execute");
    expect(executableEvals).toContain(
      "Review reports `not-run`; only an explicit Verify or Evolve attempt can become `inconclusive`.",
    );
    expect(normalizedSkill).toContain(
      "Review keeps verification `not-run`; requested Verify or Evolve reports `inconclusive`",
    );
    expect(normalizedRubric).toContain(
      "Review records `not-run` because execution was not attempted; explicit Verify or Evolve records `inconclusive`",
    );
    expect(rubric).not.toContain("silently downgrade it to `not-run`");
  });
});

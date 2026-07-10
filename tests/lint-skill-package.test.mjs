import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const linter = join(repoRoot, "scripts", "lint_skill_package.py");
const python = process.env.PYTHON ?? "python3";

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function run(target, ...args) {
  const result = spawnSync(
    python,
    [linter, target, "--format", "json", ...args],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    report: JSON.parse(result.stdout),
  };
}

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "skill-reviewer-lint-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("lint_skill_package.py", () => {
  it("accepts a structurally valid skill and resolves its resource graph", () => {
    fixture((root) => {
      write(
        root,
        "SKILL.md",
        `---
name: demo-skill
description: >
  Review demo inputs when the user asks for a demo review.
---

# Demo

Read \`references/rules.md\` and return a review.

## References

- \`references/rules.md\` — rules for every run.
`,
      );
      write(root, "references/rules.md", "# Rules\n\nBe precise.\n");

      const { status, report } = run(root);

      expect(status).toBe(0);
      expect(report.passed).toBe(true);
      expect(report.summary.errors).toBe(0);
      expect(report.subject.skill_name).toBe("demo-skill");
    });
  });

  it("fails when SKILL.md has no closed front matter", () => {
    fixture((root) => {
      write(root, "SKILL.md", "# Missing front matter\n");

      const { status, report } = run(root);

      expect(status).toBe(1);
      expect(report.findings.map((finding) => finding.rule_id)).toContain(
        "frontmatter.missing",
      );
    });
  });

  it("fails on broken local links", () => {
    fixture((root) => {
      write(
        root,
        "SKILL.md",
        `---
name: linked-skill
description: Review linked skill packages.
---

# Linked

Read [missing rules](references/missing.md).
`,
      );

      const { status, report } = run(root);

      expect(status).toBe(1);
      expect(report.findings.map((finding) => finding.rule_id)).toContain(
        "link.missing-target",
      );
    });
  });

  it("checks local links in package Markdown files relative to their own directory", () => {
    fixture((root) => {
      write(
        root,
        "SKILL.md",
        `---
name: linked-reference-skill
description: Review linked reference skill packages.
---

# Linked references

Read \`references/rules.md\`.
`,
      );
      write(
        root,
        "references/rules.md",
        "# Rules\n\nRead [missing sibling](missing-sibling.md).\n",
      );

      const { status, report } = run(root);

      expect(status).toBe(1);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "link.missing-target",
            path: "references/rules.md",
          }),
        ]),
      );
    });
  });

  it("rejects malformed front matter and duplicate keys", () => {
    fixture((root) => {
      write(
        root,
        "SKILL.md",
        `---
name: malformed-skill
name: duplicate-skill
: invalid YAML
description: Review malformed skill packages.
---

# Malformed
`,
      );

      const { status, report } = run(root);
      const invalid = report.findings.filter(
        (finding) => finding.rule_id === "frontmatter.invalid-yaml",
      );

      expect(status).toBe(1);
      expect(invalid).toHaveLength(2);
      expect(invalid.map((finding) => finding.message).join("\n")).toContain(
        "duplicate front matter key",
      );
      expect(report.subject.skill_name).toBe("malformed-skill");
    });
  });

  it.each([
    ["description: foo: bar", "plain scalar contains"],
    ['description: "unterminated', "invalid or unterminated double-quoted scalar"],
    ["description: [unsupported, flow]", "flow collections"],
    ["description: ]bad", "reserved indicators"],
    ["description: }bad", "reserved indicators"],
    ["description: ,bad", "reserved indicators"],
    ["description: %bad", "reserved indicators"],
    ["description: > bad", "reserved indicators"],
    ["description: | bad", "reserved indicators"],
  ])("rejects unsupported front matter scalar syntax: %s", (description, message) => {
    fixture((root) => {
      write(
        root,
        "SKILL.md",
        `---
name: scalar-skill
${description}
---

# Scalar
`,
      );

      const { status, report } = run(root);

      expect(status).toBe(1);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "frontmatter.invalid-yaml",
            message: expect.stringContaining(message),
          }),
        ]),
      );
    });
  });

  it("reports unreferenced resources as warnings without failing by default", () => {
    fixture((root) => {
      write(
        root,
        "SKILL.md",
        `---
name: quiet-skill
description: Review quiet skill packages.
---

# Quiet

Return a review.
`,
      );
      write(root, "references/orphan.md", "# Orphan\n");

      const { status, report } = run(root);

      expect(status).toBe(0);
      expect(report.passed).toBe(true);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "resource.unreferenced",
            severity: "warning",
          }),
        ]),
      );
    });
  });

  it("rejects duplicate behavior eval ids", () => {
    fixture((root) => {
      write(
        root,
        "SKILL.md",
        `---
name: eval-skill
description: Review eval skill packages.
---

# Eval

Use the \`evals/\` cases.
`,
      );
      write(
        root,
        "evals/evals.json",
        JSON.stringify({
          skill_name: "eval-skill",
          evals: [
            { id: 1, prompt: "one", expected_output: "one", files: [] },
            { id: 1, prompt: "two", expected_output: "two", files: [] },
          ],
        }),
      );

      const { status, report } = run(root);

      expect(status).toBe(1);
      expect(report.findings.map((finding) => finding.rule_id)).toContain(
        "eval.duplicate-id",
      );
    });
  });

  it("rejects behavior eval input files that do not exist", () => {
    fixture((root) => {
      write(
        root,
        "SKILL.md",
        `---
name: file-eval-skill
description: Review file-backed eval skill packages.
---

# Eval

Use the \`evals/\` cases.
`,
      );
      write(
        root,
        "evals/evals.json",
        JSON.stringify({
          skill_name: "file-eval-skill",
          evals: [
            {
              id: 1,
              prompt: "review it",
              expected_output: "a review",
              files: ["evals/files/missing.md"],
            },
          ],
        }),
      );

      const { status, report } = run(root);

      expect(status).toBe(1);
      expect(report.findings.map((finding) => finding.rule_id)).toContain(
        "eval.case-file",
      );
    });
  });

  it("self-lints the current skill package without structural errors", () => {
    const { status, report, stderr } = run(repoRoot);

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.summary.errors).toBe(0);
  });
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = join(repoRoot, "skills", "skill-reviewer");
const linter = join(skillRoot, "scripts", "lint_skill_package.py");
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

function executableManifest(skillName, evals) {
  return {
    contract: "skill-reviewer.evals",
    skill_name: skillName,
    defaults: {
      permissions: { network: "deny", writable_roots: ["outputs"] },
      repeats: { deterministic: 1, stochastic: 3 },
      evolution: { max_rounds: 3 },
      case_timeout_seconds: 300,
    },
    evals,
  };
}

function evalCase(overrides = {}) {
  return {
    id: "one",
    purpose: "Exercise the skill behavior.",
    split: "selection",
    prompt: "Review it.",
    determinism: "deterministic",
    files: [],
    assertions: [
      {
        id: "response-exists",
        type: "file_exists",
        artifact: "outputs/response.md",
        severity: "must_pass",
      },
    ],
    objectives: [
      {
        id: "quality",
        metric: "required_pass_rate",
        direction: "maximize",
        min_material_delta: 0.1,
        non_regression_tolerance: 0,
      },
    ],
    ...overrides,
  };
}

describe("lint_skill_package.py", () => {
  it("binds a nested install-ready Dashboard bundle into the package digest", () => {
    fixture((root) => {
      write(
        root,
        "SKILL.md",
        `---
name: demo-skill
description: Review demo inputs when the user requests a demo review.
---

# Demo

Use the install-ready \`dashboard/dist/\` presentation.
`,
      );
      write(root, "dashboard/dist/index.html", "<title>first</title>\n");

      const first = run(root);
      write(root, "dashboard/dist/index.html", "<title>second</title>\n");
      const second = run(root);

      expect(first.status).toBe(0);
      expect(first.report.subject.files_scanned).toBe(2);
      expect(second.report.subject.digest).not.toBe(first.report.subject.digest);
    });
  });

  it("fails when SKILL.md references missing bundled resources", () => {
    fixture((root) => {
      write(
        root,
        "SKILL.md",
        `---
name: demo-skill
description: Review demo inputs when the user requests a demo review.
---

# Demo

## Source-of-truth map

- \`references/rules.md\` — review authority.
- \`scripts/check.py\` — deterministic package check.
- \`dashboard/dist/\` — installed presentation surface.
`,
      );

      const { status, report } = run(root);

      expect(status).toBe(1);
      expect(
        report.findings
          .filter((finding) => finding.rule_id === "resource.missing-target")
          .map((finding) => finding.message),
      ).toEqual([
        "referenced package resource does not exist: dashboard/dist/",
        "referenced package resource does not exist: references/rules.md",
        "referenced package resource does not exist: scripts/check.py",
      ]);
    });
  });

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
        JSON.stringify(
          executableManifest("eval-skill", [
            evalCase({ id: "duplicate" }),
            evalCase({ id: "duplicate" }),
          ]),
        ),
      );

      const { status, report } = run(root);

      expect(status).toBe(1);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "eval.invalid-manifest",
            message: expect.stringContaining("duplicate eval id"),
          }),
        ]),
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
        JSON.stringify(
          executableManifest("file-eval-skill", [
            evalCase({ files: ["evals/files/missing.md"] }),
          ]),
        ),
      );

      const { status, report } = run(root);

      expect(status).toBe(1);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule_id: "eval.invalid-manifest",
            message: expect.stringContaining("does not exist"),
          }),
        ]),
      );
    });
  });

  it("self-lints the current skill package without structural errors", () => {
    const { status, report, stderr } = run(skillRoot);

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.summary.errors).toBe(0);
  });
});

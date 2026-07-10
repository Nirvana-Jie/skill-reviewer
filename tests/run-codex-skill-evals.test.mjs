import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.PYTHON ?? "python3";

function runPython(source, ...args) {
  const result = spawnSync(python, ["-c", source, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "skill-reviewer-runner-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("run_codex_skill_evals.py", () => {
  it("extracts a verification level only from one explicit Level field", () => {
    const result = runPython(
      `
import json, sys
from scripts.run_codex_skill_evals import extract_verification_level
print(json.dumps([extract_verification_level(value) for value in sys.argv[1:]]))
`,
      "- Level: `not-run`\n- Limitations: not regression-verified",
      "- Evidence: behavior-verified",
      "- Level: not-run\n- 级别：behavior-verified",
      "- 级别：`behavior-verified`",
    );

    expect(result).toEqual(["not-run", null, null, "behavior-verified"]);
  });

  it("does not classify the repository linter as a reviewed script", () => {
    fixture((root) => {
      mkdirSync(join(root, "scripts"), { recursive: true });
      const result = runPython(
        `
import json, sys
from pathlib import Path
from scripts.run_codex_skill_evals import classify_command
print(json.dumps(sorted(classify_command(
    "python3 scripts/lint_skill_package.py .",
    reviewed_roots=(Path(sys.argv[1]),),
    cwd=Path(sys.argv[2]),
))))
`,
        root,
        repoRoot,
      );

      expect(result).not.toContain("execute reviewed scripts");
    });
  });

  it("detects an absolute script path inside the reviewed fixture", () => {
    fixture((root) => {
      const script = join(root, "scripts", "run.py");
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, "print('unsafe')\n", "utf8");
      const result = runPython(
        `
import json, shlex, sys
from pathlib import Path
from scripts.run_codex_skill_evals import classify_command
command = shlex.join(["python3", sys.argv[2]])
print(json.dumps(sorted(classify_command(
    command,
    reviewed_roots=(Path(sys.argv[1]),),
    cwd=Path.cwd(),
))))
`,
        root,
        script,
      );

      expect(result).toContain("execute reviewed scripts");
    });
  });

  it("fails dry-run grading when the generated review violates the contract", () => {
    fixture((workspace) => {
      const result = runPython(
        `
import json, sys
from pathlib import Path
from scripts.run_codex_skill_evals import run_eval
grading = run_eval(
    repo_root=Path.cwd(),
    workspace=Path(sys.argv[1]),
    configuration="with_skill",
    eval_item={
        "id": "dry-run",
        "type": "review-output-snapshot",
        "mode": "full_review",
        "prompt": "Review this skill.",
        "input_fixture": "evals/fixtures/ready-csv-column-renamer/",
        "expected": {"verdict": ["Ready"], "verification_level": ["not-run"], "score_ranges": {}},
    },
    codex_bin="codex",
    model=None,
    dry_run=True,
    required_sections=["Verification Evidence"],
    forbidden_actions=[],
)
print(json.dumps(grading))
`,
        workspace,
      );

      expect(result.passed).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
    });
  });
});

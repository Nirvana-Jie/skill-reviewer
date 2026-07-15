import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(repoRoot, "scripts", "skill_eval_runtime.py");
const python = process.env.PYTHON ?? "python3";

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeExecution({
  workspace,
  plan,
  caseId,
  arm,
  repeat = 1,
  status = "completed",
  forbiddenActions = [],
  sideEffects = [],
  metrics = {},
}) {
  const assignmentPath = join(
    workspace,
    "assignments",
    caseId,
    arm,
    `repeat-${repeat}.json`,
  );
  const assignment = JSON.parse(readFileSync(assignmentPath, "utf8"));
  const repeatRoot = join(
    workspace,
    "cases",
    caseId,
    arm,
    `repeat-${repeat}`,
  );
  const artifactDigests = {};
  for (const artifact of assignment.expected_artifacts) {
    const artifactPath = join(repeatRoot, artifact);
    if (existsSync(artifactPath)) artifactDigests[artifact] = sha256(artifactPath);
  }
  return write(
    repeatRoot,
    "execution.json",
    JSON.stringify({
      schema_version: "skill-reviewer.executor-execution.v1",
      run_id: plan.run_id,
      case_id: caseId,
      arm,
      repeat,
      assignment_digest: sha256(assignmentPath),
      status,
      forbidden_actions: forbiddenActions,
      side_effects: sideEffects,
      metrics,
      artifact_digests: artifactDigests,
      agent_provenance: null,
    }),
  );
}

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "skill-reviewer-eval-runtime-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function compile({
  manifest,
  subject,
  workspace,
  baselineKind = "without_skill",
  baselinePath,
  splits = [],
  caseIds = [],
}) {
  const baselineArgs = baselinePath ? ["--baseline-path", baselinePath] : [];
  const splitArgs = splits.flatMap((split) => ["--split", split]);
  const caseArgs = caseIds.flatMap((caseId) => ["--case", caseId]);
  return spawnSync(
    python,
    [
      runtime,
      "compile",
      "--manifest",
      manifest,
      "--subject",
      subject,
      "--baseline-kind",
      baselineKind,
      ...baselineArgs,
      ...splitArgs,
      ...caseArgs,
      "--workspace",
      workspace,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function grade({ plan, workspace }) {
  return spawnSync(
    python,
    [runtime, "grade", "--plan", plan, "--workspace", workspace],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function decide({ plan, evidence, workspace, iteration = 1, phase = "selection" }) {
  return spawnSync(
    python,
    [
      runtime,
      "decide",
      "--plan",
      plan,
      "--evidence",
      evidence,
      "--workspace",
      workspace,
      "--iteration",
      String(iteration),
      "--phase",
      phase,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function runtimeCommand(args) {
  return spawnSync(python, [runtime, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function compiledPlanFixture(root, cases, options = {}) {
  const subject = join(root, "subject");
  const workspace = join(root, "run");
  const selectedSplit = options.splits?.[0] ?? cases[0]?.split ?? "development";
  const baselineKind =
    options.baselineKind ??
    (selectedSplit === "selection" || selectedSplit === "audit"
      ? "old_skill"
      : "without_skill");
  const baselinePath =
    options.baselinePath ??
    (baselineKind === "old_skill" ? join(root, "accepted-baseline") : undefined);
  write(
    subject,
    "SKILL.md",
    "---\nname: demo-skill\ndescription: Exercise executable evals.\n---\n",
  );
  if (baselinePath) {
    write(
      baselinePath,
      "SKILL.md",
      "---\nname: demo-skill\ndescription: Accepted comparison baseline.\n---\n",
    );
  }
  const manifest = write(
    subject,
    "evals/evals.json",
    JSON.stringify({
      schema_version: "skill-reviewer.evals.v2",
      skill_name: "demo-skill",
      defaults: {
        permissions: { network: "deny", writable_roots: ["outputs"] },
        repeats: { deterministic: 1, stochastic: 3 },
        evolution: { max_rounds: 3 },
      },
      evals: cases,
    }),
  );
  const result = compile({
    manifest,
    subject,
    workspace,
    baselineKind,
    baselinePath,
    splits: [selectedSplit],
    caseIds: options.caseIds ?? [],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return {
    manifest,
    plan: JSON.parse(result.stdout),
    planPath: join(workspace, "execution-plan.json"),
    baselinePath,
    subject,
    workspace,
  };
}

function minimalCase(overrides = {}) {
  return {
    id: "safe-case",
    purpose: "Exercise one executable boundary.",
    split: "development",
    prompt: "Write a response.",
    files: [],
    determinism: "deterministic",
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
        primary: true,
        min_material_delta: 0.1,
        non_regression_tolerance: 0,
      },
    ],
    ...overrides,
  };
}

function writeMinimalPackage(root, { cases = [minimalCase()], stochastic = 3 } = {}) {
  const subject = join(root, "subject");
  write(
    subject,
    "SKILL.md",
    "---\nname: demo-skill\ndescription: Exercise executable boundaries.\n---\n",
  );
  const manifest = write(
    subject,
    "evals/evals.json",
    JSON.stringify({
      schema_version: "skill-reviewer.evals.v2",
      skill_name: "demo-skill",
      defaults: {
        permissions: {
          network: "deny",
          external_side_effects: "deny",
          writable_roots: ["outputs"],
        },
        repeats: { deterministic: 1, stochastic },
        evolution: { max_rounds: 3 },
      },
      evals: cases,
    }),
  );
  return { manifest, subject };
}

function writeEvolutionSubject(root, name, marker) {
  const subject = join(root, name);
  write(
    subject,
    "SKILL.md",
    `---\nname: demo-skill\ndescription: Evolution candidate ${marker}.\n---\n`,
  );
  const manifest = write(
    subject,
    "evals/evals.json",
    JSON.stringify({
      schema_version: "skill-reviewer.evals.v2",
      skill_name: "demo-skill",
      defaults: {
        permissions: {
          network: "deny",
          external_side_effects: "deny",
          writable_roots: ["outputs"],
        },
        repeats: { deterministic: 1, stochastic: 3 },
        evolution: { max_rounds: 3 },
      },
      evals: [
        minimalCase({ id: "selection-case", split: "selection" }),
        minimalCase({ id: "public-audit", split: "audit" }),
      ],
    }),
  );
  return { manifest, subject };
}

function executeBoundRun({
  root,
  subject,
  manifest,
  baselinePath,
  split,
  label,
  iteration,
  passes = {},
}) {
  const workspace = join(root, label);
  const compiled = compile({
    manifest,
    subject,
    workspace,
    baselineKind: "old_skill",
    baselinePath,
    splits: [split],
  });
  if (compiled.status !== 0) throw new Error(compiled.stderr || compiled.stdout);
  const plan = JSON.parse(compiled.stdout);
  const caseId = split === "selection" ? "selection-case" : "public-audit";
  for (const arm of plan.cases[0].arms) {
    if (passes[arm] ?? arm !== "without_skill") {
      write(
        workspace,
        `cases/${caseId}/${arm}/repeat-1/outputs/response.md`,
        "done\n",
      );
    }
    writeExecution({ workspace, plan, caseId, arm });
  }
  const planPath = join(workspace, "execution-plan.json");
  const decided = decide({
    plan: planPath,
    evidence: join(workspace, "verification-evidence.json"),
    workspace,
    iteration,
    phase: split,
  });
  if (decided.status !== 0) throw new Error(decided.stderr || decided.stdout);
  return {
    decision: JSON.parse(decided.stdout),
    decisionPath: join(
      workspace,
      `iteration-${iteration}`,
      split === "selection" ? "acceptance-decision.json" : "audit-decision.json",
    ),
    plan,
    planPath,
    workspace,
  };
}

describe("skill_eval_runtime compile", () => {
  it("rejects path-unsafe case ids before creating workspace artifacts", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root, {
        cases: [minimalCase({ id: "../../outside" })],
      });
      const workspace = join(root, "run");

      const result = compile({ manifest, subject, workspace, splits: ["development"] });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain("path-safe");
      expect(existsSync(join(root, "outside"))).toBe(false);
      expect(existsSync(join(workspace, "execution-plan.json"))).toBe(false);
    });
  });

  it("rejects a populated workspace instead of reusing stale evidence", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root);
      const workspace = join(root, "run");
      write(workspace, "sentinel.txt", "retain me\n");

      const result = compile({ manifest, subject, workspace, splits: ["development"] });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain("workspace must be empty");
      expect(readFileSync(join(workspace, "sentinel.txt"), "utf8")).toBe("retain me\n");
      expect(existsSync(join(workspace, "execution-plan.json"))).toBe(false);
    });
  });

  it("requires exactly three repeats for stochastic cases", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root, {
        stochastic: 2,
        cases: [minimalCase({ determinism: "stochastic" })],
      });

      const result = compile({
        manifest,
        subject,
        workspace: join(root, "run"),
        splits: ["development"],
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "defaults.repeats.stochastic must be 3",
      );
    });
  });

  it("requires old_skill as the accepted baseline for selection", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root, {
        cases: [minimalCase({ split: "selection" })],
      });

      const result = compile({
        manifest,
        subject,
        workspace: join(root, "run"),
        baselineKind: "without_skill",
        splits: ["selection"],
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "selection requires an old_skill baseline",
      );
    });
  });

  it("requires one and only one lifecycle split per execution plan", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root, {
        cases: [
          minimalCase({ id: "dev-case", split: "development" }),
          minimalCase({ id: "selection-case", split: "selection" }),
        ],
      });

      const missing = compile({
        manifest,
        subject,
        workspace: join(root, "missing-split"),
      });
      const mixed = compile({
        manifest,
        subject,
        workspace: join(root, "mixed-split"),
        splits: ["development", "selection"],
      });

      expect(missing.status).toBe(2);
      expect(mixed.status).toBe(2);
      expect(JSON.parse(missing.stdout).error).toContain("exactly one --split");
      expect(JSON.parse(mixed.stdout).error).toContain("exactly one --split");
    });
  });

  it("rejects a zero material threshold for a primary objective", () => {
    fixture((root) => {
      const invalid = minimalCase();
      invalid.objectives[0].min_material_delta = 0;
      const { manifest, subject } = writeMinimalPackage(root, {
        cases: [invalid],
      });

      const result = compile({
        manifest,
        subject,
        workspace: join(root, "run"),
        splits: ["development"],
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "min_material_delta must be greater than zero",
      );
    });
  });

  it("materializes arm/repeat-specific inputs and answer-key-free skill snapshots", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root, {
        cases: [
          minimalCase({
            id: "isolated-case",
            determinism: "stochastic",
            files: ["evals/input.txt"],
          }),
        ],
      });
      write(subject, "evals/input.txt", "fixture\n");
      write(subject, "evals/expected.md", "answer key\n");
      write(subject, "references/rubric.md", "runtime reference\n");
      const workspace = join(root, "run");

      const result = compile({ manifest, subject, workspace, splits: ["development"] });

      expect(result.status, result.stderr).toBe(0);
      const assignment = JSON.parse(
        readFileSync(
          join(workspace, "assignments/isolated-case/with_skill/repeat-2.json"),
          "utf8",
        ),
      );
      expect(assignment.input_files[0].path).toContain(
        "/inputs/isolated-case/with_skill/repeat-2/package/evals/input.txt",
      );
      expect(assignment.configuration.skill_path).toContain(
        "/run/skill-snapshots/with_skill",
      );
      expect(existsSync(join(assignment.configuration.skill_path, "SKILL.md"))).toBe(true);
      expect(
        existsSync(join(assignment.configuration.skill_path, "references/rubric.md")),
      ).toBe(true);
      expect(existsSync(join(assignment.configuration.skill_path, "evals/evals.json"))).toBe(
        false,
      );
      expect(existsSync(join(assignment.configuration.skill_path, "evals/expected.md"))).toBe(
        false,
      );
    });
  });

  it("compiles a v2 manifest into a locked paired execution plan", () => {
    fixture((root) => {
      const subject = join(root, "demo-skill");
      const workspace = join(root, "run");
      write(
        subject,
        "SKILL.md",
        `---
name: demo-skill
description: Review demo inputs when asked.
---

# Demo skill
`,
      );
      write(subject, "evals/input.txt", "fixture\n");
      const manifest = write(
        subject,
        "evals/evals.json",
        JSON.stringify({
          schema_version: "skill-reviewer.evals.v2",
          skill_name: "demo-skill",
          defaults: {
            permissions: { network: "deny", writable_roots: ["outputs"] },
            repeats: { deterministic: 1, stochastic: 3 },
            evolution: { max_rounds: 3 },
          },
          evals: [
            {
              id: "writes-review",
              purpose: "Prove the skill produces the required review.",
              split: "development",
              prompt: "Review the fixture.",
              files: ["evals/input.txt"],
              determinism: "deterministic",
              assertions: [
                {
                  id: "review-exists",
                  type: "file_exists",
                  artifact: "outputs/review.md",
                  severity: "must_pass",
                },
              ],
              objectives: [
                {
                  id: "required-pass-rate",
                  metric: "required_pass_rate",
                  direction: "maximize",
                  min_material_delta: 0.05,
                  non_regression_tolerance: 0,
                },
              ],
            },
          ],
        }),
      );

      const result = compile({
        manifest,
        subject,
        workspace,
        splits: ["development"],
      });

      expect(result.status, result.stderr).toBe(0);
      const plan = JSON.parse(result.stdout);
      expect(plan.schema_version).toBe("skill-reviewer.execution-plan.v1");
      expect(plan.manifest.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(plan.subject.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(plan.cases).toEqual([
        expect.objectContaining({
          id: "writes-review",
          split: "development",
          repeats: 1,
          arms: ["with_skill", "without_skill"],
        }),
      ]);
      expect(existsSync(join(workspace, "execution-plan.json"))).toBe(true);
      const runLock = JSON.parse(
        readFileSync(join(workspace, "run-lock.json"), "utf8"),
      );
      expect(runLock).toEqual(
        expect.objectContaining({
          schema_version: "skill-reviewer.run-lock.v1",
          manifest_digest: plan.manifest.digest,
          subject_digest: plan.subject.digest,
          assignment_digests: expect.any(Object),
          input_copy_digests: expect.any(Object),
        }),
      );
      const assignmentPath = join(
        workspace,
        "assignments/writes-review/with_skill/repeat-1.json",
      );
      const assignment = JSON.parse(readFileSync(assignmentPath, "utf8"));
      expect(assignment).toEqual(
        expect.objectContaining({
          schema_version: "skill-reviewer.executor-assignment.v1",
          run_id: plan.run_id,
          case_id: "writes-review",
          arm: "with_skill",
          expected_artifacts: ["outputs/review.md"],
        }),
      );
      expect(assignment).not.toHaveProperty("assertions");
      expect(assignment).not.toHaveProperty("objectives");
      expect(assignment.input_files[0].path).toContain(
        `${workspace}/inputs/writes-review/with_skill/repeat-1/package/evals/input.txt`,
      );
      expect(readFileSync(assignment.input_files[0].path, "utf8")).toBe("fixture\n");
    });
  });

  it("blocks an invalid v2 manifest instead of silently skipping its assertions", () => {
    fixture((root) => {
      const subject = join(root, "demo-skill");
      const workspace = join(root, "run");
      write(subject, "SKILL.md", "---\nname: demo-skill\ndescription: Demo.\n---\n");
      const manifest = write(
        subject,
        "evals/evals.json",
        JSON.stringify({
          schema_version: "skill-reviewer.evals.v2",
          skill_name: "demo-skill",
          defaults: {
            permissions: { network: "deny", writable_roots: ["outputs"] },
            repeats: { deterministic: 1, stochastic: 3 },
            evolution: { max_rounds: 3 },
          },
          evals: [
            {
              id: "unknown-assertion",
              purpose: "Reject an assertion the deterministic grader cannot run.",
              split: "selection",
              prompt: "Run the test.",
              determinism: "deterministic",
              files: [],
              assertions: [
                {
                  id: "magic",
                  type: "trust_the_model",
                  artifact: "outputs/result.md",
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
            },
          ],
        }),
      );

      const result = compile({
        manifest,
        subject,
        workspace,
        splits: ["selection"],
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.stringContaining("unsupported assertion type"),
        }),
      );
      expect(existsSync(join(workspace, "execution-plan.json"))).toBe(false);
    });
  });

  it("builds a three-arm audit plan while keeping selection data separate", () => {
    fixture((root) => {
      const subject = join(root, "candidate");
      const baseline = join(root, "accepted");
      const workspace = join(root, "run");
      for (const skill of [subject, baseline]) {
        write(skill, "SKILL.md", "---\nname: demo-skill\ndescription: Demo.\n---\n");
      }
      const commonCase = {
        purpose: "Exercise one release split.",
        prompt: "Review the input.",
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
      };
      const manifest = write(
        subject,
        "evals/evals.json",
        JSON.stringify({
          schema_version: "skill-reviewer.evals.v2",
          skill_name: "demo-skill",
          defaults: {
            permissions: { network: "deny", writable_roots: ["outputs"] },
            repeats: { deterministic: 1, stochastic: 3 },
            evolution: { max_rounds: 3 },
          },
          evals: [
            { ...commonCase, id: "selection-case", split: "selection" },
            { ...commonCase, id: "audit-case", split: "audit" },
          ],
        }),
      );

      const result = compile({
        manifest,
        subject,
        baselineKind: "old_skill",
        baselinePath: baseline,
        splits: ["audit"],
        workspace,
      });

      expect(result.status, result.stderr).toBe(0);
      const plan = JSON.parse(result.stdout);
      expect(plan.splits).toEqual(["audit"]);
      expect(plan.cases).toEqual([
        expect.objectContaining({
          id: "audit-case",
          arms: ["with_skill", "old_skill", "without_skill"],
        }),
      ]);
    });
  });

  it("supports a targeted case screen without changing the frozen manifest", () => {
    fixture((root) => {
      const common = {
        purpose: "Exercise a targeted screen.",
        prompt: "Write a response.",
        split: "development",
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
      };
      const { plan } = compiledPlanFixture(
        root,
        [
          { ...common, id: "fast-case" },
          { ...common, id: "deferred-case" },
        ],
        { caseIds: ["fast-case"] },
      );

      expect(plan.case_ids).toEqual(["fast-case"]);
      expect(plan.cases.map((item) => item.id)).toEqual(["fast-case"]);
    });
  });
});

describe("skill_eval_runtime grade", () => {
  it("treats an execution that is not bound to its locked assignment as inconclusive", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "binding-case", split: "selection" }),
      ]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/binding-case/${arm}/repeat-1/outputs/response.md`,
          "done\n",
        );
        const executionPath = writeExecution({
          workspace,
          plan,
          caseId: "binding-case",
          arm,
        });
        if (arm === "with_skill") {
          const execution = JSON.parse(readFileSync(executionPath, "utf8"));
          execution.assignment_digest = "0".repeat(64);
          writeFileSync(executionPath, JSON.stringify(execution), "utf8");
        }
      }

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("inconclusive");
      expect(evidence.cases[0].with_skill.complete).toBe(false);
      expect(evidence.limitations).toContain(
        "execution binding invalid for case binding-case arm with_skill",
      );
    });
  });

  it("makes baseline forbidden actions or side effects evidence-inconclusive", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "baseline-safety", split: "selection" }),
      ]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/baseline-safety/${arm}/repeat-1/outputs/response.md`,
          "done\n",
        );
        writeExecution({
          workspace,
          plan,
          caseId: "baseline-safety",
          arm,
          sideEffects: arm === "old_skill" ? ["network.request"] : [],
        });
      }

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("inconclusive");
      expect(evidence.limitations).toContain(
        "external side effect recorded for case baseline-safety arm old_skill",
      );
    });
  });

  it("grades retained paired artifacts instead of treating execution as proof", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        {
          id: "writes-review",
          purpose: "Confirm retained output is graded.",
          prompt: "Write a review.",
          split: "selection",
          determinism: "deterministic",
          files: [],
          assertions: [
            {
              id: "review-exists",
              type: "file_exists",
              artifact: "outputs/review.md",
              severity: "must_pass",
            },
          ],
          objectives: [
            {
              id: "required-pass-rate",
              metric: "required_pass_rate",
              direction: "maximize",
              min_material_delta: 0.05,
              non_regression_tolerance: 0,
            },
          ],
        },
      ]);
      write(
        workspace,
        "cases/writes-review/with_skill/repeat-1/outputs/review.md",
        "# Review\n",
      );
      for (const arm of ["with_skill", "old_skill"]) {
        writeExecution({ workspace, plan, caseId: "writes-review", arm });
      }

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("regression-verified");
      expect(evidence.cases[0]).toEqual(
        expect.objectContaining({
          id: "writes-review",
          regressed: false,
          with_skill: expect.objectContaining({
            passed: true,
            required_pass_rate: 1,
          }),
          old_skill: expect.objectContaining({
            passed: false,
            required_pass_rate: 0,
          }),
        }),
      );
      expect(existsSync(join(workspace, "verification-evidence.json"))).toBe(
        true,
      );
    });
  });

  it("refuses to grade after a frozen subject or fixture drifts", () => {
    fixture((root) => {
      const { planPath, subject, workspace } = compiledPlanFixture(root, [
        {
          id: "integrity-case",
          purpose: "Keep the evaluated subject frozen.",
          prompt: "Produce one response.",
          split: "selection",
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
        },
      ]);
      write(subject, "references/drift.md", "changed after compilation\n");

      const result = grade({ plan: planPath, workspace });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain("locked subject changed");
      expect(existsSync(join(workspace, "verification-evidence.json"))).toBe(false);
    });
  });

  it("evaluates typed deterministic assertions and treats swapped semantic disagreement as inconclusive", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        {
          id: "typed-case",
          purpose: "Exercise deterministic and semantic graders.",
          prompt: "Review the input.",
          split: "selection",
          determinism: "deterministic",
          files: [],
          assertions: [
                {
                  id: "has-verdict",
                  type: "text_contains",
                  artifact: "outputs/review.md",
                  expected: "Verdict: Ready",
                  severity: "must_pass",
                },
                {
                  id: "safe-json",
                  type: "json_path",
                  artifact: "outputs/result.json",
                  path: "/safe",
                  operator: "equals",
                  expected: true,
                  severity: "must_pass",
                },
                {
                  id: "no-network",
                  type: "event_absent",
                  artifact: "events.jsonl",
                  event: "network.request",
                  severity: "must_pass",
                },
                {
                  id: "blind-quality",
                  type: "semantic_pair",
                  artifact: "semantic/blind-quality.json",
                  severity: "supplemental",
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
        },
      ]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/typed-case/${arm}/repeat-1/outputs/review.md`,
          "Verdict: Ready\n",
        );
        write(
          workspace,
          `cases/typed-case/${arm}/repeat-1/outputs/result.json`,
          JSON.stringify({ safe: true }),
        );
        write(
          workspace,
          `cases/typed-case/${arm}/repeat-1/events.jsonl`,
          `${JSON.stringify({ event: "file.read" })}\n`,
        );
        writeExecution({ workspace, plan, caseId: "typed-case", arm });
      }
      write(
        workspace,
        "cases/typed-case/semantic/blind-quality.json",
        JSON.stringify({
          schema_version: "skill-reviewer.semantic-judgment.v1",
          blind: true,
          judgments: [
            { mapping: { A: "with_skill", B: "old_skill" }, winner: "A" },
            { mapping: { A: "old_skill", B: "with_skill" }, winner: "A" },
          ],
        }),
      );

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("inconclusive");
      expect(evidence.cases[0].with_skill.passed).toBe(true);
      expect(evidence.cases[0].semantic_assertions).toEqual([
        expect.objectContaining({
          id: "blind-quality",
          status: "disagreement",
          passed: false,
        }),
      ]);
      expect(evidence.limitations).toContain(
        "semantic judge disagreement in case typed-case",
      );
    });
  });

  it("marks stochastic paired direction disagreement as inconclusive", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        {
          id: "variable-quality",
          purpose: "Detect unstable paired directions.",
          prompt: "Produce the result.",
          split: "selection",
          determinism: "stochastic",
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
              id: "quality-score",
              metric: "quality_score",
              direction: "maximize",
              min_material_delta: 0.1,
              non_regression_tolerance: 0,
            },
          ],
        },
      ]);
      const scores = {
        with_skill: [0.9, 0.2, 0.8],
        old_skill: [0.4, 0.7, 0.3],
      };
      for (const arm of ["with_skill", "old_skill"]) {
        scores[arm].forEach((qualityScore, index) => {
          const repeat = index + 1;
          write(
            workspace,
            `cases/variable-quality/${arm}/repeat-${repeat}/outputs/response.md`,
            "done\n",
          );
          writeExecution({
            workspace,
            plan,
            caseId: "variable-quality",
            arm,
            repeat,
            metrics: { quality_score: qualityScore },
          });
        });
      }

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("inconclusive");
      expect(evidence.cases[0].direction_disagreement).toBe(true);
      expect(evidence.cases[0].with_skill.quality_score).toBeCloseTo(0.633333);
      expect(evidence.cases[0].old_skill.quality_score).toBeCloseTo(0.466667);
      expect(evidence.limitations).toContain(
        "paired stochastic directions disagree in case variable-quality",
      );
    });
  });
});

describe("skill_eval_runtime decide", () => {
  it("accepts only a hard-gate-clean Pareto improvement", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "review-quality", split: "selection" }),
      ]);
      write(
        workspace,
        "cases/review-quality/with_skill/repeat-1/outputs/response.md",
        "done\n",
      );
      for (const arm of ["with_skill", "old_skill"]) {
        writeExecution({ workspace, plan, caseId: "review-quality", arm });
      }

      const result = decide({
        plan: planPath,
        evidence: join(workspace, "verification-evidence.json"),
        workspace,
      });

      expect(result.status, result.stderr).toBe(0);
      const decision = JSON.parse(result.stdout);
      expect(decision).toEqual(
        expect.objectContaining({
          schema_version: "skill-reviewer.acceptance-decision.v1",
          iteration: 1,
          status: "accepted",
          accepted: true,
          hard_gates_passed: true,
          pareto_admissible: true,
          material_improvement: true,
        }),
      );
      expect(decision.objectives).toEqual([
        expect.objectContaining({
          id: "quality",
          candidate: 1,
          baseline: 0,
          delta: 1,
          non_regressed: true,
          materially_improved: true,
        }),
      ]);
      expect(
        existsSync(join(workspace, "iteration-1", "acceptance-decision.json")),
      ).toBe(true);
    });
  });

  it("regrades canonical artifacts instead of trusting edited evidence", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "tamper-case", split: "selection" }),
      ]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/tamper-case/${arm}/repeat-1/outputs/response.md`,
          "done\n",
        );
        writeExecution({ workspace, plan, caseId: "tamper-case", arm });
      }
      const graded = grade({ plan: planPath, workspace });
      expect(graded.status, graded.stderr).toBe(0);
      const evidencePath = join(workspace, "verification-evidence.json");
      const edited = JSON.parse(readFileSync(evidencePath, "utf8"));
      edited.cases[0].old_skill.required_pass_rate = 0;
      writeFileSync(evidencePath, JSON.stringify(edited), "utf8");

      const result = decide({
        plan: planPath,
        evidence: evidencePath,
        workspace,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({ status: "no-change", accepted: false }),
      );
      expect(
        JSON.parse(readFileSync(evidencePath, "utf8")).cases[0].old_skill
          .required_pass_rate,
      ).toBe(1);
    });
  });

  it("uses audit as a one-shot non-regression gate without demanding a new material delta", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "public-audit", split: "audit" }),
      ]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/public-audit/${arm}/repeat-1/outputs/response.md`,
          "done\n",
        );
      }
      for (const arm of ["with_skill", "old_skill", "without_skill"]) {
        writeExecution({ workspace, plan, caseId: "public-audit", arm });
      }

      const result = decide({
        plan: planPath,
        evidence: join(workspace, "verification-evidence.json"),
        workspace,
        iteration: 2,
        phase: "audit",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          phase: "audit",
          status: "accepted",
          accepted: true,
          material_improvement: false,
        }),
      );
    });
  });
});

describe("skill_eval_runtime evolution", () => {
  it("carries immutable authority across three distinct candidate run ids", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const runs = [1, 2, 3].map((round) => {
        const candidate = writeEvolutionSubject(
          root,
          `candidate-${round}`,
          `round-${round}`,
        );
        return executeBoundRun({
          root,
          ...candidate,
          baselinePath,
          split: "selection",
          label: `selection-run-${round}`,
          iteration: round,
          passes: { with_skill: true, old_skill: true },
        });
      });
      expect(new Set(runs.map((run) => run.plan.run_id)).size).toBe(3);
      expect(new Set(runs.map((run) => run.plan.authority.digest)).size).toBe(1);

      const workspace = join(root, "evolution-control");
      const init = runtimeCommand([
        "evolution-init",
        "--plan",
        runs[0].planPath,
        "--workspace",
        workspace,
      ]);
      expect(init.status, init.stderr).toBe(0);
      const statePath = join(workspace, "evolution-state.json");

      for (const run of runs) {
        const advance = runtimeCommand([
          "evolution-advance",
          "--state",
          statePath,
          "--decision",
          run.decisionPath,
        ]);
        expect(advance.status, advance.stderr).toBe(0);
      }

      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(
        expect.objectContaining({
          max_rounds: 3,
          current_round: 3,
          status: "exhausted",
          terminal: true,
          next_action: "stop",
          seen_run_ids: runs.map((run) => run.plan.run_id),
        }),
      );
    });
  });

  it("runs audit once and never feeds an audit failure back to the optimizer", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const candidate = writeEvolutionSubject(root, "candidate", "selected");
      const selection = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "selection-run",
        iteration: 1,
        passes: { with_skill: true, old_skill: false },
      });
      expect(selection.decision.accepted).toBe(true);
      const workspace = join(root, "evolution-control");
      const initialized = runtimeCommand([
        "evolution-init",
        "--plan",
        selection.planPath,
        "--workspace",
        workspace,
      ]);
      expect(initialized.status, initialized.stderr).toBe(0);
      const statePath = join(workspace, "evolution-state.json");
      const selected = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        selection.decisionPath,
      ]);
      expect(JSON.parse(selected.stdout)).toEqual(
        expect.objectContaining({
          status: "awaiting-audit",
          next_action: "run_audit",
          terminal: false,
        }),
      );
      const audit = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "audit",
        label: "audit-run",
        iteration: 1,
        passes: { with_skill: false, old_skill: true, without_skill: false },
      });
      expect(audit.plan.run_id).not.toBe(selection.plan.run_id);
      expect(audit.decision.accepted).toBe(false);
      const audited = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        audit.decisionPath,
      ]);
      expect(JSON.parse(audited.stdout)).toEqual(
        expect.objectContaining({
          status: "audit-failed",
          audit_consumed: true,
          next_action: "stop",
          terminal: true,
        }),
      );

      const secondAudit = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        audit.decisionPath,
      ]);
      expect(secondAudit.status).toBe(2);
      expect(JSON.parse(secondAudit.stdout).error).toContain(
        "evolution is already terminal",
      );
    });
  });

  it("rejects an eval-authority change between candidate rounds", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const firstCandidate = writeEvolutionSubject(root, "candidate-1", "one");
      const firstRun = executeBoundRun({
        root,
        ...firstCandidate,
        baselinePath,
        split: "selection",
        label: "selection-1",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      const control = join(root, "control");
      runtimeCommand([
        "evolution-init",
        "--plan",
        firstRun.planPath,
        "--workspace",
        control,
      ]);
      const statePath = join(control, "evolution-state.json");
      const firstAdvance = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        firstRun.decisionPath,
      ]);
      expect(firstAdvance.status, firstAdvance.stderr).toBe(0);

      const secondCandidate = writeEvolutionSubject(root, "candidate-2", "two");
      const changedManifest = JSON.parse(
        readFileSync(secondCandidate.manifest, "utf8"),
      );
      changedManifest.evals[0].purpose = "Optimizer attempted to rewrite eval authority.";
      writeFileSync(secondCandidate.manifest, JSON.stringify(changedManifest), "utf8");
      const secondRun = executeBoundRun({
        root,
        ...secondCandidate,
        baselinePath,
        split: "selection",
        label: "selection-2",
        iteration: 2,
        passes: { with_skill: true, old_skill: true },
      });

      const rejected = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        secondRun.decisionPath,
      ]);

      expect(rejected.status).toBe(2);
      expect(JSON.parse(rejected.stdout).error).toContain(
        "evolution authority changed",
      );
    });
  });

  it("requires the audit run to use the selected candidate digest", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const selectedCandidate = writeEvolutionSubject(root, "candidate-1", "selected");
      const selection = executeBoundRun({
        root,
        ...selectedCandidate,
        baselinePath,
        split: "selection",
        label: "selection",
        iteration: 1,
        passes: { with_skill: true, old_skill: false },
      });
      const control = join(root, "control");
      runtimeCommand([
        "evolution-init",
        "--plan",
        selection.planPath,
        "--workspace",
        control,
      ]);
      const statePath = join(control, "evolution-state.json");
      runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        selection.decisionPath,
      ]);
      const substitutedCandidate = writeEvolutionSubject(
        root,
        "candidate-2",
        "substituted",
      );
      const audit = executeBoundRun({
        root,
        ...substitutedCandidate,
        baselinePath,
        split: "audit",
        label: "audit",
        iteration: 1,
        passes: { with_skill: true, old_skill: true, without_skill: false },
      });

      const rejected = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        audit.decisionPath,
      ]);

      expect(rejected.status).toBe(2);
      expect(JSON.parse(rejected.stdout).error).toContain(
        "audit subject is not the accepted selection candidate",
      );
    });
  });
});

describe("skill_eval_runtime dashboard projection", () => {
  it("joins decision history from an external cross-run evolution state", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const runs = [1, 2].map((round) => {
        const candidate = writeEvolutionSubject(
          root,
          `dashboard-candidate-${round}`,
          `dashboard-${round}`,
        );
        return executeBoundRun({
          root,
          ...candidate,
          baselinePath,
          split: "selection",
          label: `dashboard-selection-${round}`,
          iteration: round,
          passes: { with_skill: true, old_skill: true },
        });
      });
      const control = join(root, "dashboard-control");
      runtimeCommand([
        "evolution-init",
        "--plan",
        runs[0].planPath,
        "--workspace",
        control,
      ]);
      const statePath = join(control, "evolution-state.json");
      for (const run of runs) {
        const advanced = runtimeCommand([
          "evolution-advance",
          "--state",
          statePath,
          "--decision",
          run.decisionPath,
        ]);
        expect(advanced.status, advanced.stderr).toBe(0);
      }
      const output = join(runs[1].workspace, "dashboard-data.json");

      const projected = runtimeCommand([
        "project-dashboard",
        "--workspace",
        runs[1].workspace,
        "--state",
        statePath,
        "--output",
        output,
      ]);

      expect(projected.status, projected.stderr).toBe(0);
      const data = JSON.parse(readFileSync(output, "utf8"));
      expect(data.run.id).toBe(runs[1].plan.run_id);
      expect(data.run.status).toBe("optimizing");
      expect(data.summary.current_round).toBe(3);
      expect(data.iterations.map((item) => item.iteration)).toEqual([1, 2]);
    });
  });

  it("projects the retained evidence chain into a versioned read model", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        {
          id: "dashboard-case",
          purpose: "Expose one evidence-backed dashboard case.",
          prompt: "Write the review.",
          split: "selection",
          determinism: "deterministic",
          files: [],
          assertions: [
            {
              id: "review-exists",
              type: "file_exists",
              artifact: "outputs/review.md",
              severity: "must_pass",
            },
          ],
          objectives: [
            {
              id: "quality",
              metric: "required_pass_rate",
              direction: "maximize",
              primary: true,
              min_material_delta: 0.1,
              non_regression_tolerance: 0,
            },
          ],
        },
      ]);
      write(
        workspace,
        "cases/dashboard-case/with_skill/repeat-1/outputs/review.md",
        "# Review\n",
      );
      for (const arm of ["with_skill", "old_skill"]) {
        writeExecution({ workspace, plan, caseId: "dashboard-case", arm });
      }
      const graded = grade({ plan: planPath, workspace });
      expect(graded.status, graded.stderr).toBe(0);
      const decision = decide({
        plan: planPath,
        evidence: join(workspace, "verification-evidence.json"),
        workspace,
      });
      expect(decision.status, decision.stderr).toBe(0);
      runtimeCommand([
        "evolution-init",
        "--plan",
        planPath,
        "--workspace",
        workspace,
      ]);
      runtimeCommand([
        "evolution-advance",
        "--state",
        join(workspace, "evolution-state.json"),
        "--decision",
        join(workspace, "iteration-1/acceptance-decision.json"),
      ]);
      const output = join(workspace, "dashboard-data.json");

      const projected = runtimeCommand([
        "project-dashboard",
        "--workspace",
        workspace,
        "--output",
        output,
      ]);

      expect(projected.status, projected.stderr).toBe(0);
      const data = JSON.parse(readFileSync(output, "utf8"));
      expect(data).toEqual(
        expect.objectContaining({
          schema_version: "skill-reviewer.dashboard-data.v1",
          run: expect.objectContaining({
            id: plan.run_id,
            status: "awaiting-audit",
            verification_level: "regression-verified",
          }),
          summary: expect.objectContaining({
            case_count: 1,
            candidate_passed: 1,
            decision_status: "accepted",
            current_round: 1,
          }),
          cases: [
            expect.objectContaining({
              id: "dashboard-case",
              status: "passed",
              arms: expect.arrayContaining([
                expect.objectContaining({ id: "with_skill", passed: true }),
                expect.objectContaining({ id: "old_skill", passed: false }),
              ]),
            }),
          ],
        }),
      );
      expect(data.spine.map((node) => node.kind)).toEqual(
        expect.arrayContaining(["run", "gate", "iteration", "case", "assertion", "artifact"]),
      );
    });
  });
});

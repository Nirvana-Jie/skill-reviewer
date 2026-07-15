import { spawnSync } from "node:child_process";
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
  write(
    subject,
    "SKILL.md",
    "---\nname: demo-skill\ndescription: Exercise executable evals.\n---\n",
  );
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
    baselineKind: options.baselineKind ?? "without_skill",
    baselinePath: options.baselinePath,
    splits: options.splits ?? [],
    caseIds: options.caseIds ?? [],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return {
    manifest,
    plan: JSON.parse(result.stdout),
    planPath: join(workspace, "execution-plan.json"),
    subject,
    workspace,
  };
}

describe("skill_eval_runtime compile", () => {
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

      const result = compile({ manifest, subject, workspace });

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
        `${workspace}/inputs/writes-review/package/evals/input.txt`,
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

      const result = compile({ manifest, subject, workspace });

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
  it("grades retained paired artifacts instead of treating execution as proof", () => {
    fixture((root) => {
      const { planPath, workspace } = compiledPlanFixture(root, [
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
      for (const arm of ["with_skill", "without_skill"]) {
        write(
          workspace,
          `cases/writes-review/${arm}/repeat-1/execution.json`,
          JSON.stringify({ status: "completed", forbidden_actions: [] }),
        );
      }
      write(
        workspace,
        "cases/writes-review/with_skill/repeat-1/outputs/review.md",
        "# Review\n",
      );

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
          without_skill: expect.objectContaining({
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
      const { planPath, workspace } = compiledPlanFixture(root, [
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
      for (const arm of ["with_skill", "without_skill"]) {
        write(
          workspace,
          `cases/typed-case/${arm}/repeat-1/execution.json`,
          JSON.stringify({ status: "completed", forbidden_actions: [] }),
        );
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
      }
      write(
        workspace,
        "cases/typed-case/semantic/blind-quality.json",
        JSON.stringify({
          schema_version: "skill-reviewer.semantic-judgment.v1",
          blind: true,
          judgments: [
            { mapping: { A: "with_skill", B: "without_skill" }, winner: "A" },
            { mapping: { A: "without_skill", B: "with_skill" }, winner: "A" },
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
      const { planPath, workspace } = compiledPlanFixture(root, [
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
        without_skill: [0.4, 0.7, 0.3],
      };
      for (const arm of ["with_skill", "without_skill"]) {
        scores[arm].forEach((qualityScore, index) => {
          const repeat = index + 1;
          write(
            workspace,
            `cases/variable-quality/${arm}/repeat-${repeat}/execution.json`,
            JSON.stringify({
              status: "completed",
              forbidden_actions: [],
              metrics: { quality_score: qualityScore },
            }),
          );
          write(
            workspace,
            `cases/variable-quality/${arm}/repeat-${repeat}/outputs/response.md`,
            "done\n",
          );
        });
      }

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("inconclusive");
      expect(evidence.cases[0].direction_disagreement).toBe(true);
      expect(evidence.cases[0].with_skill.quality_score).toBeCloseTo(0.633333);
      expect(evidence.cases[0].without_skill.quality_score).toBeCloseTo(0.466667);
      expect(evidence.limitations).toContain(
        "paired stochastic directions disagree in case variable-quality",
      );
    });
  });
});

describe("skill_eval_runtime decide", () => {
  it("accepts only a hard-gate-clean Pareto improvement", () => {
    fixture((root) => {
      const workspace = join(root, "run");
      const plan = write(
        workspace,
        "execution-plan.json",
        JSON.stringify({
          schema_version: "skill-reviewer.execution-plan.v1",
          run_id: "run-decision",
          cases: [
            {
              id: "review-quality",
              objectives: [
                {
                  id: "required-pass-rate",
                  metric: "required_pass_rate",
                  direction: "maximize",
                  primary: true,
                  min_material_delta: 0.05,
                  non_regression_tolerance: 0,
                },
              ],
            },
          ],
        }),
      );
      const evidence = write(
        workspace,
        "verification-evidence.json",
        JSON.stringify({
          schema_version: "skill-reviewer.verification.v1",
          run_id: "run-decision",
          level: "regression-verified",
          cases: [
            {
              id: "review-quality",
              regressed: false,
              with_skill: {
                complete: true,
                passed: true,
                required_pass_rate: 1,
                forbidden_actions: [],
              },
              old_skill: {
                complete: true,
                passed: false,
                required_pass_rate: 0.5,
                forbidden_actions: [],
              },
            },
          ],
        }),
      );

      const result = decide({ plan, evidence, workspace });

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
          id: "required-pass-rate",
          candidate: 1,
          baseline: 0.5,
          delta: 0.5,
          non_regressed: true,
          materially_improved: true,
        }),
      ]);
      expect(
        existsSync(join(workspace, "iteration-1", "acceptance-decision.json")),
      ).toBe(true);
    });
  });

  it("uses audit as a one-shot non-regression gate without demanding a new material delta", () => {
    fixture((root) => {
      const workspace = join(root, "run");
      const plan = write(
        workspace,
        "execution-plan.json",
        JSON.stringify({
          schema_version: "skill-reviewer.execution-plan.v1",
          run_id: "run-audit-decision",
          baseline: { kind: "old_skill" },
          cases: [
            {
              id: "hidden-audit",
              objectives: [
                {
                  id: "quality",
                  metric: "required_pass_rate",
                  direction: "maximize",
                  primary: true,
                  min_material_delta: 0.2,
                  non_regression_tolerance: 0,
                },
              ],
            },
          ],
        }),
      );
      const evidence = write(
        workspace,
        "verification-evidence.json",
        JSON.stringify({
          schema_version: "skill-reviewer.verification.v1",
          run_id: "run-audit-decision",
          level: "regression-verified",
          cases: [
            {
              id: "hidden-audit",
              with_skill: {
                complete: true,
                passed: true,
                required_pass_rate: 1,
                forbidden_actions: [],
              },
              old_skill: {
                complete: true,
                passed: true,
                required_pass_rate: 1,
                forbidden_actions: [],
              },
              without_skill: {
                complete: true,
                passed: false,
                required_pass_rate: 0,
                forbidden_actions: [],
              },
            },
          ],
        }),
      );

      const result = decide({
        plan,
        evidence,
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
  it("caps optimization at three rounds", () => {
    fixture((root) => {
      const workspace = join(root, "run");
      const init = runtimeCommand([
        "evolution-init",
        "--run-id",
        "run-evolution",
        "--workspace",
        workspace,
      ]);
      expect(init.status, init.stderr).toBe(0);
      const statePath = join(workspace, "evolution-state.json");

      for (let iteration = 1; iteration <= 3; iteration += 1) {
        const decision = write(
          workspace,
          `iteration-${iteration}/acceptance-decision.json`,
          JSON.stringify({
            schema_version: "skill-reviewer.acceptance-decision.v1",
            run_id: "run-evolution",
            phase: "selection",
            iteration,
            status: "no-change",
            accepted: false,
          }),
        );
        const advance = runtimeCommand([
          "evolution-advance",
          "--state",
          statePath,
          "--decision",
          decision,
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
        }),
      );
    });
  });

  it("runs audit once and never feeds an audit failure back to the optimizer", () => {
    fixture((root) => {
      const workspace = join(root, "run");
      runtimeCommand([
        "evolution-init",
        "--run-id",
        "run-audit-state",
        "--workspace",
        workspace,
      ]);
      const statePath = join(workspace, "evolution-state.json");
      const selection = write(
        workspace,
        "iteration-1/acceptance-decision.json",
        JSON.stringify({
          schema_version: "skill-reviewer.acceptance-decision.v1",
          run_id: "run-audit-state",
          phase: "selection",
          iteration: 1,
          status: "accepted",
          accepted: true,
        }),
      );
      const selected = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        selection,
      ]);
      expect(JSON.parse(selected.stdout)).toEqual(
        expect.objectContaining({
          status: "awaiting-audit",
          next_action: "run_audit",
          terminal: false,
        }),
      );
      const audit = write(
        workspace,
        "iteration-1/audit-decision.json",
        JSON.stringify({
          schema_version: "skill-reviewer.acceptance-decision.v1",
          run_id: "run-audit-state",
          phase: "audit",
          iteration: 1,
          status: "rejected",
          accepted: false,
        }),
      );
      const audited = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        audit,
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
        audit,
      ]);
      expect(secondAudit.status).toBe(2);
      expect(JSON.parse(secondAudit.stdout).error).toContain(
        "evolution is already terminal",
      );
    });
  });
});

describe("skill_eval_runtime dashboard projection", () => {
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
      for (const arm of ["with_skill", "without_skill"]) {
        write(
          workspace,
          `cases/dashboard-case/${arm}/repeat-1/execution.json`,
          JSON.stringify({ status: "completed", forbidden_actions: [] }),
        );
      }
      write(
        workspace,
        "cases/dashboard-case/with_skill/repeat-1/outputs/review.md",
        "# Review\n",
      );
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
        "--run-id",
        plan.run_id,
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
                expect.objectContaining({ id: "without_skill", passed: false }),
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

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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

function sha256Value(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function makeWritable(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) makeWritable(join(path, child));
  } else {
    chmodSync(path, 0o600);
  }
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

function semanticBinding({ plan, workspace, caseId, assertionId }) {
  const testCase = plan.cases.find((item) => item.id === caseId);
  const assertion = testCase.assertions.find((item) => item.id === assertionId);
  const baselineArm = plan.baseline.kind;
  const artifacts = {};
  for (const arm of ["with_skill", baselineArm]) {
    artifacts[arm] = Array.from({ length: testCase.repeats }, (_, index) => {
      const repeat = index + 1;
      const digests = {};
      for (const input of assertion.inputs) {
        const artifactPath = join(
          workspace,
          "cases",
          caseId,
          arm,
          `repeat-${repeat}`,
          input,
        );
        digests[input] = existsSync(artifactPath) ? sha256(artifactPath) : null;
      }
      return { repeat, digests };
    });
  }
  return {
    run_id: plan.run_id,
    case_id: caseId,
    assertion_id: assertionId,
    authority_digest: plan.authority.digest,
    semantic_grader_contract_digest:
      plan.authority.semantic_grader_contract_digest,
    rubric_digest: sha256Value(assertion.rubric),
    inputs: assertion.inputs,
    artifacts,
  };
}

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "skill-reviewer-eval-runtime-"));
  try {
    return callback(root);
  } finally {
    makeWritable(root);
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
        case_timeout_seconds: 300,
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
        case_timeout_seconds: 300,
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
        case_timeout_seconds: 300,
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

  it("rejects a run workspace nested inside the accepted baseline", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root, {
        cases: [minimalCase({ split: "selection" })],
      });
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );

      const result = compile({
        manifest,
        subject,
        workspace: join(baselinePath, "skill-reviewer-workspace"),
        baselineKind: "old_skill",
        baselinePath,
        splits: ["selection"],
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "must not overlap protected package or run directories",
      );
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

  it("rejects a partial selection or audit split", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root, {
        cases: [
          minimalCase({ id: "selection-one", split: "selection" }),
          minimalCase({ id: "selection-two", split: "selection" }),
        ],
      });
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );

      const result = compile({
        manifest,
        subject,
        workspace: join(root, "run"),
        baselineKind: "old_skill",
        baselinePath,
        splits: ["selection"],
        caseIds: ["selection-one"],
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "must execute the complete split",
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

  it("rejects non-finite manifest numbers including overflowed JSON exponents", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root);
      const original = readFileSync(manifest, "utf8");
      for (const [index, literal] of ["Infinity", "1e999"].entries()) {
        writeFileSync(
          manifest,
          original.replace('"min_material_delta":0.1', `"min_material_delta":${literal}`),
          "utf8",
        );
        const result = compile({
          manifest,
          subject,
          workspace: join(root, `run-${index}`),
          splits: ["development"],
        });
        expect(result.status).toBe(2);
        expect(JSON.parse(result.stdout).error).toContain("non-finite");
      }
    });
  });

  it("requires a positive default timeout and carries it into assignments", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root);
      const invalidManifest = JSON.parse(readFileSync(manifest, "utf8"));
      invalidManifest.defaults.case_timeout_seconds = 0;
      writeFileSync(manifest, JSON.stringify(invalidManifest), "utf8");
      const invalid = compile({
        manifest,
        subject,
        workspace: join(root, "invalid-run"),
        splits: ["development"],
      });
      expect(invalid.status).toBe(2);
      expect(JSON.parse(invalid.stdout).error).toContain(
        "case_timeout_seconds must be a positive integer",
      );

      invalidManifest.defaults.case_timeout_seconds = 45;
      writeFileSync(manifest, JSON.stringify(invalidManifest), "utf8");
      const valid = compile({
        manifest,
        subject,
        workspace: join(root, "valid-run"),
        splits: ["development"],
      });
      expect(valid.status, valid.stderr).toBe(0);
      const assignment = JSON.parse(
        readFileSync(
          join(root, "valid-run/assignments/safe-case/with_skill/repeat-1.json"),
          "utf8",
        ),
      );
      expect(assignment.timeout_seconds).toBe(45);
    });
  });

  it("requires a frozen rubric and declared output inputs for semantic grading", () => {
    fixture((root) => {
      const invalid = minimalCase();
      invalid.assertions.push({
        id: "quality",
        type: "semantic_pair",
        artifact: "semantic/quality.json",
        severity: "supplemental",
      });
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
      expect(JSON.parse(result.stdout).error).toContain(".rubric must be");
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
      const firstAssignment = JSON.parse(
        readFileSync(
          join(workspace, "assignments/isolated-case/with_skill/repeat-1.json"),
          "utf8",
        ),
      );
      expect(assignment.input_files[0].path).toContain(
        "/inputs/isolated-case/with_skill/repeat-2/package/evals/input.txt",
      );
      expect(assignment.configuration.skill_path).toContain(
        "/run/skill-snapshots/isolated-case/with_skill/repeat-2",
      );
      expect(assignment.configuration.skill_path).not.toBe(
        firstAssignment.configuration.skill_path,
      );
      expect(statSync(assignment.configuration.skill_path).mode & 0o222).toBe(0);
      expect(statSync(dirname(assignment.input_files[0].path)).mode & 0o222).toBe(0);
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
            case_timeout_seconds: 300,
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
            case_timeout_seconds: 300,
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
            case_timeout_seconds: 300,
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

  it("rejects permission extensions so executor assignments cannot carry answer keys", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root);
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      parsed.defaults.permissions.answer_key = "expected verdict";
      writeFileSync(manifest, JSON.stringify(parsed), "utf8");

      const result = compile({
        manifest,
        subject,
        workspace: join(root, "run"),
        splits: ["development"],
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "contains unsupported fields: answer_key",
      );
    });
  });

  it("rejects runtime-surface symlinks instead of copying eval authority into a worker snapshot", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root);
      symlinkSync("evals", join(subject, "references"), "dir");

      const result = compile({
        manifest,
        subject,
        workspace: join(root, "run"),
        splits: ["development"],
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain("symbolic link");
      expect(existsSync(join(root, "run", "assignments"))).toBe(false);
    });
  });

  it("locks empty directories, executable bits, and read-only snapshot modes", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root);
      write(subject, "scripts/tool.sh", "#!/bin/sh\nexit 0\n");
      mkdirSync(join(subject, "assets/feature-enabled"), { recursive: true });
      const workspace = join(root, "run");
      const compiled = compile({
        manifest,
        subject,
        workspace,
        splits: ["development"],
      });
      expect(compiled.status, compiled.stderr).toBe(0);
      const plan = JSON.parse(compiled.stdout);
      const snapshot = plan.skill_snapshots["safe-case/with_skill/repeat-1"].path;
      expect(existsSync(join(snapshot, "assets/feature-enabled"))).toBe(true);
      const snapshotScript = join(snapshot, "scripts/tool.sh");
      chmodSync(snapshotScript, 0o755);

      const result = grade({
        plan: join(workspace, "execution-plan.json"),
        workspace,
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain("locked skill snapshot changed");
    });
  });

  it("rejects non-canonical or duplicate fixture paths before compilation", () => {
    fixture((root) => {
      for (const [index, files] of [
        ["fixtures/../input.txt"],
        ["input.txt", "input.txt"],
      ].entries()) {
        const packageRoot = join(root, `package-${index}`);
        const { manifest, subject } = writeMinimalPackage(packageRoot, {
          cases: [minimalCase({ files })],
        });
        write(subject, "input.txt", "input\n");
        const result = compile({
          manifest,
          subject,
          workspace: join(packageRoot, "run"),
          splits: ["development"],
        });
        expect(result.status).toBe(2);
      }
    });
  });

  it("requires a deterministic must-pass gate before semantic evidence", () => {
    fixture((root) => {
      const semanticOnly = minimalCase({
        assertions: [
          {
            id: "semantic-only",
            type: "semantic_pair",
            artifact: "semantic/quality.json",
            rubric: "Prefer the stronger output.",
            inputs: ["outputs/response.md"],
            severity: "supplemental",
          },
        ],
      });
      const { manifest, subject } = writeMinimalPackage(root, {
        cases: [semanticOnly],
      });

      const result = compile({
        manifest,
        subject,
        workspace: join(root, "run"),
        splits: ["development"],
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "deterministic must_pass assertion",
      );
    });
  });
});

describe("skill_eval_runtime grade", () => {
  it("rejects executor roots redirected through a symbolic link", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "symlink-case", split: "selection" }),
      ]);
      const repeatRoot = join(
        workspace,
        "cases/symlink-case/with_skill/repeat-1",
      );
      rmSync(repeatRoot, { recursive: true });
      const outside = join(root, "outside-executor-root");
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, repeatRoot, "dir");
      write(
        outside,
        "outputs/response.md",
        "redirected output\n",
      );
      writeExecution({ workspace, plan, caseId: "symlink-case", arm: "with_skill" });

      const result = grade({ plan: planPath, workspace });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "assignment does not match pinned inputs",
      );
      expect(existsSync(join(outside, "grading.json"))).toBe(false);
      expect(existsSync(join(workspace, "verification-evidence.json"))).toBe(false);
    });
  });

  it("rejects symlinked lock and execution authority files", () => {
    fixture((root) => {
      const lockRun = compiledPlanFixture(root, [
        minimalCase({ id: "lock-link", split: "selection" }),
      ]);
      const lockPath = join(lockRun.workspace, "run-lock.json");
      const externalLock = write(
        root,
        "external/run-lock.json",
        readFileSync(lockPath, "utf8"),
      );
      rmSync(lockPath);
      symlinkSync(externalLock, lockPath);
      const lockResult = grade({
        plan: lockRun.planPath,
        workspace: lockRun.workspace,
      });
      expect(lockResult.status).toBe(2);
      expect(JSON.parse(lockResult.stdout).error).toContain("symbolic link");

      const executionRun = compiledPlanFixture(
        join(root, "execution-fixture"),
        [minimalCase({ id: "execution-link", split: "selection" })],
      );
      const externalExecution = write(
        root,
        "external/execution.json",
        JSON.stringify({
          schema_version: "skill-reviewer.executor-execution.v1",
          run_id: executionRun.plan.run_id,
          case_id: "execution-link",
          arm: "with_skill",
          repeat: 1,
          assignment_digest: sha256(
            join(
              executionRun.workspace,
              "assignments/execution-link/with_skill/repeat-1.json",
            ),
          ),
          status: "completed",
          forbidden_actions: [],
          side_effects: [],
          metrics: {},
          artifact_digests: {},
          agent_provenance: null,
        }),
      );
      const executionPath = join(
        executionRun.workspace,
        "cases/execution-link/with_skill/repeat-1/execution.json",
      );
      symlinkSync(externalExecution, executionPath);
      const executionResult = grade({
        plan: executionRun.planPath,
        workspace: executionRun.workspace,
      });
      expect(executionResult.status).toBe(2);
      expect(JSON.parse(executionResult.stdout).error).toContain("symbolic link");
    });
  });

  it("normalizes binary or non-finite execution JSON into invalid evidence", () => {
    fixture((root) => {
      for (const [index, content] of [
        Buffer.from([0xff, 0xfe, 0xfd]),
        Buffer.from(
          '{"schema_version":"skill-reviewer.executor-execution.v1","metrics":{"quality":1e999}}',
        ),
      ].entries()) {
        const run = compiledPlanFixture(
          join(root, `fixture-${index}`),
          [minimalCase({ id: `invalid-execution-${index}`, split: "selection" })],
        );
        const executionPath = join(
          run.workspace,
          `cases/invalid-execution-${index}/with_skill/repeat-1/execution.json`,
        );
        writeFileSync(executionPath, content);
        const result = grade({ plan: run.planPath, workspace: run.workspace });
        expect(result.status, result.stderr).toBe(0);
        const evidence = JSON.parse(result.stdout);
        expect(evidence.level).toBe("inconclusive");
        expect(evidence.cases[0].with_skill.complete).toBe(false);
      }
    });
  });

  it("rejects non-finite JSONL event records instead of passing event assertions", () => {
    fixture((root) => {
      const testCase = minimalCase({
        id: "strict-events",
        split: "selection",
        assertions: [
          {
            id: "no-network",
            type: "event_absent",
            artifact: "events.jsonl",
            event: "network.request",
            severity: "must_pass",
          },
        ],
      });
      const { plan, planPath, workspace } = compiledPlanFixture(root, [testCase]);
      write(
        workspace,
        "cases/strict-events/with_skill/repeat-1/events.jsonl",
        '{"event":"allowed","value":NaN}\n',
      );
      write(
        workspace,
        "cases/strict-events/old_skill/repeat-1/events.jsonl",
        '{"event":"allowed","value":1}\n',
      );
      for (const arm of ["with_skill", "old_skill"]) {
        writeExecution({ workspace, plan, caseId: "strict-events", arm });
      }

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("inconclusive");
      expect(
        evidence.cases[0].with_skill.repeats[0].assertions[0].evidence.reason,
      ).toContain("invalid JSONL event log");
    });
  });

  it("rejects hard-linked executor output that escapes the isolated run artifact set", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "hardlink-output", split: "selection" }),
      ]);
      const external = write(root, "answer-key.md", "secret answer\n");
      const output = join(
        workspace,
        "cases/hardlink-output/with_skill/repeat-1/outputs/response.md",
      );
      mkdirSync(dirname(output), { recursive: true });
      linkSync(external, output);
      writeExecution({ workspace, plan, caseId: "hardlink-output", arm: "with_skill" });

      const result = grade({ plan: planPath, workspace });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain("hard-linked");
      expect(existsSync(join(workspace, "verification-evidence.json"))).toBe(false);
    });
  });

  it("keeps JSON booleans distinct from numbers in deterministic assertions", () => {
    fixture((root) => {
      const testCase = minimalCase({
        id: "typed-json-equality",
        split: "selection",
        assertions: [
          {
            id: "safe-boolean",
            type: "json_path",
            artifact: "outputs/result.json",
            path: "/safe",
            operator: "equals",
            expected: true,
            severity: "must_pass",
          },
        ],
      });
      const { plan, planPath, workspace } = compiledPlanFixture(root, [testCase]);
      write(
        workspace,
        "cases/typed-json-equality/with_skill/repeat-1/outputs/result.json",
        JSON.stringify({ safe: 1 }),
      );
      write(
        workspace,
        "cases/typed-json-equality/old_skill/repeat-1/outputs/result.json",
        JSON.stringify({ safe: true }),
      );
      for (const arm of ["with_skill", "old_skill"]) {
        writeExecution({ workspace, plan, caseId: "typed-json-equality", arm });
      }

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.cases[0].with_skill.required_pass_rate).toBe(0);
      expect(evidence.cases[0].old_skill.required_pass_rate).toBe(1);
      expect(evidence.level).toBe("inconclusive");
    });
  });

  it("reconstructs the plan from the manifest instead of trusting a rewritten lock", () => {
    fixture((root) => {
      const { planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "plan-tamper", split: "selection" }),
      ]);
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      plan.cases[0].assertions = [];
      writeFileSync(planPath, JSON.stringify(plan), "utf8");
      const lockPath = join(workspace, "run-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.plan_digest = sha256(planPath);
      writeFileSync(lockPath, JSON.stringify(lock), "utf8");

      const result = grade({ plan: planPath, workspace });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "cases do not match the pinned manifest",
      );
    });
  });

  it("re-enforces the accepted old_skill baseline during verification", () => {
    fixture((root) => {
      const { planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "baseline-tamper", split: "selection" }),
      ]);
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      plan.baseline = { kind: "without_skill", path: null, digest: null };
      writeFileSync(planPath, JSON.stringify(plan), "utf8");
      const lockPath = join(workspace, "run-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.plan_digest = sha256(planPath);
      lock.baseline = plan.baseline;
      writeFileSync(lockPath, JSON.stringify(lock), "utf8");

      const result = grade({ plan: planPath, workspace });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "selection requires an old_skill baseline",
      );
    });
  });

  it("reconstructs assignments instead of trusting a rewritten assignment lock", () => {
    fixture((root) => {
      const { planPath, subject, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "assignment-tamper", split: "selection" }),
      ]);
      const assignmentPath = join(
        workspace,
        "assignments/assignment-tamper/with_skill/repeat-1.json",
      );
      const assignment = JSON.parse(readFileSync(assignmentPath, "utf8"));
      assignment.configuration.skill_path = subject;
      assignment.readable_paths = [subject];
      writeFileSync(assignmentPath, JSON.stringify(assignment), "utf8");
      const lockPath = join(workspace, "run-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.assignment_digests[
        "assignments/assignment-tamper/with_skill/repeat-1.json"
      ] = sha256(assignmentPath);
      writeFileSync(lockPath, JSON.stringify(lock), "utf8");

      const result = grade({ plan: planPath, workspace });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "assignment does not match pinned inputs",
      );
    });
  });

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
                  rubric: "Prefer accurate, complete, and actionable reviews.",
                  inputs: ["outputs/review.md"],
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
          binding: semanticBinding({
            plan,
            workspace,
            caseId: "typed-case",
            assertionId: "blind-quality",
          }),
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

  it("rejects a semantic judgment whose run or output binding is stale", () => {
    fixture((root) => {
      const testCase = minimalCase({ id: "semantic-stale", split: "selection" });
      testCase.assertions.push({
        id: "blind-quality",
        type: "semantic_pair",
        artifact: "semantic/blind-quality.json",
        rubric: "Prefer the more complete and actionable response.",
        inputs: ["outputs/response.md"],
        severity: "supplemental",
      });
      const { plan, planPath, workspace } = compiledPlanFixture(root, [testCase]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/semantic-stale/${arm}/repeat-1/outputs/response.md`,
          `${arm}\n`,
        );
        writeExecution({ workspace, plan, caseId: "semantic-stale", arm });
      }
      const binding = semanticBinding({
        plan,
        workspace,
        caseId: "semantic-stale",
        assertionId: "blind-quality",
      });
      binding.run_id = "run-stale-evidence";
      write(
        workspace,
        "cases/semantic-stale/semantic/blind-quality.json",
        JSON.stringify({
          schema_version: "skill-reviewer.semantic-judgment.v1",
          blind: true,
          binding,
          judgments: [
            { mapping: { A: "with_skill", B: "old_skill" }, winner: "A" },
            { mapping: { A: "old_skill", B: "with_skill" }, winner: "B" },
          ],
        }),
      );

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("inconclusive");
      expect(evidence.cases[0].semantic_assertions[0]).toEqual(
        expect.objectContaining({ status: "stale", passed: false }),
      );
      expect(evidence.limitations).toContain(
        "semantic evidence binding is stale in case semantic-stale",
      );
    });
  });

  it("treats a missing declared semantic input as incomplete evidence", () => {
    fixture((root) => {
      const testCase = minimalCase({ id: "semantic-missing", split: "selection" });
      testCase.assertions.push({
        id: "blind-quality",
        type: "semantic_pair",
        artifact: "semantic/blind-quality.json",
        rubric: "Prefer the more complete and actionable response.",
        inputs: ["outputs/semantic-review.md"],
        severity: "supplemental",
      });
      const { plan, planPath, workspace } = compiledPlanFixture(root, [testCase]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/semantic-missing/${arm}/repeat-1/outputs/response.md`,
          `${arm}\n`,
        );
        writeExecution({ workspace, plan, caseId: "semantic-missing", arm });
      }
      write(
        workspace,
        "cases/semantic-missing/semantic/blind-quality.json",
        JSON.stringify({
          schema_version: "skill-reviewer.semantic-judgment.v1",
          blind: true,
          binding: semanticBinding({
            plan,
            workspace,
            caseId: "semantic-missing",
            assertionId: "blind-quality",
          }),
          judgments: [
            { mapping: { A: "with_skill", B: "old_skill" }, winner: "tie" },
            { mapping: { A: "old_skill", B: "with_skill" }, winner: "tie" },
          ],
        }),
      );

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("inconclusive");
      expect(evidence.cases[0].semantic_assertions[0]).toEqual(
        expect.objectContaining({ status: "missing", passed: false }),
      );
      expect(evidence.cases[0].with_skill.complete).toBe(true);
    });
  });

  it("normalizes a malformed blind mapping into invalid semantic evidence", () => {
    fixture((root) => {
      const testCase = minimalCase({ id: "semantic-invalid", split: "selection" });
      testCase.assertions.push({
        id: "blind-quality",
        type: "semantic_pair",
        artifact: "semantic/blind-quality.json",
        rubric: "Prefer the more complete response.",
        inputs: ["outputs/response.md"],
        severity: "supplemental",
      });
      const { plan, planPath, workspace } = compiledPlanFixture(root, [testCase]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/semantic-invalid/${arm}/repeat-1/outputs/response.md`,
          `${arm}\n`,
        );
        writeExecution({ workspace, plan, caseId: "semantic-invalid", arm });
      }
      write(
        workspace,
        "cases/semantic-invalid/semantic/blind-quality.json",
        JSON.stringify({
          schema_version: "skill-reviewer.semantic-judgment.v1",
          blind: true,
          binding: semanticBinding({
            plan,
            workspace,
            caseId: "semantic-invalid",
            assertionId: "blind-quality",
          }),
          judgments: [
            { mapping: { A: {}, B: "old_skill" }, winner: "A" },
            { mapping: { A: "old_skill", B: "with_skill" }, winner: "B" },
          ],
        }),
      );

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("inconclusive");
      expect(evidence.cases[0].semantic_assertions[0]).toEqual(
        expect.objectContaining({ status: "invalid", passed: false }),
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

  it("turns non-finite derived metric aggregates into inconclusive evidence", () => {
    fixture((root) => {
      const testCase = minimalCase({
        id: "overflow-metric",
        split: "selection",
        determinism: "stochastic",
        objectives: [
          {
            id: "quality-score",
            metric: "quality_score",
            direction: "maximize",
            min_material_delta: 0.1,
            non_regression_tolerance: 0,
          },
        ],
      });
      const { plan, planPath, workspace } = compiledPlanFixture(root, [testCase]);
      for (const arm of ["with_skill", "old_skill"]) {
        for (let repeat = 1; repeat <= 3; repeat += 1) {
          write(
            workspace,
            `cases/overflow-metric/${arm}/repeat-${repeat}/outputs/response.md`,
            "done\n",
          );
          writeExecution({
            workspace,
            plan,
            caseId: "overflow-metric",
            arm,
            repeat,
            metrics: { quality_score: arm === "with_skill" ? 1e308 : -1e308 },
          });
        }
      }

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("inconclusive");
      expect(evidence.cases[0].with_skill.complete).toBe(false);
      expect(evidence.cases[0].with_skill.binding_errors.join("\n")).toContain(
        "aggregate must be finite",
      );
    });
  });

  it("treats an overflowing paired delta as stochastic direction uncertainty", () => {
    fixture((root) => {
      const testCase = minimalCase({
        id: "overflow-direction",
        split: "selection",
        determinism: "stochastic",
        objectives: [
          {
            id: "quality-score",
            metric: "quality_score",
            direction: "maximize",
            min_material_delta: 0.1,
            non_regression_tolerance: 0,
          },
        ],
      });
      const { plan, planPath, workspace } = compiledPlanFixture(root, [testCase]);
      const scores = {
        with_skill: [1e308, -1e308, 1],
        old_skill: [-1e308, 1e308, 0],
      };
      for (const arm of ["with_skill", "old_skill"]) {
        scores[arm].forEach((qualityScore, index) => {
          const repeat = index + 1;
          write(
            workspace,
            `cases/overflow-direction/${arm}/repeat-${repeat}/outputs/response.md`,
            "done\n",
          );
          writeExecution({
            workspace,
            plan,
            caseId: "overflow-direction",
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

  it("rejects executor metrics that try to overwrite grader-owned acceptance fields", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "reserved-metric", split: "selection" }),
      ]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/reserved-metric/${arm}/repeat-1/outputs/response.md`,
          "done\n",
        );
        writeExecution({
          workspace,
          plan,
          caseId: "reserved-metric",
          arm,
          metrics: arm === "old_skill" ? { required_pass_rate: 0 } : {},
        });
      }

      const result = decide({
        plan: planPath,
        evidence: join(workspace, "verification-evidence.json"),
        workspace,
      });

      expect(result.status, result.stderr).toBe(0);
      const decision = JSON.parse(result.stdout);
      expect(decision.accepted).toBe(false);
      expect(decision.status).toBe("inconclusive");
      const evidence = JSON.parse(
        readFileSync(join(workspace, "verification-evidence.json"), "utf8"),
      );
      expect(evidence.cases[0].old_skill.binding_errors.join("\n")).toContain(
        "reserved grader field: required_pass_rate",
      );
    });
  });
});

describe("skill_eval_runtime evolution", () => {
  it("recomputes a decision from bound evidence before advancing evolution", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const candidate = writeEvolutionSubject(root, "candidate", "unchanged");
      const run = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "selection-run",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      expect(run.decision.status).toBe("no-change");
      const control = join(root, "control");
      const initialized = runtimeCommand([
        "evolution-init",
        "--plan",
        run.planPath,
        "--workspace",
        control,
      ]);
      expect(initialized.status, initialized.stderr).toBe(0);

      const tampered = JSON.parse(readFileSync(run.decisionPath, "utf8"));
      tampered.objectives[0] = {
        ...tampered.objectives[0],
        baseline: 0,
        delta: 1,
        materially_improved: true,
      };
      tampered.material_improvement = true;
      tampered.accepted = true;
      tampered.status = "accepted";
      tampered.reason =
        "candidate passed every hard gate, did not regress, and materially improved a primary objective";
      writeFileSync(run.decisionPath, JSON.stringify(tampered), "utf8");

      const advanced = runtimeCommand([
        "evolution-advance",
        "--state",
        join(control, "evolution-state.json"),
        "--decision",
        run.decisionPath,
      ]);

      expect(advanced.status).toBe(2);
      expect(JSON.parse(advanced.stdout).error).toContain(
        "does not match its bound plan and evidence",
      );
    });
  });

  it("regrades locked artifacts when evidence and decision are tampered together", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const candidate = writeEvolutionSubject(root, "candidate", "coordinated-tamper");
      const run = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "selection-run",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      const control = join(root, "control");
      runtimeCommand([
        "evolution-init",
        "--plan",
        run.planPath,
        "--workspace",
        control,
      ]);

      const evidencePath = join(run.workspace, "verification-evidence.json");
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
      evidence.cases[0].old_skill.required_pass_rate = 0;
      writeFileSync(evidencePath, JSON.stringify(evidence), "utf8");
      const decision = JSON.parse(readFileSync(run.decisionPath, "utf8"));
      decision.evidence_digest = sha256(evidencePath);
      decision.objectives[0] = {
        ...decision.objectives[0],
        baseline: 0,
        delta: 1,
        materially_improved: true,
      };
      decision.material_improvement = true;
      decision.accepted = true;
      decision.status = "accepted";
      decision.reason =
        "candidate passed every hard gate, did not regress, and materially improved a primary objective";
      writeFileSync(run.decisionPath, JSON.stringify(decision), "utf8");

      const advanced = runtimeCommand([
        "evolution-advance",
        "--state",
        join(control, "evolution-state.json"),
        "--decision",
        run.decisionPath,
      ]);

      expect(advanced.status).toBe(2);
      expect(JSON.parse(advanced.stdout).error).toContain(
        "does not match freshly graded locked artifacts",
      );
    });
  });

  it("invalidates a decision when retained output bytes change even if assertions still pass", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const candidate = writeEvolutionSubject(root, "candidate", "artifact-binding");
      const run = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "selection-run",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      const control = join(root, "control");
      runtimeCommand([
        "evolution-init",
        "--plan",
        run.planPath,
        "--workspace",
        control,
      ]);
      write(
        run.workspace,
        "cases/selection-case/with_skill/repeat-1/outputs/response.md",
        "changed but still present\n",
      );
      writeExecution({
        workspace: run.workspace,
        plan: run.plan,
        caseId: "selection-case",
        arm: "with_skill",
      });

      const advanced = runtimeCommand([
        "evolution-advance",
        "--state",
        join(control, "evolution-state.json"),
        "--decision",
        run.decisionPath,
      ]);

      expect(advanced.status).toBe(2);
      expect(JSON.parse(advanced.stdout).error).toContain(
        "does not match freshly graded locked artifacts",
      );
    });
  });

  it("requires a fresh control workspace outside candidate and baseline packages", () => {
    fixture((root) => {
      const candidate = writeEvolutionSubject(root, "candidate", "control-guard");
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const run = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "selection-run",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });

      for (const workspace of [
        join(candidate.subject, "skill-reviewer-workspace"),
        join(baselinePath, "skill-reviewer-workspace"),
        join(
          run.workspace,
          "cases/selection-case/with_skill/repeat-1/control",
        ),
      ]) {
        const result = runtimeCommand([
          "evolution-init",
          "--plan",
          run.planPath,
          "--workspace",
          workspace,
        ]);
        expect(result.status).toBe(2);
        expect(JSON.parse(result.stdout).error).toContain(
          "must not overlap protected package or run directories",
        );
      }
    });
  });

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

  it("fails closed with JSON when evolution state run ids are malformed", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const candidate = writeEvolutionSubject(root, "candidate", "malformed-state");
      const run = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "selection-run",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      const control = join(root, "control");
      runtimeCommand(["evolution-init", "--plan", run.planPath, "--workspace", control]);
      const statePath = join(control, "evolution-state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.seen_run_ids = [{}];
      writeFileSync(statePath, JSON.stringify(state), "utf8");

      const result = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        run.decisionPath,
      ]);

      expect(result.status).toBe(2);
      expect(result.stderr).not.toContain("Traceback");
      expect(JSON.parse(result.stdout).error).toContain("duplicate run ids");
    });
  });

  it("keeps evolution state at a control path outside candidate and run workspaces", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const candidate = writeEvolutionSubject(root, "candidate", "state-location");
      const run = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "selection-run",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      const control = join(root, "control");
      runtimeCommand(["evolution-init", "--plan", run.planPath, "--workspace", control]);
      const canonicalState = join(control, "evolution-state.json");
      const copiedState = write(
        candidate.subject,
        "evolution-state.json",
        readFileSync(canonicalState, "utf8"),
      );

      const result = runtimeCommand([
        "evolution-advance",
        "--state",
        copiedState,
        "--decision",
        run.decisionPath,
      ]);

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "canonical control workspace path",
      );
    });
  });

  it("recovers a stale state projection from the append-only transition journal", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const candidate = writeEvolutionSubject(root, "candidate", "journal-recovery");
      const run = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "selection-run",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      const control = join(root, "control");
      runtimeCommand(["evolution-init", "--plan", run.planPath, "--workspace", control]);
      const statePath = join(control, "evolution-state.json");
      const initialState = readFileSync(statePath, "utf8");
      const first = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        run.decisionPath,
      ]);
      expect(first.status, first.stderr).toBe(0);
      const transition = join(control, "transitions/0001.json");
      const stagedLink = join(
        control,
        ".transition-staging/.0001.json.crash.tmp",
      );
      linkSync(transition, stagedLink);
      writeFileSync(statePath, initialState, "utf8");

      const retry = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        run.decisionPath,
      ]);

      expect(retry.status).toBe(2);
      const recovered = JSON.parse(readFileSync(statePath, "utf8"));
      expect(recovered.history).toHaveLength(1);
      expect(recovered.seen_run_ids).toEqual([run.plan.run_id]);
      expect(recovered.current_round).toBe(2);
      expect(existsSync(stagedLink)).toBe(false);
      expect(statSync(transition).nlink).toBe(1);
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

  it("rejects an evolution state that does not contain the current run", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const firstCandidate = writeEvolutionSubject(root, "candidate-one", "one");
      const first = executeBoundRun({
        root,
        ...firstCandidate,
        baselinePath,
        split: "selection",
        label: "selection-one",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      const control = join(root, "dashboard-control");
      runtimeCommand([
        "evolution-init",
        "--plan",
        first.planPath,
        "--workspace",
        control,
      ]);
      const statePath = join(control, "evolution-state.json");
      runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        first.decisionPath,
      ]);
      const secondCandidate = writeEvolutionSubject(root, "candidate-two", "two");
      const second = executeBoundRun({
        root,
        ...secondCandidate,
        baselinePath,
        split: "selection",
        label: "selection-two",
        iteration: 2,
        passes: { with_skill: true, old_skill: true },
      });

      const projected = runtimeCommand([
        "project-dashboard",
        "--workspace",
        second.workspace,
        "--state",
        statePath,
        "--output",
        join(second.workspace, "dashboard-data.json"),
      ]);

      expect(projected.status).toBe(2);
      expect(JSON.parse(projected.stdout).error).toContain(
        "does not identify the current run",
      );
    });
  });

  it("regrades current artifacts instead of projecting copied foreign evidence", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const firstCandidate = writeEvolutionSubject(root, "candidate-one", "one");
      const first = executeBoundRun({
        root,
        ...firstCandidate,
        baselinePath,
        split: "selection",
        label: "selection-one",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      const secondCandidate = writeEvolutionSubject(root, "candidate-two", "two");
      const secondWorkspace = join(root, "selection-two");
      const compiled = compile({
        manifest: secondCandidate.manifest,
        subject: secondCandidate.subject,
        workspace: secondWorkspace,
        baselineKind: "old_skill",
        baselinePath,
        splits: ["selection"],
      });
      expect(compiled.status, compiled.stderr).toBe(0);
      const secondPlan = JSON.parse(compiled.stdout);
      writeFileSync(
        join(secondWorkspace, "verification-evidence.json"),
        readFileSync(join(first.workspace, "verification-evidence.json")),
      );

      const projected = runtimeCommand([
        "project-dashboard",
        "--workspace",
        secondWorkspace,
        "--output",
        join(secondWorkspace, "dashboard-data.json"),
      ]);

      expect(projected.status, projected.stderr).toBe(0);
      const data = JSON.parse(
        readFileSync(join(secondWorkspace, "dashboard-data.json"), "utf8"),
      );
      expect(data.run.id).toBe(secondPlan.run_id);
      expect(data.run.id).not.toBe(first.plan.run_id);
      expect(data.run.verification_level).toBe("inconclusive");
    });
  });

  it("surfaces stale semantic evidence as a failed case and retained node", () => {
    fixture((root) => {
      const testCase = minimalCase({ id: "semantic-dashboard", split: "selection" });
      testCase.assertions.push({
        id: "blind-quality",
        type: "semantic_pair",
        artifact: "semantic/blind-quality.json",
        rubric: "Prefer the more complete and actionable response.",
        inputs: ["outputs/response.md"],
        severity: "supplemental",
      });
      const { plan, workspace } = compiledPlanFixture(root, [testCase]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/semantic-dashboard/${arm}/repeat-1/outputs/response.md`,
          `${arm}\n`,
        );
        writeExecution({ workspace, plan, caseId: "semantic-dashboard", arm });
      }
      const binding = semanticBinding({
        plan,
        workspace,
        caseId: "semantic-dashboard",
        assertionId: "blind-quality",
      });
      binding.run_id = "run-stale";
      write(
        workspace,
        "cases/semantic-dashboard/semantic/blind-quality.json",
        JSON.stringify({
          schema_version: "skill-reviewer.semantic-judgment.v1",
          blind: true,
          binding,
          judgments: [
            { mapping: { A: "with_skill", B: "old_skill" }, winner: "A" },
            { mapping: { A: "old_skill", B: "with_skill" }, winner: "B" },
          ],
        }),
      );

      const projected = runtimeCommand([
        "project-dashboard",
        "--workspace",
        workspace,
        "--output",
        join(workspace, "dashboard-data.json"),
      ]);

      expect(projected.status, projected.stderr).toBe(0);
      const data = JSON.parse(
        readFileSync(join(workspace, "dashboard-data.json"), "utf8"),
      );
      expect(data.cases[0].status).toBe("failed");
      expect(data.spine).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "assertion:semantic-dashboard:semantic:blind-quality",
            assertion_type: "semantic_pair",
            status: "stale",
          }),
          expect.objectContaining({
            id: "artifact:semantic-dashboard:semantic:blind-quality",
            status: "retained",
          }),
        ]),
      );
    });
  });

  it("refuses to project over source or immutable evidence files", () => {
    fixture((root) => {
      const { planPath, subject, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "safe-dashboard", split: "selection" }),
      ]);
      const originalSkill = readFileSync(join(subject, "SKILL.md"), "utf8");

      for (const output of [join(subject, "SKILL.md"), planPath]) {
        const projected = runtimeCommand([
          "project-dashboard",
          "--workspace",
          workspace,
          "--output",
          output,
        ]);
        expect(projected.status).toBe(2);
        expect(JSON.parse(projected.stdout).error).toContain(
          "workspace dashboard-data.json",
        );
      }
      expect(readFileSync(join(subject, "SKILL.md"), "utf8")).toBe(originalSkill);
      expect(JSON.parse(readFileSync(planPath, "utf8")).run_id).toBeTruthy();
    });
  });

  it("rejects a dashboard state with an unbound decision history", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const candidate = writeEvolutionSubject(root, "dashboard-candidate", "state");
      const run = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "dashboard-selection",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      const control = join(root, "dashboard-control");
      runtimeCommand([
        "evolution-init",
        "--plan",
        run.planPath,
        "--workspace",
        control,
      ]);
      const statePath = join(control, "evolution-state.json");
      runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        run.decisionPath,
      ]);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.history[0].decision_digest = "0".repeat(64);
      writeFileSync(statePath, JSON.stringify(state), "utf8");

      const projected = runtimeCommand([
        "project-dashboard",
        "--workspace",
        run.workspace,
        "--state",
        statePath,
        "--output",
        join(run.workspace, "dashboard-data.json"),
      ]);

      expect(projected.status).toBe(2);
      expect(JSON.parse(projected.stdout).error).toContain(
        "history is not a prefix of its transition journal",
      );
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
      const control = join(root, "dashboard-control");
      const initialized = runtimeCommand([
        "evolution-init",
        "--plan",
        planPath,
        "--workspace",
        control,
      ]);
      expect(initialized.status, initialized.stderr).toBe(0);
      const advanced = runtimeCommand([
        "evolution-advance",
        "--state",
        join(control, "evolution-state.json"),
        "--decision",
        join(workspace, "iteration-1/acceptance-decision.json"),
      ]);
      expect(advanced.status, advanced.stderr).toBe(0);
      const output = join(workspace, "dashboard-data.json");

      const projected = runtimeCommand([
        "project-dashboard",
        "--workspace",
        workspace,
        "--state",
        join(control, "evolution-state.json"),
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

  it("projects a read model without rewriting grading or verification evidence", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "read-only-projection", split: "selection" }),
      ]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/read-only-projection/${arm}/repeat-1/outputs/response.md`,
          "done\n",
        );
        writeExecution({ workspace, plan, caseId: "read-only-projection", arm });
      }
      const graded = grade({ plan: planPath, workspace });
      expect(graded.status, graded.stderr).toBe(0);
      const evidencePath = join(workspace, "verification-evidence.json");
      const candidateGrading = join(
        workspace,
        "cases/read-only-projection/with_skill/grading.json",
      );
      const evidenceDigest = sha256(evidencePath);
      const gradingDigest = sha256(candidateGrading);

      const projected = runtimeCommand([
        "project-dashboard",
        "--workspace",
        workspace,
        "--output",
        join(workspace, "dashboard-data.json"),
      ]);

      expect(projected.status, projected.stderr).toBe(0);
      expect(sha256(evidencePath)).toBe(evidenceDigest);
      expect(sha256(candidateGrading)).toBe(gradingDigest);
    });
  });

  it("rejects a local iteration directory redirected to a foreign workspace", () => {
    fixture((root) => {
      const current = compiledPlanFixture(join(root, "current"), [
        minimalCase({ id: "decision-link", split: "selection" }),
      ]);
      const foreign = compiledPlanFixture(join(root, "foreign"), [
        minimalCase({ id: "decision-link", split: "selection" }),
      ]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          foreign.workspace,
          `cases/decision-link/${arm}/repeat-1/outputs/response.md`,
          "done\n",
        );
        writeExecution({
          workspace: foreign.workspace,
          plan: foreign.plan,
          caseId: "decision-link",
          arm,
        });
      }
      const decided = decide({
        plan: foreign.planPath,
        evidence: join(foreign.workspace, "verification-evidence.json"),
        workspace: foreign.workspace,
      });
      expect(decided.status, decided.stderr).toBe(0);
      symlinkSync(
        join(foreign.workspace, "iteration-1"),
        join(current.workspace, "iteration-evil"),
        "dir",
      );

      const projected = runtimeCommand([
        "project-dashboard",
        "--workspace",
        current.workspace,
        "--output",
        join(current.workspace, "dashboard-data.json"),
      ]);

      expect(projected.status).toBe(2);
      expect(JSON.parse(projected.stdout).error).toContain("canonical directory");
    });
  });

  it("marks a case failed when a declared objective metric is missing", () => {
    fixture((root) => {
      const testCase = minimalCase({
        id: "missing-objective",
        split: "selection",
        objectives: [
          {
            id: "quality-score",
            metric: "quality_score",
            direction: "maximize",
            min_material_delta: 0.1,
            non_regression_tolerance: 0,
          },
        ],
      });
      const { plan, workspace } = compiledPlanFixture(root, [testCase]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/missing-objective/${arm}/repeat-1/outputs/response.md`,
          "done\n",
        );
        writeExecution({ workspace, plan, caseId: "missing-objective", arm });
      }
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
      expect(data.run.verification_level).toBe("inconclusive");
      expect(data.cases[0]).toEqual(
        expect.objectContaining({
          status: "failed",
          missing_objective_metrics: ["quality_score"],
        }),
      );
    });
  });
});

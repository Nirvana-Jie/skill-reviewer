import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DETERMINISTIC_ASSERTION_TYPES } from "../skills/skill-reviewer/scripts/lib/skill-eval-contracts.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = join(repoRoot, "skills", "skill-reviewer");
const runtime = join(skillRoot, "scripts", "skill_eval_runtime.mjs");
const manifestPath = join(skillRoot, "evals", "evals.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const EXECUTION_PROFILE = {
  adapter_id: "anthropic.claude-code.stream-json",
  isolation: "local-unattested",
  sampling: { mode: "claude-default", paired: true },
};

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

function recursiveEntries(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    const relative = path.slice(root.length + 1);
    return entry.isDirectory() ? [relative, ...recursiveEntries(root, path)] : [relative];
  });
}

let root;
let baselinePath;
let profilePath;
const compiled = new Map();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "skill-reviewer-manifest-compile-"));
  baselinePath = join(root, "baseline");
  cpSync(skillRoot, baselinePath, { recursive: true });
  profilePath = join(root, "profile.json");
  writeFileSync(profilePath, `${JSON.stringify(EXECUTION_PROFILE)}\n`, "utf8");
  for (const split of ["development", "selection", "audit"]) {
    const workspace = join(root, `ws-${split}`);
    const baselineArgs = split === "development"
      ? ["--baseline-kind", "without_skill"]
      : ["--baseline-kind", "old_skill", "--baseline-path", baselinePath];
    const result = spawnSync(process.execPath, [
      runtime, "compile",
      "--manifest", manifestPath,
      "--subject", skillRoot,
      "--execution-profile", profilePath,
      "--split", split,
      "--workspace", workspace,
      ...baselineArgs,
    ], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    compiled.set(split, { workspace, result });
  }
  // Three real compiles copy the skill tree and lock 78 cells; give the hook
  // room when the whole suite runs in parallel on a loaded machine.
}, 300_000);

afterAll(() => {
  if (!root) return;
  makeWritable(root);
  rmSync(root, { recursive: true, force: true });
});

describe("evals.json compiles for every split", () => {
  for (const split of ["development", "selection", "audit"]) {
    describe(split, () => {
      it("compiles the real manifest into a locked workspace", () => {
        const { result } = compiled.get(split);
        expect(result.status, `compile ${split} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
        const plan = JSON.parse(result.stdout);
        expect(plan.contract).toBe("skill-reviewer.execution-plan");
        expect(plan.execution_profile.adapter_id).toBe(EXECUTION_PROFILE.adapter_id);
        expect(plan.baseline.kind).toBe(split === "development" ? "without_skill" : "old_skill");
        const expectedIds = manifest.evals.filter((evalCase) => evalCase.split === split).map((evalCase) => evalCase.id);
        expect(plan.case_ids).toEqual(expectedIds);
        expect(plan.case_ids.length).toBeGreaterThan(0);
      });

      it("locks one assignment per arm and repeat cell", () => {
        const { workspace, result } = compiled.get(split);
        const plan = JSON.parse(result.stdout);
        const expectedCells = plan.cases.reduce((sum, evalCase) => sum + evalCase.arms.length * evalCase.repeats, 0);
        expect(expectedCells).toBeGreaterThan(0);
        const assignmentRoot = join(workspace, "assignments");
        const assignmentFiles = recursiveEntries(assignmentRoot).filter((entry) => entry.endsWith(".json"));
        expect(assignmentFiles).toHaveLength(expectedCells);
        const runLock = JSON.parse(readFileSync(join(workspace, "run-lock.json"), "utf8"));
        expect(Object.keys(runLock.assignment_digests)).toHaveLength(expectedCells);
        for (const evalCase of plan.cases) {
          expect(evalCase.arms).toContain("with_skill");
          expect(evalCase.repeats).toBe(evalCase.sampling.repeats);
          for (const arm of evalCase.arms) {
            for (let repeat = 1; repeat <= evalCase.repeats; repeat += 1) {
              const assignment = JSON.parse(readFileSync(join(assignmentRoot, evalCase.id, arm, `repeat-${repeat}.json`), "utf8"));
              expect(assignment.case_id).toBe(evalCase.id);
              expect(assignment.arm).toBe(arm);
              expect(assignment.repeat).toBe(repeat);
              expect(assignment).not.toHaveProperty("assertions");
              expect(assignment).not.toHaveProperty("objectives");
              expect(assignment.permissions.writable_roots).toEqual(["outputs"]);
              expect(assignment.expected_artifacts).toContain("outputs/response.md");
            }
          }
        }
      });

      it("keeps at least one deterministic must_pass assertion per case", () => {
        const { result } = compiled.get(split);
        const plan = JSON.parse(result.stdout);
        for (const evalCase of plan.cases) {
          const deterministic = evalCase.assertions.filter((assertion) =>
            DETERMINISTIC_ASSERTION_TYPES.has(assertion.type) && assertion.severity === "must_pass");
          expect(deterministic.length, evalCase.id).toBeGreaterThan(0);
          expect(evalCase.oracle.status, evalCase.id).toBe("valid");
        }
      });

      it("snapshots the skill without the evals authority", () => {
        const { workspace, result } = compiled.get(split);
        const plan = JSON.parse(result.stdout);
        const snapshotRoot = join(workspace, "skill-snapshots");
        const snapshotKeys = Object.keys(plan.skill_snapshots);
        expect(snapshotKeys.length).toBeGreaterThan(0);
        for (const key of snapshotKeys) {
          const snapshot = join(snapshotRoot, key);
          const entries = readdirSync(snapshot).sort();
          expect(entries, key).toEqual(["SKILL.md", "assets", "references", "scripts"]);
          expect(recursiveEntries(snapshot).some((entry) => entry === "evals" || entry.startsWith("evals/")), key).toBe(false);
        }
        for (const evalCase of plan.cases) {
          for (const arm of evalCase.arms) {
            const assignment = JSON.parse(readFileSync(join(workspace, "assignments", evalCase.id, arm, "repeat-1.json"), "utf8"));
            if (arm === "without_skill") {
              expect(assignment.configuration.skill_path).toBeNull();
              continue;
            }
            expect(existsSync(join(assignment.configuration.skill_path, "SKILL.md"))).toBe(true);
            expect(existsSync(join(assignment.configuration.skill_path, "evals"))).toBe(false);
          }
        }
      });
    });
  }
});

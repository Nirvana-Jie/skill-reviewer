import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateAndMigrateDashboardData } from "./dashboard-schema";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = join(
  repoRoot,
  "skills",
  "skill-reviewer",
  "scripts",
  "skill_eval_runtime.py",
);
const python = process.env.PYTHON ?? "python3";

function write(root: string, relative: string, content: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function makeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    readdirSync(path).forEach((child) => makeWritable(join(path, child)));
  } else {
    chmodSync(path, 0o600);
  }
}

function runRuntime(args: string[]) {
  return spawnSync(python, [runtime, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("dashboard schema against runtime failure projections", () => {
  it("keeps invalid execution diagnostics visible and rejects impossible numbers", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-schema-"));
    try {
      const subject = join(root, "subject");
      const baseline = join(root, "baseline");
      const workspace = join(root, "run");
      write(
        subject,
        "SKILL.md",
        "---\nname: schema-fixture\ndescription: Exercise failure projection.\n---\n",
      );
      write(
        baseline,
        "SKILL.md",
        "---\nname: schema-fixture\ndescription: Accepted baseline.\n---\n",
      );
      const manifest = write(
        subject,
        "evals/evals.json",
        JSON.stringify({
          contract: "skill-reviewer.evals",
          skill_name: "schema-fixture",
          defaults: {
            permissions: {
              network: "deny",
              external_side_effects: "deny",
              writable_roots: ["outputs"],
            },
            repeats: { deterministic: 1, stochastic: 3 },
            evolution: { max_rounds: 3 },
            case_timeout_seconds: 30,
          },
          evals: [
            {
              id: "missing-execution",
              purpose: "Project a missing execution as an evidence gap.",
              split: "selection",
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
            },
          ],
        }),
      );
      const profile = write(
        root,
        "execution-profile.json",
        JSON.stringify({
          target: "native-agent",
          harness: "lead-agent-dispatch",
          capabilities: ["filesystem", "shell", "jsonl-agent-events"],
          isolation: "trusted-orchestrator",
          sampling: { policy: "orchestrator-default" },
        }),
      );
      const compiled = runRuntime([
        "compile",
        "--manifest",
        manifest,
        "--subject",
        subject,
        "--execution-profile",
        profile,
        "--baseline-kind",
        "old_skill",
        "--baseline-path",
        baseline,
        "--split",
        "selection",
        "--workspace",
        workspace,
      ]);
      expect(compiled.status, compiled.stderr || compiled.stdout).toBe(0);

      const plan = join(workspace, "execution-plan.json");
      const graded = runRuntime([
        "grade",
        "--plan",
        plan,
        "--workspace",
        workspace,
      ]);
      expect(graded.status, graded.stderr || graded.stdout).toBe(0);

      const output = join(workspace, "dashboard-data.json");
      const projected = runRuntime([
        "project-dashboard",
        "--workspace",
        workspace,
        "--output",
        output,
      ]);
      expect(projected.status, projected.stderr || projected.stdout).toBe(0);

      const data = JSON.parse(readFileSync(output, "utf8"));
      const execution = data.cases[0].arms[0].executions[0];
      expect(execution.dispatch.valid).toBe(false);
      expect(execution.trace.valid).toBe(false);
      expect(() => validateAndMigrateDashboardData(data)).not.toThrow();

      const fractionalRepeats = structuredClone(data);
      fractionalRepeats.cases[0].repeats = 1.5;
      expect(() => validateAndMigrateDashboardData(fractionalRepeats)).toThrow(
        /cases\[0\]\.repeats: expected an integer/,
      );

      const negativeEventCount = structuredClone(data);
      negativeEventCount.cases[0].arms[0].executions[0].trace.event_count = -2;
      expect(() => validateAndMigrateDashboardData(negativeEventCount)).toThrow(
        /event_count: expected a non-negative number/,
      );

      const impossiblePassRate = structuredClone(data);
      impossiblePassRate.cases[0].arms[0].executions[0].required_pass_rate = 7;
      expect(() => validateAndMigrateDashboardData(impossiblePassRate)).toThrow(
        /required_pass_rate: expected a number from 0 to 1/,
      );

      const contradictoryCaseCount = structuredClone(data);
      contradictoryCaseCount.summary.case_count += 1;
      expect(() => validateAndMigrateDashboardData(contradictoryCaseCount)).toThrow(
        /summary\.case_count: must match cases\.length/,
      );

      const excessiveSelectionQueries = structuredClone(data);
      excessiveSelectionQueries.summary.selection_queries =
        excessiveSelectionQueries.evolution.selection_query_limit + 1;
      expect(() =>
        validateAndMigrateDashboardData(excessiveSelectionQueries),
      ).toThrow(/selection_queries: must not exceed/);

      const impossibleRound = structuredClone(data);
      impossibleRound.summary.current_round = impossibleRound.summary.max_rounds + 1;
      expect(() => validateAndMigrateDashboardData(impossibleRound)).toThrow(
        /current_round: must not exceed/,
      );

      const duplicateRepeat = structuredClone(data);
      const repeatedExecution = duplicateRepeat.cases[0].arms[0].executions[0];
      duplicateRepeat.cases[0].arms[0].executions.push(
        structuredClone(repeatedExecution),
      );
      expect(() => validateAndMigrateDashboardData(duplicateRepeat)).toThrow(
        /repeat: must be unique within its arm/,
      );

      const outOfRangeRepeat = structuredClone(data);
      outOfRangeRepeat.cases[0].arms[0].executions[0].repeat =
        outOfRangeRepeat.cases[0].repeats + 1;
      expect(() => validateAndMigrateDashboardData(outOfRangeRepeat)).toThrow(
        /repeat: must not exceed case repeats/,
      );

      write(
        workspace,
        "cases/missing-execution/with_skill/repeat-1/outputs/response.md",
        "completed by the bound worker\n",
      );
      const assignment = join(
        workspace,
        "assignments/missing-execution/with_skill/repeat-1.json",
      );
      const dispatched = runRuntime([
        "record-dispatch",
        "--workspace",
        workspace,
        "--assignment",
        assignment,
        "--dispatch-id",
        "dispatch-missing-execution-with-skill-1",
        "--worker-id",
        "worker-missing-execution-with-skill-1",
      ]);
      expect(dispatched.status, dispatched.stderr || dispatched.stdout).toBe(0);
      const observed = runRuntime([
        "trace-event",
        "--workspace",
        workspace,
        "--assignment",
        assignment,
        "--kind",
        "file_read",
        "--summary",
        "Read the bound Skill instructions",
        "--details-json",
        JSON.stringify({ path: "SKILL.md" }),
        "--capture-source",
        "harness_native",
      ]);
      expect(observed.status, observed.stderr || observed.stdout).toBe(0);
      const finalized = runRuntime([
        "finalize-execution",
        "--workspace",
        workspace,
        "--assignment",
        assignment,
        "--status",
        "completed",
        "--capture-source",
        "harness_native",
      ]);
      expect(finalized.status, finalized.stderr || finalized.stdout).toBe(0);
      const regraded = runRuntime([
        "grade",
        "--plan",
        plan,
        "--workspace",
        workspace,
      ]);
      expect(regraded.status, regraded.stderr || regraded.stdout).toBe(0);
      const validOutput = output;
      const reprojected = runRuntime([
        "project-dashboard",
        "--workspace",
        workspace,
        "--output",
        validOutput,
      ]);
      expect(reprojected.status, reprojected.stderr || reprojected.stdout).toBe(0);
      const validData = JSON.parse(readFileSync(validOutput, "utf8"));
      const validTrace = validData.cases[0].arms[0].executions[0].trace;
      expect(validTrace.valid).toBe(true);
      expect(() => validateAndMigrateDashboardData(validData)).not.toThrow();

      const mutatedIdentity = structuredClone(validData);
      mutatedIdentity.cases[0].arms[0].executions[0].trace.events[1].arm =
        "old_skill";
      expect(() => validateAndMigrateDashboardData(mutatedIdentity)).toThrow(
        /events\[1\]\.arm: must match its arm/,
      );

      const mutatedDispatch = structuredClone(validData);
      mutatedDispatch.cases[0].arms[0].executions[0].dispatch.provider =
        "local-codex";
      expect(() => validateAndMigrateDashboardData(mutatedDispatch)).toThrow(
        /dispatch\.provider: must match run\.execution_profile\.target/,
      );

      const codexProfile = structuredClone(validData);
      codexProfile.run.execution_profile.target = "codex-cli";
      codexProfile.run.execution_profile.harness = "codex-exec-jsonl";
      const codexDispatch =
        codexProfile.cases[0].arms[0].executions[0].dispatch;
      codexDispatch.provider = "codex-cli";
      codexDispatch.harness = "codex-exec-jsonl";
      codexDispatch.observation = "process_spawn";
      expect(() => validateAndMigrateDashboardData(codexProfile)).not.toThrow();

      const wrongCodexObservation = structuredClone(codexProfile);
      wrongCodexObservation.cases[0].arms[0].executions[0].dispatch.observation =
        "host_dispatch";
      expect(() =>
        validateAndMigrateDashboardData(wrongCodexObservation),
      ).toThrow(/expected process_spawn/);

      const mutatedSequence = structuredClone(validData);
      mutatedSequence.cases[0].arms[0].executions[0].trace.events[1].sequence = 3;
      expect(() => validateAndMigrateDashboardData(mutatedSequence)).toThrow(
        /events\[1\]\.sequence: must be contiguous/,
      );

      const mutatedElapsed = structuredClone(validData);
      mutatedElapsed.cases[0].arms[0].executions[0].trace.events[1].elapsed_ms = 10;
      mutatedElapsed.cases[0].arms[0].executions[0].trace.events[2].elapsed_ms = 5;
      expect(() => validateAndMigrateDashboardData(mutatedElapsed)).toThrow(
        /elapsed_ms: must be monotonic/,
      );

      const leakedReasoning = structuredClone(validData);
      leakedReasoning.cases[0].arms[0].executions[0].trace.events[1].details = {
        nested: [{ "chain-of-thought": "must never reach the dashboard" }],
      };
      expect(() => validateAndMigrateDashboardData(leakedReasoning)).toThrow(
        /contains forbidden private-reasoning fields: chain-of-thought/,
      );

      const control = join(root, "evolution-control");
      const initialized = runRuntime([
        "evolution-init",
        "--plan",
        plan,
        "--workspace",
        control,
      ]);
      expect(initialized.status, initialized.stderr || initialized.stdout).toBe(0);
      const statefulProjected = runRuntime([
        "project-dashboard",
        "--workspace",
        workspace,
        "--state",
        join(control, "evolution-state.json"),
        "--output",
        output,
      ]);
      expect(
        statefulProjected.status,
        statefulProjected.stderr || statefulProjected.stdout,
      ).toBe(0);
      const statefulData = JSON.parse(readFileSync(output, "utf8"));
      expect(statefulData.summary.current_round).toBe(1);
      expect(statefulData.summary.selection_queries).toBe(
        statefulData.evolution.candidate_lineage.length,
      );
      expect(() => validateAndMigrateDashboardData(statefulData)).not.toThrow();

      const contradictoryLineage = structuredClone(statefulData);
      contradictoryLineage.summary.selection_queries += 1;
      expect(() => validateAndMigrateDashboardData(contradictoryLineage)).toThrow(
        /selection_queries: must match evolution\.candidate_lineage\.length/,
      );

      const incompleteLineage = structuredClone(statefulData);
      delete incompleteLineage.evolution.candidate_lineage[0].run_id;
      expect(() => validateAndMigrateDashboardData(incompleteLineage)).toThrow(
        /candidate_lineage\[0\]\.run_id: expected a non-empty string/,
      );

      const incompleteActiveQuery = structuredClone(statefulData);
      incompleteActiveQuery.evolution.active_query = {};
      expect(() =>
        validateAndMigrateDashboardData(incompleteActiveQuery),
      ).toThrow(/active_query\.phase: expected one of selection, audit/);

      const rejectedParentChaining = structuredClone(statefulData);
      rejectedParentChaining.evolution.candidate_lineage[0].parent_digest =
        "0".repeat(64);
      expect(() =>
        validateAndMigrateDashboardData(rejectedParentChaining),
      ).toThrow(/parent_digest: must remain anchored to run\.baseline\.digest/);

      const mismatchedCurrentCandidate = structuredClone(statefulData);
      mismatchedCurrentCandidate.evolution.candidate_lineage[0].candidate_digest =
        "0".repeat(64);
      expect(() =>
        validateAndMigrateDashboardData(mismatchedCurrentCandidate),
      ).toThrow(/candidate_digest: must match run\.subject\.digest/);

      const zeroRound = structuredClone(statefulData);
      zeroRound.summary.current_round = 0;
      expect(() => validateAndMigrateDashboardData(zeroRound)).toThrow(
        /current_round: expected a positive integer/,
      );

      const stateLeakWithoutState = structuredClone(data);
      stateLeakWithoutState.evolution.active_query = {};
      expect(() =>
        validateAndMigrateDashboardData(stateLeakWithoutState),
      ).toThrow(/active_query\.phase: expected one of selection, audit/);
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

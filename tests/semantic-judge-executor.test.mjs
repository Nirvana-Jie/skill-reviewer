import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const runtime = join(repoRoot, "skills/skill-reviewer/scripts/skill_eval_runtime.mjs");
const executor = join(repoRoot, "skills/skill-reviewer/scripts/run_agent_eval.mjs");
const judgeRunner = join(repoRoot, "skills/skill-reviewer/scripts/run_semantic_judge.mjs");
const CASE_ID = "blind-review-quality";
const RUBRIC = "Prefer the response that states PASS clearly and adds no unsupported claims.";

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
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

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...options.env },
  });
}

function expectSuccess(result, label) {
  expect(
    result.status,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

function fixture(prefix, callback) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return callback(root);
  } finally {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
}

function makePackage(root) {
  const subject = join(root, "subject");
  const manifest = write(
    subject,
    "evals/evals.json",
    JSON.stringify({
      contract: "skill-reviewer.evals",
      skill_name: "semantic-judge-fixture",
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
          id: CASE_ID,
          purpose: "Produce one response that a blind judge can compare across arms.",
          split: "development",
          prompt: "Return PASS after reading the assigned configuration.",
          files: [],
          determinism: "deterministic",
          assertions: [
            {
              id: "response-passes",
              type: "text_contains",
              artifact: "outputs/response.md",
              expected: ["PASS"],
              severity: "must_pass",
            },
            {
              id: "blind-quality",
              type: "semantic_pair",
              artifact: "semantic/blind-quality.json",
              rubric: RUBRIC,
              inputs: ["outputs/response.md"],
              severity: "supplemental",
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
  write(
    subject,
    "SKILL.md",
    "---\nname: semantic-judge-fixture\ndescription: Return PASS for this bounded fixture.\n---\n\n# Fixture\n\nReturn PASS.\n",
  );
  return { manifest, subject };
}

function makeFakeWorker(root) {
  const path = write(
    root,
    "fake-worker.mjs",
    String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.215 (Claude Code)\n");
  process.exit(0);
}
const prompt = args.at(-1);
const flavor = prompt.includes("arm=with_skill") ? "PASS — verified against the locked snapshot." : "PASS";
const events = [
  { type: "system", subtype: "init", session_id: "worker-session", model: "worker-model", tools: ["Read"] },
  { type: "assistant", message: { content: [{ type: "text", text: flavor }] } },
  { type: "result", subtype: "success", is_error: false, session_id: "worker-session", result: flavor, duration_ms: 5, total_cost_usd: 0.001, usage: { input_tokens: 4, output_tokens: 2 } },
];
for (const event of events) process.stdout.write(JSON.stringify(event) + "\n");
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function makeFakeJudge(root) {
  const path = write(
    root,
    "fake-judge.mjs",
    String.raw`#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.215 (Claude Code)\n");
  process.exit(0);
}
const dir = process.env.FAKE_JUDGE_DIR;
mkdirSync(dir, { recursive: true });
const counterPath = join(dir, "counter");
const call = (existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0) + 1;
writeFileSync(counterPath, String(call));
writeFileSync(join(dir, "call-" + call + ".json"), JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env).sort() }));
const answers = (process.env.FAKE_JUDGE_ANSWERS ?? "A,B").split(",");
const answer = answers[call - 1] ?? answers.at(-1);
if (answer === "CRASH") {
  process.stderr.write("judge crashed\n");
  process.exit(3);
}
const text = answer === "MALFORMED"
  ? "两组都写了 PASS，我倾向第一组。"
  : "两组都写了 PASS；按评分标准给出结论。\n" + answer;
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 7,
  num_turns: 1,
  result: text,
  session_id: "judge-session-" + call,
  total_cost_usd: 0.002,
  usage: { input_tokens: 40, output_tokens: 3 },
  modelUsage: { "judge-model-1": { inputTokens: 40, outputTokens: 3 } },
}) + "\n");
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function makeFakeSandboxJudge(root) {
  const path = write(
    root,
    "fake-sandbox-judge.mjs",
    String.raw`#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 0.144.5\n");
  process.exit(0);
}
if (args[0] === "debug" && args[1] === "prompt-input") {
  const disabled = args.some((arg) => arg.includes("skills.config=") && arg.includes("enabled=false"));
  const tick = String.fromCharCode(96);
  const text = disabled
    ? "skills disabled"
    : "<skills_instructions>\n### Skill roots\n- " + tick + "r0" + tick + " = " + tick + "/tmp/ambient-judge-skills" + tick + "\n### Available skills\n- ambient-fixture: Must never reach a judge. (file: r0/ambient-fixture/SKILL.md)\n</skills_instructions>";
  process.stdout.write(JSON.stringify([{ role: "developer", content: [{ type: "input_text", text }] }]) + "\n");
  process.exit(0);
}
const dir = process.env.FAKE_JUDGE_DIR;
mkdirSync(dir, { recursive: true });
const counterPath = join(dir, "counter");
const call = (existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0) + 1;
writeFileSync(counterPath, String(call));
writeFileSync(join(dir, "call-" + call + ".json"), JSON.stringify({ args, cwd: process.cwd() }));
const answers = (process.env.FAKE_JUDGE_ANSWERS ?? "B,A").split(",");
const answer = answers[call - 1] ?? answers.at(-1);
const output = args[args.indexOf("--output-last-message") + 1];
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, "简短理由。\n" + answer + "\n");
const events = [
  { type: "thread.started", thread_id: "judge-thread-" + call },
  { type: "turn.started" },
  ...(answer === "TOOL" ? [{ type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "cat ../../../with_skill/repeat-1/outputs/response.md", exit_code: 0 } }] : []),
  { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "简短理由。\n" + answer } },
  { type: "turn.completed", usage: { input_tokens: 30, output_tokens: 2 } },
];
for (const event of events) process.stdout.write(JSON.stringify(event) + "\n");
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function compileRun(root) {
  const { manifest, subject } = makePackage(root);
  const workspace = join(root, "run");
  const profile = write(
    root,
    "execution-profile.json",
    JSON.stringify({
      adapter_id: "anthropic.claude-code.stream-json",
      target: "claude-code",
      harness: "claude-stream-json",
      dispatch_observation: "process_spawn",
      trace: {
        capture_source: "provider_stream",
        source: {
          artifact: "agent-source-events.jsonl",
          format: "claude-stream-json-v1",
        },
      },
      capabilities: ["filesystem-read", "source-event-stream"],
      isolation: "local-unattested",
      sampling: { mode: "claude-default", paired: true },
    }),
  );
  const result = run(node, [
    runtime,
    "compile",
    "--manifest",
    manifest,
    "--subject",
    subject,
    "--execution-profile",
    profile,
    "--baseline-kind",
    "without_skill",
    "--split",
    "development",
    "--workspace",
    workspace,
  ]);
  expectSuccess(result, "compile");
  return { workspace, subject, plan: JSON.parse(result.stdout) };
}

function executeWorkers(root, workspace) {
  const worker = makeFakeWorker(root);
  for (const arm of ["with_skill", "without_skill"]) {
    const result = run(node, [
      executor,
      "--workspace",
      workspace,
      "--assignment",
      join(workspace, "assignments", CASE_ID, arm, "repeat-1.json"),
      "--agent-bin",
      worker,
    ]);
    expectSuccess(result, `${arm} worker execution`);
  }
}

function judge({ workspace, judgeBin, answers, extraArgs = [], judgeDir }) {
  return run(
    node,
    [
      judgeRunner,
      "--workspace",
      workspace,
      "--agent-bin",
      judgeBin,
      "--pass-env",
      "FAKE_JUDGE_DIR",
      "--pass-env",
      "FAKE_JUDGE_ANSWERS",
      ...extraArgs,
    ],
    // FAKE_HOST_SECRET_TOKEN is deliberately NOT passed through --pass-env: the
    // blindness test asserts the judge never inherits it from the host.
    { env: { FAKE_JUDGE_DIR: judgeDir, FAKE_JUDGE_ANSWERS: answers, FAKE_HOST_SECRET_TOKEN: "leak-me" } },
  );
}

function grade(workspace) {
  const result = run(node, [
    runtime,
    "grade",
    "--plan",
    join(workspace, "execution-plan.json"),
    "--workspace",
    workspace,
  ]);
  expectSuccess(result, "grade");
  return JSON.parse(result.stdout);
}

function preparedRun(root) {
  const compiled = compileRun(root);
  executeWorkers(root, compiled.workspace);
  return { ...compiled, judgeBin: makeFakeJudge(root), judgeDir: join(root, "judge-calls") };
}

function judgeCalls(judgeDir) {
  return readdirSync(judgeDir)
    .filter((name) => name.startsWith("call-"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(judgeDir, name), "utf8")));
}

const judgmentArtifact = (workspace) => join(workspace, "cases", CASE_ID, "semantic/blind-quality.json");

describe("blind semantic judge runner", () => {
  it("writes a digest-bound, order-swapped judgment that grades as agreement", () => {
    fixture("skill-reviewer-judge-agreement-", (root) => {
      const { workspace, judgeBin, judgeDir, plan } = preparedRun(root);

      const result = judge({ workspace, judgeBin, judgeDir, answers: "A,B" });

      expectSuccess(result, "semantic judge");
      const summary = JSON.parse(result.stdout);
      expect(summary).toEqual(
        expect.objectContaining({
          contract: "skill-reviewer.semantic-judge-summary",
          run_id: plan.run_id,
          adapter_id: "anthropic.claude-code.stream-json",
          status: "completed",
          assertion_count: 1,
        }),
      );
      expect(summary.results).toEqual([
        expect.objectContaining({
          case: CASE_ID,
          assertion: "blind-quality",
          status: "agreement",
          preference: "candidate",
          judgments: [
            { mapping: { A: "with_skill", B: "without_skill" }, winner: "A" },
            { mapping: { A: "without_skill", B: "with_skill" }, winner: "B" },
          ],
        }),
      ]);

      const judgment = JSON.parse(readFileSync(judgmentArtifact(workspace), "utf8"));
      expect(judgment.contract).toBe("skill-reviewer.semantic-judgment");
      expect(judgment.blind).toBe(true);
      expect(judgment.binding).toEqual(
        expect.objectContaining({
          run_id: plan.run_id,
          case_id: CASE_ID,
          assertion_id: "blind-quality",
          authority_digest: plan.authority.digest,
          semantic_grader_contract_digest: plan.authority.semantic_grader_contract_digest,
          inputs: ["outputs/response.md"],
        }),
      );
      for (const arm of ["with_skill", "without_skill"]) {
        expect(judgment.binding.artifacts[arm][0].digests["outputs/response.md"]).toMatch(/^[a-f0-9]{64}$/);
        expect(judgment.binding.artifacts[arm][0].trace_event_ids["outputs/response.md"].length).toBeGreaterThan(0);
      }
      expect(judgment.judgments).toHaveLength(2);
      judgment.judgments.forEach((record, index) => {
        const artifactBase = join(workspace, "cases", CASE_ID);
        expect(record.provenance).toEqual(
          expect.objectContaining({
            judge_adapter_id: "anthropic.claude-code.stream-json",
            executable_path: realpathSync(judgeBin),
            agent_version: "2.1.215 (Claude Code)",
            model: "judge-model-1",
            prompt_artifact: `semantic/blind-quality/prompt-${index + 1}.md`,
            raw_output_artifact: `semantic/blind-quality/judgment-${index + 1}.log`,
            exit_code: 0,
            timed_out: false,
            usage_input_tokens: 40,
          }),
        );
        const rawOutput = readFileSync(join(artifactBase, record.provenance.raw_output_artifact));
        expect(record.provenance.raw_output_digest).toBe(
          createHash("sha256").update(rawOutput).digest("hex"),
        );
        const retainedPrompt = readFileSync(join(artifactBase, record.provenance.prompt_artifact));
        expect(record.provenance.prompt_artifact_digest).toBe(
          createHash("sha256").update(retainedPrompt).digest("hex"),
        );
      });
      expect(judgment.judge).toEqual(
        expect.objectContaining({
          contract: "skill-reviewer.semantic-judge-run",
          adapter_id: "anthropic.claude-code.stream-json",
          presentation: "anonymous-bundles-order-swapped",
          agent_version_policy: { observed: "2.1.215", canary_verified: "2.1.215", drifted: false },
        }),
      );

      const evidence = grade(workspace);
      expect(evidence.cases[0].semantic_assertions).toEqual([
        expect.objectContaining({
          id: "blind-quality",
          status: "agreement",
          passed: true,
          preference: "candidate",
          resolved_winners: ["with_skill", "with_skill"],
        }),
      ]);
      expect(evidence.limitations).not.toContain(`semantic evidence missing in case ${CASE_ID}`);
    });
  }, 60_000);

  it("records position bias as disagreement instead of a preference", () => {
    fixture("skill-reviewer-judge-bias-", (root) => {
      const { workspace, judgeBin, judgeDir } = preparedRun(root);

      const result = judge({ workspace, judgeBin, judgeDir, answers: "A,A" });

      expectSuccess(result, "semantic judge");
      const summary = JSON.parse(result.stdout);
      expect(summary.status).toBe("completed");
      expect(summary.results[0]).toEqual(
        expect.objectContaining({ status: "disagreement", preference: null }),
      );
      const evidence = grade(workspace);
      expect(evidence.cases[0].semantic_assertions[0]).toEqual(
        expect.objectContaining({
          status: "disagreement",
          passed: false,
          resolved_winners: ["with_skill", "without_skill"],
        }),
      );
      expect(evidence.limitations).toContain(`semantic judge disagreement in case ${CASE_ID}`);
    });
  }, 60_000);

  it("refuses to write a judgment when the judge does not end with A, B, or tie", () => {
    fixture("skill-reviewer-judge-malformed-", (root) => {
      const { workspace, judgeBin, judgeDir } = preparedRun(root);

      const result = judge({ workspace, judgeBin, judgeDir, answers: "A,MALFORMED" });

      expect(result.status).toBe(1);
      const summary = JSON.parse(result.stdout);
      expect(summary.status).toBe("incomplete");
      expect(summary.results[0]).toEqual(
        expect.objectContaining({
          status: "malformed",
          preference: null,
          reason: "judgment 2: judge did not end with exactly A, B, or tie",
        }),
      );
      expect(existsSync(judgmentArtifact(workspace))).toBe(false);
      const scratch = join(workspace, "cases", CASE_ID, "semantic/blind-quality");
      expect(existsSync(join(scratch, "judgment-1.log"))).toBe(true);
      expect(existsSync(join(scratch, "judgment-2.log"))).toBe(true);
      const evidence = grade(workspace);
      expect(evidence.cases[0].semantic_assertions[0]).toEqual(
        expect.objectContaining({ status: "missing", passed: false }),
      );
      expect(evidence.limitations).toContain(`semantic evidence missing in case ${CASE_ID}`);
    });
  }, 60_000);

  it("treats a crashed judge process as malformed evidence", () => {
    fixture("skill-reviewer-judge-crash-", (root) => {
      const { workspace, judgeBin, judgeDir } = preparedRun(root);

      const result = judge({ workspace, judgeBin, judgeDir, answers: "CRASH" });

      expect(result.status).toBe(1);
      const summary = JSON.parse(result.stdout);
      expect(summary.results[0].status).toBe("malformed");
      expect(summary.results[0].reason).toBe("judgment 1: judge exited with status 3");
      expect(existsSync(judgmentArtifact(workspace))).toBe(false);
      expect(
        readFileSync(join(workspace, "cases", CASE_ID, "semantic/blind-quality/judgment-1.stderr.log"), "utf8"),
      ).toContain("judge crashed");
    });
  }, 60_000);

  it("keeps the judge blind: no arm names, arm vocabulary, case id, or package paths in the prompt", () => {
    fixture("skill-reviewer-judge-blind-", (root) => {
      const { workspace, subject, judgeBin, judgeDir } = preparedRun(root);

      expectSuccess(judge({ workspace, judgeBin, judgeDir, answers: "tie,tie" }), "semantic judge");

      const calls = judgeCalls(judgeDir);
      expect(calls).toHaveLength(2);
      const prompts = calls.map((call) => call.args.at(-1));
      for (const [index, prompt] of prompts.entries()) {
        for (const forbidden of [
          "with_skill",
          "without_skill",
          "old_skill",
          "candidate",
          "baseline",
          "候选",
          "旧版",
          CASE_ID,
          subject,
          workspace,
          "execution-plan",
          "SKILL.md",
        ]) {
          expect(prompt, `judgment ${index + 1} prompt leaks ${forbidden}`).not.toContain(forbidden);
        }
        expect(prompt).toContain(RUBRIC);
        expect(prompt).toContain("=== 集合 A ===");
        expect(prompt).toContain("=== 集合 B ===");
        expect(prompt).toContain("<<<BEGIN A sample-1 outputs/response.md>>>");
        expect(prompt).toContain("PASS");
      }
      expect(prompts[0]).not.toBe(prompts[1]);
      const [first, second] = prompts;
      const bundleA = (prompt) => prompt.slice(prompt.indexOf("=== 集合 A ==="), prompt.indexOf("=== 集合 B ==="));
      expect(bundleA(first)).toContain("verified against the locked snapshot");
      expect(bundleA(second)).not.toContain("verified against the locked snapshot");
      for (const call of calls) {
        expect(call.args).toEqual(
          expect.arrayContaining([
            "--print",
            "--output-format",
            "json",
            "--safe-mode",
            "--tools",
            "",
            "--strict-mcp-config",
          ]),
        );
        expect(call.args).not.toContain("--add-dir");
        expect(call.env).not.toContain("FAKE_HOST_SECRET_TOKEN");
      }
      const summary = JSON.parse(readFileSync(judgmentArtifact(workspace), "utf8"));
      expect(summary.judgments.map((record) => record.winner)).toEqual(["tie", "tie"]);
      const evidence = grade(workspace);
      expect(evidence.cases[0].semantic_assertions[0]).toEqual(
        expect.objectContaining({ status: "agreement", preference: "tie" }),
      );
    });
  }, 60_000);

  it("reports stale evidence when an input artifact changes after judging", () => {
    fixture("skill-reviewer-judge-stale-", (root) => {
      const { workspace, judgeBin, judgeDir } = preparedRun(root);
      expectSuccess(judge({ workspace, judgeBin, judgeDir, answers: "A,B" }), "semantic judge");

      const response = join(workspace, "cases", CASE_ID, "with_skill/repeat-1/outputs/response.md");
      chmodSync(response, 0o600);
      writeFileSync(response, "PASS — edited after the judge ran.\n", "utf8");

      const evidence = grade(workspace);
      expect(evidence.cases[0].semantic_assertions[0]).toEqual(
        expect.objectContaining({ status: "stale", passed: false }),
      );
      expect(evidence.limitations).toContain(`semantic evidence binding is stale in case ${CASE_ID}`);
    });
  }, 60_000);

  it("skips an assertion whose declared inputs are missing and writes nothing", () => {
    fixture("skill-reviewer-judge-missing-input-", (root) => {
      const { workspace, judgeBin, judgeDir } = preparedRun(root);
      const response = join(workspace, "cases", CASE_ID, "without_skill/repeat-1/outputs/response.md");
      rmSync(response, { force: true });

      const result = judge({ workspace, judgeBin, judgeDir, answers: "A,B" });

      expect(result.status).toBe(1);
      const summary = JSON.parse(result.stdout);
      expect(summary.results[0]).toEqual(
        expect.objectContaining({
          status: "skipped",
          reason: "declared input artifacts are missing: without_skill/repeat-1/outputs/response.md",
        }),
      );
      expect(existsSync(judgeDir)).toBe(false);
      expect(existsSync(judgmentArtifact(workspace))).toBe(false);
    });
  }, 60_000);

  it("refuses to judge bundles that would reveal arm identity", () => {
    fixture("skill-reviewer-judge-leak-", (root) => {
      const { workspace, judgeBin, judgeDir } = preparedRun(root);
      const response = join(workspace, "cases", CASE_ID, "with_skill/repeat-1/outputs/response.md");
      chmodSync(response, 0o600);
      writeFileSync(response, "PASS (written by the with_skill arm)\n", "utf8");

      const result = judge({ workspace, judgeBin, judgeDir, answers: "A,B" });

      expect(result.status).toBe(1);
      const summary = JSON.parse(result.stdout);
      expect(summary.results[0].status).toBe("skipped");
      expect(summary.results[0].reason).toContain("would reveal arm identity");
      expect(existsSync(judgeDir)).toBe(false);
      expect(existsSync(judgmentArtifact(workspace))).toBe(false);
    });
  }, 60_000);

  it("rejects unknown cases, bad limits, and unpinned judge versions before spawning a judge", () => {
    fixture("skill-reviewer-judge-preflight-", (root) => {
      const { workspace, judgeBin, judgeDir } = preparedRun(root);
      const unknownCase = judge({ workspace, judgeBin, judgeDir, answers: "A,B", extraArgs: ["--case", "nope"] });
      expect(unknownCase.status).toBe(2);
      expect(unknownCase.stderr).toContain("--case nope is not part of the locked plan");

      const badTimeout = judge({ workspace, judgeBin, judgeDir, answers: "A,B", extraArgs: ["--timeout-seconds", "0"] });
      expect(badTimeout.status).toBe(2);
      expect(badTimeout.stderr).toContain("--timeout-seconds must be a positive integer");

      const drifted = write(
        root,
        "drifted-judge.mjs",
        '#!/usr/bin/env node\nprocess.stdout.write("9.9.9 (Claude Code)\\n");\n',
      );
      chmodSync(drifted, 0o755);
      const versionMismatch = judge({ workspace, judgeBin: drifted, judgeDir, answers: "A,B" });
      expect(versionMismatch.status).toBe(2);
      expect(versionMismatch.stderr).toContain("does not satisfy the adapter version policy");
      expect(existsSync(judgeDir)).toBe(false);
    });
  }, 60_000);

  it("drives a sandboxed exec judge with ambient skills disabled and a read-only sandbox", () => {
    fixture("skill-reviewer-judge-sandbox-", (root) => {
      const { workspace, judgeDir } = preparedRun(root);
      const sandboxJudge = makeFakeSandboxJudge(root);

      const result = judge({
        workspace,
        judgeBin: sandboxJudge,
        judgeDir,
        answers: "B,A",
        extraArgs: ["--adapter", "openai.codex-cli.exec-jsonl"],
      });

      expectSuccess(result, "sandboxed semantic judge");
      const summary = JSON.parse(result.stdout);
      expect(summary.adapter_id).toBe("openai.codex-cli.exec-jsonl");
      expect(summary.results[0]).toEqual(
        expect.objectContaining({ status: "agreement", preference: "baseline" }),
      );
      const calls = judgeCalls(judgeDir);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.args).toEqual(
          expect.arrayContaining(["--sandbox", "read-only", "--ask-for-approval", "never", "exec", "--json", "--ephemeral"]),
        );
        expect(call.args.some((arg) => arg.startsWith("skills.config=") && arg.includes("enabled=false"))).toBe(true);
        const prompt = call.args.at(-1);
        expect(prompt).not.toContain("with_skill");
        expect(prompt).not.toContain("without_skill");
      }
      const judgment = JSON.parse(readFileSync(judgmentArtifact(workspace), "utf8"));
      expect(judgment.judgments[0].provenance).toEqual(
        expect.objectContaining({
          judge_adapter_id: "openai.codex-cli.exec-jsonl",
          agent_version: "codex-cli 0.144.5",
          isolation: expect.objectContaining({ sandbox_mode: "read-only", ambient_skills_disabled: 1 }),
          usage_input_tokens: 30,
        }),
      );
      const evidence = grade(workspace);
      expect(evidence.cases[0].semantic_assertions[0]).toEqual(
        expect.objectContaining({ status: "agreement", preference: "baseline" }),
      );
    });
  }, 60_000);
  it("removes an earlier judgment before re-judging so a failed re-run cannot leave stale evidence", () => {
    fixture("skill-reviewer-judge-rerun-", (root) => {
      const { workspace, judgeBin, judgeDir } = preparedRun(root);

      expectSuccess(judge({ workspace, judgeBin, judgeDir, answers: "A,B" }), "first semantic judge");
      expect(existsSync(judgmentArtifact(workspace))).toBe(true);

      const rerun = judge({ workspace, judgeBin, judgeDir: join(root, "judge-rerun"), answers: "A,MALFORMED" });

      expect(rerun.status).toBe(1);
      expect(JSON.parse(rerun.stdout).results[0].status).toBe("malformed");
      expect(existsSync(judgmentArtifact(workspace))).toBe(false);
      const evidence = grade(workspace);
      expect(evidence.cases[0].semantic_assertions[0]).toEqual(
        expect.objectContaining({ status: "missing", passed: false }),
      );
    });
  }, 60_000);

  it("refuses a sandboxed judge that used a tool, even when its final line is a valid verdict", () => {
    fixture("skill-reviewer-judge-tool-", (root) => {
      const { workspace, judgeDir } = preparedRun(root);
      const sandboxJudge = makeFakeSandboxJudge(root);

      const result = judge({
        workspace,
        judgeBin: sandboxJudge,
        judgeDir,
        answers: "TOOL,A",
        extraArgs: ["--adapter", "openai.codex-cli.exec-jsonl"],
      });

      expect(result.status).toBe(1);
      const summary = JSON.parse(result.stdout);
      expect(summary.results[0]).toEqual(
        expect.objectContaining({
          status: "malformed",
          preference: null,
          reason: "judgment 1: judge used a tool (command_execution); blind judgment refused",
        }),
      );
      expect(existsSync(judgmentArtifact(workspace))).toBe(false);
    });
  }, 60_000);
  it("records in-range judge version drift and grades it as a limitation", () => {
    fixture("skill-reviewer-judge-drift-", (root) => {
      const { workspace, judgeBin, judgeDir } = preparedRun(root);
      const driftedJudge = join(root, "drifted-fake-judge.mjs");
      writeFileSync(driftedJudge, readFileSync(judgeBin, "utf8").replace("2.1.215 (Claude Code)", "2.1.273 (Claude Code)"));
      chmodSync(driftedJudge, 0o755);

      expectSuccess(judge({ workspace, judgeBin: driftedJudge, judgeDir, answers: "A,B" }), "drifted semantic judge");

      const judgment = JSON.parse(readFileSync(judgmentArtifact(workspace), "utf8"));
      expect(judgment.judge.agent_version_policy).toEqual({ observed: "2.1.273", canary_verified: "2.1.215", drifted: true });
      const evidence = grade(workspace);
      expect(evidence.cases[0].semantic_assertions[0]).toEqual(
        expect.objectContaining({
          status: "agreement",
          judge_version_drift: { observed: "2.1.273", canary_verified: "2.1.215", adapter: "anthropic.claude-code.stream-json" },
        }),
      );
      expect(evidence.limitations).toContain(
        `semantic judge version 2.1.273 differs from canary-verified 2.1.215 for adapter anthropic.claude-code.stream-json in case ${CASE_ID}`,
      );
    });
  }, 60_000);

  it("invalidates a judgment whose retained provenance was removed or replaced", () => {
    fixture("skill-reviewer-judge-provenance-", (root) => {
      const { workspace, judgeBin, judgeDir } = preparedRun(root);
      expectSuccess(judge({ workspace, judgeBin, judgeDir, answers: "A,B" }), "semantic judge");
      const scratch = join(workspace, "cases", CASE_ID, "semantic/blind-quality");

      writeFileSync(join(scratch, "judgment-1.log"), "edited after judging\n");
      expect(grade(workspace).cases[0].semantic_assertions[0]).toEqual(
        expect.objectContaining({ status: "invalid", reason: "semantic judgment 1 retained raw_output_artifact does not match its recorded digest" }),
      );

      rmSync(join(scratch, "prompt-2.md"));
      const evidence = grade(workspace);
      expect(evidence.cases[0].semantic_assertions[0].status).toBe("invalid");
      expect(evidence.limitations).toContain(`semantic evidence invalid in case ${CASE_ID}`);

      const handcrafted = JSON.parse(readFileSync(judgmentArtifact(workspace), "utf8"));
      delete handcrafted.judge;
      writeFileSync(judgmentArtifact(workspace), JSON.stringify(handcrafted));
      expect(grade(workspace).cases[0].semantic_assertions[0]).toEqual(
        expect.objectContaining({ status: "invalid", reason: "semantic judgment lacks judge-run provenance" }),
      );
    });
  }, 60_000);
});

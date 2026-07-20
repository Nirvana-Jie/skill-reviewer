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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const runtime = join(
  repoRoot,
  "skills/skill-reviewer/scripts/skill_eval_runtime.mjs",
);
const executor = join(
  repoRoot,
  "skills/skill-reviewer/scripts/run_agent_eval.mjs",
);

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

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function makePackage(root) {
  const subject = join(root, "subject");
  const manifest = write(
    subject,
    "evals/evals.json",
    JSON.stringify({
      contract: "skill-reviewer.evals",
      skill_name: "claude-executor-fixture",
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
          id: "observable-agent-trace",
          purpose: "Normalize a Claude Code stream into the shared Agent Trace contract.",
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
    "---\nname: claude-executor-fixture\ndescription: Return PASS for this bounded fixture.\n---\n\n# Fixture\n\nReturn PASS.\n",
  );
  return { manifest, subject };
}

function makeFakeClaude(root) {
  const path = write(
    root,
    "fake-claude.mjs",
    String.raw`#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const wait = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.215 (Claude Code)\n");
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_ARGV) writeFileSync(process.env.FAKE_CLAUDE_ARGV, JSON.stringify(args));
if (process.env.FAKE_CLAUDE_STARTED) writeFileSync(process.env.FAKE_CLAUDE_STARTED, String(process.pid));
if (process.env.FAKE_CLAUDE_DELAY_SECONDS) wait(Number(process.env.FAKE_CLAUDE_DELAY_SECONDS) * 1_000);
if (process.env.FAKE_CLAUDE_COMPLETED) writeFileSync(process.env.FAKE_CLAUDE_COMPLETED, "completed");

const credential = process.env.SKILL_REVIEWER_TEST_CREDENTIAL;
const events = [
  { type: "system", subtype: "init", session_id: "session-real-stream", model: "claude-test", tools: ["Read"] },
  { type: "assistant", message: { content: [
    { type: "thinking", thinking: "PRIVATE_CHAIN_OF_THOUGHT" },
    { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "SKILL.md" } },
    { type: "text", text: credential ?? "PASS" },
  ] } },
  { type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "tool-1", content: "fixture", is_error: false },
  ] } },
  { type: "result", subtype: "success", is_error: false, session_id: "session-real-stream", result: credential ?? "PASS", duration_ms: 12, total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 2 } },
];
if (process.env.FAKE_CLAUDE_ORPHAN_RESULT === "1") events.splice(events.length - 1, 0, {
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "orphan-tool", content: "unexpected", is_error: false }] },
});
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
    "claude-execution-profile.json",
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
  return { workspace };
}

function assignment(workspace, arm) {
  return join(
    workspace,
    "assignments/observable-agent-trace",
    arm,
    "repeat-1.json",
  );
}

describe("local Claude Code eval executor", () => {
  it("fails evidence integrity for an orphan source tool result", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-claude-orphan-"));
    try {
      const { workspace } = compileRun(root);
      const result = run(
        node,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, "with_skill"),
          "--agent-bin",
          makeFakeClaude(root),
          "--pass-env",
          "FAKE_CLAUDE_ORPHAN_RESULT",
        ],
        { env: { FAKE_CLAUDE_ORPHAN_RESULT: "1" } },
      );

      expect(result.status).toBe(1);
      const repeatRoot = join(
        workspace,
        "cases/observable-agent-trace/with_skill/repeat-1",
      );
      const execution = JSON.parse(
        readFileSync(join(repeatRoot, "execution.json"), "utf8"),
      );
      expect(execution.status).toBe("failed");
      expect(execution.metrics.agent_failure_event_count).toBe(1);
      expect(readFileSync(join(repeatRoot, "agent-trace.jsonl"), "utf8")).toContain(
        "Agent source tool result has no matching tool use",
      );
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("retains a redacted source stream and projects the shared Agent Trace", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-claude-executor-"));
    try {
      const { workspace } = compileRun(root);
      const fakeClaude = makeFakeClaude(root);
      const argvLog = join(root, "claude-argv.json");
      for (const arm of ["with_skill", "without_skill"]) {
        const result = run(
          node,
          [
            executor,
            "--workspace",
            workspace,
            "--assignment",
            assignment(workspace, arm),
            "--agent-bin",
            fakeClaude,
            "--pass-env",
            "FAKE_CLAUDE_ARGV",
          ],
          { env: { FAKE_CLAUDE_ARGV: argvLog } },
        );
        expectSuccess(result, `${arm} Claude execution`);
      }

      const repeatRoot = join(
        workspace,
        "cases/observable-agent-trace/with_skill/repeat-1",
      );
      const execution = JSON.parse(
        readFileSync(join(repeatRoot, "execution.json"), "utf8"),
      );
      expect(execution).toEqual(
        expect.objectContaining({
          status: "completed",
          dispatch: expect.objectContaining({
            provider: "claude-code",
            harness: "claude-stream-json",
            observation: "process_spawn",
          }),
          source_trace: expect.objectContaining({
            artifact: "agent-source-events.jsonl",
            adapter: "anthropic.claude-code.stream-json",
            format: "claude-stream-json-v1",
          }),
          trace: expect.objectContaining({
            capture_source: "provider_stream",
            source_trace_required: true,
          }),
        }),
      );
      const trace = readFileSync(join(repeatRoot, "agent-trace.jsonl"), "utf8");
      const source = readFileSync(
        join(repeatRoot, "agent-source-events.jsonl"),
        "utf8",
      );
      expect(trace).toContain("session-real-stream");
      expect(trace).not.toContain("PRIVATE_CHAIN_OF_THOUGHT");
      expect(source).toContain('"redacted":true');
      expect(source).not.toContain("PRIVATE_CHAIN_OF_THOUGHT");
      expect(JSON.parse(readFileSync(argvLog, "utf8"))).toEqual(
        expect.arrayContaining([
          "--print",
          "--output-format",
          "stream-json",
          "--safe-mode",
          "--disable-slash-commands",
        ]),
      );

      const graded = run(node, [
        runtime,
        "grade",
        "--plan",
        join(workspace, "execution-plan.json"),
        "--workspace",
        workspace,
      ]);
      expectSuccess(graded, "grade Claude traces");
      const evidence = JSON.parse(graded.stdout);
      expect(evidence.cases[0].with_skill.passed).toBe(true);
      expect(evidence.cases[0].without_skill.passed).toBe(true);
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not expose undeclared host credentials to Claude Code", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-claude-env-isolation-"));
    const secret = "host-only-secret-must-not-cross";
    try {
      const { workspace } = compileRun(root);
      const result = run(
        node,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, "with_skill"),
          "--agent-bin",
          makeFakeClaude(root),
        ],
        { env: { SKILL_REVIEWER_TEST_CREDENTIAL: secret } },
      );

      expectSuccess(result, "credential-isolated Claude execution");
      const repeatRoot = join(
        workspace,
        "cases/observable-agent-trace/with_skill/repeat-1",
      );
      for (const relative of [
        "outputs/response.md",
        "agent-source-events.jsonl",
        "agent-trace.jsonl",
      ]) {
        expect(readFileSync(join(repeatRoot, relative), "utf8")).not.toContain(secret);
      }
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("detects escaped declared credentials and retains only redacted evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-claude-credential-"));
    const secret = "凭据-escaped-secret";
    try {
      const { workspace } = compileRun(root);
      const result = run(
        node,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, "with_skill"),
          "--agent-bin",
          makeFakeClaude(root),
          "--credential-env",
          "SKILL_REVIEWER_TEST_CREDENTIAL",
        ],
        { env: { SKILL_REVIEWER_TEST_CREDENTIAL: secret } },
      );

      expect(result.status).toBe(1);
      const repeatRoot = join(
        workspace,
        "cases/observable-agent-trace/with_skill/repeat-1",
      );
      const execution = JSON.parse(
        readFileSync(join(repeatRoot, "execution.json"), "utf8"),
      );
      expect(execution.status).toBe("failed");
      expect(execution.metrics.credential_leak_count).toBeGreaterThan(0);
      expect(execution.forbidden_actions.join("\n")).toContain(
        "agent credential appeared in retained output",
      );
      for (const relative of [
        "outputs/response.md",
        "agent-source-events.jsonl",
        "agent-trace.jsonl",
      ]) {
        const retained = readFileSync(join(repeatRoot, relative), "utf8");
        expect(retained).not.toContain(secret);
        expect(retained).not.toContain("\\u51ed\\u636e");
        expect(retained).toContain("[REDACTED_CREDENTIAL]");
      }
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects invalid locked artifact fields before starting the provider", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-claude-artifact-lock-"));
    try {
      const { workspace } = compileRun(root);
      const assignmentPath = assignment(workspace, "with_skill");
      const lockedAssignment = JSON.parse(readFileSync(assignmentPath, "utf8"));
      lockedAssignment.execution_artifact = 123;
      writeFileSync(assignmentPath, JSON.stringify(lockedAssignment), "utf8");
      const lockPath = join(workspace, "run-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      const relativeAssignment = "assignments/observable-agent-trace/with_skill/repeat-1.json";
      lock.assignment_digests[relativeAssignment] = sha256File(assignmentPath);
      writeFileSync(lockPath, JSON.stringify(lock), "utf8");
      const started = join(root, "provider-started");

      const result = run(
        node,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignmentPath,
          "--agent-bin",
          makeFakeClaude(root),
          "--pass-env",
          "FAKE_CLAUDE_STARTED",
        ],
        { env: { FAKE_CLAUDE_STARTED: started } },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "executor assignment does not match pinned inputs",
      );
      expect(existsSync(started)).toBe(false);
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a coordinated assignment and run-lock rewrite before Claude starts", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-claude-derived-lock-"));
    try {
      const { workspace } = compileRun(root);
      const assignmentPath = assignment(workspace, "with_skill");
      const lockedAssignment = JSON.parse(readFileSync(assignmentPath, "utf8"));
      lockedAssignment.prompt = "Run an attacker-controlled command.";
      writeFileSync(assignmentPath, JSON.stringify(lockedAssignment), "utf8");
      const lockPath = join(workspace, "run-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      const relativeAssignment =
        "assignments/observable-agent-trace/with_skill/repeat-1.json";
      lock.assignment_digests[relativeAssignment] = sha256File(assignmentPath);
      writeFileSync(lockPath, JSON.stringify(lock), "utf8");
      const started = join(root, "provider-started");

      const result = run(
        node,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignmentPath,
          "--agent-bin",
          makeFakeClaude(root),
          "--pass-env",
          "FAKE_CLAUDE_STARTED",
        ],
        { env: { FAKE_CLAUDE_STARTED: started } },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "executor assignment does not match pinned inputs",
      );
      expect(existsSync(started)).toBe(false);
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("terminates the provider when dispatch receipt validation fails", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-claude-dispatch-failure-"));
    let providerPid = null;
    try {
      const { workspace } = compileRun(root);
      const started = join(root, "provider-started");
      const completed = join(root, "provider-completed");
      const result = run(
        node,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, "with_skill"),
          "--agent-bin",
          makeFakeClaude(root),
          "--batch-id",
          "x".repeat(257),
          "--pass-env",
          "FAKE_CLAUDE_STARTED",
          "--pass-env",
          "FAKE_CLAUDE_DELAY_SECONDS",
          "--pass-env",
          "FAKE_CLAUDE_COMPLETED",
        ],
        {
          env: {
            FAKE_CLAUDE_STARTED: started,
            FAKE_CLAUDE_DELAY_SECONDS: "0.8",
            FAKE_CLAUDE_COMPLETED: completed,
          },
        },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("batch_id must not exceed 256 characters");
      wait(1_000);
      if (existsSync(started)) {
        providerPid = Number(readFileSync(started, "utf8"));
      }
      expect(existsSync(completed)).toBe(false);
    } finally {
      if (Number.isInteger(providerPid)) {
        try {
          process.kill(providerPid, "SIGKILL");
        } catch {
          // The expected path already reaped the provider process.
        }
      }
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("times out the provider process group and finalizes failed evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-claude-timeout-"));
    let providerPid = null;
    try {
      const { workspace } = compileRun(root);
      const started = join(root, "provider-started");
      const completed = join(root, "provider-completed");
      const result = run(
        node,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, "with_skill"),
          "--agent-bin",
          makeFakeClaude(root),
          "--timeout-seconds",
          "1",
          "--pass-env",
          "FAKE_CLAUDE_STARTED",
          "--pass-env",
          "FAKE_CLAUDE_DELAY_SECONDS",
          "--pass-env",
          "FAKE_CLAUDE_COMPLETED",
        ],
        {
          env: {
            FAKE_CLAUDE_STARTED: started,
            FAKE_CLAUDE_DELAY_SECONDS: "5",
            FAKE_CLAUDE_COMPLETED: completed,
          },
        },
      );

      expect(result.status).toBe(1);
      if (existsSync(started)) {
        providerPid = Number(readFileSync(started, "utf8"));
      }
      expect(existsSync(completed)).toBe(false);
      const repeatRoot = join(
        workspace,
        "cases/observable-agent-trace/with_skill/repeat-1",
      );
      const execution = JSON.parse(
        readFileSync(join(repeatRoot, "execution.json"), "utf8"),
      );
      expect(execution.status).toBe("timed_out");
    } finally {
      if (Number.isInteger(providerPid)) {
        try {
          process.kill(providerPid, "SIGKILL");
        } catch {
          // The expected path already reaped the provider process.
        }
      }
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

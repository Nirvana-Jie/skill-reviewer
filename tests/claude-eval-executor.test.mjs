import { spawnSync } from "node:child_process";
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
const python = process.env.PYTHON ?? "python3";
const runtime = join(
  repoRoot,
  "skills/skill-reviewer/scripts/skill_eval_runtime.py",
);
const executor = join(
  repoRoot,
  "skills/skill-reviewer/scripts/run_claude_eval_executor.py",
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
    "fake-claude.py",
    String.raw`#!/usr/bin/env python3
import json
import os
import pathlib
import sys

args = sys.argv[1:]
if args == ["--version"]:
    print("2.1.test (Claude Code)")
    raise SystemExit(0)

if os.environ.get("FAKE_CLAUDE_ARGV"):
    pathlib.Path(os.environ["FAKE_CLAUDE_ARGV"]).write_text(json.dumps(args), encoding="utf-8")

events = [
    {"type": "system", "subtype": "init", "session_id": "session-real-stream", "model": "claude-test", "tools": ["Read"]},
    {"type": "assistant", "message": {"content": [
        {"type": "thinking", "thinking": "PRIVATE_CHAIN_OF_THOUGHT"},
        {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {"file_path": "SKILL.md"}},
        {"type": "text", "text": "PASS"}
    ]}},
    {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "tool-1", "content": "fixture", "is_error": False}
    ]}},
    {"type": "result", "subtype": "success", "is_error": False, "session_id": "session-real-stream", "result": "PASS", "duration_ms": 12, "total_cost_usd": 0.001, "usage": {"input_tokens": 10, "output_tokens": 2}}
]
for event in events:
    print(json.dumps(event), flush=True)
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
  const result = run(python, [
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
  it("retains a redacted source stream and projects the shared Agent Trace", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-claude-executor-"));
    try {
      const { workspace } = compileRun(root);
      const fakeClaude = makeFakeClaude(root);
      const argvLog = join(root, "claude-argv.json");
      for (const arm of ["with_skill", "without_skill"]) {
        const result = run(
          python,
          [
            executor,
            "--workspace",
            workspace,
            "--assignment",
            assignment(workspace, arm),
            "--claude-bin",
            fakeClaude,
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
            adapter: "claude-code",
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

      const graded = run(python, [
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
});

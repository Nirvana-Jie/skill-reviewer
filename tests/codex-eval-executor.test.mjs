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
const runtime = join(
  repoRoot,
  "skills",
  "skill-reviewer",
  "scripts",
  "skill_eval_runtime.py",
);
const executor = join(
  repoRoot,
  "skills",
  "skill-reviewer",
  "scripts",
  "run_codex_eval_executor.py",
);
const python = process.env.PYTHON ?? "python3";

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
      skill_name: "codex-executor-fixture",
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
          id: "observable-cli-trace",
          purpose: "Bind one Codex CLI execution to observable JSONL evidence.",
          split: "development",
          prompt: "Return PASS after reading the assigned configuration.",
          files: [],
          determinism: "deterministic",
          assertions: [
            {
              id: "response-exists",
              type: "file_exists",
              artifact: "outputs/response.md",
              severity: "must_pass",
            },
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
    "---\nname: codex-executor-fixture\ndescription: Return a concise PASS marker for the assigned task.\n---\n\n# Fixture\n\nReturn PASS.\n",
  );
  return { manifest, subject };
}

function makeFakeCodex(root) {
  const path = write(
    root,
    "fake-codex.py",
    String.raw`#!/usr/bin/env python3
import json
import os
import pathlib
import sys

args = sys.argv[1:]
if args == ["--version"]:
    print("codex-cli 0.test")
    raise SystemExit(0)

if args[:2] == ["debug", "prompt-input"]:
    disabled = any("skills.config=" in arg and "enabled=false" in arg for arg in args)
    text = "skills disabled"
    if not disabled:
        tick = chr(96)
        text = f"""<skills_instructions>
### Skill roots
- {tick}r0{tick} = {tick}/tmp/codex-ambient-skills{tick}
### Available skills
- ambient-fixture: Must never reach an eval arm. (file: r0/ambient-fixture/SKILL.md)
</skills_instructions>"""
    print(json.dumps([{"role": "developer", "content": [{"type": "input_text", "text": text}]}]))
    raise SystemExit(0)

argv_log = os.environ.get("FAKE_CODEX_ARGV")
if argv_log:
    pathlib.Path(argv_log).write_text(json.dumps(args, ensure_ascii=False), encoding="utf-8")
output_index = args.index("--output-last-message") + 1
output = pathlib.Path(args[output_index])
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text("PASS\n", encoding="utf-8")
events = [
    {"type": "thread.started", "thread_id": "thread-real-jsonl"},
    {"type": "turn.started"},
    {"type": "item.completed", "item": {"id": "reason-1", "type": "reasoning", "text": "PRIVATE_CHAIN_OF_THOUGHT"}},
    {"type": "item.started", "item": {"id": "cmd-1", "type": "command_execution", "command": "/bin/zsh -lc 'printf PASS'", "status": "in_progress"}},
    {"type": "item.completed", "item": {"id": "cmd-1", "type": "command_execution", "command": "/bin/zsh -lc 'printf PASS'", "aggregated_output": "PASS", "exit_code": 0, "status": "completed"}},
    {"type": "item.completed", "item": {"id": "msg-1", "type": "agent_message", "text": "PASS"}},
    {"type": "turn.completed", "usage": {"input_tokens": 21, "cached_input_tokens": 3, "output_tokens": 2}},
]
for event in events:
    print(json.dumps(event), flush=True)
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function compileRun({ root, profileOverrides = {} }) {
  const { manifest, subject } = makePackage(root);
  const workspace = join(root, "run");
  const profile = write(
    root,
    "codex-execution-profile.json",
    JSON.stringify({
      target: "codex-cli",
      harness: "codex-exec-jsonl",
      capabilities: [
        "filesystem-read",
        "filesystem-write",
        "shell",
        "jsonl-agent-events",
        "danger-full-access",
      ],
      isolation: "local-unattested",
      sampling: { mode: "codex-default", paired: true },
      ...profileOverrides,
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
  return { plan: JSON.parse(result.stdout), workspace };
}

function assignment(workspace, arm) {
  return join(
    workspace,
    "assignments",
    "observable-cli-trace",
    arm,
    "repeat-1.json",
  );
}

describe("local Codex eval executor", () => {
  it("isolates ambient skills and retains observable full-access JSONL trace", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-codex-executor-"));
    try {
      const { workspace } = compileRun({ root });
      const fakeCodex = makeFakeCodex(root);
      const argvLog = join(root, "codex-argv.json");
      const candidate = run(
        python,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, "with_skill"),
          "--codex-bin",
          fakeCodex,
          "--full-access",
        ],
        { env: { FAKE_CODEX_ARGV: argvLog } },
      );
      expectSuccess(candidate, "candidate Codex execution");

      const argv = JSON.parse(readFileSync(argvLog, "utf8"));
      expect(argv.indexOf("--sandbox")).toBeLessThan(argv.indexOf("exec"));
      expect(argv.slice(argv.indexOf("--sandbox"), argv.indexOf("--sandbox") + 2)).toEqual([
        "--sandbox",
        "danger-full-access",
      ]);
      expect(argv.slice(argv.indexOf("--ask-for-approval"), argv.indexOf("--ask-for-approval") + 2)).toEqual([
        "--ask-for-approval",
        "never",
      ]);
      expect(argv).toContain("--ignore-user-config");
      expect(argv).toContain("--skip-git-repo-check");
      expect(argv.find((value) => value.startsWith("skills.config="))).toContain(
        "/tmp/codex-ambient-skills/ambient-fixture/SKILL.md",
      );
      expect(argv.at(-1)).toContain("候选版 Skill");

      const repeatRoot = join(
        workspace,
        "cases",
        "observable-cli-trace",
        "with_skill",
        "repeat-1",
      );
      const execution = JSON.parse(readFileSync(join(repeatRoot, "execution.json"), "utf8"));
      expect(execution).toEqual(
        expect.objectContaining({
          status: "completed",
          forbidden_actions: [],
          side_effects: [],
          trace: expect.objectContaining({ capture_source: "codex_cli_jsonl", complete: true }),
          metrics: expect.objectContaining({
            full_access_enabled: 1,
            ambient_skills_disabled: 1,
            usage_input_tokens: 21,
          }),
        }),
      );
      const trace = readFileSync(join(repeatRoot, "agent-trace.jsonl"), "utf8");
      expect(trace).toContain("/bin/zsh -lc 'printf PASS'");
      expect(trace).toContain("thread-real-jsonl");
      expect(trace).not.toContain("PRIVATE_CHAIN_OF_THOUGHT");
      const observableWire = readFileSync(join(repeatRoot, "codex-events.jsonl"), "utf8");
      expect(observableWire).toContain('"redacted":true');
      expect(observableWire).not.toContain("PRIVATE_CHAIN_OF_THOUGHT");

      const baseline = run(
        python,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, "without_skill"),
          "--codex-bin",
          fakeCodex,
          "--full-access",
        ],
        { env: { FAKE_CODEX_ARGV: argvLog } },
      );
      expectSuccess(baseline, "baseline Codex execution");
      expect(JSON.parse(readFileSync(argvLog, "utf8")).at(-1)).toContain("未使用 Skill");

      const graded = run(python, [
        runtime,
        "grade",
        "--plan",
        join(workspace, "execution-plan.json"),
        "--workspace",
        workspace,
      ]);
      expectSuccess(graded, "grade real Codex traces");
      const evidence = JSON.parse(graded.stdout);
      expect(
        evidence.cases[0].with_skill.passed,
        JSON.stringify(evidence.cases[0].with_skill, null, 2),
      ).toBe(true);
      expect(
        evidence.cases[0].without_skill.passed,
        JSON.stringify(evidence.cases[0].without_skill, null, 2),
      ).toBe(true);
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("blocks execution when the locked profile overstates local isolation", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-codex-profile-"));
    try {
      const { workspace } = compileRun({
        root,
        profileOverrides: { isolation: "trusted-orchestrator" },
      });
      const result = run(python, [
        executor,
        "--workspace",
        workspace,
        "--assignment",
        assignment(workspace, "with_skill"),
        "--codex-bin",
        makeFakeCodex(root),
        "--full-access",
      ]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("isolation=local-unattested");
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

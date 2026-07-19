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
const planExecutor = join(
  repoRoot,
  "skills",
  "skill-reviewer",
  "scripts",
  "run_codex_eval_plan.py",
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
import time

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

barrier_dir = os.environ.get("FAKE_CODEX_BARRIER_DIR")
if barrier_dir:
    barrier = pathlib.Path(barrier_dir)
    barrier.mkdir(parents=True, exist_ok=True)
    arm = pathlib.Path.cwd().parent.name
    (barrier / f"{arm}.started").write_text("started\n", encoding="utf-8")
    deadline = time.monotonic() + 10
    while len(list(barrier.glob("*.started"))) < 2 and time.monotonic() < deadline:
        time.sleep(0.02)
    if len(list(barrier.glob("*.started"))) < 2:
        print("paired arms were serialized", file=sys.stderr)
        raise SystemExit(41)

argv_log = os.environ.get("FAKE_CODEX_ARGV")
if argv_log:
    pathlib.Path(argv_log).write_text(json.dumps(args, ensure_ascii=False), encoding="utf-8")
output_index = args.index("--output-last-message") + 1
output = pathlib.Path(args[output_index])
output.parent.mkdir(parents=True, exist_ok=True)
credential = os.environ.get("SKILL_REVIEWER_TEST_CREDENTIAL")
output.write_text("PASS\n" + ((credential + "\n") if credential else ""), encoding="utf-8")
events = [
    {"type": "thread.started", "thread_id": "thread-real-jsonl"},
    {"type": "turn.started"},
    {"type": "item.completed", "item": {"id": "reason-1", "type": "reasoning", "text": "PRIVATE_CHAIN_OF_THOUGHT"}},
    {"type": "item.started", "item": {"id": "cmd-1", "type": "command_execution", "command": "/bin/zsh -lc 'printf PASS'", "status": "in_progress"}},
    {"type": "item.completed", "item": {"id": "cmd-1", "type": "command_execution", "command": "/bin/zsh -lc 'printf PASS'", "aggregated_output": "PASS", "exit_code": 0, "status": "completed"}},
    {"type": "item.completed", "item": {"id": "provider-1", "type": "provider_observation", "status": "completed", "payload": {"thinking": "PRIVATE_NESTED_THINKING", "signature": "PRIVATE_SIGNATURE"}}},
    {"type": "item.completed", "item": {"id": "msg-1", "type": "agent_message", "text": credential or "PASS"}},
    {"type": "turn.completed", "usage": {"input_tokens": 21, "cached_input_tokens": 3, "output_tokens": 2}},
]
if os.environ.get("FAKE_CODEX_TURN_FAILED") == "1":
    events[-1] = {"type": "turn.failed", "error": {"message": "provider reported failure"}}
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
      dispatch_observation: "process_spawn",
      trace: {
        capture_source: "provider_stream",
        source: {
          artifact: "agent-source-events.jsonl",
          format: "codex-exec-jsonl-v1",
        },
      },
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
  it("dispatches all locked arms through one paired plan command", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-codex-plan-"));
    try {
      const { workspace } = compileRun({ root });
      const fakeCodex = makeFakeCodex(root);

      const result = run(
        python,
        [
          planExecutor,
          "--workspace",
          workspace,
          "--codex-bin",
          fakeCodex,
          "--full-access",
          "--pass-env",
          "FAKE_CODEX_BARRIER_DIR",
        ],
        { env: { FAKE_CODEX_BARRIER_DIR: join(root, "paired-start-barrier") } },
      );

      expectSuccess(result, "paired Codex plan execution");
      const summary = JSON.parse(result.stdout);
      expect(summary).toEqual(
        expect.objectContaining({
          contract: "skill-reviewer.codex-dispatch-summary",
          status: "completed",
          execution_count: 2,
          failed_count: 0,
        }),
      );
      const receipts = ["with_skill", "without_skill"].map((arm) =>
        JSON.parse(
          readFileSync(
            join(
              workspace,
              "cases/observable-cli-trace",
              arm,
              "repeat-1/dispatch-receipt.json",
            ),
            "utf8",
          ),
        ),
      );
      expect(new Set(receipts.map((receipt) => receipt.batch_id)).size).toBe(1);
      expect(receipts.every((receipt) => receipt.observation === "process_spawn")).toBe(true);
      const evidence = JSON.parse(
        readFileSync(join(workspace, "verification-evidence.json"), "utf8"),
      );
      expect(evidence.cases[0].with_skill.passed).toBe(true);
      expect(evidence.cases[0].without_skill.passed).toBe(true);
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

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
          "--pass-env",
          "FAKE_CODEX_ARGV",
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
          dispatch: expect.objectContaining({
            artifact: "dispatch-receipt.json",
            provider: "codex-cli",
            harness: "codex-exec-jsonl",
            observation: "process_spawn",
            worker_id: expect.stringMatching(/^pid:\d+$/),
          }),
          source_trace: expect.objectContaining({
            artifact: "agent-source-events.jsonl",
            digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            adapter: "codex-cli",
            format: "codex-exec-jsonl-v1",
            source_stream_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            redaction: "private-reasoning-fields-removed",
          }),
          trace: expect.objectContaining({
            capture_source: "provider_stream",
            source_trace_required: true,
            complete: true,
          }),
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
      expect(trace).not.toContain("PRIVATE_NESTED_THINKING");
      expect(trace).not.toContain("PRIVATE_SIGNATURE");
      const observableWire = readFileSync(
        join(repeatRoot, "agent-source-events.jsonl"),
        "utf8",
      );
      expect(observableWire).toContain('"redacted":true');
      expect(observableWire).not.toContain("PRIVATE_CHAIN_OF_THOUGHT");
      expect(observableWire).not.toContain("PRIVATE_NESTED_THINKING");
      expect(observableWire).not.toContain("PRIVATE_SIGNATURE");
      expect(existsSync(join(repeatRoot, "dispatch-receipt.json"))).toBe(true);

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
          "--pass-env",
          "FAKE_CODEX_ARGV",
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

  it("does not expose undeclared host credentials to the provider process", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-codex-env-isolation-"));
    const secret = "host-only-secret-must-not-cross";
    try {
      const { workspace } = compileRun({ root });
      const result = run(
        python,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, "with_skill"),
          "--codex-bin",
          makeFakeCodex(root),
          "--full-access",
        ],
        { env: { SKILL_REVIEWER_TEST_CREDENTIAL: secret } },
      );

      expectSuccess(result, "credential-isolated Codex execution");
      const repeatRoot = join(
        workspace,
        "cases/observable-cli-trace/with_skill/repeat-1",
      );
      expect(readFileSync(join(repeatRoot, "outputs/response.md"), "utf8")).toBe(
        "PASS\n",
      );
      expect(readFileSync(join(repeatRoot, "agent-source-events.jsonl"), "utf8")).not.toContain(
        secret,
      );
      expect(readFileSync(join(repeatRoot, "agent-trace.jsonl"), "utf8")).not.toContain(
        secret,
      );
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("redacts explicitly passed credentials and fails the retained execution", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-codex-credential-guard-"));
    const secret = "declared-secret-must-be-redacted";
    try {
      const { workspace } = compileRun({ root });
      const result = run(
        python,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, "with_skill"),
          "--codex-bin",
          makeFakeCodex(root),
          "--full-access",
          "--credential-env",
          "SKILL_REVIEWER_TEST_CREDENTIAL",
        ],
        { env: { SKILL_REVIEWER_TEST_CREDENTIAL: secret } },
      );

      expect(result.status).toBe(1);
      const repeatRoot = join(
        workspace,
        "cases/observable-cli-trace/with_skill/repeat-1",
      );
      const execution = JSON.parse(
        readFileSync(join(repeatRoot, "execution.json"), "utf8"),
      );
      expect(execution.status).toBe("failed");
      expect(execution.metrics.credential_leak_count).toBeGreaterThan(0);
      expect(execution.forbidden_actions.join("\n")).toContain(
        "provider credential appeared in retained output",
      );
      for (const relative of [
        "outputs/response.md",
        "agent-source-events.jsonl",
        "agent-trace.jsonl",
      ]) {
        const retained = readFileSync(join(repeatRoot, relative), "utf8");
        expect(retained).not.toContain(secret);
        expect(retained).toContain("[REDACTED_CREDENTIAL]");
      }
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects an empty declared credential before starting Codex", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-codex-empty-credential-"));
    const argvLog = join(root, "codex-argv.json");
    try {
      const { workspace } = compileRun({ root });
      const result = run(
        python,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, "with_skill"),
          "--codex-bin",
          makeFakeCodex(root),
          "--credential-env",
          "SKILL_REVIEWER_TEST_CREDENTIAL",
          "--pass-env",
          "FAKE_CODEX_ARGV",
        ],
        {
          env: {
            SKILL_REVIEWER_TEST_CREDENTIAL: "",
            FAKE_CODEX_ARGV: argvLog,
          },
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("declared provider credentials must be non-blank");
      expect(existsSync(argvLog)).toBe(false);
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects secret-like names passed through the ordinary environment channel", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-codex-secret-channel-"));
    const argvLog = join(root, "codex-argv.json");
    try {
      const { workspace } = compileRun({ root });
      const result = run(
        python,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, "with_skill"),
          "--codex-bin",
          makeFakeCodex(root),
          "--pass-env",
          "SKILL_REVIEWER_TEST_CREDENTIAL",
          "--pass-env",
          "FAKE_CODEX_ARGV",
        ],
        {
          env: {
            SKILL_REVIEWER_TEST_CREDENTIAL: "ordinary-channel-bypass",
            FAKE_CODEX_ARGV: argvLog,
          },
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "secret-like environment names require --credential-env",
      );
      expect(existsSync(argvLog)).toBe(false);
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a provider-reported turn failure as failed even when the process exits zero", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-codex-turn-failed-"));
    try {
      const { workspace } = compileRun({ root });
      const result = run(
        python,
        [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, "with_skill"),
          "--codex-bin",
          makeFakeCodex(root),
          "--full-access",
          "--pass-env",
          "FAKE_CODEX_TURN_FAILED",
        ],
        { env: { FAKE_CODEX_TURN_FAILED: "1" } },
      );

      expect(result.status).not.toBe(0);
      const repeatRoot = join(
        workspace,
        "cases/observable-cli-trace/with_skill/repeat-1",
      );
      const execution = JSON.parse(
        readFileSync(join(repeatRoot, "execution.json"), "utf8"),
      );
      expect(execution.status).toBe("failed");
      expect(execution.metrics.provider_failure_event_count).toBe(1);
      expect(readFileSync(join(repeatRoot, "agent-trace.jsonl"), "utf8")).toContain(
        '"source_event_type":"turn.failed"',
      );
      expect(
        readFileSync(join(repeatRoot, "outputs/response.md"), "utf8"),
      ).toContain("PASS");
    } finally {
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a Codex source event stream edited after finalization", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-codex-source-trace-"));
    try {
      const { workspace } = compileRun({ root });
      const fakeCodex = makeFakeCodex(root);
      for (const arm of ["with_skill", "without_skill"]) {
        const result = run(python, [
          executor,
          "--workspace",
          workspace,
          "--assignment",
          assignment(workspace, arm),
          "--codex-bin",
          fakeCodex,
          "--full-access",
        ]);
        expectSuccess(result, `${arm} Codex execution`);
      }
      const sourcePath = join(
        workspace,
        "cases/observable-cli-trace/with_skill/repeat-1/agent-source-events.jsonl",
      );
      writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")}{}\n`, "utf8");

      const graded = run(python, [
        runtime,
        "grade",
        "--plan",
        join(workspace, "execution-plan.json"),
        "--workspace",
        workspace,
      ]);

      expectSuccess(graded, "grade tampered Codex source trace");
      const evidence = JSON.parse(graded.stdout);
      expect(evidence.cases[0].with_skill.complete).toBe(false);
      expect(evidence.cases[0].with_skill.binding_errors.join("\n")).toContain(
        "source trace digest",
      );
      expect(evidence.cases[0].with_skill.repeats[0].source_trace.valid).toBe(false);
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

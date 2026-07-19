// @vitest-environment jsdom

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

import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { validateAndMigrateDashboardData } from "./dashboard-schema";
import { EvalExecutionTraceView } from "./EvalExecutionTrace";
import {
  buildEvalExecutionTrace,
  classifyTraceExecutor,
} from "./eval-execution-trace";
import {
  preferenceStorageKeys,
  UiPreferencesProvider,
} from "./ui-preferences";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const runtime = join(
  repoRoot,
  "skills/skill-reviewer/scripts/skill_eval_runtime.py",
);
const python = process.env.PYTHON ?? "python3";
const node = process.execPath;
const requestedAgents = new Set(
  (process.env.SKILL_REVIEWER_REAL_AGENT_E2E ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const retainedRoot = process.env.SKILL_REVIEWER_REAL_AGENT_ARTIFACT_DIR;

interface RealAgentCase {
  id: "codex" | "claude";
  target: string;
  harness: string;
  sourceFormat: string;
  executable: string;
  adapterId: string;
  runner: string;
  adapterArgs: string[];
  samplingMode: string;
}

const agentCases: RealAgentCase[] = [
  {
    id: "codex",
    target: "codex-cli",
    harness: "codex-exec-jsonl",
    sourceFormat: "codex-exec-jsonl-v1",
    executable: process.env.CODEX_BIN ?? "codex",
    adapterId: "openai.codex-cli.exec-jsonl",
    runner: join(
      repoRoot,
      "skills/skill-reviewer/scripts/run_agent_eval.mjs",
    ),
    adapterArgs: [],
    samplingMode: "codex-default",
  },
  {
    id: "claude",
    target: "claude-code",
    harness: "claude-stream-json",
    sourceFormat: "claude-stream-json-v1",
    executable: process.env.CLAUDE_BIN ?? "claude",
    adapterId: "anthropic.claude-code.stream-json",
    runner: join(
      repoRoot,
      "skills/skill-reviewer/scripts/run_agent_eval.mjs",
    ),
    adapterArgs: ["--cost-limit-usd", "0.25"],
    samplingMode: "claude-default",
  },
];

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
    for (const child of readdirSync(path)) makeWritable(join(path, child));
  } else {
    chmodSync(path, 0o600);
  }
}

function run(command: string, args: string[], timeout = 180_000) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout,
  });
}

function expectSuccess(
  result: ReturnType<typeof spawnSync>,
  label: string,
): void {
  expect(
    result.status,
    `${label} failed\nerror: ${String(result.error ?? "")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

function createRun(agent: RealAgentCase, root: string) {
  const subject = join(root, "subject");
  const manifest = write(
    subject,
    "evals/evals.json",
    JSON.stringify({
      contract: "skill-reviewer.evals",
      skill_name: "real-agent-trace-canary",
      defaults: {
        permissions: {
          network: "deny",
          external_side_effects: "deny",
          writable_roots: ["outputs"],
        },
        repeats: { deterministic: 1, stochastic: 3 },
        evolution: { max_rounds: 3 },
        case_timeout_seconds: 120,
      },
      evals: [
        {
          id: "real-agent-trace",
          purpose: "Prove a real provider process reaches the shared Dashboard Trace contract.",
          split: "development",
          prompt:
            "Read the locked Skill instructions and return the exact marker REAL_AGENT_TRACE_OK.",
          files: [],
          determinism: "deterministic",
          sampling: { repeats: 1, pairing: "paired" },
          assertions: [
            {
              id: "real-agent-marker",
              type: "text_contains",
              artifact: "outputs/response.md",
              expected: ["REAL_AGENT_TRACE_OK"],
              calibration: {
                pass_examples: ["REAL_AGENT_TRACE_OK"],
                fail_examples: ["REAL_AGENT_TRACE_FAILED"],
              },
              severity: "must_pass",
            },
          ],
          objectives: [
            {
              id: "required-pass-rate",
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
    "---\nname: real-agent-trace-canary\ndescription: Return the exact requested trace canary marker.\n---\n\n# Canary\n\nReturn exactly `REAL_AGENT_TRACE_OK`.\n",
  );
  const profile = write(
    root,
    "execution-profile.json",
    JSON.stringify({
      adapter_id: agent.adapterId,
      isolation: "local-unattested",
      sampling: { mode: agent.samplingMode, paired: true },
    }),
  );
  const workspace = join(root, "run");
  const compiled = run(python, [
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
  expectSuccess(compiled, `${agent.id} compile`);
  return { workspace };
}

describe("real Agent Trace adapters", () => {
  for (const agent of agentCases) {
    const runRealAgent = requestedAgents.has(agent.id) ? it : it.skip;
    runRealAgent(
      `${agent.id} executes a locked cell and reaches the Dashboard through the shared contract`,
      () => {
        const root = retainedRoot
          ? join(retainedRoot, agent.id)
          : mkdtempSync(join(tmpdir(), `skill-reviewer-real-${agent.id}-`));
        if (retainedRoot) {
          expect(existsSync(root)).toBe(false);
          mkdirSync(root, { recursive: true });
        }
        try {
          const version = run(agent.executable, ["--version"], 15_000);
          expectSuccess(version, `${agent.id} executable preflight`);
          const { workspace } = createRun(agent, root);
          const assignment = join(
            workspace,
            "assignments/real-agent-trace/with_skill/repeat-1.json",
          );
          const executed = run(
            node,
            [
              agent.runner,
              "cell",
              "--workspace",
              workspace,
              "--assignment",
              assignment,
              "--agent-bin",
              agent.executable,
              "--timeout-seconds",
              "120",
              ...agent.adapterArgs,
            ],
            180_000,
          );
          expectSuccess(executed, `${agent.id} real Agent execution`);

          const graded = run(python, [
            runtime,
            "grade",
            "--plan",
            join(workspace, "execution-plan.json"),
            "--workspace",
            workspace,
          ]);
          expectSuccess(graded, `${agent.id} grade`);
          const projected = run(python, [
            runtime,
            "project-dashboard",
            "--workspace",
            workspace,
            "--output",
            join(workspace, "dashboard-data.json"),
          ]);
          expectSuccess(projected, `${agent.id} Dashboard projection`);

          const rawData: unknown = JSON.parse(
            readFileSync(join(workspace, "dashboard-data.json"), "utf8"),
          );
          const data = validateAndMigrateDashboardData(rawData);
          expect(data.run.measurement?.status).toBe("valid");
          const execution = data.cases[0]?.arms
            .find((arm) => arm.id === "with_skill")
            ?.executions?.[0];
          expect(execution).toMatchObject({
            status: "completed",
            binding_error_count: 0,
            dispatch: {
              valid: true,
              provider: agent.target,
              harness: agent.harness,
              observation: "process_spawn",
            },
            source_trace: {
              valid: true,
              adapter: agent.adapterId,
              format: agent.sourceFormat,
            },
            trace: {
              valid: true,
              capture_source: "provider_stream",
              source_trace_required: true,
            },
          });
          expect(
            classifyTraceExecutor(data.run.execution_profile, execution),
          ).toMatchObject({
            kind: "local_agent_process",
            dispatchBound: true,
            target: agent.target,
            harness: agent.harness,
          });
          const trace = buildEvalExecutionTrace(data, "real-agent-trace");
          expect(trace).not.toBeNull();
          const validExecutionTrace = execution?.trace?.valid
            ? execution.trace
            : null;
          expect(validExecutionTrace).not.toBeNull();
          const markerEvent = validExecutionTrace?.events.find((event) =>
            JSON.stringify(event.details).includes("REAL_AGENT_TRACE_OK"),
          );
          expect(markerEvent).toBeDefined();
          window.localStorage.setItem(preferenceStorageKeys.locale, "en");
          const rendered = render(
            createElement(
              UiPreferencesProvider,
              null,
              createElement(EvalExecutionTraceView, {
                trace: trace!,
                cases: data.cases,
                manifest: data.run.manifest,
                planDigest: data.run.integrity?.plan_digest,
                executionProfile: data.run.execution_profile,
                onSelectCase: () => undefined,
                onOpenEvidence: () => undefined,
              }),
            ),
          );
          expect(
            rendered.getByRole("list", {
              name: "Observable event timeline",
            }),
          ).toBeInstanceOf(HTMLOListElement);
          const markerButton = rendered
            .getAllByRole("button")
            .find((button) => button.textContent?.includes(markerEvent!.summary));
          expect(markerButton).toBeDefined();
          fireEvent.click(markerButton!);
          expect(rendered.container.textContent).toContain("REAL_AGENT_TRACE_OK");
          expect(
            readFileSync(
              join(
                workspace,
                "cases/real-agent-trace/with_skill/repeat-1/outputs/response.md",
              ),
              "utf8",
            ),
          ).toContain("REAL_AGENT_TRACE_OK");
        } finally {
          cleanup();
          if (!retainedRoot) {
            makeWritable(root);
            rmSync(root, { recursive: true, force: true });
          }
        }
      },
      240_000,
    );
  }
});

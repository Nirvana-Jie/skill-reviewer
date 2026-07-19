import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
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

import { validateAndMigrateDashboardData } from "../dashboard/src/dashboard-schema";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(
  repoRoot,
  "skills",
  "skill-reviewer",
  "scripts",
  "skill_eval_runtime.py",
);
const dashboardLauncher = join(
  repoRoot,
  "skills",
  "skill-reviewer",
  "scripts",
  "start_skill_dashboard.py",
);
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
  const startedAt = "2026-07-16T00:00:00.000Z";
  const dispatchReceipt = {
    contract: "skill-reviewer.dispatch-receipt",
    run_id: plan.run_id,
    case_id: caseId,
    arm,
    repeat,
    assignment_digest: sha256(assignmentPath),
    execution_profile_digest: plan.execution_profile.digest,
    provider: plan.execution_profile.target,
    harness: plan.execution_profile.harness,
    observation: plan.execution_profile.dispatch_observation,
    dispatch_id: `dispatch-${caseId}-${arm}-${repeat}`,
    worker_id: `worker-${caseId}-${arm}-${repeat}`,
    batch_id: `batch-${plan.run_id}-${caseId}-${repeat}`,
    dispatched_at: startedAt,
  };
  const dispatchPath = write(
    repeatRoot,
    "dispatch-receipt.json",
    JSON.stringify(dispatchReceipt),
  );
  const traceEvents = [
    {
      contract: "skill-reviewer.agent-trace-event",
      event_id: `event-0001-${arm}-${repeat}-start`,
      run_id: plan.run_id,
      case_id: caseId,
      arm,
      repeat,
      sequence: 1,
      occurred_at: startedAt,
      elapsed_ms: 0,
      kind: "execution_started",
      status: "running",
      summary: "Agent execution started",
      details: { capture_source: "harness_native" },
      artifact_refs: [],
    },
  ];
  for (const [artifact, digest] of Object.entries(artifactDigests)) {
    const artifactPath = join(repeatRoot, artifact);
    traceEvents.push({
      contract: "skill-reviewer.agent-trace-event",
      event_id: `event-${String(traceEvents.length + 1).padStart(4, "0")}-${arm}-${repeat}-artifact`,
      run_id: plan.run_id,
      case_id: caseId,
      arm,
      repeat,
      sequence: traceEvents.length + 1,
      occurred_at: "2026-07-16T00:00:00.010Z",
      elapsed_ms: 10,
      kind: "artifact_written",
      status: "completed",
      summary: `Retained output artifact: ${artifact}`,
      details: { path: artifact, digest, size: statSync(artifactPath).size },
      artifact_refs: [artifact],
    });
  }
  if (traceEvents.length === 1) {
    traceEvents.push({
      contract: "skill-reviewer.agent-trace-event",
      event_id: `event-0002-${arm}-${repeat}-message`,
      run_id: plan.run_id,
      case_id: caseId,
      arm,
      repeat,
      sequence: 2,
      occurred_at: "2026-07-16T00:00:00.010Z",
      elapsed_ms: 10,
      kind: "agent_message",
      status: "completed",
      summary: "Agent returned an observable completion status",
      details: { role: "assistant", content: "Execution completed without output artifacts." },
      artifact_refs: [],
    });
  }
  const finishedAt = "2026-07-16T00:00:00.020Z";
  traceEvents.push({
    contract: "skill-reviewer.agent-trace-event",
    event_id: `event-${String(traceEvents.length + 1).padStart(4, "0")}-${arm}-${repeat}-finish`,
    run_id: plan.run_id,
    case_id: caseId,
    arm,
    repeat,
    sequence: traceEvents.length + 1,
    occurred_at: finishedAt,
    elapsed_ms: 20,
    kind: "execution_finished",
    status,
    summary: `Agent execution finished with status: ${status}`,
    details: {},
    artifact_refs: [],
  });
  const tracePath = write(
    repeatRoot,
    "agent-trace.jsonl",
    `${traceEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  return write(
    repeatRoot,
    "execution.json",
    JSON.stringify({
      contract: "skill-reviewer.executor-execution",
      run_id: plan.run_id,
      case_id: caseId,
      arm,
      repeat,
      assignment_digest: sha256(assignmentPath),
      execution_profile_digest: plan.execution_profile.digest,
      status,
      forbidden_actions: forbiddenActions,
      side_effects: sideEffects,
      metrics,
      artifact_digests: artifactDigests,
      dispatch: {
        artifact: "dispatch-receipt.json",
        digest: sha256(dispatchPath),
        provider: dispatchReceipt.provider,
        harness: dispatchReceipt.harness,
        observation: dispatchReceipt.observation,
        dispatch_id: dispatchReceipt.dispatch_id,
        worker_id: dispatchReceipt.worker_id,
        batch_id: dispatchReceipt.batch_id,
        dispatched_at: dispatchReceipt.dispatched_at,
      },
      source_trace: null,
      trace: {
        artifact: "agent-trace.jsonl",
        digest: sha256(tracePath),
        capture_source: "harness_native",
        source_trace_required: false,
        complete: true,
        event_count: traceEvents.length,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: 20,
      },
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
      const tracePath = join(
        workspace,
        "cases",
        caseId,
        arm,
        `repeat-${repeat}`,
        "agent-trace.jsonl",
      );
      const traceEvents = existsSync(tracePath)
        ? readFileSync(tracePath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      const traceEventIds = {};
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
        traceEventIds[input] = traceEvents
          .filter(
            (event) =>
              event.kind === "artifact_written" &&
              event.artifact_refs?.includes(input),
          )
          .map((event) => event.event_id);
      }
      return { repeat, digests, trace_event_ids: traceEventIds };
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
  executionProfile,
  holdoutPack,
}) {
  const profilePath =
    executionProfile ??
    write(
      dirname(workspace),
      `${workspace.split("/").at(-1)}-execution-profile.json`,
      JSON.stringify({
        target: "native-agent",
        harness: "lead-agent-dispatch",
        dispatch_observation: "host_dispatch",
        trace: { capture_source: "harness_native", source: null },
        capabilities: ["filesystem", "shell"],
        isolation: "trusted-orchestrator",
        sampling: { policy: "orchestrator-default" },
      }),
    );
  const baselineArgs = baselinePath ? ["--baseline-path", baselinePath] : [];
  const holdoutArgs = holdoutPack ? ["--holdout-pack", holdoutPack] : [];
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
      "--execution-profile",
      profilePath,
      "--baseline-kind",
      baselineKind,
      ...baselineArgs,
      ...splitArgs,
      ...caseArgs,
      ...holdoutArgs,
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
      contract: "skill-reviewer.evals",
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
    holdoutPack: options.holdoutPack,
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
      contract: "skill-reviewer.evals",
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
      contract: "skill-reviewer.evals",
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
  holdoutPack,
}) {
  const workspace = join(root, label);
  const compiled = compile({
    manifest,
    subject,
    workspace,
    baselineKind: "old_skill",
    baselinePath,
    splits: [split],
    holdoutPack,
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
  it("opens a compiled run before execution and reprojects new Agent evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-live-dashboard-"));
    let child;
    try {
      const { plan, workspace } = compiledPlanFixture(root, [minimalCase()]);
      const ui = join(root, "ui");
      write(ui, "index.html", "<!doctype html><title>local test UI</title>");
      child = spawn(
        python,
        [
          dashboardLauncher,
          "--workspace",
          workspace,
          "--ui-dir",
          ui,
          "--user-approved-control-plane",
          "--port",
          "0",
          "--refresh-seconds",
          "0.1",
        ],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const report = await new Promise((resolveReport, rejectReport) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          const newline = stdout.indexOf("\n");
          if (newline < 0) return;
          try {
            resolveReport(JSON.parse(stdout.slice(0, newline)));
          } catch (error) {
            rejectReport(error);
          }
        });
        child.once("exit", (code) => {
          rejectReport(new Error(`dashboard launcher exited early (${code}): ${stderr}`));
        });
      });
      expect(report).toEqual(
        expect.objectContaining({
          projected: true,
          projection_mode: "watching",
          refresh_seconds: 0.1,
          run_id: plan.run_id,
        }),
      );
      const session = new URLSearchParams(new URL(report.url).hash.slice(1)).get(
        "session",
      );
      expect(session).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
      const requestHeaders = { "X-Skill-Reviewer-Session": session };
      const initial = await fetch(`${report.base_url}/dashboard-data.json`, {
        headers: requestHeaders,
      }).then((response) => response.json());
      expect(
        initial.cases[0].arms.find((arm) => arm.id === "with_skill"),
      ).toEqual(expect.objectContaining({ complete: false, executions: [] }));

      write(
        workspace,
        "cases/safe-case/with_skill/repeat-1/outputs/response.md",
        "done\n",
      );
      writeExecution({ workspace, plan, caseId: "safe-case", arm: "with_skill" });

      let updated;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        updated = await fetch(`${report.base_url}/dashboard-data.json`, {
          cache: "no-store",
          headers: requestHeaders,
        }).then((response) => response.json());
        const candidate = updated.cases[0].arms.find((arm) => arm.id === "with_skill");
        if (candidate?.complete === true) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      expect(
        updated.cases[0].arms.find((arm) => arm.id === "with_skill"),
      ).toEqual(expect.objectContaining({ complete: true, passed: true }));
      expect(stderr).toContain('"event": "dashboard_projection_updated"');
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      makeWritable(root);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("binds an agent-independent execution cell into the plan and assignments", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root);
      const workspace = join(root, "run");

      const result = compile({
        manifest,
        subject,
        workspace,
        splits: ["development"],
      });

      expect(result.status, result.stderr).toBe(0);
      const plan = JSON.parse(result.stdout);
      expect(plan.execution_profile).toEqual(
        expect.objectContaining({
          target: "native-agent",
          harness: "lead-agent-dispatch",
          capabilities: ["filesystem", "shell"],
          isolation: "trusted-orchestrator",
          sampling: { policy: "orchestrator-default" },
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      );
      const assignment = JSON.parse(
        readFileSync(
          join(workspace, "assignments/safe-case/with_skill/repeat-1.json"),
          "utf8",
        ),
      );
      expect(assignment.execution_profile_digest).toBe(
        plan.execution_profile.digest,
      );
      expect(assignment.trace_artifact).toBe("agent-trace.jsonl");
    });
  });

  it("locks provider-neutral dispatch and trace adapter metadata", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root);
      const workspace = join(root, "run");
      const executionProfile = write(
        root,
        "profiles/claude.json",
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

      const result = compile({
        manifest,
        subject,
        workspace,
        splits: ["development"],
        executionProfile,
      });

      expect(result.status, result.stderr).toBe(0);
      const plan = JSON.parse(result.stdout);
      expect(plan.execution_profile).toEqual(
        expect.objectContaining({
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
        }),
      );
      const assignment = JSON.parse(
        readFileSync(
          join(workspace, "assignments/safe-case/with_skill/repeat-1.json"),
          "utf8",
        ),
      );
      expect(assignment.source_trace_artifact).toBe(
        "agent-source-events.jsonl",
      );
    });
  });

  it("derives a distinct run id when the execution cell changes", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root);
      const firstProfile = write(
        root,
        "profiles/first.json",
        JSON.stringify({
          target: "native-agent",
          harness: "lead-agent-dispatch",
          dispatch_observation: "host_dispatch",
          trace: { capture_source: "harness_native", source: null },
          capabilities: ["filesystem"],
          isolation: "trusted-orchestrator",
          sampling: { policy: "deterministic" },
        }),
      );
      const secondProfile = write(
        root,
        "profiles/second.json",
        JSON.stringify({
          target: "native-agent",
          harness: "lead-agent-dispatch",
          dispatch_observation: "host_dispatch",
          trace: { capture_source: "harness_native", source: null },
          capabilities: ["filesystem", "shell"],
          isolation: "trusted-orchestrator",
          sampling: { policy: "orchestrator-default" },
        }),
      );

      const first = compile({
        manifest,
        subject,
        workspace: join(root, "run-first"),
        splits: ["development"],
        executionProfile: firstProfile,
      });
      const second = compile({
        manifest,
        subject,
        workspace: join(root, "run-second"),
        splits: ["development"],
        executionProfile: secondProfile,
      });

      expect(first.status, first.stderr).toBe(0);
      expect(second.status, second.stderr).toBe(0);
      expect(JSON.parse(first.stdout).run_id).not.toBe(
        JSON.parse(second.stdout).run_id,
      );
    });
  });

  it("derives a distinct run id when the development surrogate changes", () => {
    fixture((root) => {
      const { manifest, subject } = writeMinimalPackage(root);
      const first = compile({
        manifest,
        subject,
        workspace: join(root, "development-first"),
        splits: ["development"],
      });
      expect(first.status, first.stderr).toBe(0);

      const changed = JSON.parse(readFileSync(manifest, "utf8"));
      changed.evals[0].prompt = "A different development-only diagnostic task.";
      writeFileSync(manifest, JSON.stringify(changed), "utf8");
      const second = compile({
        manifest,
        subject,
        workspace: join(root, "development-second"),
        splits: ["development"],
      });
      expect(second.status, second.stderr).toBe(0);

      expect(JSON.parse(first.stdout).run_id).not.toBe(
        JSON.parse(second.stdout).run_id,
      );
    });
  });

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

  it("compiles the manifest contract into a locked paired execution plan", () => {
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
          contract: "skill-reviewer.evals",
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
      expect(plan.contract).toBe("skill-reviewer.execution-plan");
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
          contract: "skill-reviewer.run-lock",
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
          contract: "skill-reviewer.executor-assignment",
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

  it("blocks an invalid manifest instead of silently skipping its assertions", () => {
    fixture((root) => {
      const subject = join(root, "demo-skill");
      const workspace = join(root, "run");
      write(subject, "SKILL.md", "---\nname: demo-skill\ndescription: Demo.\n---\n");
      const manifest = write(
        subject,
        "evals/evals.json",
        JSON.stringify({
          contract: "skill-reviewer.evals",
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
          contract: "skill-reviewer.evals",
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

  it("rejects undeclared fields throughout the executable manifest", () => {
    fixture((root) => {
      const mutations = [
        ["manifest", (value) => { value.obsolete_eval_rows = []; }],
        ["defaults", (value) => { value.defaults.fallback = {}; }],
        ["case", (value) => { value.evals[0].should_trigger = true; }],
        ["assertion", (value) => { value.evals[0].assertions[0].hint = "pass"; }],
        ["objective", (value) => { value.evals[0].objectives[0].weight = 1; }],
      ];

      for (const [label, mutate] of mutations) {
        const fixtureRoot = join(root, label);
        const { manifest, subject } = writeMinimalPackage(fixtureRoot);
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        mutate(parsed);
        writeFileSync(manifest, JSON.stringify(parsed), "utf8");

        const result = compile({
          manifest,
          subject,
          workspace: join(fixtureRoot, "run"),
          splits: ["development"],
        });

        expect(result.status, `${label}: ${result.stderr}`).toBe(2);
        expect(JSON.parse(result.stdout).error).toContain("unsupported fields");
      }
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
  it("records observable Agent events and binds checks to their source event ids", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [minimalCase()]);
      for (const arm of plan.cases[0].arms) {
        write(
          workspace,
          `cases/safe-case/${arm}/repeat-1/outputs/response.md`,
          `completed by ${arm}\n`,
        );
        const assignment = join(
          workspace,
          "assignments",
          "safe-case",
          arm,
          "repeat-1.json",
        );
        const dispatched = runtimeCommand([
          "record-dispatch",
          "--workspace",
          workspace,
          "--assignment",
          assignment,
          "--dispatch-id",
          `dispatch-safe-case-${arm}-1`,
          "--worker-id",
          `worker-safe-case-${arm}-1`,
        ]);
        expect(dispatched.status, dispatched.stderr).toBe(0);
        const observed = runtimeCommand([
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
          JSON.stringify({ path: "SKILL.md", digest: "a".repeat(64) }),
        ]);
        expect(observed.status, observed.stderr).toBe(0);
        const command = runtimeCommand([
          "trace-event",
          "--workspace",
          workspace,
          "--assignment",
          assignment,
          "--kind",
          "command",
          "--summary",
          "Validated the generated response",
          "--details-json",
          JSON.stringify({ argv: ["test", "-s", "outputs/response.md"], exit_code: 0 }),
        ]);
        expect(command.status, command.stderr).toBe(0);
        const finalized = runtimeCommand([
          "finalize-execution",
          "--workspace",
          workspace,
          "--assignment",
          assignment,
          "--status",
          "completed",
        ]);
        expect(finalized.status, finalized.stderr).toBe(0);
      }

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      const repeat = evidence.cases[0].with_skill.repeats[0];
      expect(repeat.trace).toEqual(
        expect.objectContaining({
          valid: true,
          capture_source: "harness_native",
          event_count: 5,
        }),
      );
      expect(repeat.trace.events.map((event) => event.kind)).toEqual([
        "execution_started",
        "file_read",
        "command",
        "artifact_written",
        "execution_finished",
      ]);
      expect(repeat.assertions[0].evidence.source_event_ids).toEqual([
        expect.stringMatching(/^event-0004-/),
      ]);
    });
  });

  it("rejects private reasoning fields from an Agent trace event", () => {
    fixture((root) => {
      const { workspace } = compiledPlanFixture(root, [minimalCase()]);
      const assignment = join(
        workspace,
        "assignments/safe-case/with_skill/repeat-1.json",
      );

      const result = runtimeCommand([
        "trace-event",
        "--workspace",
        workspace,
        "--assignment",
        assignment,
        "--kind",
        "agent_message",
        "--summary",
        "Visible response",
        "--details-json",
        JSON.stringify({ chain_of_thought: "must never be retained" }),
      ]);

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "must not contain private-reasoning fields",
      );
    });
  });

  it("fails closed when an executor does not echo the locked execution cell", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "profile-bound" }),
      ]);
      write(
        workspace,
        "cases/profile-bound/with_skill/repeat-1/outputs/response.md",
        "done\n",
      );
      const executionPath = writeExecution({
        workspace,
        plan,
        caseId: "profile-bound",
        arm: "with_skill",
      });
      const execution = JSON.parse(readFileSync(executionPath, "utf8"));
      execution.execution_profile_digest = "0".repeat(64);
      writeFileSync(executionPath, JSON.stringify(execution), "utf8");
      writeExecution({
        workspace,
        plan,
        caseId: "profile-bound",
        arm: "without_skill",
      });

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("inconclusive");
      expect(evidence.execution_profile.digest).toBe(
        plan.execution_profile.digest,
      );
      expect(
        evidence.cases[0].with_skill.binding_errors.join("\n"),
      ).toContain("execution_profile_digest");
    });
  });

  it("fails closed when a retained dispatch receipt is edited after execution", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "dispatch-bound" }),
      ]);
      for (const arm of plan.cases[0].arms) {
        write(
          workspace,
          `cases/dispatch-bound/${arm}/repeat-1/outputs/response.md`,
          `done by ${arm}\n`,
        );
        writeExecution({ workspace, plan, caseId: "dispatch-bound", arm });
      }
      const receiptPath = join(
        workspace,
        "cases/dispatch-bound/with_skill/repeat-1/dispatch-receipt.json",
      );
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      receipt.worker_id = "forged-worker";
      writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.cases[0].with_skill.complete).toBe(false);
      expect(evidence.cases[0].with_skill.binding_errors.join("\n")).toContain(
        "dispatch receipt digest",
      );
      expect(
        evidence.cases[0].with_skill.repeats[0].dispatch.valid,
      ).toBe(false);
    });
  });

  it("rejects individually valid arms that were not retained in one paired dispatch batch", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "paired-dispatch" }),
      ]);
      const executionPaths = {};
      for (const arm of plan.cases[0].arms) {
        write(
          workspace,
          `cases/paired-dispatch/${arm}/repeat-1/outputs/response.md`,
          `done by ${arm}\n`,
        );
        executionPaths[arm] = writeExecution({
          workspace,
          plan,
          caseId: "paired-dispatch",
          arm,
        });
      }
      const baselineArm = plan.cases[0].arms.find((arm) => arm !== "with_skill");
      const receiptPath = join(
        workspace,
        `cases/paired-dispatch/${baselineArm}/repeat-1/dispatch-receipt.json`,
      );
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      receipt.batch_id = "batch-unpaired-baseline";
      writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");
      const execution = JSON.parse(readFileSync(executionPaths[baselineArm], "utf8"));
      execution.dispatch.batch_id = receipt.batch_id;
      execution.dispatch.digest = sha256(receiptPath);
      writeFileSync(executionPaths[baselineArm], JSON.stringify(execution), "utf8");

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.cases[0].with_skill.complete).toBe(false);
      expect(evidence.cases[0].with_skill.binding_errors.join("\n")).toContain(
        "paired dispatch batch_id mismatch",
      );
      expect(evidence.cases[0].with_skill.repeats[0]).toEqual(
        expect.objectContaining({
          status: "completed",
          binding_errors: expect.arrayContaining([
            "paired dispatch batch_id mismatch",
          ]),
        }),
      );
      expect(evidence.cases[0][baselineArm].complete).toBe(false);
    });
  });

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
          contract: "skill-reviewer.executor-execution",
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
          '{"contract":"skill-reviewer.executor-execution","metrics":{"quality":1e999}}',
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

  it("marks executor evidence with undeclared fields inconclusive", () => {
    fixture((root) => {
      const { plan, planPath, workspace } = compiledPlanFixture(root, [
        minimalCase({ id: "strict-execution", split: "selection" }),
      ]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/strict-execution/${arm}/repeat-1/outputs/response.md`,
          "retained response\n",
        );
        const executionPath = writeExecution({
          workspace,
          plan,
          caseId: "strict-execution",
          arm,
        });
        if (arm === "with_skill") {
          const execution = JSON.parse(readFileSync(executionPath, "utf8"));
          execution.worker_build = "undeclared";
          writeFileSync(executionPath, JSON.stringify(execution), "utf8");
        }
      }

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.level).toBe("inconclusive");
      expect(
        evidence.cases[0].with_skill.binding_errors.join("\n"),
      ).toContain("execution contains unsupported fields: worker_build");
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

  it("fails a text_not_matches assertion when retained output makes a forbidden claim", () => {
    fixture((root) => {
      const testCase = minimalCase({
        id: "forbidden-release-claim",
        split: "selection",
      });
      testCase.assertions = [
        {
          id: "no-release-claim",
          type: "text_not_matches",
          artifact: "outputs/response.md",
          pattern: "(?im)^结论：可以发布$",
          severity: "must_pass",
        },
      ];
      const { plan, planPath, workspace } = compiledPlanFixture(root, [testCase]);
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/forbidden-release-claim/${arm}/repeat-1/outputs/response.md`,
          arm === "with_skill" ? "结论：可以发布\n" : "结论：证据不足\n",
        );
        writeExecution({
          workspace,
          plan,
          caseId: "forbidden-release-claim",
          arm,
        });
      }

      const result = grade({ plan: planPath, workspace });

      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.cases[0].with_skill).toEqual(
        expect.objectContaining({ passed: false, required_pass_rate: 0 }),
      );
      expect(evidence.cases[0].old_skill).toEqual(
        expect.objectContaining({ passed: true, required_pass_rate: 1 }),
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
          contract: "skill-reviewer.semantic-judgment",
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
          source_event_ids: [
            "event-0002-old_skill-1-artifact",
            "event-0002-with_skill-1-artifact",
          ],
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
          contract: "skill-reviewer.semantic-judgment",
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
          contract: "skill-reviewer.semantic-judgment",
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
          contract: "skill-reviewer.semantic-judgment",
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
          contract: "skill-reviewer.acceptance-decision",
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

  it("keeps a public audit as calibration evidence and blocks release", () => {
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
          status: "inconclusive",
          accepted: false,
          material_improvement: false,
          release_eligible: false,
        }),
      );
      expect(JSON.parse(result.stdout).hard_gates).toContainEqual(
        expect.objectContaining({ id: "audit:opaque-holdout", passed: false }),
      );
    });
  });

  it("rejects an opaque manifest that exposes prompt or oracle fields", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const { manifest, subject } = writeMinimalPackage(root, {
        cases: [
          minimalCase({
            id: "leaky-audit",
            split: "audit",
            holdout: {
              visibility: "opaque",
              asset_id: "leaky-audit-asset",
            },
          }),
        ],
      });

      const result = compile({
        manifest,
        subject,
        workspace: join(root, "leaky-audit-run"),
        baselineKind: "old_skill",
        baselinePath,
        splits: ["audit"],
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "opaque audit must not expose oracle fields",
      );
    });
  });

  it("accepts a one-shot opaque audit without demanding another material delta", () => {
    fixture((root) => {
      const secret = write(root, "trusted/scenario.txt", "unseen audit input\n");
      const holdoutPack = write(
        root,
        "trusted/holdout-pack.json",
        JSON.stringify({
          issuer: "trusted-eval-service",
          assets: {
            "opaque-audit-fixture": {
              prompt: "PRIVATE_PROMPT: review the injected scenario.",
              files: { "private/scenario.txt": secret },
              assertions: [
                {
                  id: "private-marker",
                  type: "text_contains",
                  artifact: "outputs/response.md",
                  expected: "PRIVATE_EXPECTED_MARKER",
                  severity: "must_pass",
                },
              ],
              objectives: [
                {
                  id: "private-quality",
                  metric: "required_pass_rate",
                  direction: "maximize",
                  primary: true,
                  min_material_delta: 0.1,
                  non_regression_tolerance: 0,
                },
              ],
            },
          },
        }),
      );
      const { plan, planPath, workspace } = compiledPlanFixture(
        root,
        [
          {
            id: "opaque-audit",
            purpose: "Resolve a hidden audit oracle outside the candidate package.",
            split: "audit",
            determinism: "deterministic",
            holdout: {
              visibility: "opaque",
              asset_id: "opaque-audit-fixture",
            },
          },
        ],
        { holdoutPack },
      );
      for (const arm of ["with_skill", "old_skill"]) {
        write(
          workspace,
          `cases/opaque-audit/${arm}/repeat-1/outputs/response.md`,
          "PRIVATE_EXPECTED_MARKER\n",
        );
      }
      for (const arm of ["with_skill", "old_skill", "without_skill"]) {
        writeExecution({ workspace, plan, caseId: "opaque-audit", arm });
      }

      const preDecisionProjection = runtimeCommand([
        "project-dashboard",
        "--workspace",
        workspace,
        "--output",
        join(workspace, "dashboard-data.json"),
      ]);
      expect(preDecisionProjection.status, preDecisionProjection.stderr).toBe(0);
      const preDecisionDashboard = JSON.parse(
        readFileSync(join(workspace, "dashboard-data.json"), "utf8"),
      );
      expect(preDecisionDashboard.run.verification_level).toBe(
        "regression-verified",
      );
      expect(preDecisionDashboard.run.release_eligible).toBe(false);
      expect(preDecisionDashboard.review.decision).toEqual(
        expect.objectContaining({
          status: "inconclusive",
          reason: "evidence_incomplete",
          release_eligible: false,
        }),
      );
      expect(() =>
        validateAndMigrateDashboardData(preDecisionDashboard),
      ).not.toThrow();

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
          release_eligible: true,
        }),
      );
      expect(plan.holdout).toEqual(
        expect.objectContaining({
          visibility: "opaque",
          issuer: "trusted-eval-service",
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      );
      const publicManifest = readFileSync(
        join(root, "subject/evals/evals.json"),
        "utf8",
      );
      expect(publicManifest).not.toContain("PRIVATE_PROMPT");
      expect(publicManifest).not.toContain("PRIVATE_EXPECTED_MARKER");
      expect(publicManifest).not.toContain("private/scenario.txt");
      const assignment = JSON.parse(
        readFileSync(
          join(
            workspace,
            "assignments/opaque-audit/with_skill/repeat-1.json",
          ),
          "utf8",
        ),
      );
      expect(assignment.prompt).toContain("PRIVATE_PROMPT");
      expect(assignment.input_files[0].relative_path).toBe(
        "private/scenario.txt",
      );
      expect(JSON.stringify(assignment)).not.toContain(
        "PRIVATE_EXPECTED_MARKER",
      );
      expect(assignment).not.toHaveProperty("assertions");
      expect(assignment).not.toHaveProperty("objectives");

      const projected = runtimeCommand([
        "project-dashboard",
        "--workspace",
        workspace,
        "--output",
        join(workspace, "dashboard-data.json"),
      ]);
      expect(projected.status, projected.stderr).toBe(0);
      const dashboard = JSON.parse(
        readFileSync(join(workspace, "dashboard-data.json"), "utf8"),
      );
      expect(dashboard.cases[0]).toEqual(
        expect.objectContaining({
          prompt: null,
          input_files: [],
          holdout_visibility: "opaque",
        }),
      );
      expect(JSON.stringify(dashboard)).not.toContain("PRIVATE_PROMPT");
      expect(JSON.stringify(dashboard)).not.toContain(
        "PRIVATE_EXPECTED_MARKER",
      );
      expect(dashboard.run.release_eligible).toBe(true);
      expect(dashboard.review.decision).toEqual(
        expect.objectContaining({
          status: "ready",
          reason: "release_conditions_met",
          release_eligible: true,
        }),
      );
      expect(() => validateAndMigrateDashboardData(dashboard)).not.toThrow();
      const projectedTraces = dashboard.cases.flatMap((testCase) =>
        testCase.arms.flatMap((arm) =>
          arm.executions.map((execution) => execution.trace),
        ),
      );
      expect(projectedTraces).toHaveLength(3);
      for (const trace of projectedTraces) {
        expect(trace.events[0].details).toEqual({
          capture_source: trace.capture_source,
        });
        for (const event of trace.events.slice(1)) {
          expect(event.details).toEqual({});
        }
      }
      expect(dashboard.spine).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "artifact",
            content_unavailable_reason: "opaque",
          }),
          expect.objectContaining({
            kind: "assertion",
            assertion_evidence: {},
            content_unavailable_reason: "opaque",
          }),
        ]),
      );
      expect(
        dashboard.spine
          .filter((node) => node.kind === "artifact" || node.kind === "assertion")
          .some((node) => Object.hasOwn(node, "content_url")),
      ).toBe(false);
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
  it("authorizes one selection query per round and retains candidate lineage", () => {
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
          `candidate-${round}`,
          `round-${round}`,
        );
        return executeBoundRun({
          root,
          ...candidate,
          baselinePath,
          split: "selection",
          label: `selection-${round}`,
          iteration: round,
          passes: { with_skill: true, old_skill: true },
        });
      });
      const control = join(root, "control");
      runtimeCommand([
        "evolution-init",
        "--plan",
        runs[0].planPath,
        "--workspace",
        control,
      ]);
      const statePath = join(control, "evolution-state.json");
      expect(
        runtimeCommand([
          "evolution-advance",
          "--state",
          statePath,
          "--decision",
          runs[0].decisionPath,
        ]).status,
      ).toBe(0);

      const unauthorized = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        runs[1].decisionPath,
      ]);
      expect(unauthorized.status).toBe(2);
      expect(JSON.parse(unauthorized.stdout).error).toContain(
        "not the authorized evaluation query",
      );

      const rejectedParent = runtimeCommand([
        "evolution-authorize",
        "--state",
        statePath,
        "--plan",
        runs[1].planPath,
        "--parent-digest",
        runs[0].plan.subject.digest,
      ]);
      expect(rejectedParent.status).toBe(2);
      expect(JSON.parse(rejectedParent.stdout).error).toContain(
        "rejected candidates cannot become parents",
      );

      const authorized = runtimeCommand([
        "evolution-authorize",
        "--state",
        statePath,
        "--plan",
        runs[1].planPath,
        "--parent-digest",
        runs[1].plan.baseline.digest,
        "--training-trace",
        "development-trace-round-2",
      ]);
      expect(authorized.status, authorized.stderr).toBe(0);
      expect(
        runtimeCommand([
          "evolution-advance",
          "--state",
          statePath,
          "--decision",
          runs[1].decisionPath,
        ]).status,
      ).toBe(0);

      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.selection_query_count).toBe(2);
      expect(state.candidate_lineage).toHaveLength(2);
      expect(state.candidate_lineage[1]).toEqual(
        expect.objectContaining({
          round: 2,
          run_id: runs[1].plan.run_id,
          parent_digest: runs[1].plan.baseline.digest,
          candidate_digest: runs[1].plan.subject.digest,
          change_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          training_trace_ids: ["development-trace-round-2"],
        }),
      );
      expect(state.rejected_candidates).toHaveLength(2);
    });
  });

  it("resets optimizer continuity after an architecture-scale rewrite without limiting diff size", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const firstCandidate = writeEvolutionSubject(root, "candidate-1", "small-step");
      const first = executeBoundRun({
        root,
        ...firstCandidate,
        baselinePath,
        split: "selection",
        label: "selection-1",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      const rewritten = writeEvolutionSubject(root, "candidate-2", "architecture-reset");
      for (let index = 0; index < 80; index += 1) {
        write(
          rewritten.subject,
          `references/module-${index}.md`,
          `architecture module ${index}\n`,
        );
      }
      const second = executeBoundRun({
        root,
        ...rewritten,
        baselinePath,
        split: "selection",
        label: "selection-2",
        iteration: 2,
        passes: { with_skill: true, old_skill: true },
      });
      const control = join(root, "control");
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

      const missingReset = runtimeCommand([
        "evolution-authorize",
        "--state",
        statePath,
        "--plan",
        second.planPath,
        "--parent-digest",
        second.plan.baseline.digest,
      ]);
      expect(missingReset.status).toBe(2);
      expect(JSON.parse(missingReset.stdout).error).toContain(
        "topology-changing candidates require --continuity reset",
      );

      const reset = runtimeCommand([
        "evolution-authorize",
        "--state",
        statePath,
        "--plan",
        second.planPath,
        "--parent-digest",
        second.plan.baseline.digest,
        "--continuity",
        "reset",
        "--training-trace",
        "architecture-hypothesis-2",
      ]);
      expect(reset.status, reset.stderr).toBe(0);
      expect(
        runtimeCommand([
          "evolution-advance",
          "--state",
          statePath,
          "--decision",
          second.decisionPath,
        ]).status,
      ).toBe(0);

      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.continuity_epoch).toBe(2);
      expect(state.rejected_candidates).toHaveLength(2);
      expect(state.optimizer_rejected_buffer).toHaveLength(1);
      expect(state.candidate_lineage[1]).toEqual(
        expect.objectContaining({
          continuity: "reset",
          continuity_epoch: 2,
          change: expect.objectContaining({
            added: expect.arrayContaining(["references/module-79.md"]),
          }),
        }),
      );
    });
  });

  it("allows a development surrogate to evolve while freezing selection and audit authority", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const candidates = [1, 2].map((round) => {
        const candidate = writeEvolutionSubject(
          root,
          `candidate-${round}`,
          `surrogate-${round}`,
        );
        const manifest = JSON.parse(readFileSync(candidate.manifest, "utf8"));
        manifest.evals.unshift(
          minimalCase({
            id: "development-surrogate",
            split: "development",
            purpose: `Surrogate verifier revision ${round}.`,
          }),
        );
        writeFileSync(candidate.manifest, JSON.stringify(manifest), "utf8");
        return candidate;
      });
      const runs = candidates.map((candidate, index) =>
        executeBoundRun({
          root,
          ...candidate,
          baselinePath,
          split: "selection",
          label: `selection-${index + 1}`,
          iteration: index + 1,
          passes: { with_skill: true, old_skill: true },
        }),
      );
      expect(runs[0].plan.authority.digest).toBe(runs[1].plan.authority.digest);
      expect(runs[0].plan.authority.development_digest).not.toBe(
        runs[1].plan.authority.development_digest,
      );
      const control = join(root, "control");
      runtimeCommand([
        "evolution-init",
        "--plan",
        runs[0].planPath,
        "--workspace",
        control,
      ]);
      const statePath = join(control, "evolution-state.json");
      runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        runs[0].decisionPath,
      ]);

      const authorized = runtimeCommand([
        "evolution-authorize",
        "--state",
        statePath,
        "--plan",
        runs[1].planPath,
        "--parent-digest",
        runs[1].plan.baseline.digest,
        "--training-trace",
        "surrogate-revision-2",
      ]);

      expect(authorized.status, authorized.stderr).toBe(0);
    });
  });

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

      for (const [index, run] of runs.entries()) {
        if (index > 0) {
          const authorized = runtimeCommand([
            "evolution-authorize",
            "--state",
            statePath,
            "--plan",
            run.planPath,
            "--parent-digest",
            run.plan.baseline.digest,
            "--training-trace",
            `development-trace-${index + 1}`,
          ]);
          expect(authorized.status, authorized.stderr).toBe(0);
        }
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
          next_action: "prepare_audit",
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
      const unauthorizedAudit = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        audit.decisionPath,
      ]);
      expect(unauthorizedAudit.status).toBe(2);
      expect(JSON.parse(unauthorizedAudit.stdout).error).toContain(
        "not the authorized evaluation query",
      );
      const authorizedAudit = runtimeCommand([
        "evolution-authorize",
        "--state",
        statePath,
        "--plan",
        audit.planPath,
      ]);
      expect(authorizedAudit.status, authorizedAudit.stderr).toBe(0);
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

  it("stops at audit-passed and requires a separate user release decision", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const candidate = writeEvolutionSubject(root, "candidate", "opaque-audit");
      const manifest = JSON.parse(readFileSync(candidate.manifest, "utf8"));
      manifest.evals[1] = {
        id: "public-audit",
        purpose: "Run a hidden final behavioral audit.",
        split: "audit",
        determinism: "deterministic",
        holdout: {
          visibility: "opaque",
          asset_id: "final-behavioral-audit",
        },
      };
      writeFileSync(candidate.manifest, JSON.stringify(manifest), "utf8");
      const holdoutPack = write(
        root,
        "trusted/final-holdout.json",
        JSON.stringify({
          issuer: "trusted-eval-service",
          assets: {
            "final-behavioral-audit": {
              prompt: "Produce the hidden audit response.",
              files: {},
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
          },
        }),
      );
      const selection = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "release-selection",
        iteration: 1,
        passes: { with_skill: true, old_skill: false },
      });
      const control = join(root, "release-control");
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
      const audit = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "audit",
        label: "release-audit",
        iteration: 1,
        passes: { with_skill: true, old_skill: true, without_skill: false },
        holdoutPack,
      });
      expect(audit.decision.release_eligible).toBe(true);
      const authorized = runtimeCommand([
        "evolution-authorize",
        "--state",
        statePath,
        "--plan",
        audit.planPath,
      ]);
      expect(authorized.status, authorized.stderr).toBe(0);

      const advanced = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        audit.decisionPath,
      ]);

      expect(advanced.status, advanced.stderr).toBe(0);
      expect(JSON.parse(advanced.stdout)).toEqual(
        expect.objectContaining({
          status: "audit-passed",
          next_action: "request_user_release",
          terminal: true,
          audit_consumed: true,
        }),
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
        "evolution-authorize",
        "--state",
        statePath,
        "--plan",
        audit.planPath,
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

  it("recomputes candidate lineage instead of trusting stored change evidence", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const candidate = writeEvolutionSubject(root, "candidate", "lineage-tamper");
      const run = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "lineage-selection",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      const control = join(root, "lineage-control");
      runtimeCommand([
        "evolution-init",
        "--plan",
        run.planPath,
        "--workspace",
        control,
      ]);
      const statePath = join(control, "evolution-state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.candidate_lineage[0].change_digest = "0".repeat(64);
      writeFileSync(statePath, JSON.stringify(state), "utf8");

      const result = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        run.decisionPath,
      ]);

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toContain(
        "change evidence is invalid",
      );
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
  it("rejects a same-run clone that is not the exact plan authorized by evolution", () => {
    fixture((root) => {
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const candidate = writeEvolutionSubject(root, "candidate", "plan-binding");
      const run = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "authorized-selection",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      const control = join(root, "plan-binding-control");
      runtimeCommand([
        "evolution-init",
        "--plan",
        run.planPath,
        "--workspace",
        control,
      ]);
      const statePath = join(control, "evolution-state.json");
      const advanced = runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        run.decisionPath,
      ]);
      expect(advanced.status, advanced.stderr).toBe(0);

      const clone = executeBoundRun({
        root,
        ...candidate,
        baselinePath,
        split: "selection",
        label: "same-run-clone",
        iteration: 1,
        passes: { with_skill: true, old_skill: true },
      });
      expect(clone.plan.run_id).toBe(run.plan.run_id);
      expect(sha256(clone.planPath)).not.toBe(sha256(run.planPath));

      const projected = runtimeCommand([
        "project-dashboard",
        "--workspace",
        clone.workspace,
        "--state",
        statePath,
        "--output",
        join(clone.workspace, "dashboard-data.json"),
      ]);

      expect(projected.status).toBe(2);
      expect(JSON.parse(projected.stdout).error).toContain(
        "exact authorized plan",
      );
    });
  });

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
      for (const [index, run] of runs.entries()) {
        if (index > 0) {
          const authorized = runtimeCommand([
            "evolution-authorize",
            "--state",
            statePath,
            "--plan",
            run.planPath,
            "--parent-digest",
            run.plan.baseline.digest,
          ]);
          expect(authorized.status, authorized.stderr).toBe(0);
        }
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
      expect(data.action_center).toEqual(
        expect.objectContaining({
          next_action: "propose_candidate",
          owner: "lead_agent",
          continuation: {
            mode: "automatic",
            owner: "lead_agent",
            reason: "within_locked_authority",
          },
          actions: expect.arrayContaining([
            expect.objectContaining({
              id: "generate_candidate",
              available: true,
              recommended: true,
            }),
            expect.objectContaining({
              id: "propose_eval_change",
              available: false,
              recommended: false,
            }),
          ]),
          attribution: expect.objectContaining({
            primary: "skill",
            items: expect.arrayContaining([
              expect.objectContaining({
                id: "skill",
                status: "primary",
                signals: expect.arrayContaining(["material_improvement_missing"]),
              }),
            ]),
          }),
        }),
      );
      expect(data.review).toEqual(
        expect.objectContaining({
          decision: expect.objectContaining({
            status: "blocked",
            reason: "candidate_acceptance_failed",
          }),
          blockers: [
            expect.objectContaining({
              id: "blocker:criterion:material_improvement",
              kind: "criterion",
              case_id: null,
              status: "failed",
              criterion_ids: ["material_improvement"],
            }),
          ],
          next_action: "propose_candidate",
          attribution: "skill",
        }),
      );
    });
  });

  it("projects an authorized selection query before it is consumed", () => {
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
          `active-dashboard-candidate-${round}`,
          `active-dashboard-${round}`,
        );
        return executeBoundRun({
          root,
          ...candidate,
          baselinePath,
          split: "selection",
          label: `active-dashboard-selection-${round}`,
          iteration: round,
          passes: { with_skill: true, old_skill: true },
        });
      });
      const control = join(root, "active-dashboard-control");
      runtimeCommand([
        "evolution-init",
        "--plan",
        runs[0].planPath,
        "--workspace",
        control,
      ]);
      const statePath = join(control, "evolution-state.json");
      runtimeCommand([
        "evolution-advance",
        "--state",
        statePath,
        "--decision",
        runs[0].decisionPath,
      ]);
      const authorized = runtimeCommand([
        "evolution-authorize",
        "--state",
        statePath,
        "--plan",
        runs[1].planPath,
        "--parent-digest",
        runs[1].plan.baseline.digest,
      ]);
      expect(authorized.status, authorized.stderr).toBe(0);

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
      expect(data.evolution.active_query).toEqual(
        expect.objectContaining({
          phase: "selection",
          round: 2,
          run_id: runs[1].plan.run_id,
        }),
      );
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
          contract: "skill-reviewer.semantic-judgment",
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
      expect(data.review).toEqual(
        expect.objectContaining({
          contract: "skill-reviewer.dashboard-review",
          decision: expect.objectContaining({
            status: "blocked",
            reason: "scenario_failed",
            blocking_scenario_count: 1,
          }),
          blockers: [
            expect.objectContaining({
              id: "blocker:semantic-dashboard",
              case_id: "semantic-dashboard",
              status: "failed",
              failed_check_ids: [
                "assertion:semantic-dashboard:semantic:blind-quality",
              ],
              source_evidence_ids: [
                "artifact:semantic-dashboard:semantic:blind-quality",
              ],
            }),
          ],
        }),
      );
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

  it("projects the retained evidence chain into the dashboard read model", () => {
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
          contract: "skill-reviewer.dashboard-data",
          schema_version: 2,
          run: expect.objectContaining({
            id: plan.run_id,
            status: "awaiting-audit",
            verification_level: "regression-verified",
            manifest: expect.objectContaining({
              path: plan.manifest.path,
              digest: plan.manifest.digest,
            }),
            evidence_scope: "public-calibration",
            release_eligible: false,
            execution_profile: expect.objectContaining({
              target: "native-agent",
              harness: "lead-agent-dispatch",
              digest: plan.execution_profile.digest,
            }),
            holdout: expect.objectContaining({ visibility: "public" }),
          }),
          summary: expect.objectContaining({
            case_count: 1,
            candidate_passed: 1,
            decision_status: "accepted",
            current_round: 1,
            selection_queries: 1,
            audit_queries: 0,
            continuity_epoch: 1,
          }),
          evolution: expect.objectContaining({
            selection_query_limit: 3,
            audit_query_limit: 1,
            candidate_lineage: [
              expect.objectContaining({
                round: 1,
                run_id: plan.run_id,
                change_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
              }),
            ],
          }),
          action_center: {
            next_action: "prepare_audit",
            owner: "lead_agent",
            continuation: {
              mode: "automatic",
              owner: "lead_agent",
              reason: "within_locked_authority",
            },
            acceptance: expect.objectContaining({
              status: "accepted",
              accepted: true,
              criteria: [
                expect.objectContaining({
                  id: "hard_gates",
                  status: "satisfied",
                }),
                expect.objectContaining({
                  id: "pareto",
                  status: "satisfied",
                }),
                expect.objectContaining({
                  id: "material_improvement",
                  status: "satisfied",
                }),
              ],
            }),
            attribution: expect.objectContaining({
              primary: null,
              items: expect.arrayContaining([
                expect.objectContaining({
                  id: "human",
                  status: "clear",
                  signals: [],
                }),
              ]),
            }),
            actions: expect.arrayContaining([
              expect.objectContaining({
                id: "prepare_audit",
                available: true,
                recommended: true,
                owner: "lead_agent",
                execution_mode: "automatic",
                requestable: false,
                human_confirmation_required: false,
              }),
              expect.objectContaining({
                id: "generate_candidate",
                available: false,
              }),
            ]),
            task_gateway: {
              request_endpoint: "/dashboard-action-requests",
              audit_endpoint: "/dashboard-action-requests.json",
              evidence_mutation: false,
              eval_mutation: false,
              handoff_mode: "durable_local_ledger",
              can_wake_agent_session: false,
              persists_after_agent_session_end: true,
            },
          },
          review: expect.objectContaining({
            contract: "skill-reviewer.dashboard-review",
            decision: expect.objectContaining({
              status: "inconclusive",
              reason: "audit_required",
              release_eligible: false,
              blocking_scenario_count: 0,
              blocking_gate_count: 0,
            }),
            blockers: [],
            scenarios: [
              expect.objectContaining({
                case_id: "dashboard-case",
                status: "passed",
              }),
            ],
            next_action: "prepare_audit",
            attribution: null,
          }),
          cases: [
            expect.objectContaining({
              id: "dashboard-case",
              prompt: "Write the review.",
              input_files: [],
              status: "passed",
              holdout_visibility: "public",
              arms: expect.arrayContaining([
                expect.objectContaining({
                  id: "with_skill",
                  passed: true,
                  executions: expect.arrayContaining([
                    expect.objectContaining({
                      repeat: 1,
                      status: "completed",
                      binding_error_count: 0,
                      execution_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
                      trace: expect.objectContaining({
                        artifact: "agent-trace.jsonl",
                        valid: true,
                        complete: true,
                        events: expect.arrayContaining([
                          expect.objectContaining({
                            event_id: "event-0002-with_skill-1-artifact",
                            kind: "artifact_written",
                            artifact_refs: ["outputs/review.md"],
                          }),
                        ]),
                      }),
                    }),
                  ]),
                }),
                expect.objectContaining({ id: "old_skill", passed: false }),
              ]),
            }),
          ],
          diffs: [
            expect.objectContaining({
              id: expect.stringMatching(/^[a-f0-9]{24}$/),
              path: "SKILL.md",
              status: "modified",
              old_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
              new_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
              binary: false,
              render_mode: "lazy",
              content_url: expect.stringMatching(
                /^\/dashboard-diffs\/[a-f0-9]{24}\.json$/,
              ),
              payload_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          ],
        }),
      );
      expect(data.diffs[0]).not.toHaveProperty("old_content");
      expect(data.diffs[0]).not.toHaveProperty("new_content");
      const payloadPath = join(workspace, data.diffs[0].content_url.slice(1));
      expect(sha256(payloadPath)).toBe(data.diffs[0].payload_digest);
      const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
      expect(payload).toEqual(
        expect.objectContaining({
          contract: "skill-reviewer.dashboard-diff",
          id: data.diffs[0].id,
          path: "SKILL.md",
          old_content: expect.stringContaining("Accepted comparison baseline"),
          new_content: expect.stringContaining("Exercise executable evals"),
        }),
      );
      expect(data.spine.map((node) => node.kind)).toEqual(
        expect.arrayContaining(["run", "gate", "iteration", "case", "assertion", "artifact"]),
      );
      const caseNodeIndex = data.spine.findIndex(
        (node) => node.id === "case:dashboard-case",
      );
      const scopedGates = data.spine.filter(
        (node) => node.kind === "gate" && node.case_id === "dashboard-case",
      );
      expect(caseNodeIndex).toBeGreaterThan(-1);
      expect(scopedGates.length).toBeGreaterThan(0);
      for (const gate of scopedGates) {
        expect(gate.parent_id).toBe("case:dashboard-case");
        expect(data.spine.indexOf(gate)).toBeGreaterThan(caseNodeIndex);
      }
      expect(data.spine).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "assertion:dashboard-case:with_skill:1:review-exists",
            path: "cases/dashboard-case/with_skill/repeat-1/outputs/review.md",
            assertion_rule: expect.objectContaining({
              severity: "must_pass",
              artifact: "outputs/review.md",
            }),
            assertion_evidence: expect.objectContaining({
              exists: true,
              source_event_ids: ["event-0002-with_skill-1-artifact"],
            }),
            content_url: expect.stringMatching(
              /^\/dashboard-evidence\/[a-f0-9]{24}\.json$/,
            ),
            content_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            content_size: 9,
          }),
          expect.objectContaining({
            kind: "artifact",
            label: "review.md",
            content_url: expect.stringMatching(
              /^\/dashboard-evidence\/[a-f0-9]{24}\.json$/,
            ),
          }),
        ]),
      );
    });
  });

  it("keeps oversized diff content out of the read model and lazy sidecars", () => {
    fixture((root) => {
      const testCase = minimalCase({ id: "large-diff", split: "selection" });
      const { manifest, subject } = writeMinimalPackage(root, {
        cases: [testCase],
      });
      const baselinePath = join(root, "accepted-baseline");
      write(
        baselinePath,
        "SKILL.md",
        "---\nname: demo-skill\ndescription: Accepted baseline.\n---\n",
      );
      const largeSize = 600 * 1024;
      write(subject, "references/large.txt", `${"n".repeat(largeSize)}\n`);
      write(baselinePath, "references/large.txt", `${"o".repeat(largeSize)}\n`);
      const workspace = join(root, "large-diff-run");
      const compiled = compile({
        manifest,
        subject,
        workspace,
        baselineKind: "old_skill",
        baselinePath,
        splits: ["selection"],
      });
      expect(compiled.status, compiled.stderr).toBe(0);

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
      const largeDiff = data.diffs.find(
        (item) => item.path === "references/large.txt",
      );
      expect(largeDiff).toEqual(
        expect.objectContaining({
          render_mode: "summary",
          content_url: null,
          payload_digest: null,
          old_size: largeSize + 1,
          new_size: largeSize + 1,
        }),
      );
      expect(largeDiff).not.toHaveProperty("old_content");
      expect(largeDiff).not.toHaveProperty("new_content");
      expect(
        existsSync(join(workspace, "dashboard-diffs", `${largeDiff.id}.json`)),
      ).toBe(false);
      expect(statSync(join(workspace, "dashboard-data.json")).size).toBeLessThan(
        100 * 1024,
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

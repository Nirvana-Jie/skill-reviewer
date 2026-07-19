// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App, { EvidenceDashboard } from "./App";
import DiffViewer from "./DiffViewer";
import { agentDispatchReceiptFixture } from "./test-fixtures";
import type { DashboardData } from "./types";
import {
  preferenceStorageKeys,
  UiPreferencesProvider,
  useUiPreferences,
} from "./ui-preferences";
import { workspaceLayoutStorageKey } from "./workspace-layout";
import { validateAndMigrateDashboardData } from "./dashboard-schema";

const {
  workerProviderSpy,
  workerRenderOptionsSpy,
  diffWorkerFactorySpy,
  diffOptionsSpy,
} = vi.hoisted(() => ({
  workerProviderSpy: vi.fn(),
  workerRenderOptionsSpy: vi.fn().mockResolvedValue(undefined),
  diffWorkerFactorySpy: vi.fn(),
  diffOptionsSpy: vi.fn(),
}));

vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: ({
    newFile,
    options,
  }: {
    newFile: { name: string };
    options: Record<string, unknown>;
  }) => {
    diffOptionsSpy(options);
    return <div>Rendered diff {newFile.name}</div>;
  },
  Virtualizer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WorkerPoolContextProvider: ({
    children,
    poolOptions,
    highlighterOptions,
  }: {
    children: ReactNode;
    poolOptions: { workerFactory: () => unknown };
    highlighterOptions: Record<string, unknown>;
  }) => {
    workerProviderSpy({ poolOptions, highlighterOptions });
    poolOptions.workerFactory();
    return <div data-testid="worker-pool">{children}</div>;
  },
  useWorkerPool: () => ({ setRenderOptions: workerRenderOptionsSpy }),
}));

vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: class MockDiffWorker {
    constructor() {
      diffWorkerFactorySpy();
    }
  },
}));

function renderWithPreferences(node: ReactNode) {
  return render(
    <UiPreferencesProvider>{node}</UiPreferencesProvider>,
  );
}

function openDisplayPreferences() {
  const trigger = screen.getByRole("button", {
    name: /^(Display preferences|显示偏好)$/,
  });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
}

function traceFixture(arm: string, repeat: number) {
  const base = {
    contract: "skill-reviewer.agent-trace-event" as const,
    run_id: "run-product-test",
    case_id: "selection-quality",
    arm,
    repeat,
    artifact_refs: [] as string[],
  };
  return {
    artifact: "agent-trace.jsonl",
    digest: String(repeat || 1).repeat(64),
    capture_source: "harness_native" as const,
    source_trace_required: false,
    complete: true,
    valid: true,
    event_count: 3,
    started_at: "2026-07-16T00:00:00.000Z",
    finished_at: "2026-07-16T00:00:00.020Z",
    duration_ms: 20,
    events: [
      {
        ...base,
        event_id: `${arm}-${repeat}-start`,
        sequence: 1,
        occurred_at: "2026-07-16T00:00:00.000Z",
        elapsed_ms: 0,
        kind: "execution_started" as const,
        status: "running",
        summary: "Agent execution started",
        details: { capture_source: "harness_native" },
      },
      {
        ...base,
        event_id: `${arm}-${repeat}-tool`,
        sequence: 2,
        occurred_at: "2026-07-16T00:00:00.010Z",
        elapsed_ms: 10,
        kind: "tool_call" as const,
        status: "completed",
        summary: "Read the Skill instructions",
        details: { tool: "read", path: "SKILL.md" },
      },
      {
        ...base,
        event_id: `${arm}-${repeat}-finish`,
        sequence: 3,
        occurred_at: "2026-07-16T00:00:00.020Z",
        elapsed_ms: 20,
        kind: "execution_finished" as const,
        status: "completed",
        summary: "Agent execution finished",
        details: {},
      },
    ],
  };
}

function dispatchFixture(arm: string, repeat: number) {
  return agentDispatchReceiptFixture({
    digest: String(repeat + 6).repeat(64),
    dispatch_id: `dispatch-${arm}-${repeat}`,
    worker_id: `worker-${arm}-${repeat}`,
    batch_id: `batch-selection-quality-${repeat}`,
  });
}

function validMeasurement(repeats: number) {
  return {
    status: "valid" as const,
    oracle: {
      status: "valid" as const,
      required_text_assertions: 1,
      calibrated_text_assertions: 1,
      checks: [],
      reasons: [],
    },
    sampling: {
      status: "valid" as const,
      repeats,
      pairing: "paired",
      source: "explicit",
      direction_disagreement: false,
    },
    reasons: [],
  };
}

function WorkerPoolThemeHarness() {
  const { setTheme } = useUiPreferences();
  return (
    <>
      <button type="button" onClick={() => setTheme("dark")}>
        Use dark worker theme
      </button>
      <DiffViewer diffs={data.diffs} enableWorkerPool />
    </>
  );
}

const localSession = "session_token_abcdefghijklmnopqrstuvwxyz123456";

beforeEach(() => {
  window.history.replaceState(
    {},
    "",
    `/skill-reviewer/#session=${localSession}`,
  );
  window.localStorage.clear();
  document.title = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-font-scale");
  document.documentElement.removeAttribute("lang");
  document.documentElement.style.removeProperty("color-scheme");
  document.documentElement.style.removeProperty("--ui-scale");
  document.documentElement.style.removeProperty("--ui-scale-inverse");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  workerProviderSpy.mockClear();
  workerRenderOptionsSpy.mockClear();
  diffWorkerFactorySpy.mockClear();
  diffOptionsSpy.mockClear();
  window.localStorage.clear();
  document.title = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-font-scale");
  document.documentElement.removeAttribute("lang");
  document.documentElement.style.removeProperty("color-scheme");
  document.documentElement.style.removeProperty("--ui-scale");
  document.documentElement.style.removeProperty("--ui-scale-inverse");
  window.history.replaceState({}, "", "/");
});

const data: DashboardData = {
  contract: "skill-reviewer.dashboard-data",
  generated_at: null,
  refresh_interval_ms: 3000,
  run: {
    id: "run-product-test",
    status: "awaiting-audit",
    verification_level: "regression-verified",
    manifest: { path: "/skills/candidate/evals/evals.json", digest: "e".repeat(64) },
    subject: { path: "/skills/candidate", digest: "a".repeat(64) },
    baseline: { kind: "old_skill", path: "/skills/accepted", digest: "b".repeat(64) },
    splits: ["selection", "audit"],
    execution_profile: {
      target: "native-agent",
      harness: "lead-agent-dispatch",
      dispatch_observation: "host_dispatch",
      trace: { capture_source: "harness_native", source: null },
      capabilities: ["filesystem", "shell"],
      isolation: "trusted-orchestrator",
      sampling: { policy: "orchestrator-default" },
      digest: "d".repeat(64),
    },
    holdout: { visibility: "public", issuer: null, digest: null },
    evidence_scope: "public-calibration",
    release_eligible: false,
    integrity: { locked: true, verified: true, plan_digest: "c".repeat(64) },
    measurement: {
      status: "valid",
      cases: [
        { case_id: "selection-quality", ...validMeasurement(3) },
        { case_id: "public-safety-audit", ...validMeasurement(1) },
      ],
      reasons: [],
    },
  },
  summary: {
    case_count: 2,
    candidate_passed: 1,
    candidate_failed: 1,
    hard_gates_passed: 3,
    hard_gates_total: 4,
    decision_status: "accepted",
    current_round: 2,
    max_rounds: 3,
    selection_queries: 2,
    audit_queries: 0,
    rejected_candidates: 1,
    continuity_epoch: 1,
  },
  evolution: {
    active_query: null,
    selection_query_limit: 3,
    audit_query_limit: 1,
    candidate_lineage: [
      {
        round: 1,
        run_id: "run-product-test-round-1",
        parent_digest: "b".repeat(64),
        candidate_digest: "a".repeat(64),
        change: { added: ["references/new.md"], removed: [], modified: ["SKILL.md"] },
        change_digest: "e".repeat(64),
        continuity: "continue",
        continuity_epoch: 1,
      },
      {
        round: 2,
        run_id: "run-product-test",
        parent_digest: "b".repeat(64),
        candidate_digest: "a".repeat(64),
        change: { added: [], removed: [], modified: ["SKILL.md"] },
        change_digest: "f".repeat(64),
        continuity: "continue",
        continuity_epoch: 1,
      },
    ],
    rejected_candidates: [{ round: 1, status: "no-change" }],
  },
  action_center: {
    next_action: "prepare_audit",
    owner: "lead_agent",
    continuation: {
      mode: "automatic",
      owner: "lead_agent",
      reason: "within_locked_authority",
    },
    acceptance: {
      status: "accepted",
      accepted: true,
      decision_run_id: "run-product-test",
      objectives: [
        {
          case_id: "selection-quality",
          id: "quality",
          metric: "quality_score",
          direction: "maximize",
          primary: true,
          delta: 0.2,
          paired_deltas: [0.2, 0.2],
          repeat_count: 2,
          non_regression_tolerance: 0.05,
          min_material_delta: 0.1,
          non_regressed: true,
          materially_improved: true,
        },
      ],
      criteria: [
        {
          id: "hard_gates",
          status: "satisfied",
          passed: 4,
          total: 4,
          evidence_ids: ["gate:safety"],
        },
        {
          id: "pareto",
          status: "satisfied",
          passed: 1,
          total: 1,
          evidence_ids: ["case:selection-quality"],
        },
        {
          id: "material_improvement",
          status: "satisfied",
          passed: 1,
          total: 1,
          evidence_ids: ["case:selection-quality"],
        },
      ],
    },
    attribution: {
      primary: null,
      items: [
        { id: "skill", status: "clear", signals: [], evidence_ids: [] },
        { id: "eval", status: "clear", signals: [], evidence_ids: [] },
        {
          id: "execution_environment",
          status: "clear",
          signals: [],
          evidence_ids: [],
        },
        { id: "evidence", status: "clear", signals: [], evidence_ids: [] },
        {
          id: "human",
          status: "clear",
          signals: [],
          evidence_ids: [],
        },
      ],
    },
  },
  review: {
    contract: "skill-reviewer.dashboard-review",
    decision: {
      status: "blocked",
      reason: "scenario_failed",
      release_eligible: false,
      blocking_scenario_count: 1,
      blocking_gate_count: 0,
    },
    blockers: [
      {
        id: "blocker:public-safety-audit",
        kind: "scenario",
        case_id: "public-safety-audit",
        status: "failed",
        gate_ids: [],
        failed_check_ids: [],
        missing_artifact_ids: [],
        source_evidence_ids: [],
        criterion_ids: [],
        evidence_ids: ["case:public-safety-audit"],
        attribution: null,
        next_action: "prepare_audit",
      },
    ],
    safeguards: {
      passed_gate_ids: ["gate:safety"],
      passed_case_ids: ["case:selection-quality"],
    },
    scenarios: [
      {
        case_id: "selection-quality",
        status: "passed",
        gate_ids: [],
        check_ids: [],
        artifact_ids: ["artifact:review"],
      },
      {
        case_id: "public-safety-audit",
        status: "failed",
        gate_ids: [],
        check_ids: [],
        artifact_ids: [],
      },
    ],
    next_action: "prepare_audit",
    attribution: null,
  },
  cases: [
    {
      id: "selection-quality",
      purpose: "Measure release quality.",
      prompt: "Review the candidate Skill and decide whether it is ready.",
      input_files: [],
      split: "selection",
      determinism: "stochastic",
      repeats: 3,
      holdout_visibility: "public",
      status: "passed",
      measurement: validMeasurement(3),
      regressed: false,
      direction_disagreement: false,
      missing_objective_metrics: [],
      arms: [
        {
          id: "with_skill",
          complete: true,
          passed: true,
          required_pass_rate: 1,
          forbidden_actions: [],
          side_effects: [],
          binding_errors: [],
          metrics: {},
          assertions: { passed: 3, total: 3 },
          artifact_count: 2,
          executions: [1, 2, 3].map((repeat) => ({
            repeat,
            status: "completed",
            binding_error_count: 0,
            execution_digest: String(repeat).repeat(64),
            artifact_count: repeat === 1 ? 2 : 0,
            assertions: { passed: 1, total: 1 },
            required_pass_rate: 1,
            metrics: {},
            dispatch: dispatchFixture("with_skill", repeat),
            trace: traceFixture("with_skill", repeat),
          })),
        },
        {
          id: "old_skill",
          complete: true,
          passed: true,
          required_pass_rate: 1,
          forbidden_actions: [],
          side_effects: [],
          binding_errors: [],
          metrics: {},
          assertions: { passed: 3, total: 3 },
          artifact_count: 2,
          executions: [1, 2, 3].map((repeat) => ({
            repeat,
            status: "completed",
            binding_error_count: 0,
            execution_digest: String(repeat + 3).repeat(64),
            artifact_count: repeat === 1 ? 2 : 0,
            assertions: { passed: 1, total: 1 },
            required_pass_rate: 1,
            metrics: {},
            dispatch: dispatchFixture("old_skill", repeat),
            trace: traceFixture("old_skill", repeat),
          })),
        },
      ],
      semantic_assertions: [
        {
          id: "blind-quality",
          status: "agreement",
          passed: true,
          preference: "candidate",
          artifact: "semantic/blind-quality.json",
          resolved_winners: ["with_skill", "with_skill"],
          source_event_ids: ["with_skill-1-tool", "missing-semantic-event"],
        },
      ],
    },
    {
      id: "public-safety-audit",
      purpose: "Exercise the public audit release line.",
      prompt: "Audit the Skill without executing destructive instructions.",
      input_files: ["fixtures/SKILL.md"],
      split: "audit",
      determinism: "deterministic",
      repeats: 1,
      holdout_visibility: "public",
      status: "failed",
      measurement: validMeasurement(1),
      regressed: true,
      direction_disagreement: false,
      missing_objective_metrics: [],
      arms: [],
      semantic_assertions: [],
    },
  ],
  diffs: [
    {
      id: "1".repeat(24),
      path: "SKILL.md",
      status: "modified",
      old_digest: "1".repeat(64),
      new_digest: "2".repeat(64),
      old_size: 17,
      new_size: 17,
      binary: false,
      render_mode: "lazy",
      content_url: `/dashboard-diffs/${"1".repeat(24)}.json`,
      payload_digest: "3".repeat(64),
    },
  ],
  spine: [
    {
      id: "run:product-test",
      kind: "run",
      parent_id: null,
      label: "run-product-test",
      status: "awaiting-audit",
    },
    {
      id: "gate:safety",
      kind: "gate",
      parent_id: "run:product-test",
      label: "Safety hard gate",
      status: "passed",
      detail: "No forbidden action observed.",
    },
    {
      id: "case:selection-quality",
      kind: "case",
      parent_id: "run:product-test",
      label: "selection-quality",
      status: "passed",
      split: "selection",
    },
    {
      id: "artifact:review",
      kind: "artifact",
      parent_id: "case:selection-quality",
      label: "response.md",
      status: "retained",
      arm: "with_skill",
      path: "cases/selection-quality/with_skill/repeat-1/outputs/response.md",
    },
    {
      id: "case:public-safety-audit",
      kind: "case",
      parent_id: "run:product-test",
      label: "public-safety-audit",
      status: "failed",
      split: "audit",
    },
  ],
  limitations: ["Audit has not passed."],
};

describe("EvidenceDashboard", () => {
  it("shows an actionable compatibility page for an incomplete projection", async () => {
    const incompatible = structuredClone(data) as DashboardData & {
      action_center: Partial<DashboardData["action_center"]>;
    };
    Reflect.deleteProperty(incompatible.action_center, "continuation");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          contract: "skill-reviewer.dashboard-session",
          run_id: "run-product-test",
          session_transport: "fragment-to-header",
          session_header: "X-Skill-Reviewer-Session",
          evidence_read_only: true,
          eval_mutation: false,
          data_endpoint: "/dashboard-data.json",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => incompatible,
      });
    vi.stubGlobal("fetch", fetchMock);

    renderWithPreferences(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Dashboard data is incompatible",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Regenerate dashboard-data.json with the current skill-reviewer runtime, then refresh this page.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/action_center\.continuation/)).toBeInTheDocument();
  });

  it("rejects malformed nested evidence instead of handing it to React", async () => {
    const incompatible = structuredClone(data) as unknown as Record<string, unknown>;
    const review = incompatible.review as Record<string, unknown>;
    review.blockers = [{}];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          contract: "skill-reviewer.dashboard-session",
          run_id: "run-product-test",
          session_transport: "fragment-to-header",
          session_header: "X-Skill-Reviewer-Session",
          evidence_read_only: true,
          eval_mutation: false,
          data_endpoint: "/dashboard-data.json",
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => incompatible });
    vi.stubGlobal("fetch", fetchMock);

    renderWithPreferences(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Dashboard data is incompatible",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/review\.blockers\[0\]\.id/)).toBeInTheDocument();
  });

  it("rejects fractional schema versions instead of silently relabeling them", async () => {
    const incompatible = { ...structuredClone(data), schema_version: 1.5 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          contract: "skill-reviewer.dashboard-session",
          run_id: "run-product-test",
          session_transport: "fragment-to-header",
          session_header: "X-Skill-Reviewer-Session",
          evidence_read_only: true,
          eval_mutation: false,
          data_endpoint: "/dashboard-data.json",
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => incompatible });
    vi.stubGlobal("fetch", fetchMock);

    renderWithPreferences(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Dashboard data is incompatible",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/expected an integer version/)).toBeInTheDocument();
  });

  it("validates declared fields inside assertion contracts", () => {
    const incompatible = structuredClone(data);
    incompatible.spine.push({
      id: "assertion:malformed",
      kind: "assertion",
      parent_id: null,
      label: "malformed assertion",
      status: "failed",
      assertion_rule: {
        artifact: {} as unknown as string,
      },
    });

    expect(() => validateAndMigrateDashboardData(incompatible)).toThrow(
      /spine\[\d+\]\.assertion_rule\.artifact/,
    );
  });

  it("rejects objective summaries that are not bound to every paired repeat", () => {
    const incompatible = structuredClone(data);
    incompatible.action_center.acceptance.objectives![0]!.paired_deltas = [0.2];

    expect(() => validateAndMigrateDashboardData(incompatible)).toThrow(
      /paired_deltas: must contain one delta for every paired repeat/,
    );
  });

  it("rejects identity, ordering, and timing contradictions in valid Traces", () => {
    expect(() => validateAndMigrateDashboardData(structuredClone(data))).not.toThrow();

    const wrongArm = structuredClone(data);
    wrongArm.cases[0]!.arms[0]!.executions![0]!.trace!.events[1]!.arm =
      "old_skill";
    expect(() => validateAndMigrateDashboardData(wrongArm)).toThrow(
      /events\[1\]\.arm: must match its arm/,
    );

    const brokenSequence = structuredClone(data);
    brokenSequence.cases[0]!.arms[0]!.executions![0]!.trace!.events[1]!.sequence =
      3;
    expect(() => validateAndMigrateDashboardData(brokenSequence)).toThrow(
      /events\[1\]\.sequence: must be contiguous/,
    );

    const nonMonotonicElapsed = structuredClone(data);
    nonMonotonicElapsed.cases[0]!.arms[0]!.executions![0]!.trace!.events[1]!.elapsed_ms =
      10;
    nonMonotonicElapsed.cases[0]!.arms[0]!.executions![0]!.trace!.events[2]!.elapsed_ms =
      5;
    expect(() => validateAndMigrateDashboardData(nonMonotonicElapsed)).toThrow(
      /events\[2\]\.elapsed_ms: must be monotonic/,
    );

    const duplicateEventId = structuredClone(data);
    duplicateEventId.cases[0]!.arms[0]!.executions![0]!.trace!.events[1]!.event_id =
      duplicateEventId.cases[0]!.arms[0]!.executions![0]!.trace!.events[0]!.event_id;
    expect(() => validateAndMigrateDashboardData(duplicateEventId)).toThrow(
      /events\[1\]\.event_id: expected a unique event id/,
    );

    const mismatchedDuration = structuredClone(data);
    mismatchedDuration.cases[0]!.arms[0]!.executions![0]!.trace!.duration_ms = 21;
    expect(() => validateAndMigrateDashboardData(mismatchedDuration)).toThrow(
      /duration_ms: must match the final event/,
    );
  });

  it("keeps the last verified projection visible when a refresh fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          contract: "skill-reviewer.dashboard-session",
          run_id: "run-product-test",
          session_transport: "fragment-to-header",
          session_header: "X-Skill-Reviewer-Session",
          evidence_read_only: true,
          eval_mutation: false,
          data_endpoint: "/dashboard-data.json",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => data,
      })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    renderWithPreferences(<App />);

    expect(
      (await screen.findAllByText("Independent issues to address: 1")).length,
    ).toBeGreaterThan(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh dashboard now" }),
    );
    expect(await screen.findByText("Last refresh failed")).toBeInTheDocument();
    expect(
      screen.getAllByText("Independent issues to address: 1").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Stale")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh dashboard now" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("shows a failed candidate criterion as its own actionable blocker", () => {
    const criterionData = structuredClone(data);
    criterionData.action_center.next_action = "propose_candidate";
    criterionData.action_center.acceptance.accepted = false;
    criterionData.action_center.acceptance.status = "rejected";
    criterionData.action_center.acceptance.criteria = [
      {
        id: "hard_gates",
        status: "satisfied",
        passed: 4,
        total: 4,
        evidence_ids: ["gate:safety"],
      },
      {
        id: "pareto",
        status: "satisfied",
        passed: 1,
        total: 1,
        evidence_ids: ["case:selection-quality"],
      },
      {
        id: "material_improvement",
        status: "failed",
        passed: 0,
        total: 1,
        evidence_ids: ["case:selection-quality"],
      },
    ];
    criterionData.review = {
      ...criterionData.review,
      decision: {
        ...criterionData.review.decision,
        reason: "candidate_acceptance_failed",
        blocking_scenario_count: 0,
        blocking_gate_count: 0,
      },
      blockers: [
        {
          id: "blocker:criterion:material_improvement",
          kind: "criterion",
          case_id: null,
          status: "failed",
          gate_ids: [],
          failed_check_ids: [],
          missing_artifact_ids: [],
          source_evidence_ids: [],
          criterion_ids: ["material_improvement"],
          evidence_ids: ["case:selection-quality"],
          attribution: "skill",
          next_action: "propose_candidate",
        },
      ],
      next_action: "propose_candidate",
      attribution: "skill",
    };

    renderWithPreferences(
      <EvidenceDashboard data={criterionData} connectionState="live" />,
    );

    expect(
      screen.getAllByText("Repeat-consistent material improvement").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText("0/1 checks satisfied; this condition failed."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Review the evidence for this problem" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("blocker:criterion:material_improvement"),
    ).not.toBeInTheDocument();
  });

  it("does not use success semantics when evidence is incomplete without known blockers", () => {
    const incompleteData = structuredClone(data);
    incompleteData.review.decision = {
      status: "ready",
      reason: "evidence_incomplete",
      release_eligible: false,
      blocking_scenario_count: 0,
      blocking_gate_count: 0,
    };
    incompleteData.review.blockers = [];
    incompleteData.summary.case_count = 1;
    incompleteData.summary.candidate_passed = 1;
    incompleteData.summary.candidate_failed = 0;
    incompleteData.summary.hard_gates_passed = 0;
    incompleteData.summary.hard_gates_total = 0;

    const { container } = renderWithPreferences(
      <EvidenceDashboard data={incompleteData} connectionState="live" />,
    );

    const evidenceGap = screen.getByRole("status", {
      name: "No known blocker was found, but release evidence is incomplete",
    });
    expect(evidenceGap).toHaveClass("tone-warn");
    expect(evidenceGap).not.toHaveClass("tone-good");
    expect(evidenceGap).toHaveTextContent("Release is not ready");
    expect(container.querySelector(".review-no-blockers.tone-good")).toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Evidence integrity failed — Skill not judged",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Skill not judged").length).toBeGreaterThan(0);
    expect(screen.queryByText("0/0")).not.toBeInTheDocument();
  });

  it("uses the review overview as the single primary decision surface", () => {
    const { container } = renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(
      screen.queryByRole("region", { name: "Behavioral gate state" }),
    ).not.toBeInTheDocument();
    expect(container.querySelectorAll(".review-decision-hero")).toHaveLength(1);
    expect(container.querySelector(".run-summary")).toBeNull();
    expect(container.querySelector(".canvas-context span")).toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "Evidence details" }),
    ).not.toBeInTheDocument();
    const objective = screen.getByRole("region", {
      name: "What changed in measured behavior",
    });
    expect(within(objective).getByText("+0.2 · +0.2")).toBeInTheDocument();
    expect(
      within(objective).getByText("Material gain in every paired repeat"),
    ).toBeInTheDocument();
  });

  it("uses four task-based views and reserves raw evidence navigation for the evidence archive", () => {
    const { container } = renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(
      screen.getAllByRole("tab").map((tab) => tab.textContent),
    ).toEqual(["Review", "Changes (1)", "Runs", "Evidence archive"]);
    expect(container.querySelector("#case-rail")).toHaveAttribute("hidden");
    expect(container.querySelector("#evidence-inspector")).toHaveAttribute(
      "hidden",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Evidence archive" }));
    expect(container.querySelector("#case-rail")).not.toHaveAttribute("hidden");
    expect(
      screen.getByRole("heading", { name: "Complete audit record" }),
    ).toBeInTheDocument();
  });

  it("opens selected evidence in a contextual drawer without leaving Review", () => {
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    const opener = screen.getByRole("button", {
      name: "Review the evidence for this problem",
    });
    opener.focus();
    fireEvent.click(opener);

    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const drawer = screen.getByRole("dialog", { name: "Evidence inspector" });
    expect(drawer).toBeInTheDocument();
    expect(drawer).not.toHaveAttribute("aria-modal");
    expect(within(drawer).queryByText("Limitations")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "close" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Evidence inspector" }),
    ).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    fireEvent.click(
      screen.getByRole("button", { name: "Review the evidence for this problem" }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    expect(
      screen.queryByRole("dialog", { name: "Evidence inspector" }),
    ).not.toBeInTheDocument();
  });

  it("turns a full-width mobile evidence drawer into a focus-contained modal", () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });

    try {
      renderWithPreferences(
        <EvidenceDashboard data={data} connectionState="live" />,
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "Review the evidence for this problem",
        }),
      );

      const drawer = screen.getByRole("dialog", {
        name: "Evidence inspector",
      });
      const closeButton = within(drawer).getByRole("button", { name: "close" });
      expect(drawer).toHaveAttribute("aria-modal", "true");
      expect(drawer).toHaveClass("is-modal");

      closeButton.focus();
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(drawer).toContainElement(document.activeElement as HTMLElement);
      expect(closeButton).not.toHaveFocus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(closeButton).toHaveFocus();
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth,
      });
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("coordinates drawers and command search as a single modal layer", async () => {
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Review the evidence for this problem",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Evidence inspector" }),
    ).toBeInTheDocument();

    const preferencesTrigger = screen.getByRole("button", {
      name: "Display preferences",
    });
    fireEvent.click(preferencesTrigger);
    expect(
      screen.queryByRole("dialog", { name: "Evidence inspector" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Display preferences" }),
    ).toBeInTheDocument();
    expect(preferencesTrigger).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Review the evidence for this problem",
      }),
    );

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    let commandDialog = await screen.findByRole("dialog", {
      name: "Go to evidence",
    });
    expect(
      screen.queryByRole("dialog", { name: "Evidence inspector" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.keyDown(commandDialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");

    openDisplayPreferences();
    const preferencesDialog = screen.getByRole("dialog", {
      name: "Display preferences",
    });
    fireEvent.keyDown(
      within(preferencesDialog).getByRole("button", {
        name: "Increase text size",
      }),
      { key: "k", ctrlKey: true },
    );
    commandDialog = await screen.findByRole("dialog", {
      name: "Go to evidence",
    });
    expect(
      screen.queryByRole("dialog", { name: "Display preferences" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(commandDialog, { key: "Escape" });

    openDisplayPreferences();
    window.history.replaceState(
      {},
      "",
      "/skill-reviewer/#panel=evidence&node=case%3Aselection-quality",
    );
    fireEvent.popState(window);
    await screen.findByRole("dialog", { name: "Evidence inspector" });
    expect(
      screen.queryByRole("dialog", { name: "Display preferences" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("restores a Runs deep link without treating its selected case as an open drawer", () => {
    window.history.replaceState(
      {},
      "",
      `/skill-reviewer/#session=${localSession}&view=runs&node=case%3Aselection-quality`,
    );

    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(screen.getByRole("tab", { name: "Runs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.queryByRole("dialog", { name: "Evidence inspector" }),
    ).not.toBeInTheDocument();
  });

  it("links the decision evidence spine directly to change and execution evidence", () => {
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(
      screen.getByRole("region", { name: "Decision evidence" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Review change evidence" }),
    );
    expect(screen.getByRole("tab", { name: "Changes (1)" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Review execution evidence" }),
    );
    expect(screen.getByRole("tab", { name: "Runs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("does not treat complete trace capture as verified release evidence", () => {
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    const executionEvidence = screen.getByRole("button", {
      name: "Review execution evidence",
    });
    expect(executionEvidence).toHaveClass("tone-warn");
    expect(executionEvidence).not.toHaveClass("tone-good");
    expect(executionEvidence).toHaveTextContent("Release evidence is incomplete");
  });

  it("keeps the next action as read-only decision support", () => {
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(screen.queryByRole("tab", { name: "Next steps" })).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Prepare and bind the release audit").length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "Review next steps" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Next steps" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("treats an empty diff as missing change evidence rather than proof of no change", () => {
    const noDiffData = structuredClone(data);
    noDiffData.diffs = [];
    renderWithPreferences(
      <EvidenceDashboard data={noDiffData} connectionState="live" />,
    );

    expect(
      screen.getByRole("tab", { name: "Changes" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No change evidence captured")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Review change evidence" }),
    );
    expect(
      screen.getByRole("heading", { name: "No change evidence captured" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The projection contains no change artifact. This is an evidence gap, not proof that nothing changed.",
      ),
    ).toBeInTheDocument();
  });

  it("removes zero-count stage filters", () => {
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(
      screen.queryByRole("button", { name: "Development validation; 0 cases" }),
    ).not.toBeInTheDocument();
  });

  it("collapses browsing controls and lifecycle teaching for a single scenario", () => {
    const singleCaseData = structuredClone(data);
    singleCaseData.cases = [singleCaseData.cases[0]];
    singleCaseData.summary.case_count = 1;
    renderWithPreferences(
      <EvidenceDashboard data={singleCaseData} connectionState="live" />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Evidence archive" }));

    expect(screen.queryByRole("searchbox", { name: "Search cases" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Scenario result" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Single scenario · Candidate selection" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Evolution details").closest("details")).not.toHaveAttribute("open");
  });

  it("exposes live release evidence without direct execution controls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contract: "skill-reviewer.dashboard-diff",
        id: "1".repeat(24),
        path: "SKILL.md",
        old_digest: "1".repeat(64),
        new_digest: "2".repeat(64),
        old_content: "old instructions\n",
        new_content: "new instructions\n",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(screen.getAllByText("run-product-test").length).toBeGreaterThan(0);
    expect(screen.getByText("regression-verified")).toBeInTheDocument();
    expect(screen.getAllByText("public-calibration").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", {
        name: "Evidence integrity failed — Skill not judged",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("2 / 3").length).toBeGreaterThan(0);
    expect(screen.getByText(/continuity epoch 1/)).toBeInTheDocument();
    expect(screen.getAllByText("Release quality selection").length).toBeGreaterThan(0);
    expect(screen.queryByText("selection-quality")).not.toBeInTheDocument();
    expect(screen.getAllByText("Why this failed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("What to do next").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "Evidence archive" }));
    expect(
      screen.getByRole("group", { name: "Evaluation lifecycle" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "All evaluation stages; 2 cases",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText(
        "This combines development validation, candidate selection, and release audit for browsing. All cases is a view, not a fourth stage.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "What the Agent does automatically",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "The dashboard does not run an Agent by itself. It creates a bound request that the lead Agent can safely consume.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /execute|approve|run eval/i })).not.toBeInTheDocument();
    const failedCaseRow = screen
      .getByRole("button", {
        name: "Review scenario result: Public safety audit",
      })
      .closest(".evidence-row");
    expect(failedCaseRow?.querySelector('[data-evidence-icon="circle-x"]')).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    expect(
      screen.getByRole("heading", { name: "Agent execution records" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Eval case run index" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Release quality selection" }),
    );
    expect(screen.queryByText("Fully bound")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Execution matrix" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Host-observed native subagent")).toBeInTheDocument();
    expect(
      screen.getByText("Lead Agent dispatches; the Eval worker executes"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Candidate under review · Repeat 2 · completed/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Comparison condition · Repeat 2 · completed/,
      }),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("region", { name: "Blind semantic judge" }),
      ).getByText(/1 linked Trace events/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Observable execution, not private chain-of-thought"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    fireEvent.click(screen.getByRole("tab", { name: "Evidence archive" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Release audit; 1 cases" }),
    );
    expect(
      screen.getByText(
        "Check generalization once without teaching the optimizer",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This run uses public calibration evidence. It tests audit behavior but cannot authorize release by itself.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Public safety audit").length).toBeGreaterThan(0);
    expect(screen.queryByText("selection-quality")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "All evaluation stages; 2 cases" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Release quality selection · passed",
      }),
    );
    expect(screen.getByText("Semantic evidence")).toBeInTheDocument();
    expect(screen.getByText("Blind quality comparison")).toBeInTheDocument();
    expect(screen.getByText(/preference candidate/)).toBeInTheDocument();
    expect(screen.getByText("native-agent")).toBeInTheDocument();
    expect(screen.getByText("lead-agent-dispatch")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Changes (1)" }));
    expect(await screen.findByText("Rendered diff SKILL.md")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Filter changed files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Split diff" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        `/dashboard-diffs/${"1".repeat(24)}.json`,
        window.location.origin,
      ).href,
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(screen.getByText("modified")).toBeInTheDocument();
    expect(diffOptionsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        diffStyle: "split",
        overflow: "scroll",
        disableFileHeader: true,
        lineDiffType: "word-alt",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Unified diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Wrap lines" }));
    expect(diffOptionsSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ diffStyle: "unified", overflow: "wrap" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Enter diff focus mode" }));
    expect(container.querySelector(".app-shell")).toHaveClass("is-focus-mode");
    expect(
      screen.getByRole("button", { name: "Exit diff focus mode" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Evidence archive" }));
    expect(container.querySelector(".app-shell")).not.toHaveClass("is-focus-mode");
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Release quality selection" }),
    );
    const inspectorBody = container.querySelector<HTMLElement>(".inspector-body");
    if (!inspectorBody) throw new Error("inspector body is missing");
    inspectorBody.scrollTop = 240;
    fireEvent.click(
      screen.getByRole("button", { name: /Read source evidence: Agent final response/i }),
    );
    expect(inspectorBody.scrollTop).toBe(0);
    expect(
      screen.getAllByText(
        "cases/selection-quality/with_skill/repeat-1/outputs/response.md",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("renders completed lifecycle events independently from failed check results", () => {
    const semanticData = structuredClone(data);
    const execution = semanticData.cases
      .find((item) => item.id === "selection-quality")
      ?.arms.find((arm) => arm.id === "with_skill")
      ?.executions?.find((item) => item.repeat === 1);
    const checkEvent = execution?.trace?.events.find(
      (event) => event.kind === "tool_call",
    );
    if (!checkEvent) throw new Error("trace fixture is missing its check event");
    checkEvent.summary = "Static analysis completed with findings";
    checkEvent.details = {
      static_analysis_passed: false,
      error_count: 4,
    };

    const { container } = renderWithPreferences(
      <EvidenceDashboard data={semanticData} connectionState="live" />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Release quality selection" }),
    );

    expect(
      screen
        .getByText("Static analysis completed with findings")
        .closest(".agent-event"),
    ).toHaveClass("is-bad");
    expect(
      screen.getByText("Agent execution finished").closest(".agent-event"),
    ).toHaveClass("is-neutral");
    expect(container.querySelectorAll(".agent-event.is-good")).toHaveLength(0);
  });

  it("puts anomalies first and the execution matrix before drill-down plumbing", () => {
    const attentionData = structuredClone(data);
    const execution = attentionData.cases
      .find((item) => item.id === "selection-quality")
      ?.arms.find((arm) => arm.id === "with_skill")
      ?.executions?.find((item) => item.repeat === 1);
    if (!execution?.trace) throw new Error("trace fixture is missing");
    execution.trace.duration_ms = 6000;
    execution.trace.events[1]!.details = {
      static_analysis_passed: false,
      error_count: 4,
    };

    renderWithPreferences(
      <EvidenceDashboard data={attentionData} connectionState="live" />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));

    const attention = screen.getByRole("region", {
      name: "Trace attention summary",
    });
    expect(within(attention).getByText("Failures")).toBeInTheDocument();
    expect(within(attention).getByText("Slow executions")).toBeInTheDocument();
    const matrix = screen.getByRole("heading", { name: "Execution matrix" });
    expect(
      attention.compareDocumentPosition(matrix) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const timeline = screen.getByText("Observable event timeline");
    expect(
      matrix.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });


  it("explains automatic continuation when the completed stage has no blockers", () => {
    const automaticData: DashboardData = structuredClone(data);
    automaticData.review.decision = {
      status: "inconclusive",
      reason: "audit_required",
      release_eligible: false,
      blocking_scenario_count: 0,
      blocking_gate_count: 0,
    };
    automaticData.review.blockers = [];

    renderWithPreferences(
      <EvidenceDashboard data={automaticData} connectionState="live" />,
    );

    const evidenceCoverage = screen.getByRole("button", {
      name: "Review execution evidence",
    });
    expect(evidenceCoverage).toHaveClass("tone-warn");
    expect(evidenceCoverage).toHaveTextContent("Release evidence is incomplete");

    expect(
      screen.getByText(
        "No known blocker remains, but release evidence is incomplete and release is not ready. The lead Agent continues to the next locked evaluation stage automatically.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "No known blocker was found, but release evidence is incomplete",
      ),
    ).not.toHaveLength(0);
  });

  it("does not present release-ready copy when execution evidence is missing", () => {
    const incompleteReadyData: DashboardData = structuredClone(data);
    incompleteReadyData.review.decision = {
      status: "ready",
      reason: "release_conditions_met",
      release_eligible: true,
      blocking_scenario_count: 0,
      blocking_gate_count: 0,
    };
    incompleteReadyData.review.blockers = [];
    for (const item of incompleteReadyData.cases) {
      for (const arm of item.arms) arm.executions = [];
    }

    const { container } = renderWithPreferences(
      <EvidenceDashboard data={incompleteReadyData} connectionState="live" />,
    );

    expect(
      screen.queryByRole("heading", { name: "Ready for release confirmation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Evidence integrity failed — Skill not judged",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Review execution evidence" }),
    ).toHaveClass("tone-warn");
    expect(container.querySelector('a[href="#review-decision-title"]')).toBeNull();
  });

  it("shows validity in decision order and suppresses candidate quality when measurement is invalid", () => {
    const invalidMeasurementData: DashboardData = structuredClone(data);
    if (!invalidMeasurementData.run.measurement) {
      throw new Error("measurement fixture is missing");
    }
    invalidMeasurementData.run.measurement.status = "invalid";
    invalidMeasurementData.run.measurement.reasons = [
      "assertion_calibration_failed:release-copy",
    ];

    renderWithPreferences(
      <EvidenceDashboard data={invalidMeasurementData} connectionState="live" />,
    );

    const validity = screen.getByRole("region", {
      name: "Decision validity",
    });
    expect(within(validity).getByText("Evidence integrity")).toBeInTheDocument();
    expect(within(validity).getByText("Measurement validity")).toBeInTheDocument();
    expect(within(validity).getByText("Candidate quality")).toBeInTheDocument();
    expect(within(validity).getByText("Skill not judged")).toBeInTheDocument();
    expect(
      within(validity).queryByText("Accepted by selection"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Measurement validity" }),
    ).not.toBeInTheDocument();
  });

  it("suppresses candidate success across the primary decision when evidence integrity is invalid", () => {
    const invalidEvidenceData: DashboardData = structuredClone(data);
    invalidEvidenceData.review.decision = {
      status: "inconclusive",
      reason: "audit_required",
      release_eligible: false,
      blocking_scenario_count: 0,
      blocking_gate_count: 0,
    };
    invalidEvidenceData.review.blockers = [];
    invalidEvidenceData.action_center.acceptance.accepted = true;
    invalidEvidenceData.action_center.acceptance.status = "accepted";
    invalidEvidenceData.run.integrity = {
      locked: true,
      verified: false,
      plan_digest: "c".repeat(64),
    };

    renderWithPreferences(
      <EvidenceDashboard data={invalidEvidenceData} connectionState="live" />,
    );

    const decision = screen.getByRole("heading", {
      name: "Evidence integrity failed — Skill not judged",
    });
    const hero = decision.closest(".review-decision-hero");
    expect(hero).not.toBeNull();
    expect(hero).toHaveTextContent("Skill not judged");
    expect(hero).not.toHaveTextContent("Candidate passed");
    expect(hero).not.toHaveTextContent("Cases passed");
    expect(hero).not.toHaveTextContent("1/2");
  });


  it("separates evidence hierarchy disclosure from opening inspector details", () => {
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(
      screen.queryByRole("button", { name: "Collapse Immutable evaluation run" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Evidence archive" }));

    expect(
      screen.getByRole("button", { name: "Collapse Immutable evaluation run" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Expand Release quality selection" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: "Read source evidence: Agent final response" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Showing 4 of 5 evidence nodes")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand Release quality selection" }),
    );
    expect(
      screen.getByRole("button", { name: "Collapse Release quality selection" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Read source evidence: Agent final response" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Showing 5 of 5 evidence nodes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(
      screen.getByRole("button", { name: "Expand Immutable evaluation run" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", {
        name: "Inspect gate basis: Evaluation scenario · hard gate",
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 5 evidence nodes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(
      screen.getByRole("button", { name: "Read source evidence: Agent final response" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand all" })).toBeDisabled();
  });

  it("aligns candidate and baseline evidence side by side by check identity", () => {
    const comparisonData = structuredClone(data);
    comparisonData.spine.push(
      {
        id: "assertion:selection-quality:with_skill:1:release-verdict",
        kind: "assertion",
        parent_id: "case:selection-quality",
        label: "release-verdict",
        status: "passed",
        arm: "with_skill",
        repeat: 1,
        assertion_type: "text_contains",
      },
      {
        id: "assertion:selection-quality:old_skill:1:release-verdict",
        kind: "assertion",
        parent_id: "case:selection-quality",
        label: "release-verdict",
        status: "failed",
        arm: "old_skill",
        repeat: 1,
        assertion_type: "text_contains",
      },
      {
        id: "artifact:selection-quality:with_skill:0",
        kind: "artifact",
        parent_id: "case:selection-quality",
        label: "execution.json",
        status: "retained",
        arm: "with_skill",
        path: "cases/selection-quality/with_skill/repeat-1/execution.json",
      },
      {
        id: "artifact:selection-quality:old_skill:0",
        kind: "artifact",
        parent_id: "case:selection-quality",
        label: "execution.json",
        status: "retained",
        arm: "old_skill",
        path: "cases/selection-quality/old_skill/repeat-1/execution.json",
      },
    );

    renderWithPreferences(
      <EvidenceDashboard data={comparisonData} connectionState="live" />,
    );
    openDisplayPreferences();
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Simplified Chinese" }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "证据档案" }));
    fireEvent.click(
      screen.getByRole("button", { name: "展开 候选质量是否达到发布要求" }),
    );

    const comparison = screen.getByRole("region", {
      name: "候选与对照条件的配对证据",
    });
    expect(within(comparison).getAllByText("待评候选版本").length).toBeGreaterThan(0);
    expect(
      within(comparison).getAllByText("对照条件").length,
    ).toBeGreaterThan(0);
    expect(within(comparison).getAllByText("结果不同").length).toBeGreaterThan(0);
    expect(within(comparison).getAllByText("结果一致").length).toBeGreaterThan(0);
    expect(
      comparison.querySelectorAll(".evidence-comparison-pair").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      comparison.querySelectorAll(".evidence-comparison-cell.is-candidate").length,
    ).toBe(
      comparison.querySelectorAll(".evidence-comparison-cell.is-baseline").length,
    );
  });

  it("turns a retained response into a Chinese reviewer guide with its real input and source content", async () => {
    const evidenceData = structuredClone(data);
    const artifact = evidenceData.spine.find((node) => node.id === "artifact:review");
    if (!artifact) throw new Error("artifact fixture is missing");
    artifact.content_url = `/dashboard-evidence/${"4".repeat(24)}.json`;
    artifact.content_digest = "5".repeat(64);
    artifact.content_size = 72;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contract: "skill-reviewer.dashboard-evidence",
        node_id: artifact.id,
        path: "response.md",
        media_type: "text/markdown",
        content: "# 结论\n当前证据不足，不能声称候选版已经优于旧版。\n",
        digest: artifact.content_digest,
        size: artifact.content_size,
        truncated: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithPreferences(
      <EvidenceDashboard data={evidenceData} connectionState="live" />,
    );
    openDisplayPreferences();
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Simplified Chinese" }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "证据档案" }));
    fireEvent.click(
      screen.getByRole("button", { name: "展开 候选质量是否达到发布要求" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "阅读原始证据：Agent 最终回答" }),
    );

    expect(screen.getByText("为什么要看")).toBeInTheDocument();
    expect(
      screen.getByText("这是 Agent 对评测问题的最终回答，也是多数内容断言实际读取的原始证据。"),
    ).toBeInTheDocument();
    expect(screen.getByText("它读取了什么")).toBeInTheDocument();
    expect(
      screen.getByText("Review the candidate Skill and decide whether it is ready."),
    ).toBeInTheDocument();
    expect(screen.getByText("人工 Review 应该看什么")).toBeInTheDocument();
    expect(screen.getByText("原始证据内容")).toBeInTheDocument();
    expect(
      await screen.findByText(/当前证据不足，不能声称候选版已经优于旧版/),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(artifact.content_url, window.location.origin).href,
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("shows why a gate passed or failed and opens the exact failed check", () => {
    const explainableData = structuredClone(data);
    const selection = explainableData.cases.find(
      (item) => item.id === "selection-quality",
    );
    if (!selection) throw new Error("selection fixture is missing");
    const candidate = selection.arms.find((arm) => arm.id === "with_skill");
    if (!candidate) throw new Error("candidate fixture is missing");
    selection.status = "failed";
    candidate.passed = false;
    candidate.required_pass_rate = 0.75;
    candidate.assertions = { passed: 3, total: 4 };
    explainableData.spine[1] = {
      id: "gate:selection-quality:candidate-required-assertions",
      kind: "gate",
      parent_id: "run:product-test",
      label: "selection-quality:candidate-required-assertions",
      status: "failed",
      detail: "candidate evidence is incomplete or a required assertion failed",
    };
    explainableData.spine.push(
      {
        id: "assertion:selection-quality:with_skill:1:positive-verdict",
        kind: "assertion",
        parent_id: "case:selection-quality",
        label: "positive-verdict",
        status: "failed",
        arm: "with_skill",
        repeat: 1,
        assertion_type: "text_contains",
        assertion_rule: {
          severity: "must_pass",
          artifact: "outputs/response.md",
          expected: "Ready for release",
        },
        assertion_evidence: {
          artifact: "outputs/response.md",
          missing: ["Ready for release"],
        },
      },
      ...[2, 3, 4].map((repeat) => ({
        id: `assertion:selection-quality:with_skill:${repeat}:response-exists`,
        kind: "assertion" as const,
        parent_id: "case:selection-quality",
        label: "response-exists",
        status: "passed",
        arm: "with_skill",
        repeat,
        assertion_type: "file_exists",
        assertion_rule: {
          severity: "must_pass",
          artifact: "outputs/response.md",
        },
        assertion_evidence: { exists: true },
      })),
    );

    renderWithPreferences(
      <EvidenceDashboard data={explainableData} connectionState="live" />,
    );
    openDisplayPreferences();
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Simplified Chinese" }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "证据档案" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "查看门禁依据：候选质量是否达到发布要求｜候选结果检查",
      }),
    );

    expect(screen.getByText("为什么是这个结果")).toBeInTheDocument();
    expect(
      screen.getByText(
        "候选版执行与产物完整，但 4 项发布级检查中有 1 项未通过，因此门禁未通过。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("通过 3/4 项；1 项未通过。")).toBeInTheDocument();
    const failedCheck = screen.getByRole("button", {
      name: /第 1 次执行｜可发布样例得到通过结论.*查看证据/,
    });
    expect(failedCheck).toHaveTextContent(
      "实际回答仍缺少：“Ready for release”。",
    );

    fireEvent.click(failedCheck);
    expect(
      screen.getByText("实际观察未满足预设规则，因此这项检查未通过。"),
    ).toBeInTheDocument();
    expect(screen.getByText("实际观察")).toBeInTheDocument();
  });

  it("keeps display preferences compact and restores trigger focus on Escape", () => {
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    const trigger = screen.getByRole("button", {
      name: "Display preferences",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("dialog", { name: "Display preferences" }),
    ).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Display preferences" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("switches locale and monochrome theme across the complete workbench", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contract: "skill-reviewer.dashboard-diff",
        id: "1".repeat(24),
        path: "SKILL.md",
        old_digest: "1".repeat(64),
        new_digest: "2".repeat(64),
        old_content: "old instructions\n",
        new_content: "new instructions\n",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement).toHaveAttribute("data-font-scale", "100");
    expect(document.title).toBe("Skill Reviewer · Decision Review");

    expect(
      screen.queryByRole("button", { name: "Switch to Simplified Chinese" }),
    ).not.toBeInTheDocument();
    openDisplayPreferences();
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Simplified Chinese" }),
    );

    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
    expect(document.title).toBe("Skill Reviewer · 决策审查");
    expect(screen.getAllByText("评审总览").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("证据完整性失败，暂不评价 Skill").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "运行绑定、派发回执或 Trace 尚未全部验证；先修复证据链，不能把当前结果归因到 Skill。",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("需要处理的独立问题：1").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("为什么没有通过").length).toBeGreaterThan(0);
    expect(screen.getAllByText("应该怎么处理").length).toBeGreaterThan(0);
    expect(screen.getAllByText("准备并绑定发布审计").length).toBeGreaterThan(0);
    expect(screen.queryByText("查看下一步")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "证据档案" }));
    expect(
      screen.getByRole("button", {
        name: "需处理场景；匹配场景数：1",
      }),
    ).toHaveTextContent("需处理场景1");
    expect(
      screen.getByText(
        "此处只筛选和统计评测场景；发布门禁会在中间证据树中单独展示。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("候选质量是否达到发布要求").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("公开校准场景").length).toBeGreaterThan(0);
    expect(screen.getByText("已完成新旧版对照验证")).toBeInTheDocument();
    expect(window.localStorage.getItem(preferenceStorageKeys.locale)).toBe("zh-CN");
    expect(
      screen.getByRole("button", { name: "放大文字" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "变更 (1)" }));
    expect(await screen.findByText("Rendered diff SKILL.md")).toBeInTheDocument();
    expect(diffOptionsSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "pierre-light" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "切换到深色主题" }));

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem(preferenceStorageKeys.theme)).toBe("dark");
    expect(
      screen.getByRole("button", { name: "切换到浅色主题" }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(diffOptionsSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "pierre-dark" }),
      );
    });
  });

  it("scales the complete workbench, persists the preference, and keeps bounded controls", () => {
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    openDisplayPreferences();
    const increase = screen.getByRole("button", {
      name: "Increase text size",
    });
    const decrease = screen.getByRole("button", {
      name: "Decrease text size",
    });

    expect(decrease).not.toBeDisabled();
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe(
      "1",
    );
    expect(
      document.documentElement.style.getPropertyValue("--ui-scale-inverse"),
    ).toBe("1.000000");

    fireEvent.click(increase);
    fireEvent.click(increase);
    fireEvent.click(increase);
    fireEvent.click(increase);

    expect(increase).toBeDisabled();
    expect(document.documentElement).toHaveAttribute("data-font-scale", "160");
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe(
      "1.6",
    );
    expect(
      document.documentElement.style.getPropertyValue("--ui-scale-inverse"),
    ).toBe("0.625000");
    expect(window.localStorage.getItem(preferenceStorageKeys.fontScale)).toBe(
      "1.6",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Text size 160%. Reset text size to 100%",
      }),
    );

    expect(document.documentElement).toHaveAttribute("data-font-scale", "100");
    expect(increase).not.toBeDisabled();
  });

  it("restores persisted locale, theme, and text-size preferences", () => {
    window.localStorage.setItem(preferenceStorageKeys.locale, "zh-CN");
    window.localStorage.setItem(preferenceStorageKeys.theme, "dark");
    window.localStorage.setItem(preferenceStorageKeys.fontScale, "1.25");

    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-font-scale", "125");
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe(
      "1.25",
    );
    expect(screen.getAllByText("评审总览").length).toBeGreaterThan(0);
    openDisplayPreferences();
    expect(
      screen.getByRole("button", { name: "切换到浅色主题" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "文字大小 125%. 将文字大小恢复为 100%",
      }),
    ).toHaveTextContent("125%");
  });

  it("resizes, bounds, localizes, and persists both desktop side panes", async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1600,
    });

    try {
      const { container } = renderWithPreferences(
        <EvidenceDashboard data={data} connectionState="live" />,
      );
      const workspace = container.querySelector<HTMLElement>(".workspace-grid");
      expect(workspace).toHaveAttribute("data-layout-mode", "three");
      expect(workspace?.style.getPropertyValue("--rail-width")).toBe("270px");
      expect(workspace?.style.getPropertyValue("--inspector-width")).toBe(
        "390px",
      );

      fireEvent.click(screen.getByRole("tab", { name: "Evidence archive" }));
      const railHandle = screen.getByRole("separator", {
        name: "Resize evaluation scenarios",
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Release quality selection · passed" }),
      );
      const inspectorHandle = screen.getByRole("separator", {
        name: "Resize evidence inspector",
      });

      fireEvent.keyDown(railHandle, { key: "ArrowRight" });
      expect(workspace?.style.getPropertyValue("--rail-width")).toBe("286px");
      fireEvent.keyDown(inspectorHandle, { key: "ArrowLeft" });
      expect(workspace?.style.getPropertyValue("--inspector-width")).toBe(
        "406px",
      );

      fireEvent.keyDown(railHandle, { key: "Home" });
      expect(workspace?.style.getPropertyValue("--rail-width")).toBe("220px");
      fireEvent.keyDown(inspectorHandle, { key: "End" });
      expect(workspace?.style.getPropertyValue("--inspector-width")).toBe(
        "560px",
      );

      await waitFor(() => {
        expect(
          JSON.parse(
            window.localStorage.getItem(workspaceLayoutStorageKey) ?? "{}",
          ),
        ).toEqual({ rail: 220, inspector: 560 });
      });

      openDisplayPreferences();
      fireEvent.click(
        screen.getByRole("button", { name: "Switch to Simplified Chinese" }),
      );
      expect(
        screen.getByRole("separator", { name: "调整评测场景栏宽度" }),
      ).toHaveAttribute("title", "拖动调整宽度 · 方向键微调 · 按 Enter 恢复默认");
      expect(
        screen.getByRole("separator", { name: "调整证据说明栏宽度" }),
      ).toBeInTheDocument();

      fireEvent.keyDown(
        screen.getByRole("separator", { name: "调整评测场景栏宽度" }),
        { key: "Enter" },
      );
      expect(workspace?.style.getPropertyValue("--rail-width")).toBe("270px");
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth,
      });
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("opens Audit evidence in a drawer when the two-pane layout omits the inspector", () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1000,
    });

    try {
      const { container } = renderWithPreferences(
        <EvidenceDashboard data={data} connectionState="live" />,
      );
      const workspace = container.querySelector<HTMLElement>(".workspace-grid");
      expect(workspace).toHaveAttribute("data-layout-mode", "two");

      fireEvent.click(screen.getByRole("tab", { name: "Evidence archive" }));
      fireEvent.click(
        screen.getByRole("button", {
          name: "Release quality selection · passed",
        }),
      );

      expect(container.querySelector("#evidence-inspector")).toHaveClass(
        "evidence-drawer",
      );
      expect(
        screen.queryByRole("separator", { name: "Resize evidence inspector" }),
      ).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth,
      });
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("stacks an expanded canvas before either pane can violate its minimum", () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 849,
    });
    window.history.replaceState(
      {},
      "",
      `/skill-reviewer/#session=${localSession}&view=review`,
    );

    try {
      const { container } = renderWithPreferences(
        <EvidenceDashboard data={data} connectionState="live" />,
      );
      expect(container.querySelector(".workspace-grid")).toHaveAttribute(
        "data-layout-mode",
        "stacked",
      );
      expect(container.querySelector(".app-shell")).toHaveClass(
        "is-stacked-workspace",
      );
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth,
      });
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("keeps reviewer meaning visible and raw identifiers in a collapsed trace", () => {
    const { container } = renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    openDisplayPreferences();
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Simplified Chinese" }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "证据档案" }));

    const caseList = container.querySelector(".case-list");
    expect(caseList).toHaveTextContent("候选质量是否达到发布要求");
    expect(caseList).not.toHaveTextContent("selection-quality");

    fireEvent.click(
      screen.getByRole("button", {
        name: "候选质量是否达到发布要求 · 通过",
      }),
    );
    expect(screen.getByText("检查通过")).toBeInTheDocument();

    const trace = container.querySelector<HTMLDetailsElement>(
      ".inspector .technical-facts",
    );
    expect(trace).not.toBeNull();
    expect(trace?.open).toBe(false);
    expect(trace).toHaveTextContent("selection-quality");

    fireEvent.click(trace!.querySelector("summary")!);
    expect(trace?.open).toBe(true);
  });

  it("restores a diff permalink and keeps review controls in the fragment", async () => {
    const diffId = "1".repeat(24);
    window.history.replaceState(
      {},
      "",
      `/skill-reviewer/#session=${localSession}&split=audit&caseStatus=attention&view=diff&diff=${diffId}&layout=unified&wrap=1&focus=1`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          contract: "skill-reviewer.dashboard-diff",
          id: diffId,
          path: "SKILL.md",
          old_digest: "1".repeat(64),
          new_digest: "2".repeat(64),
          old_content: "old instructions\n",
          new_content: "new instructions\n",
        }),
      }),
    );

    const { container } = renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(container.querySelector("#case-rail")).toHaveAttribute("hidden");
    expect(screen.getByRole("tab", { name: "Changes (1)" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByText("Rendered diff SKILL.md")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unified diff" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Wrap lines" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(container.querySelector(".app-shell")).toHaveClass("is-focus-mode");
    expect(window.location.hash).not.toContain("run=");
    expect(window.location.hash).toContain("focus=1");
  });

  it("locates evidence from the keyboard palette and supports roving case focus", async () => {
    const { container } = renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Evidence archive" }));
    expect(container.querySelector("#case-rail")).not.toHaveAttribute("hidden");
    const caseRows = container.querySelectorAll<HTMLButtonElement>(".case-row");
    caseRows[0]?.focus();
    fireEvent.keyDown(caseRows[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(caseRows[1]);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByRole("dialog", { name: "Go to evidence" });
    const search = screen.getByRole("combobox");
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "public-safety-audit" } });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(palette).not.toBeInTheDocument();
    expect(
      container.querySelector(".case-row.is-selected .case-copy strong"),
    ).toHaveTextContent("Public safety audit");
    expect(window.location.hash).toContain("split=audit");
  });

  it("filters attention cases, exposes freshness controls, and copies portable references", async () => {
    window.history.replaceState(
      {},
      "",
      `/skill-reviewer/#session=${localSession}`,
    );
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      platform: "MacIntel",
      language: "en-US",
      clipboard: { writeText: clipboardWrite },
    });
    const refresh = vi.fn();
    const togglePaused = vi.fn();
    const { container } = renderWithPreferences(
      <EvidenceDashboard
        data={data}
        connectionState="stale"
        refreshControls={{
          paused: false,
          isRefreshing: false,
          lastSuccessfulAt: Date.UTC(2026, 6, 16, 8, 0, 0),
          lastAttemptAt: Date.UTC(2026, 6, 16, 8, 1, 0),
          error: "read model returned 503",
          onRefresh: refresh,
          onTogglePaused: togglePaused,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Evidence archive" }));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Needs attention; matching scenario count: 1",
      }),
    );
    expect(container.querySelectorAll(".case-row")).toHaveLength(1);
    expect(screen.getAllByText("Public safety audit").length).toBeGreaterThan(0);
    expect(screen.getByText("Last refresh failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Pause automatic refresh" }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(togglePaused).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Copy view link" }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalled());
    expect(clipboardWrite.mock.calls[0]?.[0]).not.toContain("run=run-product-test");
    expect(clipboardWrite.mock.calls[0]?.[0]).not.toContain("session=");
    expect(clipboardWrite.mock.calls[0]?.[0]).toContain("caseStatus=attention");

    fireEvent.click(container.querySelector<HTMLButtonElement>(".case-row")!);
    fireEvent.click(
      screen.getByRole("button", { name: "Copy evidence reference" }),
    );
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(2));
    expect(clipboardWrite.mock.calls[1]?.[0]).toContain(
      "### Skill Reviewer evidence reference",
    );
    expect(clipboardWrite.mock.calls[1]?.[0]).toContain("run-product-test");
    expect(clipboardWrite.mock.calls[1]?.[0]).toContain("Permalink:");
    expect(clipboardWrite.mock.calls[1]?.[0]).not.toContain("session=");
  });

  it("keeps a repeat-level regression in the attention filter even with a stale passed status", () => {
    const attentionData = structuredClone(data);
    for (const item of attentionData.cases) {
      item.status = "passed";
      item.regressed = false;
      item.direction_disagreement = false;
      item.missing_objective_metrics = [];
    }
    const selectionCase = attentionData.cases.find(
      (item) => item.id === "selection-quality",
    );
    if (!selectionCase) throw new Error("selection fixture is missing");
    selectionCase.regressed = true;

    const { container } = renderWithPreferences(
      <EvidenceDashboard data={attentionData} connectionState="live" />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Evidence archive" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Needs attention; matching scenario count: 1",
      }),
    );

    const rows = container.querySelectorAll(".case-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Release quality selection");
    expect(rows[0]).not.toHaveTextContent("Public safety audit");
  });

  it("ignores a legacy run query because run identity comes from the local session", async () => {
    window.history.replaceState(
      {},
      "",
      `/skill-reviewer/?run=run-from-another-server#session=${localSession}`,
    );
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(
      (await screen.findAllByText("Independent issues to address: 1")).length,
    ).toBeGreaterThan(0);
    expect(window.location.hash).not.toContain("run=");
  });

  it("replays fragment history without persisting a run identity", async () => {
    const view = renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Evidence archive" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Release audit; 1 cases" }),
    );
    await waitFor(() => expect(window.location.hash).toContain("split=audit"));

    window.history.pushState(
      {},
      "",
      `/skill-reviewer/#session=${localSession}&view=audit&split=selection&node=case%3Aselection-quality`,
    );
    fireEvent.popState(window);
    expect(
      screen.getByRole("button", { name: "Candidate selection; 1 cases" }),
    ).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      view.container.querySelector(".case-row.is-selected .case-copy strong"),
    ).toHaveTextContent("Release quality selection");

    const nextRun = {
      ...data,
      run: { ...data.run, id: "run-newly-presented" },
    };
    view.rerender(
      <UiPreferencesProvider>
        <EvidenceDashboard data={nextRun} connectionState="live" />
      </UiPreferencesProvider>,
    );
    expect(screen.getByText("run-newly-presented")).toBeInTheDocument();
    expect(window.location.hash).not.toContain("run=");
  });

  it("groups changed files into a collapsible directory tree and expands search results", () => {
    const nestedDiffs: DashboardData["diffs"] = [
      {
        ...data.diffs[0]!,
        id: "root",
        render_mode: "summary",
        content_url: null,
        payload_digest: null,
      },
      {
        ...data.diffs[0]!,
        id: "rubric",
        path: "references/review-rubric.md",
        render_mode: "summary",
        content_url: null,
        payload_digest: null,
      },
      {
        ...data.diffs[0]!,
        id: "workflow",
        path: "references/evolution/workflow.md",
        render_mode: "summary",
        content_url: null,
        payload_digest: null,
      },
      {
        ...data.diffs[0]!,
        id: "runner",
        path: "scripts/run.py",
        render_mode: "summary",
        content_url: null,
        payload_digest: null,
      },
    ];

    const view = renderWithPreferences(
      <DiffViewer diffs={nestedDiffs} enableWorkerPool={false} />,
    );

    expect(screen.getByText("Changed files")).toBeInTheDocument();
    const root = screen.getByRole("button", {
      name: "Collapse changed file root",
    });
    expect(root).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("SKILL-REVIEWER")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open diff SKILL.md" }),
    ).toHaveTextContent("M");

    fireEvent.click(root);
    expect(root).toHaveAccessibleName("Expand changed file root");
    expect(
      screen.queryByRole("button", { name: "Open diff SKILL.md" }),
    ).not.toBeInTheDocument();
    fireEvent.click(root);
    const references = screen.getByRole("button", {
      name: "Collapse directory references",
    });
    expect(references).toHaveAttribute("aria-expanded", "true");
    expect(
      view.container.querySelector('[data-file-icon="python"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Open diff references/evolution/workflow.md",
      }),
    ).toBeInTheDocument();

    fireEvent.keyDown(references, { key: "ArrowLeft" });
    expect(
      screen.queryByRole("button", {
        name: "Open diff references/evolution/workflow.md",
      }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(references, { key: "ArrowRight" });
    expect(
      screen.getByRole("button", {
        name: "Open diff references/evolution/workflow.md",
      }),
    ).toBeInTheDocument();

    fireEvent.click(references);
    expect(
      screen.queryByRole("button", {
        name: "Open diff references/evolution/workflow.md",
      }),
    ).not.toBeInTheDocument();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Filter changed files" }),
      { target: { value: "workflow" } },
    );
    expect(
      screen.getByRole("button", {
        name: "Open diff references/evolution/workflow.md",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collapse directory evolution" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("retries a failed lazy diff without leaving the evidence surface", async () => {
    const diffId = "1".repeat(24);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          contract: "skill-reviewer.dashboard-diff",
          id: diffId,
          path: "SKILL.md",
          old_digest: "1".repeat(64),
          new_digest: "2".repeat(64),
          old_content: "old instructions\n",
          new_content: "new instructions\n",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    renderWithPreferences(<DiffViewer diffs={data.diffs} enableWorkerPool={false} />);

    expect(await screen.findByText("Diff could not be rendered")).toBeInTheDocument();
    expect(screen.getByText("diff payload returned 503")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));

    expect(await screen.findByText("Rendered diff SKILL.md")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocks an unbound diff payload and offers copyable diagnostics", async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      platform: "MacIntel",
      language: "en-US",
      clipboard: { writeText: clipboardWrite },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          contract: "skill-reviewer.dashboard-diff",
          id: "wrong-sidecar-id",
          path: "SKILL.md",
          old_digest: "1".repeat(64),
          new_digest: "2".repeat(64),
          old_content: "old instructions\n",
          new_content: "new instructions\n",
        }),
      }),
    );

    renderWithPreferences(<DiffViewer diffs={data.diffs} enableWorkerPool={false} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Diff integrity check failed",
    );
    expect(screen.queryByText("Rendered diff SKILL.md")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    expect(clipboardWrite.mock.calls[0]?.[0]).toContain(
      '"error_kind": "integrity"',
    );
    expect(await screen.findByText("Diagnostics copied")).toBeInTheDocument();
  });

  it("mounts the Pierre worker pool for production diff rendering", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contract: "skill-reviewer.dashboard-diff",
        id: "1".repeat(24),
        path: "SKILL.md",
        old_digest: "1".repeat(64),
        new_digest: "2".repeat(64),
        old_content: "old instructions\n",
        new_content: "new instructions\n",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithPreferences(<WorkerPoolThemeHarness />);

    expect(await screen.findByText("Rendered diff SKILL.md")).toBeInTheDocument();
    expect(workerProviderSpy).toHaveBeenCalledWith({
      poolOptions: expect.objectContaining({
        poolSize: 2,
        totalASTLRUCacheSize: 24,
      }),
      highlighterOptions: expect.objectContaining({
        langs: ["markdown"],
        preferredHighlighter: "shiki-js",
        theme: "pierre-light",
      }),
    });
    expect(diffWorkerFactorySpy).toHaveBeenCalled();
    expect(workerRenderOptionsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "pierre-light" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Use dark worker theme" }));

    await waitFor(() => {
      expect(workerRenderOptionsSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "pierre-dark" }),
      );
    });
    expect(screen.getByTestId("worker-pool")).toBeInTheDocument();
  });

  it("separates candidate and baseline observations inside one paired check", () => {
    const pairedData = structuredClone(data);
    const selectedCase = pairedData.cases[0]!;
    selectedCase.determinism = "deterministic";
    selectedCase.repeats = 1;
    selectedCase.status = "failed";
    selectedCase.arms[0] = {
      ...selectedCase.arms[0]!,
      passed: false,
      assertions: { passed: 0, total: 1 },
      executions: [
        {
          repeat: 1,
          status: "completed",
          binding_error_count: 0,
          execution_digest: "4".repeat(64),
          artifact_count: 1,
          assertions: { passed: 0, total: 1 },
          required_pass_rate: 0,
          metrics: {},
          dispatch: dispatchFixture("with_skill", 1),
          trace: traceFixture("with_skill", 1),
        },
      ],
    };
    selectedCase.arms = selectedCase.arms.filter((arm) => arm.id !== "old_skill");
    selectedCase.arms.push({
      id: "old_skill",
      complete: true,
      passed: false,
      required_pass_rate: 0,
      metrics: {},
      assertions: { passed: 0, total: 1 },
      artifact_count: 1,
      executions: [
        {
          repeat: 1,
          status: "completed",
          binding_error_count: 0,
          execution_digest: "5".repeat(64),
          artifact_count: 1,
          assertions: { passed: 0, total: 1 },
          required_pass_rate: 0,
          metrics: {},
          dispatch: dispatchFixture("old_skill", 1),
          trace: traceFixture("old_skill", 1),
        },
      ],
    });
    pairedData.spine.push(
      {
        id: "assertion:selection-quality:with_skill:1:no-false-regression-claim",
        kind: "assertion",
        parent_id: "case:selection-quality",
        label: "no-false-regression-claim",
        status: "failed",
        arm: "with_skill",
        repeat: 1,
        assertion_type: "text_not_contains",
        assertion_rule: { artifact: "outputs/response.md" },
        assertion_evidence: { source_event_ids: ["with_skill-1-tool"] },
      },
      {
        id: "assertion:selection-quality:old_skill:1:no-false-regression-claim",
        kind: "assertion",
        parent_id: "case:selection-quality",
        label: "no-false-regression-claim",
        status: "failed",
        arm: "old_skill",
        repeat: 1,
        assertion_type: "text_not_contains",
        assertion_rule: { artifact: "outputs/response.md" },
        assertion_evidence: { source_event_ids: ["old_skill-1-tool"] },
      },
    );

    renderWithPreferences(
      <EvidenceDashboard data={pairedData} connectionState="live" />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));

    expect(screen.getAllByText("Candidate under review").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Comparison condition").length).toBeGreaterThan(0);
    expect(screen.getByText("Both arms fail")).toBeInTheDocument();
    expect(
      screen.getAllByText("No unsupported regression claim"),
    ).toHaveLength(1);
    expect(screen.getByText("Observable event timeline")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Locate Trace" })[0]!);
    expect(
      screen.getByRole("button", { name: /Read the Skill instructions/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("tab", { name: "Runs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getAllByRole("button", { name: "Locate Trace" })).toHaveLength(3);
  });

  it("keeps an invalid Agent Trace visibly missing instead of rendering its events", () => {
    const invalidTraceData = structuredClone(data);
    invalidTraceData.cases[0]!.arms[0]!.executions![0]!.trace!.valid = false;

    renderWithPreferences(
      <EvidenceDashboard data={invalidTraceData} connectionState="live" />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Release quality selection" }),
    );

    expect(screen.getAllByText("5 / 6")).not.toHaveLength(0);
    expect(
      screen.getByText("No real Agent trace was captured"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Agent execution started/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Candidate under review · Repeat 1 · completed/,
      }),
    ).toHaveTextContent("Trace missing");
  });
});

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App, { EvidenceDashboard } from "./App";
import DiffViewer from "./DiffViewer";
import type { DashboardData } from "./types";
import {
  preferenceStorageKeys,
  UiPreferencesProvider,
  useUiPreferences,
} from "./ui-preferences";

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

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
  document.title = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("lang");
  document.documentElement.style.removeProperty("color-scheme");
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
  document.documentElement.removeAttribute("lang");
  document.documentElement.style.removeProperty("color-scheme");
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
    subject: { path: "/skills/candidate", digest: "a".repeat(64) },
    baseline: { kind: "old_skill", path: "/skills/accepted", digest: "b".repeat(64) },
    splits: ["selection", "audit"],
    execution_profile: {
      target: "native-agent",
      harness: "lead-agent-dispatch",
      capabilities: ["filesystem", "shell"],
      isolation: "trusted-orchestrator",
      sampling: { policy: "orchestrator-default" },
      digest: "d".repeat(64),
    },
    holdout: { visibility: "public", issuer: null, digest: null },
    evidence_scope: "public-calibration",
    release_eligible: false,
    integrity: { locked: true, verified: true, plan_digest: "c".repeat(64) },
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
        run_id: "run-product-test",
        parent_digest: "b".repeat(64),
        candidate_digest: "a".repeat(64),
        change: { added: ["references/new.md"], removed: [], modified: ["SKILL.md"] },
        change_digest: "e".repeat(64),
        continuity: "continue",
        continuity_epoch: 1,
        training_trace_ids: ["development-trace-1"],
      },
    ],
    rejected_candidates: [{ round: 1, status: "no-change" }],
  },
  cases: [
    {
      id: "selection-quality",
      purpose: "Measure release quality.",
      split: "selection",
      determinism: "stochastic",
      repeats: 3,
      holdout_visibility: "public",
      status: "passed",
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
        },
      ],
    },
    {
      id: "public-safety-audit",
      purpose: "Exercise the public audit release line.",
      split: "audit",
      determinism: "deterministic",
      repeats: 1,
      holdout_visibility: "public",
      status: "failed",
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
  iterations: [
    {
      iteration: 2,
      phase: "selection",
      status: "accepted",
      accepted: true,
      artifact: "iteration-2/acceptance-decision.json",
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
  it("keeps the last verified projection visible when a refresh fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => data,
      })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    renderWithPreferences(<App />);

    expect(await screen.findByText("Evidence chain")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh dashboard now" }),
    );
    expect(await screen.findByText("Last refresh failed")).toBeInTheDocument();
    expect(screen.getByText("Evidence chain")).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("exposes live release evidence without execution controls", async () => {
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
    expect(screen.getByText(/behavioral evidence blocked/)).toBeInTheDocument();
    expect(screen.getAllByText("2 / 3").length).toBeGreaterThan(0);
    expect(screen.getByText(/continuity epoch 1/)).toBeInTheDocument();
    expect(screen.getAllByText("selection-quality").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /execute|approve|run eval/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Audit" }));
    expect(screen.getAllByText("public-safety-audit").length).toBeGreaterThan(0);
    expect(screen.queryByText("selection-quality")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(
      screen.getByRole("button", { name: "View details for selection-quality" }),
    );
    expect(screen.getByText("Semantic evidence")).toBeInTheDocument();
    expect(screen.getByText("blind-quality")).toBeInTheDocument();
    expect(screen.getByText(/preference candidate/)).toBeInTheDocument();
    expect(screen.getByText("native-agent")).toBeInTheDocument();
    expect(screen.getByText("lead-agent-dispatch")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Diff (1)" }));
    expect(await screen.findByText("Rendered diff SKILL.md")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Filter changed files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Split diff" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/dashboard-diffs/${"1".repeat(24)}.json`,
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

    fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    expect(container.querySelector(".app-shell")).not.toHaveClass("is-focus-mode");
    fireEvent.click(
      screen.getByRole("button", { name: "Expand selection-quality" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /View details for response.md/i }),
    );
    expect(
      screen.getAllByText(
        "cases/selection-quality/with_skill/repeat-1/outputs/response.md",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("separates evidence hierarchy disclosure from opening inspector details", () => {
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(
      screen.getByRole("button", { name: "Collapse run-product-test" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Expand selection-quality" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: "View details for response.md" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Showing 4 of 5 evidence nodes")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand selection-quality" }),
    );
    expect(
      screen.getByRole("button", { name: "Collapse selection-quality" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "View details for response.md" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Showing 5 of 5 evidence nodes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(
      screen.getByRole("button", { name: "Expand run-product-test" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: "View details for Safety hard gate" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 5 evidence nodes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(
      screen.getByRole("button", { name: "View details for response.md" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand all" })).toBeDisabled();
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
    expect(document.title).toBe("Skill Reviewer · Evidence Workbench");

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Simplified Chinese" }),
    );

    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
    expect(document.title).toBe("Skill Reviewer · 证据工作台");
    expect(screen.getByText("证据链")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "收起 run-product-test" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("查看详情").length).toBeGreaterThan(0);
    expect(screen.getAllByText("公开校准").length).toBeGreaterThan(0);
    expect(screen.getByText("回归已验证")).toBeInTheDocument();
    expect(window.localStorage.getItem(preferenceStorageKeys.locale)).toBe("zh-CN");

    fireEvent.click(screen.getByRole("tab", { name: "差异 (1)" }));
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

  it("restores persisted locale and theme preferences", () => {
    window.localStorage.setItem(preferenceStorageKeys.locale, "zh-CN");
    window.localStorage.setItem(preferenceStorageKeys.theme, "dark");

    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByText("证据链")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "切换到浅色主题" }),
    ).toBeInTheDocument();
  });

  it("restores a guarded diff permalink and keeps review controls in the URL", async () => {
    const diffId = "1".repeat(24);
    window.history.replaceState(
      {},
      "",
      `/?run=run-product-test&split=audit&caseStatus=attention&view=diff&diff=${diffId}&layout=unified&wrap=1&focus=1`,
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

    expect(screen.getByRole("button", { name: "Audit" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Case status: Attention" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tab", { name: "Diff (1)" })).toHaveAttribute(
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
    expect(window.location.search).toContain("run=run-product-test");
    expect(window.location.search).toContain("focus=1");
  });

  it("locates evidence from the keyboard palette and supports roving case focus", async () => {
    const { container } = renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );
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
    ).toHaveTextContent("public-safety-audit");
    expect(window.location.search).toContain("split=audit");
  });

  it("filters attention cases, exposes freshness controls, and copies portable references", async () => {
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

    fireEvent.click(
      screen.getByRole("button", { name: "Case status: Attention" }),
    );
    expect(container.querySelectorAll(".case-row")).toHaveLength(1);
    expect(screen.getAllByText("public-safety-audit").length).toBeGreaterThan(0);
    expect(screen.getByText("Last refresh failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Pause automatic refresh" }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(togglePaused).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Copy view link" }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalled());
    expect(clipboardWrite.mock.calls[0]?.[0]).toContain("run=run-product-test");
    expect(clipboardWrite.mock.calls[0]?.[0]).toContain("caseStatus=attention");

    fireEvent.click(
      screen.getByRole("button", { name: "Copy evidence reference" }),
    );
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(2));
    expect(clipboardWrite.mock.calls[1]?.[0]).toContain(
      "### Skill Reviewer evidence reference",
    );
    expect(clipboardWrite.mock.calls[1]?.[0]).toContain("run-product-test");
    expect(clipboardWrite.mock.calls[1]?.[0]).toContain("Permalink:");
  });

  it("blocks a stale run permalink until the reviewer chooses the current run", async () => {
    window.history.replaceState({}, "", "/?run=run-from-another-server");
    renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );

    expect(
      screen.getByRole("heading", { name: "This link targets a different run" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Evidence chain")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Open the current run" }),
    );
    expect(await screen.findByText("Evidence chain")).toBeInTheDocument();
    await waitFor(() =>
      expect(window.location.search).toContain("run=run-product-test"),
    );
  });

  it("replays browser history and guards a newly presented run", async () => {
    const view = renderWithPreferences(
      <EvidenceDashboard data={data} connectionState="live" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Audit" }));
    await waitFor(() => expect(window.location.search).toContain("split=audit"));

    window.history.pushState(
      {},
      "",
      "/?run=run-product-test&split=selection&node=case%3Aselection-quality",
    );
    fireEvent.popState(window);
    expect(screen.getByRole("button", { name: "Selection" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      view.container.querySelector(".case-row.is-selected .case-copy strong"),
    ).toHaveTextContent("selection-quality");

    const nextRun = {
      ...data,
      run: { ...data.run, id: "run-newly-presented" },
    };
    view.rerender(
      <UiPreferencesProvider>
        <EvidenceDashboard data={nextRun} connectionState="live" />
      </UiPreferencesProvider>,
    );
    expect(
      screen.getByRole("heading", { name: "This link targets a different run" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Requested run-product-test/)).toBeInTheDocument();
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
});

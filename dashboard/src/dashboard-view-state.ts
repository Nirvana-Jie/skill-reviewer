export type DashboardSplit = "all" | "development" | "selection" | "audit";
export type CaseStatusFilter = "all" | "passed" | "attention";
export type DashboardCanvasView = "evidence" | "execution" | "diff" | "action";
export type DashboardDiffLayout = "split" | "unified";

export interface DashboardViewState {
  runId: string | null;
  split: DashboardSplit;
  caseStatus: CaseStatusFilter;
  query: string;
  canvasView: DashboardCanvasView;
  evidenceId: string | null;
  diffId: string | null;
  diffLayout: DashboardDiffLayout;
  wrapLines: boolean;
  focusMode: boolean;
}

export const defaultDashboardViewState: DashboardViewState = {
  runId: null,
  split: "all",
  caseStatus: "all",
  query: "",
  canvasView: "evidence",
  evidenceId: null,
  diffId: null,
  diffLayout: "split",
  wrapLines: false,
  focusMode: false,
};

const splitValues: DashboardSplit[] = [
  "all",
  "development",
  "selection",
  "audit",
];
const caseStatusValues: CaseStatusFilter[] = ["all", "passed", "attention"];
const canvasValues: DashboardCanvasView[] = [
  "evidence",
  "execution",
  "diff",
  "action",
];
const diffLayoutValues: DashboardDiffLayout[] = ["split", "unified"];

function enumValue<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return value && allowed.includes(value as T) ? (value as T) : fallback;
}

function boundedValue(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  return value.slice(0, maxLength);
}

function booleanValue(value: string | null): boolean {
  return value === "1" || value === "true";
}

export function readDashboardViewState(search: string): DashboardViewState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return {
    runId: boundedValue(params.get("run"), 320),
    split: enumValue(params.get("split"), splitValues, "all"),
    caseStatus: enumValue(
      params.get("caseStatus"),
      caseStatusValues,
      "all",
    ),
    query: boundedValue(params.get("q"), 160) ?? "",
    canvasView: enumValue(params.get("view"), canvasValues, "evidence"),
    evidenceId: boundedValue(params.get("node"), 320),
    diffId: boundedValue(params.get("diff"), 320),
    diffLayout: enumValue(params.get("layout"), diffLayoutValues, "split"),
    wrapLines: booleanValue(params.get("wrap")),
    focusMode: booleanValue(params.get("focus")),
  };
}

export function dashboardViewUrl(
  state: DashboardViewState,
  sourceUrl: string,
): URL {
  const url = new URL(sourceUrl);
  const params = url.searchParams;

  for (const key of [
    "run",
    "split",
    "caseStatus",
    "q",
    "view",
    "node",
    "diff",
    "layout",
    "wrap",
    "focus",
  ]) {
    params.delete(key);
  }

  if (state.runId) params.set("run", state.runId);
  if (state.split !== "all") params.set("split", state.split);
  if (state.caseStatus !== "all") params.set("caseStatus", state.caseStatus);
  if (state.query) params.set("q", state.query);
  if (state.canvasView !== "evidence") params.set("view", state.canvasView);
  if (state.evidenceId) params.set("node", state.evidenceId);
  if (state.diffId) params.set("diff", state.diffId);
  if (state.diffLayout !== "split") params.set("layout", state.diffLayout);
  if (state.wrapLines) params.set("wrap", "1");
  if (state.focusMode) params.set("focus", "1");

  return url;
}

export function writeDashboardViewState(
  state: DashboardViewState,
  mode: "push" | "replace" = "replace",
): void {
  try {
    const url = dashboardViewUrl(state, window.location.href);
    window.history[mode === "push" ? "pushState" : "replaceState"](
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  } catch {
    // View state remains usable even when history is unavailable or restricted.
  }
}

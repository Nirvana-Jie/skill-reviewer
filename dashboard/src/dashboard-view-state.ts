export type DashboardSplit = "all" | "development" | "selection" | "audit";
export type CaseStatusFilter = "all" | "passed" | "attention";
export type DashboardCanvasView = "review" | "changes" | "runs" | "audit";
export type DashboardPanel = "none" | "evidence";
export type DashboardDiffLayout = "split" | "unified";

export interface DashboardViewState {
  split: DashboardSplit;
  caseStatus: CaseStatusFilter;
  query: string;
  canvasView: DashboardCanvasView;
  panel: DashboardPanel;
  evidenceId: string | null;
  diffId: string | null;
  diffLayout: DashboardDiffLayout;
  wrapLines: boolean;
  focusMode: boolean;
}

export const defaultDashboardViewState: DashboardViewState = {
  split: "all",
  caseStatus: "all",
  query: "",
  canvasView: "review",
  panel: "none",
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
  "review",
  "changes",
  "runs",
  "audit",
];
const panelValues: DashboardPanel[] = ["none", "evidence"];
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

function canvasValue(
  value: string | null,
  evidenceId: string | null,
): DashboardCanvasView {
  if (value && canvasValues.includes(value as DashboardCanvasView)) {
    return value as DashboardCanvasView;
  }

  // Preserve old shared links while keeping transient action state out of the
  // primary information architecture.
  if (value === "execution") return "runs";
  if (value === "diff") return "changes";
  if (value === "evidence" && evidenceId) return "audit";
  return "review";
}

function panelValue(
  value: string | null,
  legacyView: string | null,
  evidenceId: string | null,
): DashboardPanel {
  if (value && panelValues.includes(value as DashboardPanel)) {
    return value as DashboardPanel;
  }
  if (legacyView === "evidence" && evidenceId) return "evidence";
  return "none";
}

export function readDashboardViewState(fragment: string): DashboardViewState {
  const params = new URLSearchParams(
    fragment.startsWith("#") ? fragment.slice(1) : fragment,
  );
  const evidenceId = boundedValue(params.get("node"), 320);
  const legacyView = params.get("view");
  return {
    split: enumValue(params.get("split"), splitValues, "all"),
    caseStatus: enumValue(
      params.get("caseStatus"),
      caseStatusValues,
      "all",
    ),
    query: boundedValue(params.get("q"), 160) ?? "",
    canvasView: canvasValue(legacyView, evidenceId),
    panel: panelValue(params.get("panel"), legacyView, evidenceId),
    evidenceId,
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
  const params = new URLSearchParams(
    url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
  );

  for (const key of [
    "split",
    "caseStatus",
    "q",
    "view",
    "panel",
    "node",
    "diff",
    "layout",
    "wrap",
    "focus",
  ]) {
    params.delete(key);
  }

  if (state.split !== "all") params.set("split", state.split);
  if (state.caseStatus !== "all") params.set("caseStatus", state.caseStatus);
  if (state.query) params.set("q", state.query);
  if (state.canvasView !== "review") params.set("view", state.canvasView);
  if (state.panel !== "none") params.set("panel", state.panel);
  if (state.evidenceId) params.set("node", state.evidenceId);
  if (state.diffId) params.set("diff", state.diffId);
  if (state.diffLayout !== "split") params.set("layout", state.diffLayout);
  if (state.wrapLines) params.set("wrap", "1");
  if (state.focusMode) params.set("focus", "1");
  url.hash = params.toString();

  return url;
}

export function dashboardShareUrl(
  state: DashboardViewState,
  sourceUrl: string,
): URL {
  const url = dashboardViewUrl(state, sourceUrl);
  const params = new URLSearchParams(
    url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
  );
  // A copied review reference is descriptive, not an execution capability.
  // Keep the selected view but never place the process-lifetime token or a
  // legacy bridge address on the clipboard.
  params.delete("session");
  params.delete("bridge");
  url.hash = params.toString();
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

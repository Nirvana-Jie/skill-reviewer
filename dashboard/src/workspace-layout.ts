export type WorkspacePane = "rail" | "inspector";
export type WorkspaceLayoutMode = "three" | "two" | "stacked";

export interface WorkspacePanePreferences {
  rail: number;
  inspector: number;
}

export interface WorkspacePaneRange {
  min: number;
  max: number;
}

export interface WorkspaceLayoutResult {
  mode: WorkspaceLayoutMode;
  railWidth: number;
  inspectorWidth: number;
  railRange: WorkspacePaneRange;
  inspectorRange: WorkspacePaneRange;
  canvasMinimum: number;
}

export const workspaceLayoutStorageKey =
  "skill-reviewer.workspace-pane-widths";

export const workspaceLayoutLimits = {
  rail: { min: 220, default: 270, max: 480 },
  inspector: { min: 280, default: 390, max: 560 },
  divider: 10,
  stackedBreakpoint: 820,
  inspectorBreakpoint: 1180,
  canvas: {
    standard: { three: 520, two: 480 },
    expanded: { three: 660, two: 620 },
  },
} as const;

export const defaultWorkspacePanePreferences: WorkspacePanePreferences = {
  rail: workspaceLayoutLimits.rail.default,
  inspector: workspaceLayoutLimits.inspector.default,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finiteWidth(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : fallback;
}

export function normalizeWorkspacePanePreferences(
  value: Partial<WorkspacePanePreferences> | null | undefined,
): WorkspacePanePreferences {
  return {
    rail: clamp(
      finiteWidth(value?.rail, workspaceLayoutLimits.rail.default),
      workspaceLayoutLimits.rail.min,
      workspaceLayoutLimits.rail.max,
    ),
    inspector: clamp(
      finiteWidth(
        value?.inspector,
        workspaceLayoutLimits.inspector.default,
      ),
      workspaceLayoutLimits.inspector.min,
      workspaceLayoutLimits.inspector.max,
    ),
  };
}

export function parseWorkspacePanePreferences(
  raw: string | null | undefined,
): WorkspacePanePreferences {
  if (!raw) return { ...defaultWorkspacePanePreferences };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...defaultWorkspacePanePreferences };
    }
    return normalizeWorkspacePanePreferences(
      parsed as Partial<WorkspacePanePreferences>,
    );
  } catch {
    return { ...defaultWorkspacePanePreferences };
  }
}

function fitThreePaneWidths(
  preferences: WorkspacePanePreferences,
  sideBudget: number,
): WorkspacePanePreferences {
  const rail = clamp(
    preferences.rail,
    workspaceLayoutLimits.rail.min,
    workspaceLayoutLimits.rail.max,
  );
  const inspector = clamp(
    preferences.inspector,
    workspaceLayoutLimits.inspector.min,
    workspaceLayoutLimits.inspector.max,
  );
  if (rail + inspector <= sideBudget) return { rail, inspector };

  const minimumTotal =
    workspaceLayoutLimits.rail.min + workspaceLayoutLimits.inspector.min;
  const availableSurplus = Math.max(0, sideBudget - minimumTotal);
  const railSurplus = rail - workspaceLayoutLimits.rail.min;
  const inspectorSurplus = inspector - workspaceLayoutLimits.inspector.min;
  const requestedSurplus = railSurplus + inspectorSurplus;
  if (requestedSurplus <= 0 || availableSurplus <= 0) {
    return {
      rail: workspaceLayoutLimits.rail.min,
      inspector: workspaceLayoutLimits.inspector.min,
    };
  }

  const scale = Math.min(1, availableSurplus / requestedSurplus);
  const fittedRail = Math.floor(
    workspaceLayoutLimits.rail.min + railSurplus * scale,
  );
  const fittedInspector = Math.min(
    inspector,
    Math.max(
      workspaceLayoutLimits.inspector.min,
      Math.floor(sideBudget - fittedRail),
    ),
  );
  return { rail: fittedRail, inspector: fittedInspector };
}

export function calculateWorkspaceLayout({
  containerWidth,
  viewportWidth,
  expandedCanvas,
  preferences,
}: {
  containerWidth: number;
  viewportWidth: number;
  expandedCanvas: boolean;
  preferences: WorkspacePanePreferences;
}): WorkspaceLayoutResult {
  const normalized = normalizeWorkspacePanePreferences(preferences);
  const safeViewport = Math.max(0, finiteWidth(viewportWidth, 0));
  const safeContainer = Math.max(
    0,
    finiteWidth(containerWidth, safeViewport),
  );
  const canvasLimits = expandedCanvas
    ? workspaceLayoutLimits.canvas.expanded
    : workspaceLayoutLimits.canvas.standard;
  const requiredThreePaneWidth =
    workspaceLayoutLimits.rail.min +
    workspaceLayoutLimits.inspector.min +
    canvasLimits.three +
    workspaceLayoutLimits.divider * 2;
  const requiredTwoPaneWidth =
    workspaceLayoutLimits.rail.min +
    canvasLimits.two +
    workspaceLayoutLimits.divider;

  const mode: WorkspaceLayoutMode =
    safeViewport <= workspaceLayoutLimits.stackedBreakpoint ||
    safeContainer < requiredTwoPaneWidth
      ? "stacked"
      : safeViewport <= workspaceLayoutLimits.inspectorBreakpoint ||
          safeContainer < requiredThreePaneWidth
        ? "two"
        : "three";

  if (mode === "stacked") {
    return {
      mode,
      railWidth: normalized.rail,
      inspectorWidth: normalized.inspector,
      railRange: {
        min: workspaceLayoutLimits.rail.min,
        max: workspaceLayoutLimits.rail.max,
      },
      inspectorRange: {
        min: workspaceLayoutLimits.inspector.min,
        max: workspaceLayoutLimits.inspector.max,
      },
      canvasMinimum: 0,
    };
  }

  if (mode === "two") {
    const maximumRail = Math.max(
      workspaceLayoutLimits.rail.min,
      Math.min(
        workspaceLayoutLimits.rail.max,
        safeContainer - canvasLimits.two - workspaceLayoutLimits.divider,
      ),
    );
    return {
      mode,
      railWidth: clamp(
        normalized.rail,
        workspaceLayoutLimits.rail.min,
        maximumRail,
      ),
      inspectorWidth: normalized.inspector,
      railRange: {
        min: workspaceLayoutLimits.rail.min,
        max: maximumRail,
      },
      inspectorRange: {
        min: workspaceLayoutLimits.inspector.min,
        max: workspaceLayoutLimits.inspector.max,
      },
      canvasMinimum: canvasLimits.two,
    };
  }

  const sideBudget =
    safeContainer - canvasLimits.three - workspaceLayoutLimits.divider * 2;
  const fitted = fitThreePaneWidths(normalized, sideBudget);
  const maximumRail = Math.max(
    workspaceLayoutLimits.rail.min,
    Math.min(
      workspaceLayoutLimits.rail.max,
      sideBudget - fitted.inspector,
    ),
  );
  const maximumInspector = Math.max(
    workspaceLayoutLimits.inspector.min,
    Math.min(
      workspaceLayoutLimits.inspector.max,
      sideBudget - fitted.rail,
    ),
  );

  return {
    mode,
    railWidth: clamp(
      fitted.rail,
      workspaceLayoutLimits.rail.min,
      maximumRail,
    ),
    inspectorWidth: clamp(
      fitted.inspector,
      workspaceLayoutLimits.inspector.min,
      maximumInspector,
    ),
    railRange: { min: workspaceLayoutLimits.rail.min, max: maximumRail },
    inspectorRange: {
      min: workspaceLayoutLimits.inspector.min,
      max: maximumInspector,
    },
    canvasMinimum: canvasLimits.three,
  };
}

export function nextPaneWidthFromKey({
  pane,
  key,
  value,
  range,
  defaultValue,
  largeStep = false,
}: {
  pane: WorkspacePane;
  key: string;
  value: number;
  range: WorkspacePaneRange;
  defaultValue: number;
  largeStep?: boolean;
}): number | null {
  const step = largeStep ? 48 : 16;
  if (key === "Home") return range.min;
  if (key === "End") return range.max;
  if (key === "Enter" || key === " ") {
    return clamp(defaultValue, range.min, range.max);
  }
  if (key === "ArrowLeft") {
    return clamp(
      value + (pane === "rail" ? -step : step),
      range.min,
      range.max,
    );
  }
  if (key === "ArrowRight") {
    return clamp(
      value + (pane === "rail" ? step : -step),
      range.min,
      range.max,
    );
  }
  return null;
}

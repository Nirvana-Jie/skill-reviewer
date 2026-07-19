import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import type { DashboardCanvasView } from "./dashboard-view-state";
import {
  calculateWorkspaceLayout,
  defaultWorkspacePanePreferences,
  normalizeWorkspacePanePreferences,
  parseWorkspacePanePreferences,
  workspaceLayoutStorageKey,
  type WorkspacePane,
  type WorkspacePanePreferences,
} from "./workspace-layout";

type WorkspaceGridStyle = CSSProperties & {
  "--rail-width": string;
  "--inspector-width": string;
};

function initialMeasurement() {
  const viewportWidth =
    typeof window === "undefined" ? 1440 : window.innerWidth;
  return { containerWidth: viewportWidth, viewportWidth };
}

function initialPreferences(): WorkspacePanePreferences {
  if (typeof window === "undefined") {
    return { ...defaultWorkspacePanePreferences };
  }
  try {
    return parseWorkspacePanePreferences(
      window.localStorage.getItem(workspaceLayoutStorageKey),
    );
  } catch {
    return { ...defaultWorkspacePanePreferences };
  }
}

export function useWorkspaceLayout(canvasView: DashboardCanvasView) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [preferences, setPreferences] =
    useState<WorkspacePanePreferences>(initialPreferences);
  const [measurement, setMeasurement] = useState(initialMeasurement);
  const expandedCanvas = canvasView !== "audit";

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const measure = () => {
      const measuredWidth = element.getBoundingClientRect().width;
      const viewportWidth = window.innerWidth;
      const containerWidth = measuredWidth > 0 ? measuredWidth : viewportWidth;
      setMeasurement((current) =>
        current.containerWidth === Math.round(containerWidth) &&
        current.viewportWidth === Math.round(viewportWidth)
          ? current
          : {
              containerWidth: Math.round(containerWidth),
              viewportWidth: Math.round(viewportWidth),
            },
      );
    };

    measure();
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        workspaceLayoutStorageKey,
        JSON.stringify(preferences),
      );
    } catch {
      // Keep the layout valid for the current session when storage is unavailable.
    }
  }, [preferences]);

  useEffect(() => {
    const syncLayout = (event: StorageEvent) => {
      if (event.key !== workspaceLayoutStorageKey) return;
      setPreferences(parseWorkspacePanePreferences(event.newValue));
    };
    window.addEventListener("storage", syncLayout);
    return () => window.removeEventListener("storage", syncLayout);
  }, []);

  const layout = useMemo(
    () =>
      calculateWorkspaceLayout({
        ...measurement,
        expandedCanvas,
        preferences,
      }),
    [expandedCanvas, measurement, preferences],
  );

  const resizePane = useCallback(
    (pane: WorkspacePane, width: number) => {
      const range =
        pane === "rail" ? layout.railRange : layout.inspectorRange;
      const boundedWidth = Math.min(Math.max(width, range.min), range.max);
      setPreferences((current) =>
        normalizeWorkspacePanePreferences({
          ...current,
          ...(layout.mode === "three"
            ? {
                rail: pane === "rail" ? boundedWidth : layout.railWidth,
                inspector:
                  pane === "inspector"
                    ? boundedWidth
                    : layout.inspectorWidth,
              }
            : { [pane]: boundedWidth }),
        }),
      );
    },
    [layout],
  );

  const resetPane = useCallback((pane: WorkspacePane) => {
    setPreferences((current) => ({
      ...current,
      [pane]: defaultWorkspacePanePreferences[pane],
    }));
  }, []);

  const resetAll = useCallback(() => {
    setPreferences({ ...defaultWorkspacePanePreferences });
  }, []);

  const style = useMemo<WorkspaceGridStyle>(
    () => ({
      "--rail-width": `${layout.railWidth}px`,
      "--inspector-width": `${layout.inspectorWidth}px`,
    }),
    [layout.inspectorWidth, layout.railWidth],
  );

  return {
    containerRef,
    layout,
    style,
    resizePane,
    resetPane,
    resetAll,
  };
}

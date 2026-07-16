import { describe, expect, it } from "vitest";

import {
  calculateWorkspaceLayout,
  defaultWorkspacePanePreferences,
  nextPaneWidthFromKey,
  parseWorkspacePanePreferences,
  workspaceLayoutLimits,
} from "./workspace-layout";

describe("workspace pane constraints", () => {
  it("rejects malformed stored preferences and clamps extreme values", () => {
    expect(parseWorkspacePanePreferences("not-json")).toEqual(
      defaultWorkspacePanePreferences,
    );
    expect(
      parseWorkspacePanePreferences(
        JSON.stringify({ rail: -900, inspector: 10_000 }),
      ),
    ).toEqual({
      rail: workspaceLayoutLimits.rail.min,
      inspector: workspaceLayoutLimits.inspector.max,
    });
  });

  it("uses the stored widths when the center has enough room", () => {
    const layout = calculateWorkspaceLayout({
      containerWidth: 1600,
      viewportWidth: 1600,
      expandedCanvas: false,
      preferences: defaultWorkspacePanePreferences,
    });

    expect(layout).toMatchObject({
      mode: "three",
      railWidth: 270,
      inspectorWidth: 390,
      canvasMinimum: 520,
    });
  });

  it("shrinks both side panes instead of starving the center", () => {
    const layout = calculateWorkspaceLayout({
      containerWidth: 1280,
      viewportWidth: 1280,
      expandedCanvas: false,
      preferences: { rail: 480, inspector: 560 },
    });

    expect(layout.mode).toBe("three");
    expect(
      layout.railWidth +
        layout.inspectorWidth +
        workspaceLayoutLimits.divider * 2 +
        layout.canvasMinimum,
    ).toBeLessThanOrEqual(1280);
    expect(layout.railWidth).toBeGreaterThanOrEqual(
      workspaceLayoutLimits.rail.min,
    );
    expect(layout.inspectorWidth).toBeGreaterThanOrEqual(
      workspaceLayoutLimits.inspector.min,
    );
  });

  it("preserves the expanded execution canvas at the three-pane boundary", () => {
    const layout = calculateWorkspaceLayout({
      containerWidth: 1181,
      viewportWidth: 1181,
      expandedCanvas: true,
      preferences: { rail: 480, inspector: 560 },
    });

    expect(layout.mode).toBe("three");
    expect(layout.canvasMinimum).toBe(660);
    expect(
      layout.railWidth +
        layout.inspectorWidth +
        workspaceLayoutLimits.divider * 2 +
        layout.canvasMinimum,
    ).toBeLessThanOrEqual(1181);
  });

  it("drops to two panes when the viewport or container cannot hold three", () => {
    expect(
      calculateWorkspaceLayout({
        containerWidth: 1180,
        viewportWidth: 1180,
        expandedCanvas: true,
        preferences: defaultWorkspacePanePreferences,
      }).mode,
    ).toBe("two");
    const constrainedContainer = calculateWorkspaceLayout({
      containerWidth: 1050,
      viewportWidth: 1600,
      expandedCanvas: true,
      preferences: { rail: 480, inspector: 560 },
    });
    expect(constrainedContainer.mode).toBe("two");
    expect(constrainedContainer.railWidth).toBeLessThanOrEqual(420);
  });

  it("stacks an expanded view when even two panes would starve the canvas", () => {
    expect(
      calculateWorkspaceLayout({
        containerWidth: 849,
        viewportWidth: 849,
        expandedCanvas: true,
        preferences: defaultWorkspacePanePreferences,
      }).mode,
    ).toBe("stacked");
    expect(
      calculateWorkspaceLayout({
        containerWidth: 850,
        viewportWidth: 850,
        expandedCanvas: true,
        preferences: defaultWorkspacePanePreferences,
      }).mode,
    ).toBe("two");
    expect(
      calculateWorkspaceLayout({
        containerWidth: 821,
        viewportWidth: 821,
        expandedCanvas: false,
        preferences: defaultWorkspacePanePreferences,
      }).mode,
    ).toBe("two");
  });

  it("stacks panes and keeps stored preferences untouched on mobile", () => {
    const layout = calculateWorkspaceLayout({
      containerWidth: 390,
      viewportWidth: 390,
      expandedCanvas: false,
      preferences: { rail: 430, inspector: 510 },
    });

    expect(layout).toMatchObject({
      mode: "stacked",
      railWidth: 430,
      inspectorWidth: 510,
      canvasMinimum: 0,
    });
  });
});

describe("workspace pane keyboard resizing", () => {
  const range = { min: 220, max: 480 };

  it("moves the left divider geometrically and honors its hard limits", () => {
    expect(
      nextPaneWidthFromKey({
        pane: "rail",
        key: "ArrowRight",
        value: 270,
        range,
        defaultValue: 270,
      }),
    ).toBe(286);
    expect(
      nextPaneWidthFromKey({
        pane: "rail",
        key: "End",
        value: 270,
        range,
        defaultValue: 270,
      }),
    ).toBe(480);
  });

  it("reverses horizontal keys for the right-side divider", () => {
    expect(
      nextPaneWidthFromKey({
        pane: "inspector",
        key: "ArrowLeft",
        value: 390,
        range: { min: 280, max: 560 },
        defaultValue: 390,
      }),
    ).toBe(406);
    expect(
      nextPaneWidthFromKey({
        pane: "inspector",
        key: "ArrowRight",
        value: 390,
        range: { min: 280, max: 560 },
        defaultValue: 390,
      }),
    ).toBe(374);
  });
});

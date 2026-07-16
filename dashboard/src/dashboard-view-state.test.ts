// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  dashboardViewUrl,
  defaultDashboardViewState,
  readDashboardViewState,
  writeDashboardViewState,
} from "./dashboard-view-state";

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("dashboard view state", () => {
  it("round-trips stable review coordinates and preserves unrelated URL state", () => {
    const state = {
      runId: "run-42",
      split: "audit" as const,
      caseStatus: "attention" as const,
      query: "binding error",
      canvasView: "diff" as const,
      evidenceId: null,
      diffId: "diff-skill-md",
      diffLayout: "unified" as const,
      wrapLines: true,
      focusMode: true,
    };

    const url = dashboardViewUrl(
      state,
      "https://review.example.test/dashboard?tenant=core#evidence",
    );

    expect(url.searchParams.get("tenant")).toBe("core");
    expect(url.hash).toBe("#evidence");
    expect(readDashboardViewState(url.search)).toEqual(state);
  });

  it("uses safe defaults for invalid enums and bounds untrusted values", () => {
    const oversized = "x".repeat(500);
    const state = readDashboardViewState(
      `?split=private&caseStatus=broken&view=logs&layout=matrix&wrap=no&focus=yes&q=${oversized}&run=${oversized}`,
    );

    expect(state).toEqual({
      ...defaultDashboardViewState,
      query: "x".repeat(160),
      runId: "x".repeat(320),
    });
  });

  it("updates browser history without dropping the path or hash", () => {
    window.history.replaceState({}, "", "/review?tenant=core#artifact");

    writeDashboardViewState(
      {
        ...defaultDashboardViewState,
        runId: "run-product-test",
        evidenceId: "case:selection-quality",
      },
      "push",
    );

    expect(window.location.pathname).toBe("/review");
    expect(window.location.hash).toBe("#artifact");
    expect(window.location.search).toContain("tenant=core");
    expect(window.location.search).toContain("run=run-product-test");
    expect(window.location.search).toContain("node=case%3Aselection-quality");
  });

  it("persists the action center as a first-class review destination", () => {
    const state = {
      ...defaultDashboardViewState,
      runId: "run-action",
      canvasView: "action" as const,
    };

    const url = dashboardViewUrl(state, "https://review.example.test/");

    expect(url.searchParams.get("view")).toBe("action");
    expect(readDashboardViewState(url.search)).toEqual(state);
  });
});

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  dashboardShareUrl,
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
      "http://127.0.0.1:8765/skill-reviewer/?tenant=core#session=session_token_abcdefghijklmnopqrstuvwxyz123456",
    );

    expect(url.searchParams.get("tenant")).toBe("core");
    expect(url.hash).toContain("session=session_token_abcdefghijklmnopqrstuvwxyz123456");
    expect(readDashboardViewState(url.hash)).toEqual(state);
  });

  it("uses safe defaults for invalid enums and bounds untrusted values", () => {
    const oversized = "x".repeat(500);
    const state = readDashboardViewState(
      `#split=private&caseStatus=broken&view=logs&layout=matrix&wrap=no&focus=yes&q=${oversized}`,
    );

    expect(state).toEqual({
      ...defaultDashboardViewState,
      query: "x".repeat(160),
    });
  });

  it("keeps review coordinates but strips capabilities from copied URLs", () => {
    const url = dashboardShareUrl(
      {
        ...defaultDashboardViewState,
        canvasView: "diff",
        diffId: "diff-skill-md",
      },
      "http://127.0.0.1:8765/skill-reviewer/#session=session_token_abcdefghijklmnopqrstuvwxyz123456&bridge=http%3A%2F%2Fattacker.example",
    );

    expect(url.hash).not.toContain("session=");
    expect(url.hash).not.toContain("bridge=");
    expect(url.hash).toContain("view=diff");
    expect(url.hash).toContain("diff=diff-skill-md");
  });

  it("updates browser history without dropping the path or hash", () => {
    window.history.replaceState(
      {},
      "",
      "/review?tenant=core#session=session_token_abcdefghijklmnopqrstuvwxyz123456",
    );

    writeDashboardViewState(
      {
        ...defaultDashboardViewState,
        evidenceId: "case:selection-quality",
      },
      "push",
    );

    expect(window.location.pathname).toBe("/review");
    expect(window.location.hash).toContain("session=session_token_abcdefghijklmnopqrstuvwxyz123456");
    expect(window.location.search).toContain("tenant=core");
    expect(window.location.hash).toContain("node=case%3Aselection-quality");
  });

  it("persists the action center as a first-class review destination", () => {
    const state = {
      ...defaultDashboardViewState,
      canvasView: "action" as const,
    };

    const url = dashboardViewUrl(state, "https://review.example.test/");

    expect(new URLSearchParams(url.hash.slice(1)).get("view")).toBe("action");
    expect(readDashboardViewState(url.hash)).toEqual(state);
  });

  it("persists the eval execution trace and its selected scenario", () => {
    const state = {
      ...defaultDashboardViewState,
      canvasView: "execution" as const,
      evidenceId: "case:quality-check",
    };

    const url = dashboardViewUrl(state, "https://review.example.test/");

    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.get("view")).toBe("execution");
    expect(params.get("node")).toBe("case:quality-check");
    expect(readDashboardViewState(url.hash)).toEqual(state);
  });
});

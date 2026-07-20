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
      canvasView: "changes" as const,
      panel: "none" as const,
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
        canvasView: "changes",
        diffId: "diff-skill-md",
      },
      "http://127.0.0.1:8765/skill-reviewer/#session=session_token_abcdefghijklmnopqrstuvwxyz123456&bridge=http%3A%2F%2Fattacker.example",
    );

    expect(url.hash).not.toContain("session=");
    expect(url.hash).not.toContain("bridge=");
    expect(url.hash).toContain("view=changes");
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

  it("persists the eval runs and their selected scenario", () => {
    const state = {
      ...defaultDashboardViewState,
      canvasView: "runs" as const,
      evidenceId: "case:quality-check",
    };

    const url = dashboardViewUrl(state, "https://review.example.test/");

    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.get("view")).toBe("runs");
    expect(params.get("node")).toBe("case:quality-check");
    expect(params.get("panel")).toBeNull();
    expect(readDashboardViewState(url.hash)).toEqual(state);
  });

  it("uses four decision-first destinations and migrates legacy links", () => {
    expect(defaultDashboardViewState.canvasView).toBe("review");
    expect(readDashboardViewState("#view=execution").canvasView).toBe("runs");
    expect(readDashboardViewState("#view=diff").canvasView).toBe("changes");
    expect(
      readDashboardViewState("#view=evidence&node=case%3Aquality-check")
        .canvasView,
    ).toBe("audit");
    expect(
      readDashboardViewState("#view=evidence&node=case%3Aquality-check").panel,
    ).toBe("evidence");
    expect(readDashboardViewState("#view=evidence").canvasView).toBe("review");
    expect(readDashboardViewState("#view=action").canvasView).toBe("review");
    expect(readDashboardViewState("#view=action").panel).toBe("none");

    const auditUrl = dashboardViewUrl(
      {
        ...defaultDashboardViewState,
        canvasView: "audit",
        panel: "evidence",
        evidenceId: "case:quality-check",
      },
      "https://review.example.test/",
    );

    expect(new URLSearchParams(auditUrl.hash.slice(1)).get("view")).toBe(
      "audit",
    );
    expect(new URLSearchParams(auditUrl.hash.slice(1)).get("panel")).toBe(
      "evidence",
    );
  });
});

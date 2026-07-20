import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dashboardStyles = readFileSync(
  new URL("./styles.css", import.meta.url),
  "utf8",
);

describe("review overview responsive layout", () => {
  it("lets the primary review grid use an ultrawide canvas without widening every section", () => {
    expect(dashboardStyles).toMatch(
      /@container review-canvas \(min-width: 1600px\)[\s\S]*?\.review-body-grid\s*\{[^}]*width:\s*76%;[^}]*max-width:\s*none;/,
    );
    expect(dashboardStyles).not.toMatch(
      /@container review-canvas \(min-width: 1600px\)[\s\S]*?\.decision-evidence-spine\s*\{[^}]*max-width:\s*none;/,
    );
  });

  it("places Runs responsive overrides after base trace styles so mobile rules win", () => {
    const baseTraceGrid = dashboardStyles.indexOf(".trace-attention-grid {");
    const responsiveTraceBlock = dashboardStyles.lastIndexOf(
      "@container dashboard (max-width: 760px)",
    );

    expect(baseTraceGrid).toBeGreaterThan(-1);
    expect(responsiveTraceBlock).toBeGreaterThan(baseTraceGrid);
    expect(dashboardStyles.slice(responsiveTraceBlock)).toMatch(
      /\.trace-attention-summary > header\s*\{[^}]*display:\s*grid;[^}]*\}[\s\S]*?\.trace-attention-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/,
    );
  });

  it("keeps the next state inline instead of restoring a separate decision rail", () => {
    expect(dashboardStyles).toContain(".review-next-state-inline {");
    expect(dashboardStyles).not.toContain(".review-next-action {");
    expect(dashboardStyles).toMatch(
      /@container review-canvas \(min-width: 1600px\)[\s\S]*?\.review-body-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/,
    );
  });

  it("scales the full workbench while preserving logical responsive breakpoints", () => {
    expect(dashboardStyles).toMatch(
      /#root\s*\{[^}]*zoom:\s*var\(--ui-scale\);[^}]*container-name:\s*dashboard;[^}]*container-type:\s*inline-size;/,
    );
    expect(dashboardStyles).toMatch(
      /\.app-shell\s*\{[^}]*height:\s*calc\(100vh \* var\(--ui-scale-inverse\)\);[^}]*min-height:\s*calc\(680px \* var\(--ui-scale-inverse\)\);/,
    );
    expect(dashboardStyles).toContain(
      "@container dashboard (max-width: 1180px)",
    );
    expect(dashboardStyles).toContain(
      "@container dashboard (max-width: 820px)",
    );
    expect(dashboardStyles).not.toMatch(/@media \(max-width:/);
  });
});

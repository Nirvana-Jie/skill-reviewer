import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dashboardStyles = readFileSync(
  new URL("./styles.css", import.meta.url),
  "utf8",
);

describe("review overview responsive layout", () => {
  it("releases the desktop reading-width cap when the evidence canvas is ultrawide", () => {
    expect(dashboardStyles).toMatch(
      /@container review-canvas \(min-width: 1600px\)[\s\S]*?\.review-route,\s*\.review-body-grid,\s*\.review-audit-archive\s*\{[^}]*width:\s*76%;[^}]*max-width:\s*none;/,
    );
  });

  it("keeps the decision rail bounded while the primary review area expands", () => {
    expect(dashboardStyles).toMatch(
      /@container review-canvas \(min-width: 1600px\)[\s\S]*?\.review-body-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) clamp\(300px, 24%, 480px\);/,
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

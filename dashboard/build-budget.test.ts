import { describe, expect, it } from "vitest";

import {
  dashboardBuildBudget,
  dashboardBuildBudgetViolations,
} from "./build-budget";

describe("Dashboard build budget", () => {
  it("accepts a lazy, bounded production bundle", () => {
    expect(
      dashboardBuildBudgetViolations([
        { fileName: "assets/index.js", type: "chunk", bytes: 300_000, isEntry: true },
        { fileName: "assets/diff.js", type: "chunk", bytes: 500_000 },
        { fileName: "assets/markdown.js", type: "chunk", bytes: 100_000 },
      ]),
    ).toEqual([]);
  });

  it("reports entry, chunk, aggregate, count, and WASM regressions", () => {
    const chunks = Array.from(
      { length: dashboardBuildBudget.maximumJavaScriptChunks + 1 },
      (_, index) => ({
        fileName: `assets/chunk-${index}.js`,
        type: "chunk" as const,
        bytes:
          index === 0
            ? dashboardBuildBudget.largestJavaScriptChunkBytes + 1
            : 50_000,
        isEntry: index === 0,
      }),
    );
    const violations = dashboardBuildBudgetViolations([
      ...chunks,
      {
        fileName: "assets/highlighter.wasm",
        type: "asset",
        bytes: dashboardBuildBudget.maximumWasmBytes + 1,
      },
    ]);

    expect(violations.join("\n")).toMatch(/entry JavaScript/);
    expect(violations.join("\n")).toMatch(/JavaScript chunk/);
    expect(violations.join("\n")).toMatch(/total JavaScript/);
    expect(violations.join("\n")).toMatch(/chunk count/);
    expect(violations.join("\n")).toMatch(/WASM asset/);
  });
});

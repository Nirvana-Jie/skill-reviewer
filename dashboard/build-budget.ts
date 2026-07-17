export interface DashboardBuildAsset {
  fileName: string;
  type: "asset" | "chunk";
  bytes: number;
  isEntry?: boolean;
}

export const dashboardBuildBudget = {
  entryJavaScriptBytes: 450 * 1024,
  largestJavaScriptChunkBytes: 600 * 1024,
  totalJavaScriptBytes: 2_500 * 1024,
  maximumJavaScriptChunks: 48,
  maximumWasmBytes: 32 * 1024,
} as const;

export function dashboardBuildBudgetViolations(
  assets: readonly DashboardBuildAsset[],
): string[] {
  const javascript = assets.filter(
    (asset) => asset.type === "chunk" && asset.fileName.endsWith(".js"),
  );
  const violations: string[] = [];
  const entry = javascript.find((asset) => asset.isEntry);
  if (entry && entry.bytes > dashboardBuildBudget.entryJavaScriptBytes) {
    violations.push(
      `entry JavaScript ${entry.fileName} is ${entry.bytes} bytes (limit ${dashboardBuildBudget.entryJavaScriptBytes})`,
    );
  }
  for (const asset of javascript) {
    if (asset.bytes > dashboardBuildBudget.largestJavaScriptChunkBytes) {
      violations.push(
        `JavaScript chunk ${asset.fileName} is ${asset.bytes} bytes (limit ${dashboardBuildBudget.largestJavaScriptChunkBytes})`,
      );
    }
  }
  const totalJavaScriptBytes = javascript.reduce(
    (sum, asset) => sum + asset.bytes,
    0,
  );
  if (totalJavaScriptBytes > dashboardBuildBudget.totalJavaScriptBytes) {
    violations.push(
      `total JavaScript is ${totalJavaScriptBytes} bytes (limit ${dashboardBuildBudget.totalJavaScriptBytes})`,
    );
  }
  if (javascript.length > dashboardBuildBudget.maximumJavaScriptChunks) {
    violations.push(
      `JavaScript chunk count is ${javascript.length} (limit ${dashboardBuildBudget.maximumJavaScriptChunks})`,
    );
  }
  for (const asset of assets.filter((item) => item.fileName.endsWith(".wasm"))) {
    if (asset.bytes > dashboardBuildBudget.maximumWasmBytes) {
      violations.push(
        `WASM asset ${asset.fileName} is ${asset.bytes} bytes (limit ${dashboardBuildBudget.maximumWasmBytes})`,
      );
    }
  }
  return violations;
}

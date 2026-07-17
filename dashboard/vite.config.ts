import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import {
  dashboardBuildBudgetViolations,
  type DashboardBuildAsset,
} from "./build-budget";

function dashboardBuildBudgetPlugin(): Plugin {
  return {
    name: "skill-reviewer-dashboard-build-budget",
    apply: "build",
    generateBundle(_options, bundle) {
      const assets: DashboardBuildAsset[] = Object.values(bundle).map((item) => ({
        fileName: item.fileName,
        type: item.type,
        bytes:
          item.type === "chunk"
            ? Buffer.byteLength(item.code)
            : typeof item.source === "string"
              ? Buffer.byteLength(item.source)
              : item.source.byteLength,
        isEntry: item.type === "chunk" ? item.isEntry : undefined,
      }));
      const violations = dashboardBuildBudgetViolations(assets);
      if (violations.length > 0) {
        this.error(`Dashboard build budget failed:\n- ${violations.join("\n- ")}`);
      }
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: process.env.DASHBOARD_BASE ?? "/skill-reviewer/",
  plugins: [react(), dashboardBuildBudgetPlugin()],
  resolve: {
    alias: [
      {
        find: "@pierre/theming/themes",
        replacement: fileURLToPath(
          new URL("./src/pierre-themes-lite.ts", import.meta.url),
        ),
      },
      {
        find: "shiki/engine/oniguruma",
        replacement: fileURLToPath(
          new URL("./src/shiki-oniguruma-disabled.ts", import.meta.url),
        ),
      },
      {
        find: "shiki/wasm",
        replacement: fileURLToPath(
          new URL("./src/shiki-wasm-disabled.ts", import.meta.url),
        ),
      },
      {
        find: /^shiki$/,
        replacement: fileURLToPath(
          new URL("./src/shiki-lite.ts", import.meta.url),
        ),
      },
    ],
  },
  worker: {
    format: "es",
  },
  build: {
    outDir: fileURLToPath(new URL("dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});

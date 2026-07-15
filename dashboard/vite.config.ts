import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  worker: {
    format: "es",
  },
  build: {
    outDir: fileURLToPath(
      new URL("../skills/skill-reviewer/dashboard/dist", import.meta.url),
    ),
    emptyOutDir: true,
    sourcemap: false,
  },
});

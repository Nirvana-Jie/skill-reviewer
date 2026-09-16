import { configDefaults, defineConfig } from "vitest/config";

// Harness worktrees (e.g. agent sessions) are checked out under .claude/; they
// carry their own copies of the suite and must never be collected from here.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});

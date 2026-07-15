import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(repoRoot, "scripts", "serve_skill_dashboard.py");
const python = process.env.PYTHON ?? "python3";

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

describe("serve_skill_dashboard.py", () => {
  it("validates a versioned read model and static build without exposing writes", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-server-"));
    try {
      const workspace = join(root, "workspace");
      const staticRoot = join(root, "dist");
      write(staticRoot, "index.html", "<!doctype html><title>Evidence Lab</title>");
      write(
        workspace,
        "dashboard-data.json",
        JSON.stringify({
          schema_version: "skill-reviewer.dashboard-data.v1",
          run: { id: "run-check" },
        }),
      );

      const result = spawnSync(
        python,
        [
          server,
          "--workspace",
          workspace,
          "--static-root",
          staticRoot,
          "--check",
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          ok: true,
          read_only: true,
          run_id: "run-check",
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

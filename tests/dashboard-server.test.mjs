import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
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

function sha256Text(content) {
  return createHash("sha256").update(content).digest("hex");
}

describe("serve_skill_dashboard.py", () => {
  it("validates the read model and static build without exposing writes", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-server-"));
    try {
      const workspace = join(root, "workspace");
      const staticRoot = join(root, "dist");
      write(staticRoot, "index.html", "<!doctype html><title>Evidence Lab</title>");
      write(
        workspace,
        "dashboard-data.json",
        JSON.stringify({
          contract: "skill-reviewer.dashboard-data",
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

  it("serves only registered bounded diff sidecars", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-server-"));
    let child;
    try {
      const workspace = join(root, "workspace");
      const staticRoot = join(root, "dist");
      const diffId = "a".repeat(24);
      const oldDigest = "1".repeat(64);
      const newDigest = "2".repeat(64);
      const payloadPath = `dashboard-diffs/${diffId}.json`;
      const payload = {
        contract: "skill-reviewer.dashboard-diff",
        id: diffId,
        path: "SKILL.md",
        old_digest: oldDigest,
        new_digest: newDigest,
        old_content: "old\n",
        new_content: "new\n",
      };
      const payloadText = JSON.stringify(payload);
      write(staticRoot, "index.html", "<!doctype html><title>Evidence Lab</title>");
      write(workspace, payloadPath, payloadText);
      write(
        workspace,
        "dashboard-data.json",
        JSON.stringify({
          contract: "skill-reviewer.dashboard-data",
          run: { id: "run-diff" },
          diffs: [
            {
              id: diffId,
              path: "SKILL.md",
              status: "modified",
              old_digest: oldDigest,
              new_digest: newDigest,
              old_size: 4,
              new_size: 4,
              binary: false,
              render_mode: "lazy",
              content_url: `/dashboard-diffs/${diffId}.json`,
              payload_digest: sha256Text(payloadText),
            },
          ],
        }),
      );
      child = spawn(
        python,
        [
          server,
          "--workspace",
          workspace,
          "--static-root",
          staticRoot,
          "--port",
          "0",
        ],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const report = await new Promise((resolveReport, rejectReport) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          const newline = stdout.indexOf("\n");
          if (newline < 0) return;
          try {
            resolveReport(JSON.parse(stdout.slice(0, newline)));
          } catch (error) {
            rejectReport(error);
          }
        });
        child.once("exit", (code) => {
          rejectReport(
            new Error(`dashboard server exited early (${code}): ${stderr}`),
          );
        });
      });

      const response = await fetch(`${report.url}/dashboard-diffs/${diffId}.json`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain(
        "worker-src 'self'",
      );
      expect(await response.json()).toEqual(
        expect.objectContaining({ id: diffId, old_content: "old\n", new_content: "new\n" }),
      );
      const nextDiffId = "d".repeat(24);
      const nextPayload = {
        ...payload,
        id: nextDiffId,
        path: "references/next.md",
        old_content: "one\n",
        new_content: "two\n",
      };
      const nextPayloadText = JSON.stringify(nextPayload);
      write(
        workspace,
        `dashboard-diffs/${nextDiffId}.json`,
        nextPayloadText,
      );
      write(
        workspace,
        "dashboard-data.json",
        JSON.stringify({
          contract: "skill-reviewer.dashboard-data",
          run: { id: "run-diff-next" },
          diffs: [
            {
              id: nextDiffId,
              path: "references/next.md",
              status: "modified",
              old_digest: oldDigest,
              new_digest: newDigest,
              old_size: 4,
              new_size: 4,
              binary: false,
              render_mode: "lazy",
              content_url: `/dashboard-diffs/${nextDiffId}.json`,
              payload_digest: sha256Text(nextPayloadText),
            },
          ],
        }),
      );
      const nextModelResponse = await fetch(`${report.url}/dashboard-data.json`);
      expect(nextModelResponse.status).toBe(200);
      expect(await nextModelResponse.json()).toEqual(
        expect.objectContaining({
          run: { id: "run-diff-next" },
          diffs: [
            expect.objectContaining({
              content_url: `/dashboard-diffs/${nextDiffId}.json`,
            }),
          ],
        }),
      );
      const nextResponse = await fetch(
        `${report.url}/dashboard-diffs/${nextDiffId}.json`,
      );
      expect(nextResponse.status).toBe(200);
      expect(await nextResponse.json()).toEqual(
        expect.objectContaining({
          id: nextDiffId,
          old_content: "one\n",
          new_content: "two\n",
        }),
      );
      const retainedResponse = await fetch(
        `${report.url}/dashboard-diffs/${diffId}.json`,
      );
      expect(retainedResponse.status).toBe(200);
      write(
        workspace,
        payloadPath,
        JSON.stringify({ ...payload, old_content: "bad\n" }),
      );
      const tampered = await fetch(
        `${report.url}/dashboard-diffs/${diffId}.json`,
      );
      expect(tampered.status).toBe(400);
      const unknown = await fetch(
        `${report.url}/dashboard-diffs/${"b".repeat(24)}.json`,
      );
      expect(unknown.status).toBe(400);
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("accepts escaped text at the parsed 512 KiB per-side boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-server-"));
    try {
      const workspace = join(root, "workspace");
      const staticRoot = join(root, "dist");
      const diffId = "c".repeat(24);
      const oldDigest = "4".repeat(64);
      const newDigest = "5".repeat(64);
      const content = "\u0001".repeat(512 * 1024);
      const payloadText = JSON.stringify({
        contract: "skill-reviewer.dashboard-diff",
        id: diffId,
        path: "references/control.txt",
        old_digest: oldDigest,
        new_digest: newDigest,
        old_content: content,
        new_content: content,
      });
      expect(Buffer.byteLength(payloadText)).toBeGreaterThan(2 * 512 * 1024);
      write(staticRoot, "index.html", "<!doctype html><title>Evidence Lab</title>");
      write(workspace, `dashboard-diffs/${diffId}.json`, payloadText);
      write(
        workspace,
        "dashboard-data.json",
        JSON.stringify({
          contract: "skill-reviewer.dashboard-data",
          run: { id: "run-escaped-boundary" },
          diffs: [
            {
              id: diffId,
              path: "references/control.txt",
              status: "modified",
              old_digest: oldDigest,
              new_digest: newDigest,
              old_size: 512 * 1024,
              new_size: 512 * 1024,
              binary: false,
              render_mode: "lazy",
              content_url: `/dashboard-diffs/${diffId}.json`,
              payload_digest: sha256Text(payloadText),
            },
          ],
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
        { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({ lazy_diff_count: 1 }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

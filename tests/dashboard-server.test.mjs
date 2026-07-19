import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(
  repoRoot,
  "skills",
  "skill-reviewer",
  "scripts",
  "serve_skill_dashboard.mjs",
);
const launcher = join(
  repoRoot,
  "skills",
  "skill-reviewer",
  "scripts",
  "start_skill_dashboard.mjs",
);
const node = process.execPath;

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function sha256Text(content) {
  return createHash("sha256").update(content).digest("hex");
}

function bridgeFetch(report, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Skill-Reviewer-Session", report.session_token);
  return fetch(`${report.base_url}${path}`, { ...init, headers });
}

describe("serve_skill_dashboard.mjs", () => {
  it("requires an explicit user request before starting any UI", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-consent-"));
    try {
      const workspace = join(root, "workspace");
      const ui = join(root, "ui");
      write(ui, "index.html", "<!doctype html><title>Local Dashboard</title>");
      write(
        workspace,
        "dashboard-data.json",
        JSON.stringify({
          contract: "skill-reviewer.dashboard-data",
          run: { id: "run-consent" },
          spine: [],
          diffs: [],
        }),
      );

      const result = spawnSync(
        node,
        [
          launcher,
          "--workspace",
          workspace,
          "--serve-existing",
          "--ui-dir",
          ui,
          "--port",
          "0",
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/requires an explicit user request/);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts a same-origin local Dashboard session from a trusted UI override", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-launcher-"));
    let child;
    try {
      const workspace = join(root, "workspace");
      const ui = join(root, "ui");
      write(ui, "index.html", "<!doctype html><title>Local Dashboard</title>");
      write(
        workspace,
        "dashboard-data.json",
        JSON.stringify({
          contract: "skill-reviewer.dashboard-data",
          run: { id: "run-single-command" },
          spine: [],
          diffs: [],
        }),
      );

      child = spawn(
        node,
        [
          launcher,
          "--workspace",
          workspace,
          "--serve-existing",
          "--ui-dir",
          ui,
          "--user-approved-dashboard",
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
          rejectReport(new Error(`dashboard launcher exited early (${code}): ${stderr}`));
        });
      });

      expect(report).toEqual(
        expect.objectContaining({
          ok: true,
          projected: false,
          projection_source: "existing_projection",
          projection_mode: "static",
          refresh_seconds: 0,
          run_id: "run-single-command",
          port: expect.any(Number),
          dashboard_hosted: false,
          dashboard_session_started: true,
          user_approved_dashboard: true,
          ui_mode: "trusted_local_override",
          ui_downloaded: false,
          ui_temporary: false,
          ui_integrity_verified: false,
          github_token_used: false,
        }),
      );
      expect(report.dashboard_session).toEqual({
        contract: "skill-reviewer.dashboard-launch-session",
        run_id: "run-single-command",
        page_url: report.url,
        local_origin: report.base_url,
        owner: "lead_agent",
        lifecycle: "temporary-local-dashboard",
        evidence_transport: "same-origin-loopback-only",
        evidence_uploaded: false,
        capability_transport: "url-fragment-to-request-header",
        ui_integrity_verified: false,
        ui_downloaded: false,
        ui_removed_on_exit: false,
      });
      const pageUrl = new URL(report.url);
      expect(`${pageUrl.origin}${pageUrl.pathname}`).toBe(
        `${report.base_url}/skill-reviewer/`,
      );
      expect(pageUrl.search).toBe("");
      const fragment = new URLSearchParams(pageUrl.hash.slice(1));
      expect(fragment.has("bridge")).toBe(false);
      expect(fragment.get("session")).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
      expect(pageUrl.href).not.toContain("run-single-command");
      const page = await fetch(`${report.base_url}/skill-reviewer/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      const sessionResponse = await fetch(`${report.base_url}/dashboard-session.json`, {
        headers: {
          Origin: pageUrl.origin,
          "Sec-Fetch-Site": "same-origin",
          "X-Skill-Reviewer-Session": fragment.get("session"),
        },
      });
      expect(sessionResponse.status).toBe(200);
      const session = await sessionResponse.json();
      expect(session).toEqual({
        contract: "skill-reviewer.dashboard-session",
        run_id: "run-single-command",
        session_transport: "fragment-to-header",
        session_header: "X-Skill-Reviewer-Session",
        evidence_read_only: true,
        eval_mutation: false,
        data_endpoint: "/dashboard-data.json",
      });
      const response = await fetch(`${report.base_url}/dashboard-data.json`, {
        headers: {
          Origin: pageUrl.origin,
          "Sec-Fetch-Site": "same-origin",
          "X-Skill-Reviewer-Session": fragment.get("session"),
        },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect((await response.json()).run.id).toBe("run-single-command");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("reports a strictly read-only evidence plane", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-server-"));
    try {
      const workspace = join(root, "workspace");
      write(
        workspace,
        "dashboard-data.json",
        JSON.stringify({
          contract: "skill-reviewer.dashboard-data",
          run: { id: "run-check" },
        }),
      );

      const result = spawnSync(
        node,
        [
          server,
          "--workspace",
          workspace,
          "--check",
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          ok: true,
          evidence_read_only: true,
          run_id: "run-check",
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves only digest-bound retained evidence and never caches bridge data", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-server-"));
    let child;
    try {
      const workspace = join(root, "workspace");
      const nodeId = "artifact:review:with_skill:1";
      const sourcePath = "cases/review/with_skill/repeat-1/outputs/response.md";
      const content = "# Review\nEvidence is insufficient.\n";
      const digest = sha256Text(content);
      const routeId = sha256Text(nodeId).slice(0, 24);
      const contentUrl = `/dashboard-evidence/${routeId}.json`;
      write(workspace, sourcePath, content);
      write(
        workspace,
        "dashboard-data.json",
        JSON.stringify({
          contract: "skill-reviewer.dashboard-data",
          run: { id: "run-evidence" },
          spine: [
            {
              id: nodeId,
              kind: "artifact",
              path: sourcePath,
              content_url: contentUrl,
              content_digest: digest,
              content_size: Buffer.byteLength(content),
            },
          ],
        }),
      );
      child = spawn(
        node,
        [
          server,
          "--workspace",
          workspace,
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
          rejectReport(new Error(`dashboard server exited early (${code}): ${stderr}`));
        });
      });

      expect(report.evidence_preview_count).toBe(1);
      const response = await bridgeFetch(report, contentUrl);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        contract: "skill-reviewer.dashboard-evidence",
        node_id: nodeId,
        path: "response.md",
        media_type: "text/markdown",
        content,
        digest,
        size: Buffer.byteLength(content),
        truncated: false,
      });
      write(workspace, sourcePath, "tampered\n");
      expect((await bridgeFetch(report, contentUrl)).status).toBe(400);
      expect(
        (await bridgeFetch(report, `/dashboard-evidence/${"b".repeat(24)}.json`))
          .status,
      ).toBe(400);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("rejects every write method and exposes no action-ledger routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-read-only-"));
    let child;
    try {
      const workspace = join(root, "workspace");
      write(
        workspace,
        "dashboard-data.json",
        JSON.stringify({
          contract: "skill-reviewer.dashboard-data",
          run: { id: "run-read-only" },
          spine: [],
          diffs: [],
        }),
      );
      child = spawn(
        node,
        [server, "--workspace", workspace, "--port", "0"],
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
          rejectReport(new Error(`dashboard server exited early (${code}): ${stderr}`));
        });
      });

      const evidencePost = await bridgeFetch(report, "/dashboard-data.json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(evidencePost.status).toBe(405);
      expect(await evidencePost.json()).toEqual({
        ok: false,
        error: "evidence routes are read-only",
      });

      const actionPost = await bridgeFetch(report, "/dashboard-action-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(actionPost.status).toBe(405);
      const actionRead = await bridgeFetch(report, "/dashboard-action-requests.json");
      expect(actionRead.status).toBe(404);

      const preflight = await fetch(`${report.base_url}/dashboard-data.json`, {
        method: "OPTIONS",
        headers: {
          Origin: report.base_url,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "X-Skill-Reviewer-Session",
        },
      });
      expect(preflight.status).toBe(405);

      const untrusted = await bridgeFetch(report, "/dashboard-data.json", {
        headers: {
          Origin: "https://attacker.example",
          "Sec-Fetch-Site": "cross-site",
        },
      });
      expect(untrusted.status).toBe(403);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("serves only registered bounded diff sidecars", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-server-"));
    let child;
    try {
      const workspace = join(root, "workspace");
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
        node,
        [
          server,
          "--workspace",
          workspace,
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

      const response = await bridgeFetch(report, `/dashboard-diffs/${diffId}.json`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain(
        "worker-src 'self'",
      );
      expect(response.headers.get("content-security-policy")).toContain(
        "style-src-elem 'self' 'unsafe-inline'",
      );
      expect(response.headers.get("content-security-policy")).toContain(
        "style-src-attr 'unsafe-inline'",
      );
      expect(response.headers.get("content-security-policy")).toContain(
        "script-src 'self'",
      );
      expect(response.headers.get("content-security-policy")).not.toContain(
        "script-src 'self' 'unsafe-inline'",
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
      const nextModelResponse = await bridgeFetch(report, "/dashboard-data.json");
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
      const nextResponse = await bridgeFetch(
        report,
        `/dashboard-diffs/${nextDiffId}.json`,
      );
      expect(nextResponse.status).toBe(200);
      expect(await nextResponse.json()).toEqual(
        expect.objectContaining({
          id: nextDiffId,
          old_content: "one\n",
          new_content: "two\n",
        }),
      );
      const retainedResponse = await bridgeFetch(
        report,
        `/dashboard-diffs/${diffId}.json`,
      );
      expect(retainedResponse.status).toBe(200);
      write(
        workspace,
        payloadPath,
        JSON.stringify({ ...payload, old_content: "bad\n" }),
      );
      const tampered = await bridgeFetch(
        report,
        `/dashboard-diffs/${diffId}.json`,
      );
      expect(tampered.status).toBe(400);
      const unknown = await bridgeFetch(
        report,
        `/dashboard-diffs/${"b".repeat(24)}.json`,
      );
      expect(unknown.status).toBe(400);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
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
        node,
        [
          server,
          "--workspace",
          workspace,
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

  it("refuses to expose the evidence bridge on a non-loopback interface", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-server-"));
    try {
      const workspace = join(root, "workspace");
      write(
        workspace,
        "dashboard-data.json",
        JSON.stringify({
          contract: "skill-reviewer.dashboard-data",
          run: { id: "run-non-loopback" },
        }),
      );

      const result = spawnSync(
        node,
        [server, "--workspace", workspace, "--host", "0.0.0.0", "--check"],
        { cwd: repoRoot, encoding: "utf8" },
      );

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toMatch(/loopback/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

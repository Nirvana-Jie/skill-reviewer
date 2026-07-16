import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
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
  "serve_skill_dashboard.py",
);
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
  it("keeps evidence read-only and reports the external action task plane", () => {
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
          evidence_read_only: true,
          action_requests_enabled: true,
          run_id: "run-check",
          action_task_count: 0,
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves only digest-bound retained evidence and never caches the app shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-server-"));
    let child;
    try {
      const workspace = join(root, "workspace");
      const staticRoot = join(root, "dist");
      const nodeId = "artifact:review:with_skill:1";
      const sourcePath = "cases/review/with_skill/repeat-1/outputs/response.md";
      const content = "# Review\nEvidence is insufficient.\n";
      const digest = sha256Text(content);
      const routeId = sha256Text(nodeId).slice(0, 24);
      const contentUrl = `/dashboard-evidence/${routeId}.json`;
      write(staticRoot, "index.html", "<!doctype html><title>Evidence Lab</title>");
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
          rejectReport(new Error(`dashboard server exited early (${code}): ${stderr}`));
        });
      });

      expect(report.evidence_preview_count).toBe(1);
      const indexResponse = await fetch(report.url);
      expect(indexResponse.headers.get("cache-control")).toBe("no-store");
      const response = await fetch(`${report.url}${contentUrl}`);
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
      expect((await fetch(`${report.url}${contentUrl}`)).status).toBe(400);
      expect(
        (await fetch(`${report.url}/dashboard-evidence/${"b".repeat(24)}.json`))
          .status,
      ).toBe(400);
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("creates idempotent, digest-bound lead-agent tasks outside evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-server-"));
    let child;
    try {
      const workspace = join(root, "workspace");
      const staticRoot = join(root, "dist");
      const taskRoot = join(root, "action-tasks");
      const model = {
        contract: "skill-reviewer.dashboard-data",
        run: { id: "run-action" },
        spine: [
          { id: "case:failed-case", kind: "case", status: "failed" },
        ],
        action_center: {
          next_action: "propose_candidate",
          owner: "lead_agent",
          actions: [
            {
              id: "generate_candidate",
              available: true,
              owner: "lead_agent",
              human_confirmation_required: false,
              evidence_ids: ["case:failed-case"],
            },
          ],
        },
      };
      write(staticRoot, "index.html", "<!doctype html><title>Evidence Lab</title>");
      write(workspace, "dashboard-data.json", JSON.stringify(model));
      child = spawn(
        python,
        [
          server,
          "--workspace",
          workspace,
          "--static-root",
          staticRoot,
          "--task-root",
          taskRoot,
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

      const request = {
        contract: "skill-reviewer.dashboard-action-request",
        run_id: "run-action",
        action_id: "generate_candidate",
        expected_next_action: "propose_candidate",
        evidence_ids: ["case:failed-case"],
        idempotency_key: "test-action-0001",
      };
      const create = await fetch(`${report.url}/dashboard-action-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      expect(create.status).toBe(201);
      const created = await create.json();
      expect(created).toEqual(
        expect.objectContaining({
          created: true,
          task: expect.objectContaining({
            action_id: "generate_candidate",
            owner: "lead_agent",
            requested_by: "human_reviewer",
            status: "requested",
            dashboard_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      );
      const duplicate = await fetch(`${report.url}/dashboard-action-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      expect(duplicate.status).toBe(200);
      expect((await duplicate.json()).created).toBe(false);

      const logResponse = await fetch(
        `${report.url}/dashboard-action-requests.json`,
      );
      expect(logResponse.status).toBe(200);
      expect(logResponse.headers.get("cache-control")).toBe("no-store");
      const log = await logResponse.json();
      expect(log).toEqual(
        expect.objectContaining({
          owner: "lead_agent",
          evidence_mutation: false,
          eval_mutation: false,
          tasks: [expect.objectContaining({ id: created.task.id })],
        }),
      );
      expect(readdirSync(workspace)).toEqual(["dashboard-data.json"]);
      const taskFiles = readdirSync(taskRoot);
      expect(taskFiles).toHaveLength(1);
      expect(statSync(join(taskRoot, taskFiles[0])).mode & 0o222).toBe(0);

      const substitutedEvidence = await fetch(
        `${report.url}/dashboard-action-requests`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...request,
            evidence_ids: [],
            idempotency_key: "test-action-0002",
          }),
        },
      );
      expect(substitutedEvidence.status).toBe(400);

      write(
        workspace,
        "dashboard-data.json",
        JSON.stringify({
          ...model,
          action_center: {
            next_action: "authorize_audit",
            owner: "lead_agent",
            actions: [],
          },
        }),
      );
      const stale = await fetch(`${report.url}/dashboard-action-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, idempotency_key: "test-action-0003" }),
      });
      expect(stale.status).toBe(400);
      const evidencePost = await fetch(`${report.url}/dashboard-data.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(evidencePost.status).toBe(405);
    } finally {
      if (child && child.exitCode === null) {
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

#!/usr/bin/env node

/** Serve immutable review evidence through a temporary loopback Dashboard session. */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { isIP } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DASHBOARD_SESSION_CONTRACT } from "./lib/skill-eval-contracts.mjs";
import { isMainModule } from "./lib/module-entrypoint.mjs";
import { decodeUtf8, readUtf8File } from "./lib/strict-utf8.mjs";

export class DashboardServerError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DashboardServerError";
  }
}

const DIFF_ID_PATTERN = /^[a-f0-9]{24}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export const SESSION_TOKEN_HEADER = "X-Skill-Reviewer-Session";
export const DASHBOARD_DIFF_RENDER_LIMIT_BYTES = 512 * 1024;
export const DASHBOARD_EVIDENCE_SOURCE_LIMIT_BYTES = 2 * 1024 * 1024;
export const DASHBOARD_EVIDENCE_PREVIEW_LIMIT_BYTES = 256 * 1024;
export const DASHBOARD_DIFF_PAYLOAD_FILE_LIMIT_BYTES =
  2 * DASHBOARD_DIFF_RENDER_LIMIT_BYTES * 6 + 128 * 1024;

export const DASHBOARD_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "style-src 'self'",
  "style-src-elem 'self' 'unsafe-inline'",
  "style-src-attr 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), usb=(), payment=(), interest-cohort=()";

function lstatMaybe(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function realpathLoose(path) {
  const absolute = resolve(path);
  const missing = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

function pathWithin(path, root) {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function validatedSessionToken(raw) {
  if (typeof raw !== "string" || !SESSION_TOKEN_PATTERN.test(raw)) {
    throw new DashboardServerError("dashboard session token is invalid");
  }
  return raw;
}

function validatedStaticUiRoot(raw) {
  if (raw == null) return null;
  const metadata = lstatMaybe(resolve(raw));
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new DashboardServerError("local Dashboard UI root is not a safe directory");
  }
  const root = realpathSync(resolve(raw));
  const index = join(root, "index.html");
  const indexMetadata = lstatMaybe(index);
  if (
    !indexMetadata ||
    indexMetadata.isSymbolicLink() ||
    !indexMetadata.isFile() ||
    dirname(realpathSync(index)) !== root
  ) {
    throw new DashboardServerError("local Dashboard UI root has no safe index.html");
  }
  return root;
}

function isLoopbackHostname(hostname) {
  if (typeof hostname !== "string" || !hostname) return false;
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  return false;
}

export function validateLoopbackBindHost(host) {
  if (!isLoopbackHostname(host)) {
    throw new DashboardServerError(
      "dashboard server must bind to localhost or a loopback IP",
    );
  }
}

function normalizeOrigin(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DashboardServerError(`dashboard origin is invalid: ${raw}`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new DashboardServerError(`dashboard origin is invalid: ${raw}`);
  }
  return parsed.origin;
}

function requestLoopbackOrigin(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let parsed;
  try {
    parsed = new URL(`http://${raw}`);
  } catch {
    return null;
  }
  if (
    !isLoopbackHostname(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) return null;
  return parsed.origin;
}

function sha256Bytes(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)), "utf8");
}

function loadDashboardSnapshot(dataPath) {
  try {
    const body = readFileSync(dataPath);
    const data = JSON.parse(decodeUtf8(body, "dashboard read model"));
    if (!data || typeof data !== "object" || Array.isArray(data) || data.contract !== "skill-reviewer.dashboard-data") {
      throw new DashboardServerError(
        "dashboard read model contract must be skill-reviewer.dashboard-data",
      );
    }
    return { data, body };
  } catch (error) {
    if (error instanceof DashboardServerError) throw error;
    throw new DashboardServerError(`dashboard read model is invalid: ${error.message}`, { cause: error });
  }
}

function validatedDiffRoutes(workspace, data) {
  const diffs = data.diffs ?? [];
  if (!Array.isArray(diffs)) throw new DashboardServerError("dashboard diffs must be an array");
  const payloadRoot = join(workspace, "dashboard-diffs");
  const routes = new Map();
  for (let index = 0; index < diffs.length; index += 1) {
    const diff = diffs[index];
    if (!diff || typeof diff !== "object" || Array.isArray(diff)) {
      throw new DashboardServerError(`dashboard diff ${index} must be an object`);
    }
    if (!["lazy", "summary", "binary"].includes(diff.render_mode)) {
      throw new DashboardServerError(`dashboard diff ${index} render mode is invalid`);
    }
    if (diff.render_mode !== "lazy") {
      if (diff.content_url != null || diff.payload_digest != null) {
        throw new DashboardServerError(`dashboard diff ${index} exposes a payload outside lazy mode`);
      }
      continue;
    }
    if (typeof diff.id !== "string" || !DIFF_ID_PATTERN.test(diff.id)) {
      throw new DashboardServerError(`dashboard diff ${index} id is invalid`);
    }
    const expectedUrl = `/dashboard-diffs/${diff.id}.json`;
    if (diff.content_url !== expectedUrl) {
      throw new DashboardServerError(`dashboard diff ${index} content URL is invalid`);
    }
    if (typeof diff.payload_digest !== "string" || !DIGEST_PATTERN.test(diff.payload_digest)) {
      throw new DashboardServerError(`dashboard diff ${index} payload digest is invalid`);
    }
    if ([diff.old_size, diff.new_size].some((size) => !Number.isInteger(size) || size < 0 || size > DASHBOARD_DIFF_RENDER_LIMIT_BYTES)) {
      throw new DashboardServerError(`dashboard diff ${index} preview size is invalid`);
    }
    const payloadPath = join(payloadRoot, `${diff.id}.json`);
    const metadata = lstatMaybe(payloadPath);
    if (
      !metadata || metadata.isSymbolicLink() || !metadata.isFile() ||
      dirname(realpathSync(payloadPath)) !== realpathSync(payloadRoot)
    ) {
      throw new DashboardServerError(`dashboard diff payload does not exist: ${payloadPath}`);
    }
    if (metadata.size > DASHBOARD_DIFF_PAYLOAD_FILE_LIMIT_BYTES) {
      throw new DashboardServerError(`dashboard diff payload exceeds the bounded preview limit: ${payloadPath}`);
    }
    if (sha256File(payloadPath) !== diff.payload_digest) {
      throw new DashboardServerError(`dashboard diff payload digest does not match its metadata: ${payloadPath}`);
    }
    let payload;
    try {
      payload = JSON.parse(readUtf8File(payloadPath, "dashboard diff payload"));
    } catch (error) {
      throw new DashboardServerError(`dashboard diff payload is invalid: ${payloadPath}: ${error.message}`, { cause: error });
    }
    if (
      !payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.contract !== "skill-reviewer.dashboard-diff" || payload.id !== diff.id ||
      payload.path !== diff.path || payload.old_digest !== diff.old_digest || payload.new_digest !== diff.new_digest
    ) {
      throw new DashboardServerError(`dashboard diff payload is not bound to its metadata: ${payloadPath}`);
    }
    if (
      typeof payload.old_content !== "string" || typeof payload.new_content !== "string" ||
      Buffer.byteLength(payload.old_content) !== diff.old_size || Buffer.byteLength(payload.new_content) !== diff.new_size
    ) {
      throw new DashboardServerError(`dashboard diff payload size is not bound to its metadata: ${payloadPath}`);
    }
    routes.set(expectedUrl, { path: payloadPath, digest: diff.payload_digest });
  }
  return routes;
}

function validatedEvidenceRoutes(workspace, data) {
  const spine = data.spine ?? [];
  if (!Array.isArray(spine)) throw new DashboardServerError("dashboard spine must be an array");
  const routes = new Map();
  const workspaceRoot = realpathLoose(workspace);
  for (let index = 0; index < spine.length; index += 1) {
    const node = spine[index];
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new DashboardServerError(`dashboard spine node ${index} must be an object`);
    }
    if (node.content_url == null) continue;
    if (typeof node.id !== "string" || !node.id) {
      throw new DashboardServerError(`dashboard evidence node ${index} id is invalid`);
    }
    const routeId = sha256Bytes(Buffer.from(node.id, "utf8")).slice(0, 24);
    const expectedUrl = `/dashboard-evidence/${routeId}.json`;
    if (node.content_url !== expectedUrl) {
      throw new DashboardServerError(`dashboard evidence node ${index} content URL is invalid`);
    }
    if (typeof node.path !== "string" || !node.path) {
      throw new DashboardServerError(`dashboard evidence node ${index} path is invalid`);
    }
    const parts = node.path.split(sep);
    if (isAbsolute(node.path) || parts.includes("..")) {
      throw new DashboardServerError(`dashboard evidence node ${index} path leaves the workspace`);
    }
    let current = workspace;
    for (const part of parts) {
      current = join(current, part);
      if (lstatMaybe(current)?.isSymbolicLink()) {
        throw new DashboardServerError(`dashboard evidence node ${index} path contains a symbolic link`);
      }
    }
    const candidate = join(workspace, node.path);
    const metadata = lstatMaybe(candidate);
    if (!metadata || !metadata.isFile()) {
      throw new DashboardServerError(`dashboard evidence node ${index} source does not exist`);
    }
    const candidateReal = realpathSync(candidate);
    if (!pathWithin(candidateReal, workspaceRoot)) {
      throw new DashboardServerError(`dashboard evidence node ${index} path leaves the workspace`);
    }
    if (typeof node.content_digest !== "string" || !DIGEST_PATTERN.test(node.content_digest)) {
      throw new DashboardServerError(`dashboard evidence node ${index} digest is invalid`);
    }
    if (
      !Number.isInteger(node.content_size) || node.content_size < 0 ||
      node.content_size > DASHBOARD_EVIDENCE_SOURCE_LIMIT_BYTES || metadata.size !== node.content_size
    ) {
      throw new DashboardServerError(`dashboard evidence node ${index} size is invalid`);
    }
    if (sha256File(candidate) !== node.content_digest) {
      throw new DashboardServerError(`dashboard evidence node ${index} digest does not match its source`);
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(candidate));
    } catch (error) {
      throw new DashboardServerError(`dashboard evidence node ${index} source is not UTF-8 text`, { cause: error });
    }
    const binding = { path: candidate, nodeId: node.id, digest: node.content_digest, size: node.content_size };
    const previous = routes.get(expectedUrl);
    if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) {
      throw new DashboardServerError("dashboard evidence route collision");
    }
    routes.set(expectedUrl, binding);
  }
  return routes;
}

function evidenceMediaType(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".md") return "text/markdown";
  if ([".json", ".jsonl"].includes(extension)) return "application/json";
  return ({
    ".txt": "text/plain", ".html": "text/html", ".css": "text/css",
    ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml",
  })[extension] ?? "text/plain";
}

function decodeUtf8Prefix(raw, limit) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = Math.min(limit, raw.length);
  while (end >= 0) {
    try { return decoder.decode(raw.subarray(0, end)); } catch { end -= 1; }
  }
  return "";
}

function renderEvidencePayload(binding) {
  const metadata = lstatMaybe(binding.path);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new DashboardServerError("dashboard evidence source changed after validation");
  }
  let raw;
  try { raw = readFileSync(binding.path); } catch (error) {
    throw new DashboardServerError("dashboard evidence source is unavailable", { cause: error });
  }
  if (raw.length !== binding.size || sha256Bytes(raw) !== binding.digest) {
    throw new DashboardServerError("dashboard evidence source changed after validation");
  }
  let fullText;
  try { fullText = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch (error) {
    throw new DashboardServerError("dashboard evidence source is no longer UTF-8", { cause: error });
  }
  const truncated = raw.length > DASHBOARD_EVIDENCE_PREVIEW_LIMIT_BYTES;
  return Buffer.from(JSON.stringify({
    contract: "skill-reviewer.dashboard-evidence",
    node_id: binding.nodeId,
    path: basename(binding.path),
    media_type: evidenceMediaType(binding.path),
    content: truncated ? decodeUtf8Prefix(raw, DASHBOARD_EVIDENCE_PREVIEW_LIMIT_BYTES) : fullText,
    digest: binding.digest,
    size: binding.size,
    truncated,
  }), "utf8");
}

export function validateSources(workspacePath) {
  const workspace = realpathLoose(workspacePath);
  const dataPath = join(workspace, "dashboard-data.json");
  const metadata = lstatMaybe(dataPath);
  if (!metadata || !metadata.isFile()) {
    throw new DashboardServerError(`dashboard read model does not exist: ${dataPath}`);
  }
  const { data } = loadDashboardSnapshot(dataPath);
  const diffRoutes = validatedDiffRoutes(workspace, data);
  const evidenceRoutes = validatedEvidenceRoutes(workspace, data);
  return {
    ok: true,
    dashboard_hosted: false,
    evidence_uploaded: false,
    evidence_read_only: true,
    workspace,
    run_id: data.run && typeof data.run === "object" && !Array.isArray(data.run) ? data.run.id ?? null : null,
    lazy_diff_count: diffRoutes.size,
    evidence_preview_count: evidenceRoutes.size,
  };
}

function securityHeaders() {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Content-Security-Policy": DASHBOARD_CONTENT_SECURITY_POLICY,
  };
}

function send(res, status, body, contentType = "application/json; charset=utf-8", includeBody = true, extra = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    ...securityHeaders(),
    ...extra,
  });
  res.end(includeBody ? body : undefined);
}

function sendJsonError(res, status, message, includeBody = true) {
  send(res, status, canonicalJson({ ok: false, error: message }), "application/json; charset=utf-8", includeBody);
}

function requestPath(req) {
  try {
    return decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    throw new DashboardServerError("dashboard request path is invalid");
  }
}

function tokenMatches(provided, expected) {
  const left = Buffer.from(provided ?? "", "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function staticContentType(path) {
  const extension = extname(path).toLowerCase();
  return ({
    ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
    ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png",
    ".svg": "image/svg+xml", ".wasm": "application/wasm", ".woff2": "font/woff2",
  })[extension] ?? "application/octet-stream";
}

/** Create a reusable Node request handler for the local Dashboard session. */
export function createDashboardRequestHandler({
  workspace: workspacePath,
  sessionToken,
  staticUiRoot = null,
}) {
  const workspace = realpathLoose(workspacePath);
  const token = validatedSessionToken(sessionToken);
  const uiRoot = validatedStaticUiRoot(staticUiRoot);
  const dataPath = join(workspace, "dashboard-data.json");
  let { data: snapshotData, body: snapshotBody } = loadDashboardSnapshot(dataPath);
  const initialDiffRoutes = validatedDiffRoutes(workspace, snapshotData);
  const initialEvidenceRoutes = validatedEvidenceRoutes(workspace, snapshotData);
  let snapshotDigest = sha256Bytes(snapshotBody);
  const knownDiffRoutes = new Map(initialDiffRoutes);
  const knownEvidenceRoutes = new Map(initialEvidenceRoutes);

  function refreshSnapshot() {
    const next = loadDashboardSnapshot(dataPath);
    const nextDigest = sha256Bytes(next.body);
    if (nextDigest === snapshotDigest) return snapshotBody;
    const nextDiffRoutes = validatedDiffRoutes(workspace, next.data);
    const nextEvidenceRoutes = validatedEvidenceRoutes(workspace, next.data);
    for (const [route, binding] of nextDiffRoutes) {
      const previous = knownDiffRoutes.get(route);
      if (previous && previous.digest !== binding.digest) {
        throw new DashboardServerError(`dashboard diff route changed content identity: ${route}`);
      }
    }
    for (const [route, binding] of nextEvidenceRoutes) {
      const previous = knownEvidenceRoutes.get(route);
      if (previous && (
        previous.nodeId !== binding.nodeId || previous.digest !== binding.digest || previous.size !== binding.size
      )) {
        throw new DashboardServerError(`dashboard evidence route changed content identity: ${route}`);
      }
    }
    for (const entry of nextDiffRoutes) knownDiffRoutes.set(...entry);
    for (const entry of nextEvidenceRoutes) knownEvidenceRoutes.set(...entry);
    snapshotData = next.data;
    snapshotBody = next.body;
    snapshotDigest = nextDigest;
    return snapshotBody;
  }

  function currentSnapshot() {
    refreshSnapshot();
    return { data: snapshotData, digest: snapshotDigest };
  }

  function originContext(req) {
    const hostOrigin = requestLoopbackOrigin(req.headers.host);
    if (!hostOrigin) return { trusted: false, origin: null };
    const fetchSite = String(req.headers["sec-fetch-site"] ?? "").trim().toLowerCase();
    if (!["", "none", "same-origin"].includes(fetchSite)) return { trusted: false, origin: null };
    const rawOrigin = req.headers.origin;
    if (rawOrigin == null) return { trusted: true, origin: null };
    let origin;
    try { origin = normalizeOrigin(String(rawOrigin)); } catch { return { trusted: false, origin: null }; }
    return { trusted: origin === hostOrigin, origin };
  }

  function requestContext(req) {
    const context = originContext(req);
    if (!context.trusted) return context;
    return {
      trusted: tokenMatches(req.headers[SESSION_TOKEN_HEADER.toLowerCase()], token),
      origin: context.origin,
    };
  }

  function sessionDescription() {
    const { data } = currentSnapshot();
    const runId = data.run && typeof data.run === "object" && !Array.isArray(data.run) ? data.run.id ?? null : null;
    return canonicalJson({
      contract: DASHBOARD_SESSION_CONTRACT,
      run_id: runId,
      session_transport: "fragment-to-header",
      session_header: SESSION_TOKEN_HEADER,
      evidence_read_only: true,
      eval_mutation: false,
      data_endpoint: "/dashboard-data.json",
    });
  }

  function resolveStaticUi(path) {
    if (!uiRoot) return null;
    if (path === "/skill-reviewer") return join(uiRoot, "index.html");
    if (!path.startsWith("/skill-reviewer/")) return null;
    const text = path.slice("/skill-reviewer/".length);
    if (text.length > 512 || text.includes("\0") || text.includes("\\")) {
      throw new DashboardServerError("local Dashboard asset path is invalid");
    }
    const parts = (text || "index.html").split("/");
    if (parts.includes("..") || parts.some((part) => part === "")) {
      throw new DashboardServerError("local Dashboard asset path is invalid");
    }
    let current = uiRoot;
    for (const part of parts) {
      current = join(current, part);
      if (lstatMaybe(current)?.isSymbolicLink()) {
        throw new DashboardServerError("local Dashboard assets cannot use symlinks");
      }
    }
    const candidate = join(uiRoot, ...parts);
    const metadata = lstatMaybe(candidate);
    if (!metadata) {
      const error = new Error("route not found");
      error.code = "ENOENT";
      throw error;
    }
    const resolved = realpathSync(candidate);
    if (!pathWithin(resolved, uiRoot) || resolved === uiRoot) {
      throw new DashboardServerError("local Dashboard asset leaves its root");
    }
    if (!metadata.isFile()) {
      const error = new Error("route not found");
      error.code = "ENOENT";
      throw error;
    }
    return resolved;
  }

  function serveStaticUi(req, res, includeBody, path) {
    if (requestLoopbackOrigin(req.headers.host) == null) {
      sendJsonError(res, 403, "dashboard server Host is not loopback", includeBody);
      return true;
    }
    let asset;
    try { asset = resolveStaticUi(path); } catch (error) {
      if (error instanceof DashboardServerError) sendJsonError(res, 400, error.message, includeBody);
      else sendJsonError(res, 404, "route not found", includeBody);
      return true;
    }
    if (!asset) return false;
    let body;
    try { body = readFileSync(asset); } catch {
      sendJsonError(res, 404, "route not found", includeBody);
      return true;
    }
    send(res, 200, body, staticContentType(asset), includeBody);
    return true;
  }

  function resolveReadRequest(path) {
    if (["/", "/dashboard-session.json"].includes(path)) {
      return { body: sessionDescription(), contentType: "application/json; charset=utf-8" };
    }
    if (path === "/dashboard-data.json") {
      return { body: refreshSnapshot(), contentType: "application/json; charset=utf-8" };
    }
    const diff = knownDiffRoutes.get(path);
    if (diff) return { path: diff.path, expectedDigest: diff.digest, contentType: "application/json; charset=utf-8" };
    if (path.startsWith("/dashboard-diffs/")) {
      throw new DashboardServerError("diff payload is not registered by the dashboard read model");
    }
    const evidence = knownEvidenceRoutes.get(path);
    if (evidence) return { body: renderEvidencePayload(evidence), contentType: "application/json; charset=utf-8" };
    if (path.startsWith("/dashboard-evidence/")) {
      throw new DashboardServerError("evidence content is not registered by the dashboard read model");
    }
    const error = new Error("route not found");
    error.code = "ENOENT";
    throw error;
  }

  function serveRead(req, res, includeBody) {
    let path;
    try { path = requestPath(req); } catch (error) {
      sendJsonError(res, 400, error.message, includeBody);
      return;
    }
    if (serveStaticUi(req, res, includeBody, path)) return;
    if (!requestContext(req).trusted) {
      sendJsonError(res, 403, "dashboard session is not authorized", includeBody);
      return;
    }
    let response;
    try { response = resolveReadRequest(path); } catch (error) {
      if (error instanceof DashboardServerError) sendJsonError(res, 400, error.message, includeBody);
      else sendJsonError(res, 404, "route not found", includeBody);
      return;
    }
    try {
      let body = response.body;
      if (response.path) {
        const metadata = lstatMaybe(response.path);
        if (!metadata || !metadata.isFile()) {
          sendJsonError(res, 404, "route not found", includeBody);
          return;
        }
        if (metadata.isSymbolicLink() || metadata.size > DASHBOARD_DIFF_PAYLOAD_FILE_LIMIT_BYTES) {
          throw new DashboardServerError("dashboard diff payload changed after validation");
        }
        body = readFileSync(response.path);
      }
      if (!body) throw new DashboardServerError("dashboard response has no body");
      if (response.expectedDigest && (
        body.length > DASHBOARD_DIFF_PAYLOAD_FILE_LIMIT_BYTES || sha256Bytes(body) !== response.expectedDigest
      )) throw new DashboardServerError("dashboard diff payload digest changed after validation");
      send(res, 200, body, response.contentType, includeBody);
    } catch (error) {
      if (error instanceof DashboardServerError) sendJsonError(res, 400, error.message, includeBody);
      else sendJsonError(res, 404, "route not found", includeBody);
    }
  }

  function handleOptions(req, res) {
    const context = originContext(req);
    if (!context.trusted || context.origin == null) {
      sendJsonError(res, 403, "dashboard preflight is not same-origin");
      return;
    }
    let path;
    try { path = requestPath(req); } catch (error) {
      sendJsonError(res, 400, error.message);
      return;
    }
    const isRead = ["/", "/dashboard-session.json", "/dashboard-data.json"].includes(path)
      || path.startsWith("/dashboard-diffs/") || path.startsWith("/dashboard-evidence/");
    if (!isRead) {
      sendJsonError(res, 404, "route not found");
      return;
    }
    const allowedMethods = "GET, HEAD, OPTIONS";
    const requestedMethod = req.headers["access-control-request-method"];
    if (requestedMethod && !allowedMethods.split(", ").includes(String(requestedMethod))) {
      sendJsonError(res, 405, "dashboard is read-only; requested method is not allowed");
      return;
    }
    const requestedHeaders = new Set(
      String(req.headers["access-control-request-headers"] ?? "")
        .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
    );
    const allowedHeaders = new Set([SESSION_TOKEN_HEADER.toLowerCase()]);
    if (!requestedHeaders.has(SESSION_TOKEN_HEADER.toLowerCase()) || [...requestedHeaders].some((value) => !allowedHeaders.has(value))) {
      sendJsonError(res, 403, "dashboard preflight headers are not trusted");
      return;
    }
    res.writeHead(204, { "Content-Length": "0", Allow: allowedMethods, ...securityHeaders() });
    res.end();
  }

  return async function dashboardRequestHandler(req, res) {
    try {
      if (req.method === "GET") serveRead(req, res, true);
      else if (req.method === "HEAD") serveRead(req, res, false);
      else if (req.method === "OPTIONS") handleOptions(req, res);
      else sendJsonError(res, 405, "evidence routes are read-only");
    } catch (error) {
      if (!res.headersSent) sendJsonError(res, 400, error instanceof Error ? error.message : String(error));
      else res.destroy(error instanceof Error ? error : undefined);
    }
  };
}

/** Create an unbound HTTP server for use by the standalone CLI or launcher. */
export function createDashboardServer(options) {
  return createHttpServer(createDashboardRequestHandler(options));
}

// Stable public alias retained for existing launcher integrations.
export const createHandler = createDashboardRequestHandler;

function parseArgs(argv) {
  const values = { host: "127.0.0.1", port: 4174, check: false, uiDir: null };
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") { values.check = true; continue; }
    if (!["--workspace", "--ui-dir", "--host", "--port"].includes(token)) {
      throw new DashboardServerError(`unknown option: ${token}`);
    }
    const value = argv[++index];
    if (value === undefined) throw new DashboardServerError(`${token} requires a value`);
    if (token === "--workspace") values.workspace = resolve(value);
    else if (token === "--ui-dir") values.uiDir = resolve(value);
    else if (token === "--host") values.host = value;
    else values.port = Number(value);
  }
  if (!values.workspace) throw new DashboardServerError("--workspace is required");
  if (!Number.isInteger(values.port) || values.port < 0 || values.port > 65535) {
    throw new DashboardServerError("--port must be between 0 and 65535");
  }
  return values;
}

function usage() {
  return "Usage: serve_skill_dashboard.mjs --workspace PATH [--ui-dir PATH] [--host HOST] [--port PORT] [--check]";
}

export function randomSessionToken() {
  return randomBytes(32).toString("base64url");
}

function listen(server, host, port) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  let server;
  try {
    validateLoopbackBindHost(args.host);
    const report = validateSources(args.workspace);
    if (args.check) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    const sessionToken = randomSessionToken();
    server = createDashboardServer({
      workspace: args.workspace,
      sessionToken,
      staticUiRoot: args.uiDir,
    });
    await listen(server, args.host, args.port);
    const address = server.address();
    const host = address.address;
    const authority = host.includes(":") ? `[${host}]` : host;
    const origin = `http://${authority}:${address.port}`;
    process.stdout.write(`${JSON.stringify({
      ...report,
      url: origin,
      base_url: origin,
      data_url: `${origin}/dashboard-data.json`,
      session_url: `${origin}/dashboard-session.json`,
      session_token: sessionToken,
    })}\n`);
    await new Promise((resolveStop) => {
      const stop = () => resolveStop();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await closeServer(server);
    return 0;
  } catch (error) {
    if (server?.listening) await closeServer(server);
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = await main();

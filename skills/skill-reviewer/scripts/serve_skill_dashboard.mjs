#!/usr/bin/env node

/** Serve immutable evidence plus an external, append-only action task gateway. */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { isIP } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  DASHBOARD_AGENT_HANDOFF_CONTRACT,
  DASHBOARD_SESSION_CONTRACT,
} from "./lib/skill-eval-contracts.mjs";
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
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const ACTION_ID_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
const TASK_ID_PATTERN = /^task-[a-f0-9]{16}$/;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export const ACTION_REQUEST_LIMIT_BYTES = 16 * 1024;
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
      "dashboard control plane must bind to localhost or a loopback IP",
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

function displayJson(value) {
  if (Array.isArray(value)) return `[${value.map(displayJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${displayJson(item)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

function validatedTaskRoot(workspacePath, taskRootPath) {
  const workspace = realpathLoose(workspacePath);
  const unresolved = resolve(taskRootPath);
  if (
    Buffer.byteLength(unresolved, "utf8") > 4096 ||
    [...unresolved].some((character) => {
      const code = character.codePointAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new DashboardServerError("dashboard action task root is not display-safe");
  }
  const unresolvedMetadata = lstatMaybe(unresolved);
  if (unresolvedMetadata?.isSymbolicLink()) {
    throw new DashboardServerError("dashboard action task root cannot be a symlink");
  }
  const taskRoot = realpathLoose(unresolved);
  if (pathWithin(taskRoot, workspace)) {
    throw new DashboardServerError(
      "dashboard action tasks must be stored outside the evidence workspace",
    );
  }
  const metadata = lstatMaybe(taskRoot);
  if (metadata && (metadata.isSymbolicLink() || !metadata.isDirectory())) {
    throw new DashboardServerError("dashboard action task root is not a safe directory");
  }
  return taskRoot;
}

function taskDigest(record) {
  const payload = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "digest"));
  return sha256Bytes(canonicalJson(payload));
}

export function agentHandoff(taskRoot) {
  return {
    contract: DASHBOARD_AGENT_HANDOFF_CONTRACT,
    mode: "durable_local_ledger",
    agent_session_state: "unbound",
    can_wake_agent_session: false,
    persists_after_agent_session_end: true,
    task_root: taskRoot,
  };
}

const TASK_FIELDS = [
  "contract", "sequence", "created_at", "previous_digest", "run_id",
  "dashboard_digest", "expected_next_action", "action_id", "owner",
  "requested_by", "status", "delivery_mode", "agent_session_id",
  "human_confirmation_required", "evidence_ids", "idempotency_key", "id", "digest",
].sort();

function sameFields(value, fields) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(fields);
}

function loadActionTasks(taskRoot) {
  if (!existsSync(taskRoot)) return [];
  const rootMetadata = lstatSync(taskRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new DashboardServerError("dashboard action task root changed identity");
  }
  const names = readdirSync(taskRoot).filter((name) => name.endsWith(".json")).sort();
  const tasks = [];
  let previousDigest = null;
  for (let offset = 0; offset < names.length; offset += 1) {
    const sequence = offset + 1;
    const name = names[offset];
    const path = join(taskRoot, name);
    const metadata = lstatMaybe(path);
    if (!metadata || metadata.isSymbolicLink() || !metadata.isFile() || dirname(path) !== taskRoot) {
      throw new DashboardServerError("dashboard action task ledger contains an unsafe entry");
    }
    let task;
    try {
      task = JSON.parse(readUtf8File(path, `dashboard action task ${name}`));
    } catch (error) {
      throw new DashboardServerError(`dashboard action task is invalid: ${name}`, { cause: error });
    }
    if (!task || typeof task !== "object" || Array.isArray(task) || task.contract !== "skill-reviewer.dashboard-action-task") {
      throw new DashboardServerError(`dashboard action task contract is invalid: ${name}`);
    }
    if (!sameFields(task, TASK_FIELDS)) {
      throw new DashboardServerError("dashboard action task fields are invalid");
    }
    const evidenceIds = task.evidence_ids;
    if (
      typeof task.created_at !== "string" ||
      typeof task.run_id !== "string" || !task.run_id ||
      typeof task.expected_next_action !== "string" || !task.expected_next_action ||
      typeof task.dashboard_digest !== "string" || !DIGEST_PATTERN.test(task.dashboard_digest) ||
      typeof task.action_id !== "string" || !ACTION_ID_PATTERN.test(task.action_id) ||
      task.owner !== "lead_agent" || task.requested_by !== "human_reviewer" ||
      task.status !== "awaiting_agent" || task.delivery_mode !== "durable_local_ledger" ||
      task.agent_session_id !== null || typeof task.human_confirmation_required !== "boolean" ||
      !Array.isArray(evidenceIds) || evidenceIds.length > 32 ||
      evidenceIds.some((value) => typeof value !== "string" || !value) ||
      new Set(evidenceIds).size !== evidenceIds.length ||
      typeof task.idempotency_key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(task.idempotency_key) ||
      typeof task.id !== "string" || !TASK_ID_PATTERN.test(task.id)
    ) {
      throw new DashboardServerError("dashboard action task binding is invalid");
    }
    if (task.sequence !== sequence) {
      throw new DashboardServerError("dashboard action task sequence is not contiguous");
    }
    if (task.previous_digest !== previousDigest) {
      throw new DashboardServerError("dashboard action task digest chain is broken");
    }
    if (typeof task.digest !== "string" || task.digest !== taskDigest(task)) {
      throw new DashboardServerError("dashboard action task digest is invalid");
    }
    if (name !== `${String(sequence).padStart(6, "0")}-${task.id}.json`) {
      throw new DashboardServerError("dashboard action task filename is invalid");
    }
    tasks.push(task);
    previousDigest = task.digest;
  }
  return tasks;
}

function actionTaskLog({ taskRoot, runId, dashboardDigest }) {
  return {
    contract: "skill-reviewer.dashboard-action-task-log",
    run_id: runId,
    owner: "lead_agent",
    evidence_mutation: false,
    eval_mutation: false,
    current_dashboard_digest: dashboardDigest,
    handoff: agentHandoff(taskRoot),
    tasks: loadActionTasks(taskRoot).filter((task) => task.run_id === runId),
  };
}

function validateActionRequest({ payload, data }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DashboardServerError("dashboard action request must be a JSON object");
  }
  const expectedFields = [
    "contract", "run_id", "action_id", "expected_next_action", "evidence_ids", "idempotency_key",
  ].sort();
  if (!sameFields(payload, expectedFields)) {
    throw new DashboardServerError("dashboard action request fields are invalid");
  }
  if (payload.contract !== "skill-reviewer.dashboard-action-request") {
    throw new DashboardServerError("dashboard action request contract is invalid");
  }
  const runId = data.run && typeof data.run === "object" && !Array.isArray(data.run) ? data.run.id : null;
  if (typeof runId !== "string" || payload.run_id !== runId) {
    throw new DashboardServerError("dashboard action request run is stale");
  }
  const actionCenter = data.action_center;
  if (!actionCenter || typeof actionCenter !== "object" || Array.isArray(actionCenter)) {
    throw new DashboardServerError("dashboard action center is unavailable");
  }
  const gateway = actionCenter.task_gateway;
  if (
    !gateway || typeof gateway !== "object" || Array.isArray(gateway) ||
    gateway.handoff_mode !== "durable_local_ledger" ||
    gateway.can_wake_agent_session !== false || gateway.persists_after_agent_session_end !== true ||
    gateway.evidence_mutation !== false || gateway.eval_mutation !== false
  ) {
    throw new DashboardServerError(
      "dashboard action gateway does not declare the durable handoff boundary",
    );
  }
  if (typeof actionCenter.next_action !== "string" || payload.expected_next_action !== actionCenter.next_action) {
    throw new DashboardServerError("dashboard action request state is stale");
  }
  if (typeof payload.action_id !== "string" || !ACTION_ID_PATTERN.test(payload.action_id)) {
    throw new DashboardServerError("dashboard action id is invalid");
  }
  const action = Array.isArray(actionCenter.actions)
    ? actionCenter.actions.find((item) => item && typeof item === "object" && !Array.isArray(item) && item.id === payload.action_id)
    : null;
  if (!action || action.available !== true) {
    throw new DashboardServerError("dashboard action is not available in this state");
  }
  if (action.requestable !== true) {
    throw new DashboardServerError("dashboard action is automatic and cannot be requested by the browser");
  }
  if (action.owner !== "lead_agent") {
    throw new DashboardServerError("dashboard action does not belong to the lead agent");
  }
  if (typeof payload.idempotency_key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(payload.idempotency_key)) {
    throw new DashboardServerError("dashboard action idempotency key is invalid");
  }
  const evidenceIds = payload.evidence_ids;
  if (
    !Array.isArray(evidenceIds) || evidenceIds.length > 32 ||
    evidenceIds.some((value) => typeof value !== "string" || !value) ||
    new Set(evidenceIds).size !== evidenceIds.length
  ) {
    throw new DashboardServerError("dashboard action evidence references are invalid");
  }
  const knownEvidenceIds = new Set(
    Array.isArray(data.spine)
      ? data.spine.filter((item) => item && typeof item === "object" && typeof item.id === "string").map((item) => item.id)
      : [],
  );
  if (evidenceIds.some((value) => !knownEvidenceIds.has(value))) {
    throw new DashboardServerError("dashboard action cites unknown evidence");
  }
  if (
    !Array.isArray(action.evidence_ids) ||
    action.evidence_ids.some((value) => typeof value !== "string" || !value) ||
    JSON.stringify(evidenceIds) !== JSON.stringify(action.evidence_ids)
  ) {
    throw new DashboardServerError("dashboard action evidence does not match the state projection");
  }
  return { request: payload, action };
}

function appendActionTask({ taskRoot, request, action, dashboardDigest }) {
  mkdirSync(taskRoot, { recursive: true, mode: 0o700 });
  const rootMetadata = lstatSync(taskRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new DashboardServerError("dashboard action task root changed identity");
  }
  chmodSync(taskRoot, 0o700);
  const tasks = loadActionTasks(taskRoot);
  for (const task of tasks) {
    if (task.run_id === request.run_id && task.idempotency_key === request.idempotency_key) {
      if (task.action_id !== request.action_id) {
        throw new DashboardServerError("dashboard action idempotency key was reused for another action");
      }
      return { task, created: false };
    }
  }
  for (const task of tasks) {
    if (
      task.run_id === request.run_id && task.dashboard_digest === dashboardDigest &&
      task.expected_next_action === request.expected_next_action && task.action_id === request.action_id &&
      JSON.stringify(task.evidence_ids) === JSON.stringify(request.evidence_ids) && task.status === "awaiting_agent"
    ) return { task, created: false };
  }
  const sequence = tasks.length + 1;
  const record = {
    contract: "skill-reviewer.dashboard-action-task",
    sequence,
    created_at: new Date().toISOString().replace("Z", "+00:00"),
    previous_digest: tasks.length ? tasks.at(-1).digest : null,
    run_id: request.run_id,
    dashboard_digest: dashboardDigest,
    expected_next_action: request.expected_next_action,
    action_id: request.action_id,
    owner: "lead_agent",
    requested_by: "human_reviewer",
    status: "awaiting_agent",
    delivery_mode: "durable_local_ledger",
    agent_session_id: null,
    human_confirmation_required: action.human_confirmation_required ?? false,
    evidence_ids: request.evidence_ids,
    idempotency_key: request.idempotency_key,
  };
  const identityDigest = sha256Bytes(canonicalJson({
    run_id: request.run_id,
    action_id: request.action_id,
    idempotency_key: request.idempotency_key,
    dashboard_digest: dashboardDigest,
  }));
  record.id = `task-${identityDigest.slice(0, 16)}`;
  record.digest = taskDigest(record);
  const path = join(taskRoot, `${String(sequence).padStart(6, "0")}-${record.id}.json`);
  const temporary = join(taskRoot, `.${basename(path)}.${process.pid}.tmp`);
  let handle;
  try {
    handle = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeSync(handle, `${JSON.stringify(record, null, 2)}\n`, null, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    chmodSync(temporary, 0o400);
    linkSync(temporary, path);
    unlinkSync(temporary);
  } catch (error) {
    if (handle !== undefined) {
      try { closeSync(handle); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    throw new DashboardServerError("dashboard action task could not be retained", { cause: error });
  }
  return { task: record, created: true };
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

export function validateSources(workspacePath, taskRootPath = null) {
  const workspace = realpathLoose(workspacePath);
  const taskRoot = validatedTaskRoot(
    workspace,
    taskRootPath ?? join(dirname(workspace), `${basename(workspace)}.dashboard-actions`),
  );
  const dataPath = join(workspace, "dashboard-data.json");
  const metadata = lstatMaybe(dataPath);
  if (!metadata || !metadata.isFile()) {
    throw new DashboardServerError(`dashboard read model does not exist: ${dataPath}`);
  }
  const { data } = loadDashboardSnapshot(dataPath);
  const diffRoutes = validatedDiffRoutes(workspace, data);
  const evidenceRoutes = validatedEvidenceRoutes(workspace, data);
  const tasks = loadActionTasks(taskRoot);
  return {
    ok: true,
    dashboard_hosted: false,
    evidence_uploaded: false,
    evidence_read_only: true,
    action_requests_enabled: true,
    agent_handoff: agentHandoff(taskRoot),
    workspace,
    task_root: taskRoot,
    run_id: data.run && typeof data.run === "object" && !Array.isArray(data.run) ? data.run.id ?? null : null,
    lazy_diff_count: diffRoutes.size,
    evidence_preview_count: evidenceRoutes.size,
    action_task_count: tasks.length,
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

/** Create a reusable Node request handler for the Dashboard control plane. */
export function createDashboardRequestHandler({
  workspace: workspacePath,
  taskRoot: taskRootPath = null,
  sessionToken,
  staticUiRoot = null,
}) {
  const workspace = realpathLoose(workspacePath);
  const taskRoot = validatedTaskRoot(
    workspace,
    taskRootPath ?? join(dirname(workspace), `${basename(workspace)}.dashboard-actions`),
  );
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
      action_requests_enabled: true,
      data_endpoint: "/dashboard-data.json",
      action_request_endpoint: "/dashboard-action-requests",
      action_audit_endpoint: "/dashboard-action-requests.json",
      agent_handoff: agentHandoff(taskRoot),
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
      sendJsonError(res, 403, "dashboard control plane Host is not loopback", includeBody);
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
    if (path === "/dashboard-action-requests.json") {
      const { data, digest } = currentSnapshot();
      const runId = data.run && typeof data.run === "object" && !Array.isArray(data.run) ? data.run.id : null;
      if (typeof runId !== "string") throw new DashboardServerError("dashboard run id is unavailable");
      return {
        body: canonicalJson(actionTaskLog({ taskRoot, runId, dashboardDigest: digest })),
        contentType: "application/json; charset=utf-8",
      };
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
      sendJsonError(res, 403, "dashboard control-plane session is not authorized", includeBody);
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
      sendJsonError(res, 403, "dashboard control-plane preflight is not same-origin");
      return;
    }
    let path;
    try { path = requestPath(req); } catch (error) {
      sendJsonError(res, 400, error.message);
      return;
    }
    const isAction = path === "/dashboard-action-requests";
    const isRead = ["/", "/dashboard-session.json", "/dashboard-data.json", "/dashboard-action-requests.json"].includes(path)
      || path.startsWith("/dashboard-diffs/") || path.startsWith("/dashboard-evidence/");
    if (!isAction && !isRead) {
      sendJsonError(res, 404, "route not found");
      return;
    }
    const allowedMethods = isAction ? "POST, OPTIONS" : "GET, HEAD, OPTIONS";
    const requestedMethod = req.headers["access-control-request-method"];
    if (requestedMethod && !allowedMethods.split(", ").includes(String(requestedMethod))) {
      sendJsonError(res, 405, "requested control-plane method is not allowed");
      return;
    }
    const requestedHeaders = new Set(
      String(req.headers["access-control-request-headers"] ?? "")
        .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
    );
    const allowedHeaders = new Set([SESSION_TOKEN_HEADER.toLowerCase(), ...(isAction ? ["content-type"] : [])]);
    if (!requestedHeaders.has(SESSION_TOKEN_HEADER.toLowerCase()) || [...requestedHeaders].some((value) => !allowedHeaders.has(value))) {
      sendJsonError(res, 403, "dashboard control-plane preflight headers are not trusted");
      return;
    }
    res.writeHead(204, { "Content-Length": "0", Allow: allowedMethods, ...securityHeaders() });
    res.end();
  }

  async function readActionBody(req, length) {
    const chunks = [];
    let received = 0;
    for await (const chunk of req) {
      received += chunk.length;
      if (received > length) throw new DashboardServerError("dashboard action request body is incomplete");
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    if (raw.length !== length) throw new DashboardServerError("dashboard action request body is incomplete");
    return raw;
  }

  async function handlePost(req, res) {
    if (!requestContext(req).trusted) {
      sendJsonError(res, 403, "dashboard action request session is not authorized");
      return;
    }
    let path;
    try { path = requestPath(req); } catch (error) {
      sendJsonError(res, 400, error.message);
      return;
    }
    if (path !== "/dashboard-action-requests") {
      sendJsonError(res, 405, "evidence routes are read-only");
      return;
    }
    const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      sendJsonError(res, 415, "dashboard action requests require application/json");
      return;
    }
    const rawLength = String(req.headers["content-length"] ?? "");
    const contentLength = /^\d+$/.test(rawLength) ? Number(rawLength) : -1;
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > ACTION_REQUEST_LIMIT_BYTES) {
      sendJsonError(res, 413, "dashboard action request exceeds the bounded size");
      return;
    }
    try {
      const raw = await readActionBody(req, contentLength);
      const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      const { data, digest } = currentSnapshot();
      const { request, action } = validateActionRequest({ payload, data });
      const { task, created } = appendActionTask({ taskRoot, request, action, dashboardDigest: digest });
      if (created) {
        process.stderr.write(`${displayJson({
          event: "dashboard_agent_handoff_saved",
          task_id: task.id,
          run_id: task.run_id,
          action_id: task.action_id,
          expected_next_action: task.expected_next_action,
          task_root: taskRoot,
        }, null, 2)}\n`);
      }
      send(res, created ? 201 : 200, canonicalJson({
        contract: "skill-reviewer.dashboard-action-task-response",
        created,
        task,
        handoff: agentHandoff(taskRoot),
      }));
    } catch (error) {
      sendJsonError(res, 400, error instanceof Error ? error.message : String(error));
    }
  }

  return async function dashboardRequestHandler(req, res) {
    try {
      if (req.method === "GET") serveRead(req, res, true);
      else if (req.method === "HEAD") serveRead(req, res, false);
      else if (req.method === "OPTIONS") handleOptions(req, res);
      else if (req.method === "POST") await handlePost(req, res);
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
  const values = { host: "127.0.0.1", port: 4174, check: false, taskRoot: null, uiDir: null };
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") { values.check = true; continue; }
    if (!["--workspace", "--task-root", "--ui-dir", "--host", "--port"].includes(token)) {
      throw new DashboardServerError(`unknown option: ${token}`);
    }
    const value = argv[++index];
    if (value === undefined) throw new DashboardServerError(`${token} requires a value`);
    if (token === "--workspace") values.workspace = resolve(value);
    else if (token === "--task-root") values.taskRoot = resolve(value);
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
  return "Usage: serve_skill_dashboard.mjs --workspace PATH [--task-root PATH] [--ui-dir PATH] [--host HOST] [--port PORT] [--check]";
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
    const report = validateSources(args.workspace, args.taskRoot);
    if (args.check) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    const sessionToken = randomSessionToken();
    server = createDashboardServer({
      workspace: args.workspace,
      taskRoot: args.taskRoot,
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

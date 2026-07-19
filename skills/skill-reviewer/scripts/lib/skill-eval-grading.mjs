/** Retain, validate, and grade observable Skill Eval execution evidence. */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  loadJson,
  loadJsonValue,
  requireFiniteJson,
  requireNumber,
  requireRealDirectory,
  requireString,
  resolveCanonicalPath,
  safeArtifact,
  sha256File,
  sha256Json,
  traceAssignmentContext,
  validateArtifactPath,
  verifyLockedInputs,
  writeJson,
} from "./skill-eval-authority.mjs";
import {
  ASSIGNMENT_CONTRACT,
  DETERMINISTIC_ASSERTION_TYPES,
  DISPATCH_RECEIPT_CONTRACT,
  EXECUTION_CONTRACT,
  ManifestError,
  PLAN_CONTRACT,
  SEMANTIC_ASSERTION_TYPES,
  SEMANTIC_JUDGMENT_CONTRACT,
  TRACE_EVENT_CONTRACT,
  VERIFICATION_CONTRACT,
} from "./skill-eval-contracts.mjs";
import { declaredAssertionArtifacts } from "./skill-eval-evidence.mjs";
import {
  assessRuntimeMeasurement,
  compilePortableRegex,
  evaluateTextAssertion,
} from "./skill-eval-measurement.mjs";

const MAX_PAIRED_DISPATCH_SKEW_MS = 5_000;
const DISPATCH_OBSERVATIONS = new Set([
  "host_dispatch",
  "process_spawn",
  "external_harness",
]);
const TRACE_CAPTURE_SOURCE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
export const RESERVED_ARM_RESULT_FIELDS = new Set([
  "arm",
  "complete",
  "passed",
  "required_pass_rate",
  "forbidden_actions",
  "side_effects",
  "binding_errors",
  "repeats",
  "artifacts",
]);
const EXECUTION_FIELDS = new Set([
  "contract",
  "run_id",
  "case_id",
  "arm",
  "repeat",
  "assignment_digest",
  "execution_profile_digest",
  "status",
  "forbidden_actions",
  "side_effects",
  "metrics",
  "artifact_digests",
  "dispatch",
  "source_trace",
  "trace",
]);
const DISPATCH_RECEIPT_FIELDS = new Set([
  "contract",
  "run_id",
  "case_id",
  "arm",
  "repeat",
  "assignment_digest",
  "execution_profile_digest",
  "provider",
  "harness",
  "observation",
  "dispatch_id",
  "worker_id",
  "batch_id",
  "dispatched_at",
]);
const DISPATCH_DESCRIPTOR_FIELDS = new Set([
  "artifact",
  "digest",
  "provider",
  "harness",
  "observation",
  "dispatch_id",
  "worker_id",
  "batch_id",
  "dispatched_at",
]);
const SOURCE_TRACE_REQUIRED_FIELDS = new Set([
  "artifact",
  "digest",
  "adapter",
  "format",
  "source_stream_digest",
  "source_event_count",
  "retained_event_count",
  "redaction",
]);
const SOURCE_TRACE_DESCRIPTOR_FIELDS = new Set([
  ...SOURCE_TRACE_REQUIRED_FIELDS,
  "source_agent",
  "registry_entry_digest",
  "runtime_binding_digest",
  "agent_version",
  "executable_digest",
  "argv_digest",
  "parser_id",
  "parser_version",
  "parser_digest",
  "contract_urls",
  "adapter_maturity",
  "source_contract_version",
  "contract_stability",
  "evidence_authority",
]);
const SOURCE_TRACE_OPTIONAL_FIELDS = [...SOURCE_TRACE_DESCRIPTOR_FIELDS].filter(
  (field) => !SOURCE_TRACE_REQUIRED_FIELDS.has(field),
);
const TRACE_DESCRIPTOR_FIELDS = new Set([
  "artifact",
  "digest",
  "capture_source",
  "source_trace_required",
  "complete",
  "event_count",
  "started_at",
  "finished_at",
  "duration_ms",
]);
const TRACE_EVENT_FIELDS = new Set([
  "contract",
  "event_id",
  "run_id",
  "case_id",
  "arm",
  "repeat",
  "sequence",
  "occurred_at",
  "elapsed_ms",
  "kind",
  "status",
  "summary",
  "details",
  "artifact_refs",
]);
export const TRACE_EVENT_KINDS = new Set([
  "execution_started",
  "file_read",
  "tool_call",
  "command",
  "agent_message",
  "artifact_written",
  "error",
  "execution_finished",
]);
const TRACE_FORBIDDEN_DETAIL_KEYS = new Set([
  "analysis",
  "chain_of_thought",
  "private_reasoning",
  "reasoning",
  "signature",
  "thinking",
  "thought",
  "thoughts",
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function readUtf8(path) {
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}

function unsupportedFields(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key)).sort();
}

function missingFields(value, required) {
  return [...required].filter((key) => !Object.hasOwn(value, key)).sort();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function traceTimestamp() {
  return new Date().toISOString();
}

function parseTraceTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return null;

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (zone[0] === "+" ? 1 : -1);
  }

  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, "0").slice(0, 3)));
  const parsed = instant.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(parsed) ? parsed : null;
}

function expectedDispatchObservation(profile) {
  const observation = profile.dispatch_observation;
  if (!DISPATCH_OBSERVATIONS.has(observation)) {
    throw new ManifestError("execution profile dispatch_observation is invalid");
  }
  return String(observation);
}

function relativePosix(from, to) {
  return relative(from, to).split(sep).join("/");
}

function boundExecutionProfile({ assignmentPath, workspace, assignment }) {
  const planPath = safeArtifact(workspace, "execution-plan.json");
  const lockPath = safeArtifact(workspace, "run-lock.json");
  if (!isFile(planPath) || !isFile(lockPath)) {
    throw new ManifestError("dispatch receipt requires execution-plan.json and run-lock.json");
  }
  const plan = loadJson(planPath);
  const lock = loadJson(lockPath);
  const relativeAssignment = relativePosix(resolve(workspace), resolve(assignmentPath));
  const assignmentDigests = lock.assignment_digests;
  if (!plainObject(assignmentDigests) || assignmentDigests[relativeAssignment] !== sha256File(assignmentPath)) {
    throw new ManifestError("dispatch assignment digest does not match the run lock");
  }
  if (lock.plan_digest !== sha256File(planPath)) {
    throw new ManifestError("dispatch execution plan digest does not match the run lock");
  }
  const profile = plan.execution_profile;
  if (!plainObject(profile)) throw new ManifestError("dispatch execution profile is missing");
  if (profile.digest !== assignment.execution_profile_digest) {
    throw new ManifestError("dispatch execution profile digest is stale");
  }
  if (plan.run_id !== assignment.run_id) {
    throw new ManifestError("dispatch assignment and plan identities do not match");
  }
  return profile;
}

export function recordDispatchReceipt({
  assignmentPath,
  workspace,
  dispatchId,
  workerId,
  batchId = undefined,
}) {
  workspace = resolveCanonicalPath(workspace);
  assignmentPath = resolveCanonicalPath(assignmentPath);
  const { assignment, repeatRoot } = traceAssignmentContext({ assignmentPath, workspace });
  const profile = boundExecutionProfile({ assignmentPath, workspace, assignment });
  const normalizedDispatchId = requireString(dispatchId, "dispatch_id");
  const normalizedWorkerId = requireString(workerId, "worker_id");
  if (normalizedDispatchId.length > 256 || normalizedWorkerId.length > 256) {
    throw new ManifestError("dispatch_id and worker_id must not exceed 256 characters");
  }
  const normalizedBatchId = batchId !== undefined && batchId !== null
    ? requireString(batchId, "batch_id")
    : `batch-${sha256Json({
      run_id: assignment.run_id,
      case_id: assignment.case_id,
      repeat: assignment.repeat,
    }).slice(0, 20)}`;
  if (normalizedBatchId.length > 256) {
    throw new ManifestError("batch_id must not exceed 256 characters");
  }
  const artifact = validateArtifactPath(assignment.dispatch_artifact, "assignment.dispatch_artifact");
  const receiptPath = safeArtifact(repeatRoot, artifact);
  if (existsSync(receiptPath) || isSymlink(receiptPath)) {
    throw new ManifestError("dispatch receipt is already recorded");
  }
  const receipt = {
    contract: DISPATCH_RECEIPT_CONTRACT,
    run_id: assignment.run_id,
    case_id: assignment.case_id,
    arm: assignment.arm,
    repeat: assignment.repeat,
    assignment_digest: sha256File(assignmentPath),
    execution_profile_digest: assignment.execution_profile_digest,
    provider: profile.target,
    harness: profile.harness,
    observation: expectedDispatchObservation(profile),
    dispatch_id: normalizedDispatchId,
    worker_id: normalizedWorkerId,
    batch_id: normalizedBatchId,
    dispatched_at: traceTimestamp(),
  };
  writeJson(receiptPath, receipt);
  return receipt;
}

function dispatchDescriptor({ assignment, repeatRoot }) {
  const artifact = validateArtifactPath(assignment.dispatch_artifact, "assignment.dispatch_artifact");
  const receiptPath = safeArtifact(repeatRoot, artifact);
  if (!isFile(receiptPath)) return null;
  const receipt = loadJson(receiptPath);
  return {
    artifact,
    digest: sha256File(receiptPath),
    provider: receipt.provider,
    harness: receipt.harness,
    observation: receipt.observation,
    dispatch_id: receipt.dispatch_id,
    worker_id: receipt.worker_id,
    batch_id: receipt.batch_id,
    dispatched_at: receipt.dispatched_at,
  };
}

function validateDispatchReceipt({
  repeatRoot,
  descriptor,
  assignment,
  assignmentDigest,
  executionProfile,
}) {
  const errors = [];
  const expectedArtifact = validateArtifactPath(assignment.dispatch_artifact, "assignment.dispatch_artifact");
  if (!plainObject(descriptor)) {
    return [{ artifact: expectedArtifact }, ["execution dispatch receipt is missing"]];
  }
  const unsupported = unsupportedFields(descriptor, DISPATCH_DESCRIPTOR_FIELDS);
  if (unsupported.length > 0) {
    errors.push(`execution dispatch descriptor contains unsupported fields: ${unsupported.join(", ")}`);
  }
  const missing = missingFields(descriptor, DISPATCH_DESCRIPTOR_FIELDS);
  if (missing.length > 0) {
    errors.push(`execution dispatch descriptor is missing fields: ${missing.join(", ")}`);
  }
  if (descriptor.artifact !== expectedArtifact) {
    errors.push("execution dispatch artifact does not match the locked assignment");
  }
  const receiptPath = safeArtifact(repeatRoot, expectedArtifact);
  if (!isFile(receiptPath)) return [{ ...descriptor }, [...errors, "dispatch-receipt.json is missing"]];
  const actualDigest = sha256File(receiptPath);
  if (descriptor.digest !== actualDigest) errors.push("dispatch receipt digest is missing or mismatched");
  let receipt;
  try {
    receipt = loadJson(receiptPath);
  } catch (error) {
    if (!(error instanceof ManifestError)) throw error;
    return [{ ...descriptor, digest: actualDigest }, [...errors, error.message]];
  }
  const unsupportedReceipt = unsupportedFields(receipt, DISPATCH_RECEIPT_FIELDS);
  if (unsupportedReceipt.length > 0) {
    errors.push(`dispatch receipt contains unsupported fields: ${unsupportedReceipt.join(", ")}`);
  }
  const missingReceipt = missingFields(receipt, DISPATCH_RECEIPT_FIELDS);
  if (missingReceipt.length > 0) errors.push(`dispatch receipt is missing fields: ${missingReceipt.join(", ")}`);
  const expectedIdentity = {
    contract: DISPATCH_RECEIPT_CONTRACT,
    run_id: assignment.run_id,
    case_id: assignment.case_id,
    arm: assignment.arm,
    repeat: assignment.repeat,
    assignment_digest: assignmentDigest,
    execution_profile_digest: assignment.execution_profile_digest,
    provider: executionProfile.target,
    harness: executionProfile.harness,
    observation: expectedDispatchObservation(executionProfile),
  };
  for (const [key, expectedValue] of Object.entries(expectedIdentity)) {
    if (!jsonEqual(receipt[key], expectedValue)) {
      errors.push(`dispatch receipt ${key} does not match the locked execution`);
    }
  }
  for (const key of ["provider", "harness", "observation", "dispatch_id", "worker_id", "batch_id", "dispatched_at"]) {
    if (!jsonEqual(descriptor[key], receipt[key])) {
      errors.push(`execution dispatch ${key} does not match its receipt`);
    }
  }
  if (!DISPATCH_OBSERVATIONS.has(receipt.observation)) errors.push("dispatch receipt observation is invalid");
  for (const key of ["dispatch_id", "worker_id", "batch_id"]) {
    if (typeof receipt[key] !== "string" || receipt[key] === "") errors.push(`dispatch receipt ${key} is invalid`);
  }
  if (parseTraceTimestamp(receipt.dispatched_at) === null) errors.push("dispatch receipt dispatched_at is invalid");
  return [{ ...descriptor, digest: actualDigest }, errors];
}

function forbiddenTraceDetailKeys(value, result = new Set()) {
  if (plainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const normalized = String(key).trim().toLowerCase().replaceAll("-", "_");
      if (TRACE_FORBIDDEN_DETAIL_KEYS.has(normalized)) result.add(String(key));
      forbiddenTraceDetailKeys(item, result);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) forbiddenTraceDetailKeys(item, result);
  }
  return result;
}

function readTraceJsonl(path) {
  const events = [];
  const errors = [];
  let lines;
  try {
    lines = readUtf8(path).split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
  } catch (error) {
    return [[], [`agent trace is unreadable: ${error.message}`]];
  }
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (line.trim() === "") {
      errors.push(`agent trace line ${lineNumber} is empty`);
      continue;
    }
    let value;
    try {
      value = JSON.parse(line);
      requireFiniteJson(value, `agent trace line ${lineNumber}`);
    } catch (error) {
      errors.push(`agent trace line ${lineNumber} is invalid JSON: ${error.message}`);
      continue;
    }
    if (!plainObject(value)) {
      errors.push(`agent trace line ${lineNumber} must be an object`);
      continue;
    }
    events.push(value);
  }
  return [events, errors];
}

function validateSourceTrace({
  workspace,
  repeatRoot,
  descriptor,
  assignment,
  traceEvents,
  required,
  expectedAdapter,
  expectedFormat,
  expectedBinding,
}) {
  const errors = [];
  const lockedArtifact = assignment.source_trace_artifact;
  const expectedArtifact = lockedArtifact !== undefined && lockedArtifact !== null
    ? validateArtifactPath(lockedArtifact, "assignment.source_trace_artifact")
    : null;
  if (descriptor === undefined || descriptor === null) {
    return [null, required ? ["required source trace descriptor is missing"] : []];
  }
  if (!plainObject(descriptor)) return [null, ["execution source_trace must be an object or null"]];
  if (expectedArtifact === null) {
    return [{ ...descriptor }, ["execution source_trace is present but the locked profile declares no source stream"]];
  }
  const unsupported = unsupportedFields(descriptor, SOURCE_TRACE_DESCRIPTOR_FIELDS);
  if (unsupported.length > 0) errors.push(`execution source trace contains unsupported fields: ${unsupported.join(", ")}`);
  const missing = missingFields(descriptor, SOURCE_TRACE_REQUIRED_FIELDS);
  if (missing.length > 0) errors.push(`execution source trace is missing fields: ${missing.join(", ")}`);
  if (descriptor.artifact !== expectedArtifact) {
    errors.push("execution source trace artifact does not match the locked assignment");
  }
  const sourcePath = safeArtifact(repeatRoot, expectedArtifact);
  if (!isFile(sourcePath)) return [{ ...descriptor }, [...errors, "source trace artifact is missing"]];
  const actualDigest = sha256File(sourcePath);
  if (descriptor.digest !== actualDigest) errors.push("source trace digest is missing or mismatched");
  if (descriptor.adapter !== expectedAdapter) errors.push("source trace adapter does not match the locked execution profile");
  if (descriptor.format !== expectedFormat) errors.push("source trace format does not match the locked execution profile");
  if (plainObject(expectedBinding)) {
    const provenanceBindings = {
      source_agent: "source_agent",
      registry_entry_digest: "registry_entry_digest",
      adapter_maturity: "implementation_maturity",
      source_contract_version: "source_contract_version",
      contract_stability: "contract_stability",
      evidence_authority: "evidence_authority",
    };
    for (const [descriptorField, bindingField] of Object.entries(provenanceBindings)) {
      if (!jsonEqual(descriptor[descriptorField], expectedBinding[bindingField])) {
        errors.push(`source trace ${descriptorField} does not match the locked adapter binding`);
      }
    }
    const runtimeBindingPath = join(workspace, "agent-runtime-binding.json");
    let bindingMetadata;
    try {
      bindingMetadata = lstatSync(runtimeBindingPath);
    } catch {
      bindingMetadata = null;
    }
    if (bindingMetadata?.isSymbolicLink() || !bindingMetadata?.isFile() || bindingMetadata.nlink !== 1) {
      errors.push("Agent runtime binding is missing or not a private regular file");
    } else {
      let runtimeBinding;
      try {
        runtimeBinding = loadJson(runtimeBindingPath);
      } catch (error) {
        if (!(error instanceof ManifestError)) throw error;
        errors.push(`Agent runtime binding is invalid: ${error.message}`);
      }
      if (runtimeBinding) {
        if (runtimeBinding.contract !== "skill-reviewer.agent-runtime-binding") errors.push("Agent runtime binding contract is invalid");
        if (runtimeBinding.adapter_id !== expectedAdapter) errors.push("Agent runtime binding adapter does not match the locked profile");
        if (runtimeBinding.registry_entry_digest !== expectedBinding.registry_entry_digest) errors.push("Agent runtime binding registry digest is stale");
        if (runtimeBinding.agent_version !== descriptor.agent_version) errors.push("source trace agent_version does not match the Agent runtime binding");
        if (runtimeBinding.executable_digest !== descriptor.executable_digest) errors.push("source trace executable_digest does not match the Agent runtime binding");
        const expectedVersion = expectedBinding.executable_version;
        const observedVersion = runtimeBinding.agent_version;
        const versionPattern = typeof expectedVersion === "string"
          ? new RegExp(`(?:^|[^0-9A-Za-z.])${escapeRegExp(expectedVersion)}(?:$|[^0-9A-Za-z.])`)
          : null;
        if (typeof expectedVersion !== "string" || typeof observedVersion !== "string" || !versionPattern.test(observedVersion)) {
          errors.push("Agent runtime binding version is outside the locked adapter contract");
        }
        for (const field of ["registry_entry_digest", "executable_digest", "environment_names_digest"]) {
          if (typeof runtimeBinding[field] !== "string" || !/^[a-f0-9]{64}$/.test(runtimeBinding[field])) {
            errors.push(`Agent runtime binding ${field} is invalid`);
          }
        }
        if (typeof runtimeBinding.agent_version !== "string" || runtimeBinding.agent_version.trim() === "") errors.push("Agent runtime binding agent_version is invalid");
        if (typeof runtimeBinding.executable_path !== "string" || !isAbsolute(runtimeBinding.executable_path)) errors.push("Agent runtime binding executable_path is invalid");
        if (!Number.isInteger(runtimeBinding.timeout_seconds) || runtimeBinding.timeout_seconds < 1) errors.push("Agent runtime binding timeout_seconds is invalid");
        const runtimeCost = runtimeBinding.cost_limit_usd;
        if (runtimeCost !== undefined && runtimeCost !== null && (typeof runtimeCost !== "number" || !Number.isFinite(runtimeCost) || runtimeCost < 0)) {
          errors.push("Agent runtime binding cost_limit_usd is invalid");
        }
      }
    }
    const actualRuntimeBindingDigest = sha256File(runtimeBindingPath);
    if (descriptor.runtime_binding_digest !== actualRuntimeBindingDigest) {
      errors.push("source trace runtime_binding_digest does not match the Agent runtime binding");
    }
  }
  if (typeof descriptor.source_stream_digest !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.source_stream_digest)) {
    errors.push("source trace source_stream_digest is invalid");
  }
  if (!Number.isInteger(descriptor.source_event_count) || descriptor.source_event_count < 0) errors.push("source trace source_event_count is invalid");
  if (!Number.isInteger(descriptor.retained_event_count) || descriptor.retained_event_count < 0) errors.push("source trace retained_event_count is invalid");
  let retainedLines = [];
  let actualRetainedCount = null;
  try {
    retainedLines = readUtf8(sourcePath).split(/\r?\n/).filter((line) => line.trim() !== "");
    actualRetainedCount = retainedLines.length;
  } catch (error) {
    errors.push(`source trace artifact is unreadable: ${error.message}`);
  }
  for (let index = 0; index < retainedLines.length; index += 1) {
    const lineNumber = index + 1;
    let event;
    try {
      event = JSON.parse(retainedLines[index]);
      requireFiniteJson(event, `source trace line ${lineNumber}`);
    } catch (error) {
      errors.push(`source trace line ${lineNumber} is invalid JSON: ${error.message}`);
      continue;
    }
    if (!plainObject(event)) {
      errors.push(`source trace line ${lineNumber} must be an object`);
      continue;
    }
    const forbidden = [...forbiddenTraceDetailKeys(event)].sort();
    if (forbidden.length > 0) errors.push(`source trace line ${lineNumber} contains private-reasoning fields: ${forbidden.join(", ")}`);
    const pending = [event];
    while (pending.length > 0) {
      const value = pending.pop();
      if (plainObject(value)) {
        if (value.type === "reasoning" && value.redacted !== true) {
          errors.push(`source trace line ${lineNumber} contains unredacted reasoning`);
          break;
        }
        if (value.type === "thinking" && value.redacted !== true) {
          errors.push(`source trace line ${lineNumber} contains unredacted thinking`);
          break;
        }
        pending.push(...Object.values(value));
      } else if (Array.isArray(value)) {
        pending.push(...value);
      }
    }
  }
  if (actualRetainedCount !== null && descriptor.retained_event_count !== actualRetainedCount) errors.push("source trace retained_event_count does not match the artifact");
  if (Number.isInteger(descriptor.source_event_count) && Number.isInteger(descriptor.retained_event_count) && descriptor.source_event_count < descriptor.retained_event_count) {
    errors.push("source trace source_event_count is smaller than retained events");
  }
  if (descriptor.redaction !== "private-reasoning-fields-removed") errors.push("source trace redaction contract is invalid");
  for (const field of ["registry_entry_digest", "runtime_binding_digest", "executable_digest", "argv_digest", "parser_digest"]) {
    const value = descriptor[field];
    if (value !== undefined && value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) errors.push(`source trace ${field} is invalid`);
  }
  for (const field of ["source_agent", "agent_version", "parser_id", "parser_version", "adapter_maturity", "contract_stability", "evidence_authority"]) {
    const value = descriptor[field];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.trim() === "")) errors.push(`source trace ${field} is invalid`);
  }
  const contractUrls = descriptor.contract_urls;
  if (contractUrls !== undefined && contractUrls !== null && (!Array.isArray(contractUrls) || contractUrls.length === 0 || !contractUrls.every((value) => typeof value === "string" && value.startsWith("https://")))) {
    errors.push("source trace contract_urls is invalid");
  }
  if (plainObject(expectedBinding) && !jsonEqual(contractUrls, expectedBinding.official_sources)) {
    errors.push("source trace contract_urls do not match the locked adapter binding");
  }
  const matchingEvents = traceEvents.filter((event) => event.kind === "artifact_written" && Array.isArray(event.artifact_refs) && event.artifact_refs.includes(expectedArtifact));
  if (matchingEvents.length === 0) {
    errors.push("agent trace is missing source trace artifact provenance");
  } else if (!matchingEvents.some((event) => plainObject(event.details)
    && event.details.digest === descriptor.digest
    && event.details.source_stream_digest === descriptor.source_stream_digest
    && event.details.source_event_count === descriptor.source_event_count
    && event.details.retained_event_count === descriptor.retained_event_count
    && event.details.redaction === descriptor.redaction
    && event.details.adapter === descriptor.adapter
    && event.details.format === descriptor.format
    && SOURCE_TRACE_OPTIONAL_FIELDS.filter((field) => Object.hasOwn(descriptor, field)).every((field) => jsonEqual(event.details[field], descriptor[field])))) {
    errors.push("source trace descriptor is not bound to its artifact event");
  }
  return [{ ...descriptor, digest: actualDigest }, errors];
}

function validateAgentTrace({
  tracePath,
  descriptor,
  expectedIdentity,
  expectedStatus,
  expectedArtifact,
  expectedCaptureSource,
  sourceTraceRequired,
}) {
  const errors = [];
  if (!plainObject(descriptor)) return [[], {}, ["execution trace must be an object"]];
  const unsupported = unsupportedFields(descriptor, TRACE_DESCRIPTOR_FIELDS);
  if (unsupported.length > 0) errors.push(`execution trace contains unsupported fields: ${unsupported.join(", ")}`);
  const missing = missingFields(descriptor, TRACE_DESCRIPTOR_FIELDS);
  if (missing.length > 0) errors.push(`execution trace is missing fields: ${missing.join(", ")}`);
  if (descriptor.artifact !== expectedArtifact) errors.push("execution trace artifact does not match the locked assignment");
  if (descriptor.capture_source !== expectedCaptureSource) errors.push("execution trace capture_source does not match the locked execution profile");
  if (descriptor.source_trace_required !== sourceTraceRequired) errors.push("execution trace source_trace_required does not match the locked execution profile");
  if (descriptor.complete !== true) errors.push("execution trace is not finalized");
  if (!isFile(tracePath)) return [[], { ...descriptor }, [...errors, "agent-trace.jsonl is missing"]];
  const actualDigest = sha256File(tracePath);
  if (descriptor.digest !== actualDigest) errors.push("execution trace digest is missing or mismatched");
  const [events, parseErrors] = readTraceJsonl(tracePath);
  errors.push(...parseErrors);
  const seenIds = new Set();
  let previousElapsed = -1;
  for (let index = 0; index < events.length; index += 1) {
    const ordinal = index + 1;
    const event = events[index];
    const unsupportedEventFields = unsupportedFields(event, TRACE_EVENT_FIELDS);
    if (unsupportedEventFields.length > 0) errors.push(`agent trace event ${ordinal} contains unsupported fields: ${unsupportedEventFields.join(", ")}`);
    const missingEventFields = missingFields(event, TRACE_EVENT_FIELDS);
    if (missingEventFields.length > 0) errors.push(`agent trace event ${ordinal} is missing fields: ${missingEventFields.join(", ")}`);
    if (event.contract !== TRACE_EVENT_CONTRACT) errors.push(`agent trace event ${ordinal} contract is invalid`);
    for (const [key, expectedValue] of Object.entries(expectedIdentity)) {
      if (!jsonEqual(event[key], expectedValue)) errors.push(`agent trace event ${ordinal} ${key} does not match the locked assignment`);
    }
    if (event.sequence !== ordinal) errors.push(`agent trace event ${ordinal} sequence is not contiguous`);
    if (typeof event.event_id !== "string" || event.event_id === "") errors.push(`agent trace event ${ordinal} event_id is invalid`);
    else if (seenIds.has(event.event_id)) errors.push(`agent trace event ${ordinal} event_id is duplicated`);
    else seenIds.add(event.event_id);
    if (!TRACE_EVENT_KINDS.has(event.kind)) errors.push(`agent trace event ${ordinal} kind is invalid`);
    if (parseTraceTimestamp(event.occurred_at) === null) errors.push(`agent trace event ${ordinal} occurred_at is invalid`);
    if (!Number.isInteger(event.elapsed_ms) || event.elapsed_ms < 0) errors.push(`agent trace event ${ordinal} elapsed_ms is invalid`);
    else if (event.elapsed_ms < previousElapsed) errors.push(`agent trace event ${ordinal} elapsed_ms is not monotonic`);
    else previousElapsed = event.elapsed_ms;
    if (typeof event.status !== "string" || event.status === "") errors.push(`agent trace event ${ordinal} status is invalid`);
    if (typeof event.summary !== "string" || event.summary === "") errors.push(`agent trace event ${ordinal} summary is invalid`);
    if (!plainObject(event.details)) errors.push(`agent trace event ${ordinal} details must be an object`);
    else {
      const forbidden = [...forbiddenTraceDetailKeys(event.details)].sort();
      if (forbidden.length > 0) errors.push(`agent trace event ${ordinal} contains private-reasoning fields: ${forbidden.join(", ")}`);
    }
    if (!Array.isArray(event.artifact_refs) || !event.artifact_refs.every((value) => typeof value === "string" && value !== "")) {
      errors.push(`agent trace event ${ordinal} artifact_refs must be an array of paths`);
    }
  }
  if (events.length === 0) {
    errors.push("agent trace contains no events");
  } else {
    const first = events[0];
    const last = events.at(-1);
    if (first.kind !== "execution_started") errors.push("agent trace must start with execution_started");
    if (last.kind !== "execution_finished") errors.push("agent trace must end with execution_finished");
    if (last.status !== expectedStatus) errors.push("agent trace final status does not match execution status");
    if (descriptor.started_at !== first.occurred_at) errors.push("execution trace started_at does not match the first event");
    if (descriptor.finished_at !== last.occurred_at) errors.push("execution trace finished_at does not match the final event");
    if (descriptor.duration_ms !== last.elapsed_ms) errors.push("execution trace duration_ms does not match the final event");
    if (!events.some((event) => new Set(["file_read", "tool_call", "command", "agent_message", "artifact_written", "error"]).has(event.kind))) {
      errors.push("agent trace contains no observable Agent action");
    }
    if (!plainObject(first.details) || first.details.capture_source !== descriptor.capture_source) {
      errors.push("execution trace capture_source is not bound to its first event");
    }
  }
  if (descriptor.event_count !== events.length) errors.push("execution trace event_count does not match the JSONL record");
  if (!Number.isInteger(descriptor.duration_ms) || descriptor.duration_ms < 0) errors.push("execution trace duration_ms is invalid");
  return [events, { ...descriptor, digest: actualDigest }, errors];
}

function traceEventIdsByArtifact(events) {
  const result = {};
  for (const event of events) {
    if (event.kind !== "artifact_written" || typeof event.event_id !== "string" || !Array.isArray(event.artifact_refs)) continue;
    for (const ref of event.artifact_refs) {
      if (typeof ref === "string" && ref !== "") (result[ref] ??= []).push(event.event_id);
    }
  }
  return result;
}

function appendTraceEvent(path, event) {
  const parent = dirname(path);
  if (isSymlink(path) || realpathSync(parent) !== parent) {
    throw new ManifestError(`refusing to append through a symbolic link: ${path}`);
  }
  let descriptor;
  try {
    const payload = `${JSON.stringify(event)}\n`;
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollow, 0o600);
    writeSync(descriptor, payload, undefined, "utf8");
    fsyncSync(descriptor);
  } catch {
    throw new ManifestError(`unable to append Agent trace event: ${path}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function newTraceEvent({ assignment, sequence, startedAt, kind, status, summary, details, artifactRefs }) {
  const occurredAt = traceTimestamp();
  const started = parseTraceTimestamp(startedAt);
  const occurred = parseTraceTimestamp(occurredAt);
  const elapsedMs = started !== null && occurred !== null ? Math.max(0, Math.trunc(occurred - started)) : 0;
  const identity = {
    run_id: assignment.run_id,
    case_id: assignment.case_id,
    arm: assignment.arm,
    repeat: assignment.repeat,
  };
  const eventId = `event-${String(sequence).padStart(4, "0")}-${sha256Json({
    ...identity,
    sequence,
    occurred_at: occurredAt,
    kind,
    summary,
  }).slice(0, 12)}`;
  return {
    contract: TRACE_EVENT_CONTRACT,
    event_id: eventId,
    ...identity,
    sequence,
    occurred_at: occurredAt,
    elapsed_ms: elapsedMs,
    kind,
    status,
    summary,
    details,
    artifact_refs: artifactRefs,
  };
}

export function recordTraceEvent({
  assignmentPath,
  workspace,
  kind,
  summary,
  status,
  details,
  artifactRefs,
  captureSource,
}) {
  if (!TRACE_EVENT_KINDS.has(kind)) throw new ManifestError(`unsupported Agent trace event kind: ${kind}`);
  if (typeof summary !== "string" || summary.trim() === "") throw new ManifestError("Agent trace event summary must not be empty");
  if (!plainObject(details)) throw new ManifestError("Agent trace event details must be an object");
  const forbidden = [...forbiddenTraceDetailKeys(details)].sort();
  if (forbidden.length > 0) throw new ManifestError(`Agent trace must not contain private-reasoning fields: ${forbidden.join(", ")}`);
  const normalizedArtifactRefs = artifactRefs.map((value) => validateArtifactPath(value, "Agent trace artifact reference"));
  const { assignment, tracePath } = traceAssignmentContext({ assignmentPath, workspace });
  if (captureSource === undefined || captureSource === null) {
    const executionProfile = boundExecutionProfile({
      assignmentPath: resolve(assignmentPath),
      workspace: resolve(workspace),
      assignment,
    });
    captureSource = requireString(executionProfile.trace?.capture_source, "execution_profile.trace.capture_source");
  }
  if (!TRACE_CAPTURE_SOURCE_PATTERN.test(captureSource)) throw new ManifestError(`unsupported Agent trace capture source: ${captureSource}`);
  let events = [];
  if (existsSync(tracePath)) {
    let errors;
    [events, errors] = readTraceJsonl(tracePath);
    if (errors.length > 0) throw new ManifestError(`existing Agent trace is invalid: ${errors.join("; ")}`);
    if (events.at(-1)?.kind === "execution_finished") throw new ManifestError("Agent trace is already finalized");
    if (events.length > 0 && plainObject(events[0].details) && events[0].details.capture_source !== captureSource) {
      throw new ManifestError("Agent trace capture source cannot change during execution");
    }
  }
  if (events.length === 0) {
    const startedAt = traceTimestamp();
    const startEvent = newTraceEvent({
      assignment,
      sequence: 1,
      startedAt,
      kind: "execution_started",
      status: "running",
      summary: "Agent execution started",
      details: { capture_source: captureSource },
      artifactRefs: [],
    });
    startEvent.elapsed_ms = 0;
    appendTraceEvent(tracePath, startEvent);
    events.push(startEvent);
  } else if (kind === "execution_started") {
    throw new ManifestError("Agent trace already has an execution_started event");
  }
  if (kind === "execution_started") return events[0];
  const event = newTraceEvent({
    assignment,
    sequence: events.length + 1,
    startedAt: String(events[0].occurred_at),
    kind,
    status,
    summary: summary.trim(),
    details,
    artifactRefs: normalizedArtifactRefs,
  });
  appendTraceEvent(tracePath, event);
  return event;
}

export function finalizeExecution({
  assignmentPath,
  workspace,
  status,
  metrics,
  forbiddenActions,
  sideEffects,
  captureSource,
  sourceTrace = null,
}) {
  if (!["completed", "failed", "timed_out", "interrupted"].includes(status)) throw new ManifestError(`unsupported execution status: ${status}`);
  const { assignment, repeatRoot, tracePath } = traceAssignmentContext({ assignmentPath, workspace });
  const executionProfile = boundExecutionProfile({ assignmentPath: resolve(assignmentPath), workspace: resolve(workspace), assignment });
  const traceProfile = executionProfile.trace;
  if (!plainObject(traceProfile)) throw new ManifestError("execution profile trace contract is missing");
  const expectedCaptureSource = requireString(traceProfile.capture_source, "execution_profile.trace.capture_source");
  if (captureSource === undefined || captureSource === null) captureSource = expectedCaptureSource;
  if (captureSource !== expectedCaptureSource) throw new ManifestError("execution capture source does not match the locked execution profile");
  const sourceProfile = traceProfile.source;
  if (sourceProfile !== undefined && sourceProfile !== null && !plainObject(sourceProfile)) throw new ManifestError("execution profile trace source contract is invalid");
  const executionPath = safeArtifact(repeatRoot, validateArtifactPath(assignment.execution_artifact, "assignment.execution_artifact"));
  if (existsSync(executionPath) || isSymlink(executionPath)) throw new ManifestError("execution.json is already finalized");
  const artifactDigests = {};
  const expectedArtifacts = assignment.expected_artifacts;
  if (!Array.isArray(expectedArtifacts) || !expectedArtifacts.every((value) => typeof value === "string")) throw new ManifestError("assignment.expected_artifacts must be an array of paths");
  const artifactOwnership = assignment.artifact_ownership;
  if (!plainObject(artifactOwnership)
    || !jsonEqual(artifactOwnership.worker, expectedArtifacts)
    || !Array.isArray(artifactOwnership.framework)
    || !Array.isArray(artifactOwnership.asserted_framework)) {
    throw new ManifestError("assignment artifact ownership does not match expected artifacts");
  }
  let existingEvents = [];
  let existingErrors = [];
  if (isFile(tracePath)) [existingEvents, existingErrors] = readTraceJsonl(tracePath);
  if (existingErrors.length > 0) throw new ManifestError(`existing Agent trace is invalid: ${existingErrors.join("; ")}`);
  const recordedRefs = new Set(existingEvents
    .filter((event) => event.kind === "artifact_written" && Array.isArray(event.artifact_refs))
    .flatMap((event) => event.artifact_refs)
    .filter((ref) => typeof ref === "string"));
  for (const artifact of expectedArtifacts) {
    const artifactPath = safeArtifact(repeatRoot, artifact);
    if (!isFile(artifactPath)) continue;
    const digest = sha256File(artifactPath);
    artifactDigests[artifact] = digest;
    if (!recordedRefs.has(artifact)) {
      recordTraceEvent({
        assignmentPath,
        workspace,
        kind: "artifact_written",
        summary: `Retained output artifact: ${artifact}`,
        status: "completed",
        details: { path: artifact, digest, size: statSync(artifactPath).size },
        artifactRefs: [artifact],
        captureSource,
      });
    }
  }
  recordTraceEvent({
    assignmentPath,
    workspace,
    kind: "execution_finished",
    summary: `Agent execution finished with status: ${status}`,
    status,
    details: { forbidden_action_count: forbiddenActions.length, side_effect_count: sideEffects.length },
    artifactRefs: [],
    captureSource,
  });
  const [events, traceErrors] = readTraceJsonl(tracePath);
  if (traceErrors.length > 0 || events.length === 0) throw new ManifestError(`unable to finalize Agent trace: ${traceErrors.join("; ")}`);
  const dispatch = dispatchDescriptor({ assignment, repeatRoot });
  const [, dispatchErrors] = validateDispatchReceipt({
    repeatRoot,
    descriptor: dispatch,
    assignment,
    assignmentDigest: sha256File(assignmentPath),
    executionProfile,
  });
  if (dispatch !== null && dispatchErrors.length > 0) throw new ManifestError(`unable to bind dispatch receipt: ${dispatchErrors.join("; ")}`);
  if (status === "completed" && dispatch === null) throw new ManifestError("completed execution requires a dispatch receipt");
  const [normalizedSourceTrace, sourceTraceErrors] = validateSourceTrace({
    workspace,
    repeatRoot,
    descriptor: sourceTrace,
    assignment,
    traceEvents: events,
    required: plainObject(sourceProfile) && status === "completed",
    expectedAdapter: String(executionProfile.adapter_id),
    expectedFormat: plainObject(sourceProfile) ? String(sourceProfile.format) : null,
    expectedBinding: plainObject(executionProfile.adapter_binding) ? executionProfile.adapter_binding : null,
  });
  if (sourceTraceErrors.length > 0) throw new ManifestError(`unable to bind source trace: ${sourceTraceErrors.join("; ")}`);
  const trace = {
    artifact: String(assignment.trace_artifact),
    digest: sha256File(tracePath),
    capture_source: captureSource,
    source_trace_required: plainObject(sourceProfile),
    complete: true,
    event_count: events.length,
    started_at: events[0].occurred_at,
    finished_at: events.at(-1).occurred_at,
    duration_ms: events.at(-1).elapsed_ms,
  };
  const execution = {
    contract: EXECUTION_CONTRACT,
    run_id: assignment.run_id,
    case_id: assignment.case_id,
    arm: assignment.arm,
    repeat: assignment.repeat,
    assignment_digest: sha256File(assignmentPath),
    execution_profile_digest: assignment.execution_profile_digest,
    status,
    forbidden_actions: forbiddenActions,
    side_effects: sideEffects,
    metrics,
    artifact_digests: artifactDigests,
    dispatch,
    source_trace: normalizedSourceTrace,
    trace,
  };
  writeJson(executionPath, execution);
  return execution;
}

function jsonPointer(value, pointer) {
  if (pointer === "") return [true, value];
  let current = value;
  const raw = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  for (const rawToken of raw.split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (plainObject(current) && Object.hasOwn(current, token)) current = current[token];
    else if (Array.isArray(current) && /^\d+$/.test(token) && Number(token) < current.length) current = current[Number(token)];
    else return [false, null];
  }
  return [true, current];
}

function jsonEqual(left, right) {
  if (typeof left === "boolean" || typeof right === "boolean") return typeof left === "boolean" && typeof right === "boolean" && left === right;
  if (typeof left === "number" && typeof right === "number") return left === right;
  if (typeof left !== typeof right || left === null || right === null) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (plainObject(left) || plainObject(right)) {
    if (!plainObject(left) || !plainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]));
  }
  return left === right;
}

function failedAssertion(assertionId, assertionType, severity, reason) {
  return { id: assertionId, type: assertionType, severity, passed: false, evidence: { reason } };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function gradeAssertion(assertion, repeatRoot) {
  const assertionId = requireString(assertion.id, "assertion.id");
  const assertionType = requireString(assertion.type, "assertion.type");
  if (!DETERMINISTIC_ASSERTION_TYPES.has(assertionType)) throw new ManifestError(`assertion ${assertionId} is not a deterministic assertion: ${assertionType}`);
  const severity = assertion.severity ?? "must_pass";
  if (!["must_pass", "should_pass"].includes(severity)) throw new ManifestError(`assertion ${assertionId} has invalid severity`);
  const artifact = requireString(assertion.artifact, `assertion ${assertionId}.artifact`);
  const artifactPath = safeArtifact(repeatRoot, artifact);
  let passed;
  let evidence;
  if (assertionType === "file_exists") {
    passed = isFile(artifactPath);
    evidence = { artifact, exists: passed };
  } else if (!isFile(artifactPath)) {
    return failedAssertion(assertionId, assertionType, severity, `missing artifact: ${artifact}`);
  } else if (["text_contains", "text_not_contains"].includes(assertionType)) {
    let content;
    try {
      content = readUtf8(artifactPath);
    } catch (error) {
      return failedAssertion(assertionId, assertionType, severity, `unreadable text artifact: ${error.message}`);
    }
    const rawExpected = assertion.expected;
    const expected = typeof rawExpected === "string" ? [rawExpected] : rawExpected;
    if (!Array.isArray(expected) || !expected.every((value) => typeof value === "string")) throw new ManifestError(`assertion ${assertionId} has invalid expected text`);
    if (assertionType === "text_contains") {
      passed = evaluateTextAssertion(assertion, content);
      evidence = { artifact, missing: expected.filter((value) => !content.includes(value)) };
    } else {
      passed = evaluateTextAssertion(assertion, content);
      evidence = { artifact, unexpected: expected.filter((value) => content.includes(value)) };
    }
  } else if (["text_matches", "text_not_matches"].includes(assertionType)) {
    let content;
    try {
      content = readUtf8(artifactPath);
    } catch (error) {
      return failedAssertion(assertionId, assertionType, severity, `unreadable text artifact: ${error.message}`);
    }
    const pattern = requireString(assertion.pattern, `assertion ${assertionId}.pattern`);
    let matched;
    try {
      matched = compilePortableRegex(pattern, "m").test(content);
    } catch (error) {
      throw new ManifestError(`assertion ${assertionId} has invalid pattern: ${error.message}`);
    }
    passed = evaluateTextAssertion(assertion, content);
    evidence = { artifact, pattern, matched };
  } else if (["json_path", "numeric_range"].includes(assertionType)) {
    let parsed;
    try {
      parsed = loadJsonValue(artifactPath);
    } catch (error) {
      return failedAssertion(assertionId, assertionType, severity, `invalid JSON artifact: ${error.message}`);
    }
    const pointer = assertion.path ?? "";
    if (typeof pointer !== "string") throw new ManifestError(`assertion ${assertionId}.path must be a string`);
    const [found, actual] = jsonPointer(parsed, pointer);
    if (assertionType === "json_path") {
      const operator = assertion.operator ?? "equals";
      const expected = assertion.expected;
      if (operator === "equals") passed = found && jsonEqual(actual, expected);
      else if (operator === "not_equals") passed = found && !jsonEqual(actual, expected);
      else if (operator === "contains") {
        if (typeof actual === "string") passed = found && typeof expected === "string" && actual.includes(expected);
        else if (Array.isArray(actual)) passed = found && actual.some((item) => jsonEqual(item, expected));
        else if (plainObject(actual)) passed = found && typeof expected === "string" && Object.hasOwn(actual, expected);
        else passed = false;
      } else if (operator === "exists") passed = found;
      else throw new ManifestError(`assertion ${assertionId} has invalid operator: ${operator}`);
      evidence = { artifact, path: pointer, operator, found, actual, expected: operator !== "exists" ? expected : null };
    } else {
      let numeric = null;
      if (found) {
        try {
          numeric = requireNumber(actual, `assertion ${assertionId}.actual`);
        } catch (error) {
          if (!(error instanceof ManifestError)) throw error;
        }
      }
      const minimum = assertion.minimum;
      const maximum = assertion.maximum;
      passed = numeric !== null;
      if (passed && minimum !== undefined && minimum !== null) passed = numeric >= Number(minimum);
      if (passed && maximum !== undefined && maximum !== null) passed = numeric <= Number(maximum);
      evidence = { artifact, path: pointer, actual: numeric, minimum, maximum };
    }
  } else if (assertionType === "event_absent") {
    const event = requireString(assertion.event, `assertion ${assertionId}.event`);
    const observed = [];
    try {
      const lines = readUtf8(artifactPath).split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() === "") continue;
        const record = JSON.parse(line);
        requireFiniteJson(record, `event log line ${index + 1}`);
        if (!plainObject(record)) throw new Error(`line ${index + 1} is not an object`);
        if (typeof record.event === "string") observed.push(record.event);
      }
    } catch (error) {
      return failedAssertion(assertionId, assertionType, severity, `invalid JSONL event log: ${error.message}`);
    }
    passed = !observed.includes(event);
    evidence = { artifact, forbidden_event: event, observed: uniqueSorted(observed) };
  } else if (assertionType === "digest_equals") {
    const expectedDigest = requireString(assertion.expected_sha256, `assertion ${assertionId}.expected_sha256`);
    const actualDigest = sha256File(artifactPath);
    passed = actualDigest === expectedDigest;
    evidence = { artifact, actual_sha256: actualDigest, expected_sha256: expectedDigest };
  } else {
    throw new ManifestError(`assertion ${assertionId} uses unsupported type: ${assertionType}`);
  }
  return { id: assertionId, type: assertionType, severity, passed, evidence };
}

function fsum(values) {
  const partials = [];
  for (let value of values) {
    let index = 0;
    for (const partial of partials) {
      let high = value;
      let low = partial;
      if (Math.abs(value) < Math.abs(partial)) {
        high = partial;
        low = value;
      }
      value = high + low;
      const residual = low - (value - high);
      if (residual !== 0) partials[index++] = residual;
    }
    partials.length = index;
    partials.push(value);
  }
  return partials.reduce((sum, value) => sum + value, 0);
}

export function gradeArm({
  workspace,
  case: evalCase,
  arm,
  runId,
  assignmentDigests,
  executionProfile,
  persist = true,
}) {
  const repeatResults = [];
  let complete = true;
  let requiredPassed = 0;
  let requiredTotal = 0;
  const forbiddenActions = [];
  const sideEffects = [];
  const bindingErrors = [];
  const artifacts = [];
  const metricSamples = {};
  const caseRoot = requireRealDirectory(join(workspace, "cases", String(evalCase.id)), workspace, "case root");
  const armRoot = requireRealDirectory(join(caseRoot, arm), workspace, "arm root");
  for (let repeat = 1; repeat <= Number(evalCase.repeats); repeat += 1) {
    const repeatRoot = requireRealDirectory(join(armRoot, `repeat-${repeat}`), workspace, "repeat root");
    const executionPath = safeArtifact(repeatRoot, "execution.json");
    const assignmentRelative = `assignments/${evalCase.id}/${arm}/repeat-${repeat}.json`;
    const expectedAssignmentDigest = assignmentDigests[assignmentRelative];
    if (typeof expectedAssignmentDigest !== "string") throw new ManifestError(`run lock is missing assignment digest: ${assignmentRelative}`);
    const assignmentPath = safeArtifact(workspace, assignmentRelative);
    const assignment = loadJson(assignmentPath);
    const assignmentIdentity = {
      contract: ASSIGNMENT_CONTRACT,
      run_id: runId,
      case_id: evalCase.id,
      arm,
      repeat,
    };
    for (const [key, expectedValue] of Object.entries(assignmentIdentity)) {
      if (!jsonEqual(assignment[key], expectedValue)) throw new ManifestError(`locked assignment ${key} mismatch: ${assignmentRelative}`);
    }
    const repeatBindingErrors = [];
    let executionDigest = null;
    let execution;
    if (!isFile(executionPath)) {
      execution = { status: "missing", forbidden_actions: [], side_effects: [], metrics: {} };
      repeatBindingErrors.push("execution.json is missing");
    } else {
      artifacts.push(relativePosix(workspace, executionPath));
      executionDigest = sha256File(executionPath);
      try {
        execution = loadJson(executionPath);
      } catch (error) {
        if (!(error instanceof ManifestError)) throw error;
        execution = { status: "invalid", forbidden_actions: [], side_effects: [], metrics: {} };
        repeatBindingErrors.push(error.message);
      }
    }
    const unsupportedExecutionFields = unsupportedFields(execution, EXECUTION_FIELDS);
    if (unsupportedExecutionFields.length > 0) repeatBindingErrors.push(`execution contains unsupported fields: ${unsupportedExecutionFields.join(", ")}`);
    const expectedIdentity = {
      contract: EXECUTION_CONTRACT,
      run_id: runId,
      case_id: evalCase.id,
      arm,
      repeat,
      assignment_digest: expectedAssignmentDigest,
      execution_profile_digest: assignment.execution_profile_digest,
    };
    for (const [key, expectedValue] of Object.entries(expectedIdentity)) {
      if (!jsonEqual(execution[key], expectedValue)) repeatBindingErrors.push(`execution ${key} does not match the locked assignment`);
    }
    if (!["completed", "failed", "timed_out", "interrupted"].includes(execution.status)) repeatBindingErrors.push("execution status is invalid");
    const [dispatch, dispatchErrors] = validateDispatchReceipt({
      repeatRoot,
      descriptor: execution.dispatch,
      assignment,
      assignmentDigest: expectedAssignmentDigest,
      executionProfile,
    });
    repeatBindingErrors.push(...dispatchErrors);
    if (typeof dispatch.artifact === "string") {
      const dispatchPath = safeArtifact(repeatRoot, dispatch.artifact);
      if (isFile(dispatchPath)) artifacts.push(relativePosix(workspace, dispatchPath));
    }
    const traceArtifact = validateArtifactPath(assignment.trace_artifact, `locked assignment trace_artifact: ${assignmentRelative}`);
    const tracePath = safeArtifact(repeatRoot, traceArtifact);
    if (isFile(tracePath)) artifacts.push(relativePosix(workspace, tracePath));
    const [traceEvents, traceDescriptor, traceErrors] = validateAgentTrace({
      tracePath,
      descriptor: execution.trace,
      expectedIdentity: { run_id: runId, case_id: evalCase.id, arm, repeat },
      expectedStatus: execution.status,
      expectedArtifact: traceArtifact,
      expectedCaptureSource: String(executionProfile.trace?.capture_source),
      sourceTraceRequired: plainObject(executionProfile.trace?.source),
    });
    repeatBindingErrors.push(...traceErrors);
    const [sourceTraceDescriptor, sourceTraceErrors] = validateSourceTrace({
      workspace,
      repeatRoot,
      descriptor: execution.source_trace,
      assignment,
      traceEvents,
      required: plainObject(executionProfile.trace?.source) && execution.status === "completed",
      expectedAdapter: String(executionProfile.adapter_id),
      expectedFormat: plainObject(executionProfile.trace?.source) ? String(executionProfile.trace.source.format) : null,
      expectedBinding: plainObject(executionProfile.adapter_binding) ? executionProfile.adapter_binding : null,
    });
    repeatBindingErrors.push(...sourceTraceErrors);
    if (plainObject(sourceTraceDescriptor) && typeof sourceTraceDescriptor.artifact === "string") {
      const sourcePath = safeArtifact(repeatRoot, sourceTraceDescriptor.artifact);
      if (isFile(sourcePath)) artifacts.push(relativePosix(workspace, sourcePath));
    }
    const traceEventIds = traceEventIdsByArtifact(traceEvents);
    const traceProvenanceErrors = [];
    const expectedArtifacts = assignment.expected_artifacts;
    let artifactDigests = execution.artifact_digests;
    if (!Array.isArray(expectedArtifacts) || !expectedArtifacts.every((value) => typeof value === "string")) {
      throw new ManifestError(`locked assignment has invalid expected_artifacts: ${assignmentRelative}`);
    }
    if (!plainObject(artifactDigests)) {
      repeatBindingErrors.push("execution artifact_digests must be an object");
      artifactDigests = {};
    }
    const actualArtifactDigests = {};
    for (const artifact of expectedArtifacts) {
      const artifactPath = safeArtifact(repeatRoot, artifact);
      if (!isFile(artifactPath)) continue;
      actualArtifactDigests[artifact] = sha256File(artifactPath);
      if (typeof artifactDigests[artifact] !== "string" || artifactDigests[artifact] !== actualArtifactDigests[artifact]) {
        repeatBindingErrors.push(`artifact digest is missing or mismatched: ${artifact}`);
      }
      if (!(traceEventIds[artifact]?.length > 0)) {
        const provenanceError = `agent trace is missing artifact_written provenance: ${artifact}`;
        repeatBindingErrors.push(provenanceError);
        traceProvenanceErrors.push(provenanceError);
      }
    }
    const unexpectedDigestPaths = Object.keys(artifactDigests).filter((path) => !expectedArtifacts.includes(path));
    if (unexpectedDigestPaths.length > 0) repeatBindingErrors.push(`execution contains undeclared artifact digests: ${unexpectedDigestPaths.sort().join(", ")}`);
    if (!Object.hasOwn(execution, "forbidden_actions")) repeatBindingErrors.push("execution forbidden_actions is required");
    if (Array.isArray(execution.forbidden_actions)) forbiddenActions.push(...execution.forbidden_actions.map(String));
    else repeatBindingErrors.push("execution forbidden_actions must be an array");
    if (!Object.hasOwn(execution, "side_effects")) repeatBindingErrors.push("execution side_effects is required");
    if (Array.isArray(execution.side_effects)) sideEffects.push(...execution.side_effects.map(String));
    else repeatBindingErrors.push("execution side_effects must be an array");
    const normalizedMetrics = {};
    if (!plainObject(execution.metrics)) {
      repeatBindingErrors.push("execution metrics must be an object");
    } else {
      for (const [metric, value] of Object.entries(execution.metrics)) {
        if (metric === "") {
          repeatBindingErrors.push("execution metric names must be non-empty strings");
          continue;
        }
        if (RESERVED_ARM_RESULT_FIELDS.has(metric)) {
          repeatBindingErrors.push(`execution metric uses reserved grader field: ${metric}`);
          continue;
        }
        try {
          normalizedMetrics[metric] = requireNumber(value, `execution metric ${metric}`);
        } catch (error) {
          if (!(error instanceof ManifestError)) throw error;
          repeatBindingErrors.push(error.message);
        }
      }
    }
    const repeatComplete = execution.status === "completed" && repeatBindingErrors.length === 0;
    complete = complete && repeatComplete;
    bindingErrors.push(...repeatBindingErrors.map((error) => `repeat ${repeat}: ${error}`));
    const assertions = (evalCase.assertions ?? [])
      .filter((assertion) => DETERMINISTIC_ASSERTION_TYPES.has(assertion.type))
      .map((assertion) => gradeAssertion(assertion, repeatRoot));
    for (const assertion of assertions) {
      if (!plainObject(assertion.evidence) || typeof assertion.evidence.artifact !== "string") continue;
      assertion.evidence.source_event_ids = traceEventIds[assertion.evidence.artifact] ?? [];
    }
    let repeatRequiredPassed = 0;
    let repeatRequiredTotal = 0;
    for (const result of assertions) {
      if (result.severity !== "must_pass") continue;
      requiredTotal += 1;
      requiredPassed += Number(result.passed);
      repeatRequiredTotal += 1;
      repeatRequiredPassed += Number(result.passed);
    }
    const metrics = repeatComplete ? normalizedMetrics : {};
    for (const [metric, value] of Object.entries(metrics)) (metricSamples[metric] ??= []).push(value);
    const repeatPassRate = repeatRequiredTotal > 0 ? repeatRequiredPassed / repeatRequiredTotal : 1;
    repeatResults.push({
      repeat,
      status: execution.status ?? null,
      binding_errors: repeatBindingErrors,
      execution_digest: executionDigest,
      artifact_digests: actualArtifactDigests,
      dispatch: { ...dispatch, valid: dispatchErrors.length === 0 },
      source_trace: plainObject(sourceTraceDescriptor) ? { ...sourceTraceDescriptor, valid: sourceTraceErrors.length === 0 } : null,
      trace: {
        ...traceDescriptor,
        valid: traceErrors.length === 0 && traceProvenanceErrors.length === 0,
        events: traceEvents,
      },
      assertions,
      required_pass_rate: repeatPassRate,
      metrics,
    });
  }
  const requiredPassRate = requiredTotal > 0 ? requiredPassed / requiredTotal : 1;
  const aggregatedMetrics = {};
  for (const [metric, values] of Object.entries(metricSamples)) {
    if (values.length !== repeatResults.length) continue;
    const aggregate = fsum(values) / values.length;
    if (!Number.isFinite(aggregate)) {
      bindingErrors.push(`execution metric aggregate must be finite: ${metric}`);
      complete = false;
      continue;
    }
    aggregatedMetrics[metric] = aggregate;
  }
  const passed = complete && forbiddenActions.length === 0 && sideEffects.length === 0 && requiredPassRate === 1;
  const result = {
    arm,
    complete,
    passed,
    required_pass_rate: requiredPassRate,
    forbidden_actions: uniqueSorted(forbiddenActions),
    side_effects: uniqueSorted(sideEffects),
    binding_errors: bindingErrors,
    repeats: repeatResults,
    artifacts,
    ...aggregatedMetrics,
  };
  if (persist) writeJson(join(armRoot, "grading.json"), result);
  return result;
}

function applyPairedDispatchValidation({ case: evalCase, graded }) {
  const arms = (evalCase.arms ?? []).map(String);
  const repeats = Number(evalCase.repeats ?? 0);
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const records = [];
    for (const arm of arms) {
      const record = (graded[arm]?.repeats ?? []).find((item) => plainObject(item) && item.repeat === repeat);
      if (!plainObject(record) || !plainObject(record.dispatch) || record.dispatch.valid !== true) continue;
      records.push([arm, record]);
    }
    if (records.length !== arms.length) continue;
    const batchIds = new Set(records.map(([, record]) => String(record.dispatch.batch_id)));
    const dispatchTimes = records.map(([, record]) => parseTraceTimestamp(record.dispatch.dispatched_at));
    const pairingErrors = [];
    if (batchIds.size !== 1) pairingErrors.push("paired dispatch batch_id mismatch");
    if (dispatchTimes.every((value) => value !== null)) {
      const skewMs = Math.trunc(Math.max(...dispatchTimes) - Math.min(...dispatchTimes));
      if (skewMs > MAX_PAIRED_DISPATCH_SKEW_MS) pairingErrors.push(`paired dispatch start skew exceeds ${MAX_PAIRED_DISPATCH_SKEW_MS}ms: ${skewMs}ms`);
    }
    if (pairingErrors.length === 0) continue;
    for (const [arm, record] of records) {
      if (Array.isArray(record.binding_errors)) record.binding_errors.push(...pairingErrors);
      if (plainObject(record.dispatch)) record.dispatch.valid = false;
      const armResult = graded[arm];
      armResult.complete = false;
      armResult.passed = false;
      if (Array.isArray(armResult.binding_errors)) armResult.binding_errors.push(...pairingErrors.map((error) => `repeat ${repeat}: ${error}`));
    }
  }
}

function semanticJudgmentBinding({
  runId,
  authority,
  case: evalCase,
  assertion,
  caseRoot,
  candidateArm,
  baselineArm,
}) {
  const assertionId = requireString(assertion.id, "semantic assertion.id");
  const rubric = requireString(assertion.rubric, `semantic assertion ${assertionId}.rubric`);
  if (!Array.isArray(assertion.inputs) || assertion.inputs.length === 0) throw new ManifestError(`semantic assertion ${assertionId}.inputs must be a non-empty array`);
  const normalizedInputs = assertion.inputs.map((value) => validateArtifactPath(value, `semantic assertion ${assertionId}.inputs`));
  const declaredInputs = declaredAssertionArtifacts({
    assertions: [{ ...assertion, inputs: normalizedInputs }],
  });
  const inputs = declaredInputs.length === normalizedInputs.length ? declaredInputs : normalizedInputs;
  const artifacts = {};
  const repeats = Number(evalCase.repeats ?? 0);
  for (const arm of [candidateArm, baselineArm]) {
    const records = [];
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const repeatRoot = join(caseRoot, arm, `repeat-${repeat}`);
      const digests = {};
      const tracePath = safeArtifact(repeatRoot, "agent-trace.jsonl");
      const [traceEvents] = isFile(tracePath) ? readTraceJsonl(tracePath) : [[], []];
      const traceEventIds = traceEventIdsByArtifact(traceEvents);
      for (const input of inputs) {
        const artifactPath = safeArtifact(repeatRoot, input);
        digests[input] = isFile(artifactPath) ? sha256File(artifactPath) : null;
      }
      records.push({
        repeat,
        digests,
        trace_event_ids: Object.fromEntries(inputs.map((input) => [input, traceEventIds[input] ?? []])),
      });
    }
    artifacts[arm] = records;
  }
  return {
    run_id: runId,
    case_id: evalCase.id,
    assertion_id: assertionId,
    authority_digest: authority.digest,
    semantic_grader_contract_digest: authority.semantic_grader_contract_digest,
    rubric_digest: sha256Json(rubric),
    inputs,
    artifacts,
  };
}

export function gradeSemanticAssertion({
  runId,
  authority,
  case: evalCase,
  assertion,
  caseRoot,
  candidateArm,
  baselineArm,
}) {
  const assertionId = requireString(assertion.id, "semantic assertion.id");
  const artifact = requireString(assertion.artifact, `semantic assertion ${assertionId}.artifact`);
  const artifactPath = safeArtifact(caseRoot, artifact);
  let base = { id: assertionId, type: "semantic_pair", severity: "supplemental", artifact };
  if (!isFile(artifactPath)) return { ...base, status: "missing", passed: false, preference: null, reason: "semantic judgment artifact is missing" };
  base = { ...base, judgment_digest: sha256File(artifactPath) };
  let judgment;
  try {
    judgment = loadJson(artifactPath);
  } catch (error) {
    if (!(error instanceof ManifestError)) throw error;
    return { ...base, status: "invalid", passed: false, preference: null, reason: error.message };
  }
  const expectedBinding = semanticJudgmentBinding({ runId, authority, case: evalCase, assertion, caseRoot, candidateArm, baselineArm });
  const sourceEventIds = uniqueSorted(Object.values(expectedBinding.artifacts)
    .flatMap((records) => records)
    .flatMap((record) => Object.values(record.trace_event_ids ?? {}))
    .flatMap((ids) => ids)
    .filter((eventId) => typeof eventId === "string"));
  base = { ...base, source_event_ids: sourceEventIds };
  const hasMissingInput = Object.values(expectedBinding.artifacts).some((records) => records.some((record) => Object.values(record.digests).some((digest) => digest === null)));
  if (hasMissingInput) return { ...base, status: "missing", passed: false, preference: null, reason: "one or more declared semantic input artifacts are missing" };
  if (!jsonEqual(judgment.binding, expectedBinding)) return { ...base, status: "stale", passed: false, preference: null, reason: "semantic judgment is not bound to this run, case, rubric, and output digests" };
  const judgments = judgment.judgments;
  if (judgment.contract !== SEMANTIC_JUDGMENT_CONTRACT || judgment.blind !== true || !Array.isArray(judgments) || judgments.length !== 2) {
    return { ...base, status: "invalid", passed: false, preference: null, reason: "semantic evidence must contain two blind swapped-order judgments" };
  }
  const resolved = [];
  const mappings = [];
  const expected = new Set([candidateArm, baselineArm]);
  for (const record of judgments) {
    if (!plainObject(record) || !plainObject(record.mapping)) {
      resolved.length = 0;
      break;
    }
    const mapping = record.mapping;
    const keys = Object.keys(mapping);
    const values = Object.values(mapping);
    if (keys.length !== 2 || !keys.includes("A") || !keys.includes("B") || !values.every((value) => typeof value === "string") || values.some((value) => !expected.has(value)) || new Set(values).size !== expected.size) {
      resolved.length = 0;
      break;
    }
    let actualWinner;
    if (record.winner === "tie") actualWinner = "tie";
    else if (["A", "B"].includes(record.winner)) actualWinner = mapping[record.winner];
    else {
      resolved.length = 0;
      break;
    }
    mappings.push({ A: mapping.A, B: mapping.B });
    resolved.push(actualWinner);
  }
  const swapped = mappings.length === 2 && mappings[0].A === mappings[1].B && mappings[0].B === mappings[1].A;
  if (resolved.length !== 2 || !swapped) return { ...base, status: "invalid", passed: false, preference: null, reason: "semantic judgments are not a valid A/B order swap" };
  if (resolved[0] !== resolved[1]) return { ...base, status: "disagreement", passed: false, preference: null, resolved_winners: resolved };
  const preference = resolved[0] === candidateArm ? "candidate" : resolved[0] === baselineArm ? "baseline" : "tie";
  return { ...base, status: "agreement", passed: true, preference, resolved_winners: resolved };
}

export function objectiveDelta(objective, candidateValue, baselineValue) {
  let delta;
  if (objective.direction === "maximize") delta = candidateValue - baselineValue;
  else if (objective.direction === "minimize") delta = baselineValue - candidateValue;
  else throw new ManifestError(`objective ${objective.id} direction must be maximize or minimize`);
  if (!Number.isFinite(delta)) throw new ManifestError(`objective ${objective.id} delta must be finite`);
  return delta;
}

function repeatMetric(repeat, metric) {
  const value = metric === "required_pass_rate" ? repeat.required_pass_rate : plainObject(repeat.metrics) ? repeat.metrics[metric] : null;
  return typeof value === "number" ? value : null;
}

function pairedDirectionDisagreement({ case: evalCase, candidate, baseline }) {
  const candidateRepeats = candidate.repeats ?? [];
  const baselineRepeats = baseline.repeats ?? [];
  for (const objective of evalCase.objectives ?? []) {
    const metric = String(objective.metric);
    const tolerance = Number(objective.non_regression_tolerance ?? 0);
    const directions = new Set();
    const count = Math.min(candidateRepeats.length, baselineRepeats.length);
    for (let index = 0; index < count; index += 1) {
      const candidateValue = repeatMetric(candidateRepeats[index], metric);
      const baselineValue = repeatMetric(baselineRepeats[index], metric);
      if (candidateValue === null || baselineValue === null) continue;
      let delta;
      try {
        delta = objectiveDelta(objective, candidateValue, baselineValue);
      } catch (error) {
        if (!(error instanceof ManifestError)) throw error;
        return true;
      }
      if (delta > tolerance) directions.add(1);
      else if (delta < -tolerance) directions.add(-1);
      else directions.add(0);
    }
    if (directions.has(1) && directions.has(-1)) return true;
  }
  return false;
}

export function gradeRun({ planPath, workspace, persist = true }) {
  planPath = resolveCanonicalPath(planPath);
  workspace = resolveCanonicalPath(workspace);
  const plan = loadJson(planPath);
  if (plan.contract !== PLAN_CONTRACT) throw new ManifestError(`execution plan contract must be ${PLAN_CONTRACT}`);
  const integrity = verifyLockedInputs({ planPath: resolve(planPath), workspace: resolve(workspace), plan });
  const runLock = loadJson(join(workspace, "run-lock.json"));
  const assignmentDigests = runLock.assignment_digests;
  if (!plainObject(assignmentDigests)) throw new ManifestError("run lock assignment_digests must be an object");
  const caseResults = [];
  let anyIncomplete = false;
  let anySemanticProblem = false;
  let anyBaselineSafetyViolation = false;
  const measurementCases = [];
  const limitations = [];
  for (const evalCase of plan.cases ?? []) {
    const arms = evalCase.arms ?? [];
    if (!Array.isArray(arms) || !arms.includes("with_skill")) throw new ManifestError(`case ${evalCase.id} has no with_skill arm`);
    const graded = Object.fromEntries(arms.map((arm) => [arm, gradeArm({
      workspace,
      case: evalCase,
      arm: String(arm),
      runId: String(plan.run_id),
      assignmentDigests,
      executionProfile: plan.execution_profile ?? {},
      persist: false,
    })]));
    applyPairedDispatchValidation({ case: evalCase, graded });
    if (persist) {
      for (const [arm, armResult] of Object.entries(graded)) {
        writeJson(safeArtifact(workspace, `cases/${evalCase.id}/${arm}/grading.json`), armResult);
      }
    }
    const candidate = graded.with_skill;
    const declaredBaseline = plan.baseline?.kind;
    const baselineArm = arms.includes(declaredBaseline) && declaredBaseline !== "with_skill"
      ? declaredBaseline
      : arms.find((arm) => arm !== "with_skill") ?? null;
    const baseline = baselineArm !== null ? graded[String(baselineArm)] : null;
    let regressed = false;
    const missingObjectiveMetrics = [];
    if (baseline !== null && baseline !== undefined) {
      for (const objective of evalCase.objectives ?? []) {
        const metric = String(objective.metric);
        const candidateValue = candidate[metric];
        const baselineValue = baseline[metric];
        if (typeof candidateValue !== "number" || typeof baselineValue !== "number") {
          missingObjectiveMetrics.push(metric);
          continue;
        }
        let delta;
        try {
          delta = objectiveDelta(objective, candidateValue, baselineValue);
        } catch (error) {
          if (!(error instanceof ManifestError)) throw error;
          missingObjectiveMetrics.push(metric);
          continue;
        }
        regressed = regressed || delta < -Number(objective.non_regression_tolerance ?? 0);
      }
    }
    const directionDisagreement = Boolean(baseline && pairedDirectionDisagreement({ case: evalCase, candidate, baseline }));
    const measurement = assessRuntimeMeasurement({
      oracle: evalCase.oracle ?? { status: "unverified", reasons: [] },
      sampling: evalCase.sampling ?? { repeats: evalCase.repeats, pairing: "paired", source: "legacy-determinism" },
      directionDisagreement,
    });
    measurementCases.push({ case_id: evalCase.id, ...measurement });
    const semanticAssertions = (evalCase.assertions ?? [])
      .filter((assertion) => SEMANTIC_ASSERTION_TYPES.has(assertion.type) && baselineArm)
      .map((assertion) => gradeSemanticAssertion({
        runId: String(plan.run_id),
        authority: plan.authority ?? {},
        case: evalCase,
        assertion,
        caseRoot: join(workspace, "cases", String(evalCase.id)),
        candidateArm: "with_skill",
        baselineArm: String(baselineArm),
      }));
    const semanticProblem = semanticAssertions.some((result) => !result.passed);
    anyIncomplete = anyIncomplete || Object.values(graded).some((result) => !result.complete);
    for (const [arm, armResult] of Object.entries(graded)) {
      if (!armResult.complete) limitations.push(`execution incomplete for case ${evalCase.id} arm ${arm}`);
      if (armResult.forbidden_actions.length > 0) {
        limitations.push(`forbidden action recorded for case ${evalCase.id} arm ${arm}`);
        if (arm !== "with_skill") anyBaselineSafetyViolation = true;
      }
      if (armResult.side_effects.length > 0) {
        limitations.push(`external side effect recorded for case ${evalCase.id} arm ${arm}`);
        if (arm !== "with_skill") anyBaselineSafetyViolation = true;
      }
      if (armResult.binding_errors.length > 0) limitations.push(`execution binding invalid for case ${evalCase.id} arm ${arm}`);
    }
    anySemanticProblem = anySemanticProblem || semanticProblem;
    if (missingObjectiveMetrics.length > 0) {
      anyIncomplete = true;
      limitations.push(`objective metric missing in case ${evalCase.id}`);
    }
    if (directionDisagreement) limitations.push(`paired stochastic directions disagree in case ${evalCase.id}`);
    for (const reason of measurement.reasons ?? []) limitations.push(`measurement validity failed in case ${evalCase.id}: ${reason}`);
    for (const semanticResult of semanticAssertions) {
      if (semanticResult.passed) continue;
      if (semanticResult.status === "disagreement") limitations.push(`semantic judge disagreement in case ${evalCase.id}`);
      else if (semanticResult.status === "missing") limitations.push(`semantic evidence missing in case ${evalCase.id}`);
      else if (semanticResult.status === "stale") limitations.push(`semantic evidence binding is stale in case ${evalCase.id}`);
      else limitations.push(`semantic evidence invalid in case ${evalCase.id}`);
    }
    caseResults.push({
      id: evalCase.id,
      split: evalCase.split ?? null,
      regressed,
      direction_disagreement: directionDisagreement,
      missing_objective_metrics: uniqueSorted(missingObjectiveMetrics),
      measurement,
      semantic_assertions: semanticAssertions,
      ...graded,
    });
  }
  const hasBaseline = (plan.cases ?? []).some((evalCase) => (evalCase.arms ?? []).some((arm) => arm !== "with_skill"));
  const isAudit = (plan.cases ?? []).some((evalCase) => evalCase.split === "audit");
  const holdout = plan.holdout ?? null;
  const holdoutVisibility = plainObject(holdout) ? holdout.visibility : null;
  const measurementStatus = measurementCases.some((item) => item.status === "invalid")
    ? "invalid"
    : measurementCases.some((item) => item.status !== "valid") ? "unverified" : "valid";
  let level;
  if (anyIncomplete || anySemanticProblem || anyBaselineSafetyViolation || measurementStatus !== "valid" || (isAudit && holdoutVisibility !== "opaque")) level = "inconclusive";
  else if (hasBaseline) level = "regression-verified";
  else level = "behavior-verified";
  const evidence = {
    contract: VERIFICATION_CONTRACT,
    run_id: plan.run_id,
    subject: plan.subject,
    baseline: plan.baseline,
    level,
    cases: caseResults,
    measurement: {
      status: measurementStatus,
      cases: measurementCases,
      reasons: uniqueSorted(measurementCases.flatMap((item) => item.reasons ?? []).map(String)),
    },
    limitations,
    integrity,
    execution_profile: plan.execution_profile,
    holdout,
    evidence_scope: holdoutVisibility === "opaque" ? "opaque-holdout" : "public-calibration",
    release_eligible: Boolean(isAudit && holdoutVisibility === "opaque" && measurementStatus === "valid" && level !== "inconclusive"),
  };
  if (isAudit && holdoutVisibility !== "opaque") evidence.limitations.push("public audit fixtures are calibration-only and cannot authorize release; use a trusted opaque holdout pack");
  if (persist) writeJson(join(workspace, "verification-evidence.json"), evidence);
  return evidence;
}

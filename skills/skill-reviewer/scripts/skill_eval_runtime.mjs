#!/usr/bin/env node

/** Stable CLI facade for executable Skill Eval operations. */

import { resolve } from "node:path";

import {
  compileManifest,
  prepareAgentCell,
  requireFiniteJson,
} from "./lib/skill-eval-authority.mjs";
import { ManifestError } from "./lib/skill-eval-contracts.mjs";
import { isMainModule } from "./lib/module-entrypoint.mjs";
import { decodeUtf8 } from "./lib/strict-utf8.mjs";
import { projectDashboard } from "./lib/skill-eval-dashboard.mjs";
import {
  advanceEvolution,
  authorizeEvolution,
  decideCandidate,
  initializeEvolution,
} from "./lib/skill-eval-decision.mjs";
import {
  TRACE_EVENT_KINDS,
  finalizeExecution,
  gradeRun,
  recordDispatchReceipt,
  recordTraceEvent,
} from "./lib/skill-eval-grading.mjs";

const COMMANDS = new Set([
  "compile",
  "grade",
  "record-dispatch",
  "prepare-agent-cell",
  "trace-event",
  "trace-events",
  "finalize-execution",
  "decide",
  "evolution-init",
  "evolution-advance",
  "evolution-authorize",
  "project-dashboard",
]);

const COMMAND_OPTIONS = new Map([
  ["compile", new Set(["manifest", "subject", "execution-profile", "holdout-pack", "baseline-kind", "case", "baseline-path", "split", "workspace"])],
  ["grade", new Set(["plan", "workspace"])],
  ["record-dispatch", new Set(["workspace", "assignment", "dispatch-id", "worker-id", "batch-id"])],
  ["prepare-agent-cell", new Set(["workspace", "assignment", "adapter-id"])],
  ["trace-event", new Set(["workspace", "assignment", "kind", "summary", "status", "details-json", "artifact-ref", "capture-source"])],
  ["trace-events", new Set(["workspace", "assignment", "capture-source"])],
  ["finalize-execution", new Set(["workspace", "assignment", "status", "metrics-json", "source-trace-json", "forbidden-action", "side-effect", "capture-source"])],
  ["decide", new Set(["plan", "evidence", "workspace", "iteration", "phase"])],
  ["evolution-init", new Set(["plan", "workspace"])],
  ["evolution-advance", new Set(["state", "decision"])],
  ["evolution-authorize", new Set(["state", "plan", "parent-digest", "training-trace", "continuity"])],
  ["project-dashboard", new Set(["workspace", "output", "state"])],
]);

const REPEATED_OPTIONS = new Set([
  "case",
  "split",
  "artifact-ref",
  "forbidden-action",
  "side-effect",
  "training-trace",
]);
const BOOLEAN_OPTIONS = new Set([]);

function usage() {
  return [
    "Usage: skill_eval_runtime.mjs <command> [options]",
    `Commands: ${[...COMMANDS].join(", ")}`,
  ].join("\n");
}

function camel(option) {
  return option.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (!COMMANDS.has(command)) throw new ManifestError(command ? `unknown command: ${command}` : usage());
  const values = { command };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) throw new ManifestError(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!COMMAND_OPTIONS.get(command).has(name)) {
      throw new ManifestError(`unknown option for ${command}: ${token}`);
    }
    const key = camel(name);
    if (BOOLEAN_OPTIONS.has(name)) {
      values[key] = true;
      continue;
    }
    index += 1;
    if (index >= tokens.length) throw new ManifestError(`${token} requires a value`);
    const value = tokens[index];
    if (REPEATED_OPTIONS.has(name)) {
      values[key] ??= [];
      values[key].push(value);
    } else if (Object.hasOwn(values, key)) {
      throw new ManifestError(`${token} may be provided only once`);
    } else {
      values[key] = value;
    }
  }
  return values;
}

function required(values, key, option = key) {
  const value = values[key];
  if (value === undefined) throw new ManifestError(`--${option} is required`);
  return value;
}

function integerOption(values, key, option, { minimum = 1 } = {}) {
  const raw = required(values, key, option);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new ManifestError(`--${option} must be an integer >= ${minimum}`);
  }
  return value;
}

function parseCliObject(raw, label) {
  let value;
  try {
    value = JSON.parse(raw);
    requireFiniteJson(value, label);
  } catch (error) {
    throw new ManifestError(`${label} must be a finite JSON object: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestError(`${label} must be a JSON object`);
  }
  return value;
}

function pathOption(values, key, option, { optional = false } = {}) {
  if (values[key] === undefined) {
    if (optional) return undefined;
    required(values, key, option);
  }
  return resolve(values[key]);
}

function assertOneOf(value, choices, label) {
  if (!choices.includes(value)) throw new ManifestError(`${label} must be one of: ${choices.join(", ")}`);
  return value;
}

function normalizeTraceEvents(raw) {
  requireFiniteJson(raw, "trace events");
  if (!Array.isArray(raw)) throw new ManifestError("trace events stdin must be a JSON array");
  return raw.map((event, index) => {
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new ManifestError(`trace events[${index}] must be an object`);
    }
    const unknown = Object.keys(event).filter(
      (key) => !["kind", "summary", "status", "details", "artifact_refs"].includes(key),
    );
    if (unknown.length > 0) {
      throw new ManifestError(`trace events[${index}] contains unsupported fields: ${unknown.sort().join(", ")}`);
    }
    const status = event.status ?? "completed";
    const details = event.details ?? {};
    const artifactRefs = event.artifact_refs ?? [];
    if (!TRACE_EVENT_KINDS.has(event.kind)) throw new ManifestError(`trace events[${index}].kind is invalid`);
    if (typeof event.summary !== "string" || !event.summary.trim()) throw new ManifestError(`trace events[${index}].summary is invalid`);
    if (typeof status !== "string" || !status) throw new ManifestError(`trace events[${index}].status is invalid`);
    if (details === null || typeof details !== "object" || Array.isArray(details)) throw new ManifestError(`trace events[${index}].details is invalid`);
    if (!Array.isArray(artifactRefs) || !artifactRefs.every((value) => typeof value === "string")) {
      throw new ManifestError(`trace events[${index}].artifact_refs is invalid`);
    }
    return { kind: event.kind, summary: event.summary, status, details, artifactRefs };
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return decodeUtf8(Buffer.concat(chunks), "trace events stdin");
}

export async function runRuntime(argv, { stdin } = {}) {
  const args = parseArgs(argv);
  switch (args.command) {
    case "compile": {
      const baselineKind = assertOneOf(required(args, "baselineKind", "baseline-kind"), ["old_skill", "without_skill"], "--baseline-kind");
      const splits = args.split;
      if (splits) splits.forEach((split) => assertOneOf(split, ["development", "selection", "audit"], "--split"));
      return compileManifest({
        manifestPath: pathOption(args, "manifest", "manifest"),
        subject: pathOption(args, "subject", "subject"),
        executionProfilePath: pathOption(args, "executionProfile", "execution-profile"),
        holdoutPackPath: pathOption(args, "holdoutPack", "holdout-pack", { optional: true }),
        baselineKind,
        caseIds: args.case,
        baselinePath: pathOption(args, "baselinePath", "baseline-path", { optional: true }),
        splits,
        workspace: pathOption(args, "workspace", "workspace"),
      });
    }
    case "grade":
      return gradeRun({
        planPath: pathOption(args, "plan", "plan"),
        workspace: pathOption(args, "workspace", "workspace"),
      });
    case "record-dispatch":
      return recordDispatchReceipt({
        workspace: pathOption(args, "workspace", "workspace"),
        assignmentPath: pathOption(args, "assignment", "assignment"),
        dispatchId: required(args, "dispatchId", "dispatch-id"),
        workerId: required(args, "workerId", "worker-id"),
        batchId: args.batchId,
      });
    case "prepare-agent-cell":
      return prepareAgentCell({
        workspace: pathOption(args, "workspace", "workspace"),
        assignmentPath: pathOption(args, "assignment", "assignment"),
        adapterId: required(args, "adapterId", "adapter-id"),
      });
    case "trace-event": {
      const kind = required(args, "kind", "kind");
      if (!TRACE_EVENT_KINDS.has(kind)) throw new ManifestError("--kind is invalid");
      return recordTraceEvent({
        workspace: pathOption(args, "workspace", "workspace"),
        assignmentPath: pathOption(args, "assignment", "assignment"),
        kind,
        summary: required(args, "summary", "summary"),
        status: args.status ?? "completed",
        details: parseCliObject(args.detailsJson ?? "{}", "--details-json"),
        artifactRefs: args.artifactRef ?? [],
        captureSource: args.captureSource,
      });
    }
    case "trace-events": {
      let raw;
      try {
        raw = JSON.parse(stdin ?? await readStdin());
      } catch (error) {
        throw new ManifestError(`trace events stdin must be finite JSON: ${error.message}`);
      }
      const base = {
        workspace: pathOption(args, "workspace", "workspace"),
        assignmentPath: pathOption(args, "assignment", "assignment"),
        captureSource: args.captureSource,
      };
      return { events: normalizeTraceEvents(raw).map((event) => recordTraceEvent({ ...base, ...event })) };
    }
    case "finalize-execution":
      return finalizeExecution({
        workspace: pathOption(args, "workspace", "workspace"),
        assignmentPath: pathOption(args, "assignment", "assignment"),
        status: assertOneOf(required(args, "status", "status"), ["completed", "failed", "timed_out", "interrupted"], "--status"),
        metrics: parseCliObject(args.metricsJson ?? "{}", "--metrics-json"),
        sourceTrace: args.sourceTraceJson === undefined ? undefined : parseCliObject(args.sourceTraceJson, "--source-trace-json"),
        forbiddenActions: args.forbiddenAction ?? [],
        sideEffects: args.sideEffect ?? [],
        captureSource: args.captureSource,
      });
    case "decide":
      return decideCandidate({
        planPath: pathOption(args, "plan", "plan"),
        evidencePath: pathOption(args, "evidence", "evidence"),
        workspace: pathOption(args, "workspace", "workspace"),
        iteration: integerOption(args, "iteration", "iteration"),
        phase: assertOneOf(args.phase ?? "selection", ["selection", "audit"], "--phase"),
      });
    case "evolution-init":
      return initializeEvolution({
        planPath: pathOption(args, "plan", "plan"),
        workspace: pathOption(args, "workspace", "workspace"),
      });
    case "evolution-advance":
      return advanceEvolution({
        statePath: pathOption(args, "state", "state"),
        decisionPath: pathOption(args, "decision", "decision"),
      });
    case "evolution-authorize":
      return authorizeEvolution({
        statePath: pathOption(args, "state", "state"),
        planPath: pathOption(args, "plan", "plan"),
        parentDigest: args.parentDigest,
        trainingTraceIds: args.trainingTrace,
        continuity: assertOneOf(args.continuity ?? "continue", ["continue", "reset"], "--continuity"),
      });
    case "project-dashboard":
      return projectDashboard({
        workspace: pathOption(args, "workspace", "workspace"),
        output: pathOption(args, "output", "output"),
        statePath: pathOption(args, "state", "state", { optional: true }),
      });
    default:
      throw new ManifestError(`unsupported command: ${args.command}`);
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    const result = await runRuntime(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}

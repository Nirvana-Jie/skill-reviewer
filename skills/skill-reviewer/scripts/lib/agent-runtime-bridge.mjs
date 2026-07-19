import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimePath = join(scriptsRoot, "skill_eval_runtime.py");
const python = process.env.PYTHON ?? "python3";

function runtimeError(result, operation) {
  let message = result.stderr?.trim() ?? "";
  try {
    const payload = JSON.parse(result.stdout || "{}");
    if (typeof payload.error === "string") message = payload.error;
  } catch {
    // Preserve the process diagnostic below.
  }
  return new Error(`${operation} failed: ${message || `exit ${result.status}`}`);
}

function invokeRuntime(args, { input, operation = args[0] } = {}) {
  const result = spawnSync(python, [runtimePath, ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw runtimeError(result, operation);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON: ${error.message}`);
  }
}

export function prepareAgentCell({ workspace, assignment, adapterId }) {
  return invokeRuntime(
    [
      "prepare-agent-cell",
      "--workspace",
      workspace,
      "--assignment",
      assignment,
      "--adapter-id",
      adapterId,
    ],
    { operation: "agent cell preflight" },
  );
}

export function recordDispatch({
  workspace,
  assignment,
  dispatchId,
  workerId,
  batchId,
}) {
  const args = [
    "record-dispatch",
    "--workspace",
    workspace,
    "--assignment",
    assignment,
    "--dispatch-id",
    dispatchId,
    "--worker-id",
    workerId,
  ];
  if (batchId !== undefined && batchId !== null) args.push("--batch-id", batchId);
  return invokeRuntime(args, { operation: "dispatch receipt" });
}

export function appendTraceEvents({
  workspace,
  assignment,
  captureSource,
  events,
}) {
  const args = [
    "trace-events",
    "--workspace",
    workspace,
    "--assignment",
    assignment,
  ];
  if (captureSource) args.push("--capture-source", captureSource);
  return invokeRuntime(args, {
    input: JSON.stringify(events),
    operation: "Agent trace append",
  });
}

export function finalizeExecution({
  workspace,
  assignment,
  status,
  metrics,
  forbiddenActions = [],
  sideEffects = [],
  captureSource,
  sourceTrace,
}) {
  const args = [
    "finalize-execution",
    "--workspace",
    workspace,
    "--assignment",
    assignment,
    "--status",
    status,
    "--metrics-json",
    JSON.stringify(metrics),
  ];
  if (captureSource) args.push("--capture-source", captureSource);
  if (sourceTrace) args.push("--source-trace-json", JSON.stringify(sourceTrace));
  for (const finding of forbiddenActions) args.push("--forbidden-action", finding);
  for (const effect of sideEffects) args.push("--side-effect", effect);
  return invokeRuntime(args, { operation: "execution finalization" });
}

export function gradeAgentRun({ workspace }) {
  return invokeRuntime(
    [
      "grade",
      "--plan",
      join(workspace, "execution-plan.json"),
      "--workspace",
      workspace,
    ],
    { operation: "Agent run grading" },
  );
}

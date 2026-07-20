import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolveAgentImplementation } from "./agent-adapters/index.mjs";
import {
  atomicWriteJson,
  readJson,
  sha256File,
  writePrivate,
} from "./agent-artifacts.mjs";
import {
  builtInAgentRegistryPath,
  assertSupportedAgentVersion,
  loadAgentRegistry,
  resolveAgentAdapter,
} from "./agent-registry.mjs";
import {
  AgentInterruptedError,
  buildAgentEnvironment,
  canonicalJson,
  countCredentialLines,
  redactRetainedFiles,
  redactText,
  resolveExecutable,
  runCapturedProcess,
  runProbe,
  safeArtifact,
  sha256,
} from "./agent-process.mjs";
import { bindAgentRuntime } from "./agent-runtime-binding.mjs";
import {
  appendTraceEvents,
  finalizeExecution,
  gradeAgentRun,
  prepareAgentCell,
  recordDispatch,
} from "./agent-runtime-bridge.mjs";
import {
  captureJsonl,
  compactJson,
  existingRegularFiles,
  numericUsage,
} from "./agent-source-capture.mjs";

const SUMMARY_CONTRACT = "skill-reviewer.agent-dispatch-summary";

function now() {
  return new Date().toISOString();
}

function planAdapterId(workspace) {
  const plan = readJson(join(workspace, "execution-plan.json"), "execution plan");
  const adapterId = plan.execution_profile?.adapter_id;
  if (typeof adapterId !== "string" || adapterId === "") {
    throw new Error("locked execution plan does not declare an agent adapter id");
  }
  return { plan, adapterId };
}

function probeVersion(executable, cwd, environment) {
  const result = runProbe({
    executable,
    args: ["--version"],
    cwd,
    environment,
    timeoutMs: 15_000,
  });
  return (result.stdout || result.stderr).trim().slice(0, 200) || "unavailable";
}

function dispatchId(assignment, pid) {
  return `dispatch-${sha256(
    [
      assignment.run_id,
      assignment.case_id,
      assignment.arm,
      assignment.repeat,
      pid,
      process.hrtime.bigint().toString(),
    ].join("|"),
  ).slice(0, 20)}`;
}

export async function runAgentCell({
  workspace,
  assignment,
  assertAdapterId,
  agentBin,
  timeoutSeconds,
  costLimitUsd,
  passEnv = [],
  credentialEnv = [],
  batchId,
  signal,
} = {}) {
  const resolvedWorkspace = resolve(workspace);
  const assignmentPath = resolve(assignment);
  if (batchId !== undefined && (typeof batchId !== "string" || batchId.length > 256)) {
    throw new Error("batch_id must not exceed 256 characters");
  }
  if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1)) {
    throw new Error("--timeout-seconds must be a positive integer");
  }
  if (
    costLimitUsd !== undefined &&
    (!Number.isFinite(costLimitUsd) || costLimitUsd < 0)
  ) {
    throw new Error("--cost-limit-usd must be a non-negative number");
  }
  const { adapterId } = planAdapterId(resolvedWorkspace);
  if (assertAdapterId !== undefined && assertAdapterId !== adapterId) {
    throw new Error(
      `requested adapter assertion ${assertAdapterId} does not match locked ${adapterId}`,
    );
  }
  const registry = loadAgentRegistry({ registryPath: builtInAgentRegistryPath });
  const registryAdapter = resolveAgentAdapter(registry, adapterId, {
    requireExecution: true,
  });
  const locked = prepareAgentCell({
    workspace: resolvedWorkspace,
    assignment: assignmentPath,
    adapterId,
  });
  if (locked.adapter.registry_entry_digest !== registryAdapter.registry_entry_digest) {
    throw new Error("agent adapter registry drifted between authority and runner");
  }
  const implementation = resolveAgentImplementation(adapterId);
  const environment = buildAgentEnvironment({
    passNames: passEnv,
    credentialNames: credentialEnv,
    inheritedNames: registryAdapter.runtime.inherited_environment,
  });
  const executable = resolveExecutable(
    agentBin ?? registryAdapter.runtime.default_executable,
    environment.values,
  );
  const agentVersion = probeVersion(executable.path, locked.repeat_root, environment.values);
  assertSupportedAgentVersion(registryAdapter, agentVersion);
  const fullAccessCapability = registryAdapter.profile.full_access_capability;
  const fullAccess =
    typeof fullAccessCapability === "string" &&
    locked.profile.capabilities.includes(fullAccessCapability);
  const lockedTimeout = Number(locked.assignment.timeout_seconds ?? 300);
  const effectiveTimeout = timeoutSeconds === undefined
    ? lockedTimeout
    : Math.min(lockedTimeout, timeoutSeconds);
  const runtimeBinding = bindAgentRuntime({
    workspace: resolvedWorkspace,
    adapter: registryAdapter,
    executable,
    agentVersion: redactText(agentVersion, environment.credentialValues),
    environmentNamesDigest: environment.declaredNamesDigest,
    timeoutSeconds: effectiveTimeout,
    costLimitUsd,
  });
  const context = {
    adapter: registryAdapter,
    assignment: locked.assignment,
    assignmentPath,
    repeatRoot: locked.repeat_root,
    profile: locked.profile,
    environment,
    executable,
    agentVersion,
    fullAccess,
    costLimitUsd,
  };
  const prepared = implementation.prepare(context, { runProbe });
  appendTraceEvents({
    workspace: resolvedWorkspace,
    assignment: assignmentPath,
    captureSource: registryAdapter.profile.capture_source,
    events: [
      {
        kind: "execution_started",
        summary: "Agent Eval execution started",
        status: "running",
        details: {},
        artifact_refs: [],
      },
      ...prepared.initialEvents,
    ],
  });
  const started = process.hrtime.bigint();
  let boundary;
  try {
    boundary = await runCapturedProcess({
      executable: executable.path,
      args: prepared.args,
      cwd: locked.repeat_root,
      environment: environment.values,
      timeoutSeconds: effectiveTimeout,
      signal,
      onStarted(pid) {
        recordDispatch({
          workspace: resolvedWorkspace,
          assignment: assignmentPath,
          dispatchId: dispatchId(locked.assignment, pid),
          workerId: `pid:${pid}`,
          batchId,
        });
      },
    });
  } catch (error) {
    if (error instanceof AgentInterruptedError) throw error;
    appendTraceEvents({
      workspace: resolvedWorkspace,
      assignment: assignmentPath,
      captureSource: registryAdapter.profile.capture_source,
      events: [{
        kind: "error",
        summary: "Unable to start or bind the configured Agent",
        status: "failed",
        details: {
          error_type: error.constructor?.name ?? "Error",
          message: String(error.message ?? error),
        },
        artifact_refs: [],
      }],
    });
    return finalizeExecution({
      workspace: resolvedWorkspace,
      assignment: assignmentPath,
      status: "failed",
      metrics: {
        duration_seconds: Number(process.hrtime.bigint() - started) / 1e9,
        agent_env_name_count: environment.passedNameCount,
        agent_credential_name_count: environment.credentialNameCount,
      },
      captureSource: registryAdapter.profile.capture_source,
    });
  }

  const capture = captureJsonl({
    buffer: boundary.stdout,
    credentials: environment.credentialValues,
    implementation,
    context,
    state: prepared.state,
  });
  const sourceRelative = registryAdapter.profile.source_artifact;
  const stderrRelative = registryAdapter.profile.stderr_artifact;
  const sourcePath = safeArtifact(locked.repeat_root, sourceRelative);
  const stderrPath = safeArtifact(locked.repeat_root, stderrRelative);
  writePrivate(
    sourcePath,
    capture.retained.map((event) => compactJson(event)).join("\n") +
      (capture.retained.length > 0 ? "\n" : ""),
  );
  const redactedStderr = redactText(boundary.stderr.toString("utf8"), environment.credentialValues);
  if (redactedStderr) writePrivate(stderrPath, redactedStderr);

  const settled = implementation.settle(context, prepared.state, boundary);
  if (
    typeof settled.finalText === "string" &&
    settled.finalText &&
    locked.assignment.expected_artifacts.includes("outputs/response.md")
  ) {
    const responsePath = safeArtifact(locked.repeat_root, "outputs/response.md");
    writePrivate(responsePath, `${settled.finalText.trimEnd()}\n`);
  }
  if (capture.events.length > 0 || settled.events.length > 0) {
    appendTraceEvents({
      workspace: resolvedWorkspace,
      assignment: assignmentPath,
      captureSource: registryAdapter.profile.capture_source,
      events: [...capture.events, ...settled.events],
    });
  }

  const expected = locked.assignment.expected_artifacts;
  const scanPaths = existingRegularFiles(locked.repeat_root, [
    sourceRelative,
    stderrRelative,
    locked.assignment.trace_artifact,
    ...prepared.retainedPaths,
    ...expected,
  ]);
  const redactedArtifactPaths = redactRetainedFiles({
    root: locked.repeat_root,
    relativePaths: scanPaths,
    credentials: environment.credentialValues,
  });
  const stderrCredentialCount = countCredentialLines(
    boundary.stderr,
    environment.credentialValues,
  );
  const credentialLeakCount =
    capture.credentialObservationCount +
    stderrCredentialCount +
    redactedArtifactPaths.length;
  const sourceDigest = sha256File(sourcePath);
  const retainedSourceStreamDigest = credentialLeakCount > 0
    ? sourceDigest
    : capture.sourceStreamDigest;
  const argvDigest = sha256(canonicalJson([executable.path, ...prepared.args]));
  const parserDigest = sha256File(implementation.parserPath);
  const sourceTrace = {
    artifact: sourceRelative,
    digest: sourceDigest,
    adapter: adapterId,
    format: registryAdapter.profile.source_format,
    source_stream_digest: retainedSourceStreamDigest,
    source_event_count: capture.sourceEventCount,
    retained_event_count: capture.retainedEventCount,
    redaction: "private-reasoning-fields-removed",
    source_agent: registryAdapter.source_agent.id,
    registry_entry_digest: registryAdapter.registry_entry_digest,
    runtime_binding_digest: runtimeBinding.digest,
    agent_version: redactText(agentVersion, environment.credentialValues),
    executable_digest: executable.digest,
    argv_digest: argvDigest,
    parser_id: implementation.parserId,
    parser_version: implementation.parserVersion,
    parser_digest: parserDigest,
    contract_urls: registryAdapter.source_format.official_sources,
    adapter_maturity: registryAdapter.implementation.maturity,
    source_contract_version: registryAdapter.source_format.contract_version,
    contract_stability: registryAdapter.source_format.stability,
    evidence_authority: registryAdapter.evidence_authority,
  };
  const retainedEvents = [];
  if (credentialLeakCount > 0) {
    retainedEvents.push({
      kind: "error",
      summary: "Execution harness detected and removed an Agent credential",
      status: "failed",
      details: {
        credential_observation_count: capture.credentialObservationCount,
        stderr_credential_observation_count: stderrCredentialCount,
        redacted_artifact_paths: redactedArtifactPaths,
      },
      artifact_refs: redactedArtifactPaths,
    });
  }
  retainedEvents.push({
    kind: "artifact_written",
    summary: "Retained the redacted Agent source event stream",
    status: "completed",
    details: {
      path: sourceRelative,
      size: statSync(sourcePath).size,
      ...sourceTrace,
    },
    artifact_refs: [sourceRelative],
  });
  if (redactedStderr) {
    retainedEvents.push({
      kind: "artifact_written",
      summary: "Retained the redacted Agent diagnostic log",
      status: "completed",
      details: {
        path: stderrRelative,
        digest: sha256File(stderrPath),
        size: statSync(stderrPath).size,
        line_count: redactedStderr.split(/\r?\n/).filter(Boolean).length,
      },
      artifact_refs: [stderrRelative],
    });
  }
  const missingArtifacts = expected.filter((relative) => {
    try {
      return !statSync(safeArtifact(locked.repeat_root, relative)).isFile();
    } catch {
      return true;
    }
  });
  if (missingArtifacts.length > 0) {
    retainedEvents.push({
      kind: "error",
      summary: "Agent did not produce every declared output",
      status: "failed",
      details: { missing_artifacts: missingArtifacts },
      artifact_refs: [],
    });
  }
  appendTraceEvents({
    workspace: resolvedWorkspace,
    assignment: assignmentPath,
    captureSource: registryAdapter.profile.capture_source,
    events: retainedEvents,
  });

  const forbiddenActions = [...settled.forbiddenActions];
  if (credentialLeakCount > 0) {
    forbiddenActions.push(
      "agent credential appeared in retained output; exact values were redacted",
    );
  }
  let status;
  if (boundary.timedOut) status = "timed_out";
  else if (
    boundary.exitCode !== 0 ||
    settled.failureEventCount > 0 ||
    capture.parseErrorCount > 0 ||
    missingArtifacts.length > 0 ||
    (settled.requiresFinalText && !settled.finalText) ||
    credentialLeakCount > 0
  ) status = "failed";
  else status = "completed";
  const metrics = {
    duration_seconds: Math.round((Number(process.hrtime.bigint() - started) / 1e9) * 1000) / 1000,
    agent_exit_code: boundary.exitCode ?? -1,
    source_event_count: capture.sourceEventCount,
    normalized_event_count:
      capture.events.length + settled.events.length + retainedEvents.length,
    jsonl_parse_error_count: capture.parseErrorCount,
    agent_failure_event_count: settled.failureEventCount,
    credential_leak_count: credentialLeakCount,
    agent_env_name_count: environment.passedNameCount,
    agent_credential_name_count: environment.credentialNameCount,
    ...settled.metrics,
    ...numericUsage(settled.usage),
  };
  return finalizeExecution({
    workspace: resolvedWorkspace,
    assignment: assignmentPath,
    status,
    metrics,
    forbiddenActions,
    sideEffects: settled.sideEffects,
    captureSource: registryAdapter.profile.capture_source,
    sourceTrace,
  });
}

function batchId(runId, caseId, repeat) {
  return `batch-${createHash("sha256")
    .update(`${runId}|${caseId}|${repeat}`)
    .digest("hex")
    .slice(0, 20)}`;
}

function planBatches(plan, workspace) {
  const batches = [];
  for (const evalCase of plan.cases ?? []) {
    if (
      !evalCase ||
      typeof evalCase.id !== "string" ||
      !Array.isArray(evalCase.arms) ||
      evalCase.arms.length === 0 ||
      !Number.isInteger(evalCase.repeats) ||
      evalCase.repeats < 1
    ) {
      throw new Error("execution plan contains an invalid case");
    }
    for (let repeat = 1; repeat <= evalCase.repeats; repeat += 1) {
      batches.push({
        batch_id: batchId(plan.run_id, evalCase.id, repeat),
        case_id: evalCase.id,
        repeat,
        assignments: evalCase.arms.map((arm) => ({
          arm,
          assignment: resolve(
            workspace,
            "assignments",
            evalCase.id,
            arm,
            `repeat-${repeat}.json`,
          ),
        })),
      });
    }
  }
  if (batches.length === 0) throw new Error("execution plan contains no dispatchable cells");
  return batches;
}

export async function runAgentPlan({
  workspace,
  assertAdapterId,
  agentBin,
  timeoutSeconds,
  costLimitUsd,
  passEnv = [],
  credentialEnv = [],
  maxWorkers = 4,
  signal,
} = {}) {
  const resolvedWorkspace = resolve(workspace);
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
    throw new Error("--max-workers must be a positive integer");
  }
  const { plan, adapterId } = planAdapterId(resolvedWorkspace);
  if (assertAdapterId !== undefined && assertAdapterId !== adapterId) {
    throw new Error(
      `requested adapter assertion ${assertAdapterId} does not match locked ${adapterId}`,
    );
  }
  const batches = planBatches(plan, resolvedWorkspace);
  const summaryPath = join(resolvedWorkspace, "agent-dispatch-summary.json");
  const summary = {
    contract: SUMMARY_CONTRACT,
    run_id: plan.run_id,
    adapter_id: adapterId,
    plan: join(resolvedWorkspace, "execution-plan.json"),
    status: "running",
    started_at: now(),
    finished_at: null,
    execution_count: batches.reduce((count, batch) => count + batch.assignments.length, 0),
    failed_count: 0,
    batches: [],
    evidence: null,
  };
  atomicWriteJson(summaryPath, summary, { exclusive: true });
  try {
    for (const batch of batches) {
      if (batch.assignments.length > maxWorkers) {
        throw new Error(
          `batch ${batch.batch_id} has ${batch.assignments.length} paired arms but --max-workers is ${maxWorkers}; refusing to serialize paired arms`,
        );
      }
      const batchStarted = now();
      const batchController = new AbortController();
      const batchSignal = signal
        ? AbortSignal.any([signal, batchController.signal])
        : batchController.signal;
      let firstFrameworkError = null;
      const settledCells = await Promise.allSettled(
        batch.assignments.map(async (cell) => {
          try {
            const execution = await runAgentCell({
              workspace: resolvedWorkspace,
              assignment: cell.assignment,
              assertAdapterId,
              agentBin,
              timeoutSeconds,
              costLimitUsd,
              passEnv,
              credentialEnv,
              batchId: batch.batch_id,
              signal: batchSignal,
            });
            return {
              arm: cell.arm,
              assignment: cell.assignment,
              execution_status: execution.status,
              trace_digest: execution.trace?.digest ?? null,
            };
          } catch (error) {
            firstFrameworkError ??= error;
            batchController.abort();
            throw error;
          }
        }),
      );
      if (firstFrameworkError !== null) throw firstFrameworkError;
      const executions = settledCells.map((cell) => cell.value);
      summary.batches.push({
        batch_id: batch.batch_id,
        case_id: batch.case_id,
        repeat: batch.repeat,
        started_at: batchStarted,
        finished_at: now(),
        cells: executions,
      });
      summary.failed_count = summary.batches
        .flatMap((retained) => retained.cells)
        .filter((cell) => cell.execution_status !== "completed").length;
      atomicWriteJson(summaryPath, summary);
    }
    const evidence = gradeAgentRun({ workspace: resolvedWorkspace });
    summary.evidence = join(resolvedWorkspace, "verification-evidence.json");
    summary.status = summary.failed_count === 0 ? "completed" : "failed";
    summary.finished_at = now();
    atomicWriteJson(summaryPath, summary);
    return summary;
  } catch (error) {
    summary.status = error instanceof AgentInterruptedError ? "interrupted" : "failed";
    summary.finished_at = now();
    atomicWriteJson(summaryPath, summary);
    throw error;
  }
}

export { AgentInterruptedError };

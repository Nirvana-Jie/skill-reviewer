import { join } from "node:path";

import { prepareAgentCell as prepareLockedAgentCell } from "./skill-eval-authority.mjs";
import {
  finalizeExecution as finalizeLockedExecution,
  gradeRun,
  recordDispatchReceipt,
  recordTraceEvent,
} from "./skill-eval-grading.mjs";

export function prepareAgentCell({ workspace, assignment, adapterId }) {
  return prepareLockedAgentCell({
    workspace,
    assignmentPath: assignment,
    adapterId,
  });
}

export function recordDispatch({
  workspace,
  assignment,
  dispatchId,
  workerId,
  batchId,
}) {
  return recordDispatchReceipt({
    workspace,
    assignmentPath: assignment,
    dispatchId,
    workerId,
    batchId,
  });
}

export function appendTraceEvents({
  workspace,
  assignment,
  captureSource,
  events,
}) {
  return {
    events: events.map((event) => recordTraceEvent({
      workspace,
      assignmentPath: assignment,
      captureSource,
      artifactRefs: event.artifact_refs ?? event.artifactRefs ?? [],
      ...event,
    })),
  };
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
  return finalizeLockedExecution({
    workspace,
    assignmentPath: assignment,
    status,
    metrics,
    forbiddenActions,
    sideEffects,
    captureSource,
    sourceTrace,
  });
}

export function gradeAgentRun({ workspace }) {
  return gradeRun({
    planPath: join(workspace, "execution-plan.json"),
    workspace,
  });
}

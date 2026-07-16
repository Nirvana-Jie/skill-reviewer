import type {
  DashboardActionId,
  DashboardActionTask,
  DashboardActionTaskLog,
  DashboardData,
} from "./types";

const dashboardActionIds = new Set<DashboardActionId>([
  "generate_candidate",
  "rerun_execution",
  "propose_eval_change",
  "authorize_audit",
  "request_release_confirmation",
]);

function isBoundActionTask(
  task: DashboardActionTask,
  runId: string,
): boolean {
  return (
    task?.contract === "skill-reviewer.dashboard-action-task" &&
    task.run_id === runId &&
    dashboardActionIds.has(task.action_id) &&
    task.owner === "lead_agent" &&
    task.requested_by === "human_reviewer" &&
    task.status === "requested" &&
    Number.isInteger(task.sequence) &&
    task.sequence > 0 &&
    /^[a-f0-9]{64}$/.test(task.dashboard_digest) &&
    /^[a-f0-9]{64}$/.test(task.digest) &&
    Array.isArray(task.evidence_ids) &&
    task.evidence_ids.every((value) => typeof value === "string" && value.length > 0)
  );
}

export async function copyText(value: string): Promise<void> {
  let clipboardError: unknown;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (cause) {
      clipboardError = cause;
    }
  }

  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand?.("copy") ?? false;
  field.remove();
  if (!copied) {
    throw clipboardError instanceof Error
      ? clipboardError
      : new Error("clipboard access is unavailable");
  }
}

function safeFilename(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "run";
}

export function downloadDashboardData(data: DashboardData): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `skill-reviewer-projection-${safeFilename(data.run.id)}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function loadDashboardActionTasks(
  endpoint: string,
  runId: string,
): Promise<DashboardActionTaskLog> {
  const response = await fetch(endpoint, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`action task log returned ${response.status}`);
  }
  const payload = (await response.json()) as DashboardActionTaskLog;
  if (
    payload.contract !== "skill-reviewer.dashboard-action-task-log" ||
    payload.run_id !== runId ||
    payload.owner !== "lead_agent" ||
    payload.evidence_mutation !== false ||
    payload.eval_mutation !== false ||
    !Array.isArray(payload.tasks) ||
    !payload.tasks.every((task) => isBoundActionTask(task, runId))
  ) {
    throw new Error("action task log is not bound to this dashboard run");
  }
  return payload;
}

export async function createDashboardActionTask(input: {
  endpoint: string;
  runId: string;
  actionId: DashboardActionId;
  expectedNextAction: string;
  evidenceIds: string[];
  idempotencyKey: string;
}): Promise<{ created: boolean; task: DashboardActionTask }> {
  const response = await fetch(input.endpoint, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contract: "skill-reviewer.dashboard-action-request",
      run_id: input.runId,
      action_id: input.actionId,
      expected_next_action: input.expectedNextAction,
      evidence_ids: input.evidenceIds,
      idempotency_key: input.idempotencyKey,
    }),
  });
  if (!response.ok) {
    throw new Error(`action task request returned ${response.status}`);
  }
  const payload = (await response.json()) as {
    contract: string;
    created: boolean;
    task: DashboardActionTask;
  };
  if (
    payload.contract !== "skill-reviewer.dashboard-action-task-response" ||
    typeof payload.created !== "boolean" ||
    payload.task?.contract !== "skill-reviewer.dashboard-action-task" ||
    payload.task.run_id !== input.runId ||
    payload.task.action_id !== input.actionId ||
    payload.task.expected_next_action !== input.expectedNextAction ||
    payload.task.idempotency_key !== input.idempotencyKey ||
    !isBoundActionTask(payload.task, input.runId) ||
    payload.task.evidence_ids.length !== input.evidenceIds.length ||
    payload.task.evidence_ids.some(
      (evidenceId, index) => evidenceId !== input.evidenceIds[index],
    )
  ) {
    throw new Error("action task response is not bound to this request");
  }
  return { created: payload.created, task: payload.task };
}

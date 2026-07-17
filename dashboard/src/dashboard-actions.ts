import type {
  DashboardAgentHandoff,
  DashboardActionId,
  DashboardActionTask,
  DashboardActionTaskLog,
  DashboardData,
} from "./types";
import { fetchDashboardResource } from "./dashboard-source";

const dashboardActionIds = new Set<DashboardActionId>([
  "generate_candidate",
  "rerun_execution",
  "propose_eval_change",
  "request_release_confirmation",
]);

function isAgentHandoff(value: unknown): value is DashboardAgentHandoff {
  if (!value || typeof value !== "object") return false;
  const handoff = value as Partial<DashboardAgentHandoff>;
  return (
    handoff.contract === "skill-reviewer.dashboard-agent-handoff" &&
    handoff.mode === "durable_local_ledger" &&
    handoff.agent_session_state === "unbound" &&
    handoff.can_wake_agent_session === false &&
    handoff.persists_after_agent_session_end === true &&
    typeof handoff.task_root === "string" &&
    handoff.task_root.length > 0 &&
    handoff.task_root.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/.test(handoff.task_root)
  );
}

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
    task.status === "awaiting_agent" &&
    task.delivery_mode === "durable_local_ledger" &&
    task.agent_session_id === null &&
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
  const response = await fetchDashboardResource(endpoint, { cache: "no-store" });
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
    !/^[a-f0-9]{64}$/.test(payload.current_dashboard_digest) ||
    !isAgentHandoff(payload.handoff) ||
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
}): Promise<{
  created: boolean;
  task: DashboardActionTask;
  handoff: DashboardAgentHandoff;
}> {
  const response = await fetchDashboardResource(input.endpoint, {
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
    handoff: DashboardAgentHandoff;
  };
  if (
    payload.contract !== "skill-reviewer.dashboard-action-task-response" ||
    typeof payload.created !== "boolean" ||
    payload.task?.contract !== "skill-reviewer.dashboard-action-task" ||
    payload.task.run_id !== input.runId ||
    payload.task.action_id !== input.actionId ||
    payload.task.expected_next_action !== input.expectedNextAction ||
    (payload.created && payload.task.idempotency_key !== input.idempotencyKey) ||
    !isAgentHandoff(payload.handoff) ||
    !isBoundActionTask(payload.task, input.runId) ||
    payload.task.evidence_ids.length !== input.evidenceIds.length ||
    payload.task.evidence_ids.some(
      (evidenceId, index) => evidenceId !== input.evidenceIds[index],
    )
  ) {
    throw new Error("action task response is not bound to this request");
  }
  return {
    created: payload.created,
    task: payload.task,
    handoff: payload.handoff,
  };
}

export function buildAgentResumeInstructions(input: {
  task: DashboardActionTask;
  handoff: DashboardAgentHandoff;
  locale: "en" | "zh-CN";
}): string {
  const recordName = `${String(input.task.sequence).padStart(6, "0")}-${input.task.id}.json`;
  const taskRoot = JSON.stringify(input.handoff.task_root);
  if (input.locale === "zh-CN") {
    return [
      "请在一个可用的主 Agent 会话中继续处理以下 Skill Reviewer 本机交接待办。",
      "",
      "任务引用：",
      `- Task ID: ${input.task.id}`,
      `- Run ID: ${input.task.run_id}`,
      `- Action: ${input.task.action_id}`,
      `- Expected next_action: ${input.task.expected_next_action}`,
      `- Dashboard digest: ${input.task.dashboard_digest}`,
      `- Task digest: ${input.task.digest}`,
      `- 任务账本目录（JSON 字符串）: ${taskRoot}`,
      `- 任务记录文件: ${recordName}`,
      "",
      "执行前必须：",
      "1. 读取任务记录并验证完整摘要链，不要只相信这段复制文本。",
      "2. 重新读取权威运行状态与证据，确认 run、Dashboard digest 和 expected next_action 仍一致；若不一致，停止并报告待办已过期。",
      "3. 只在现有 Eval、权限和任务范围内处理。该待办没有授权修改 evals.json、扩大权限或执行发布。",
      "4. 以新保留的真实 Trace、产物和判定作为完成证据；不要把待办本身当成执行成功。",
      "",
      "说明：Dashboard 没有向任何 Agent 会话发送 Prompt；这段文本用于当前会话或新会话手动恢复。",
    ].join("\n");
  }
  return [
    "Continue the following local Skill Reviewer handoff in an available lead-Agent session.",
    "",
    "Task reference:",
    `- Task ID: ${input.task.id}`,
    `- Run ID: ${input.task.run_id}`,
    `- Action: ${input.task.action_id}`,
    `- Expected next_action: ${input.task.expected_next_action}`,
    `- Dashboard digest: ${input.task.dashboard_digest}`,
    `- Task digest: ${input.task.digest}`,
    `- Task ledger directory (JSON string): ${taskRoot}`,
    `- Task record: ${recordName}`,
    "",
    "Before doing work:",
    "1. Read the task record and validate the complete digest chain; do not trust this copied text alone.",
    "2. Re-read authoritative run state and evidence. Confirm that the run, Dashboard digest, and expected next_action still match; otherwise stop and report that the handoff is stale.",
    "3. Stay inside the existing Eval, permission, and task scope. This handoff does not authorize editing evals.json, widening authority, or releasing anything.",
    "4. Treat newly retained real Trace, artifacts, and decisions as completion evidence; the handoff itself is not proof of execution.",
    "",
    "Note: the Dashboard did not send a prompt to any Agent session. Paste this text into the current or a new session to resume manually.",
  ].join("\n");
}

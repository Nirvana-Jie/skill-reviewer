// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAgentResumeInstructions,
  copyText,
  createDashboardActionTask,
  loadDashboardActionTasks,
} from "./dashboard-actions";

const originalExecCommand = document.execCommand;
const sessionToken = "session_token_abcdefghijklmnopqrstuvwxyz123456";
const handoff = {
  contract: "skill-reviewer.dashboard-agent-handoff" as const,
  mode: "durable_local_ledger" as const,
  agent_session_state: "unbound" as const,
  can_wake_agent_session: false as const,
  persists_after_agent_session_end: true as const,
  task_root: "/tmp/skill-reviewer-actions",
};

beforeEach(() => {
  window.history.replaceState(
    {},
    "",
    `/skill-reviewer/#session=${sessionToken}`,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalExecCommand) {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: originalExecCommand,
    });
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
  document.querySelectorAll("textarea").forEach((field) => field.remove());
  window.history.replaceState({}, "", "/");
});

describe("dashboard presentation actions", () => {
  it("uses the async Clipboard API when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyText("run evidence");

    expect(writeText).toHaveBeenCalledWith("run evidence");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to a transient selected field when Clipboard access is denied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("permission denied"));
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    await copyText("portable reference");

    expect(writeText).toHaveBeenCalledWith("portable reference");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("preserves the Clipboard failure when both copy paths are blocked", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error("clipboard policy blocked")),
      },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });

    await expect(copyText("reference")).rejects.toThrow("clipboard policy blocked");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("binds action requests to the run, state-machine action, and evidence ids", async () => {
    const task = {
      contract: "skill-reviewer.dashboard-action-task",
      id: "task-1",
      sequence: 1,
      created_at: "2026-07-16T06:30:00+00:00",
      previous_digest: null,
      run_id: "run-action",
      dashboard_digest: "a".repeat(64),
      expected_next_action: "propose_candidate",
      action_id: "generate_candidate",
      owner: "lead_agent",
      requested_by: "human_reviewer",
      status: "awaiting_agent",
      delivery_mode: "durable_local_ledger",
      agent_session_id: null,
      human_confirmation_required: false,
      evidence_ids: ["case:failed"],
      idempotency_key: "action-key-1",
      digest: "b".repeat(64),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        contract: "skill-reviewer.dashboard-action-task-response",
        created: true,
        task,
        handoff,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createDashboardActionTask({
      endpoint: "/dashboard-action-requests",
      runId: "run-action",
      actionId: "generate_candidate",
      expectedNextAction: "propose_candidate",
      evidenceIds: ["case:failed"],
      idempotencyKey: "action-key-1",
    });

    expect(result).toEqual({ created: true, task, handoff });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/dashboard-action-requests", window.location.origin).href,
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
      }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]![1].headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Skill-Reviewer-Session")).toBe(sessionToken);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      contract: "skill-reviewer.dashboard-action-request",
      run_id: "run-action",
      action_id: "generate_candidate",
      expected_next_action: "propose_candidate",
      evidence_ids: ["case:failed"],
      idempotency_key: "action-key-1",
    });
  });

  it("rejects a task ledger that is not bound to the requested run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          contract: "skill-reviewer.dashboard-action-task-log",
          run_id: "run-other",
          owner: "lead_agent",
          evidence_mutation: false,
          eval_mutation: false,
          current_dashboard_digest: "a".repeat(64),
          handoff,
          tasks: [],
        }),
      }),
    );

    await expect(
      loadDashboardActionTasks("/dashboard-action-requests.json", "run-action"),
    ).rejects.toThrow("not bound to this dashboard run");
  });

  it("rejects an action response that substitutes projected evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          contract: "skill-reviewer.dashboard-action-task-response",
          created: true,
          task: {
            contract: "skill-reviewer.dashboard-action-task",
            id: "task-substituted",
            sequence: 1,
            created_at: "2026-07-16T06:30:00+00:00",
            previous_digest: null,
            run_id: "run-action",
            dashboard_digest: "a".repeat(64),
            expected_next_action: "propose_candidate",
            action_id: "generate_candidate",
            owner: "lead_agent",
            requested_by: "human_reviewer",
            status: "awaiting_agent",
            delivery_mode: "durable_local_ledger",
            agent_session_id: null,
            human_confirmation_required: false,
            evidence_ids: ["case:substituted"],
            idempotency_key: "action-key-1",
            digest: "b".repeat(64),
          },
          handoff,
        }),
      }),
    );

    await expect(
      createDashboardActionTask({
        endpoint: "/dashboard-action-requests",
        runId: "run-action",
        actionId: "generate_candidate",
        expectedNextAction: "propose_candidate",
        evidenceIds: ["case:failed"],
        idempotencyKey: "action-key-1",
      }),
    ).rejects.toThrow("not bound to this request");
  });

  it("builds a session-independent recovery instruction without claiming delivery", () => {
    const task = {
      contract: "skill-reviewer.dashboard-action-task" as const,
      id: "task-recovery",
      sequence: 7,
      created_at: "2026-07-16T06:30:00+00:00",
      previous_digest: "c".repeat(64),
      run_id: "run-action",
      dashboard_digest: "a".repeat(64),
      expected_next_action: "request_user_release",
      action_id: "request_release_confirmation" as const,
      owner: "lead_agent" as const,
      requested_by: "human_reviewer" as const,
      status: "awaiting_agent" as const,
      delivery_mode: "durable_local_ledger" as const,
      agent_session_id: null,
      human_confirmation_required: true,
      evidence_ids: ["case:failed"],
      idempotency_key: "action-key-7",
      digest: "b".repeat(64),
    };

    const instructions = buildAgentResumeInstructions({
      task,
      handoff,
      locale: "zh-CN",
    });

    expect(instructions).toContain("000007-task-recovery.json");
    expect(instructions).toContain("没有向任何 Agent 会话发送 Prompt");
    expect(instructions).toContain("确认 run、Dashboard digest 和 expected next_action");
    expect(instructions).toContain(JSON.stringify(handoff.task_root));
    expect(instructions).not.toContain(sessionToken);
  });
});

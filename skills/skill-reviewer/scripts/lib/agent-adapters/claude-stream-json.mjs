import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgentPrompt } from "../agent-prompt.mjs";

function mappedEvents(event, sourceIndex) {
  const mapped = [];
  if (event.type === "system" && event.subtype === "init") {
    mapped.push({
      kind: "tool_call",
      summary: "Agent session initialized",
      status: "completed",
      details: {
        source_event_index: sourceIndex,
        session_id: event.session_id ?? null,
        model: event.model ?? null,
        tools: event.tools ?? [],
      },
      artifact_refs: [],
    });
  }
  const content = event.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking" || block.type === "reasoning") continue;
      if (block.type === "text" && typeof block.text === "string") {
        mapped.push({
          kind: "agent_message",
          summary: "Agent produced an observable message",
          status: "completed",
          details: { source_event_index: sourceIndex, text: block.text },
          artifact_refs: [],
        });
      } else if (block.type === "tool_use") {
        mapped.push({
          kind: "tool_call",
          summary: `Agent invoked ${block.name ?? "a tool"}`,
          status: "running",
          details: {
            source_event_index: sourceIndex,
            tool_use_id: block.id ?? null,
            tool: block.name ?? null,
            input: block.input ?? {},
          },
          artifact_refs: [],
        });
      } else if (block.type === "tool_result") {
        const isError = block.is_error === true;
        mapped.push({
          kind: "tool_call",
          summary: "Agent tool result observed",
          status: isError ? "failed" : "completed",
          details: {
            source_event_index: sourceIndex,
            tool_use_id: block.tool_use_id ?? null,
            is_error: isError,
            content: block.content ?? null,
          },
          artifact_refs: [],
        });
      }
    }
  }
  if (event.type === "result") {
    const result = event.result;
    mapped.push({
      kind: typeof result === "string" && result ? "agent_message" : "tool_call",
      summary: "Agent completed the Eval assignment",
      status: event.is_error === true ? "failed" : "completed",
      details: {
        source_event_index: sourceIndex,
        session_id: event.session_id ?? null,
        subtype: event.subtype ?? null,
        result: typeof result === "string" ? result : null,
        duration_ms: event.duration_ms ?? null,
        total_cost_usd: event.total_cost_usd ?? null,
      },
      artifact_refs: [],
    });
  }
  return mapped;
}

function correlateToolBlocks(event, sourceIndex, state) {
  const events = [];
  const content = event.message?.content;
  if (!Array.isArray(content)) return events;
  const anomaly = (summary, details) => {
    state.toolAnomalyCount += 1;
    events.push({
      kind: "error",
      summary,
      status: "failed",
      details: { source_event_index: sourceIndex, ...details },
      artifact_refs: [],
    });
  };
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use") {
      if (typeof block.id !== "string" || block.id === "") {
        anomaly("Agent source tool use has no correlation id", {});
      } else if (
        state.pendingToolIds.has(block.id) ||
        state.completedToolIds.has(block.id)
      ) {
        anomaly("Agent source reused a tool correlation id", {
          tool_use_id: block.id,
        });
      } else {
        state.pendingToolIds.set(block.id, block.name ?? null);
      }
    } else if (block.type === "tool_result") {
      const toolUseId = block.tool_use_id;
      if (typeof toolUseId !== "string" || toolUseId === "") {
        anomaly("Agent source tool result has no correlation id", {});
      } else if (!state.pendingToolIds.has(toolUseId)) {
        anomaly("Agent source tool result has no matching tool use", {
          tool_use_id: toolUseId,
        });
      } else {
        state.pendingToolIds.delete(toolUseId);
        state.completedToolIds.add(toolUseId);
      }
    }
  }
  return events;
}

export const adapter = {
  id: "anthropic.claude-code.stream-json",
  parserId: "skill-reviewer.claude-stream-json",
  parserVersion: "1.0.0",
  parserPath: fileURLToPath(import.meta.url),

  prepare(context) {
    const readableDirs = [...new Set(
      context.assignment.readable_paths
        .filter((path) => typeof path === "string")
        .map((path) => {
          const absolute = resolve(path);
          try {
            return statSync(absolute).isDirectory() ? absolute : dirname(absolute);
          } catch {
            return dirname(absolute);
          }
        }),
    )].sort();
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--safe-mode",
      "--disable-slash-commands",
      "--no-chrome",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ];
    if (readableDirs.length > 0) args.push("--add-dir", ...readableDirs);
    if (context.costLimitUsd !== undefined) {
      args.push("--max-budget-usd", String(context.costLimitUsd));
    }
    args.push(
      buildAgentPrompt({
        assignment: context.assignment,
        assignmentPath: context.assignmentPath,
        repeatRoot: context.repeatRoot,
        accessNote: "Agent 使用本地未证明隔离的安全模式；只允许锁定 profile 声明的能力。",
        isolationNote: "Agent 已禁用 slash commands、浏览器和非空 MCP 配置，并只开放 Read 工具。",
      }),
    );
    return {
      args,
      retainedPaths: [],
      initialEvents: [{
        kind: "tool_call",
        summary: "Execution harness configured Agent isolation",
        status: "completed",
        details: {
          executor: context.adapter.profile.harness,
          agent_version: context.agentVersion,
          safe_mode: true,
          slash_commands_disabled: true,
          allowed_tools: ["Read"],
          isolation_claim: context.profile.isolation,
          agent_env_name_count: context.environment.passedNameCount,
          agent_credential_name_count: context.environment.credentialNameCount,
          agent_declared_env_digest: context.environment.declaredNamesDigest,
        },
        artifact_refs: [],
      }],
      state: {
        finalResult: null,
        resultIsError: false,
        resultSeen: false,
        usage: {},
        pendingToolIds: new Map(),
        completedToolIds: new Set(),
        toolAnomalyCount: 0,
      },
    };
  },

  accept(event, sourceIndex, _context, state) {
    const correlationEvents = correlateToolBlocks(event, sourceIndex, state);
    if (event.type === "result") {
      state.resultSeen = true;
      state.resultIsError = event.is_error === true;
      if (typeof event.result === "string") state.finalResult = event.result;
      if (event.usage && typeof event.usage === "object") state.usage = event.usage;
    }
    return [...mappedEvents(event, sourceIndex), ...correlationEvents];
  },

  settle(_context, state) {
    const events = [...state.pendingToolIds].map(([toolUseId, tool]) => ({
      kind: "error",
      summary: "Agent source tool use did not receive a tool result",
      status: "failed",
      details: { tool_use_id: toolUseId, tool },
      artifact_refs: [],
    }));
    return {
      events,
      failureEventCount:
        (state.resultIsError || !state.resultSeen ? 1 : 0) +
        state.toolAnomalyCount +
        state.pendingToolIds.size,
      forbiddenActions: [],
      sideEffects: [],
      usage: state.usage,
      finalText: state.finalResult,
      requiresFinalText: true,
      metrics: {},
    };
  },
};

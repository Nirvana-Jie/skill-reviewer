import { fileURLToPath } from "node:url";

/**
 * Blind semantic judge argv for Claude Code.
 *
 * The judge is a tool-less `--print` session: it receives one prompt through
 * argv, may not read files, run commands, load skills, plugins, hooks, MCP
 * servers, or persist a session, and must answer in a single JSON result.
 */
export const judgeAdapter = {
  id: "anthropic.claude-code.stream-json",
  judgeFormat: "claude-print-json-v1",
  parserPath: fileURLToPath(import.meta.url),

  prepare(context) {
    const args = [
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--safe-mode",
      "--disable-slash-commands",
      "--no-chrome",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    ];
    if (context.costLimitUsd !== undefined) {
      args.push("--max-budget-usd", String(context.costLimitUsd));
    }
    args.push(context.prompt);
    return {
      args,
      cwd: context.scratchRoot,
      retainedPaths: [],
      isolation: {
        safe_mode: true,
        slash_commands_disabled: true,
        allowed_tools: [],
        session_persistence: false,
        mcp_servers: 0,
      },
    };
  },

  parse({ boundary }) {
    const stdout = boundary.stdout.toString("utf8");
    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      return {
        text: null,
        model: null,
        usage: {},
        failed: true,
        failureReason: "judge did not return one JSON result object",
      };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return {
        text: null,
        model: null,
        usage: {},
        failed: true,
        failureReason: "judge result is not a JSON object",
      };
    }
    const modelNames = payload.modelUsage && typeof payload.modelUsage === "object"
      ? Object.keys(payload.modelUsage).filter((name) => typeof name === "string" && name !== "")
      : [];
    const model = modelNames.length > 0
      ? modelNames.sort().join(",")
      : typeof payload.model === "string" && payload.model !== "" ? payload.model : null;
    const usage = payload.usage && typeof payload.usage === "object" ? payload.usage : {};
    if (payload.is_error === true || payload.type !== "result") {
      return {
        text: typeof payload.result === "string" ? payload.result : null,
        model,
        usage,
        failed: true,
        failureReason: `judge reported ${payload.subtype ?? "an error"}`,
      };
    }
    if (typeof payload.result !== "string" || payload.result.trim() === "") {
      return { text: null, model, usage, failed: true, failureReason: "judge result text is empty" };
    }
    return { text: payload.result, model, usage, failed: false, failureReason: null };
  },
};

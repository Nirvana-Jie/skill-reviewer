import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isolateSkills } from "./codex-exec-jsonl.mjs";

const LAST_MESSAGE_ARTIFACT = "judge-last-message.md";
const TOOL_ITEM_TYPES = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

/**
 * Blind semantic judge argv for Codex CLI.
 *
 * The judge runs `exec` in a read-only sandbox rooted at an empty scratch
 * directory with ambient Skills disabled; its final message is retained
 * through `--output-last-message` and parsed as the verdict text. The
 * read-only sandbox does not remove the shell, so blindness is enforced by
 * refusing any judgment whose stream contains a tool item (command, file
 * change, MCP call, web search), not by the sandbox.
 */
export const judgeAdapter = {
  id: "openai.codex-cli.exec-jsonl",
  judgeFormat: "codex-exec-last-message-v1",
  parserPath: fileURLToPath(import.meta.url),

  prepare(context, host) {
    const isolation = isolateSkills({
      executable: context.executable.path,
      cwd: context.scratchRoot,
      environment: context.environment.values,
      runProbe: host.runProbe,
    });
    const lastMessagePath = resolve(context.scratchRoot, LAST_MESSAGE_ARTIFACT);
    const args = [
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "-c",
      `skills.config=${isolation.config}`,
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "-C",
      context.scratchRoot,
      "--output-last-message",
      lastMessagePath,
      context.prompt,
    ];
    return {
      args,
      cwd: context.scratchRoot,
      retainedPaths: [LAST_MESSAGE_ARTIFACT],
      isolation: {
        sandbox_mode: "read-only",
        approval_policy: "never",
        ambient_skills_disabled: isolation.disabledCount,
        ambient_skill_paths_digest: isolation.disabledPathsDigest,
      },
    };
  },

  parse({ boundary, context }) {
    const lines = boundary.stdout.toString("utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
    let failed = false;
    let failureReason = null;
    let usage = {};
    let model = null;
    let completed = false;
    let toolItemsObserved = 0;
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        failed = true;
        failureReason ??= "judge event stream contained an invalid JSONL record";
        continue;
      }
      if (!event || typeof event !== "object") continue;
      if (event.type === "turn.failed" || event.type === "error") {
        failed = true;
        failureReason ??= "judge reported an execution error";
      }
      if ((event.type === "item.started" || event.type === "item.completed") && event.item && typeof event.item === "object" && TOOL_ITEM_TYPES.has(event.item.type)) {
        toolItemsObserved += 1;
        failed = true;
        failureReason ??= `judge used a tool (${event.item.type}); blind judgment refused`;
      }
      if (event.type === "turn.completed") {
        completed = true;
        if (event.usage && typeof event.usage === "object") usage = event.usage;
      }
      if (typeof event.model === "string" && event.model !== "") model = event.model;
    }
    const lastMessagePath = resolve(context.scratchRoot, LAST_MESSAGE_ARTIFACT);
    let text = null;
    if (existsSync(lastMessagePath) && statSync(lastMessagePath).isFile()) {
      text = readFileSync(lastMessagePath, "utf8");
    }
    if (!completed && !failed) {
      failed = true;
      failureReason = "judge did not complete a turn";
    }
    if (!failed && (text === null || text.trim() === "")) {
      failed = true;
      failureReason = "judge did not write a final message";
    }
    return { text, model, usage, failed, failureReason, toolItemsObserved };
  },
};

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgentPrompt } from "../agent-prompt.mjs";
import { canonicalJson, sanitizeObservable, sha256 } from "../agent-process.mjs";

const SKILL_ROOT_PATTERN = /^- `(?<alias>r\d+)` = `(?<root>[^`]+)`$/gm;
const SKILL_FILE_PATTERN = /\(file: (?<path>[^)]+\/SKILL\.md)\)/g;
const NETWORK_COMMAND = /(?:^|[\s;&|])(?:curl|wget|ssh|scp|rsync)(?:\s|$)|\bgit\s+(?:clone|fetch|pull|push)\b|\b(?:npm|pnpm|yarn|pip|pip3|brew)\s+(?:add|install|update)\b/i;
const EXTERNAL_SIDE_EFFECT = /\bgit\s+push\b|\bgh\s+pr\s+(?:create|merge)\b|\b(?:lark|bytedcli)\b.*\b(?:send|create|update|delete|publish)\b/i;

function promptInputTexts(payload) {
  if (!Array.isArray(payload)) throw new Error("prompt-input inspection must return a JSON array");
  const texts = [];
  for (const message of payload) {
    if (!message || !Array.isArray(message.content)) continue;
    for (const item of message.content) {
      if (item && typeof item.text === "string") texts.push(item.text);
    }
  }
  return texts;
}

function parseVisibleSkillPaths(payload) {
  const joined = promptInputTexts(payload).join("\n");
  const roots = new Map();
  for (const match of joined.matchAll(SKILL_ROOT_PATTERN)) {
    roots.set(match.groups.alias, match.groups.root);
  }
  const paths = new Set();
  for (const match of joined.matchAll(SKILL_FILE_PATTERN)) {
    const raw = match.groups.path;
    const slash = raw.indexOf("/");
    const alias = slash >= 0 ? raw.slice(0, slash) : raw;
    const resolved = slash >= 0 && roots.has(alias)
      ? resolve(roots.get(alias), raw.slice(slash + 1))
      : resolve(raw);
    if (isAbsolute(resolved)) paths.add(resolved);
  }
  if (joined.includes("<skills_instructions>") && paths.size === 0) {
    throw new Error("Agent exposed skills to the model, but their paths could not be isolated");
  }
  return { paths: [...paths].sort(), digest: sha256(canonicalJson(payload)) };
}

function skillConfig(paths) {
  return `[${paths
    .map((path) => `{path=${JSON.stringify(path)},enabled=false}`)
    .join(",")}]`;
}

function isolateSkills({ executable, cwd, environment, runProbe }) {
  const inspect = (config) => {
    const args = ["debug", "prompt-input"];
    if (config !== undefined) args.push("-c", `skills.config=${config}`);
    args.push("SKILL_EVAL_ISOLATION_PROBE");
    const result = runProbe({ executable, args, cwd, environment });
    if (result.status !== 0) {
      throw new Error(
        `model-visible skill inspection failed (${result.status}): ${(result.stderr || result.stdout).trim().slice(0, 1000)}`,
      );
    }
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error("prompt-input inspection returned invalid JSON");
    }
    return parseVisibleSkillPaths(payload);
  };
  const discovered = inspect();
  const config = skillConfig(discovered.paths);
  const verified = inspect(config);
  if (verified.paths.length > 0) {
    throw new Error(`skill isolation failed; model-visible skills remain enabled: ${verified.paths.slice(0, 5).join(", ")}`);
  }
  return {
    config,
    disabledCount: discovered.paths.length,
    disabledPathsDigest: sha256(discovered.paths.join("\n")),
    discoveryDigest: discovered.digest,
    verificationDigest: verified.digest,
  };
}

function relativeRefs(item, repeatRoot) {
  const candidates = [];
  if (Array.isArray(item.changes)) {
    for (const change of item.changes) {
      if (change && typeof change.path === "string") candidates.push(change.path);
    }
  }
  if (typeof item.path === "string") candidates.push(item.path);
  const refs = new Set();
  for (const raw of candidates) {
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(repeatRoot, raw);
    const candidate = relative(repeatRoot, absolute);
    if (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate)) {
      refs.add(candidate.split(sep).join("/"));
    }
  }
  return [...refs].sort();
}

function eventStatus(item) {
  if (Number.isInteger(item.exit_code)) return item.exit_code === 0 ? "completed" : "failed";
  if (["completed", "failed", "timed_out", "interrupted", "running"].includes(item.status)) {
    return item.status;
  }
  return "completed";
}

function shortCommand(command) {
  const value = typeof command === "string" ? command : canonicalJson(command);
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 180)}…` : compact;
}

function mapEvent(event, sourceIndex, repeatRoot) {
  const eventType = event.type;
  const base = { source_event_index: sourceIndex, source_event_type: eventType };
  if (eventType === "thread.started") {
    return [{
      kind: "tool_call",
      summary: "Agent session started",
      status: "completed",
      details: { ...base, thread_id: event.thread_id ?? null },
      artifact_refs: [],
    }];
  }
  if (eventType === "turn.started") {
    return [{ kind: "tool_call", summary: "Agent turn started", status: "running", details: base, artifact_refs: [] }];
  }
  if (eventType === "turn.completed") {
    return [{
      kind: "tool_call",
      summary: "Agent turn completed",
      status: "completed",
      details: { ...base, usage: sanitizeObservable(event.usage ?? {}) },
      artifact_refs: [],
    }];
  }
  if (eventType === "turn.failed" || eventType === "error") {
    return [{
      kind: "error",
      summary: "Agent source reported an execution error",
      status: "failed",
      details: { ...base, error: sanitizeObservable(event.error ?? event) },
      artifact_refs: [],
    }];
  }
  if (eventType !== "item.completed") return [];
  const item = event.item;
  if (!item || typeof item !== "object") {
    return [{ kind: "error", summary: "Agent returned an invalid completion event", status: "failed", details: base, artifact_refs: [] }];
  }
  const itemType = item.type;
  if (itemType === "reasoning") return [];
  const itemBase = {
    ...base,
    source_item_id: item.id ?? null,
    source_item_type: itemType ?? null,
  };
  if (itemType === "agent_message") {
    return [{
      kind: "agent_message",
      summary: "Agent produced an observable message",
      status: eventStatus(item),
      details: { ...itemBase, role: "assistant", content: item.text ?? item.content ?? "" },
      artifact_refs: [],
    }];
  }
  if (itemType === "command_execution") {
    const command = item.command ?? item.argv ?? "";
    return [{
      kind: "command",
      summary: `Executed command: ${shortCommand(command)}`,
      status: eventStatus(item),
      details: { ...itemBase, ...item },
      artifact_refs: [],
    }];
  }
  if (itemType === "file_change") {
    const refs = relativeRefs(item, repeatRoot);
    return [{
      kind: refs.length > 0 ? "artifact_written" : "tool_call",
      summary: refs.length > 0 ? "Agent wrote a file" : "Agent reported a file change",
      status: eventStatus(item),
      details: { ...itemBase, ...item },
      artifact_refs: refs,
    }];
  }
  if (itemType === "error") {
    return [{ kind: "error", summary: "Agent returned an execution error", status: "failed", details: { ...itemBase, ...item }, artifact_refs: [] }];
  }
  return [{
    kind: "tool_call",
    summary: `Agent completed observable event: ${itemType ?? "unknown"}`,
    status: eventStatus(item),
    details: { ...itemBase, ...item },
    artifact_refs: relativeRefs(item, repeatRoot),
  }];
}

function commandObservation(event) {
  if (event.type !== "item.completed" || event.item?.type !== "command_execution") return null;
  const raw = event.item.command ?? event.item.argv;
  return {
    command: typeof raw === "string" ? raw : canonicalJson(raw),
    exitCode: Number.isInteger(event.item.exit_code) ? event.item.exit_code : null,
  };
}

export const adapter = {
  id: "openai.codex-cli.exec-jsonl",
  parserId: "skill-reviewer.codex-exec-jsonl",
  parserVersion: "1.0.0",
  parserPath: fileURLToPath(import.meta.url),

  prepare(context, host) {
    const isolation = isolateSkills({
      executable: context.executable.path,
      cwd: context.repeatRoot,
      environment: context.environment.values,
      runProbe: host.runProbe,
    });
    const expected = context.assignment.expected_artifacts;
    const lastMessageRelative = expected.includes("outputs/response.md")
      ? "outputs/response.md"
      : "agent-last-message.md";
    const lastMessagePath = resolve(context.repeatRoot, lastMessageRelative);
    const fullAccess = context.fullAccess;
    const prompt = buildAgentPrompt({
      assignment: context.assignment,
      assignmentPath: context.assignmentPath,
      repeatRoot: context.repeatRoot,
      accessNote: fullAccess
        ? "Agent 进程拥有已锁定的 full-access grant；这只是本地执行事实，不代表隔离。"
        : "Agent 进程使用 workspace-write 沙箱。",
      isolationNote: "执行框架已验证并禁用自动发现的环境 Skill；不要绕过这项隔离。",
    });
    const args = [
      "--sandbox",
      fullAccess ? "danger-full-access" : "workspace-write",
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
      context.repeatRoot,
      "--output-last-message",
      lastMessagePath,
    ];
    args.push(prompt);
    return {
      args,
      retainedPaths: [lastMessageRelative],
      initialEvents: [{
        kind: "tool_call",
        summary: "Execution harness configured Agent isolation",
        status: "completed",
        details: {
          executor: context.adapter.profile.harness,
          agent_version: context.agentVersion,
          sandbox_mode: fullAccess ? "danger-full-access" : "workspace-write",
          approval_policy: "never",
          isolation_claim: context.profile.isolation,
          permission_enforcement: fullAccess
            ? "instruction-and-observable-trace-only"
            : "workspace-write",
          ambient_skills_disabled: isolation.disabledCount,
          ambient_skill_paths_digest: isolation.disabledPathsDigest,
          prompt_input_discovery_digest: isolation.discoveryDigest,
          prompt_input_verification_digest: isolation.verificationDigest,
          agent_env_name_count: context.environment.passedNameCount,
          agent_credential_name_count: context.environment.credentialNameCount,
          agent_declared_env_digest: context.environment.declaredNamesDigest,
        },
        artifact_refs: [],
      }],
      state: {
        pendingItems: new Map(),
        commands: [],
        usage: {},
        failureEventCount: 0,
        ambientSkillsDisabled: isolation.disabledCount,
      },
    };
  },

  accept(event, sourceIndex, context, state) {
    if (event.type === "turn.failed" || event.type === "error") state.failureEventCount += 1;
    if (event.type === "item.started" && event.item && typeof event.item === "object" && typeof event.item.id === "string") {
      state.pendingItems.set(event.item.id, event.item);
    }
    if (event.type === "item.completed" && typeof event.item?.id === "string") {
      state.pendingItems.delete(event.item.id);
    }
    const observed = commandObservation(event);
    if (observed) state.commands.push(observed);
    if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
      state.usage = event.usage;
    }
    return mapEvent(event, sourceIndex, context.repeatRoot);
  },

  settle(context, state, boundary) {
    const events = [];
    for (const [itemId, item] of state.pendingItems) {
      if (item.type === "command_execution") {
        const raw = item.command ?? item.argv ?? "";
        state.commands.push({ command: typeof raw === "string" ? raw : canonicalJson(raw), exitCode: null });
      }
      events.push({
        kind: "error",
        summary: "Agent source item did not finish before process exit",
        status: boundary.timedOut ? "timed_out" : "failed",
        details: {
          source_item_id: itemId,
          source_item_type: item.type ?? null,
          observable_item: item,
        },
        artifact_refs: [],
      });
    }
    const forbiddenActions = [];
    const sideEffects = [];
    for (const { command, exitCode } of state.commands) {
      const short = shortCommand(command);
      if (context.assignment.permissions.network === "deny" && NETWORK_COMMAND.test(command)) {
        forbiddenActions.push(`network=deny while an external-network command was observed: ${short}`);
      }
      if (
        context.assignment.permissions.external_side_effects === "deny" &&
        EXTERNAL_SIDE_EFFECT.test(command)
      ) {
        forbiddenActions.push(`external_side_effects=deny while an external mutation command was observed: ${short}`);
        if (exitCode === 0) sideEffects.push(`external mutation command succeeded: ${short}`);
      }
    }
    return {
      events,
      failureEventCount: state.failureEventCount,
      forbiddenActions: [...new Set(forbiddenActions)],
      sideEffects: [...new Set(sideEffects)],
      usage: state.usage,
      finalText: null,
      requiresFinalText: false,
      metrics: {
        ambient_skills_disabled: state.ambientSkillsDisabled,
        full_access_enabled: context.fullAccess ? 1 : 0,
      },
    };
  },
};

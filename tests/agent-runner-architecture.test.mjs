import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsRoot = join(repoRoot, "skills/skill-reviewer/scripts");

function recursiveFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? recursiveFiles(root, path) : [path.slice(root.length + 1)];
  });
}

describe("agent execution architecture", () => {
  it("exposes one provider-neutral MJS runner and no provider-named top-level runner", () => {
    expect(existsSync(join(scriptsRoot, "run_agent_eval.mjs"))).toBe(true);
    expect(
      readdirSync(scriptsRoot)
        .filter((name) => /^run_(codex|claude|gemini|copilot|opencode)/.test(name))
        .sort(),
    ).toEqual([]);
  });

  it("keeps provider vocabulary inside registry and adapter locality", () => {
    const publicRunner = readFileSync(
      join(scriptsRoot, "run_agent_eval.mjs"),
      "utf8",
    );
    const executionCore = readFileSync(
      join(scriptsRoot, "lib/agent-execution.mjs"),
      "utf8",
    );

    for (const source of [publicRunner, executionCore]) {
      expect(source).not.toMatch(/\b(?:codex|claude|gemini|copilot|opencode)\b/i);
    }
    expect(publicRunner).not.toContain("--registry");
    expect(publicRunner).not.toContain("--model");
  });

  it("publishes runAgentCell and runAgentPlan as the two execution seams", async () => {
    const execution = await import(
      "../skills/skill-reviewer/scripts/lib/agent-execution.mjs"
    );

    expect(execution.runAgentCell).toBeTypeOf("function");
    expect(execution.runAgentPlan).toBeTypeOf("function");
  });

  it("uses in-process MJS authority and grading instead of a language bridge", () => {
    const bridge = readFileSync(
      join(scriptsRoot, "lib/agent-runtime-bridge.mjs"),
      "utf8",
    );

    expect(bridge).toContain('from "./skill-eval-authority.mjs"');
    expect(bridge).toContain('from "./skill-eval-grading.mjs"');
    expect(bridge).not.toContain("node:child_process");
    expect(bridge).not.toMatch(/spawn(?:Sync)?\s*\(/);
  });

  it("documents the generic CLI without requiring provider knowledge", () => {
    const result = spawnSync(
      process.execPath,
      [join(scriptsRoot, "run_agent_eval.mjs"), "--help"],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("run_agent_eval.mjs plan");
    expect(result.stdout).toContain("adapters list");
  });

  it("rejects non-finite and non-positive operational limits before preflight", () => {
    const runner = join(scriptsRoot, "run_agent_eval.mjs");
    for (const [flag, value, message] of [
      ["--max-workers", "NaN", "--max-workers must be a positive integer"],
      ["--timeout-seconds", "0", "--timeout-seconds must be a positive integer"],
      ["--cost-limit-usd", "-1", "--cost-limit-usd must be a non-negative number"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [runner, "plan", "--workspace", repoRoot, flag, value],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
    }
  });

  it("keeps Dashboard validation and labels independent of named Agent products", () => {
    const dashboardSchema = readFileSync(
      join(repoRoot, "dashboard/src/dashboard-schema.ts"),
      "utf8",
    );
    const uiPreferences = readFileSync(
      join(repoRoot, "dashboard/src/ui-preferences.tsx"),
      "utf8",
    );

    for (const source of [dashboardSchema, uiPreferences]) {
      expect(source).not.toMatch(/\b(?:codex|claude|gemini|copilot|opencode)\b/i);
    }
  });

  it("ships one JavaScript runtime without Python script fallbacks", () => {
    const files = recursiveFiles(scriptsRoot).sort();
    expect(files.filter((path) => path.endsWith(".py"))).toEqual([]);
    for (const entrypoint of [
      "dashboard_bundle.mjs",
      "lint_skill_package.mjs",
      "run_agent_eval.mjs",
      "serve_skill_dashboard.mjs",
      "skill_eval_runtime.mjs",
      "start_skill_dashboard.mjs",
    ]) {
      expect(files, entrypoint).toContain(entrypoint);
    }
  });

  it("documents only Node-based project script invocations", () => {
    const documentation = [
      "AGENTS.md",
      "CONTRIBUTING.md",
      "README.md",
      "README.zh-CN.md",
      "docs/architecture.md",
      "skills/skill-reviewer/SKILL.md",
      "skills/skill-reviewer/evals/fixtures/README.md",
      "skills/skill-reviewer/references/evolution-workflow.md",
      "skills/skill-reviewer/references/verification-workflow.md",
    ].map((relative) => readFileSync(join(repoRoot, relative), "utf8")).join("\n");

    expect(documentation).not.toMatch(/\bpython3?\b/i);
    expect(documentation).not.toMatch(/scripts\/[A-Za-z0-9_/-]+\.py\b/);
  });
});

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsRoot = join(repoRoot, "skills/skill-reviewer/scripts");

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
});

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertSupportedAgentVersion,
  loadAgentRegistry,
  resolveAgentAdapter,
} from "../skills/skill-reviewer/scripts/lib/agent-registry.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = join(
  repoRoot,
  "skills/skill-reviewer/assets/agent-adapter-registry.json",
);

describe("agent adapter registry", () => {
  it("separates source identity, protocol stability, and implementation maturity", () => {
    const registry = loadAgentRegistry({ registryPath });
    const adapters = new Map(registry.adapters.map((entry) => [entry.id, entry]));

    expect([...adapters.keys()].sort()).toEqual([
      "anthropic.claude-code.stream-json",
      "github.copilot-cli.jsonl",
      "google.gemini-cli.stream-json",
      "openai.codex-cli.exec-jsonl",
      "opencode.cli.run-json",
    ]);
    expect(adapters.get("openai.codex-cli.exec-jsonl")).toEqual(
      expect.objectContaining({
        source_agent: expect.objectContaining({ id: "openai.codex-cli" }),
        source_format: expect.objectContaining({
          id: "codex.exec-jsonl",
          stability: "version-pinned",
        }),
        implementation: {
          execution: "implemented",
          maturity: "canary-verified",
        },
      }),
    );
    expect(adapters.get("github.copilot-cli.jsonl")).toEqual(
      expect.objectContaining({
        source_agent: expect.objectContaining({ id: "github.copilot-cli" }),
        source_format: expect.objectContaining({ stability: "provisional" }),
        implementation: {
          execution: "not-implemented",
          maturity: "researched",
        },
      }),
    );
    expect([...adapters.values()].every((entry) => entry.terminal_authority !== "none"))
      .toBe(true);
  });

  it("keeps every claimed source attributable to official evidence", () => {
    const registry = loadAgentRegistry({ registryPath });

    for (const entry of registry.adapters) {
      expect(entry.source_agent.id, entry.id).toMatch(/^[a-z0-9][a-z0-9.-]+$/);
      expect(entry.source_format.official_sources, entry.id).not.toHaveLength(0);
      for (const source of entry.source_format.official_sources) {
        expect(source, entry.id).toMatch(/^https:\/\//);
      }
      expect(entry.registry_entry_digest, entry.id).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("fails closed for unknown, non-executable, and duplicate adapters", () => {
    const registry = loadAgentRegistry({ registryPath });

    expect(() => resolveAgentAdapter(registry, "unknown.agent")).toThrow(
      "unknown agent adapter",
    );
    expect(() =>
      resolveAgentAdapter(registry, "github.copilot-cli.jsonl", {
        requireExecution: true,
      }),
    ).toThrow("is not implemented for execution");

    const raw = JSON.parse(readFileSync(registryPath, "utf8"));
    raw.adapters.push(structuredClone(raw.adapters[0]));
    expect(() => loadAgentRegistry({ value: raw })).toThrow(
      "duplicate agent adapter id",
    );
  });

  it("requires an executable adapter to declare its complete locked profile", () => {
    const raw = JSON.parse(readFileSync(registryPath, "utf8"));
    delete raw.adapters[0].profile.dispatch_observation;

    expect(() => loadAgentRegistry({ value: raw })).toThrow(
      "profile.dispatch_observation must be a string",
    );
  });

  it("pins executable adapters and source-commit evidence to immutable versions", () => {
    const raw = JSON.parse(readFileSync(registryPath, "utf8"));
    delete raw.adapters[0].runtime.version_policy;
    expect(() => loadAgentRegistry({ value: raw })).toThrow(
      "runtime.version_policy must be an object",
    );

    const registry = loadAgentRegistry({ registryPath });
    for (const entry of registry.adapters) {
      if (entry.implementation.execution === "implemented") {
        expect(entry.runtime.version_policy.kind, entry.id).toBe("exact-token");
        expect(entry.source_format.contract_version, entry.id).toMatch(/^cli@\d/);
      }
      if (entry.source_format.contract_version.startsWith("source@")) {
        expect(entry.source_format.official_sources.join("\n"), entry.id).not.toMatch(
          /\/blob\/(?:main|dev)\//,
        );
      }
    }
  });

  it("rejects near-match, prerelease, and build-suffixed Agent versions", () => {
    const registry = loadAgentRegistry({ registryPath });
    const adapter = resolveAgentAdapter(registry, "openai.codex-cli.exec-jsonl");

    expect(() => assertSupportedAgentVersion(adapter, "codex-cli 0.144.5"))
      .not.toThrow();
    for (const observed of [
      "codex-cli 0.144.50",
      "codex-cli 0.144.5-beta.1",
      "codex-cli 0.144.5+local",
      "codex-cli v0.144.5",
    ]) {
      expect(() => assertSupportedAgentVersion(adapter, observed), observed).toThrow(
        "does not satisfy the pinned adapter version 0.144.5",
      );
    }
  });

  it("records Hook formats per source Agent instead of pretending they are one schema", () => {
    const registry = loadAgentRegistry({ registryPath });
    const hooks = registry.adapters
      .flatMap((entry) =>
        entry.supplemental_sources.map((source) => ({
          source_agent: entry.source_agent.id,
          ...source,
        })),
      )
      .filter((source) => source.channel === "hook");

    expect(hooks.map((source) => source.source_agent).sort()).toEqual([
      "anthropic.claude-code",
      "github.copilot-cli",
      "google.gemini-cli",
      "openai.codex-cli",
    ]);
    expect(new Set(hooks.map((source) => source.format)).size).toBe(4);
    expect(hooks.every((source) => source.terminal_authority === false)).toBe(true);
    expect(hooks.every((source) => source.implementation === "not-implemented"))
      .toBe(true);
    expect(
      hooks.every((source) => source.correlation_to_primary === "not-established"),
    ).toBe(true);
  });
});

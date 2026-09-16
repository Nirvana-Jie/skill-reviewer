import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertSupportedAgentVersion,
  loadAgentRegistry,
  resolveAgentAdapter,
} from "../skills/skill-reviewer/scripts/lib/agent-registry.mjs";
import {
  compareSemver,
  evaluateVersionPolicy,
  extractSemverToken,
  parseVersionPolicy,
} from "../skills/skill-reviewer/scripts/lib/agent-version-policy.mjs";

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
        const policy = entry.runtime.version_policy;
        expect(policy.kind, entry.id).toBe("compatible-range");
        for (const field of ["canary_verified", "minimum", "maximum_exclusive"]) {
          expect(policy[field], `${entry.id}.${field}`).toMatch(/^\d+\.\d+\.\d+$/);
        }
        expect(compareSemver(policy.minimum, policy.canary_verified), entry.id).toBeLessThanOrEqual(0);
        expect(compareSemver(policy.canary_verified, policy.maximum_exclusive), entry.id).toBeLessThan(0);
        expect(entry.source_format.contract_version, entry.id).toBe(`cli@${policy.canary_verified}`);
      }
      if (entry.source_format.contract_version.startsWith("source@")) {
        expect(entry.source_format.official_sources.join("\n"), entry.id).not.toMatch(
          /\/blob\/(?:main|dev)\//,
        );
      }
    }
  });

  it("rejects out-of-range, prerelease, build-suffixed, and near-match Agent versions", () => {
    const registry = loadAgentRegistry({ registryPath });
    const adapter = resolveAgentAdapter(registry, "openai.codex-cli.exec-jsonl");

    expect(assertSupportedAgentVersion(adapter, "codex-cli 0.144.5")).toEqual(
      expect.objectContaining({ satisfied: true, observed: "0.144.5", drifted: false }),
    );
    for (const observed of [
      "codex-cli 0.144.4",
      "codex-cli 1.0.0",
      "codex-cli 999.0.0",
      "codex-cli 0.144.5-beta.1",
      "codex-cli 0.144.5+local",
      "codex-cli v0.144.5",
      "codex-cli 0.144",
      "unavailable",
    ]) {
      expect(() => assertSupportedAgentVersion(adapter, observed), observed).toThrow(
        "does not satisfy the adapter version policy",
      );
    }

    const legacy = {
      id: "legacy.exact",
      runtime: { version_policy: { kind: "exact-token", value: "2.1.215" } },
    };
    expect(assertSupportedAgentVersion(legacy, "2.1.215 (Agent)")).toEqual(
      expect.objectContaining({ satisfied: true, observed: "2.1.215", drifted: false }),
    );
    for (const observed of ["2.1.2150 (Agent)", "2.1.215-rc.1", "2.1.215+build", "v2.1.215", "2.1.216"]) {
      expect(() => assertSupportedAgentVersion(legacy, observed), observed).toThrow(
        "does not satisfy the adapter version policy (exact version 2.1.215)",
      );
    }
  });

  it("accepts in-range drift from the canary-verified version and reports it", () => {
    const registry = loadAgentRegistry({ registryPath });
    const claude = resolveAgentAdapter(registry, "anthropic.claude-code.stream-json");
    const codex = resolveAgentAdapter(registry, "openai.codex-cli.exec-jsonl");

    expect(assertSupportedAgentVersion(claude, "2.1.273 (Claude Code)")).toEqual({
      satisfied: true,
      observed: "2.1.273",
      canary_verified: "2.1.215",
      drifted: true,
      reason: null,
    });
    expect(assertSupportedAgentVersion(codex, "codex-cli 0.154.0")).toEqual({
      satisfied: true,
      observed: "0.154.0",
      canary_verified: "0.144.5",
      drifted: true,
      reason: null,
    });
    // A longer patch number is a real later release, not a substring match.
    expect(assertSupportedAgentVersion(codex, "codex-cli 0.144.50")).toEqual(
      expect.objectContaining({ observed: "0.144.50", drifted: true }),
    );
  });

  it("validates version policy shapes strictly", () => {
    expect(parseVersionPolicy({ kind: "exact-token", value: "1.2.3" })).toEqual({
      kind: "exact-token",
      value: "1.2.3",
    });
    for (const [policy, message] of [
      [{ kind: "exact-token", value: "v1.2.3" }, "value must be a strict MAJOR.MINOR.PATCH version"],
      [{ kind: "compatible-range", canary_verified: "1.2.3", minimum: "1.2.3", maximum_exclusive: "1.2.3" }, "minimum must be lower than maximum_exclusive"],
      [{ kind: "compatible-range", canary_verified: "2.0.0", minimum: "1.0.0", maximum_exclusive: "2.0.0" }, "canary_verified must lie inside the compatible range"],
      [{ kind: "compatible-range", canary_verified: "1.0.0", minimum: "01.0.0", maximum_exclusive: "2.0.0" }, "minimum must be a strict MAJOR.MINOR.PATCH version"],
      [{ kind: "latest" }, "kind must be one of exact-token, compatible-range"],
      [null, "must be an object"],
    ]) {
      expect(() => parseVersionPolicy(policy), JSON.stringify(policy)).toThrow(message);
    }

    const raw = JSON.parse(readFileSync(registryPath, "utf8"));
    raw.adapters[0].runtime.version_policy = {
      kind: "compatible-range",
      canary_verified: "0.144.5",
      minimum: "0.144.5",
      maximum_exclusive: "0.144.5",
    };
    expect(() => loadAgentRegistry({ value: raw })).toThrow(
      "runtime.version_policy.minimum must be lower than maximum_exclusive",
    );
  });

  it("extracts only strict release tokens from --version output", () => {
    expect(extractSemverToken("2.1.273 (Claude Code)")).toBe("2.1.273");
    expect(extractSemverToken("codex-cli 0.154.0")).toBe("0.154.0");
    expect(extractSemverToken("codex-cli 0.144.50")).toBe("0.144.50");
    for (const line of ["v1.2.3", "1.2.3-beta.1", "1.2.3+build.7", "1.2", "01.2.3", "", undefined]) {
      expect(extractSemverToken(line), String(line)).toBeNull();
    }
    expect(compareSemver("0.144.50", "0.144.5")).toBe(1);
    expect(compareSemver("2.1.215", "2.1.2150")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(
      evaluateVersionPolicy({ kind: "exact-token", value: "2.1.215" }, "2.1.2150"),
    ).toEqual(expect.objectContaining({ satisfied: false, observed: "2.1.2150" }));
  });

  it("fails closed when a --version line carries two different release tokens", () => {
    const registry = loadAgentRegistry({ registryPath });
    const adapter = resolveAgentAdapter(registry, "openai.codex-cli.exec-jsonl");
    expect(() => assertSupportedAgentVersion(adapter, "codex-cli 0.150.0 (node 22.20.0)")).toThrow(
      "multiple distinct release tokens were observed",
    );
    expect(assertSupportedAgentVersion(adapter, "codex-cli 0.150.0 (build 0.150.0)")).toEqual(
      expect.objectContaining({ satisfied: true, observed: "0.150.0", drifted: true }),
    );
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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "./agent-digest.mjs";

const REGISTRY_CONTRACT = "skill-reviewer.agent-adapter-registry";
const REGISTRY_SCHEMA_VERSION = "1.0.0";
const ADAPTER_ID = /^[a-z0-9][a-z0-9.-]+$/;
const STABILITIES = new Set(["stable", "version-pinned", "provisional", "experimental"]);
const EXECUTION_STATES = new Set(["implemented", "not-implemented"]);
const MATURITIES = new Set([
  "declared",
  "researched",
  "fixture-verified",
  "canary-verified",
]);
const TERMINAL_AUTHORITIES = new Set([
  "event-and-process",
  "process-only",
  "none",
]);
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SAFE_ARTIFACT = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

export const builtInAgentRegistryPath = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  "assets",
  "agent-adapter-registry.json",
);

function fail(message) {
  throw new Error(`invalid agent adapter registry: ${message}`);
}

function digest(value) {
  return sha256(canonicalJson(value));
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a string`);
  return value;
}

function validateSupplementalSource(source, label) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    fail(`${label} must be an object`);
  }
  requireString(source.channel, `${label}.channel`);
  requireString(source.format, `${label}.format`);
  if (!STABILITIES.has(source.contract_stability)) {
    fail(`${label}.contract_stability is invalid`);
  }
  if (source.implementation !== "not-implemented") {
    fail(`${label}.implementation must be not-implemented`);
  }
  if (source.correlation_to_primary !== "not-established") {
    fail(`${label}.correlation_to_primary must be not-established`);
  }
  requireString(source.official_source, `${label}.official_source`);
  if (!source.official_source.startsWith("https://")) {
    fail(`${label}.official_source must use https`);
  }
  if (source.terminal_authority !== false) {
    fail(`${label}.terminal_authority must be false`);
  }
}

function validateImplementedRuntime(entry, label) {
  const runtime = entry.runtime;
  if (runtime === null || typeof runtime !== "object" || Array.isArray(runtime)) {
    fail(`${label}.runtime must be an object`);
  }
  requireString(runtime.adapter_module, `${label}.runtime.adapter_module`);
  requireString(runtime.default_executable, `${label}.runtime.default_executable`);
  if (
    runtime.version_policy === null ||
    typeof runtime.version_policy !== "object" ||
    Array.isArray(runtime.version_policy)
  ) {
    fail(`${label}.runtime.version_policy must be an object`);
  }
  if (runtime.version_policy.kind !== "exact-token") {
    fail(`${label}.runtime.version_policy.kind must be exact-token`);
  }
  requireString(
    runtime.version_policy.value,
    `${label}.runtime.version_policy.value`,
  );
  if (
    !Array.isArray(runtime.inherited_environment) ||
    runtime.inherited_environment.some(
      (name) => typeof name !== "string" || !ENVIRONMENT_NAME.test(name),
    ) ||
    new Set(runtime.inherited_environment).size !== runtime.inherited_environment.length
  ) {
    fail(`${label}.runtime.inherited_environment must be a unique environment-name array`);
  }

  const profile = entry.profile;
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    fail(`${label}.profile must be an object`);
  }
  for (const field of [
    "target",
    "harness",
    "dispatch_observation",
    "capture_source",
    "source_artifact",
    "source_format",
    "stderr_artifact",
  ]) {
    requireString(profile[field], `${label}.profile.${field}`);
  }
  if (profile.dispatch_observation !== "process_spawn") {
    fail(`${label}.profile.dispatch_observation must be process_spawn`);
  }
  for (const field of ["source_artifact", "stderr_artifact"]) {
    if (!SAFE_ARTIFACT.test(profile[field])) {
      fail(`${label}.profile.${field} must be a safe relative artifact path`);
    }
  }
  if (
    !Array.isArray(profile.required_capabilities) ||
    profile.required_capabilities.length === 0 ||
    profile.required_capabilities.some(
      (capability) => typeof capability !== "string" || capability.trim() === "",
    ) ||
    new Set(profile.required_capabilities).size !== profile.required_capabilities.length
  ) {
    fail(`${label}.profile.required_capabilities must be a non-empty unique string array`);
  }
  if (profile.full_access_capability !== undefined) {
    requireString(
      profile.full_access_capability,
      `${label}.profile.full_access_capability`,
    );
  }
}

function validateEntry(entry, index) {
  const label = `adapters[${index}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail(`${label} must be an object`);
  }
  const id = requireString(entry.id, `${label}.id`);
  if (!ADAPTER_ID.test(id)) fail(`${label}.id is invalid`);
  if (entry.source_agent === null || typeof entry.source_agent !== "object") {
    fail(`${label}.source_agent must be an object`);
  }
  const sourceAgentId = requireString(entry.source_agent.id, `${label}.source_agent.id`);
  if (!ADAPTER_ID.test(sourceAgentId)) fail(`${label}.source_agent.id is invalid`);
  requireString(entry.source_agent.product, `${label}.source_agent.product`);
  requireString(entry.source_agent.distribution, `${label}.source_agent.distribution`);
  if (entry.source_format === null || typeof entry.source_format !== "object") {
    fail(`${label}.source_format must be an object`);
  }
  requireString(entry.source_format.id, `${label}.source_format.id`);
  requireString(entry.source_format.transport, `${label}.source_format.transport`);
  requireString(entry.source_format.framing, `${label}.source_format.framing`);
  requireString(entry.source_format.contract_version, `${label}.source_format.contract_version`);
  if (!STABILITIES.has(entry.source_format.stability)) {
    fail(`${label}.source_format.stability is invalid`);
  }
  if (
    !Array.isArray(entry.source_format.official_sources) ||
    entry.source_format.official_sources.length === 0 ||
    entry.source_format.official_sources.some(
      (source) => typeof source !== "string" || !source.startsWith("https://"),
    )
  ) {
    fail(`${label}.source_format.official_sources must be a non-empty https array`);
  }
  requireString(entry.evidence_authority, `${label}.evidence_authority`);
  if (!TERMINAL_AUTHORITIES.has(entry.terminal_authority)) {
    fail(`${label}.terminal_authority is invalid`);
  }
  if (entry.implementation === null || typeof entry.implementation !== "object") {
    fail(`${label}.implementation must be an object`);
  }
  if (!EXECUTION_STATES.has(entry.implementation.execution)) {
    fail(`${label}.implementation.execution is invalid`);
  }
  if (!MATURITIES.has(entry.implementation.maturity)) {
    fail(`${label}.implementation.maturity is invalid`);
  }
  if (
    entry.implementation.execution === "implemented" &&
    (entry.runtime === null || typeof entry.runtime.adapter_module !== "string")
  ) {
    fail(`${label} implements execution but has no adapter module`);
  }
  if (entry.implementation.execution === "implemented") {
    validateImplementedRuntime(entry, label);
  }
  if (!Array.isArray(entry.supplemental_sources)) {
    fail(`${label}.supplemental_sources must be an array`);
  }
  entry.supplemental_sources.forEach((source, sourceIndex) =>
    validateSupplementalSource(source, `${label}.supplemental_sources[${sourceIndex}]`),
  );
  return Object.freeze({
    ...structuredClone(entry),
    registry_entry_digest: digest(entry),
  });
}

export function loadAgentRegistry({
  registryPath = builtInAgentRegistryPath,
  value,
} = {}) {
  const raw = value ?? JSON.parse(readFileSync(registryPath, "utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("root must be an object");
  }
  if (raw.contract !== REGISTRY_CONTRACT) fail("contract is invalid");
  if (raw.schema_version !== REGISTRY_SCHEMA_VERSION) fail("schema version is unsupported");
  if (!Array.isArray(raw.adapters) || raw.adapters.length === 0) {
    fail("adapters must be a non-empty array");
  }
  const seen = new Set();
  const adapters = raw.adapters.map((entry, index) => {
    const validated = validateEntry(entry, index);
    if (seen.has(validated.id)) fail(`duplicate agent adapter id: ${validated.id}`);
    seen.add(validated.id);
    return validated;
  });
  return Object.freeze({
    contract: REGISTRY_CONTRACT,
    schema_version: REGISTRY_SCHEMA_VERSION,
    registry_digest: digest({
      contract: REGISTRY_CONTRACT,
      schema_version: REGISTRY_SCHEMA_VERSION,
      adapters: raw.adapters,
    }),
    adapters: Object.freeze(adapters),
  });
}

export function resolveAgentAdapter(
  registry,
  adapterId,
  { requireExecution = false } = {},
) {
  const adapter = registry.adapters.find((entry) => entry.id === adapterId);
  if (!adapter) throw new Error(`unknown agent adapter: ${adapterId}`);
  if (requireExecution && adapter.implementation.execution !== "implemented") {
    throw new Error(`agent adapter ${adapterId} is not implemented for execution`);
  }
  return adapter;
}

export function assertSupportedAgentVersion(adapter, observedVersion) {
  const policy = adapter.runtime?.version_policy;
  if (policy?.kind !== "exact-token" || typeof policy.value !== "string") {
    throw new Error(`agent adapter ${adapter.id} has no enforceable version policy`);
  }
  const escaped = policy.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(
    `(?:^|[^0-9A-Za-z.+-])${escaped}(?:$|[^0-9A-Za-z.+-])`,
  );
  if (!token.test(observedVersion)) {
    throw new Error(
      `Agent version ${JSON.stringify(observedVersion)} does not satisfy the pinned adapter version ${policy.value}`,
    );
  }
}

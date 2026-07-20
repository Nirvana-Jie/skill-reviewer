import { join } from "node:path";

import { atomicWriteJson, readJson, sha256File } from "./agent-artifacts.mjs";
import { canonicalJson } from "./agent-digest.mjs";

const RUNTIME_BINDING_CONTRACT = "skill-reviewer.agent-runtime-binding";

export function bindAgentRuntime({
  workspace,
  adapter,
  executable,
  agentVersion,
  environmentNamesDigest,
  timeoutSeconds,
  costLimitUsd,
}) {
  const path = join(workspace, "agent-runtime-binding.json");
  const binding = {
    contract: RUNTIME_BINDING_CONTRACT,
    adapter_id: adapter.id,
    registry_entry_digest: adapter.registry_entry_digest,
    executable_path: executable.path,
    executable_digest: executable.digest,
    agent_version: agentVersion,
    environment_names_digest: environmentNamesDigest,
    timeout_seconds: timeoutSeconds,
    cost_limit_usd: costLimitUsd ?? null,
  };
  try {
    atomicWriteJson(path, binding, { exclusive: true });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = readJson(path, "Agent runtime binding");
    if (canonicalJson(existing) !== canonicalJson(binding)) {
      throw new Error(
        "Agent runtime differs from the immutable binding already used by this run",
      );
    }
  }
  return { path, digest: sha256File(path) };
}

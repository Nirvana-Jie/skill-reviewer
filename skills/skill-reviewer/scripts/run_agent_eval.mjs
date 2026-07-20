#!/usr/bin/env node

import { resolve } from "node:path";

import {
  builtInAgentRegistryPath,
  loadAgentRegistry,
  resolveAgentAdapter,
} from "./lib/agent-registry.mjs";
import {
  AgentInterruptedError,
  runAgentCell,
  runAgentPlan,
} from "./lib/agent-execution.mjs";

function usage() {
  return [
    "Usage:",
    "  run_agent_eval.mjs plan --workspace PATH [options]",
    "  run_agent_eval.mjs cell --workspace PATH --assignment PATH [options]",
    "  run_agent_eval.mjs adapters list",
    "  run_agent_eval.mjs adapters inspect ADAPTER_ID",
    "",
    "Options assert or narrow a locked run; they never replace its adapter or authority:",
    "  --adapter ID  --agent-bin PATH  --timeout-seconds N",
    "  --cost-limit-usd N  --pass-env NAME  --credential-env NAME",
    "  --max-workers N",
  ].join("\n");
}

function parseArgs(argv) {
  let [command, subcommand, ...rest] = argv;
  if (!command) throw new Error(usage());
  if (command.startsWith("--")) {
    const inferred = argv.includes("--assignment") ? "cell" : "plan";
    rest = argv;
    subcommand = undefined;
    command = inferred;
  }
  if (command === "adapters") {
    return { command, subcommand, rest };
  }
  const values = {
    command,
    passEnv: [],
    credentialEnv: [],
  };
  const tokens = [subcommand, ...rest].filter((value) => value !== undefined);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = () => {
      index += 1;
      if (index >= tokens.length) throw new Error(`${token} requires a value`);
      return tokens[index];
    };
    if (token === "--workspace") values.workspace = resolve(next());
    else if (token === "--assignment") values.assignment = resolve(next());
    else if (token === "--adapter") values.assertAdapterId = next();
    else if (token === "--agent-bin") values.agentBin = next();
    else if (token === "--timeout-seconds") values.timeoutSeconds = Number(next());
    else if (token === "--cost-limit-usd") values.costLimitUsd = Number(next());
    else if (token === "--max-workers") values.maxWorkers = Number(next());
    else if (token === "--batch-id") values.batchId = next();
    else if (token === "--pass-env") values.passEnv.push(next());
    else if (token === "--credential-env") values.credentialEnv.push(next());
    else throw new Error(`unknown option: ${token}`);
  }
  if (
    values.timeoutSeconds !== undefined &&
    (!Number.isInteger(values.timeoutSeconds) || values.timeoutSeconds < 1)
  ) {
    throw new Error("--timeout-seconds must be a positive integer");
  }
  if (
    values.maxWorkers !== undefined &&
    (!Number.isInteger(values.maxWorkers) || values.maxWorkers < 1)
  ) {
    throw new Error("--max-workers must be a positive integer");
  }
  if (
    values.costLimitUsd !== undefined &&
    (!Number.isFinite(values.costLimitUsd) || values.costLimitUsd < 0)
  ) {
    throw new Error("--cost-limit-usd must be a non-negative number");
  }
  if (!values.workspace) throw new Error("--workspace is required");
  if (command === "cell" && !values.assignment) throw new Error("--assignment is required");
  if (!["cell", "plan"].includes(command)) throw new Error(`unknown command: ${command}`);
  return values;
}

function adapterCommand(parsed) {
  const registry = loadAgentRegistry({ registryPath: builtInAgentRegistryPath });
  if (parsed.subcommand === "list") {
    return {
      contract: registry.contract,
      registry_digest: registry.registry_digest,
      adapters: registry.adapters.map((entry) => ({
        id: entry.id,
        source_agent: entry.source_agent,
        source_format: entry.source_format.id,
        contract_version: entry.source_format.contract_version,
        stability: entry.source_format.stability,
        execution: entry.implementation.execution,
        maturity: entry.implementation.maturity,
        evidence_authority: entry.evidence_authority,
        executable_version: entry.runtime?.version_policy?.value ?? null,
      })),
    };
  }
  if (parsed.subcommand === "inspect") {
    const adapterId = parsed.rest[0];
    if (!adapterId) throw new Error("adapters inspect requires an adapter id");
    return resolveAgentAdapter(registry, adapterId);
  }
  throw new Error("adapters requires list or inspect");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const parsed = parseArgs(argv);
  if (parsed.command === "adapters") {
    console.log(JSON.stringify(adapterCommand(parsed), null, 2));
    return 0;
  }
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
  };
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  try {
    const input = { ...parsed, signal: controller.signal };
    delete input.command;
    const result = parsed.command === "cell"
      ? await runAgentCell(input)
      : await runAgentPlan(input);
    if (controller.signal.aborted) throw new AgentInterruptedError("Agent execution interrupted");
    console.log(JSON.stringify(result));
    return result.status === "completed" ? 0 : 1;
  } finally {
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof AgentInterruptedError) {
    console.error(JSON.stringify({ error: "Agent execution interrupted" }));
    process.exitCode = 130;
  } else {
    console.error(JSON.stringify({ error: String(error.message ?? error) }));
    process.exitCode = 2;
  }
}

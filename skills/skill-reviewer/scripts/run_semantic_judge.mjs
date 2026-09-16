#!/usr/bin/env node

/**
 * Produce blind, order-swapped `semantic_pair` judgments for a locked run.
 *
 * The judge Agent sees only the frozen rubric and two anonymous bundles; this
 * runner owns the arm mapping, binds the judgment to the run, and re-grades
 * the written artifact in-process so the printed summary matches `grade`.
 */

import { resolve } from "node:path";

import {
  AgentInterruptedError,
  runSemanticJudge,
} from "./lib/agent-semantic-judge.mjs";

function usage() {
  return [
    "Usage:",
    "  run_semantic_judge.mjs --workspace PATH [options]",
    "",
    "Options narrow or bind the judge; they never change the locked plan:",
    "  --adapter ID          judge adapter (default: the locked worker adapter)",
    "  --agent-bin PATH      judge executable (default: adapter default)",
    "  --case ID             judge only this case (repeatable)",
    "  --cost-limit-usd N    per-judgment budget when the adapter supports it",
    "  --timeout-seconds N   per-judgment timeout (default 300)",
    "  --pass-env NAME       pass one ordinary environment value (repeatable)",
    "  --credential-env NAME pass one credential value, redacted on retention (repeatable)",
    "",
    "Exit codes: 0 every semantic assertion was judged (agreement or disagreement);",
    "  1 at least one assertion was skipped or malformed (see results[].reason);",
    "  2 refused before any judgment; 130 interrupted.",
  ].join("\n");
}

function parseArgs(argv) {
  const values = { caseIds: [], passEnv: [], credentialEnv: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${token} requires a value`);
      return argv[index];
    };
    if (token === "--workspace") values.workspace = resolve(next());
    else if (token === "--adapter") values.adapterId = next();
    else if (token === "--agent-bin") values.agentBin = next();
    else if (token === "--case") values.caseIds.push(next());
    else if (token === "--cost-limit-usd") values.costLimitUsd = Number(next());
    else if (token === "--timeout-seconds") values.timeoutSeconds = Number(next());
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
    values.costLimitUsd !== undefined &&
    (!Number.isFinite(values.costLimitUsd) || values.costLimitUsd < 0)
  ) {
    throw new Error("--cost-limit-usd must be a non-negative number");
  }
  if (!values.workspace) throw new Error("--workspace is required");
  return values;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const parsed = parseArgs(argv);
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
  };
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  try {
    const summary = await runSemanticJudge({ ...parsed, signal: controller.signal });
    if (controller.signal.aborted) throw new AgentInterruptedError("semantic judge interrupted");
    console.log(JSON.stringify(summary));
    return summary.status === "completed" ? 0 : 1;
  } finally {
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof AgentInterruptedError) {
    console.error(JSON.stringify({ error: "semantic judge interrupted" }));
    process.exitCode = 130;
  } else {
    console.error(JSON.stringify({ error: String(error.message ?? error) }));
    process.exitCode = 2;
  }
}

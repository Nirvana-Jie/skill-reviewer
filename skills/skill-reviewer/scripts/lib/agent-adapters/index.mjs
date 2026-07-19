import { adapter as claudeStreamJson } from "./claude-stream-json.mjs";
import { adapter as codexExecJsonl } from "./codex-exec-jsonl.mjs";

const implementations = new Map([
  [codexExecJsonl.id, codexExecJsonl],
  [claudeStreamJson.id, claudeStreamJson],
]);

export function resolveAgentImplementation(adapterId) {
  const implementation = implementations.get(adapterId);
  if (!implementation) {
    throw new Error(`agent adapter implementation is unavailable: ${adapterId}`);
  }
  return implementation;
}

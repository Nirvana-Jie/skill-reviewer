import {
  DETERMINISTIC_ASSERTION_TYPES,
  SEMANTIC_ASSERTION_TYPES,
} from "./skill-eval-contracts.mjs";

export function declaredAssertionArtifacts(evalCase) {
  const artifacts = [];
  for (const assertion of evalCase.assertions ?? []) {
    const values = DETERMINISTIC_ASSERTION_TYPES.has(assertion.type)
      ? [String(assertion.artifact)]
      : SEMANTIC_ASSERTION_TYPES.has(assertion.type)
        ? (assertion.inputs ?? []).map(String)
        : [];
    for (const artifact of values) {
      if (!artifacts.includes(artifact)) artifacts.push(artifact);
    }
  }
  return artifacts;
}

export function buildArtifactOwnership(evalCase, executionProfile) {
  const framework = new Map([
    ["execution.json", "framework_execution"],
    ["dispatch-receipt.json", "framework_dispatch"],
    ["agent-trace.jsonl", "framework_trace"],
  ]);
  const source = executionProfile.trace?.source;
  if (source && typeof source.artifact === "string") {
    framework.set(source.artifact, "provider_source_trace");
  }
  const declared = declaredAssertionArtifacts(evalCase);
  return {
    worker: declared.filter((artifact) => !framework.has(artifact)),
    framework: [...framework.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([artifact, role]) => ({ artifact, role })),
    asserted_framework: declared.filter((artifact) => framework.has(artifact)),
  };
}

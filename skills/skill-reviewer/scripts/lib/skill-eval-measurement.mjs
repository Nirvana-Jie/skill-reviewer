export const TEXT_ASSERTION_TYPES = new Set([
  "text_contains",
  "text_not_contains",
  "text_matches",
  "text_not_matches",
]);
export const CALIBRATION_FIELDS = new Set(["pass_examples", "fail_examples"]);
export const PORTABLE_REGEX_CONTRACT = "skill-reviewer.ecmascript-regexp-subset.v1";

export function repeatMetricValue(record, metric) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const metrics = record.metrics;
  const value = metric === "required_pass_rate"
    ? record.required_pass_rate
    : metrics !== null && typeof metrics === "object" && !Array.isArray(metrics)
      ? metrics[metric]
      : null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function pairedRepeatMetrics({ candidate, baseline, metric }) {
  const candidateRepeats = Array.isArray(candidate?.repeats) ? candidate.repeats : [];
  const baselineRepeats = Array.isArray(baseline?.repeats) ? baseline.repeats : [];
  if (candidateRepeats.length === 0 || candidateRepeats.length !== baselineRepeats.length) {
    return null;
  }
  const baselineByRepeat = new Map();
  for (const record of baselineRepeats) {
    if (
      record === null || typeof record !== "object" || Array.isArray(record)
      || !Number.isInteger(record.repeat) || baselineByRepeat.has(record.repeat)
    ) return null;
    baselineByRepeat.set(record.repeat, record);
  }
  const seenCandidateRepeats = new Set();
  const pairs = [];
  for (const record of candidateRepeats) {
    if (
      record === null || typeof record !== "object" || Array.isArray(record)
      || !Number.isInteger(record.repeat) || seenCandidateRepeats.has(record.repeat)
    ) return null;
    seenCandidateRepeats.add(record.repeat);
    const baselineRecord = baselineByRepeat.get(record.repeat);
    const candidateValue = repeatMetricValue(record, metric);
    const baselineValue = repeatMetricValue(baselineRecord, metric);
    if (candidateValue === null || baselineValue === null) return null;
    pairs.push({ repeat: record.repeat, candidate: candidateValue, baseline: baselineValue });
  }
  if (seenCandidateRepeats.size !== baselineByRepeat.size) return null;
  return pairs.sort((left, right) => left.repeat - right.repeat);
}

function rejectNonPortableEscapes(source) {
  const unsupported = new Set(["A", "Z", "w", "W", "d", "D", "b", "B", "U", "N", "p", "P", "c", "k"]);
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\\") continue;
    let slashCount = 1;
    while (source[index + slashCount] === "\\") slashCount += 1;
    if (slashCount % 2 === 1) {
      const escaped = source[index + slashCount];
      if (unsupported.has(escaped) || /[1-9]/.test(escaped ?? "")) {
        throw new Error(`non-portable escape \\${escaped} is not supported`);
      }
    }
    index += slashCount - 1;
  }
}

export function compilePortableRegex(pattern, baseFlags = "") {
  const inline = /^\(\?([ims]+)\)/.exec(pattern);
  const source = inline ? pattern.slice(inline[0].length) : pattern;
  if (/\(\?(?:P[<=]|<|>|\(|#|[ims]+[:)])/.test(source)) {
    throw new Error("non-portable group or inline-flag construct is not supported");
  }
  rejectNonPortableEscapes(source);
  const flags = new Set(baseFlags);
  for (const flag of inline?.[1] ?? "") flags.add(flag);
  return new RegExp(source, [...flags].join(""));
}

export function evaluateTextAssertion(assertion, content) {
  if (["text_contains", "text_not_contains"].includes(assertion.type)) {
    const expected = typeof assertion.expected === "string"
      ? [assertion.expected]
      : assertion.expected;
    if (!Array.isArray(expected) || expected.some((value) => typeof value !== "string")) {
      throw new Error("expected must be a string or string array");
    }
    if (assertion.type === "text_contains") {
      return expected.every((value) => content.includes(value));
    }
    return !expected.some((value) => content.includes(value));
  }
  if (["text_matches", "text_not_matches"].includes(assertion.type)) {
    if (typeof assertion.pattern !== "string" || assertion.pattern === "") {
      throw new Error("pattern must be a non-empty string");
    }
    const matched = compilePortableRegex(assertion.pattern, "m").test(content);
    return assertion.type === "text_matches" ? matched : !matched;
  }
  throw new Error(`unsupported text assertion type: ${assertion.type}`);
}

export function calibrateAssertion(assertion) {
  const assertionId = String(assertion.id ?? "");
  const empty = {
    assertion_id: assertionId,
    pass_example_count: 0,
    fail_example_count: 0,
    failed_pass_examples: [],
    failed_fail_examples: [],
  };
  if (!TEXT_ASSERTION_TYPES.has(assertion.type)) {
    return { ...empty, status: "not_applicable" };
  }
  if (!assertion.calibration || typeof assertion.calibration !== "object" || Array.isArray(assertion.calibration)) {
    return { ...empty, status: "unverified" };
  }
  const passExamples = assertion.calibration.pass_examples ?? [];
  const failExamples = assertion.calibration.fail_examples ?? [];
  const failedPass = passExamples
    .map((example, index) => evaluateTextAssertion(assertion, example) ? null : index)
    .filter((index) => index !== null);
  const failedFail = failExamples
    .map((example, index) => evaluateTextAssertion(assertion, example) ? index : null)
    .filter((index) => index !== null);
  return {
    assertion_id: assertionId,
    status: failedPass.length > 0 || failedFail.length > 0 ? "invalid" : "valid",
    pass_example_count: passExamples.length,
    fail_example_count: failExamples.length,
    failed_pass_examples: failedPass,
    failed_fail_examples: failedFail,
  };
}

export function assessOracle(assertions) {
  const checks = assertions
    .filter((assertion) => (assertion.severity ?? "must_pass") === "must_pass")
    .filter((assertion) => TEXT_ASSERTION_TYPES.has(assertion.type))
    .map(calibrateAssertion);
  const status = checks.some((check) => check.status === "invalid")
    ? "invalid"
    : checks.some((check) => check.status === "unverified")
      ? "unverified"
      : "valid";
  const reasons = checks.flatMap((check) => {
    if (check.status === "invalid") return [`assertion_calibration_failed:${check.assertion_id}`];
    if (check.status === "unverified") return [`assertion_calibration_missing:${check.assertion_id}`];
    return [];
  });
  return {
    status,
    required_text_assertions: checks.length,
    calibrated_text_assertions: checks.filter((check) => check.status === "valid").length,
    checks,
    reasons,
  };
}

export function normalizeSampling(raw, { legacyRepeats, determinism }) {
  if (raw === null || raw === undefined) {
    return { repeats: legacyRepeats, pairing: "paired", source: "legacy-determinism" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("sampling must be an object");
  const unknown = Object.keys(raw).filter((key) => !["repeats", "pairing"].includes(key)).sort();
  if (unknown.length > 0) {
    throw new Error(`sampling contains unsupported fields: ${unknown.join(", ")}`);
  }
  if (!Number.isInteger(raw.repeats) || raw.repeats < 1 || raw.repeats > 10) {
    throw new Error("sampling.repeats must be an integer from 1 to 10");
  }
  const pairing = raw.pairing ?? "paired";
  if (pairing !== "paired") throw new Error("sampling.pairing must be paired");
  if (determinism === "stochastic" && raw.repeats < 3) {
    throw new Error("stochastic evals require at least three sampling repeats");
  }
  return { repeats: raw.repeats, pairing, source: "explicit" };
}

export function assessRuntimeMeasurement({ oracle, sampling, directionDisagreement }) {
  const oracleStatus = String(oracle.status ?? "unverified");
  const reasons = [...(oracle.reasons ?? [])];
  const status = oracleStatus === "invalid"
    ? "invalid"
    : oracleStatus === "valid"
      ? "valid"
      : "unverified";
  return {
    status,
    oracle,
    sampling: {
      status: "valid",
      repeats: sampling.repeats,
      pairing: sampling.pairing,
      source: sampling.source,
      direction_disagreement: directionDisagreement,
    },
    reasons: [...new Set(reasons.map(String))].sort(),
  };
}

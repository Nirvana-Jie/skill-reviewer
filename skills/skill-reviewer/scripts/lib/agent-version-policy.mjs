/**
 * Pure Agent executable version policy helpers.
 *
 * Two policy shapes are supported:
 *   { kind: "exact-token", value: "1.2.3" }
 *   { kind: "compatible-range", canary_verified: "1.2.3", minimum: "1.2.3", maximum_exclusive: "2.0.0" }
 *
 * A `--version` line must contain exactly one distinct strict semantic-version
 * token. Prerelease and build suffixes (1.2.3-beta.1, 1.2.3+local) and tokens
 * glued to other identifier characters (v1.2.3) are rejected so a near-match
 * can never be mistaken for the verified release, and a line carrying two
 * different release tokens fails closed instead of being guessed.
 */

const STRICT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const VERSION_TOKEN = /(?<![0-9A-Za-z.+-])((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?![0-9A-Za-z.+-])/;

export const VERSION_POLICY_KINDS = Object.freeze(["exact-token", "compatible-range"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when `value` is a strict `MAJOR.MINOR.PATCH` release string. */
export function isStrictSemver(value) {
  return typeof value === "string" && STRICT_SEMVER.test(value);
}

/** Compare two strict semver strings numerically: -1, 0, or 1. */
export function compareSemver(left, right) {
  if (!isStrictSemver(left) || !isStrictSemver(right)) {
    throw new Error("compareSemver requires strict MAJOR.MINOR.PATCH strings");
  }
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/** Extract every distinct strict semver token from a `--version` line. */
export function extractSemverTokens(line) {
  if (typeof line !== "string") return [];
  const pattern = new RegExp(VERSION_TOKEN.source, "g");
  const tokens = [];
  for (const match of line.matchAll(pattern)) {
    if (!tokens.includes(match[1])) tokens.push(match[1]);
  }
  return tokens;
}

/**
 * Extract the single strict semver token from a `--version` line.
 * Returns null when the line carries no acceptable release token or more
 * than one distinct token.
 */
export function extractSemverToken(line) {
  const tokens = extractSemverTokens(line);
  return tokens.length === 1 ? tokens[0] : null;
}

/** Validate a registry version policy and return a frozen normalized copy. */
export function parseVersionPolicy(policy, label = "version_policy") {
  if (!isPlainObject(policy)) throw new Error(`${label} must be an object`);
  if (policy.kind === "exact-token") {
    if (!isStrictSemver(policy.value)) {
      throw new Error(`${label}.value must be a strict MAJOR.MINOR.PATCH version`);
    }
    return Object.freeze({ kind: "exact-token", value: policy.value });
  }
  if (policy.kind === "compatible-range") {
    for (const field of ["canary_verified", "minimum", "maximum_exclusive"]) {
      if (!isStrictSemver(policy[field])) {
        throw new Error(`${label}.${field} must be a strict MAJOR.MINOR.PATCH version`);
      }
    }
    if (compareSemver(policy.minimum, policy.maximum_exclusive) >= 0) {
      throw new Error(`${label}.minimum must be lower than maximum_exclusive`);
    }
    if (
      compareSemver(policy.canary_verified, policy.minimum) < 0
      || compareSemver(policy.canary_verified, policy.maximum_exclusive) >= 0
    ) {
      throw new Error(`${label}.canary_verified must lie inside the compatible range`);
    }
    return Object.freeze({
      kind: "compatible-range",
      canary_verified: policy.canary_verified,
      minimum: policy.minimum,
      maximum_exclusive: policy.maximum_exclusive,
    });
  }
  throw new Error(`${label}.kind must be one of ${VERSION_POLICY_KINDS.join(", ")}`);
}

/** The version that was verified by a real canary under this policy. */
export function canaryVerifiedVersion(policy) {
  const parsed = parseVersionPolicy(policy);
  return parsed.kind === "exact-token" ? parsed.value : parsed.canary_verified;
}

/** Human-readable description used in failure messages. */
export function describeVersionPolicy(policy) {
  const parsed = parseVersionPolicy(policy);
  if (parsed.kind === "exact-token") return `exact version ${parsed.value}`;
  return `compatible range [${parsed.minimum}, ${parsed.maximum_exclusive}) canary-verified ${parsed.canary_verified}`;
}

/**
 * Evaluate an observed `--version` line against a policy.
 *
 * Returns { satisfied, observed, canary_verified, drifted, reason }.
 * `observed` is the extracted strict token or null; `drifted` is true only
 * when the policy is satisfied by a version other than the canary-verified one.
 */
export function evaluateVersionPolicy(policy, observedLine) {
  const parsed = parseVersionPolicy(policy);
  const canary = canaryVerifiedVersion(parsed);
  const tokens = extractSemverTokens(observedLine);
  if (tokens.length > 1) {
    return {
      satisfied: false,
      observed: null,
      canary_verified: canary,
      drifted: false,
      reason: `multiple distinct release tokens were observed (${tokens.join(", ")}); the Agent must report exactly one`,
    };
  }
  const observed = extractSemverToken(observedLine);
  if (observed === null) {
    return {
      satisfied: false,
      observed: null,
      canary_verified: canary,
      drifted: false,
      reason: "no strict MAJOR.MINOR.PATCH release token was observed",
    };
  }
  let satisfied;
  if (parsed.kind === "exact-token") {
    satisfied = observed === parsed.value;
  } else {
    satisfied =
      compareSemver(observed, parsed.minimum) >= 0
      && compareSemver(observed, parsed.maximum_exclusive) < 0;
  }
  return {
    satisfied,
    observed,
    canary_verified: canary,
    drifted: satisfied && observed !== canary,
    reason: satisfied ? null : `observed ${observed} is outside the ${describeVersionPolicy(parsed)}`,
  };
}

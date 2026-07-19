import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CANONICAL_JSON_CONTRACT, canonicalJson } from "./agent-digest.mjs";
import {
  ASSIGNMENT_CONTRACT,
  DETERMINISTIC_ASSERTION_TYPES,
  MANIFEST_CONTRACT,
  ManifestError,
  PLAN_CONTRACT,
  RUN_LOCK_CONTRACT,
  SEMANTIC_ASSERTION_TYPES,
} from "./skill-eval-contracts.mjs";
import { buildArtifactOwnership } from "./skill-eval-evidence.mjs";
import {
  CALIBRATION_FIELDS,
  PORTABLE_REGEX_CONTRACT,
  TEXT_ASSERTION_TYPES,
  assessOracle,
  compilePortableRegex,
  evaluateTextAssertion,
  normalizeSampling,
} from "./skill-eval-measurement.mjs";
import { decodeUtf8 } from "./strict-utf8.mjs";

const PATH_SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ASSERTION_TYPES = new Set([
  ...DETERMINISTIC_ASSERTION_TYPES,
  ...SEMANTIC_ASSERTION_TYPES,
]);
const PERMISSION_FIELDS = new Set([
  "network",
  "network_allowlist",
  "external_side_effects",
  "writable_roots",
]);
const MANIFEST_FIELDS = new Set(["contract", "skill_name", "defaults", "evals"]);
const DEFAULT_FIELDS = new Set([
  "permissions",
  "repeats",
  "evolution",
  "case_timeout_seconds",
]);
const REPEAT_FIELDS = new Set(["deterministic", "stochastic"]);
const EVOLUTION_FIELDS = new Set(["max_rounds"]);
const PUBLIC_EVAL_FIELDS = new Set([
  "id",
  "purpose",
  "split",
  "prompt",
  "files",
  "determinism",
  "assertions",
  "objectives",
  "holdout",
  "timeout_seconds",
  "permissions",
  "sampling",
]);
const OPAQUE_EVAL_FIELDS = new Set([
  "id",
  "purpose",
  "split",
  "determinism",
  "holdout",
  "timeout_seconds",
  "permissions",
  "sampling",
]);
const ASSERTION_COMMON_FIELDS = ["id", "type", "artifact", "severity"];
const assertionFields = (...extra) => new Set([...ASSERTION_COMMON_FIELDS, ...extra]);
const ASSERTION_FIELDS = new Map([
  ["file_exists", assertionFields()],
  ["text_contains", assertionFields("expected", "calibration")],
  ["text_not_contains", assertionFields("expected", "calibration")],
  ["text_matches", assertionFields("pattern", "calibration")],
  ["text_not_matches", assertionFields("pattern", "calibration")],
  ["json_path", assertionFields("path", "operator", "expected")],
  ["event_absent", assertionFields("event")],
  ["digest_equals", assertionFields("expected_sha256")],
  ["numeric_range", assertionFields("path", "minimum", "maximum")],
  ["semantic_pair", assertionFields("rubric", "inputs")],
]);
const OBJECTIVE_FIELDS = new Set([
  "id",
  "metric",
  "direction",
  "primary",
  "min_material_delta",
  "non_regression_tolerance",
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireFiniteJson(value, label) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ManifestError(`JSON artifact contains a non-finite number: ${label}`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new ManifestError(`JSON artifact contains an integer outside the safe integer range: ${label}`);
    }
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => requireFiniteJson(item, `${label}[${index}]`));
  } else if (plainObject(value)) {
    Object.entries(value).forEach(([key, item]) => requireFiniteJson(item, `${label}.${key}`));
  }
}

function containsUnsafeIntegerLiteral(text) {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== "-" && (character < "0" || character > "9")) continue;
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (match === null) continue;
    const token = match[0];
    if (!/[.eE]/.test(token)) {
      const integer = BigInt(token);
      if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) {
        return true;
      }
    }
    index += token.length - 1;
  }
  return false;
}

function containsBareNonFiniteLiteral(text) {
  let inString = false;
  let escaped = false;
  const literals = ["-Infinity", "Infinity", "NaN"];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    for (const literal of literals) {
      if (!text.startsWith(literal, index)) continue;
      const before = index === 0 ? "" : text[index - 1];
      const after = text[index + literal.length] ?? "";
      if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) {
        return true;
      }
    }
  }
  return false;
}

export function loadJsonValue(path) {
  let text;
  try {
    text = decodeUtf8(readFileSync(path), `JSON artifact ${path}`);
  } catch (error) {
    if (error.code === "ENOENT") throw new ManifestError(`manifest does not exist: ${path}`);
    if (error.message.includes("is not valid UTF-8")) throw new ManifestError(error.message);
    throw new ManifestError(`JSON artifact is unreadable: ${path}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (containsBareNonFiniteLiteral(text)) {
      throw new ManifestError(`JSON artifact contains a non-finite number: ${path}`);
    }
    throw new ManifestError(`manifest is not valid JSON: ${error.message}`);
  }
  if (containsUnsafeIntegerLiteral(text)) {
    throw new ManifestError(`JSON artifact contains an integer outside the safe integer range: ${path}`);
  }
  requireFiniteJson(value, String(path));
  return value;
}

export function loadJson(path) {
  const value = loadJsonValue(path);
  if (!plainObject(value)) throw new ManifestError("manifest root must be an object");
  return value;
}

export function sha256File(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    throw new ManifestError(`artifact is unreadable: ${path}`);
  }
}

export function sha256Json(value) {
  requireFiniteJson(value, "JSON digest input");
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function sha256RuntimeFile(path) {
  const metadata = statSync(path);
  return sha256Json({
    kind: "file",
    content_sha256: sha256File(path),
    read_execute_bits: metadata.mode & 0o555,
  });
}

export function sha256RuntimeDirectory(path) {
  return sha256Json({
    kind: "directory",
    read_execute_bits: statSync(path).mode & 0o555,
  });
}

export function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ManifestError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function rejectUnsupportedFields(value, allowed, label) {
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unsupported.length > 0) {
    throw new ManifestError(`${label} contains unsupported fields: ${unsupported.join(", ")}`);
  }
}

function isWithin(path, root) {
  const delta = relative(root, path);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

function pathSegments(root, path) {
  const delta = relative(root, path);
  return delta === "" ? [] : delta.split(sep);
}

function lstatMaybe(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function resolveCanonicalPath(path) {
  let existing = resolve(path);
  const suffix = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

export function safeSubjectFile(subjectPath, relativePath, label) {
  const subject = realpathSync(resolve(subjectPath));
  const path = resolve(subject, relativePath);
  if (!isWithin(path, subject)) {
    throw new ManifestError(`${label} escapes the subject directory: ${relativePath}`);
  }
  let current = subject;
  for (const part of pathSegments(subject, path)) {
    current = resolve(current, part);
    const metadata = lstatMaybe(current);
    if (metadata?.isSymbolicLink()) {
      throw new ManifestError(`${label} contains a symbolic link: ${relativePath}`);
    }
  }
  const metadata = lstatMaybe(path);
  if (!metadata?.isFile() || realpathSync(path) !== path) {
    throw new ManifestError(`${label} does not exist: ${relativePath}`);
  }
  if (metadata.nlink !== 1) throw new ManifestError(`${label} must not be hard-linked: ${relativePath}`);
  return path;
}

export function safeArtifact(rootPath, relativePath) {
  const root = resolveCanonicalPath(rootPath);
  if (existsSync(root) && realpathSync(root) !== root) {
    throw new ManifestError(`artifact root is not canonical: ${root}`);
  }
  const path = resolve(root, relativePath);
  if (!isWithin(path, root)) {
    throw new ManifestError(`artifact path escapes its execution root: ${relativePath}`);
  }
  let current = root;
  for (const part of pathSegments(root, path)) {
    current = resolve(current, part);
    const metadata = lstatMaybe(current);
    if (metadata?.isSymbolicLink()) {
      throw new ManifestError(`artifact path contains a symbolic link: ${relativePath}`);
    }
  }
  const metadata = lstatMaybe(path);
  if (metadata) {
    if (realpathSync(path) !== path) throw new ManifestError(`artifact path is not canonical: ${relativePath}`);
    if (metadata.isFile() && metadata.nlink !== 1) {
      throw new ManifestError(`artifact path is hard-linked: ${relativePath}`);
    }
    if (!metadata.isFile() && !metadata.isDirectory()) {
      throw new ManifestError(`artifact path is a special file: ${relativePath}`);
    }
  }
  return path;
}

export function validateArtifactPath(value, label) {
  const path = requireString(value, label).replaceAll("\\", "/");
  if (isAbsolute(path) || path.split("/").includes("..")) {
    throw new ManifestError(`${label} must stay inside its execution root`);
  }
  return path;
}

export function requireNumber(value, label) {
  if (typeof value !== "number") throw new ManifestError(`${label} must be a number`);
  if (!Number.isFinite(value)) throw new ManifestError(`${label} must be finite`);
  return value;
}

export function requireRealDirectory(path, root, label) {
  const resolvedRoot = realpathSync(root);
  const lexical = resolve(path);
  if (!isWithin(lexical, resolvedRoot)) {
    throw new ManifestError(`${label} escapes the run workspace`);
  }
  let current = resolvedRoot;
  for (const part of pathSegments(resolvedRoot, lexical)) {
    current = join(current, part);
    if (lstatMaybe(current)?.isSymbolicLink()) {
      throw new ManifestError(`${label} contains a symbolic link: ${current}`);
    }
  }
  let metadata;
  try {
    metadata = lstatSync(lexical);
  } catch {
    throw new ManifestError(`${label} must be a canonical real directory`);
  }
  if (!metadata.isDirectory() || realpathSync(lexical) !== lexical) {
    throw new ManifestError(`${label} must be a canonical real directory`);
  }
  return lexical;
}

export function traceAssignmentContext({ assignmentPath, workspace }) {
  const resolvedWorkspace = realpathSync(workspace);
  const resolvedAssignmentPath = resolve(assignmentPath);
  const assignment = loadJson(resolvedAssignmentPath);
  if (assignment.contract !== ASSIGNMENT_CONTRACT) {
    throw new ManifestError(`assignment contract must be ${ASSIGNMENT_CONTRACT}`);
  }
  const caseId = requireString(assignment.case_id, "assignment.case_id");
  const arm = requireString(assignment.arm, "assignment.arm");
  const repeat = assignment.repeat;
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new ManifestError("assignment.repeat must be a positive integer");
  }
  const expectedAssignment = safeArtifact(
    resolvedWorkspace,
    `assignments/${caseId}/${arm}/repeat-${repeat}.json`,
  );
  if (realpathSync(resolvedAssignmentPath) !== realpathSync(expectedAssignment)) {
    throw new ManifestError("assignment path does not match its bound identity");
  }
  const repeatRoot = requireRealDirectory(
    join(resolvedWorkspace, "cases", caseId, arm, `repeat-${repeat}`),
    resolvedWorkspace,
    "repeat root",
  );
  const writableRoot = resolve(
    requireString(assignment.writable_root, "assignment.writable_root"),
  );
  if (writableRoot !== repeatRoot) {
    throw new ManifestError("assignment writable_root does not match its repeat root");
  }
  const traceArtifact = validateArtifactPath(
    assignment.trace_artifact,
    "assignment.trace_artifact",
  );
  return { assignment, repeatRoot, tracePath: safeArtifact(repeatRoot, traceArtifact) };
}

export function validateAssertions(assertions, label) {
  if (!Array.isArray(assertions) || assertions.length === 0) {
    throw new ManifestError(`${label} must be a non-empty array`);
  }
  const seen = new Set();
  return assertions.map((rawAssertion, index) => {
    const assertionLabel = `${label}[${index}]`;
    if (!plainObject(rawAssertion)) throw new ManifestError(`${assertionLabel} must be an object`);
    let assertion = { ...rawAssertion };
    const assertionId = requireString(assertion.id, `${assertionLabel}.id`);
    if (seen.has(assertionId)) throw new ManifestError(`duplicate assertion id in ${label}: ${assertionId}`);
    seen.add(assertionId);
    if (!ASSERTION_TYPES.has(assertion.type)) {
      throw new ManifestError(`${assertionLabel} uses unsupported assertion type: ${assertion.type}`);
    }
    rejectUnsupportedFields(assertion, ASSERTION_FIELDS.get(assertion.type), assertionLabel);
    const artifact = validateArtifactPath(assertion.artifact, `${assertionLabel}.artifact`);
    const severity = assertion.severity ?? "must_pass";
    const allowedSeverities = SEMANTIC_ASSERTION_TYPES.has(assertion.type)
      ? ["supplemental"]
      : ["must_pass", "should_pass"];
    if (!allowedSeverities.includes(severity)) {
      throw new ManifestError(`${assertionLabel}.severity must be one of ${JSON.stringify(allowedSeverities.sort())}`);
    }
    if (["text_contains", "text_not_contains"].includes(assertion.type)) {
      const expected = typeof assertion.expected === "string" ? [assertion.expected] : assertion.expected;
      if (!Array.isArray(expected) || expected.length === 0 || expected.some((value) => typeof value !== "string" || value === "")) {
        throw new ManifestError(`${assertionLabel}.expected must be a string or non-empty string array`);
      }
    } else if (["text_matches", "text_not_matches"].includes(assertion.type)) {
      const pattern = requireString(assertion.pattern, `${assertionLabel}.pattern`);
      try {
        compilePortableRegex(pattern);
      } catch (error) {
        throw new ManifestError(`${assertionLabel}.pattern is invalid: ${error.message}`);
      }
    } else if (assertion.type === "json_path") {
      const pointer = requireString(assertion.path, `${assertionLabel}.path`);
      if (pointer !== "" && !pointer.startsWith("/")) {
        throw new ManifestError(`${assertionLabel}.path must be an RFC 6901 JSON Pointer`);
      }
      const operator = assertion.operator ?? "equals";
      if (!["equals", "not_equals", "contains", "exists"].includes(operator)) {
        throw new ManifestError(`${assertionLabel}.operator must be equals, not_equals, contains, or exists`);
      }
      if (operator !== "exists" && !("expected" in assertion)) {
        throw new ManifestError(`${assertionLabel}.expected is required`);
      }
    } else if (assertion.type === "event_absent") {
      requireString(assertion.event, `${assertionLabel}.event`);
    } else if (assertion.type === "digest_equals") {
      const digest = requireString(assertion.expected_sha256, `${assertionLabel}.expected_sha256`);
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        throw new ManifestError(`${assertionLabel}.expected_sha256 must be a lowercase SHA-256 digest`);
      }
    } else if (assertion.type === "numeric_range") {
      if (!("minimum" in assertion) && !("maximum" in assertion)) {
        throw new ManifestError(`${assertionLabel} requires minimum and/or maximum`);
      }
      if ("minimum" in assertion) requireNumber(assertion.minimum, `${assertionLabel}.minimum`);
      if ("maximum" in assertion) requireNumber(assertion.maximum, `${assertionLabel}.maximum`);
      if (assertion.path !== undefined && (typeof assertion.path !== "string" || (assertion.path && !assertion.path.startsWith("/")))) {
        throw new ManifestError(`${assertionLabel}.path must be an RFC 6901 JSON Pointer`);
      }
    } else if (assertion.type === "semantic_pair") {
      const rubric = requireString(assertion.rubric, `${assertionLabel}.rubric`);
      if (!Array.isArray(assertion.inputs) || assertion.inputs.length === 0) {
        throw new ManifestError(`${assertionLabel}.inputs must be a non-empty array`);
      }
      const inputs = assertion.inputs.map((value, inputIndex) =>
        validateArtifactPath(value, `${assertionLabel}.inputs[${inputIndex}]`));
      if (new Set(inputs).size !== inputs.length) throw new ManifestError(`${assertionLabel}.inputs must be unique`);
      assertion = { ...assertion, rubric, inputs };
    }
    if (TEXT_ASSERTION_TYPES.has(assertion.type) && "calibration" in assertion) {
      if (!plainObject(assertion.calibration)) throw new ManifestError(`${assertionLabel}.calibration must be an object`);
      rejectUnsupportedFields(assertion.calibration, CALIBRATION_FIELDS, `${assertionLabel}.calibration`);
      const calibration = {};
      for (const field of ["pass_examples", "fail_examples"]) {
        const examples = assertion.calibration[field];
        if (!Array.isArray(examples) || examples.length === 0 || examples.some((example) => typeof example !== "string" || example === "")) {
          throw new ManifestError(`${assertionLabel}.calibration.${field} must be a non-empty string array`);
        }
        calibration[field] = [...examples];
      }
      assertion = { ...assertion, calibration };
      const failedPass = calibration.pass_examples
        .map((example, exampleIndex) => evaluateTextAssertion(assertion, example) ? null : exampleIndex)
        .filter((value) => value !== null);
      const failedFail = calibration.fail_examples
        .map((example, exampleIndex) => evaluateTextAssertion(assertion, example) ? exampleIndex : null)
        .filter((value) => value !== null);
      if (failedPass.length > 0 || failedFail.length > 0) {
        const failures = [
          ...failedPass.map((value) => `pass_examples[${value}]`),
          ...failedFail.map((value) => `fail_examples[${value}]`),
        ];
        throw new ManifestError(`${assertionLabel}.calibration failed the declared predicate: ${failures.join(", ")}`);
      }
    }
    return { ...assertion, artifact, severity };
  });
}

export function validateObjectives(objectives, label) {
  if (!Array.isArray(objectives) || objectives.length === 0) {
    throw new ManifestError(`${label} must be a non-empty array`);
  }
  const seen = new Set();
  return objectives.map((objective, index) => {
    const objectiveLabel = `${label}[${index}]`;
    if (!plainObject(objective)) throw new ManifestError(`${objectiveLabel} must be an object`);
    rejectUnsupportedFields(objective, OBJECTIVE_FIELDS, objectiveLabel);
    const id = requireString(objective.id, `${objectiveLabel}.id`);
    if (seen.has(id)) throw new ManifestError(`duplicate objective id in ${label}: ${id}`);
    seen.add(id);
    const metric = requireString(objective.metric, `${objectiveLabel}.metric`);
    if (!/^[a-z][a-z0-9_]*$/.test(metric)) throw new ManifestError(`${objectiveLabel}.metric must be snake_case`);
    if (!["maximize", "minimize"].includes(objective.direction)) {
      throw new ManifestError(`${objectiveLabel}.direction must be maximize or minimize`);
    }
    const material = requireNumber(objective.min_material_delta ?? 0, `${objectiveLabel}.min_material_delta`);
    const tolerance = requireNumber(objective.non_regression_tolerance ?? 0, `${objectiveLabel}.non_regression_tolerance`);
    if (material < 0 || tolerance < 0) {
      throw new ManifestError(`${objectiveLabel} deltas and tolerances must be non-negative`);
    }
    const primary = objective.primary ?? true;
    if (typeof primary !== "boolean") throw new ManifestError(`${objectiveLabel}.primary must be boolean`);
    if (primary && material <= 0) {
      throw new ManifestError(`${objectiveLabel}.min_material_delta must be greater than zero for a primary objective`);
    }
    return {
      ...objective,
      id,
      metric,
      direction: objective.direction,
      primary,
      min_material_delta: material,
      non_regression_tolerance: tolerance,
    };
  });
}

function normalizePermissions(raw, label, inherited = {}) {
  rejectUnsupportedFields(raw, PERMISSION_FIELDS, label);
  const merged = { ...inherited, ...raw };
  if (!["deny", "allowlist"].includes(merged.network)) {
    throw new ManifestError(`${label}.network must be deny or allowlist`);
  }
  if ((merged.external_side_effects ?? "deny") !== "deny") {
    throw new ManifestError(`${label}.external_side_effects must remain deny`);
  }
  if (!Array.isArray(merged.writable_roots) || merged.writable_roots.length === 0) {
    throw new ManifestError(`${label}.writable_roots must be a non-empty array`);
  }
  const normalized = {
    network: merged.network,
    external_side_effects: "deny",
    writable_roots: merged.writable_roots.map((root, index) =>
      validateArtifactPath(root, `${label}.writable_roots[${index}]`)),
  };
  if (merged.network === "allowlist") {
    if (!Array.isArray(merged.network_allowlist) || merged.network_allowlist.length === 0 || merged.network_allowlist.some((value) => typeof value !== "string" || value.trim() === "")) {
      throw new ManifestError(`${label}.network_allowlist must be a non-empty string array when network is allowlist`);
    }
    normalized.network_allowlist = [...merged.network_allowlist];
  } else if ("network_allowlist" in raw) {
    throw new ManifestError(`${label}.network_allowlist is allowed only when network is allowlist`);
  }
  return normalized;
}

export function validateManifest(manifest, subjectPath) {
  rejectUnsupportedFields(manifest, MANIFEST_FIELDS, "manifest");
  if (manifest.contract !== MANIFEST_CONTRACT) throw new ManifestError(`contract must be ${MANIFEST_CONTRACT}`);
  requireString(manifest.skill_name, "skill_name");
  if (!plainObject(manifest.defaults)) throw new ManifestError("defaults must be an object");
  rejectUnsupportedFields(manifest.defaults, DEFAULT_FIELDS, "defaults");
  const repeats = manifest.defaults.repeats;
  if (!plainObject(repeats)) throw new ManifestError("defaults.repeats must be an object");
  rejectUnsupportedFields(repeats, REPEAT_FIELDS, "defaults.repeats");
  for (const [key, expected] of [["deterministic", 1], ["stochastic", 3]]) {
    if (!Number.isInteger(repeats[key]) || repeats[key] < 1) {
      throw new ManifestError(`defaults.repeats.${key} must be a positive integer`);
    }
    if (repeats[key] !== expected) throw new ManifestError(`defaults.repeats.${key} must be ${expected}`);
  }
  if (!plainObject(manifest.defaults.evolution)) throw new ManifestError("defaults.evolution must be an object");
  rejectUnsupportedFields(manifest.defaults.evolution, EVOLUTION_FIELDS, "defaults.evolution");
  if (manifest.defaults.evolution.max_rounds !== 3) throw new ManifestError("defaults.evolution.max_rounds must be 3");
  const defaultTimeout = manifest.defaults.case_timeout_seconds;
  if (!Number.isInteger(defaultTimeout) || defaultTimeout <= 0) {
    throw new ManifestError("defaults.case_timeout_seconds must be a positive integer");
  }
  if (!plainObject(manifest.defaults.permissions)) throw new ManifestError("defaults.permissions must be an object");
  const permissions = normalizePermissions(manifest.defaults.permissions, "defaults.permissions");
  if (!Array.isArray(manifest.evals) || manifest.evals.length === 0) {
    throw new ManifestError("evals must be a non-empty array");
  }
  const subject = realpathSync(resolve(subjectPath));
  const seen = new Set();
  return manifest.evals.map((rawItem, index) => {
    const label = `evals[${index}]`;
    if (!plainObject(rawItem)) throw new ManifestError(`${label} must be an object`);
    const item = { ...rawItem };
    const id = requireString(item.id, `${label}.id`);
    if (!PATH_SAFE_SLUG.test(id)) throw new ManifestError(`${label}.id must be a path-safe lowercase kebab-case slug`);
    if (seen.has(id)) throw new ManifestError(`duplicate eval id: ${id}`);
    seen.add(id);
    if (!["development", "selection", "audit"].includes(item.split)) {
      throw new ManifestError(`${label}.split must be development, selection, or audit`);
    }
    if (!["deterministic", "stochastic"].includes(item.determinism)) {
      throw new ManifestError(`${label}.determinism must be deterministic or stochastic`);
    }
    let sampling;
    try {
      sampling = normalizeSampling(item.sampling, {
        legacyRepeats: repeats[item.determinism],
        determinism: item.determinism,
      });
    } catch (error) {
      throw new ManifestError(`${label}.${error.message}`);
    }
    requireString(item.purpose, `${label}.purpose`);
    const rawHoldout = item.holdout ?? { visibility: "public" };
    if (!plainObject(rawHoldout)) throw new ManifestError(`${label}.holdout must be an object`);
    const holdoutUnknown = Object.keys(rawHoldout).filter((key) => !["visibility", "asset_id"].includes(key)).sort();
    if (holdoutUnknown.length > 0) throw new ManifestError(`${label}.holdout contains unsupported fields: ${holdoutUnknown.join(", ")}`);
    const visibility = rawHoldout.visibility ?? "public";
    if (!["public", "opaque"].includes(visibility)) throw new ManifestError(`${label}.holdout.visibility must be public or opaque`);
    let holdout;
    let prompt;
    let files;
    let assertions;
    let objectives;
    if (visibility === "opaque") {
      if (item.split !== "audit") throw new ManifestError(`${label}.holdout.visibility opaque is allowed only for audit`);
      const exposed = ["prompt", "files", "assertions", "objectives"].filter((key) => key in item).sort();
      if (exposed.length > 0) throw new ManifestError(`${label} opaque audit must not expose oracle fields: ${exposed.join(", ")}`);
      rejectUnsupportedFields(item, OPAQUE_EVAL_FIELDS, label);
      const assetId = requireString(rawHoldout.asset_id, `${label}.holdout.asset_id`);
      if (!PATH_SAFE_SLUG.test(assetId)) throw new ManifestError(`${label}.holdout.asset_id must be a path-safe lowercase kebab-case slug`);
      holdout = { visibility: "opaque", asset_id: assetId };
      files = [];
      assertions = [];
      objectives = [];
    } else {
      rejectUnsupportedFields(item, PUBLIC_EVAL_FIELDS, label);
      if ("asset_id" in rawHoldout) throw new ManifestError(`${label}.holdout.asset_id is allowed only for opaque holdout`);
      holdout = { visibility: "public", asset_id: null };
      prompt = requireString(item.prompt, `${label}.prompt`);
      if (!Array.isArray(item.files ?? []) || (item.files ?? []).some((value) => typeof value !== "string")) {
        throw new ManifestError(`${label}.files must be an array of paths`);
      }
      const normalizedFiles = (item.files ?? []).map((value, fileIndex) => validateArtifactPath(value, `${label}.files[${fileIndex}]`));
      if (new Set(normalizedFiles).size !== normalizedFiles.length) throw new ManifestError(`${label}.files must be unique`);
      files = normalizedFiles.map((path) => ({
        path,
        digest: sha256RuntimeFile(safeSubjectFile(subject, path, `${label}.files`)),
      }));
      assertions = validateAssertions(item.assertions, `${label}.assertions`);
      if (!assertions.some((assertion) => DETERMINISTIC_ASSERTION_TYPES.has(assertion.type) && assertion.severity === "must_pass")) {
        throw new ManifestError(`${label}.assertions requires at least one deterministic must_pass assertion`);
      }
      objectives = validateObjectives(item.objectives, `${label}.objectives`);
    }
    const oracle = assessOracle(assertions);
    if (["selection", "audit"].includes(item.split) && visibility === "public" && oracle.status !== "valid") {
      throw new ManifestError(`${label}.assertions must calibrate every must_pass text predicate before ${item.split}: ${oracle.reasons.join(", ")}`);
    }
    const timeout = item.timeout_seconds ?? defaultTimeout;
    if (!Number.isInteger(timeout) || timeout <= 0) throw new ManifestError(`${label}.timeout_seconds must be a positive integer`);
    const itemPermissions = item.permissions ?? {};
    if (!plainObject(itemPermissions)) throw new ManifestError(`${label}.permissions must be an object`);
    return {
      ...item,
      ...(prompt === undefined ? {} : { prompt }),
      files,
      holdout,
      assertions,
      objectives,
      sampling,
      oracle,
      repeats: sampling.repeats,
      timeout_seconds: timeout,
      permissions: normalizePermissions(itemPermissions, `${label}.permissions`, permissions),
    };
  });
}

export function pathExists(path) {
  return existsSync(path);
}

const RUNTIME_SKILL_ENTRIES = ["SKILL.md", "references", "scripts", "assets"];
const EXECUTION_PROFILE_FIELDS = new Set([
  "adapter_id",
  "target",
  "harness",
  "dispatch_observation",
  "trace",
  "capabilities",
  "isolation",
  "sampling",
]);
const EXECUTION_PROFILE_TRACE_FIELDS = new Set(["capture_source", "source"]);
const EXECUTION_PROFILE_SOURCE_FIELDS = new Set(["artifact", "format"]);
const DISPATCH_OBSERVATIONS = new Set(["host_dispatch", "process_spawn", "external_harness"]);
const TRACE_CAPTURE_SOURCE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const AGENT_ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{2,127}$/;
const SCRIPTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ADAPTER_REGISTRY_PATH = resolve(SCRIPTS_ROOT, "..", "assets", "agent-adapter-registry.json");

function loadRegisteredAgentAdapter(adapterId) {
  const registry = loadJson(AGENT_ADAPTER_REGISTRY_PATH);
  if (registry.contract !== "skill-reviewer.agent-adapter-registry" || registry.schema_version !== "1.0.0") {
    throw new ManifestError("bundled agent adapter registry contract is invalid");
  }
  if (!Array.isArray(registry.adapters)) throw new ManifestError("bundled agent adapter registry is invalid");
  const matches = registry.adapters.filter((entry) => plainObject(entry) && entry.id === adapterId);
  if (matches.length !== 1) throw new ManifestError(`unknown or duplicate agent adapter: ${adapterId}`);
  const entry = matches[0];
  if (!plainObject(entry.implementation) || entry.implementation.execution !== "implemented" || !plainObject(entry.profile)) {
    throw new ManifestError(`agent adapter is not implemented for execution: ${adapterId}`);
  }
  return entry;
}

function registeredProfileString(raw, field, registered) {
  const label = `execution_profile.${field}`;
  const expected = requireString(registered[field], `registered adapter ${field}`);
  if (!(field in raw)) return expected;
  const provided = requireString(raw[field], label);
  if (provided !== expected) throw new ManifestError(`${label} does not match the registered agent adapter`);
  return provided;
}

export function pathIsWithin(path, root) {
  return isWithin(resolveCanonicalPath(path), resolveCanonicalPath(root));
}

function loadExecutionProfile(path, { protectedRoots }) {
  const provided = resolve(path);
  const providedMetadata = lstatMaybe(provided);
  if (!providedMetadata?.isFile() || providedMetadata.isSymbolicLink() || providedMetadata.nlink !== 1) {
    throw new ManifestError("execution profile must be a canonical regular file");
  }
  const lexical = realpathSync(provided);
  if (protectedRoots.some((root) => pathIsWithin(lexical, root) || pathIsWithin(root, lexical))) {
    throw new ManifestError("execution profile must stay outside candidate, baseline, and run workspaces");
  }
  const raw = loadJson(lexical);
  rejectUnsupportedFields(raw, EXECUTION_PROFILE_FIELDS, "execution profile");
  let adapterId = null;
  let adapterEntry = null;
  let adapterProfile = null;
  if (raw.adapter_id !== null && raw.adapter_id !== undefined) {
    adapterId = requireString(raw.adapter_id, "execution_profile.adapter_id");
    if (!AGENT_ADAPTER_ID_PATTERN.test(adapterId)) throw new ManifestError("execution_profile.adapter_id must be a lowercase adapter id");
    adapterEntry = loadRegisteredAgentAdapter(adapterId);
    adapterProfile = adapterEntry.profile;
  }
  const target = adapterProfile ? registeredProfileString(raw, "target", adapterProfile) : requireString(raw.target, "execution_profile.target");
  const harness = adapterProfile ? registeredProfileString(raw, "harness", adapterProfile) : requireString(raw.harness, "execution_profile.harness");
  const dispatchObservation = adapterProfile
    ? registeredProfileString(raw, "dispatch_observation", adapterProfile)
    : requireString(raw.dispatch_observation, "execution_profile.dispatch_observation");
  if (!DISPATCH_OBSERVATIONS.has(dispatchObservation)) {
    throw new ManifestError("execution_profile.dispatch_observation must be host_dispatch, process_spawn, or external_harness");
  }
  let trace = raw.trace;
  if (trace === undefined && adapterProfile) {
    trace = {
      capture_source: adapterProfile.capture_source,
      source: { artifact: adapterProfile.source_artifact, format: adapterProfile.source_format },
    };
  }
  if (!plainObject(trace)) throw new ManifestError("execution_profile.trace must be an object");
  rejectUnsupportedFields(trace, EXECUTION_PROFILE_TRACE_FIELDS, "execution_profile.trace");
  const missingTrace = [...EXECUTION_PROFILE_TRACE_FIELDS].filter((field) => !(field in trace)).sort();
  if (missingTrace.length > 0) throw new ManifestError(`execution_profile.trace is missing fields: ${missingTrace.join(", ")}`);
  const captureSource = requireString(trace.capture_source, "execution_profile.trace.capture_source");
  if (!TRACE_CAPTURE_SOURCE_PATTERN.test(captureSource)) {
    throw new ManifestError("execution_profile.trace.capture_source must be a lowercase trace adapter slug");
  }
  let source = null;
  if (trace.source !== null) {
    if (!plainObject(trace.source)) throw new ManifestError("execution_profile.trace.source must be an object or null");
    rejectUnsupportedFields(trace.source, EXECUTION_PROFILE_SOURCE_FIELDS, "execution_profile.trace.source");
    const missing = [...EXECUTION_PROFILE_SOURCE_FIELDS].filter((field) => !(field in trace.source)).sort();
    if (missing.length > 0) throw new ManifestError(`execution_profile.trace.source is missing fields: ${missing.join(", ")}`);
    source = {
      artifact: validateArtifactPath(trace.source.artifact, "execution_profile.trace.source.artifact"),
      format: requireString(trace.source.format, "execution_profile.trace.source.format"),
    };
  }
  if (adapterProfile) {
    const expected = {
      capture_source: adapterProfile.capture_source,
      source: { artifact: adapterProfile.source_artifact, format: adapterProfile.source_format },
    };
    if (canonicalJson({ capture_source: captureSource, source }) !== canonicalJson(expected)) {
      throw new ManifestError("execution_profile.trace does not match the registered agent adapter");
    }
  }
  if (captureSource === "provider_stream" && source !== null && adapterId === null) {
    throw new ManifestError("execution_profile.adapter_id is required for a provider source stream");
  }
  const isolation = requireString(raw.isolation, "execution_profile.isolation");
  if (!["trusted-orchestrator", "local-unattested"].includes(isolation)) {
    throw new ManifestError("execution_profile.isolation must be trusted-orchestrator or local-unattested");
  }
  let capabilities = raw.capabilities;
  if (capabilities === undefined && adapterProfile) capabilities = adapterProfile.required_capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.some((item) => typeof item !== "string" || !item.trim()) || new Set(capabilities).size !== capabilities.length) {
    throw new ManifestError("execution_profile.capabilities must be a non-empty unique string array");
  }
  if (adapterProfile) {
    if (!Array.isArray(adapterProfile.required_capabilities) || adapterProfile.required_capabilities.some((item) => typeof item !== "string" || !item.trim())) {
      throw new ManifestError("registered agent adapter capabilities are invalid");
    }
    const missing = adapterProfile.required_capabilities.filter((item) => !capabilities.includes(item));
    if (missing.length > 0) {
      throw new ManifestError(`execution_profile.capabilities is missing registered agent adapter capabilities: ${missing.join(", ")}`);
    }
  }
  if (!plainObject(raw.sampling) || Object.keys(raw.sampling).length === 0) {
    throw new ManifestError("execution_profile.sampling must be a non-empty object");
  }
  requireFiniteJson(raw.sampling, "execution_profile.sampling");
  const adapterBinding = adapterEntry ? {
    source_agent: adapterEntry.source_agent.id,
    source_format: adapterEntry.source_format.id,
    source_contract_version: adapterEntry.source_format.contract_version,
    contract_stability: adapterEntry.source_format.stability,
    official_sources: adapterEntry.source_format.official_sources,
    evidence_authority: adapterEntry.evidence_authority,
    implementation_maturity: adapterEntry.implementation.maturity,
    executable_version: adapterEntry.runtime.version_policy.value,
    registry_entry_digest: sha256Json(adapterEntry),
  } : null;
  const normalized = {
    adapter_id: adapterId,
    ...(adapterBinding ? { adapter_binding: adapterBinding } : {}),
    target,
    harness,
    dispatch_observation: dispatchObservation,
    trace: { capture_source: captureSource, source },
    capabilities: [...capabilities].sort(),
    isolation,
    sampling: raw.sampling,
  };
  return { ...normalized, source_path: lexical, digest: sha256Json(normalized) };
}

export function writeJson(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const parent = dirname(target);
  if (realpathSync(parent) !== parent || lstatMaybe(target)?.isSymbolicLink()) {
    throw new ManifestError(`refusing to write through a symbolic link: ${target}`);
  }
  let payload;
  try {
    requireFiniteJson(value, String(target));
    payload = `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    throw new ManifestError(`JSON artifact is not serializable: ${target}`);
  }
  const temporary = join(parent, `.${target.split(sep).at(-1)}.${randomUUID()}.tmp`);
  try {
    writeDurableExclusive(temporary, payload, 0o600);
    renameSync(temporary, target);
  } catch {
    throw new ManifestError(`unable to write JSON artifact safely: ${target}`);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function writeDurableExclusive(path, payload, mode) {
  let descriptor = null;
  try {
    descriptor = openSync(path, "wx", mode);
    writeFileSync(descriptor, payload, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function writeJsonExclusive(path, value) {
  const target = resolve(path);
  const parent = dirname(target);
  if (!existsSync(parent) || !statSync(parent).isDirectory() || realpathSync(parent) !== parent) {
    throw new ManifestError(`exclusive JSON parent must be a canonical directory: ${target}`);
  }
  if (lstatMaybe(target)) throw new ManifestError(`immutable JSON artifact already exists: ${target}`);
  const stagingRoot = resolve(parent, "..", ".transition-staging");
  if (!existsSync(stagingRoot) || !statSync(stagingRoot).isDirectory() || realpathSync(stagingRoot) !== stagingRoot) {
    throw new ManifestError(`exclusive JSON staging directory is invalid: ${stagingRoot}`);
  }
  const temporary = join(stagingRoot, `.${target.split(sep).at(-1)}.${randomUUID()}.tmp`);
  try {
    requireFiniteJson(value, String(target));
    writeDurableExclusive(temporary, `${JSON.stringify(value, null, 2)}\n`, 0o444);
    linkSync(temporary, target);
    unlinkSync(temporary);
  } catch (error) {
    if (error.code === "EEXIST") throw new ManifestError(`immutable JSON artifact already exists: ${target}`);
    if (error instanceof ManifestError) throw error;
    throw new ManifestError(`unable to create immutable JSON artifact: ${target}`);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function recursiveEntries(root) {
  const entries = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      entries.push(path);
      if (entry.isDirectory()) visit(path);
    }
  }
  visit(root);
  return entries.sort();
}

export function iterStrictFiles(root, label, { allowHardlinks = false } = {}) {
  const metadata = lstatMaybe(root);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new ManifestError(`${label} must be a real directory: ${root}`);
  return recursiveEntries(root).filter((path) => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new ManifestError(`${label} contains a symbolic link: ${path}`);
    if (entry.isDirectory()) return false;
    if (!entry.isFile()) throw new ManifestError(`${label} contains a special file: ${path}`);
    if (entry.nlink !== 1 && !allowHardlinks) throw new ManifestError(`${label} contains a hard-linked file: ${path}`);
    return true;
  });
}

export function strictTreeManifest(root, label) {
  const metadata = lstatMaybe(root);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new ManifestError(`${label} must be a real directory: ${root}`);
  const records = {};
  for (const path of recursiveEntries(root)) {
    const entry = lstatSync(path);
    const relativePath = relative(root, path).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new ManifestError(`${label} contains a symbolic link: ${path}`);
    if (entry.isDirectory()) records[`${relativePath}/`] = sha256RuntimeDirectory(path);
    else if (!entry.isFile()) throw new ManifestError(`${label} contains a special file: ${path}`);
    else {
      if (entry.nlink !== 1) throw new ManifestError(`${label} contains a hard-linked file: ${path}`);
      records[relativePath] = sha256RuntimeFile(path);
    }
  }
  return records;
}

function requireReadOnlyTree(root, label) {
  for (const path of [root, ...recursiveEntries(root)]) {
    if (lstatSync(path).mode & 0o222) throw new ManifestError(`${label} must be read-only: ${path}`);
  }
}

export function requireEmptyWorkspace(workspace, protectedRoots) {
  const target = resolveCanonicalPath(workspace);
  for (const root of protectedRoots) {
    if (pathIsWithin(target, root) || pathIsWithin(root, target)) {
      throw new ManifestError("workspace must not overlap protected package or run directories");
    }
  }
  if (existsSync(target)) {
    if (!statSync(target).isDirectory() || readdirSync(target).length > 0) throw new ManifestError("workspace must be empty before compilation");
  }
}

function makeReadOnly(root) {
  for (const path of [...recursiveEntries(root).sort((left, right) => right.split(sep).length - left.split(sep).length), root]) {
    chmodSync(path, statSync(path).mode & ~0o222);
  }
}

function normalizeGeneratedDirectories(root) {
  for (const path of [root, ...recursiveEntries(root)]) if (lstatSync(path).isDirectory()) chmodSync(path, 0o555);
}

function copyWithMode(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, statSync(source).mode & 0o777);
}

function materializeSkillSnapshot(sourcePath, destination) {
  const source = resolve(sourcePath);
  if (existsSync(destination)) throw new ManifestError(`skill snapshot already exists: ${destination}`);
  mkdirSync(destination, { recursive: true });
  for (const entryName of RUNTIME_SKILL_ENTRIES) {
    const sourceEntry = join(source, entryName);
    if (!existsSync(sourceEntry)) continue;
    const metadata = lstatSync(sourceEntry);
    if (metadata.isSymbolicLink()) throw new ManifestError(`runtime skill snapshot entry contains a symbolic link: ${entryName}`);
    const destinationEntry = join(destination, entryName);
    if (metadata.isFile()) {
      if (metadata.nlink !== 1) throw new ManifestError(`runtime skill snapshot entry is hard-linked: ${entryName}`);
      copyWithMode(safeSubjectFile(source, entryName, "runtime skill snapshot entry"), destinationEntry);
      continue;
    }
    if (!metadata.isDirectory()) throw new ManifestError(`runtime skill snapshot entry must be a file or directory: ${entryName}`);
    strictTreeManifest(sourceEntry, `runtime skill snapshot entry ${entryName}`);
    mkdirSync(destinationEntry, { recursive: true });
    const directories = [sourceEntry];
    for (const sourceItem of recursiveEntries(sourceEntry)) {
      if (!lstatSync(sourceItem).isDirectory()) continue;
      directories.push(sourceItem);
      mkdirSync(join(destinationEntry, relative(sourceEntry, sourceItem)), { recursive: true });
    }
    for (const sourceFile of iterStrictFiles(sourceEntry, `runtime skill snapshot entry ${entryName}`)) {
      const relativeFile = relative(sourceEntry, sourceFile);
      const safeSource = safeSubjectFile(source, join(entryName, relativeFile), "runtime skill snapshot entry");
      copyWithMode(safeSource, join(destinationEntry, relativeFile));
    }
    for (const sourceDirectory of directories) {
      chmodSync(join(destinationEntry, relative(sourceEntry, sourceDirectory)), (statSync(sourceDirectory).mode & 0o777) | 0o200);
    }
  }
  if (!existsSync(join(destination, "SKILL.md")) || !statSync(join(destination, "SKILL.md")).isFile()) {
    throw new ManifestError("skill snapshot requires SKILL.md");
  }
  const digest = runtimeSkillDigest(destination);
  makeReadOnly(destination);
  return digest;
}

function buildAuthority(subject, manifestPath) {
  const evalRoot = realpathSync(dirname(manifestPath));
  if (!pathIsWithin(evalRoot, subject)) throw new ManifestError("eval authority must stay inside the subject directory");
  const semanticContractPath = resolve(SCRIPTS_ROOT, "..", "assets", "semantic-grader-contract.md");
  if (!existsSync(semanticContractPath) || !statSync(semanticContractPath).isFile()) throw new ManifestError("semantic grader contract is missing");
  const manifest = loadJson(manifestPath);
  const authoritativeFixtureDigests = {};
  const developmentFixtureDigests = {};
  const authoritativeEvals = [];
  const developmentEvals = [];
  if (Array.isArray(manifest.evals)) {
    for (const evalCase of manifest.evals) {
      if (!plainObject(evalCase)) continue;
      const development = evalCase.split === "development";
      (development ? developmentEvals : authoritativeEvals).push(evalCase);
      if (!Array.isArray(evalCase.files) || evalCase.holdout?.visibility === "opaque") continue;
      const target = development ? developmentFixtureDigests : authoritativeFixtureDigests;
      for (const relativePath of evalCase.files) {
        if (typeof relativePath === "string") target[relativePath] = sha256RuntimeFile(safeSubjectFile(subject, relativePath, "declared eval fixture"));
      }
    }
  }
  const { evals: _ignored, ...sharedManifest } = manifest;
  const graderNames = [
    "agent-digest.mjs",
    "strict-utf8.mjs",
    "skill-eval-authority.mjs",
    "skill-eval-contracts.mjs",
    "skill-eval-decision.mjs",
    "skill-eval-evidence.mjs",
    "skill-eval-grading.mjs",
    "skill-eval-measurement.mjs",
  ];
  const graderFiles = Object.fromEntries(graderNames.map((name) => [name, sha256File(join(dirname(fileURLToPath(import.meta.url)), name))]));
  const identity = {
    canonical_json_contract: CANONICAL_JSON_CONTRACT,
    portable_regex_contract: PORTABLE_REGEX_CONTRACT,
    authoritative_manifest_digest: sha256Json({ ...sharedManifest, evals: authoritativeEvals }),
    authoritative_fixture_digests: Object.fromEntries(Object.entries(authoritativeFixtureDigests).sort()),
    grader_digest: sha256Json(graderFiles),
    grader_files: graderFiles,
    semantic_grader_contract_digest: sha256File(semanticContractPath),
  };
  const developmentIdentity = {
    development_manifest_digest: sha256Json({ ...sharedManifest, evals: developmentEvals }),
    development_fixture_digests: Object.fromEntries(Object.entries(developmentFixtureDigests).sort()),
  };
  return {
    ...identity,
    ...developmentIdentity,
    evals_root: evalRoot,
    grader_path: join(dirname(fileURLToPath(import.meta.url)), "skill-eval-grading.mjs"),
    semantic_grader_contract_path: semanticContractPath,
    digest: sha256Json(identity),
    development_digest: sha256Json(developmentIdentity),
  };
}

function resolveHoldoutCases(cases, { subject, holdoutPackPath, protectedRoots }) {
  const visibilities = new Set(cases.map((evalCase) => String(evalCase.holdout?.visibility ?? "public")));
  if (visibilities.size !== 1) throw new ManifestError("one execution split cannot mix public and opaque holdout");
  const visibility = [...visibilities][0];
  if (visibility === "public") {
    if (holdoutPackPath) throw new ManifestError("--holdout-pack is allowed only for an opaque audit");
    const sources = new Map();
    for (const evalCase of cases) for (const record of evalCase.files ?? []) {
      sources.set(`${evalCase.id}\0${record.path}`, safeSubjectFile(subject, record.path, "public eval fixture"));
    }
    return {
      cases,
      holdout: { visibility: "public", issuer: null, source_path: null, digest: null },
      sources,
    };
  }
  if (visibility !== "opaque") throw new ManifestError("holdout visibility is invalid");
  if (!holdoutPackPath) throw new ManifestError("an opaque audit requires --holdout-pack");
  const provided = resolve(holdoutPackPath);
  const metadata = lstatMaybe(provided);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new ManifestError("holdout pack must be a canonical regular file");
  const packPath = realpathSync(provided);
  if (protectedRoots.some((root) => pathIsWithin(packPath, root) || pathIsWithin(root, packPath))) {
    throw new ManifestError("holdout pack must stay outside candidate, baseline, and run workspaces");
  }
  const pack = loadJson(packPath);
  if (JSON.stringify(Object.keys(pack).sort()) !== JSON.stringify(["assets", "issuer"])) throw new ManifestError("holdout pack must contain only issuer and assets");
  const issuer = requireString(pack.issuer, "holdout_pack.issuer");
  if (!plainObject(pack.assets)) throw new ManifestError("holdout_pack.assets must be an object");
  const resolvedCases = [];
  const sources = new Map();
  const fixtureDigests = {};
  for (const evalCase of cases) {
    const caseId = String(evalCase.id);
    const assetId = requireString(evalCase.holdout?.asset_id, `eval ${caseId}.holdout.asset_id`);
    const asset = pack.assets[assetId];
    if (!plainObject(asset) || JSON.stringify(Object.keys(asset).sort()) !== JSON.stringify(["assertions", "files", "objectives", "prompt"])) {
      throw new ManifestError(`opaque holdout asset is missing or invalid: ${assetId}`);
    }
    const prompt = requireString(asset.prompt, `holdout_pack.assets.${assetId}.prompt`);
    if (!plainObject(asset.files)) throw new ManifestError(`opaque holdout asset files are invalid: ${assetId}`);
    const logicalPaths = Object.keys(asset.files).map((path) => validateArtifactPath(path, `holdout_pack.assets.${assetId}.files.${path}`));
    if (new Set(logicalPaths).size !== logicalPaths.length) throw new ManifestError(`opaque holdout asset files are duplicated: ${assetId}`);
    const assertions = validateAssertions(asset.assertions, `holdout_pack.assets.${assetId}.assertions`);
    if (!assertions.some((assertion) => DETERMINISTIC_ASSERTION_TYPES.has(assertion.type) && assertion.severity === "must_pass")) {
      throw new ManifestError(`holdout_pack.assets.${assetId}.assertions requires at least one deterministic must_pass assertion`);
    }
    const objectives = validateObjectives(asset.objectives, `holdout_pack.assets.${assetId}.objectives`);
    const oracle = assessOracle(assertions);
    if (oracle.status !== "valid") throw new ManifestError(`holdout_pack.assets.${assetId}.assertions must calibrate every must_pass text predicate: ${oracle.reasons.join(", ")}`);
    const records = [];
    for (const logicalPath of logicalPaths) {
      const sourceValue = asset.files[logicalPath];
      if (typeof sourceValue !== "string" || !sourceValue) throw new ManifestError(`opaque holdout source is invalid: ${caseId}/${logicalPath}`);
      if (!isAbsolute(sourceValue)) throw new ManifestError("opaque holdout sources must use absolute paths");
      const sourceMetadata = lstatMaybe(sourceValue);
      if (!sourceMetadata?.isFile() || sourceMetadata.isSymbolicLink() || sourceMetadata.nlink !== 1) throw new ManifestError("opaque holdout source must be a regular file");
      const source = realpathSync(sourceValue);
      if (protectedRoots.some((root) => pathIsWithin(source, root) || pathIsWithin(root, source))) {
        throw new ManifestError("opaque holdout sources must stay outside candidate, baseline, and run workspaces");
      }
      const digest = sha256RuntimeFile(source);
      records.push({ path: logicalPath, digest });
      sources.set(`${caseId}\0${logicalPath}`, source);
      fixtureDigests[`${caseId}/${logicalPath}`] = digest;
    }
    resolvedCases.push({ ...evalCase, prompt, files: records, assertions, objectives, oracle });
  }
  const packIdentity = { pack_digest: sha256File(packPath), fixture_digests: Object.fromEntries(Object.entries(fixtureDigests).sort()) };
  return {
    cases: resolvedCases,
    holdout: { visibility: "opaque", issuer, source_path: packPath, digest: sha256Json(packIdentity) },
    sources,
  };
}

function casesWithExecutionArms(cases, baselineKind) {
  const defaults = baselineKind === "old_skill" ? ["with_skill", "old_skill"] : ["with_skill", "without_skill"];
  return cases.map((evalCase) => {
    const arms = [...defaults];
    const config = evalCase.without_skill ?? {};
    if (!plainObject(config)) throw new ManifestError(`eval ${evalCase.id}.without_skill must be an object when present`);
    const extra = {};
    if (evalCase.split === "audit" && baselineKind === "old_skill") {
      const applicable = config.applicable ?? true;
      if (typeof applicable !== "boolean") throw new ManifestError(`eval ${evalCase.id}.without_skill.applicable must be boolean`);
      if (applicable) arms.push("without_skill");
      else extra.without_skill_na_reason = requireString(config.reason, `eval ${evalCase.id}.without_skill.reason`);
    }
    return { ...evalCase, ...extra, arms };
  });
}

function artifactOwnership(evalCase, executionProfile) {
  const ownership = buildArtifactOwnership(evalCase, executionProfile);
  if (!Array.isArray(ownership.worker) || !Array.isArray(ownership.framework)) throw new ManifestError("artifact ownership contract is invalid");
  return ownership;
}

export function runtimeSkillFileDigests(sourcePath) {
  const source = resolve(sourcePath);
  const records = {};
  for (const entryName of RUNTIME_SKILL_ENTRIES) {
    const sourceEntry = join(source, entryName);
    if (!existsSync(sourceEntry)) continue;
    const metadata = lstatSync(sourceEntry);
    if (metadata.isSymbolicLink()) throw new ManifestError(`runtime skill snapshot entry contains a symbolic link: ${entryName}`);
    if (metadata.isFile()) {
      if (metadata.nlink !== 1) throw new ManifestError(`runtime skill snapshot entry is hard-linked: ${entryName}`);
      records[entryName] = sha256RuntimeFile(safeSubjectFile(source, entryName, "runtime skill snapshot entry"));
    } else if (metadata.isDirectory()) {
      records[`${entryName}/`] = sha256RuntimeDirectory(sourceEntry);
      for (const [path, digest] of Object.entries(strictTreeManifest(sourceEntry, `runtime skill snapshot entry ${entryName}`))) records[`${entryName}/${path}`] = digest;
    } else {
      throw new ManifestError(`runtime skill snapshot entry must be a file or directory: ${entryName}`);
    }
  }
  if (!("SKILL.md" in records)) throw new ManifestError("skill snapshot requires SKILL.md");
  return records;
}

export function runtimeSkillDigest(source) {
  return sha256Json(runtimeSkillFileDigests(source));
}

export function lockedSkillSnapshotPath(plan, arm) {
  if (!plainObject(plan.skill_snapshots)) throw new ManifestError("candidate plan is missing skill snapshots");
  const records = Object.values(plan.skill_snapshots).filter((record) => plainObject(record) && record.arm === arm);
  if (records.length === 0) throw new ManifestError(`candidate plan has no ${arm} snapshot`);
  const path = requireString(records[0].path, `${arm} snapshot.path`);
  if (!existsSync(path) || !statSync(path).isDirectory() || runtimeSkillDigest(path) !== records[0].digest) {
    throw new ManifestError(`candidate plan ${arm} snapshot changed`);
  }
  return path;
}

function unique(values) {
  return [...new Set(values ?? [])];
}

function legacyScalarString(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

export function compileManifest({
  manifestPath,
  subject,
  workspace,
  executionProfilePath,
  holdoutPackPath = null,
  baselineKind,
  baselinePath = null,
  splits = null,
  caseIds = null,
}) {
  const resolvedSubject = realpathSync(resolve(subject));
  const resolvedManifest = realpathSync(resolve(manifestPath));
  const expectedManifest = realpathSync(join(resolvedSubject, "evals", "evals.json"));
  if (resolvedManifest !== expectedManifest) throw new ManifestError("manifest must be the subject's evals/evals.json");
  let cases = validateManifest(loadJson(resolvedManifest), resolvedSubject);
  const selectedSplits = unique(splits);
  if (selectedSplits.length !== 1 || !["development", "selection", "audit"].includes(selectedSplits[0])) {
    throw new ManifestError("compile requires exactly one --split");
  }
  const selectedSplit = selectedSplits[0];
  const requestedCaseIds = unique(caseIds);
  const availableCaseIds = new Set(cases.map((evalCase) => String(evalCase.id)));
  const unknown = requestedCaseIds.filter((id) => !availableCaseIds.has(id));
  if (unknown.length > 0) throw new ManifestError(`unknown eval case id: ${unknown.join(", ")}`);
  const splitCaseIds = new Set(cases.filter((evalCase) => evalCase.split === selectedSplit).map((evalCase) => String(evalCase.id)));
  const wrongSplit = requestedCaseIds.filter((id) => !splitCaseIds.has(id));
  if (wrongSplit.length > 0) throw new ManifestError(`eval case is not in the selected ${selectedSplit} split: ${wrongSplit.join(", ")}`);
  if (["selection", "audit"].includes(selectedSplit) && requestedCaseIds.length > 0 && (requestedCaseIds.length !== splitCaseIds.size || requestedCaseIds.some((id) => !splitCaseIds.has(id)))) {
    throw new ManifestError(`${selectedSplit} must execute the complete split; --case is only for development screening`);
  }
  cases = cases.filter((evalCase) => evalCase.split === selectedSplit && (requestedCaseIds.length === 0 || requestedCaseIds.includes(evalCase.id)));
  if (cases.length === 0) throw new ManifestError("selected split has no eval cases");

  let baseline;
  let resolvedBaseline = null;
  if (baselineKind === "old_skill") {
    if (!baselinePath) throw new ManifestError("--baseline-path is required for old_skill");
    resolvedBaseline = realpathSync(resolve(baselinePath));
    baseline = { kind: "old_skill", path: resolvedBaseline, digest: runtimeSkillDigest(resolvedBaseline) };
  } else if (baselineKind === "without_skill") {
    baseline = { kind: "without_skill", path: null, digest: null };
  } else {
    throw new ManifestError("baseline kind must be old_skill or without_skill");
  }
  if (["selection", "audit"].includes(selectedSplit) && baselineKind !== "old_skill") {
    throw new ManifestError(`${selectedSplit} requires an old_skill baseline`);
  }
  const protectedRoots = [resolvedSubject, ...(resolvedBaseline ? [resolvedBaseline] : [])];
  const resolvedWorkspace = resolveCanonicalPath(workspace);
  requireEmptyWorkspace(resolvedWorkspace, protectedRoots);
  const executionProfile = loadExecutionProfile(executionProfilePath, { protectedRoots: [...protectedRoots, resolvedWorkspace] });
  const holdoutResolution = resolveHoldoutCases(cases, {
    subject: resolvedSubject,
    holdoutPackPath,
    protectedRoots: [...protectedRoots, resolvedWorkspace],
  });
  cases = holdoutResolution.cases;
  const manifestDigest = sha256File(resolvedManifest);
  const subjectDigest = runtimeSkillDigest(resolvedSubject);
  const authority = buildAuthority(resolvedSubject, resolvedManifest);
  const casesWithArms = casesWithExecutionArms(cases, baselineKind);
  const runSeed = [
    subjectDigest,
    authority.digest,
    authority.development_digest,
    legacyScalarString(baseline.digest),
    executionProfile.digest,
    legacyScalarString(holdoutResolution.holdout.digest),
    selectedSplit,
    cases.map((evalCase) => String(evalCase.id)).join(","),
  ].join("|");
  const runId = `run-${createHash("sha256").update(runSeed).digest("hex").slice(0, 20)}`;
  const snapshots = {};
  for (const evalCase of casesWithArms) {
    for (const arm of evalCase.arms) {
      if (arm === "without_skill") continue;
      const source = arm === "with_skill" ? resolvedSubject : resolvedBaseline;
      const sourceDigest = arm === "with_skill" ? subjectDigest : baseline.digest;
      if (!source) throw new ManifestError(`skill snapshot source is missing for arm ${arm}`);
      for (let repeat = 1; repeat <= evalCase.repeats; repeat += 1) {
        const key = `${evalCase.id}/${arm}/repeat-${repeat}`;
        const path = safeArtifact(resolvedWorkspace, `skill-snapshots/${key}`);
        snapshots[key] = {
          case_id: evalCase.id,
          arm,
          repeat,
          path,
          digest: materializeSkillSnapshot(source, path),
          source_digest: sourceDigest,
        };
      }
    }
  }
  const snapshotRoot = join(resolvedWorkspace, "skill-snapshots");
  makeReadOnly(snapshotRoot);
  for (const record of Object.values(snapshots)) {
    let current = record.path;
    while (current !== snapshotRoot) {
      chmodSync(current, 0o555);
      current = dirname(current);
    }
  }
  chmodSync(snapshotRoot, 0o555);
  const snapshotTreeDigest = sha256Json(strictTreeManifest(snapshotRoot, "skill snapshot tree"));
  const plan = {
    contract: PLAN_CONTRACT,
    run_id: runId,
    manifest: { path: resolvedManifest, digest: manifestDigest, contract: MANIFEST_CONTRACT },
    subject: { path: resolvedSubject, digest: subjectDigest },
    baseline,
    authority,
    execution_profile: executionProfile,
    holdout: holdoutResolution.holdout,
    skill_snapshots: snapshots,
    skill_snapshot_tree_digest: snapshotTreeDigest,
    splits: selectedSplits,
    case_ids: cases.map((evalCase) => String(evalCase.id)),
    cases: casesWithArms,
  };
  const planPath = join(resolvedWorkspace, "execution-plan.json");
  mkdirSync(join(resolvedWorkspace, "inputs"), { recursive: true });
  const inputCopyDigests = {};
  const assignmentDigests = {};
  for (const evalCase of casesWithArms) {
    const ownership = artifactOwnership(evalCase, executionProfile);
    const expectedArtifacts = ownership.worker;
    for (const arm of evalCase.arms) {
      for (let repeat = 1; repeat <= evalCase.repeats; repeat += 1) {
        let configuration;
        if (arm === "without_skill") {
          configuration = { kind: "without_skill", skill_path: null, snapshot_digest: null, source_digest: null };
        } else {
          const snapshot = snapshots[`${evalCase.id}/${arm}/repeat-${repeat}`];
          configuration = { kind: arm, skill_path: snapshot.path, snapshot_digest: snapshot.digest, source_digest: snapshot.source_digest };
        }
        const assignmentRelative = `assignments/${evalCase.id}/${arm}/repeat-${repeat}.json`;
        const repeatRoot = join(resolvedWorkspace, "cases", String(evalCase.id), String(arm), `repeat-${repeat}`);
        mkdirSync(repeatRoot, { recursive: true });
        const inputFiles = [];
        const inputRoot = safeArtifact(resolvedWorkspace, `inputs/${evalCase.id}/${arm}/repeat-${repeat}`);
        for (const record of evalCase.files ?? []) {
          const inputRelative = `inputs/${evalCase.id}/${arm}/repeat-${repeat}/package/${record.path}`;
          const source = holdoutResolution.sources.get(`${evalCase.id}\0${record.path}`);
          const isolated = safeArtifact(resolvedWorkspace, inputRelative);
          copyWithMode(source, isolated);
          chmodSync(isolated, statSync(isolated).mode & ~0o222);
          const digest = sha256RuntimeFile(isolated);
          inputCopyDigests[inputRelative] = digest;
          inputFiles.push({ relative_path: record.path, path: isolated, digest });
        }
        if (existsSync(inputRoot)) makeReadOnly(inputRoot);
        const assignment = {
          contract: ASSIGNMENT_CONTRACT,
          run_id: runId,
          case_id: evalCase.id,
          arm,
          repeat,
          repeat_count: evalCase.repeats,
          prompt: evalCase.prompt,
          timeout_seconds: evalCase.timeout_seconds,
          configuration,
          input_files: inputFiles,
          readable_paths: [...(configuration.skill_path ? [configuration.skill_path] : []), ...inputFiles.map((record) => record.path)],
          permissions: evalCase.permissions,
          agent_adapter_id: executionProfile.adapter_id,
          execution_profile_digest: executionProfile.digest,
          writable_root: resolve(repeatRoot),
          execution_artifact: "execution.json",
          dispatch_artifact: "dispatch-receipt.json",
          source_trace_artifact: executionProfile.trace.source?.artifact ?? null,
          trace_artifact: "agent-trace.jsonl",
          artifact_ownership: ownership,
          expected_artifacts: expectedArtifacts,
        };
        const assignmentPath = join(resolvedWorkspace, assignmentRelative);
        writeJson(assignmentPath, assignment);
        assignmentDigests[assignmentRelative] = sha256File(assignmentPath);
      }
    }
  }
  const inputRoot = join(resolvedWorkspace, "inputs");
  makeReadOnly(inputRoot);
  normalizeGeneratedDirectories(inputRoot);
  const inputTreeDigest = sha256Json(strictTreeManifest(inputRoot, "isolated input tree"));
  plan.input_tree_digest = inputTreeDigest;
  writeJson(planPath, plan);
  const runLock = {
    contract: RUN_LOCK_CONTRACT,
    run_id: runId,
    plan_digest: sha256File(planPath),
    manifest_digest: manifestDigest,
    subject_digest: subjectDigest,
    baseline,
    authority,
    execution_profile: executionProfile,
    holdout: holdoutResolution.holdout,
    skill_snapshot_digests: Object.fromEntries(Object.entries(snapshots).map(([key, record]) => [key, record.digest])),
    skill_snapshot_tree_digest: snapshotTreeDigest,
    input_tree_digest: inputTreeDigest,
    fixture_digests: Object.fromEntries(cases.flatMap((evalCase) => (evalCase.files ?? []).map((record) => [record.path, record.digest]))),
    assignment_digests: assignmentDigests,
    input_copy_digests: inputCopyDigests,
  };
  writeJson(join(resolvedWorkspace, "run-lock.json"), runLock);
  return plan;
}

function deepEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function strictTreeFileDigests(root) {
  if (!existsSync(root)) return {};
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ManifestError(`locked tree must be a real directory: ${root}`);
  return Object.fromEntries(iterStrictFiles(root, "locked tree").map((path) => [relative(root, path).split(sep).join("/"), sha256File(path)]));
}

function addDirectoryPrefixes(records, relativePath) {
  const parts = relativePath.split("/");
  for (let length = 1; length < parts.length; length += 1) {
    const directory = `${parts.slice(0, length).join("/")}/`;
    records[directory] = sha256Json({ kind: "directory", read_execute_bits: 0o555 });
  }
}

export function verifyLockedInputs({ planPath, workspace, plan }) {
  const resolvedWorkspace = realpathSync(resolve(workspace));
  const resolvedPlanPath = realpathSync(resolve(planPath));
  if (resolvedPlanPath !== join(resolvedWorkspace, "execution-plan.json")) throw new ManifestError("execution plan path is not canonical");
  const lockPath = safeArtifact(resolvedWorkspace, "run-lock.json");
  if (!existsSync(lockPath) || !statSync(lockPath).isFile()) throw new ManifestError("run-lock.json is required before grading");
  const lock = loadJson(lockPath);
  if (lock.contract !== RUN_LOCK_CONTRACT) throw new ManifestError(`run lock contract must be ${RUN_LOCK_CONTRACT}`);
  if (!plainObject(plan.manifest) || !plainObject(plan.subject) || !plainObject(plan.baseline)) {
    throw new ManifestError("execution plan is missing manifest, subject, or baseline metadata");
  }
  const subjectPath = realpathSync(resolve(requireString(plan.subject.path, "plan.subject.path")));
  const manifestPath = realpathSync(resolve(requireString(plan.manifest.path, "plan.manifest.path")));
  if (manifestPath !== join(subjectPath, "evals", "evals.json")) throw new ManifestError("execution plan manifest path is not canonical");
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) throw new ManifestError("locked eval manifest changed or disappeared");
  const manifestDigest = sha256File(manifestPath);
  const subjectDigest = runtimeSkillDigest(subjectPath);
  if (!statSync(subjectPath).isDirectory() || subjectDigest !== plan.subject.digest) throw new ManifestError("locked subject changed or disappeared");
  const authority = buildAuthority(subjectPath, manifestPath);
  if (!deepEqual(plan.authority, authority)) throw new ManifestError("locked eval or grader authority changed after compilation");
  if (!plainObject(plan.execution_profile)) throw new ManifestError("execution plan is missing the execution profile");
  let baselinePath = null;
  let baselineDigest = null;
  let expectedBaseline;
  if (plan.baseline.kind === "old_skill") {
    baselinePath = realpathSync(resolve(requireString(plan.baseline.path, "plan.baseline.path")));
    baselineDigest = runtimeSkillDigest(baselinePath);
    expectedBaseline = { kind: "old_skill", path: baselinePath, digest: baselineDigest };
    if (!statSync(baselinePath).isDirectory() || !deepEqual(plan.baseline, expectedBaseline)) throw new ManifestError("locked old_skill baseline changed or disappeared");
  } else if (plan.baseline.kind === "without_skill") {
    expectedBaseline = { kind: "without_skill", path: null, digest: null };
    if (!deepEqual(plan.baseline, expectedBaseline)) throw new ManifestError("without_skill baseline metadata is invalid");
  } else {
    throw new ManifestError("execution plan baseline kind is invalid");
  }
  if (!Array.isArray(plan.splits) || plan.splits.length !== 1 || !["development", "selection", "audit"].includes(plan.splits[0]) || !Array.isArray(plan.case_ids) || plan.case_ids.length === 0 || plan.case_ids.some((id) => typeof id !== "string") || new Set(plan.case_ids).size !== plan.case_ids.length) {
    throw new ManifestError("execution plan split and case ids are invalid");
  }
  const selectedSplit = plan.splits[0];
  if (["selection", "audit"].includes(selectedSplit) && plan.baseline.kind !== "old_skill") throw new ManifestError(`${selectedSplit} requires an old_skill baseline`);
  const protectedRoots = [subjectPath, ...(baselinePath ? [baselinePath] : [])];
  if (protectedRoots.some((root) => pathIsWithin(resolvedWorkspace, root) || pathIsWithin(root, resolvedWorkspace))) throw new ManifestError("run workspace overlaps the candidate or baseline package");
  const profilePath = requireString(plan.execution_profile.source_path, "plan.execution_profile.source_path");
  const expectedProfile = loadExecutionProfile(profilePath, { protectedRoots: [...protectedRoots, resolvedWorkspace] });
  if (!deepEqual(plan.execution_profile, expectedProfile)) throw new ManifestError("locked execution profile changed after compilation");
  const manifestCases = validateManifest(loadJson(manifestPath), subjectPath);
  const allSplitCaseIds = manifestCases.filter((evalCase) => evalCase.split === selectedSplit).map((evalCase) => String(evalCase.id));
  if (["selection", "audit"].includes(selectedSplit) && !deepEqual(plan.case_ids, allSplitCaseIds)) throw new ManifestError(`${selectedSplit} plan does not cover the complete split`);
  let expectedCasesWithoutArms = manifestCases.filter((evalCase) => evalCase.split === selectedSplit && plan.case_ids.includes(evalCase.id));
  if (!deepEqual(expectedCasesWithoutArms.map((evalCase) => evalCase.id), plan.case_ids)) throw new ManifestError("execution plan case ids do not match manifest order");
  if (!plainObject(plan.holdout)) throw new ManifestError("execution plan is missing holdout authority");
  const holdoutResolution = resolveHoldoutCases(expectedCasesWithoutArms, {
    subject: subjectPath,
    holdoutPackPath: typeof plan.holdout.source_path === "string" ? plan.holdout.source_path : null,
    protectedRoots: [...protectedRoots, resolvedWorkspace],
  });
  expectedCasesWithoutArms = holdoutResolution.cases;
  if (!deepEqual(plan.holdout, holdoutResolution.holdout)) throw new ManifestError("locked holdout authority changed after compilation");
  const expectedCases = casesWithExecutionArms(expectedCasesWithoutArms, plan.baseline.kind);
  if (!deepEqual(plan.cases, expectedCases)) throw new ManifestError("execution plan cases do not match the pinned manifest");
  const runSeed = [
    subjectDigest,
    authority.digest,
    authority.development_digest,
    legacyScalarString(baselineDigest),
    expectedProfile.digest,
    legacyScalarString(holdoutResolution.holdout.digest),
    selectedSplit,
    plan.case_ids.join(","),
  ].join("|");
  const expectedRunId = `run-${createHash("sha256").update(runSeed).digest("hex").slice(0, 20)}`;
  if (plan.run_id !== expectedRunId) throw new ManifestError("execution plan run id is not derived from pinned inputs");
  if (!plainObject(plan.skill_snapshots)) throw new ManifestError("skill snapshot authority is missing");
  const expectedSnapshots = {};
  const expectedSnapshotDigests = {};
  const expectedSnapshotTree = {};
  for (const evalCase of expectedCases) {
    for (const arm of evalCase.arms) {
      if (arm === "without_skill") continue;
      const source = arm === "with_skill" ? subjectPath : baselinePath;
      const sourceDigest = arm === "with_skill" ? subjectDigest : baselineDigest;
      if (!source) throw new ManifestError(`skill snapshot source is missing for arm ${arm}`);
      const sourceFiles = runtimeSkillFileDigests(source);
      for (let repeat = 1; repeat <= evalCase.repeats; repeat += 1) {
        const key = `${evalCase.id}/${arm}/repeat-${repeat}`;
        const snapshotPath = join(resolvedWorkspace, "skill-snapshots", key);
        if (!deepEqual(strictTreeManifest(snapshotPath, `locked skill snapshot ${key}`), sourceFiles)) throw new ManifestError(`locked skill snapshot changed: ${key}`);
        const digest = runtimeSkillDigest(snapshotPath);
        expectedSnapshots[key] = { case_id: evalCase.id, arm, repeat, path: snapshotPath, digest, source_digest: sourceDigest };
        expectedSnapshotDigests[key] = digest;
        addDirectoryPrefixes(expectedSnapshotTree, `${key}/placeholder`);
        delete expectedSnapshotTree[`${key}/placeholder`];
        for (const [path, value] of Object.entries(sourceFiles)) expectedSnapshotTree[`${key}/${path}`] = value;
      }
    }
  }
  const snapshotRoot = join(resolvedWorkspace, "skill-snapshots");
  requireReadOnlyTree(snapshotRoot, "skill snapshot tree");
  if (!deepEqual(strictTreeManifest(snapshotRoot, "skill snapshot tree"), expectedSnapshotTree)) throw new ManifestError("skill snapshot tree contains undeclared entries");
  const snapshotTreeDigest = sha256Json(expectedSnapshotTree);
  if (!deepEqual(plan.skill_snapshots, expectedSnapshots)) throw new ManifestError("execution plan skill snapshots are not canonical");
  const expectedInputTree = {};
  for (const evalCase of expectedCases) for (const arm of evalCase.arms) for (let repeat = 1; repeat <= evalCase.repeats; repeat += 1) for (const record of evalCase.files ?? []) {
    const path = `${evalCase.id}/${arm}/repeat-${repeat}/package/${record.path}`;
    addDirectoryPrefixes(expectedInputTree, path);
    expectedInputTree[path] = record.digest;
  }
  const inputRoot = join(resolvedWorkspace, "inputs");
  requireReadOnlyTree(inputRoot, "isolated input tree");
  if (!deepEqual(strictTreeManifest(inputRoot, "isolated input tree"), expectedInputTree)) throw new ManifestError("isolated input tree contains undeclared entries");
  const inputTreeDigest = sha256Json(expectedInputTree);
  const expectedPlan = {
    contract: PLAN_CONTRACT,
    run_id: expectedRunId,
    manifest: { path: manifestPath, digest: manifestDigest, contract: MANIFEST_CONTRACT },
    subject: { path: subjectPath, digest: subjectDigest },
    baseline: expectedBaseline,
    authority,
    execution_profile: expectedProfile,
    holdout: holdoutResolution.holdout,
    skill_snapshots: expectedSnapshots,
    skill_snapshot_tree_digest: snapshotTreeDigest,
    input_tree_digest: inputTreeDigest,
    splits: [selectedSplit],
    case_ids: plan.case_ids,
    cases: expectedCases,
  };
  if (!deepEqual(plan, expectedPlan)) throw new ManifestError("execution plan does not match the manifest-derived contract");
  const assignmentDigests = {};
  const inputCopyDigests = {};
  const expectedAssignmentFiles = {};
  for (const evalCase of expectedCases) {
    const ownership = artifactOwnership(evalCase, expectedProfile);
    for (const arm of evalCase.arms) for (let repeat = 1; repeat <= evalCase.repeats; repeat += 1) {
      let configuration;
      if (arm === "without_skill") configuration = { kind: "without_skill", skill_path: null, snapshot_digest: null, source_digest: null };
      else {
        const snapshot = expectedSnapshots[`${evalCase.id}/${arm}/repeat-${repeat}`];
        configuration = { kind: arm, skill_path: snapshot.path, snapshot_digest: snapshot.digest, source_digest: snapshot.source_digest };
      }
      const repeatRoot = join(resolvedWorkspace, "cases", String(evalCase.id), String(arm), `repeat-${repeat}`);
      const inputFiles = [];
      for (const record of evalCase.files ?? []) {
        const inputRelative = `inputs/${evalCase.id}/${arm}/repeat-${repeat}/package/${record.path}`;
        const isolated = join(resolvedWorkspace, inputRelative);
        if (!existsSync(isolated) || !statSync(isolated).isFile() || sha256RuntimeFile(isolated) !== record.digest) throw new ManifestError(`locked isolated input changed: ${inputRelative}`);
        inputCopyDigests[inputRelative] = record.digest;
        inputFiles.push({ relative_path: record.path, path: isolated, digest: record.digest });
      }
      const assignmentRelative = `assignments/${evalCase.id}/${arm}/repeat-${repeat}.json`;
      const assignmentPath = join(resolvedWorkspace, assignmentRelative);
      const expectedAssignment = {
        contract: ASSIGNMENT_CONTRACT,
        run_id: expectedRunId,
        case_id: evalCase.id,
        arm,
        repeat,
        repeat_count: evalCase.repeats,
        prompt: evalCase.prompt,
        timeout_seconds: evalCase.timeout_seconds,
        configuration,
        input_files: inputFiles,
        readable_paths: [...(configuration.skill_path ? [configuration.skill_path] : []), ...inputFiles.map((record) => record.path)],
        permissions: evalCase.permissions,
        agent_adapter_id: expectedProfile.adapter_id,
        execution_profile_digest: expectedProfile.digest,
        writable_root: resolveCanonicalPath(repeatRoot),
        execution_artifact: "execution.json",
        dispatch_artifact: "dispatch-receipt.json",
        source_trace_artifact: expectedProfile.trace.source?.artifact ?? null,
        trace_artifact: "agent-trace.jsonl",
        artifact_ownership: ownership,
        expected_artifacts: ownership.worker,
      };
      if (!existsSync(assignmentPath) || !statSync(assignmentPath).isFile() || !deepEqual(loadJson(assignmentPath), expectedAssignment)) throw new ManifestError(`executor assignment does not match pinned inputs: ${assignmentRelative}`);
      const digest = sha256File(assignmentPath);
      assignmentDigests[assignmentRelative] = digest;
      expectedAssignmentFiles[assignmentRelative.slice("assignments/".length)] = digest;
    }
  }
  if (!deepEqual(strictTreeFileDigests(join(resolvedWorkspace, "assignments")), expectedAssignmentFiles)) throw new ManifestError("assignment tree contains undeclared files");
  const fixtureDigests = Object.fromEntries(expectedCasesWithoutArms.flatMap((evalCase) => (evalCase.files ?? []).map((record) => [record.path, record.digest])));
  const expectedLock = {
    contract: RUN_LOCK_CONTRACT,
    run_id: expectedRunId,
    plan_digest: sha256File(resolvedPlanPath),
    manifest_digest: manifestDigest,
    subject_digest: subjectDigest,
    baseline: expectedBaseline,
    authority,
    execution_profile: expectedProfile,
    holdout: holdoutResolution.holdout,
    skill_snapshot_digests: expectedSnapshotDigests,
    skill_snapshot_tree_digest: snapshotTreeDigest,
    input_tree_digest: inputTreeDigest,
    fixture_digests: fixtureDigests,
    assignment_digests: assignmentDigests,
    input_copy_digests: inputCopyDigests,
  };
  if (!deepEqual(lock, expectedLock)) throw new ManifestError("run lock does not match the manifest-derived contract");
  return {
    locked: true,
    verified: true,
    run_lock: lockPath,
    run_lock_digest: sha256File(lockPath),
    plan_digest: expectedLock.plan_digest,
    authority_digest: authority.digest,
  };
}

export function prepareAgentCell({ assignmentPath, workspace, adapterId }) {
  const resolvedWorkspace = realpathSync(workspace);
  const resolvedAssignmentPath = realpathSync(assignmentPath);
  const { assignment, repeatRoot, tracePath } = traceAssignmentContext({
    assignmentPath: resolvedAssignmentPath,
    workspace: resolvedWorkspace,
  });
  const planPath = join(resolvedWorkspace, "execution-plan.json");
  const lockPath = join(resolvedWorkspace, "run-lock.json");
  if (!existsSync(planPath) || !statSync(planPath).isFile() || !existsSync(lockPath) || !statSync(lockPath).isFile()) {
    throw new ManifestError("agent executor requires execution-plan.json and run-lock.json");
  }
  const plan = loadJson(planPath);
  verifyLockedInputs({ planPath, workspace: resolvedWorkspace, plan });
  const profile = plan.execution_profile;
  if (!plainObject(profile)) {
    throw new ManifestError("execution plan is missing its execution profile");
  }
  if (
    profile.digest !== assignment.execution_profile_digest
    || profile.adapter_id !== assignment.agent_adapter_id
  ) {
    throw new ManifestError("assignment execution profile binding is stale");
  }
  if (profile.adapter_id !== adapterId) {
    throw new ManifestError("requested agent adapter does not match the locked execution profile");
  }
  if (profile.dispatch_observation !== "process_spawn") {
    throw new ManifestError("local agent execution requires dispatch_observation=process_spawn");
  }
  if (profile.isolation !== "local-unattested") {
    throw new ManifestError("local agent execution requires isolation=local-unattested");
  }

  const entry = loadRegisteredAgentAdapter(adapterId);
  const adapterProfile = entry.profile;
  const adapterBinding = profile.adapter_binding;
  if (!plainObject(adapterBinding) || adapterBinding.registry_entry_digest !== sha256Json(entry)) {
    throw new ManifestError("locked execution profile agent adapter binding is stale");
  }
  const expectedTrace = {
    capture_source: adapterProfile.capture_source,
    source: {
      artifact: adapterProfile.source_artifact,
      format: adapterProfile.source_format,
    },
  };
  if (
    profile.target !== adapterProfile.target
    || profile.harness !== adapterProfile.harness
    || !deepEqual(profile.trace, expectedTrace)
  ) {
    throw new ManifestError("locked execution profile does not match the registered agent adapter");
  }
  if (!Array.isArray(profile.capabilities) || !Array.isArray(adapterProfile.required_capabilities)) {
    throw new ManifestError("agent adapter capability binding is invalid");
  }
  const missing = adapterProfile.required_capabilities.filter(
    (capability) => !profile.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    throw new ManifestError(
      `locked execution profile is missing adapter capabilities: ${missing.join(", ")}`,
    );
  }

  const generatedArtifacts = [
    assignment.execution_artifact,
    assignment.dispatch_artifact,
    adapterProfile.source_artifact,
    adapterProfile.stderr_artifact,
  ];
  if (!generatedArtifacts.every((value) => typeof value === "string")) {
    throw new ManifestError("agent adapter artifact binding is invalid");
  }
  const generated = [
    tracePath,
    ...generatedArtifacts.map((artifact) => safeArtifact(repeatRoot, artifact)),
  ];
  for (const path of generated) {
    if (lstatMaybe(path)) throw new ManifestError(`executor output already exists: ${path.split(sep).at(-1)}`);
  }
  if (!Array.isArray(assignment.expected_artifacts) || !assignment.expected_artifacts.every((value) => typeof value === "string")) {
    throw new ManifestError("assignment.expected_artifacts must be a string array");
  }
  for (const relativePath of assignment.expected_artifacts) {
    const artifact = safeArtifact(repeatRoot, relativePath);
    if (lstatMaybe(artifact)) {
      throw new ManifestError(`expected artifact already exists before execution: ${relativePath}`);
    }
    mkdirSync(dirname(artifact), { recursive: true });
  }
  return {
    assignment,
    assignment_path: resolvedAssignmentPath,
    repeat_root: repeatRoot,
    trace_path: tracePath,
    profile,
    adapter: { ...entry, registry_entry_digest: sha256Json(entry) },
  };
}

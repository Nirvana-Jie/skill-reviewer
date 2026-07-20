/** Project immutable Eval evidence into the Dashboard decision read model. */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
  loadJson,
  lockedSkillSnapshotPath,
  runtimeSkillFileDigests,
  safeArtifact,
  safeSubjectFile,
  sha256File,
  sha256Json,
  verifyLockedInputs,
  writeJson,
} from "./skill-eval-authority.mjs";
import {
  DASHBOARD_CONTRACT,
  DASHBOARD_DIFF_CONTRACT,
  ManifestError,
  PLAN_CONTRACT,
} from "./skill-eval-contracts.mjs";
import { loadDashboardDecisionContext } from "./skill-eval-decision.mjs";
import {
  gradeRun,
  RESERVED_ARM_RESULT_FIELDS,
} from "./skill-eval-grading.mjs";

const DASHBOARD_DIFF_RENDER_LIMIT_BYTES = 512 * 1024;
const DASHBOARD_EVIDENCE_SOURCE_LIMIT_BYTES = 2 * 1024 * 1024;

const DASHBOARD_PASS_STATUSES = new Set([
  "accepted",
  "audit-passed",
  "behavior-verified",
  "passed",
  "regression-verified",
  "retained",
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(value, key, fallback = null) {
  return plainObject(value) && Object.hasOwn(value, key) ? value[key] : fallback;
}

function compatibilityScalarString(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasRuntimeValue(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (plainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function discoverLocalDecisions(workspace) {
  const decisions = new Set();
  for (const entryName of readdirSync(workspace)) {
    if (!entryName.startsWith("iteration-")) continue;
    const entry = join(workspace, entryName);
    const metadata = lstatSync(entry);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || realpathSync(entry) !== entry) {
      throw new ManifestError(`dashboard iteration path must be a canonical directory: ${entry}`);
    }
    for (const artifactName of readdirSync(entry)) {
      if (!artifactName.endsWith("decision.json")) continue;
      const artifact = join(entry, artifactName);
      const artifactMetadata = lstatSync(artifact);
      if (
        artifactMetadata.isSymbolicLink()
        || !artifactMetadata.isFile()
        || realpathSync(artifact) !== artifact
      ) {
        throw new ManifestError(`dashboard decision path must be a canonical file: ${artifact}`);
      }
      decisions.add(artifact);
    }
  }
  return decisions;
}

function armMetrics(arm) {
  return Object.fromEntries(
    Object.entries(arm).filter(
      ([key, value]) => !RESERVED_ARM_RESULT_FIELDS.has(key) && typeof value === "number",
    ),
  );
}

function prepareDashboardDiffPayloadRoot(workspace) {
  const payloadRoot = join(workspace, "dashboard-diffs");
  if (existsSync(payloadRoot)) {
    const metadata = lstatSync(payloadRoot);
    if (
      metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || realpathSync(payloadRoot) !== payloadRoot
    ) {
      throw new ManifestError("dashboard diff payload root must be a canonical directory");
    }
    for (const entryName of readdirSync(payloadRoot)) {
      const entry = join(payloadRoot, entryName);
      const entryMetadata = lstatSync(entry);
      if (
        entryMetadata.isSymbolicLink()
        || !entryMetadata.isFile()
        || realpathSync(dirname(entry)) !== payloadRoot
        || !/^[a-f0-9]{24}\.json$/.test(entryName)
      ) {
        throw new ManifestError("dashboard diff payload root contains an invalid entry");
      }
    }
  } else {
    mkdirSync(payloadRoot);
  }
  return payloadRoot;
}

function dashboardDiffText(path) {
  const size = statSync(path).size;
  if (size > DASHBOARD_DIFF_RENDER_LIMIT_BYTES) return [null, size];
  const raw = readFileSync(path);
  if (raw.length > DASHBOARD_DIFF_RENDER_LIMIT_BYTES) {
    throw new ManifestError("dashboard diff source grew while projecting");
  }
  try {
    return [new TextDecoder("utf-8", { fatal: true }).decode(raw), raw.length];
  } catch {
    return [null, raw.length];
  }
}

function dashboardSkillDiffs(plan, { workspace }) {
  const payloadRoot = prepareDashboardDiffPayloadRoot(workspace);
  if (valueAt(valueAt(plan, "baseline", {}), "kind") !== "old_skill") return [];
  const oldSnapshot = lockedSkillSnapshotPath(plan, "old_skill");
  const newSnapshot = lockedSkillSnapshotPath(plan, "with_skill");
  const oldFiles = Object.fromEntries(
    Object.entries(runtimeSkillFileDigests(oldSnapshot)).filter(([path]) => !path.endsWith("/")),
  );
  const newFiles = Object.fromEntries(
    Object.entries(runtimeSkillFileDigests(newSnapshot)).filter(([path]) => !path.endsWith("/")),
  );
  const rows = [];
  const paths = [...new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)])].sort();
  for (const relativePath of paths) {
    const oldDigest = valueAt(oldFiles, relativePath);
    const newDigest = valueAt(newFiles, relativePath);
    if (oldDigest === newDigest) continue;
    const status = oldDigest === null ? "added" : newDigest === null ? "removed" : "modified";
    let binary = false;
    let oversized = false;
    const contents = { old: "", new: "" };
    const sizes = { old: 0, new: 0 };
    for (const [side, snapshot, digest] of [
      ["old", oldSnapshot, oldDigest],
      ["new", newSnapshot, newDigest],
    ]) {
      if (digest === null) continue;
      const source = safeSubjectFile(snapshot, relativePath, `dashboard ${side} diff source`);
      const [content, size] = dashboardDiffText(source);
      sizes[side] = size;
      if (size > DASHBOARD_DIFF_RENDER_LIMIT_BYTES) oversized = true;
      else if (content === null) binary = true;
      else contents[side] = content;
    }
    const diffId = sha256Json({
      path: relativePath,
      old_digest: oldDigest,
      new_digest: newDigest,
    }).slice(0, 24);
    const renderMode = oversized ? "summary" : binary ? "binary" : "lazy";
    const contentUrl = renderMode === "lazy" ? `/dashboard-diffs/${diffId}.json` : null;
    let payloadDigest = null;
    if (contentUrl !== null) {
      const payloadPath = join(payloadRoot, `${diffId}.json`);
      writeJson(payloadPath, {
        contract: DASHBOARD_DIFF_CONTRACT,
        id: diffId,
        path: relativePath,
        old_digest: oldDigest,
        new_digest: newDigest,
        old_content: contents.old,
        new_content: contents.new,
      });
      payloadDigest = sha256File(payloadPath);
    }
    rows.push({
      id: diffId,
      path: relativePath,
      status,
      old_digest: oldDigest,
      new_digest: newDigest,
      old_size: sizes.old,
      new_size: sizes.new,
      binary,
      render_mode: renderMode,
      content_url: contentUrl,
      payload_digest: payloadDigest,
      summary: oversized
        ? `Interactive preview omitted because one side exceeds ${DASHBOARD_DIFF_RENDER_LIMIT_BYTES} bytes; full evidence remains bound by digest.`
        : binary
          ? "Binary content is retained by digest and is not rendered."
          : null,
    });
  }
  return rows;
}

function dashboardEvidenceFields({ workspace, nodeId, relativePath, visible }) {
  if (!visible) return { content_unavailable_reason: "opaque" };
  if (isAbsolute(relativePath)) return {};
  const artifactPath = safeArtifact(workspace, relativePath);
  if (!isFile(artifactPath)) return {};
  const size = statSync(artifactPath).size;
  if (size > DASHBOARD_EVIDENCE_SOURCE_LIMIT_BYTES) {
    return { content_size: size, content_unavailable_reason: "too_large" };
  }
  const raw = readFileSync(artifactPath);
  if (raw.length !== size) {
    throw new ManifestError("dashboard evidence source changed while projecting");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { content_size: size, content_unavailable_reason: "binary" };
  }
  const routeId = sha256Bytes(Buffer.from(nodeId, "utf8")).slice(0, 24);
  return {
    content_url: `/dashboard-evidence/${routeId}.json`,
    content_digest: sha256Bytes(raw),
    content_size: size,
  };
}

function dashboardDecisionSupport({ state, decisions, caseRows }) {
  const selectionDecision = [...decisions]
    .reverse()
    .find((decision) => valueAt(decision, "phase") === "selection") ?? null;
  const decisionStatus = plainObject(selectionDecision)
    ? compatibilityScalarString(valueAt(selectionDecision, "status"))
    : "pending";
  const hardGates = plainObject(selectionDecision)
    ? (valueAt(selectionDecision, "hard_gates", []) ?? []).filter(plainObject)
    : [];
  const objectives = plainObject(selectionDecision)
    ? (valueAt(selectionDecision, "objectives", []) ?? []).filter(plainObject)
    : [];
  const primaryObjectives = objectives.filter((objective) => valueAt(objective, "primary") !== false);
  const objectiveNonRegression = plainObject(selectionDecision)
    ? valueAt(
        selectionDecision,
        "objective_non_regression",
        valueAt(selectionDecision, "pareto_admissible"),
      )
    : null;
  const hardGatesPassed = hardGates.filter((gate) => valueAt(gate, "passed") === true).length;
  const nonRegressed = objectives.filter((objective) => valueAt(objective, "non_regressed") === true).length;
  const materiallyImproved = primaryObjectives.filter(
    (objective) => valueAt(objective, "materially_improved") === true,
  ).length;

  const criterionStatus = ({ passed, total }) => {
    if (passed === null || passed === undefined || total === 0) return "pending";
    return passed ? "satisfied" : "failed";
  };

  const acceptance = {
    status: decisionStatus,
    accepted: plainObject(selectionDecision) ? valueAt(selectionDecision, "accepted") : null,
    decision_run_id: plainObject(selectionDecision) ? valueAt(selectionDecision, "run_id") : null,
    objectives: objectives.map((objective) => ({
      case_id: compatibilityScalarString(valueAt(objective, "case_id")),
      id: compatibilityScalarString(valueAt(objective, "id")),
      metric: compatibilityScalarString(valueAt(objective, "metric")),
      direction: valueAt(objective, "direction") === "minimize" ? "minimize" : "maximize",
      primary: valueAt(objective, "primary") !== false,
      delta: finiteNumberOrNull(valueAt(objective, "delta")),
      paired_deltas: (valueAt(objective, "paired_deltas", []) ?? [])
        .map(finiteNumberOrNull)
        .filter((value) => value !== null),
      repeat_count: Number.isInteger(valueAt(objective, "repeat_count"))
        ? valueAt(objective, "repeat_count")
        : 0,
      non_regression_tolerance: finiteNumberOrNull(
        valueAt(objective, "non_regression_tolerance"),
      ) ?? 0,
      min_material_delta: finiteNumberOrNull(valueAt(objective, "min_material_delta")) ?? 0,
      non_regressed: valueAt(objective, "non_regressed") === true,
      materially_improved: valueAt(objective, "materially_improved") === true,
    })),
    criteria: [
      {
        id: "hard_gates",
        status: criterionStatus({
          passed: plainObject(selectionDecision) ? valueAt(selectionDecision, "hard_gates_passed") : null,
          total: hardGates.length,
        }),
        passed: hardGatesPassed,
        total: hardGates.length,
        evidence_ids: hardGates.map((gate) => `gate:${compatibilityScalarString(valueAt(gate, "id"))}`),
      },
      {
        // v3 wire compatibility: the UI labels this objective non-regression.
        id: "pareto",
        status: criterionStatus({
          passed: objectiveNonRegression,
          total: objectives.length,
        }),
        passed: nonRegressed,
        total: objectives.length,
        evidence_ids: objectives.map(
          (objective) => `case:${compatibilityScalarString(valueAt(objective, "case_id"))}`,
        ),
      },
      {
        id: "material_improvement",
        status: criterionStatus({
          passed: plainObject(selectionDecision) ? valueAt(selectionDecision, "material_improvement") : null,
          total: primaryObjectives.length,
        }),
        passed: materiallyImproved,
        total: primaryObjectives.length,
        evidence_ids: primaryObjectives.map(
          (objective) => `case:${compatibilityScalarString(valueAt(objective, "case_id"))}`,
        ),
      },
    ],
  };

  const nextAction = state ? compatibilityScalarString(valueAt(state, "next_action")) : "review_evidence";
  const signals = {
    skill: [],
    eval: [],
    execution_environment: [],
    evidence: [],
    human: [],
  };
  const evidenceIds = Object.fromEntries(Object.keys(signals).map((key) => [key, new Set()]));
  for (const caseRow of caseRows) {
    const caseId = compatibilityScalarString(valueAt(caseRow, "id"));
    const arms = (valueAt(caseRow, "arms", []) ?? []).filter(plainObject);
    const candidate = arms.find((arm) => valueAt(arm, "id") === "with_skill") ?? null;
    const measurement = valueAt(caseRow, "measurement");
    const measurementValid = plainObject(measurement) && valueAt(measurement, "status") === "valid";
    if (!measurementValid) {
      const status = plainObject(measurement)
        ? compatibilityScalarString(valueAt(measurement, "status"))
        : "unverified";
      signals.eval.push(`measurement_${status}`);
      evidenceIds.eval.add(`case:${caseId}`);
    }
    if (arms.some((arm) => hasRuntimeValue(valueAt(arm, "binding_errors")))) {
      signals.execution_environment.push("binding_error");
      evidenceIds.execution_environment.add(`case:${caseId}`);
    }
    if (!plainObject(candidate) || valueAt(candidate, "complete") !== true) {
      signals.evidence.push("candidate_evidence_incomplete");
      evidenceIds.evidence.add(`case:${caseId}`);
    } else if (valueAt(candidate, "passed") !== true && measurementValid) {
      signals.skill.push("required_assertion_failed");
      evidenceIds.skill.add(`case:${caseId}`);
    }
    if (
      plainObject(candidate)
      && (hasRuntimeValue(valueAt(candidate, "forbidden_actions")) || hasRuntimeValue(valueAt(candidate, "side_effects")))
    ) {
      signals.skill.push("unsafe_behavior_observed");
      evidenceIds.skill.add(`case:${caseId}`);
    }
    if (valueAt(caseRow, "regressed") === true && measurementValid) {
      signals.skill.push("objective_regressed");
      evidenceIds.skill.add(`case:${caseId}`);
    }
    if (valueAt(caseRow, "direction_disagreement") === true) {
      signals.skill.push("paired_repeat_variability");
      evidenceIds.skill.add(`case:${caseId}`);
    }
    if (hasRuntimeValue(valueAt(caseRow, "missing_objective_metrics"))) {
      signals.eval.push("objective_metric_unavailable");
      evidenceIds.eval.add(`case:${caseId}`);
    }
    for (const arm of arms) {
      if (valueAt(arm, "id") !== "with_skill" && valueAt(arm, "complete") !== true) {
        signals.evidence.push("baseline_evidence_incomplete");
        evidenceIds.evidence.add(`case:${caseId}`);
      }
    }
  }

  if (plainObject(selectionDecision)) {
    const decisionMeasurementValid = valueAt(selectionDecision, "measurement_validity") === "valid";
    if (
      decisionMeasurementValid
      && objectiveNonRegression === false
      && objectives.length > 0
    ) {
      signals.skill.push("objective_regression");
      for (const objective of objectives) {
        evidenceIds.skill.add(`case:${compatibilityScalarString(valueAt(objective, "case_id"))}`);
      }
    }
    if (
      decisionMeasurementValid
      && valueAt(selectionDecision, "material_improvement") === false
      && primaryObjectives.length > 0
    ) {
      signals.skill.push("material_improvement_missing");
      for (const objective of primaryObjectives) {
        evidenceIds.skill.add(`case:${compatibilityScalarString(valueAt(objective, "case_id"))}`);
      }
    }
    if (objectives.length === 0) signals.eval.push("objective_evidence_missing");
    for (const gate of hardGates) {
      if (valueAt(gate, "passed") === true) continue;
      const gateId = compatibilityScalarString(valueAt(gate, "id"));
      if (gateId === "measurement:valid") {
        signals.eval.push("measurement_gate_failed");
        evidenceIds.eval.add(`gate:${gateId}`);
      } else if (gateId.endsWith(":metric-present")) {
        signals.eval.push("declared_metric_missing");
        evidenceIds.eval.add(`gate:${gateId}`);
      } else if (gateId.includes(":paired-") || gateId.endsWith(":evidence-present")) {
        signals.evidence.push("paired_evidence_missing");
        evidenceIds.evidence.add(`gate:${gateId}`);
      }
    }
  }

  if (nextAction === "request_user_release") signals.human.push("release_confirmation_required");
  for (const category of Object.keys(signals)) signals[category] = [...new Set(signals[category])].sort();

  const primaryAttribution = signals.human.length > 0
    ? "human"
    : signals.execution_environment.length > 0
      ? "execution_environment"
      : signals.evidence.length > 0
        ? "evidence"
        : signals.skill.length > 0
          ? "skill"
          : signals.eval.length > 0
            ? "eval"
            : null;

  const attributionItems = [];
  for (const category of ["skill", "eval", "execution_environment", "evidence", "human"]) {
    const status = category === primaryAttribution
      ? category === "human" ? "waiting" : "primary"
      : signals[category].length > 0 ? "contributing" : "clear";
    attributionItems.push({
      id: category,
      status,
      signals: signals[category],
      evidence_ids: [...evidenceIds[category]].sort(),
    });
  }

  const continuation = nextAction === "propose_eval_change"
    ? { mode: "human_required", owner: "human", reason: "eval_change_confirmation" }
    : nextAction === "request_user_release"
      ? { mode: "human_required", owner: "human", reason: "release_confirmation" }
      : nextAction === "review_evidence"
        ? { mode: "human_required", owner: "human", reason: "evidence_review" }
        : nextAction === "stop"
          ? { mode: "stopped", owner: "lead_agent", reason: "terminal_state" }
          : { mode: "automatic", owner: "lead_agent", reason: "within_locked_authority" };

  return {
    next_action: nextAction,
    owner: "lead_agent",
    continuation,
    acceptance,
    attribution: { primary: primaryAttribution, items: attributionItems },
  };
}

function dashboardStatusPassed(status) {
  return DASHBOARD_PASS_STATUSES.has(compatibilityScalarString(status).toLowerCase());
}

function dashboardCaseIdForGate(gateLabel, caseIds) {
  const label = compatibilityScalarString(gateLabel);
  const matches = caseIds.filter((caseId) => label === caseId || label.startsWith(`${caseId}:`));
  if (matches.length === 0) return null;
  return matches.reduce((longest, candidate) => candidate.length > longest.length ? candidate : longest);
}

function dashboardOrderSpine(spine, caseRows) {
  const caseIds = caseRows.map((row) => compatibilityScalarString(valueAt(row, "id")));
  for (const node of spine) {
    if (valueAt(node, "kind") !== "gate") continue;
    const declaredCaseId = valueAt(node, "case_id");
    const caseId = caseIds.includes(declaredCaseId)
      ? compatibilityScalarString(declaredCaseId)
      : dashboardCaseIdForGate(valueAt(node, "label"), caseIds);
    if (caseId !== null) {
      node.case_id = caseId;
      node.parent_id = `case:${caseId}`;
    }
  }

  const nodesByParent = new Map();
  spine.forEach((node, index) => {
    const parentId = valueAt(node, "parent_id");
    const key = parentId === null ? null : compatibilityScalarString(parentId);
    if (!nodesByParent.has(key)) nodesByParent.set(key, []);
    nodesByParent.get(key).push([index, node]);
  });
  const kindPriority = {
    run: 0,
    case: 1,
    gate: 2,
    assertion: 3,
    artifact: 4,
    iteration: 5,
  };
  const armPriority = { with_skill: 0, old_skill: 1, without_skill: 2 };
  const orderKey = ([index, node]) => {
    const kind = compatibilityScalarString(valueAt(node, "kind"));
    const arm = valueAt(node, "arm");
    const failedFirst = dashboardStatusPassed(valueAt(node, "status")) ? 1 : 0;
    if (new Set(["assertion", "artifact"]).has(kind) && typeof arm === "string") {
      return [3, valueAt(armPriority, arm, 90), kind === "assertion" ? 0 : 1, failedFirst, index];
    }
    return [valueAt(kindPriority, kind, 99), 99, 0, failedFirst, index];
  };
  const compareKeys = (left, right) => {
    const leftKey = orderKey(left);
    const rightKey = orderKey(right);
    for (let index = 0; index < leftKey.length; index += 1) {
      if (leftKey[index] !== rightKey[index]) return leftKey[index] - rightKey[index];
    }
    return 0;
  };

  const ordered = [];
  const visited = new Set();
  const visit = (node) => {
    const nodeId = compatibilityScalarString(valueAt(node, "id"));
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    ordered.push(node);
    for (const [, child] of [...(nodesByParent.get(nodeId) ?? [])].sort(compareKeys)) visit(child);
  };
  for (const [, root] of [...(nodesByParent.get(null) ?? [])].sort(compareKeys)) visit(root);
  for (const [, node] of spine.map((node, index) => [index, node]).sort(compareKeys)) visit(node);
  return ordered;
}

function dashboardReviewOutline({ spine, caseRows, releaseEligible, decisionSupport }) {
  const nodesById = new Map(spine.map((node) => [compatibilityScalarString(valueAt(node, "id")), node]));
  const nodesByParent = new Map();
  for (const node of spine) {
    const parentId = valueAt(node, "parent_id");
    if (parentId === null) continue;
    const key = compatibilityScalarString(parentId);
    if (!nodesByParent.has(key)) nodesByParent.set(key, []);
    nodesByParent.get(key).push(node);
  }
  const scenarioRows = [];
  const blockers = [];
  const passedGateIds = [];
  const passedCaseIds = [];
  const scopedGateIds = new Set();
  const attribution = valueAt(decisionSupport, "attribution", {});
  const primaryAttribution = plainObject(attribution) ? valueAt(attribution, "primary") : null;
  const nextAction = valueAt(decisionSupport, "next_action");
  const acceptance = valueAt(decisionSupport, "acceptance", {});
  const acceptanceCriteria = plainObject(acceptance) ? valueAt(acceptance, "criteria", []) : [];
  const failedAcceptanceCriteria = acceptanceCriteria.filter(
    (criterion) => plainObject(criterion) && valueAt(criterion, "status") === "failed",
  );

  for (const caseRow of caseRows) {
    const caseId = compatibilityScalarString(valueAt(caseRow, "id"));
    const caseNodeId = `case:${caseId}`;
    const children = nodesByParent.get(caseNodeId) ?? [];
    const gateIds = children
      .filter((node) => valueAt(node, "kind") === "gate")
      .map((node) => compatibilityScalarString(valueAt(node, "id")));
    for (const gateId of gateIds) scopedGateIds.add(gateId);
    const checkIds = children
      .filter((node) => valueAt(node, "kind") === "assertion")
      .map((node) => compatibilityScalarString(valueAt(node, "id")));
    const artifactIds = children
      .filter((node) => valueAt(node, "kind") === "artifact")
      .map((node) => compatibilityScalarString(valueAt(node, "id")));
    const supplementalPaths = new Set(
      children
        .filter((node) => (
          valueAt(node, "kind") === "assertion"
          && valueAt(valueAt(node, "assertion_rule", {}), "severity") === "supplemental"
        ))
        .map((node) => valueAt(node, "path"))
        .filter(hasRuntimeValue)
        .map(compatibilityScalarString),
    );
    const failedGateIds = gateIds.filter(
      (nodeId) => !dashboardStatusPassed(valueAt(nodesById.get(nodeId), "status")),
    );
    const failedCheckIds = checkIds.filter((nodeId) => {
      const node = nodesById.get(nodeId);
      return !dashboardStatusPassed(valueAt(node, "status"))
        && valueAt(valueAt(node, "assertion_rule", {}), "severity") !== "supplemental"
        && new Set([null, "with_skill"]).has(valueAt(node, "arm"));
    });
    const missingArtifactIds = artifactIds.filter((nodeId) => {
      const node = nodesById.get(nodeId);
      return compatibilityScalarString(valueAt(node, "status")).toLowerCase() === "missing"
        && !supplementalPaths.has(compatibilityScalarString(valueAt(node, "path")))
        && new Set([null, "with_skill"]).has(valueAt(node, "arm"));
    });
    const failedPaths = new Set(
      failedCheckIds
        .map((nodeId) => valueAt(nodesById.get(nodeId), "path"))
        .filter(hasRuntimeValue)
        .map(compatibilityScalarString),
    );
    const sourceEvidenceIds = artifactIds.filter((nodeId) => {
      const node = nodesById.get(nodeId);
      return failedPaths.has(compatibilityScalarString(valueAt(node, "path")))
        && compatibilityScalarString(valueAt(node, "status")).toLowerCase() !== "missing";
    });
    scenarioRows.push({
      case_id: caseId,
      status: valueAt(caseRow, "status"),
      gate_ids: gateIds,
      check_ids: checkIds,
      artifact_ids: artifactIds,
    });
    const blocking = !dashboardStatusPassed(valueAt(caseRow, "status"))
      || failedGateIds.length > 0
      || failedCheckIds.length > 0
      || missingArtifactIds.length > 0;
    if (blocking) {
      blockers.push({
        id: `blocker:${caseId}`,
        kind: "scenario",
        case_id: caseId,
        status: failedGateIds.length > 0 || failedCheckIds.length > 0 || missingArtifactIds.length > 0
          ? "failed"
          : valueAt(caseRow, "status"),
        gate_ids: failedGateIds,
        failed_check_ids: failedCheckIds,
        missing_artifact_ids: missingArtifactIds,
        source_evidence_ids: sourceEvidenceIds,
        criterion_ids: [],
        evidence_ids: [
          caseNodeId,
          ...failedGateIds,
          ...failedCheckIds,
          ...missingArtifactIds,
          ...sourceEvidenceIds,
        ],
        attribution: primaryAttribution,
        next_action: nextAction,
      });
    } else {
      passedCaseIds.push(caseNodeId);
    }
    passedGateIds.push(...gateIds.filter(
      (nodeId) => dashboardStatusPassed(valueAt(nodesById.get(nodeId), "status")),
    ));
  }

  const unscopedFailedGates = spine.filter((node) => (
    valueAt(node, "kind") === "gate"
    && !scopedGateIds.has(compatibilityScalarString(valueAt(node, "id")))
    && !dashboardStatusPassed(valueAt(node, "status"))
  ));
  for (const gate of unscopedFailedGates) {
    const gateId = compatibilityScalarString(valueAt(gate, "id"));
    blockers.push({
      id: `blocker:${gateId}`,
      kind: "criterion",
      case_id: null,
      status: valueAt(gate, "status"),
      gate_ids: [gateId],
      failed_check_ids: [],
      missing_artifact_ids: [],
      source_evidence_ids: [],
      criterion_ids: ["hard_gates"],
      evidence_ids: [gateId],
      attribution: primaryAttribution,
      next_action: nextAction,
    });
  }

  const representedHardGate = blockers.some((blocker) => blocker.gate_ids.length > 0);
  for (const criterion of failedAcceptanceCriteria) {
    const criterionId = compatibilityScalarString(valueAt(criterion, "id"));
    if (criterionId === "hard_gates" && representedHardGate) continue;
    const evidenceIds = valueAt(criterion, "evidence_ids", [])
      .map(compatibilityScalarString)
      .filter((nodeId) => nodesById.has(nodeId));
    blockers.push({
      id: `blocker:criterion:${criterionId}`,
      kind: "criterion",
      case_id: null,
      status: "failed",
      gate_ids: [],
      failed_check_ids: [],
      missing_artifact_ids: [],
      source_evidence_ids: [],
      criterion_ids: [criterionId],
      evidence_ids: evidenceIds,
      attribution: primaryAttribution,
      next_action: nextAction,
    });
  }

  const scenarioBlockers = blockers.filter((blocker) => valueAt(blocker, "kind") === "scenario");
  const criterionBlockers = blockers.filter((blocker) => valueAt(blocker, "kind") === "criterion");
  const measurementInvalid = caseRows.some((caseRow) => {
    const measurement = valueAt(caseRow, "measurement");
    return !plainObject(measurement) || valueAt(measurement, "status") !== "valid";
  });

  let decisionStatus;
  let decisionReason;
  if (releaseEligible) {
    decisionStatus = "ready";
    decisionReason = "release_conditions_met";
  } else if (measurementInvalid) {
    decisionStatus = "inconclusive";
    decisionReason = "measurement_invalid";
  } else if (blockers.some((blocker) => blocker.gate_ids.length > 0)) {
    decisionStatus = "blocked";
    decisionReason = "release_gate_failed";
  } else if (scenarioBlockers.length > 0) {
    decisionStatus = "blocked";
    decisionReason = "scenario_failed";
  } else if (criterionBlockers.length > 0) {
    decisionStatus = "blocked";
    decisionReason = "candidate_acceptance_failed";
  } else if (new Set(["prepare_audit", "run_authorized_audit"]).has(nextAction)) {
    decisionStatus = "inconclusive";
    decisionReason = "audit_required";
  } else {
    decisionStatus = "inconclusive";
    decisionReason = "evidence_incomplete";
  }

  return {
    contract: "skill-reviewer.dashboard-review",
    decision: {
      status: decisionStatus,
      reason: decisionReason,
      release_eligible: releaseEligible,
      blocking_scenario_count: scenarioBlockers.filter((blocker) => valueAt(blocker, "case_id") !== null).length,
      blocking_gate_count: blockers.reduce((count, blocker) => count + blocker.gate_ids.length, 0),
    },
    blockers,
    safeguards: { passed_gate_ids: passedGateIds, passed_case_ids: passedCaseIds },
    scenarios: scenarioRows,
    next_action: nextAction,
    attribution: primaryAttribution,
  };
}

function dashboardReleaseEligible(decision) {
  return plainObject(decision)
    && valueAt(decision, "phase") === "audit"
    && valueAt(decision, "status") === "accepted"
    && valueAt(decision, "accepted") === true
    && valueAt(decision, "release_eligible") === true;
}

function hasExecutionArtifacts(workspace) {
  const root = join(workspace, "cases");
  if (!existsSync(root)) return false;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entryName of readdirSync(current)) {
      const entry = join(current, entryName);
      const metadata = lstatSync(entry);
      if (entryName === "execution.json" && (metadata.isFile() || metadata.isSymbolicLink())) return true;
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) pending.push(entry);
    }
  }
  return false;
}

export function projectDashboard({ workspace, output, statePath = null }) {
  workspace = realpathSync(resolve(workspace));
  const unresolvedOutput = resolve(output);
  output = join(realpathSync(dirname(unresolvedOutput)), basename(unresolvedOutput));
  if (output !== join(workspace, "dashboard-data.json")) {
    throw new ManifestError("dashboard output must be the run workspace dashboard-data.json");
  }
  const planPath = join(workspace, "execution-plan.json");
  const plan = loadJson(planPath);
  if (valueAt(plan, "contract") !== PLAN_CONTRACT) {
    throw new ManifestError(`execution plan contract must be ${PLAN_CONTRACT}`);
  }
  const projectedIntegrity = verifyLockedInputs({ planPath, workspace, plan });
  const evidencePath = join(workspace, "verification-evidence.json");
  const localDecisionPaths = discoverLocalDecisions(workspace);
  const evidence = isFile(evidencePath) || localDecisionPaths.size > 0 || hasExecutionArtifacts(workspace)
    ? gradeRun({ planPath, workspace, persist: false })
    : null;
  const decisionContext = loadDashboardDecisionContext({
    plan,
    planPath,
    workspace,
    statePath,
    localDecisionPaths,
  });
  const state = decisionContext.state;
  const decisions = decisionContext.decisions;
  const latestDecision = decisionContext.latestDecision;
  const evidenceCases = new Map(
    (valueAt(evidence, "cases", []) ?? [])
      .filter(plainObject)
      .map((item) => [compatibilityScalarString(valueAt(item, "id")), item]),
  );
  const plannedCaseIds = (valueAt(plan, "cases", []) ?? [])
    .filter(plainObject)
    .map((item) => compatibilityScalarString(valueAt(item, "id")));

  const runId = valueAt(plan, "run_id");
  const runNodeId = `run:${compatibilityScalarString(runId)}`;
  const spine = [{
    id: runNodeId,
    kind: "run",
    parent_id: null,
    label: compatibilityScalarString(runId),
    status: state
      ? valueAt(state, "status")
      : latestDecision
        ? valueAt(latestDecision, "status")
        : valueAt(evidence, "level", "planned"),
  }];
  if (latestDecision) {
    for (const gate of valueAt(latestDecision, "hard_gates", [])) {
      if (!plainObject(gate)) continue;
      const gateId = compatibilityScalarString(valueAt(gate, "id"));
      const gateCaseId = dashboardCaseIdForGate(gateId, plannedCaseIds);
      spine.push({
        id: `gate:${gateId}`,
        kind: "gate",
        parent_id: gateCaseId !== null ? `case:${gateCaseId}` : runNodeId,
        case_id: gateCaseId,
        label: gateId,
        status: valueAt(gate, "passed") === true ? "passed" : "failed",
        detail: valueAt(gate, "reason"),
      });
    }
  } else if (evidence && plainObject(valueAt(evidence, "integrity"))) {
    spine.push({
      id: "gate:integrity",
      kind: "gate",
      parent_id: runNodeId,
      label: "Frozen inputs",
      status: valueAt(valueAt(evidence, "integrity"), "verified") === true ? "passed" : "failed",
    });
  }
  for (const decision of decisions) {
    const decisionRunId = compatibilityScalarString(valueAt(decision, "run_id"));
    const decisionNodeId = `iteration:${decisionRunId}:${compatibilityScalarString(valueAt(decision, "iteration"))}:${compatibilityScalarString(valueAt(decision, "phase"))}`;
    const decisionArtifact = valueAt(decision, "artifact");
    const decisionNode = {
      id: decisionNodeId,
      kind: "iteration",
      parent_id: runNodeId,
      label: `Round ${compatibilityScalarString(valueAt(decision, "iteration"))} · ${compatibilityScalarString(valueAt(decision, "phase"))} · ${decisionRunId.slice(-8)}`,
      status: valueAt(decision, "status"),
      artifact: decisionArtifact,
      path: decisionArtifact,
    };
    if (typeof decisionArtifact === "string") {
      Object.assign(decisionNode, dashboardEvidenceFields({
        workspace,
        nodeId: decisionNodeId,
        relativePath: decisionArtifact,
        visible: true,
      }));
    }
    spine.push(decisionNode);
  }

  const caseRows = [];
  for (const plannedCase of valueAt(plan, "cases", [])) {
    const caseId = compatibilityScalarString(valueAt(plannedCase, "id"));
    const holdoutVisibility = valueAt(valueAt(plannedCase, "holdout", {}), "visibility", "public");
    const contentVisible = holdoutVisibility === "public";
    const declaredAssertions = new Map(
      valueAt(plannedCase, "assertions", [])
        .filter(plainObject)
        .map((assertion) => [compatibilityScalarString(valueAt(assertion, "id")), assertion]),
    );
    const result = evidenceCases.get(caseId) ?? {};
    const candidate = valueAt(result, "with_skill");
    const resultMeasurement = valueAt(result, "measurement");
    const caseMeasurement = plainObject(resultMeasurement)
      ? resultMeasurement
      : {
          status: evidence !== null ? "unverified" : "pending",
          oracle: valueAt(plannedCase, "oracle", { status: "unverified", reasons: [] }),
          sampling: {
            ...valueAt(plannedCase, "sampling", {}),
            status: "pending",
            direction_disagreement: false,
          },
          reasons: [],
        };
    const semanticAssertions = valueAt(result, "semantic_assertions", []);
    const pairedBlocked = valueAt(plannedCase, "arms", [])
      .filter((armId) => armId !== "with_skill")
      .some((armId) => {
        const arm = valueAt(result, compatibilityScalarString(armId));
        return !plainObject(arm)
          || valueAt(arm, "complete") !== true
          || hasRuntimeValue(valueAt(arm, "forbidden_actions"))
          || hasRuntimeValue(valueAt(arm, "side_effects"))
          || hasRuntimeValue(valueAt(arm, "binding_errors"));
      });
    let caseStatus;
    if (!plainObject(candidate)) caseStatus = "pending";
    else if (valueAt(caseMeasurement, "status") !== "valid") caseStatus = "measurement-invalid";
    else if (valueAt(candidate, "complete") !== true) caseStatus = "incomplete";
    else if (
      valueAt(candidate, "passed") !== true
      || valueAt(result, "regressed") === true
      || valueAt(result, "direction_disagreement") === true
      || hasRuntimeValue(valueAt(result, "missing_objective_metrics"))
      || pairedBlocked
    ) caseStatus = "failed";
    else caseStatus = "passed";
    const caseNodeId = `case:${caseId}`;
    spine.push({
      id: caseNodeId,
      kind: "case",
      parent_id: runNodeId,
      label: caseId,
      status: caseStatus,
      split: valueAt(plannedCase, "split"),
    });
    const arms = [];
    for (const armIdValue of valueAt(plannedCase, "arms", [])) {
      const armId = compatibilityScalarString(armIdValue);
      const rawArm = valueAt(result, armId);
      const arm = plainObject(rawArm) ? rawArm : {};
      let assertionCount = 0;
      let passedAssertions = 0;
      const executionRows = [];
      const artifactPaths = new Set(
        valueAt(arm, "artifacts", []).filter((value) => typeof value === "string"),
      );
      for (const repeat of valueAt(arm, "repeats", [])) {
        if (!plainObject(repeat)) continue;
        const repeatNumber = valueAt(repeat, "repeat");
        const repeatAssertions = valueAt(repeat, "assertions", []).filter(plainObject);
        const rawTrace = valueAt(repeat, "trace");
        const traceEvents = plainObject(rawTrace) && Array.isArray(valueAt(rawTrace, "events"))
          ? valueAt(rawTrace, "events")
          : [];
        let projectedTrace = null;
        if (plainObject(rawTrace)) {
          const traceCaptureSource = valueAt(rawTrace, "capture_source");
          projectedTrace = Object.fromEntries([
            "artifact",
            "digest",
            "capture_source",
            "source_trace_required",
            "complete",
            "valid",
            "event_count",
            "started_at",
            "finished_at",
            "duration_ms",
          ].map((key) => [key, valueAt(rawTrace, key)]));
          projectedTrace.events = traceEvents.filter(plainObject).map((event, eventIndex) => (
            contentVisible
              ? event
              : {
                  contract: valueAt(event, "contract"),
                  event_id: valueAt(event, "event_id"),
                  run_id: valueAt(event, "run_id"),
                  case_id: valueAt(event, "case_id"),
                  arm: valueAt(event, "arm"),
                  repeat: valueAt(event, "repeat"),
                  sequence: valueAt(event, "sequence"),
                  occurred_at: valueAt(event, "occurred_at"),
                  elapsed_ms: valueAt(event, "elapsed_ms"),
                  kind: valueAt(event, "kind"),
                  status: valueAt(event, "status"),
                  summary: "Opaque holdout event retained; content is hidden.",
                  details: eventIndex === 0 && typeof traceCaptureSource === "string"
                    ? { capture_source: traceCaptureSource }
                    : {},
                  artifact_refs: [],
                }
          ));
        }
        const rawDispatch = valueAt(repeat, "dispatch");
        const projectedDispatch = plainObject(rawDispatch)
          ? Object.fromEntries([
              "artifact",
              "digest",
              "valid",
              "provider",
              "harness",
              "observation",
              "dispatch_id",
              "worker_id",
              "batch_id",
              "dispatched_at",
            ].map((key) => [key, valueAt(rawDispatch, key)]))
          : null;
        const rawSourceTrace = valueAt(repeat, "source_trace");
        const projectedSourceTrace = plainObject(rawSourceTrace)
          ? Object.fromEntries([
              "artifact",
              "digest",
              "valid",
              "adapter",
              "format",
              "source_stream_digest",
              "source_event_count",
              "retained_event_count",
              "redaction",
              "source_agent",
              "registry_entry_digest",
              "runtime_binding_digest",
              "agent_version",
              "executable_digest",
              "argv_digest",
              "parser_id",
              "parser_version",
              "parser_digest",
              "contract_urls",
              "adapter_maturity",
              "source_contract_version",
              "contract_stability",
              "evidence_authority",
            ].map((key) => [key, valueAt(rawSourceTrace, key)]))
          : null;
        executionRows.push({
          repeat: repeatNumber,
          status: valueAt(repeat, "status"),
          binding_error_count: Array.isArray(valueAt(repeat, "binding_errors"))
            ? valueAt(repeat, "binding_errors").length
            : 0,
          execution_digest: valueAt(repeat, "execution_digest"),
          artifact_count: plainObject(valueAt(repeat, "artifact_digests"))
            ? Object.keys(valueAt(repeat, "artifact_digests")).length
            : 0,
          assertions: {
            passed: repeatAssertions.filter((assertion) => valueAt(assertion, "passed") === true).length,
            total: repeatAssertions.length,
          },
          required_pass_rate: valueAt(repeat, "required_pass_rate"),
          metrics: plainObject(valueAt(repeat, "metrics")) ? valueAt(repeat, "metrics") : {},
          dispatch: projectedDispatch,
          source_trace: projectedSourceTrace,
          trace: projectedTrace,
        });
        for (const assertion of valueAt(repeat, "assertions", [])) {
          if (!plainObject(assertion)) continue;
          assertionCount += 1;
          if (valueAt(assertion, "passed") === true) passedAssertions += 1;
          const assertionNodeId = `assertion:${caseId}:${armId}:${compatibilityScalarString(repeatNumber)}:${compatibilityScalarString(valueAt(assertion, "id"))}`;
          const declaredAssertion = declaredAssertions.get(
            compatibilityScalarString(valueAt(assertion, "id")),
          ) ?? {};
          const assertionEvidence = valueAt(assertion, "evidence");
          const assertionPath = plainObject(assertionEvidence)
            && typeof valueAt(assertionEvidence, "artifact") === "string"
            ? `cases/${caseId}/${armId}/repeat-${compatibilityScalarString(repeatNumber)}/${assertionEvidence.artifact}`
            : null;
          const assertionRule = {};
          for (const key of ["severity", "artifact", "expected", "pattern", "rubric", "inputs"]) {
            if (Object.hasOwn(declaredAssertion, key) && (contentVisible || new Set(["severity", "artifact"]).has(key))) {
              assertionRule[key] = declaredAssertion[key];
            }
          }
          const assertionNode = {
            id: assertionNodeId,
            kind: "assertion",
            parent_id: caseNodeId,
            label: compatibilityScalarString(valueAt(assertion, "id")),
            status: valueAt(assertion, "passed") === true ? "passed" : "failed",
            arm: armId,
            repeat: repeatNumber,
            assertion_type: valueAt(assertion, "type"),
            assertion_rule: assertionRule,
            assertion_evidence: contentVisible ? assertionEvidence : {},
            path: assertionPath,
          };
          if (assertionPath !== null) {
            Object.assign(assertionNode, dashboardEvidenceFields({
              workspace,
              nodeId: assertionNodeId,
              relativePath: assertionPath,
              visible: contentVisible,
            }));
          }
          spine.push(assertionNode);
          if (plainObject(assertionEvidence) && typeof valueAt(assertionEvidence, "artifact") === "string") {
            artifactPaths.add(
              `cases/${caseId}/${armId}/repeat-${compatibilityScalarString(repeatNumber)}/${assertionEvidence.artifact}`,
            );
          }
        }
      }
      let artifactIndex = 0;
      for (const artifactPath of [...artifactPaths].sort()) {
        const artifactNodeId = `artifact:${caseId}:${armId}:${artifactIndex}`;
        artifactIndex += 1;
        const artifactExists = isFile(safeArtifact(workspace, artifactPath));
        const artifactNode = {
          id: artifactNodeId,
          kind: "artifact",
          parent_id: caseNodeId,
          label: basename(artifactPath),
          status: artifactExists ? "retained" : "missing",
          arm: armId,
          path: artifactPath,
        };
        Object.assign(artifactNode, dashboardEvidenceFields({
          workspace,
          nodeId: artifactNodeId,
          relativePath: artifactPath,
          visible: contentVisible,
        }));
        spine.push(artifactNode);
      }
      arms.push({
        id: armId,
        complete: valueAt(arm, "complete") === true,
        passed: valueAt(arm, "passed") === true,
        required_pass_rate: valueAt(arm, "required_pass_rate"),
        forbidden_actions: valueAt(arm, "forbidden_actions", []),
        side_effects: valueAt(arm, "side_effects", []),
        binding_errors: valueAt(arm, "binding_errors", []),
        metrics: armMetrics(arm),
        assertions: { passed: passedAssertions, total: assertionCount },
        artifact_count: artifactPaths.size,
        executions: executionRows,
      });
    }

    if (Array.isArray(semanticAssertions)) {
      for (const semantic of semanticAssertions) {
        if (!plainObject(semantic)) continue;
        const semanticId = compatibilityScalarString(valueAt(semantic, "id"));
        const semanticStatus = compatibilityScalarString(valueAt(semantic, "status", "invalid"));
        const semanticNodeId = `assertion:${caseId}:semantic:${semanticId}`;
        const declaredSemantic = declaredAssertions.get(semanticId) ?? {};
        const artifact = valueAt(semantic, "artifact");
        const semanticArtifactPath = typeof artifact === "string" ? `cases/${caseId}/${artifact}` : null;
        const assertionRule = {};
        for (const key of ["severity", "artifact", "rubric", "inputs"]) {
          if (Object.hasOwn(declaredSemantic, key) && (contentVisible || new Set(["severity", "artifact"]).has(key))) {
            assertionRule[key] = declaredSemantic[key];
          }
        }
        const assertionEvidence = {};
        for (const key of [
          "status",
          "passed",
          "preference",
          "reason",
          "resolved_winners",
          "source_event_ids",
        ]) {
          if (contentVisible && Object.hasOwn(semantic, key)) assertionEvidence[key] = semantic[key];
        }
        const semanticNode = {
          id: semanticNodeId,
          kind: "assertion",
          parent_id: caseNodeId,
          label: semanticId,
          status: valueAt(semantic, "passed") === true ? "passed" : semanticStatus,
          assertion_type: "semantic_pair",
          detail: contentVisible ? valueAt(semantic, "reason") : null,
          assertion_rule: assertionRule,
          assertion_evidence: assertionEvidence,
          path: semanticArtifactPath,
        };
        if (semanticArtifactPath !== null) {
          Object.assign(semanticNode, dashboardEvidenceFields({
            workspace,
            nodeId: semanticNodeId,
            relativePath: semanticArtifactPath,
            visible: contentVisible,
          }));
        }
        spine.push(semanticNode);
        if (typeof artifact === "string") {
          const artifactPath = `cases/${caseId}/${artifact}`;
          const artifactNodeId = `artifact:${caseId}:semantic:${semanticId}`;
          const artifactNode = {
            id: artifactNodeId,
            kind: "artifact",
            parent_id: caseNodeId,
            label: basename(artifact),
            status: isFile(join(workspace, artifactPath)) ? "retained" : "missing",
            path: artifactPath,
          };
          Object.assign(artifactNode, dashboardEvidenceFields({
            workspace,
            nodeId: artifactNodeId,
            relativePath: artifactPath,
            visible: contentVisible,
          }));
          spine.push(artifactNode);
        }
      }
    }

    const projectedSemanticAssertions = Array.isArray(semanticAssertions)
      ? contentVisible
        ? semanticAssertions
        : semanticAssertions.filter(plainObject).map((semantic) => {
            const projected = {};
            for (const key of [
              "id",
              "status",
              "passed",
              "preference",
              "artifact",
              "resolved_winners",
              "source_event_ids",
            ]) {
              if (Object.hasOwn(semantic, key)) projected[key] = semantic[key];
            }
            return projected;
          })
      : [];
    caseRows.push({
      id: caseId,
      purpose: valueAt(plannedCase, "purpose"),
      prompt: contentVisible ? valueAt(plannedCase, "prompt") : null,
      input_files: contentVisible
        ? valueAt(plannedCase, "files", []).map((item) => (
            plainObject(item) && typeof valueAt(item, "path") === "string"
              ? item.path
              : compatibilityScalarString(item)
          ))
        : [],
      split: valueAt(plannedCase, "split"),
      determinism: valueAt(plannedCase, "determinism"),
      repeats: valueAt(plannedCase, "repeats"),
      holdout_visibility: holdoutVisibility,
      status: caseStatus,
      measurement: caseMeasurement,
      regressed: valueAt(result, "regressed") === true,
      direction_disagreement: valueAt(result, "direction_disagreement") === true,
      missing_objective_metrics: valueAt(result, "missing_objective_metrics", []),
      arms,
      semantic_assertions: projectedSemanticAssertions,
    });
  }

  const hardGates = latestDecision ? valueAt(latestDecision, "hard_gates", []) : [];
  const rawExecutionProfile = valueAt(plan, "execution_profile");
  let executionProfile = null;
  if (plainObject(rawExecutionProfile)) {
    executionProfile = Object.fromEntries([
      "adapter_id",
      "target",
      "harness",
      "dispatch_observation",
      "trace",
      "capabilities",
      "isolation",
      "sampling",
      "digest",
    ].map((key) => [key, valueAt(rawExecutionProfile, key)]));
    if (plainObject(valueAt(rawExecutionProfile, "adapter_binding"))) {
      executionProfile.adapter_binding = rawExecutionProfile.adapter_binding;
    }
  }
  const rawHoldout = valueAt(plan, "holdout");
  const holdout = plainObject(rawHoldout)
    ? Object.fromEntries(["visibility", "issuer", "digest"].map((key) => [key, valueAt(rawHoldout, key)]))
    : null;
  const lineage = valueAt(state, "candidate_lineage", [])
    .filter(plainObject)
    .map((record) => Object.fromEntries([
      "round",
      "run_id",
      "parent_digest",
      "candidate_digest",
      "change",
      "change_digest",
      "continuity",
      "continuity_epoch",
    ].map((key) => [key, valueAt(record, key)])));
  const rawActiveQuery = valueAt(state, "authorized_query");
  const activeQuery = plainObject(rawActiveQuery)
    ? Object.fromEntries([
      "phase",
      "round",
      "run_id",
      "candidate_digest",
      "holdout_visibility",
    ].map((key) => [key, valueAt(rawActiveQuery, key)]))
    : null;
  const skillDiffs = dashboardSkillDiffs(plan, { workspace });
  const orderedSpine = dashboardOrderSpine(spine, caseRows);
  const releaseEligible = dashboardReleaseEligible(latestDecision);
  const summary = {
    case_count: caseRows.length,
    candidate_passed: caseRows.filter((row) => row.status === "passed").length,
    candidate_failed: caseRows.filter((row) => new Set(["failed", "incomplete"]).has(row.status)).length,
    hard_gates_passed: hardGates.filter(
      (gate) => plainObject(gate) && valueAt(gate, "passed") === true,
    ).length,
    hard_gates_total: hardGates.length,
    decision_status: latestDecision ? valueAt(latestDecision, "status") : null,
    current_round: state ? valueAt(state, "current_round") : null,
    max_rounds: state ? valueAt(state, "max_rounds") : 3,
    selection_queries: state ? valueAt(state, "selection_query_count") : 0,
    audit_queries: state ? valueAt(state, "audit_query_count") : 0,
    rejected_candidates: state ? valueAt(state, "rejected_candidates", []).length : 0,
    invalid_experiments: state ? valueAt(state, "invalid_experiments", []).length : 0,
    continuity_epoch: state ? valueAt(state, "continuity_epoch") : null,
  };
  const decisionSupport = dashboardDecisionSupport({ state, decisions, caseRows });
  const review = dashboardReviewOutline({
    spine: orderedSpine,
    caseRows,
    releaseEligible,
    decisionSupport,
  });
  const measurement = valueAt(evidence, "measurement", null) ?? {
    status: "pending",
    cases: valueAt(plan, "cases", []).filter(plainObject).map((plannedCase) => ({
      case_id: compatibilityScalarString(valueAt(plannedCase, "id")),
      status: "pending",
      oracle: valueAt(plannedCase, "oracle"),
      sampling: {
        ...valueAt(plannedCase, "sampling", {}),
        status: "pending",
        direction_disagreement: false,
      },
      reasons: [],
    })),
    reasons: [],
  };
  const evidenceScope = valueAt(evidence, "evidence_scope", null)
    ?? (valueAt(holdout, "visibility") === "opaque" ? "opaque-holdout" : "public-calibration");
  const data = {
    contract: DASHBOARD_CONTRACT,
    schema_version: 3,
    generated_at: null,
    refresh_interval_ms: 3000,
    run: {
      id: runId,
      status: state
        ? valueAt(state, "status")
        : latestDecision
          ? valueAt(latestDecision, "status")
          : valueAt(evidence, "level", "planned"),
      verification_level: valueAt(evidence, "level", "not-run"),
      manifest: valueAt(plan, "manifest"),
      subject: valueAt(plan, "subject"),
      baseline: valueAt(plan, "baseline"),
      splits: valueAt(plan, "splits", []),
      control_anchor: state ? "local/trusted" : null,
      execution_profile: executionProfile,
      holdout,
      evidence_scope: evidenceScope,
      release_eligible: releaseEligible,
      integrity: valueAt(evidence, "integrity", projectedIntegrity),
      measurement,
    },
    summary,
    evolution: {
      active_query: activeQuery,
      selection_query_limit: state ? valueAt(state, "max_rounds", 3) : 3,
      audit_query_limit: 1,
      candidate_lineage: lineage,
      rejected_candidates: state ? valueAt(state, "rejected_candidates", []) : [],
      invalid_experiments: state ? valueAt(state, "invalid_experiments", []) : [],
    },
    // Wire name retained for schema-v2 snapshot compatibility. The payload is
    // read-only decision support; the Dashboard exposes no action gateway.
    action_center: decisionSupport,
    review,
    cases: caseRows,
    diffs: skillDiffs,
    spine: orderedSpine,
    limitations: [
      ...valueAt(evidence, "limitations", []),
      ...(state
        ? ["evolution control anchor is local/trusted; same-owner anti-replay requires an external append-only anchor"]
        : []),
    ],
  };
  writeJson(output, data);
  return data;
}

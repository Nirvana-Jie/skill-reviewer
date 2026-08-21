/** Apply acceptance gates and govern bounded Skill evolution state. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  iterStrictFiles,
  loadJson,
  lockedSkillSnapshotPath,
  pathIsWithin,
  requireEmptyWorkspace,
  requireRealDirectory,
  requireString,
  resolveCanonicalPath,
  runtimeSkillFileDigests,
  safeArtifact,
  sha256File,
  sha256Json,
  verifyLockedInputs,
  writeJson,
  writeJsonExclusive,
} from "./skill-eval-authority.mjs";
import {
  ACCEPTANCE_CONTRACT,
  EVOLUTION_STATE_CONTRACT,
  EVOLUTION_TRANSITION_CONTRACT,
  ManifestError,
  PLAN_CONTRACT,
  VERIFICATION_CONTRACT,
} from "./skill-eval-contracts.mjs";
import { gradeRun, objectiveDelta } from "./skill-eval-grading.mjs";
import { pairedRepeatMetrics } from "./skill-eval-measurement.mjs";

const CANDIDATE_AUTHORIZATION_FIELDS = new Set([
  "phase",
  "round",
  "run_id",
  "plan_path",
  "plan_digest",
  "parent_digest",
  "candidate_digest",
  "subject_path",
  "change",
  "change_digest",
  "continuity",
  "continuity_reason",
  "continuity_epoch",
]);
const AUDIT_AUTHORIZATION_FIELDS = new Set([
  "phase",
  "round",
  "run_id",
  "plan_path",
  "plan_digest",
  "candidate_digest",
  "holdout_visibility",
  "holdout_digest",
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(left, right) {
  return isDeepStrictEqual(left, right);
}

function none(value) {
  return value === undefined ? null : value;
}

function hasItems(value) {
  if (Array.isArray(value) || typeof value === "string") return value.length > 0;
  if (plainObject(value)) return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== false;
}

function canonicalExistingPath(path, label) {
  try {
    return realpathSync(resolve(path));
  } catch {
    throw new ManifestError(`${label} does not exist`);
  }
}

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function exactFields(value, fields) {
  if (!plainObject(value) || Object.keys(value).length !== fields.size) return false;
  return Object.keys(value).every((key) => fields.has(key));
}

function baselineResult(caseResult, preferred = null) {
  if (preferred && preferred !== "with_skill") {
    const value = caseResult[preferred];
    if (plainObject(value)) return [preferred, value];
  }
  for (const [key, value] of Object.entries(caseResult)) {
    if (["with_skill", "old_skill", "without_skill"].includes(key) && key !== "with_skill" && plainObject(value)) {
      return [key, value];
    }
  }
  return [null, null];
}

function pairedObjectiveDeltas({ objective, candidate, baseline }) {
  const pairs = pairedRepeatMetrics({
    candidate,
    baseline,
    metric: objective.metric,
  });
  return pairs?.map((pair) => ({
    repeat: pair.repeat,
    delta: objectiveDelta(objective, pair.candidate, pair.baseline),
  })) ?? null;
}

function computeDecisionCore({ plan, evidence, iteration, phase }) {
  const evidenceCases = new Map(
    (evidence.cases ?? [])
      .filter((item) => plainObject(item))
      .map((item) => [String(none(item.id)), item]),
  );
  const hardGates = [];
  const objectiveResults = [];
  const measurement = evidence.measurement;
  const measurementStatus = plainObject(measurement) ? String(none(measurement.status)) : "unverified";
  const measurementValid = measurementStatus === "valid";
  hardGates.push({
    id: "measurement:valid",
    passed: measurementValid,
    reason: measurementValid
      ? "oracle calibration is valid"
      : `measurement is ${measurementStatus}; candidate quality cannot be attributed`,
  });
  const opaqueHoldout = phase === "audit" && plainObject(plan.holdout) && plan.holdout.visibility === "opaque";
  if (phase === "audit") {
    hardGates.push({
      id: "audit:opaque-holdout",
      passed: opaqueHoldout,
      reason: opaqueHoldout
        ? "audit fixtures are bound to a trusted opaque holdout pack"
        : "public calibration fixtures cannot authorize release",
    });
  }
  for (const evalCase of plan.cases ?? []) {
    const caseId = String(none(evalCase.id));
    const result = evidenceCases.get(caseId);
    if (result === undefined) {
      hardGates.push({ id: `${caseId}:evidence-present`, passed: false, reason: "missing case evidence" });
      continue;
    }
    const candidate = result.with_skill;
    const preferredBaseline = plainObject(plan.baseline) ? none(plan.baseline.kind) : null;
    const [baselineArm, baseline] = baselineResult(result, preferredBaseline);
    const candidateValid = plainObject(candidate)
      && candidate.complete === true
      && candidate.passed === true
      && !hasItems(candidate.forbidden_actions)
      && !hasItems(candidate.side_effects);
    hardGates.push({
      id: `${caseId}:candidate-required-assertions`,
      passed: candidateValid,
      reason: candidateValid
        ? "candidate artifacts complete and required assertions pass"
        : "candidate evidence is incomplete or a required assertion failed",
    });
    for (const pairedArm of ["old_skill", "without_skill"]) {
      if (pairedArm === baselineArm || !Object.hasOwn(result, pairedArm)) continue;
      const paired = result[pairedArm];
      const pairedComplete = plainObject(paired)
        && paired.complete === true
        && !hasItems(paired.forbidden_actions)
        && !hasItems(paired.side_effects);
      hardGates.push({
        id: `${caseId}:paired-${pairedArm}-complete`,
        passed: pairedComplete,
        reason: pairedComplete
          ? `${pairedArm} artifacts are complete and safe`
          : `${pairedArm} artifacts are missing, incomplete, or unsafe`,
      });
    }
    const baselineValid = plainObject(baseline)
      && baseline.complete === true
      && !hasItems(baseline.forbidden_actions)
      && !hasItems(baseline.side_effects);
    hardGates.push({
      id: `${caseId}:paired-baseline-complete`,
      passed: baselineValid,
      reason: baselineValid
        ? `${baselineArm ?? "baseline"} artifacts are complete and safe`
        : "paired baseline artifacts are missing, incomplete, or unsafe",
    });
    const noForbidden = plainObject(candidate)
      && !hasItems(candidate.forbidden_actions)
      && !hasItems(candidate.side_effects);
    hardGates.push({
      id: `${caseId}:forbidden-actions`,
      passed: noForbidden,
      reason: noForbidden
        ? "no forbidden action or external side effect observed"
        : "forbidden action or external side effect observed",
    });
    if (!plainObject(candidate) || !plainObject(baseline)) continue;
    for (const objective of evalCase.objectives ?? []) {
      const metric = requireString(objective.metric, "objective.metric");
      const candidateValue = candidate[metric];
      const baselineValue = baseline[metric];
      const unusableMetrics = result.missing_objective_metrics ?? [];
      if (
        unusableMetrics.includes(metric)
        || typeof candidateValue !== "number"
        || typeof baselineValue !== "number"
      ) {
        hardGates.push({
          id: `${caseId}:${none(objective.id)}:metric-present`,
          passed: false,
          reason: `metric ${metric} is missing from paired evidence`,
        });
        continue;
      }
      const delta = objectiveDelta(objective, candidateValue, baselineValue);
      const tolerance = Number(objective.non_regression_tolerance ?? 0);
      const materialDelta = Number(objective.min_material_delta ?? 0);
      const repeatPairs = pairedObjectiveDeltas({ objective, candidate, baseline });
      if (repeatPairs === null) {
        hardGates.push({
          id: `${caseId}:${none(objective.id)}:paired-metrics-present`,
          passed: false,
          reason: `metric ${metric} is missing from one or more paired repeats`,
        });
        continue;
      }
      const regressionRepeats = repeatPairs
        .filter((pair) => pair.delta < -tolerance)
        .map((pair) => pair.repeat);
      const materialImprovementRepeats = repeatPairs
        .filter((pair) => pair.delta >= materialDelta)
        .map((pair) => pair.repeat);
      objectiveResults.push({
        case_id: caseId,
        id: none(objective.id),
        metric,
        direction: none(objective.direction),
        primary: objective.primary ?? true,
        candidate: candidateValue,
        baseline: baselineValue,
        delta,
        paired_deltas: repeatPairs.map((pair) => pair.delta),
        repeat_count: repeatPairs.length,
        aggregation_policy: "all_paired_repeats",
        regression_repeats: regressionRepeats,
        material_improvement_repeats: materialImprovementRepeats,
        non_regressed: regressionRepeats.length === 0,
        materially_improved: materialImprovementRepeats.length === repeatPairs.length,
        non_regression_tolerance: tolerance,
        min_material_delta: materialDelta,
      });
    }
  }

  const hardGatesPassed = hardGates.every((item) => item.passed);
  const objectiveNonRegression = objectiveResults.length > 0
    && objectiveResults.every((item) => item.non_regressed);
  const materialImprovement = objectiveResults.some((item) => item.primary && item.materially_improved);
  const evidenceInconclusive = evidence.level === "inconclusive";
  const directionMixed = (plan.cases ?? []).some((evalCase) => {
    const result = evidenceCases.get(String(none(evalCase.id)));
    return plainObject(result) && result.direction_disagreement === true;
  });
  let accepted = measurementValid
    && !evidenceInconclusive
    && hardGatesPassed
    && objectiveNonRegression;
  if (phase === "selection") accepted = accepted && materialImprovement;
  let status;
  if (!measurementValid) status = "invalid";
  else if (evidenceInconclusive) status = "inconclusive";
  else if (!hardGatesPassed || !objectiveNonRegression) status = "rejected";
  else if (phase === "selection" && !materialImprovement) status = "no-change";
  else status = "accepted";
  const reasons = {
    accepted: "candidate passed every hard gate, did not regress, and materially improved a primary objective",
    rejected: "candidate failed a hard gate or regressed on a declared objective",
    "no-change": "candidate produced no material primary-objective improvement",
    inconclusive: "retained evidence cannot support an acceptance decision",
    invalid: "the oracle is invalid, so this experiment cannot judge candidate quality",
  };
  if (status === "rejected" && !objectiveNonRegression && directionMixed) {
    reasons.rejected = "candidate regressed in at least one paired repeat while paired repeat effects varied in direction; repeat consistency is insufficient at the declared repeat budget";
  }
  return {
    contract: ACCEPTANCE_CONTRACT,
    run_id: none(plan.run_id),
    iteration,
    phase,
    status,
    accepted,
    hard_gates_passed: hardGatesPassed,
    objective_non_regression: objectiveNonRegression,
    // Compatibility alias for v1/v2 consumers. This is a single-baseline
    // non-regression gate, not a Pareto-frontier search result.
    pareto_admissible: objectiveNonRegression,
    material_improvement: materialImprovement,
    repeat_consistency: directionMixed ? "direction-mixed" : "consistent",
    release_eligible: phase === "audit" && accepted && opaqueHoldout,
    measurement_validity: measurementStatus,
    hard_gates: hardGates,
    objectives: objectiveResults,
    reason: phase === "selection" || status !== "accepted"
      ? reasons[status]
      : "candidate passed the one-shot audit hard gates without regression",
  };
}

export function decideCandidate({ planPath, evidencePath, workspace, iteration, phase }) {
  if (!["selection", "audit"].includes(phase)) throw new ManifestError("decision phase must be selection or audit");
  workspace = resolveCanonicalPath(workspace);
  planPath = resolveCanonicalPath(planPath);
  evidencePath = resolveCanonicalPath(evidencePath);
  if (planPath !== join(workspace, "execution-plan.json")) {
    throw new ManifestError("decision plan must be the workspace execution-plan.json");
  }
  if (evidencePath !== join(workspace, "verification-evidence.json")) {
    throw new ManifestError("decision evidence must be the workspace verification-evidence.json");
  }
  const plan = loadJson(planPath);
  if (plan.contract !== PLAN_CONTRACT) throw new ManifestError(`execution plan contract must be ${PLAN_CONTRACT}`);
  if (!same(plan.splits, [phase]) || (plan.cases ?? []).some((evalCase) => evalCase.split !== phase)) {
    throw new ManifestError(`${phase} decisions require a plan containing only the ${phase} split`);
  }
  const evidence = gradeRun({ planPath, workspace });
  if (evidence.contract !== VERIFICATION_CONTRACT) {
    throw new ManifestError(`verification evidence contract must be ${VERIFICATION_CONTRACT}`);
  }
  if (plan.run_id !== evidence.run_id) throw new ManifestError("execution plan and evidence use different run ids");
  if (!Number.isInteger(iteration) || iteration < 1) throw new ManifestError("iteration must be a positive integer");
  if (!plainObject(evidence.integrity) || evidence.integrity.verified !== true) {
    throw new ManifestError("decision requires verified locked evidence");
  }
  const decision = {
    ...computeDecisionCore({ plan, evidence, iteration, phase }),
    plan_path: planPath,
    plan_digest: sha256File(planPath),
    evidence_path: evidencePath,
    evidence_digest: sha256File(evidencePath),
    evidence_level: none(evidence.level),
    authority_digest: plainObject(plan.authority) ? none(plan.authority.digest) : null,
    subject: none(plan.subject),
    baseline: none(plan.baseline),
  };
  writeJson(
    join(workspace, `iteration-${iteration}`, phase === "selection" ? "acceptance-decision.json" : "audit-decision.json"),
    decision,
  );
  return decision;
}

function validateBoundDecision(decision, decisionPath) {
  if (decision.contract !== ACCEPTANCE_CONTRACT) {
    throw new ManifestError(`acceptance decision contract must be ${ACCEPTANCE_CONTRACT}`);
  }
  const rawPlanPath = requireString(decision.plan_path, "decision.plan_path");
  const rawEvidencePath = requireString(decision.evidence_path, "decision.evidence_path");
  if (!isRegularFile(rawPlanPath) || sha256File(rawPlanPath) !== decision.plan_digest) {
    throw new ManifestError("decision plan digest is missing or mismatched");
  }
  if (!isRegularFile(rawEvidencePath) || sha256File(rawEvidencePath) !== decision.evidence_digest) {
    throw new ManifestError("decision evidence digest is missing or mismatched");
  }
  const plan = loadJson(rawPlanPath);
  const evidence = loadJson(rawEvidencePath);
  if (plan.contract !== PLAN_CONTRACT) throw new ManifestError(`execution plan contract must be ${PLAN_CONTRACT}`);
  if (evidence.contract !== VERIFICATION_CONTRACT) {
    throw new ManifestError(`verification evidence contract must be ${VERIFICATION_CONTRACT}`);
  }
  if (!(decision.run_id === plan.run_id && plan.run_id === evidence.run_id)) {
    throw new ManifestError("decision, plan, and evidence use different run ids");
  }
  if (![plan.authority, plan.subject, plan.baseline].every(plainObject)) {
    throw new ManifestError("decision plan authority, subject, and baseline must be objects");
  }
  if (decision.authority_digest !== plan.authority.digest) throw new ManifestError("decision authority digest does not match its plan");
  if (!same(decision.subject, plan.subject)) throw new ManifestError("decision subject does not match its plan");
  if (!same(decision.baseline, plan.baseline)) throw new ManifestError("decision baseline does not match its plan");
  if (!plainObject(evidence.integrity) || evidence.integrity.verified !== true || evidence.integrity.plan_digest !== decision.plan_digest) {
    throw new ManifestError("decision evidence is not bound to a verified plan");
  }
  if (decision.evidence_level !== evidence.level) throw new ManifestError("decision evidence level does not match retained evidence");
  const phase = decision.phase;
  if (!["selection", "audit"].includes(phase) || !same(plan.splits, [phase])) {
    throw new ManifestError("decision phase does not match its single-split plan");
  }
  const iteration = decision.iteration;
  if (!Number.isInteger(iteration) || iteration < 1) throw new ManifestError("decision iteration must be a positive integer");
  const planPath = canonicalExistingPath(rawPlanPath, "decision plan");
  const evidencePath = canonicalExistingPath(rawEvidencePath, "decision evidence");
  const runWorkspace = dirname(planPath);
  if (planPath !== join(runWorkspace, "execution-plan.json")) throw new ManifestError("decision plan path is not canonical");
  if (evidencePath !== join(runWorkspace, "verification-evidence.json")) throw new ManifestError("decision evidence path is not canonical");
  const expectedDecisionPath = join(
    runWorkspace,
    `iteration-${iteration}`,
    phase === "selection" ? "acceptance-decision.json" : "audit-decision.json",
  );
  if (resolve(decisionPath) !== expectedDecisionPath || (existsSync(decisionPath) && realpathSync(decisionPath) !== expectedDecisionPath)) {
    throw new ManifestError("decision artifact path is not canonical");
  }
  const freshEvidence = gradeRun({ planPath, workspace: runWorkspace, persist: false });
  if (!same(freshEvidence, evidence)) throw new ManifestError("decision evidence does not match freshly graded locked artifacts");
  const expectedCore = computeDecisionCore({ plan, evidence: freshEvidence, iteration, phase });
  if (Object.entries(expectedCore).some(([key, value]) => !same(decision[key], value))) {
    throw new ManifestError("decision payload does not match its bound plan and evidence");
  }
  if (!isRegularFile(decisionPath)) throw new ManifestError("decision artifact does not exist");
  return [plan, freshEvidence];
}

function candidateChange({ parentSnapshot, candidateSnapshot }) {
  const parentFiles = runtimeSkillFileDigests(parentSnapshot);
  const candidateFiles = runtimeSkillFileDigests(candidateSnapshot);
  const parentNames = new Set(Object.keys(parentFiles));
  const candidateNames = new Set(Object.keys(candidateFiles));
  const added = [...candidateNames].filter((path) => !parentNames.has(path)).sort();
  const removed = [...parentNames].filter((path) => !candidateNames.has(path)).sort();
  const modified = [...parentNames]
    .filter((path) => candidateNames.has(path) && parentFiles[path] !== candidateFiles[path])
    .sort();
  const change = { added, removed, modified };
  return { ...change, digest: sha256Json(change) };
}

function candidateAuthorization({
  plan,
  planPath,
  roundNumber,
  parentDigest,
  parentSnapshot,
  continuity,
  continuityEpoch,
}) {
  if (!plainObject(plan.subject)) throw new ManifestError("candidate plan subject is missing");
  const candidateDigest = requireString(plan.subject.digest, "plan.subject.digest");
  const change = candidateChange({
    parentSnapshot,
    candidateSnapshot: lockedSkillSnapshotPath(plan, "with_skill"),
  });
  const canonicalPlanPath = canonicalExistingPath(planPath, "candidate plan");
  return {
    phase: "selection",
    round: roundNumber,
    run_id: requireString(plan.run_id, "plan.run_id"),
    plan_path: canonicalPlanPath,
    plan_digest: sha256File(canonicalPlanPath),
    parent_digest: parentDigest,
    candidate_digest: candidateDigest,
    subject_path: requireString(plan.subject.path, "plan.subject.path"),
    change: { added: change.added, removed: change.removed, modified: change.modified },
    change_digest: change.digest,
    continuity,
    continuity_reason: continuityReason({ roundNumber, continuity, change }),
    continuity_epoch: continuityEpoch,
  };
}

// Deterministic, structured rationale for the continue/reset enum so lineage
// records explain themselves without free-form operator text.
function continuityReason({ roundNumber, continuity, change }) {
  if (roundNumber === 1) return "initial";
  if (continuity !== "reset") return "continue";
  return change.added.length > 0 || change.removed.length > 0
    ? "topology-reset"
    : "operator-reset";
}

function auditAuthorization({ plan, planPath, roundNumber }) {
  if (!plainObject(plan.subject)) throw new ManifestError("audit plan subject is missing");
  if (!plainObject(plan.holdout)) throw new ManifestError("audit plan holdout is missing");
  const canonicalPlanPath = canonicalExistingPath(planPath, "audit plan");
  return {
    phase: "audit",
    round: roundNumber,
    run_id: requireString(plan.run_id, "plan.run_id"),
    plan_path: canonicalPlanPath,
    plan_digest: sha256File(canonicalPlanPath),
    candidate_digest: requireString(plan.subject.digest, "plan.subject.digest"),
    holdout_visibility: none(plan.holdout.visibility),
    holdout_digest: none(plan.holdout.digest),
  };
}

export function initializeEvolution({ planPath, workspace }) {
  planPath = canonicalExistingPath(planPath, "evolution plan");
  const plan = loadJson(planPath);
  if (plan.contract !== PLAN_CONTRACT) throw new ManifestError(`execution plan contract must be ${PLAN_CONTRACT}`);
  if (!same(plan.splits, ["selection"])) throw new ManifestError("evolution must initialize from a selection plan");
  if (!plainObject(plan.subject) || !plainObject(plan.baseline)) {
    throw new ManifestError("evolution plan is missing subject or baseline metadata");
  }
  const subjectPath = resolve(requireString(plan.subject.path, "plan.subject.path"));
  const baselinePath = resolve(requireString(plan.baseline.path, "plan.baseline.path"));
  workspace = resolveCanonicalPath(workspace);
  requireEmptyWorkspace(workspace, [subjectPath, baselinePath, dirname(planPath)]);
  verifyLockedInputs({ planPath, workspace: dirname(planPath), plan });
  const authorityDigest = requireString(plan.authority?.digest, "plan.authority.digest");
  const executionProfileDigest = requireString(plan.execution_profile?.digest, "plan.execution_profile.digest");
  if (plan.baseline.kind !== "old_skill" || typeof plan.baseline.digest !== "string") {
    throw new ManifestError("evolution requires a pinned old_skill baseline");
  }
  const statePath = join(workspace, "evolution-state.json");
  if (existsSync(statePath)) throw new ManifestError("evolution-state.json already exists");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, "transitions"));
  mkdirSync(join(workspace, ".transition-staging"));
  const evolutionId = `evo-${sha256Json({ authority: authorityDigest, baseline: plan.baseline.digest }).slice(0, 20)}`;
  const initialAuthorization = candidateAuthorization({
    plan,
    planPath,
    roundNumber: 1,
    parentDigest: String(plan.baseline.digest),
    parentSnapshot: lockedSkillSnapshotPath(plan, "old_skill"),
    continuity: "continue",
    continuityEpoch: 1,
  });
  const state = {
    contract: EVOLUTION_STATE_CONTRACT,
    evolution_id: evolutionId,
    authority_digest: authorityDigest,
    execution_profile_digest: executionProfileDigest,
    baseline: plan.baseline,
    initialized_from_plan: planPath,
    control_workspace: workspace,
    max_rounds: 3,
    // Governance rationale: the cap is a predeclared cost/safety budget, not a
    // convergence or statistical-sufficiency claim.
    max_rounds_basis: "predeclared-cost-cap",
    current_round: 1,
    status: "optimizing",
    next_action: "run_authorized_selection",
    terminal: false,
    audit_consumed: false,
    selected_subject_digest: null,
    authorized_query: initialAuthorization,
    selection_query_count: 1,
    audit_query_count: 0,
    continuity_epoch: 1,
    candidate_lineage: [initialAuthorization],
    rejected_candidates: [],
    invalid_experiments: [],
    seen_run_ids: [],
    history: [],
    journal_head_digest: null,
  };
  writeJson(statePath, state);
  return state;
}

export function authorizeEvolution({
  statePath,
  planPath,
  parentDigest = null,
  continuity,
}) {
  statePath = resolve(statePath);
  if (isSymlink(statePath)) throw new ManifestError("evolution state path must not be a symbolic link");
  statePath = canonicalExistingPath(statePath, "evolution state");
  planPath = canonicalExistingPath(planPath, "evolution plan");
  const state = loadJson(statePath);
  const plan = loadJson(planPath);
  if (state.contract !== EVOLUTION_STATE_CONTRACT) throw new ManifestError(`evolution state contract must be ${EVOLUTION_STATE_CONTRACT}`);
  if (plan.contract !== PLAN_CONTRACT) throw new ManifestError(`execution plan contract must be ${PLAN_CONTRACT}`);
  verifyLockedInputs({ planPath, workspace: dirname(planPath), plan });
  validateEvolutionState(state, plan, statePath, planPath);
  if (state.terminal === true) throw new ManifestError("evolution is already terminal");
  if (state.authorized_query != null) throw new ManifestError("the current round already has an authorized evaluation query");
  if (state.authority_digest !== plan.authority?.digest) throw new ManifestError("evolution authority changed; user confirmation requires a new run");
  if (!same(state.baseline, plan.baseline)) throw new ManifestError("accepted old_skill baseline changed during evolution");
  if (state.execution_profile_digest !== plan.execution_profile?.digest) throw new ManifestError("execution profile changed during evolution");
  const roundNumber = Number(state.current_round ?? 0);
  const splits = plan.splits;
  if (state.status === "optimizing") {
    if (!same(splits, ["selection"])) throw new ManifestError("optimizing evolution can authorize only selection");
    if (parentDigest == null) throw new ManifestError("selection authorization requires --parent-digest");
    if (!["continue", "reset"].includes(continuity)) throw new ManifestError("continuity must be continue or reset");
    const baselineDigest = requireString(state.baseline?.digest, "state.baseline.digest");
    if (parentDigest !== baselineDigest) {
      throw new ManifestError("selection candidates must branch from the accepted baseline; rejected candidates cannot become parents");
    }
    const lineage = state.candidate_lineage;
    if (!Array.isArray(lineage)) throw new ManifestError("candidate_lineage must be an array");
    if (Number(state.selection_query_count ?? 0) >= Number(state.max_rounds ?? 3)) {
      throw new ManifestError("selection query budget is exhausted");
    }
    if (lineage.some((record) => plainObject(record) && record.run_id === plan.run_id)) {
      throw new ManifestError("selection run is already present in candidate lineage");
    }
    let epoch = Number(state.continuity_epoch ?? 1);
    const authorization = candidateAuthorization({
      plan,
      planPath,
      roundNumber,
      parentDigest,
      parentSnapshot: lockedSkillSnapshotPath(plan, "old_skill"),
      continuity,
      continuityEpoch: epoch,
    });
    const topologyChanged = authorization.change.added.length > 0 || authorization.change.removed.length > 0;
    if (topologyChanged && continuity !== "reset") {
      throw new ManifestError("topology-changing candidates require --continuity reset");
    }
    if (continuity === "reset") {
      epoch += 1;
      state.continuity_epoch = epoch;
      authorization.continuity_epoch = epoch;
    }
    lineage.push(authorization);
    state.candidate_lineage = lineage;
    state.selection_query_count = Number(state.selection_query_count ?? 0) + 1;
    state.authorized_query = authorization;
    state.next_action = "run_authorized_selection";
  } else if (state.status === "awaiting-audit") {
    if (!same(splits, ["audit"])) throw new ManifestError("awaiting-audit evolution can authorize only audit");
    if (parentDigest != null) throw new ManifestError("audit query binding cannot carry candidate lineage");
    if (continuity !== "continue") throw new ManifestError("audit query binding cannot reset continuity");
    if (Number(state.audit_query_count ?? 0) !== 0) throw new ManifestError("audit query may be bound only once");
    if (plan.subject?.digest !== state.selected_subject_digest) {
      throw new ManifestError("audit subject is not the accepted selection candidate");
    }
    state.audit_query_count = 1;
    state.authorized_query = auditAuthorization({ plan, planPath, roundNumber });
    state.next_action = "run_authorized_audit";
  } else {
    throw new ManifestError("evolution state cannot authorize another query");
  }
  writeJson(statePath, state);
  return state;
}

export function advanceEvolution({ statePath, decisionPath }) {
  statePath = resolve(statePath);
  if (isSymlink(statePath)) throw new ManifestError("evolution state path must not be a symbolic link");
  statePath = canonicalExistingPath(statePath, "evolution state");
  decisionPath = canonicalExistingPath(decisionPath, "decision artifact");
  const state = loadJson(statePath);
  const decision = loadJson(decisionPath);
  if (state.contract !== EVOLUTION_STATE_CONTRACT) throw new ManifestError(`evolution state contract must be ${EVOLUTION_STATE_CONTRACT}`);
  const [plan] = validateBoundDecision(decision, decisionPath);
  if (state.authority_digest !== decision.authority_digest) {
    throw new ManifestError("evolution authority changed; user confirmation requires a new run");
  }
  if (!same(state.baseline, decision.baseline)) throw new ManifestError("accepted old_skill baseline changed during evolution");
  if (state.execution_profile_digest !== plan.execution_profile?.digest) throw new ManifestError("execution profile changed during evolution");
  const decisionPlanPath = canonicalExistingPath(requireString(decision.plan_path, "decision.plan_path"), "decision plan");
  validateEvolutionState(state, plan, statePath, decisionPlanPath);
  const stagingRoot = join(requireString(state.control_workspace, "state.control_workspace"), ".transition-staging");
  for (const staged of readdirSync(stagingRoot)) unlinkSync(join(stagingRoot, staged));
  // The journal is the recovery source if a process stopped after appending a
  // transition but before replacing the derived state projection.
  writeJson(statePath, state);
  if (state.terminal === true) throw new ManifestError("evolution is already terminal");
  const phase = decision.phase;
  const iteration = decision.iteration;
  if (!["selection", "audit"].includes(phase)) throw new ManifestError("decision phase must be selection or audit");
  if (iteration !== state.current_round) throw new ManifestError("decision iteration does not match the current evolution round");
  const seenRunIds = state.seen_run_ids;
  if (!Array.isArray(seenRunIds)) throw new ManifestError("evolution seen_run_ids must be an array");
  const runId = requireString(decision.run_id, "decision.run_id");
  if (seenRunIds.includes(runId)) throw new ManifestError("the same evaluation run cannot advance evolution twice");
  const authorizedQuery = state.authorized_query;
  if (
    !plainObject(authorizedQuery)
    || authorizedQuery.phase !== phase
    || authorizedQuery.round !== iteration
    || authorizedQuery.run_id !== runId
    || authorizedQuery.plan_digest !== sha256File(decisionPlanPath)
    || authorizedQuery.plan_path !== decisionPlanPath
  ) {
    throw new ManifestError("decision is not the authorized evaluation query");
  }

  const history = state.history;
  if (!Array.isArray(history)) throw new ManifestError("evolution state history must be an array");
  if (history.length === 0) {
    const initializedPlan = loadJson(requireString(state.initialized_from_plan, "state.initialized_from_plan"));
    if (initializedPlan.run_id !== runId) throw new ManifestError("the first evolution decision must use the initialization run");
  }
  const decisionDigest = sha256File(decisionPath);
  history.push({
    phase,
    iteration,
    run_id: runId,
    subject_digest: none(plan.subject?.digest),
    status: none(decision.status),
    accepted: decision.accepted === true,
    decision_path: decisionPath,
    decision_digest: decisionDigest,
    authorization: { ...authorizedQuery },
  });
  const experimentInvalid = decision.status === "invalid";
  if (experimentInvalid) {
    if (!Array.isArray(state.invalid_experiments)) throw new ManifestError("invalid_experiments must be an array");
    state.invalid_experiments = [
      ...state.invalid_experiments,
      {
        phase,
        round: iteration,
        run_id: runId,
        candidate_digest: none(plan.subject?.digest),
        measurement_validity: none(decision.measurement_validity),
        reason: none(decision.reason),
        decision_digest: decisionDigest,
      },
    ];
  }

  if (phase === "selection") {
    if (state.status !== "optimizing") throw new ManifestError("selection decisions are allowed only while optimizing");
    if (experimentInvalid) {
      Object.assign(state, { status: "measurement-invalid", next_action: "propose_eval_change", terminal: true });
    } else if (decision.accepted === true) {
      Object.assign(state, {
        status: "awaiting-audit",
        next_action: "prepare_audit",
        terminal: false,
        selected_subject_digest: none(plan.subject?.digest),
      });
    } else if (Number(state.current_round ?? 0) >= Number(state.max_rounds ?? 3)) {
      Object.assign(state, { status: "exhausted", next_action: "stop", terminal: true });
    } else {
      Object.assign(state, {
        current_round: Number(state.current_round) + 1,
        status: "optimizing",
        next_action: "propose_candidate",
        terminal: false,
      });
    }
    if (decision.accepted !== true && !experimentInvalid) {
      const rejectedRecord = {
        round: iteration,
        run_id: runId,
        candidate_digest: none(plan.subject?.digest),
        status: none(decision.status),
        reason: none(decision.reason),
        repeat_consistency: none(decision.repeat_consistency),
        decision_digest: decisionDigest,
        objective_deltas: (decision.objectives ?? [])
          .filter((objective) => plainObject(objective))
          .map((objective) => ({
            case_id: none(objective.case_id),
            id: none(objective.id),
            delta: none(objective.delta),
          })),
        continuity_epoch: none(authorizedQuery.continuity_epoch),
      };
      if (!Array.isArray(state.rejected_candidates)) throw new ManifestError("rejected candidate history must be an array");
      state.rejected_candidates = [...state.rejected_candidates, rejectedRecord];
    }
  } else {
    if (state.status !== "awaiting-audit") throw new ManifestError("audit is allowed only after a selection candidate is accepted");
    if (state.audit_consumed === true) throw new ManifestError("audit may run only once");
    if (plan.subject?.digest !== state.selected_subject_digest) {
      throw new ManifestError("audit subject is not the accepted selection candidate");
    }
    const auditPassed = decision.accepted === true;
    Object.assign(state, {
      status: experimentInvalid ? "measurement-invalid" : auditPassed ? "audit-passed" : "audit-failed",
      next_action: experimentInvalid ? "propose_eval_change" : auditPassed ? "request_user_release" : "stop",
      terminal: true,
      audit_consumed: true,
    });
  }
  state.history = history;
  state.seen_run_ids = [...seenRunIds, runId];
  state.authorized_query = null;
  const transitionPath = safeArtifact(
    join(requireString(state.control_workspace, "state.control_workspace"), "transitions"),
    `${String(history.length).padStart(4, "0")}.json`,
  );
  writeJsonExclusive(transitionPath, {
    contract: EVOLUTION_TRANSITION_CONTRACT,
    sequence: history.length,
    previous_digest: none(state.journal_head_digest),
    record: history.at(-1),
  });
  state.journal_head_digest = sha256File(transitionPath);
  writeJson(statePath, state);
  return state;
}

function loadOptionalJson(path) {
  return isRegularFile(path) ? loadJson(path) : null;
}

function decisionSortKey(decision) {
  const iteration = Number.isInteger(decision.iteration) ? decision.iteration : 0;
  return [iteration, decision.phase === "audit" ? 1 : 0];
}

function compareDecision(left, right) {
  const leftKey = decisionSortKey(left);
  const rightKey = decisionSortKey(right);
  return leftKey[0] - rightKey[0] || leftKey[1] - rightKey[1];
}

function validateAuthorizationPlan({
  authorization,
  expectedSplit,
  authorityDigest,
  baseline,
  executionProfileDigest,
  label,
}) {
  const rawPlanPath = requireString(authorization.plan_path, `${label}.plan_path`);
  if (
    !isAbsolute(rawPlanPath)
    || isSymlink(rawPlanPath)
    || !isRegularFile(rawPlanPath)
    || canonicalExistingPath(rawPlanPath, `${label} plan`) !== rawPlanPath
    || rawPlanPath.split(sep).at(-1) !== "execution-plan.json"
  ) {
    throw new ManifestError(`${label} plan path is not canonical`);
  }
  if (sha256File(rawPlanPath) !== authorization.plan_digest) throw new ManifestError(`${label} plan digest is invalid`);
  const plan = loadJson(rawPlanPath);
  if (
    plan.contract !== PLAN_CONTRACT
    || !same(plan.splits, [expectedSplit])
    || plan.run_id !== authorization.run_id
    || plan.authority?.digest !== authorityDigest
    || !same(plan.baseline, baseline)
    || plan.execution_profile?.digest !== executionProfileDigest
  ) {
    throw new ManifestError(`${label} plan does not match evolution authority`);
  }
  verifyLockedInputs({ planPath: rawPlanPath, workspace: dirname(rawPlanPath), plan });
  return [rawPlanPath, plan];
}

function authorizationBindsExactPlan(authorization, planPath) {
  const canonicalPlanPath = canonicalExistingPath(planPath, "authorized plan");
  return authorization.plan_path === canonicalPlanPath && authorization.plan_digest === sha256File(canonicalPlanPath);
}

export function loadDashboardDecisionContext({
  plan,
  planPath,
  workspace,
  statePath = null,
  localDecisionPaths,
}) {
  workspace = resolveCanonicalPath(workspace);
  const rawStatePath = resolve(statePath ?? join(workspace, "evolution-state.json"));
  if (isSymlink(rawStatePath)) throw new ManifestError("dashboard evolution state path must not be a symbolic link");
  const resolvedStatePath = existsSync(rawStatePath) ? canonicalExistingPath(rawStatePath, "dashboard evolution state") : rawStatePath;
  if (statePath != null && !isRegularFile(resolvedStatePath)) {
    throw new ManifestError("explicit dashboard evolution state does not exist");
  }
  const state = loadOptionalJson(resolvedStatePath);
  const stateDecisions = state ? validateEvolutionState(state, plan, resolvedStatePath, planPath) : [];
  if (state !== null) {
    const initializedPlan = loadJson(requireString(state.initialized_from_plan, "state.initialized_from_plan"));
    const seenRunIds = state.seen_run_ids ?? [];
    const activeQuery = state.authorized_query;
    const currentStateRunId = plainObject(activeQuery)
      ? activeQuery.run_id
      : seenRunIds.length > 0
        ? seenRunIds.at(-1)
        : initializedPlan.run_id;
    if (plan.run_id !== currentStateRunId) throw new ManifestError("dashboard state does not identify the current run");
    const stateHistory = state.history ?? [];
    const currentAuthorization = plainObject(activeQuery)
      ? activeQuery
      : stateHistory.length > 0 && plainObject(stateHistory.at(-1))
        ? stateHistory.at(-1).authorization
        : null;
    if (!plainObject(currentAuthorization) || !authorizationBindsExactPlan(currentAuthorization, planPath)) {
      throw new ManifestError("dashboard state is not bound to the exact authorized plan");
    }
  }

  const decisions = [];
  const decisionPaths = new Set([...(localDecisionPaths ?? []), ...stateDecisions.map(([path]) => path)]);
  for (const decisionPath of [...decisionPaths].sort()) {
    const decision = loadJson(decisionPath);
    validateBoundDecision(decision, decisionPath);
    const isLocal = pathIsWithin(decisionPath, workspace);
    if (isLocal && decision.run_id !== plan.run_id) {
      throw new ManifestError("workspace decision does not belong to the current run");
    }
    decisions.push({
      ...decision,
      artifact: isLocal ? relative(workspace, decisionPath).split(sep).join("/") : String(decisionPath),
    });
  }
  decisions.sort(compareDecision);
  const currentDecisions = decisions.filter((decision) => decision.run_id === plan.run_id);
  return {
    state,
    decisions,
    latestDecision: currentDecisions.length > 0 ? currentDecisions.at(-1) : null,
  };
}

function validateCandidateLineage({
  lineage,
  authorityDigest,
  baseline,
  executionProfileDigest,
  initializedRunId,
}) {
  if (lineage.length === 0 || lineage.length > 3) throw new ManifestError("candidate lineage must contain one to three queries");
  const baselineDigest = requireString(baseline.digest, "state.baseline.digest");
  const byRunId = new Map();
  let previousEpoch = null;
  for (const [index, rawRecord] of lineage.entries()) {
    const label = `candidate_lineage[${index}]`;
    if (!exactFields(rawRecord, CANDIDATE_AUTHORIZATION_FIELDS)) throw new ManifestError(`${label} contract is invalid`);
    const record = rawRecord;
    const expectedRound = index + 1;
    if (record.phase !== "selection" || record.round !== expectedRound || record.parent_digest !== baselineDigest) {
      throw new ManifestError(`${label} phase, round, or parent is invalid`);
    }
    const runId = requireString(record.run_id, `${label}.run_id`);
    if (byRunId.has(runId) || (index === 0 && runId !== initializedRunId)) {
      throw new ManifestError("candidate lineage run sequence is invalid");
    }
    const [planPath, candidatePlan] = validateAuthorizationPlan({
      authorization: record,
      expectedSplit: "selection",
      authorityDigest,
      baseline,
      executionProfileDigest,
      label,
    });
    if (
      !plainObject(candidatePlan.subject)
      || record.candidate_digest !== candidatePlan.subject.digest
      || record.subject_path !== candidatePlan.subject.path
    ) {
      throw new ManifestError(`${label} candidate identity is invalid`);
    }
    const change = candidateChange({
      parentSnapshot: lockedSkillSnapshotPath(candidatePlan, "old_skill"),
      candidateSnapshot: lockedSkillSnapshotPath(candidatePlan, "with_skill"),
    });
    const expectedChange = { added: change.added, removed: change.removed, modified: change.modified };
    if (!same(record.change, expectedChange) || record.change_digest !== change.digest) {
      throw new ManifestError(`${label} change evidence is invalid`);
    }
    const continuity = record.continuity;
    const epoch = record.continuity_epoch;
    if (!["continue", "reset"].includes(continuity) || !Number.isInteger(epoch)) {
      throw new ManifestError(`${label} continuity is invalid`);
    }
    const expectedReason = continuityReason({
      roundNumber: expectedRound,
      continuity,
      change,
    });
    if (record.continuity_reason !== expectedReason) {
      throw new ManifestError(`${label} continuity reason is invalid`);
    }
    if (index === 0) {
      if (continuity !== "continue" || epoch !== 1) throw new ManifestError("initial candidate must start continuity epoch 1");
    } else if (continuity === "reset") {
      if (epoch !== Number(previousEpoch) + 1) throw new ManifestError(`${label} reset epoch is invalid`);
    } else if (epoch !== previousEpoch) {
      throw new ManifestError(`${label} continuity epoch is invalid`);
    }
    if (index > 0 && (change.added.length > 0 || change.removed.length > 0) && continuity !== "reset") {
      throw new ManifestError(`${label} topology change is missing a continuity reset`);
    }
    previousEpoch = epoch;
    byRunId.set(runId, { authorization: record, plan: candidatePlan, path: planPath });
  }
  return byRunId;
}

function validateAuditAuthorization({
  authorization,
  authorityDigest,
  baseline,
  executionProfileDigest,
  roundNumber,
  selectedSubjectDigest,
  label,
}) {
  if (!exactFields(authorization, AUDIT_AUTHORIZATION_FIELDS)) throw new ManifestError(`${label} contract is invalid`);
  const [planPath, auditPlan] = validateAuthorizationPlan({
    authorization,
    expectedSplit: "audit",
    authorityDigest,
    baseline,
    executionProfileDigest,
    label,
  });
  const expected = auditAuthorization({ plan: auditPlan, planPath, roundNumber });
  if (!same(authorization, expected) || authorization.candidate_digest !== selectedSubjectDigest) {
    throw new ManifestError(`${label} is not bound to the selected candidate`);
  }
  return [planPath, auditPlan];
}

function validateEvolutionState(state, plan, statePath, planPath) {
  if (state.contract !== EVOLUTION_STATE_CONTRACT) {
    throw new ManifestError(`evolution state contract must be ${EVOLUTION_STATE_CONTRACT}`);
  }
  const planAuthority = plan.authority;
  const baseline = plan.baseline;
  const subject = plan.subject;
  if (![planAuthority, baseline, subject].every(plainObject)) {
    throw new ManifestError("dashboard plan authority, subject, and baseline must be objects");
  }
  const authorityDigest = requireString(planAuthority.digest, "plan.authority.digest");
  const executionProfileDigest = requireString(plan.execution_profile?.digest, "plan.execution_profile.digest");
  let controlWorkspace = requireString(state.control_workspace, "state.control_workspace");
  if (!isAbsolute(controlWorkspace)) throw new ManifestError("state.control_workspace must be an absolute path");
  controlWorkspace = requireRealDirectory(controlWorkspace, parse(controlWorkspace).root, "evolution control workspace");
  const canonicalStatePath = safeArtifact(controlWorkspace, "evolution-state.json");
  if (isSymlink(statePath) || canonicalExistingPath(statePath, "evolution state") !== canonicalStatePath) {
    throw new ManifestError("evolution state must stay at its canonical control workspace path");
  }
  const transitionsRoot = requireRealDirectory(
    join(controlWorkspace, "transitions"),
    controlWorkspace,
    "evolution transition journal",
  );
  const stagingRoot = requireRealDirectory(
    join(controlWorkspace, ".transition-staging"),
    controlWorkspace,
    "evolution transition staging",
  );
  if (state.authority_digest !== authorityDigest) throw new ManifestError("dashboard state authority does not match the current run");
  if (!same(state.baseline, baseline)) throw new ManifestError("dashboard state baseline does not match the current run");
  if (state.execution_profile_digest !== executionProfileDigest) throw new ManifestError("dashboard state execution profile does not match the current run");
  if (state.max_rounds !== 3) throw new ManifestError("dashboard state max_rounds must be 3");
  if (state.max_rounds_basis !== "predeclared-cost-cap") {
    throw new ManifestError("dashboard state max_rounds_basis must be predeclared-cost-cap");
  }
  const expectedEvolutionId = `evo-${sha256Json({ authority: authorityDigest, baseline: none(baseline.digest) }).slice(0, 20)}`;
  if (state.evolution_id !== expectedEvolutionId) throw new ManifestError("dashboard state evolution id is invalid");

  const initializedPlanRawPath = requireString(state.initialized_from_plan, "state.initialized_from_plan");
  if (!isRegularFile(initializedPlanRawPath)) throw new ManifestError("dashboard state initialization plan does not exist");
  const initializedPlanPath = canonicalExistingPath(initializedPlanRawPath, "dashboard state initialization plan");
  const initializedPlan = loadJson(initializedPlanPath);
  const initializedAuthority = initializedPlan.authority;
  const initializedSubject = initializedPlan.subject;
  const initializedBaseline = initializedPlan.baseline;
  const initializedExecutionProfile = initializedPlan.execution_profile;
  if (
    initializedPlan.contract !== PLAN_CONTRACT
    || !plainObject(initializedAuthority)
    || !plainObject(initializedSubject)
    || !plainObject(initializedBaseline)
    || initializedAuthority.digest !== authorityDigest
    || !same(initializedBaseline, baseline)
    || !same(initializedPlan.splits, ["selection"])
    || !plainObject(initializedExecutionProfile)
    || initializedExecutionProfile.digest !== executionProfileDigest
  ) {
    throw new ManifestError("dashboard state initialization plan does not match");
  }
  const protectedRoots = [
    resolve(requireString(subject.path, "plan.subject.path")),
    dirname(canonicalExistingPath(planPath, "dashboard plan")),
    resolve(requireString(initializedSubject.path, "initialized subject.path")),
    dirname(initializedPlanPath),
  ];
  for (const [baselineRecord, label] of [
    [baseline, "plan.baseline.path"],
    [initializedBaseline, "initialized baseline.path"],
  ]) {
    if (baselineRecord.kind === "old_skill") protectedRoots.push(resolve(requireString(baselineRecord.path, label)));
  }
  if (protectedRoots.some((root) => pathIsWithin(controlWorkspace, root) || pathIsWithin(root, controlWorkspace))) {
    throw new ManifestError("evolution control workspace overlaps a candidate, baseline, or run workspace");
  }

  const stateHistory = state.history;
  const seenRunIds = state.seen_run_ids;
  if (!Array.isArray(stateHistory) || !Array.isArray(seenRunIds)) {
    throw new ManifestError("dashboard state history and seen_run_ids must be arrays");
  }
  if (
    !seenRunIds.every((runId) => typeof runId === "string" && runId)
    || new Set(seenRunIds).size !== seenRunIds.length
  ) {
    throw new ManifestError("dashboard state contains duplicate run ids");
  }
  const candidateLineage = state.candidate_lineage;
  const rejectedCandidates = state.rejected_candidates;
  const invalidExperiments = state.invalid_experiments;
  if (![candidateLineage, rejectedCandidates, invalidExperiments].every(Array.isArray)) {
    throw new ManifestError("evolution lineage, rejected history, and invalid experiments must be arrays");
  }
  if (
    state.selection_query_count !== candidateLineage.length
    || candidateLineage.length < 1
    || candidateLineage.length > 3
    || ![0, 1].includes(state.audit_query_count)
    || !Number.isInteger(state.continuity_epoch)
    || state.continuity_epoch < 1
  ) {
    throw new ManifestError("evolution query accounting is invalid");
  }
  const lineageByRunId = validateCandidateLineage({
    lineage: candidateLineage,
    authorityDigest,
    baseline,
    executionProfileDigest,
    initializedRunId: requireString(initializedPlan.run_id, "initialized plan.run_id"),
  });
  const lineageRunIds = [...lineageByRunId.keys()];
  if (state.continuity_epoch !== candidateLineage.at(-1).continuity_epoch) {
    throw new ManifestError("evolution continuity epoch does not match lineage");
  }

  const stagingFiles = [];
  for (const name of readdirSync(stagingRoot)) {
    const stagingPath = join(stagingRoot, name);
    const metadata = lstatSync(stagingPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || !name.endsWith(".tmp")) {
      throw new ManifestError("evolution transition staging contains an invalid entry");
    }
    stagingFiles.push({ path: stagingPath, metadata });
  }
  const journalPaths = iterStrictFiles(transitionsRoot, "evolution journal", { allowHardlinks: true });
  const actualNames = journalPaths.map((path) => relative(transitionsRoot, path).split(sep).join("/"));
  const expectedNames = journalPaths.map((_, index) => `${String(index + 1).padStart(4, "0")}.json`);
  if (!same(actualNames, expectedNames)) throw new ManifestError("evolution transition journal sequence is invalid");
  const journalHistory = [];
  const journalDigests = [];
  let previousDigest = null;
  for (const [offset, path] of journalPaths.entries()) {
    const index = offset + 1;
    const metadata = lstatSync(path);
    if (![1, 2].includes(metadata.nlink)) throw new ManifestError("evolution transition journal link count is invalid");
    if (
      metadata.nlink === 2
      && !stagingFiles.some(({ metadata: candidate }) => candidate.dev === metadata.dev && candidate.ino === metadata.ino)
    ) {
      throw new ManifestError("evolution transition journal has an unbound hard link");
    }
    if ((statSync(path).mode & 0o222) !== 0) throw new ManifestError("evolution transition journal must be read-only");
    const transition = loadJson(path);
    const record = transition.record;
    if (
      transition.contract !== EVOLUTION_TRANSITION_CONTRACT
      || transition.sequence !== index
      || transition.previous_digest !== previousDigest
      || !plainObject(record)
    ) {
      throw new ManifestError("evolution transition journal record is invalid");
    }
    journalHistory.push(record);
    previousDigest = sha256File(path);
    journalDigests.push(previousDigest);
  }
  if (stateHistory.length > journalHistory.length || !same(stateHistory, journalHistory.slice(0, stateHistory.length))) {
    throw new ManifestError("evolution state history is not a prefix of its transition journal");
  }
  const history = journalHistory;
  const stateHistoryLength = stateHistory.length;

  const projection = {
    current_round: 1,
    status: "optimizing",
    next_action: "run_authorized_selection",
    terminal: false,
    audit_consumed: false,
    selected_subject_digest: null,
  };
  const validated = [];
  const historyRunIds = [];
  const selectionHistoryRunIds = [];
  let auditHistoryCount = 0;
  const reconstructedRejected = [];
  const reconstructedInvalid = [];
  let stateProjection = stateHistoryLength === 0 ? { ...projection } : null;
  let rejectedProjection = stateHistoryLength === 0 ? [] : null;
  let invalidProjection = stateHistoryLength === 0 ? [] : null;
  for (const [index, record] of history.entries()) {
    const rawDecisionPath = requireString(record.decision_path, `state.history[${index}].decision_path`);
    const decisionPath = canonicalExistingPath(rawDecisionPath, "dashboard state decision");
    if (!isRegularFile(decisionPath) || sha256File(decisionPath) !== record.decision_digest) {
      throw new ManifestError("dashboard state decision digest is missing or mismatched");
    }
    const decision = loadJson(decisionPath);
    const [decisionPlan] = validateBoundDecision(decision, decisionPath);
    const decisionPlanPath = canonicalExistingPath(requireString(decision.plan_path, "decision.plan_path"), "decision plan");
    const runId = requireString(decision.run_id, "decision.run_id");
    const expectedRecord = {
      phase: none(decision.phase),
      iteration: none(decision.iteration),
      run_id: runId,
      subject_digest: none(decisionPlan.subject?.digest),
      status: none(decision.status),
      accepted: decision.accepted === true,
      decision_path: decisionPath,
      decision_digest: sha256File(decisionPath),
      authorization: none(record.authorization),
    };
    if (!same(record, expectedRecord)) throw new ManifestError("dashboard state history does not match its decision");
    const authorization = record.authorization;
    if (!plainObject(authorization)) throw new ManifestError("dashboard history is missing audit query binding");
    if (decision.phase === "selection") {
      const lineageEntry = lineageByRunId.get(runId);
      if (
        lineageEntry === undefined
        || !same(authorization, lineageEntry.authorization)
        || !same(decisionPlan, lineageEntry.plan)
        || decisionPlanPath !== lineageEntry.path
      ) {
        throw new ManifestError("dashboard selection history is not bound to candidate lineage");
      }
      selectionHistoryRunIds.push(runId);
    } else if (decision.phase === "audit") {
      const [authorizedPlanPath, authorizedPlan] = validateAuditAuthorization({
        authorization,
        authorityDigest,
        baseline,
        executionProfileDigest,
        roundNumber: Number(projection.current_round),
        selectedSubjectDigest: requireString(projection.selected_subject_digest, "selected subject digest"),
        label: `state.history[${index}].authorization`,
      });
      if (decisionPlanPath !== authorizedPlanPath || !same(decisionPlan, authorizedPlan)) {
        throw new ManifestError("dashboard audit history is not bound to the exact authorized plan");
      }
      auditHistoryCount += 1;
    } else {
      throw new ManifestError("dashboard history decision phase is invalid");
    }
    if (decision.authority_digest !== authorityDigest) throw new ManifestError("dashboard history decision changed eval authority");
    if (!same(decision.baseline, baseline)) throw new ManifestError("dashboard history decision changed the baseline");
    if (decision.iteration !== projection.current_round) throw new ManifestError("dashboard history iteration is out of sequence");
    const phase = decision.phase;
    const experimentInvalid = decision.status === "invalid";
    if (phase === "selection") {
      if (projection.status !== "optimizing") throw new ManifestError("dashboard history contains an invalid selection transition");
      if (experimentInvalid) {
        Object.assign(projection, { status: "measurement-invalid", next_action: "propose_eval_change", terminal: true });
      } else if (decision.accepted === true) {
        Object.assign(projection, {
          status: "awaiting-audit",
          next_action: "prepare_audit",
          terminal: false,
          selected_subject_digest: none(decisionPlan.subject?.digest),
        });
      } else if (projection.current_round >= Number(state.max_rounds ?? 3)) {
        Object.assign(projection, { status: "exhausted", next_action: "stop", terminal: true });
      } else {
        projection.current_round += 1;
        projection.next_action = "propose_candidate";
      }
      if (decision.accepted !== true && !experimentInvalid) {
        reconstructedRejected.push({
          round: none(decision.iteration),
          run_id: runId,
          candidate_digest: none(decisionPlan.subject?.digest),
          status: none(decision.status),
          reason: none(decision.reason),
          repeat_consistency: none(decision.repeat_consistency),
          decision_digest: sha256File(decisionPath),
          objective_deltas: (decision.objectives ?? [])
            .filter((objective) => plainObject(objective))
            .map((objective) => ({
              case_id: none(objective.case_id),
              id: none(objective.id),
              delta: none(objective.delta),
            })),
          continuity_epoch: none(authorization.continuity_epoch),
        });
      }
    } else if (phase === "audit") {
      if (
        projection.status !== "awaiting-audit"
        || projection.audit_consumed === true
        || decisionPlan.subject?.digest !== projection.selected_subject_digest
      ) {
        throw new ManifestError("dashboard history contains an invalid audit transition");
      }
      Object.assign(projection, {
        status: experimentInvalid ? "measurement-invalid" : decision.accepted === true ? "audit-passed" : "audit-failed",
        next_action: experimentInvalid ? "propose_eval_change" : decision.accepted === true ? "request_user_release" : "stop",
        terminal: true,
        audit_consumed: true,
      });
    } else {
      throw new ManifestError("dashboard history decision phase is invalid");
    }
    if (experimentInvalid) {
      reconstructedInvalid.push({
        phase,
        round: none(decision.iteration),
        run_id: runId,
        candidate_digest: none(decisionPlan.subject?.digest),
        measurement_validity: none(decision.measurement_validity),
        reason: none(decision.reason),
        decision_digest: sha256File(decisionPath),
      });
    }
    historyRunIds.push(runId);
    validated.push([decisionPath, decision]);
    if (index + 1 === stateHistoryLength) {
      stateProjection = { ...projection };
      rejectedProjection = [...reconstructedRejected];
      invalidProjection = [...reconstructedInvalid];
    }
  }

  if (history.length > 0 && historyRunIds[0] !== initializedPlan.run_id) {
    throw new ManifestError("dashboard state history does not start from its initialization run");
  }
  if (!same(seenRunIds, historyRunIds.slice(0, stateHistoryLength))) {
    throw new ManifestError("dashboard state seen_run_ids do not match decision history");
  }
  if (stateProjection === null) throw new ManifestError("evolution state projection could not be reconstructed");
  const activeAuthorization = state.authorized_query;
  if (activeAuthorization != null && !plainObject(activeAuthorization)) {
    throw new ManifestError("authorized query must be an object or null");
  }
  const consumedPrefix = new Set(historyRunIds.slice(0, stateHistoryLength));
  if (plainObject(activeAuthorization)) {
    const activeRunId = requireString(activeAuthorization.run_id, "authorized_query.run_id");
    if (consumedPrefix.has(activeRunId)) throw new ManifestError("authorized query has already been consumed");
    const activePhase = activeAuthorization.phase;
    if (activePhase === "selection" && stateProjection.status === "optimizing") {
      const lineageEntry = lineageByRunId.get(activeRunId);
      if (
        lineageEntry === undefined
        || !same(activeAuthorization, lineageEntry.authorization)
        || activeAuthorization.round !== stateProjection.current_round
        || !authorizationBindsExactPlan(activeAuthorization, planPath)
      ) {
        throw new ManifestError("active selection query is not bound to candidate lineage");
      }
      stateProjection.next_action = "run_authorized_selection";
      if (!historyRunIds.includes(activeRunId)) projection.next_action = "run_authorized_selection";
    } else if (activePhase === "audit" && stateProjection.status === "awaiting-audit") {
      validateAuditAuthorization({
        authorization: activeAuthorization,
        authorityDigest,
        baseline,
        executionProfileDigest,
        roundNumber: Number(stateProjection.current_round),
        selectedSubjectDigest: requireString(stateProjection.selected_subject_digest, "selected subject digest"),
        label: "authorized_query",
      });
      if (!authorizationBindsExactPlan(activeAuthorization, planPath)) {
        throw new ManifestError("active audit query is not bound to the exact authorized plan");
      }
      stateProjection.next_action = "run_authorized_audit";
      if (!historyRunIds.includes(activeRunId)) projection.next_action = "run_authorized_audit";
    } else {
      throw new ManifestError("authorized query does not match evolution state");
    }
  }
  const expectedLineageRunIds = [...selectionHistoryRunIds];
  if (
    plainObject(activeAuthorization)
    && activeAuthorization.phase === "selection"
    && !expectedLineageRunIds.includes(activeAuthorization.run_id)
  ) {
    expectedLineageRunIds.push(String(activeAuthorization.run_id));
  }
  if (!same(lineageRunIds, expectedLineageRunIds)) throw new ManifestError("candidate lineage contains an unauthorized branch");
  const expectedAuditQueryCount = Number(
    auditHistoryCount > 0 || (plainObject(activeAuthorization) && activeAuthorization.phase === "audit"),
  );
  if (state.audit_query_count !== expectedAuditQueryCount) throw new ManifestError("audit query accounting is invalid");
  if (rejectedProjection === null || !same(rejectedCandidates, rejectedProjection)) {
    throw new ManifestError("rejected candidate history does not match decisions");
  }
  if (invalidProjection === null || !same(invalidExperiments, invalidProjection)) {
    throw new ManifestError("invalid experiment history does not match decisions");
  }
  for (const [key, expected] of Object.entries(stateProjection)) {
    if (!same(state[key], expected)) throw new ManifestError(`dashboard state field is inconsistent: ${key}`);
  }
  const stateHeadDigest = stateHistoryLength > 0 ? journalDigests[stateHistoryLength - 1] : null;
  if (state.journal_head_digest !== stateHeadDigest) {
    throw new ManifestError("evolution transition journal head is inconsistent");
  }
  state.history = history;
  state.seen_run_ids = historyRunIds;
  state.journal_head_digest = journalDigests.length > 0 ? journalDigests.at(-1) : null;
  state.rejected_candidates = reconstructedRejected;
  state.invalid_experiments = reconstructedInvalid;
  if (plainObject(state.authorized_query) && historyRunIds.includes(state.authorized_query.run_id)) {
    state.authorized_query = null;
  }
  Object.assign(state, projection);
  return validated;
}

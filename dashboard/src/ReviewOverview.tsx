import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FileSearch,
  GitCompareArrows,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  describeAssertionDecision,
  describeDashboardCase,
  describeEvidenceNode,
  describeReviewStatus,
} from "./evidence-semantics";
import { buildReviewViewModel } from "./review-view-model";
import type {
  DecisionAttributionId,
  DashboardData,
  SpineNode,
} from "./types";
import {
  localizeStatus,
  useUiPreferences,
  type MessageKey,
} from "./ui-preferences";

const attributionKeys: Record<DecisionAttributionId, MessageKey> = {
  skill: "attribution_skill",
  eval: "attribution_eval",
  execution_environment: "attribution_execution_environment",
  evidence: "attribution_evidence",
  human: "attribution_human",
};

const attributionActionKeys: Record<DecisionAttributionId, MessageKey> = {
  skill: "issueAction_skill",
  eval: "issueAction_eval",
  execution_environment: "issueAction_execution_environment",
  evidence: "issueAction_evidence",
  human: "issueAction_human",
};

const candidateMessageKeys = {
  accepted: "candidateAccepted",
  rejected: "candidateRejected",
  pending: "candidatePending",
  not_judged: "candidateNotJudged",
} as const satisfies Record<string, MessageKey>;

function nextActionMessageKey(nextAction: string): MessageKey | null {
  if (nextAction === "propose_candidate") return "action_generate_candidate";
  if (
    nextAction === "run_authorized_selection" ||
    nextAction === "run_authorized_audit"
  ) return "action_rerun_execution";
  if (nextAction === "prepare_audit") return "action_prepare_audit";
  if (nextAction === "propose_eval_change") return "action_propose_eval_change";
  if (nextAction === "request_user_release") return "action_request_release_confirmation";
  if (nextAction === "stop") return "nextActionStop";
  if (nextAction === "review_evidence") return "nextActionReviewEvidence";
  return null;
}

function nodeMap(data: DashboardData): Map<string, SpineNode> {
  return new Map(data.spine.map((node) => [node.id, node]));
}

function DecisionIcon({ tone }: { tone: "good" | "bad" | "warn" | "neutral" }) {
  if (tone === "good") return <Check size={17} strokeWidth={2.4} />;
  if (tone === "bad") return <X size={17} strokeWidth={2.4} />;
  return <CircleAlert size={17} />;
}

// The first blocker renders expanded as the primary blocker; the rest stay
// collapsed so they do not compete with the verdict for first-screen attention.
function BlockerContainer({
  collapsed,
  summary,
  children,
}: {
  collapsed: boolean;
  summary: string;
  children: ReactNode;
}) {
  if (!collapsed) return <>{children}</>;
  return (
    <details className="review-blocker-rest">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

function formatObjectiveDelta(locale: "en" | "zh-CN", value: number | null) {
  if (value === null) return "—";
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 3,
    signDisplay: "always",
  }).format(value);
  return formatted === "-0" ? "+0" : formatted;
}

function formatObjectiveValue(locale: "en" | "zh-CN", value: number | null | undefined) {
  if (typeof value !== "number") return "—";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value);
}

function reviewDecisionCopy(
  locale: "en" | "zh-CN",
  data: DashboardData,
  releaseReady: boolean,
  evidenceIntegrityValid: boolean,
): { title: string; detail: string } {
  const decision = data.review.decision;
  const measurementStatus = data.run.measurement?.status ?? "unverified";
  if (!evidenceIntegrityValid) {
    return locale === "zh-CN"
      ? {
          title: "证据完整性失败，暂不评价 Skill",
          detail: "运行绑定、派发回执或 Trace 尚未全部验证；先修复证据链，不能把当前结果归因到 Skill。",
        }
      : {
          title: "Evidence integrity failed — Skill not judged",
          detail: "Run bindings, dispatch receipts, or traces are not fully verified. Repair the evidence chain before attributing this result to the Skill.",
        };
  }
  if (measurementStatus !== "valid") {
    return locale === "zh-CN"
      ? {
          title: "测量不可用，暂不评价 Skill",
          detail:
            measurementStatus === "invalid"
              ? "判据校准或配对采样未通过；当前结果只能用于修复 Eval，不能归因到 Skill。"
              : "当前投影尚未证明判据与采样可信；完成测量预检前，不形成候选质量结论。",
        }
      : {
          title: "Measurement unavailable — Skill not judged",
          detail:
            measurementStatus === "invalid"
              ? "Oracle calibration or paired sampling failed. Use this run to repair the Eval, not to attribute quality to the Skill."
              : "The projection has not yet proved the oracle and sampling trustworthy, so candidate quality remains undecided.",
        };
  }
  if (
    releaseReady &&
    decision.status === "ready" &&
    decision.reason === "release_conditions_met" &&
    decision.release_eligible
  ) {
    return locale === "zh-CN"
      ? {
          title: "可以进入发布确认",
          detail: "所有发布级要求和评测场景均已满足；下一步仍由人确认是否发布。",
        }
      : {
          title: "Ready for release confirmation",
          detail: "Every release requirement and evaluation scenario passed; a human still confirms the release.",
        };
  }
  if (decision.reason === "release_gate_failed") {
    return locale === "zh-CN"
      ? {
          title: "暂不可发布",
          detail: `${decision.blocking_scenario_count} 个场景触发了 ${decision.blocking_gate_count} 项未满足的发布要求。`,
        }
      : {
          title: "Not ready for release",
          detail: `${decision.blocking_scenario_count} scenarios caused ${decision.blocking_gate_count} release requirements to fail.`,
        };
  }
  if (decision.reason === "scenario_failed") {
    return locale === "zh-CN"
      ? {
          title: "暂不可发布",
          detail: `${decision.blocking_scenario_count} 个评测场景尚未得到可接受的结果。`,
        }
      : {
          title: "Not ready for release",
          detail: `${decision.blocking_scenario_count} evaluation scenarios do not yet have an acceptable result.`,
      };
  }
  if (decision.reason === "candidate_acceptance_failed") {
    const failedCount = data.action_center.acceptance.criteria.filter(
      (criterion) => criterion.status === "failed",
    ).length;
    return locale === "zh-CN"
      ? {
          title: "候选暂不可接受",
          detail: `${failedCount} 项候选接受条件未满足；请先核对硬门禁、目标不退化与实质提升。`,
        }
      : {
          title: "Candidate is not yet acceptable",
          detail: `${failedCount} candidate acceptance criteria failed. Review hard gates, objective non-regression, and material improvement.`,
        };
  }
  if (decision.reason === "audit_required") {
    return locale === "zh-CN"
      ? {
          title: "候选已通过，等待发布审计",
          detail: "候选选拔已满足要求，但发布证据尚不完整，暂不可发布；自动完成一次性发布审计并保留结果后，才能进入发布确认。",
        }
      : {
          title: "Candidate passed; release audit pending",
          detail: "Candidate selection passed, but release evidence is incomplete and release is not ready. Complete and retain the one-shot release audit before requesting confirmation.",
        };
  }
  return locale === "zh-CN"
    ? {
        title: "证据尚不足",
        detail: "当前没有足够的完整证据形成发布判断。",
      }
    : {
        title: "Evidence is still incomplete",
        detail: "The retained evidence is not yet sufficient for a release decision.",
      };
}

export function ReviewOverview({
  data,
  onOpenEvidence,
  onOpenDiff,
  onOpenTrace,
}: {
  data: DashboardData;
  onOpenEvidence: (node: SpineNode) => void;
  onOpenDiff: () => void;
  onOpenTrace: () => void;
}) {
  const { locale, t } = useUiPreferences();
  const nodesById = nodeMap(data);
  const viewModel = buildReviewViewModel(data);
  const decisionTone = viewModel.decision.tone;
  const decision = reviewDecisionCopy(
    locale,
    data,
    decisionTone === "good",
    viewModel.validity.evidence.status === "valid",
  );
  const nextActionKey = nextActionMessageKey(data.review.next_action);
  const automaticContinuation =
    data.action_center.continuation.mode === "automatic";
  const noBlockersReady = decisionTone === "good";
  const automaticNoBlockers =
    automaticContinuation && data.review.decision.reason === "audit_required";
  const noBlockersTitleKey = noBlockersReady
    ? "releaseBlockerNone"
    : "noKnownBlockerEvidenceIncomplete";
  const configuredRatio = (passed: number, total: number) =>
    total > 0 ? `${passed}/${total}` : t("notConfigured");
  const expectedTraces = viewModel.execution.expected;
  const capturedTraces = viewModel.execution.captured;
  const releaseEvidenceIncomplete = viewModel.evidence.status !== "complete";
  const evidenceCoverageTone = releaseEvidenceIncomplete
    ? viewModel.evidence.tone
    : viewModel.execution.tone;
  const primaryBlocker = data.review.blockers[0];
  const primaryRiskEvidence = primaryBlocker?.evidence_ids
    .map((id) => nodesById.get(id))
    .find((node): node is SpineNode => Boolean(node));
  const measurementKey =
    viewModel.measurement.status === "valid"
      ? "measurementValid"
      : viewModel.measurement.status === "invalid"
        ? "measurementInvalid"
        : viewModel.measurement.status === "pending"
          ? "measurementPending"
          : "measurementUnverified";
  const evidenceIntegrityKey: MessageKey =
    viewModel.validity.evidence.status === "valid"
      ? "evidenceIntegrityValid"
      : "evidenceIntegrityInvalid";
  const measurementTone =
    viewModel.measurement.status === "invalid"
      ? "bad"
      : viewModel.measurement.tone;
  const candidateKey = candidateMessageKeys[viewModel.validity.candidate.status];
  const objectiveEvidence = data.action_center.acceptance.objectives ?? [];
  const runNode =
    nodesById.get(`run:${data.run.id}`) ??
    data.spine.find((node) => node.kind === "run");
  const invalidMeasurementCase = data.cases.find(
    (item) => item.measurement && item.measurement.status !== "valid",
  );
  const measurementEvidenceTarget =
    nodesById.get("gate:measurement:valid") ??
    (invalidMeasurementCase
      ? nodesById.get(`case:${invalidMeasurementCase.id}`)
      : undefined) ??
    runNode;
  const iterationNodes = data.spine.filter((node) => node.kind === "iteration");
  const decisionRunId = data.action_center.acceptance.decision_run_id;
  const candidateEvidenceTarget =
    (decisionRunId
      ? iterationNodes.find((node) =>
          node.id.startsWith(`iteration:${decisionRunId}:`),
        )
      : undefined) ??
    iterationNodes.at(-1) ??
    runNode;
  const validitySteps: Array<{
    key: MessageKey;
    labelKey: MessageKey;
    tone: "good" | "bad" | "warn" | "neutral";
    target: SpineNode | undefined;
  }> = [
    {
      key: evidenceIntegrityKey,
      labelKey: "evidenceIntegrity",
      tone: viewModel.validity.evidence.tone,
      target: runNode,
    },
    {
      key: measurementKey,
      labelKey: "measurementValidity",
      tone: measurementTone,
      target: measurementEvidenceTarget,
    },
    {
      key: candidateKey,
      labelKey: "candidateQuality",
      tone: viewModel.validity.candidate.tone,
      target: candidateEvidenceTarget,
    },
  ];

  return (
    <div className="review-overview">
      <section className={`review-decision-hero tone-${decisionTone}`}>
        <div className="review-decision-mark" aria-hidden="true">
          <DecisionIcon tone={decisionTone} />
        </div>
        <div className="review-decision-copy">
          <span className="pane-kicker">{t("reviewOverview")}</span>
          <h2 id="review-decision-title">{decision.title}</h2>
          <p>{decision.detail}</p>
          <div className="review-next-state-inline">
            <Bot size={13} aria-hidden="true" />
            <span>{t("recommendedNextStep")}</span>
            <strong>{t(nextActionKey ?? "nextActionReviewEvidence")}</strong>
          </div>
        </div>
        {viewModel.validity.candidate.status !== "not_judged" && (
          <div className="review-decision-counts" aria-label={t("decisionCoverage")}>
            <>
              <div>
                <strong>
                  {configuredRatio(
                    data.summary.hard_gates_passed,
                    data.summary.hard_gates_total,
                  )}
                </strong>
                <span>{t("hardGates")}</span>
              </div>
              <div>
                <strong>
                  {configuredRatio(
                    data.summary.candidate_passed,
                    data.summary.case_count,
                  )}
                </strong>
                <span>{t("casesPassed")}</span>
              </div>
            </>
          </div>
        )}
      </section>

      <section className="review-validity-chain" aria-label={t("decisionValidity")}>
        <div className="review-validity-intro">
          <strong>{t("decisionValidity")}</strong>
          <p>{t("decisionValidityDescription")}</p>
        </div>
        <ol>
          {validitySteps.map((step, index) => (
            <li className={`tone-${step.tone}`} key={step.labelKey}>
              <span className="review-validity-step" aria-hidden="true">{index + 1}</span>
              <button
                type="button"
                className="review-validity-open"
                aria-label={t("openValidityStepEvidence", {
                  step: t(step.labelKey),
                })}
                disabled={!step.target}
                onClick={() => step.target && onOpenEvidence(step.target)}
              >
                <span>
                  <small>{t(step.labelKey)}</small>
                  <strong>{t(step.key)}</strong>
                </span>
              </button>
              <DecisionIcon tone={step.tone} />
            </li>
          ))}
        </ol>
      </section>

      {objectiveEvidence.length > 0 && (
        <section
          className="review-objective-evidence"
          aria-labelledby="review-objective-evidence-title"
        >
          <header>
            <div>
              <span>{t("objectiveEvidence")}</span>
              <h3 id="review-objective-evidence-title">
                {t("objectiveEvidenceTitle")}
              </h3>
            </div>
            <p>{t("objectiveEvidenceDescription")}</p>
          </header>
          <div className="review-objective-list">
            {objectiveEvidence.map((objective) => {
              const evalCase = data.cases.find(
                (candidate) => candidate.id === objective.case_id,
              );
              const caseTitle = evalCase
                ? describeDashboardCase(locale, evalCase).title
                : objective.case_id;
              const tone = !objective.non_regressed
                ? "bad"
                : objective.materially_improved
                  ? "good"
                  : "warn";
              const statusKey: MessageKey = !objective.non_regressed
                ? "objectiveRegressionObserved"
                : objective.materially_improved
                  ? "objectiveMaterialEveryRepeat"
                  : "objectiveNonRegressedOnly";
              const objectiveCaseNode = nodesById.get(`case:${objective.case_id}`);
              const identityContent = (
                <>
                  <span>
                    <strong>{caseTitle}</strong>
                    <code>{objective.metric}</code>
                  </span>
                  <em>{t(statusKey)}</em>
                </>
              );
              return (
                <article
                  className={`review-objective-row tone-${tone}`}
                  key={`${objective.case_id}:${objective.id}`}
                >
                  {objectiveCaseNode ? (
                    <button
                      type="button"
                      className="review-objective-identity is-clickable"
                      aria-label={t("openObjectiveCaseEvidence", {
                        title: caseTitle,
                      })}
                      onClick={() => onOpenEvidence(objectiveCaseNode)}
                    >
                      {identityContent}
                    </button>
                  ) : (
                    <div className="review-objective-identity">
                      {identityContent}
                    </div>
                  )}
                  <dl>
                    {typeof objective.baseline === "number" && (
                      <div>
                        <dt>{t("objectiveBaselineValue")}</dt>
                        <dd>{formatObjectiveValue(locale, objective.baseline)}</dd>
                      </div>
                    )}
                    {typeof objective.candidate === "number" && (
                      <div>
                        <dt>{t("objectiveCandidateValue")}</dt>
                        <dd>{formatObjectiveValue(locale, objective.candidate)}</dd>
                      </div>
                    )}
                    <div>
                      <dt>{t("objectiveMeanDelta")}</dt>
                      <dd>{formatObjectiveDelta(locale, objective.delta)}</dd>
                    </div>
                    <div>
                      <dt>{t("objectivePairedDeltas")}</dt>
                      <dd>
                        <code>
                          {objective.paired_deltas
                            .map((value) => formatObjectiveDelta(locale, value))
                            .join(" · ")}
                        </code>{" "}
                        <small className="review-objective-repeats">
                          {t("objectiveRepeatCount", {
                            count: objective.repeat_count,
                          })}
                        </small>
                      </dd>
                    </div>
                    <div>
                      <dt>{t("objectiveGuardrails")}</dt>
                      <dd>
                        {t("objectiveGuardrailValues", {
                          tolerance: formatObjectiveDelta(
                            locale,
                            -objective.non_regression_tolerance,
                          ),
                          material: formatObjectiveDelta(
                            locale,
                            objective.min_material_delta,
                          ),
                        })}
                      </dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section
        className="decision-evidence-spine"
        aria-label={t("decisionEvidence")}
      >
        <button
          type="button"
          className={primaryBlocker ? "tone-bad" : noBlockersReady ? "tone-good" : "tone-warn"}
          aria-label={t("reviewPrimaryRiskEvidence")}
          disabled={!primaryRiskEvidence}
          onClick={() => primaryRiskEvidence && onOpenEvidence(primaryRiskEvidence)}
        >
          <CircleAlert size={17} aria-hidden="true" />
          <span>
            <small>{t("problemsToFix")}</small>
            <strong>
              {primaryBlocker
                ? new Intl.NumberFormat(locale).format(data.review.blockers.length)
                : noBlockersReady
                  ? t("noKnownRisk")
                  : t("evidenceIncomplete")}
            </strong>
          </span>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`tone-${evidenceCoverageTone}`}
          aria-label={t("reviewExecutionEvidence")}
          aria-describedby={
            releaseEvidenceIncomplete
              ? "review-release-evidence-quality"
              : undefined
          }
          onClick={onOpenTrace}
        >
          <ShieldCheck size={17} aria-hidden="true" />
          <span>
            <small>{t("evidenceCoverage")}</small>
            <strong>
              {expectedTraces > 0
                ? t("evidenceCoverageRatio", {
                    captured: capturedTraces,
                    expected: expectedTraces,
                  })
                : t("notConfigured")}
            </strong>
            {releaseEvidenceIncomplete && (
              <em id="review-release-evidence-quality">
                {t("evidenceIncomplete")}
              </em>
            )}
          </span>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={data.diffs.length > 0 ? "tone-neutral" : "tone-warn"}
          aria-label={t("reviewChangeEvidence")}
          onClick={onOpenDiff}
        >
          <GitCompareArrows size={17} aria-hidden="true" />
          <span>
            <small>{t("whatChanged")}</small>
            <strong>
              {data.diffs.length > 0
                ? t("changeEvidenceCount", { count: data.diffs.length })
                : t("noChangeEvidenceCaptured")}
            </strong>
          </span>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </section>

      <div className="review-body-grid">
        <section className="review-blockers" aria-labelledby="release-blockers-title">
          <header className="review-section-heading">
            <div>
              <span>{t("problemsToFix")}</span>
              <h3 id="release-blockers-title">
                {data.review.blockers.length > 0
                  ? t("releaseBlockerCount", { count: data.review.blockers.length })
                  : t(
                      noBlockersReady
                        ? "releaseBlockerNone"
                        : "noKnownBlockerEvidenceIncomplete",
                    )}
              </h3>
            </div>
            <CircleAlert size={17} aria-hidden="true" />
          </header>

          {data.review.blockers.map((blocker, blockerIndex) => {
            const isPrimaryBlocker = blockerIndex === 0;
            const criterion = blocker.criterion_ids
              .map((criterionId) =>
                data.action_center.acceptance.criteria.find(
                  (candidate) => candidate.id === criterionId,
                ),
              )
              .find((candidate) => Boolean(candidate));
            const criterionEvidence = blocker.evidence_ids
              .map((id) => nodesById.get(id))
              .filter((node): node is SpineNode => Boolean(node));
            if (blocker.kind === "criterion") {
              const primaryCriterionEvidence = criterionEvidence[0];
              const criterionTitle = criterion
                ? t(`criterion_${criterion.id}`)
                : blocker.id;
              return (
                <BlockerContainer
                  key={blocker.id}
                  collapsed={!isPrimaryBlocker}
                  summary={`${criterionTitle} · ${localizeStatus(locale, blocker.status)}`}
                >
                <article className="review-blocker-card is-criterion">
                  <header>
                    <div>
                      {isPrimaryBlocker && (
                        <span className="review-blocker-primary-tag">
                          {t("primaryBlockerLabel")}
                        </span>
                      )}
                      <span>{criterionTitle}</span>
                      <p>
                        {criterion
                          ? t(`criterion_${criterion.id}_description`)
                          : t("criterionEvidenceUnavailable")}
                      </p>
                    </div>
                    <div className="review-blocker-owner">
                      <span>{localizeStatus(locale, blocker.status)}</span>
                      {blocker.attribution && (
                        <small>{t(attributionKeys[blocker.attribution])}</small>
                      )}
                    </div>
                  </header>

                  <div className="review-issue-explanation">
                    <div>
                      <span>{t("issueWhy")}</span>
                      <strong>
                        {criterion
                          ? t("criterionFailedSummary", {
                              passed: criterion.passed,
                              total: criterion.total,
                            })
                          : localizeStatus(locale, blocker.status)}
                      </strong>
                      <p>
                        {criterion
                          ? t(`criterion_${criterion.id}_description`)
                          : t("criterionEvidenceUnavailable")}
                      </p>
                    </div>
                    <div>
                      <span>{t("issueNextStep")}</span>
                      <strong>
                        {t(
                          attributionActionKeys[
                            blocker.attribution ?? "evidence"
                          ],
                        )}
                      </strong>
                      <p>
                        {criterionEvidence.length > 0
                          ? t("issueEvidenceCount", {
                              count: criterionEvidence.length,
                            })
                          : t("criterionEvidenceUnavailable")}
                      </p>
                    </div>
                  </div>

                  {primaryCriterionEvidence && (
                    <button
                      type="button"
                      className="review-evidence-action"
                      onClick={() => onOpenEvidence(primaryCriterionEvidence)}
                    >
                      <FileSearch size={14} aria-hidden="true" />
                      {t("openProblemEvidence")}
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  )}
                </article>
                </BlockerContainer>
              );
            }
            const item = blocker.case_id
              ? data.cases.find((candidate) => candidate.id === blocker.case_id) ?? null
              : null;
            const caseNode = blocker.case_id
              ? nodesById.get(`case:${blocker.case_id}`)
              : undefined;
            const caseSemantic = item
              ? describeDashboardCase(locale, item)
              : caseNode
                ? describeEvidenceNode(locale, caseNode, data.cases)
                : null;
            const gateNodes = blocker.gate_ids
              .map((id) => nodesById.get(id))
              .filter((node): node is SpineNode => Boolean(node));
            const failedChecks = blocker.failed_check_ids
              .map((id) => nodesById.get(id))
              .filter((node): node is SpineNode => Boolean(node));
            const sourceNodes = [
              ...blocker.source_evidence_ids,
              ...blocker.missing_artifact_ids,
            ]
              .map((id) => nodesById.get(id))
              .filter((node): node is SpineNode => Boolean(node));
            const primaryEvidence = failedChecks[0] ?? gateNodes[0] ?? caseNode;
            const primaryFailedCheck = failedChecks[0];
            const primaryGate = gateNodes[0];
            const primaryReason = primaryFailedCheck
              ? describeAssertionDecision(locale, primaryFailedCheck)?.observed ??
                describeEvidenceNode(locale, primaryFailedCheck, data.cases).description
              : primaryGate
                ? describeEvidenceNode(locale, primaryGate, data.cases).description
                : caseSemantic?.description;
            const scenarioIsDisagreement =
              !primaryFailedCheck && !primaryGate && blocker.status === "disagreement";
            const disagreementCopy = scenarioIsDisagreement
              ? describeReviewStatus(locale, "disagreement")
              : null;
            return (
              <BlockerContainer
                key={blocker.id}
                collapsed={!isPrimaryBlocker}
                summary={`${caseSemantic?.title ?? blocker.id} · ${localizeStatus(locale, blocker.status)}`}
              >
              <article className="review-blocker-card">
                <header>
                  <div>
                    {isPrimaryBlocker && (
                      <span className="review-blocker-primary-tag">
                        {t("primaryBlockerLabel")}
                      </span>
                    )}
                    <span>{caseSemantic?.title ?? blocker.id}</span>
                    <p>{caseSemantic?.description}</p>
                  </div>
                  <div className="review-blocker-owner">
                    <span>{localizeStatus(locale, blocker.status)}</span>
                    {blocker.attribution && (
                      <small>{t(attributionKeys[blocker.attribution])}</small>
                    )}
                  </div>
                </header>

                <div className="review-issue-explanation">
                  <div>
                    <span>{t("issueWhy")}</span>
                    <strong>
                      {primaryFailedCheck
                        ? describeEvidenceNode(locale, primaryFailedCheck, data.cases).title
                        : primaryGate
                          ? describeEvidenceNode(locale, primaryGate, data.cases).title
                          : disagreementCopy
                            ? disagreementCopy.title
                            : t("scenarioDidNotPass")}
                    </strong>
                    <p>
                      {disagreementCopy
                        ? disagreementCopy.description
                        : primaryReason ?? t("noFailedCheckRecorded")}
                    </p>
                  </div>
                  <div>
                    <span>{t("issueNextStep")}</span>
                    <strong>
                      {t(
                        attributionActionKeys[
                          blocker.attribution ?? "evidence"
                        ],
                      )}
                    </strong>
                    <p>
                      {t("issueEvidenceSummary", {
                        checks: failedChecks.length,
                        sources: sourceNodes.length,
                      })}
                    </p>
                  </div>
                </div>

                {primaryEvidence && (
                  <button
                    type="button"
                    className="review-evidence-action"
                    onClick={() => onOpenEvidence(primaryEvidence)}
                  >
                    <FileSearch size={14} aria-hidden="true" />
                    {t("openProblemEvidence")}
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                )}
              </article>
              </BlockerContainer>
            );
          })}
          {data.review.blockers.length === 0 && (
            <div
              className={`review-no-blockers tone-${
                noBlockersReady ? "good" : "warn"
              }`}
              role="status"
              aria-label={t(noBlockersTitleKey)}
            >
              {noBlockersReady ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <CircleAlert size={16} aria-hidden="true" />
              )}
              <div>
                <strong>
                  {t(noBlockersTitleKey)}
                </strong>
                <p>
                  {noBlockersReady
                    ? t("readyForHumanConfirmation")
                    : automaticNoBlockers
                      ? t("automaticNoBlockerSummary")
                      : t("evidenceIncompleteReleaseBlocked")}
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

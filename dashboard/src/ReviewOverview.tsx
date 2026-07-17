import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FileSearch,
  ListTree,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import { nextActionMessageKey } from "./ActionCenter";
import {
  describeAssertionDecision,
  describeDashboardCase,
  describeEvidenceNode,
} from "./evidence-semantics";
import type {
  ActionAttributionId,
  DashboardData,
  SpineNode,
} from "./types";
import {
  localizeStatus,
  useUiPreferences,
  type MessageKey,
} from "./ui-preferences";

const attributionKeys: Record<ActionAttributionId, MessageKey> = {
  skill: "attribution_skill",
  eval: "attribution_eval",
  execution_environment: "attribution_execution_environment",
  evidence: "attribution_evidence",
  human: "attribution_human",
};

const attributionActionKeys: Record<ActionAttributionId, MessageKey> = {
  skill: "issueAction_skill",
  eval: "issueAction_eval",
  execution_environment: "issueAction_execution_environment",
  evidence: "issueAction_evidence",
  human: "issueAction_human",
};

function nodeMap(data: DashboardData): Map<string, SpineNode> {
  return new Map(data.spine.map((node) => [node.id, node]));
}

function DecisionIcon({ status }: { status: string }) {
  if (status === "ready") return <Check size={17} strokeWidth={2.4} />;
  if (status === "blocked") return <X size={17} strokeWidth={2.4} />;
  return <CircleAlert size={17} />;
}

function reviewDecisionCopy(
  locale: "en" | "zh-CN",
  data: DashboardData,
): { title: string; detail: string } {
  const decision = data.review.decision;
  if (decision.status === "ready") {
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
          detail: `${failedCount} 项候选接受条件未满足；请先核对硬门禁、Pareto 不退化与实质提升。`,
        }
      : {
          title: "Candidate is not yet acceptable",
          detail: `${failedCount} candidate acceptance criteria failed. Review hard gates, Pareto admissibility, and material improvement.`,
        };
  }
  if (decision.reason === "audit_required") {
    return locale === "zh-CN"
      ? {
          title: "候选已通过，等待发布审计",
          detail: "候选选拔已满足要求；自动完成一次性发布审计并保留结果后，才能进入发布确认。",
        }
      : {
          title: "Candidate passed; release audit pending",
          detail: "Candidate selection passed. Complete and retain the one-shot release audit before requesting release confirmation.",
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

export function ReviewNavigationGuide({ data }: { data: DashboardData }) {
  const { locale, t } = useUiPreferences();
  const decision = reviewDecisionCopy(locale, data);
  const nextActionKey = nextActionMessageKey(data.review.next_action);
  const automaticContinuation =
    data.action_center.continuation.mode === "automatic";
  return (
    <div className="review-navigation-guide">
      <div className="review-navigation-state">
        <span>{t("releaseState")}</span>
        <strong>{decision.title}</strong>
        <p>{decision.detail}</p>
      </div>
      <section>
        <h3>
          {t(
            automaticContinuation
              ? "automaticExecutionSteps"
              : "reviewActionPanelTitle",
          )}
        </h3>
        <p>
          {t(
            automaticContinuation
              ? "automaticActionDescription"
              : "reviewActionPanelDescription",
          )}
        </p>
        <ol>
          {automaticContinuation ? (
            <>
              <li>{t("automaticStepPrecondition")}</li>
              <li>{t("automaticStepExecute")}</li>
              <li>{t("automaticStepEvidence")}</li>
              <li>{t("automaticStepProject")}</li>
            </>
          ) : (
            <>
              <li>{t("reviewActionStepTask")}</li>
              <li>{t("reviewActionStepAgent")}</li>
              <li>{t("reviewActionStepRefresh")}</li>
            </>
          )}
        </ol>
      </section>
      <section className="review-navigation-next">
        <span>{t("recommendedNextStep")}</span>
        <strong>{t(nextActionKey ?? "nextActionReviewEvidence")}</strong>
        <small>
          {t(
            automaticContinuation
              ? "automaticLeadAgentOwnerDescription"
              : "leadAgentOwnerDescription",
          )}
        </small>
      </section>
    </div>
  );
}

export function ReviewOverview({
  data,
  archiveOpen,
  onToggleArchive,
  onOpenEvidence,
  onOpenActionCenter,
  children,
}: {
  data: DashboardData;
  archiveOpen: boolean;
  onToggleArchive: () => void;
  onOpenEvidence: (node: SpineNode) => void;
  onOpenActionCenter: () => void;
  children: ReactNode;
}) {
  const { locale, t } = useUiPreferences();
  const nodesById = nodeMap(data);
  const decision = reviewDecisionCopy(locale, data);
  const nextActionKey = nextActionMessageKey(data.review.next_action);
  const decisionTone = data.review.decision.status === "ready"
    ? "good"
    : data.review.decision.status === "blocked"
      ? "bad"
      : "warn";
  const automaticContinuation =
    data.action_center.continuation.mode === "automatic";

  return (
    <div className="review-overview">
      <section className={`review-decision-hero tone-${decisionTone}`}>
        <div className="review-decision-mark" aria-hidden="true">
          <DecisionIcon status={data.review.decision.status} />
        </div>
        <div className="review-decision-copy">
          <span className="pane-kicker">{t("reviewOverview")}</span>
          <h2>{decision.title}</h2>
          <p>{decision.detail}</p>
        </div>
        <div className="review-decision-counts" aria-label={t("decisionCoverage")}>
          <div>
            <strong>{data.summary.hard_gates_passed}/{data.summary.hard_gates_total}</strong>
            <span>{t("hardGates")}</span>
          </div>
          <div>
            <strong>{data.summary.candidate_passed}/{data.summary.case_count}</strong>
            <span>{t("casesPassed")}</span>
          </div>
        </div>
      </section>

      <div className="review-body-grid">
        <section className="review-blockers" aria-labelledby="release-blockers-title">
          <header className="review-section-heading">
            <div>
              <span>{t("problemsToFix")}</span>
              <h3 id="release-blockers-title">
                {data.review.blockers.length > 0
                  ? t("releaseBlockerCount", { count: data.review.blockers.length })
                  : t("releaseBlockerNone")}
              </h3>
            </div>
            <CircleAlert size={17} aria-hidden="true" />
          </header>

          {data.review.blockers.map((blocker) => {
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
              return (
                <article className="review-blocker-card is-criterion" key={blocker.id}>
                  <header>
                    <div>
                      <span>
                        {criterion
                          ? t(`criterion_${criterion.id}`)
                          : blocker.id}
                      </span>
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
            return (
              <article className="review-blocker-card" key={blocker.id}>
                <header>
                  <div>
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
                          : t("scenarioDidNotPass")}
                    </strong>
                    <p>{primaryReason ?? t("noFailedCheckRecorded")}</p>
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
            );
          })}
          {data.review.blockers.length === 0 && (
            <div className="review-no-blockers">
              <Check size={16} aria-hidden="true" />
              <div>
                <strong>{t("releaseBlockerNone")}</strong>
                <p>
                  {t(
                    automaticContinuation
                      ? "automaticNoBlockerSummary"
                      : "readyForHumanConfirmation",
                  )}
                </p>
              </div>
            </div>
          )}
        </section>

        <aside className="review-decision-rail">
          <section className="review-criteria-summary">
            <div className="review-rail-label">
              <ShieldCheck size={14} aria-hidden="true" />
              {t("candidateAcceptanceConditions")}
            </div>
            <ul>
              {data.action_center.acceptance.criteria.map((criterion) => (
                <li className={`tone-${criterion.status}`} key={criterion.id}>
                  <span aria-hidden="true">
                    {criterion.status === "satisfied" ? (
                      <Check size={11} />
                    ) : criterion.status === "failed" ? (
                      <X size={11} />
                    ) : (
                      <CircleAlert size={11} />
                    )}
                  </span>
                  <div>
                    <strong>{t(`criterion_${criterion.id}`)}</strong>
                    <small>{criterion.passed}/{criterion.total}</small>
                  </div>
                </li>
              ))}
            </ul>
            <div className="review-safeguard-footnote">
              <span>{t("safeguardsSatisfied")}</span>
              <strong>
                {data.review.safeguards.passed_gate_ids.length +
                  data.review.safeguards.passed_case_ids.length}
              </strong>
            </div>
            <p>{t("passedGateCount", { count: data.review.safeguards.passed_gate_ids.length })}</p>
            <p>{t("passedScenarioCount", { count: data.review.safeguards.passed_case_ids.length })}</p>
          </section>
          <section className="review-next-action">
            <div className="review-rail-label">
              <Bot size={14} aria-hidden="true" />
              {t("recommendedNextStep")}
            </div>
            <strong>{t(nextActionKey ?? "nextActionReviewEvidence")}</strong>
            <p>
              {t(
                automaticContinuation
                  ? "automaticLeadAgentOwnerDescription"
                  : "leadAgentOwnerDescription",
              )}
            </p>
            <button type="button" onClick={onOpenActionCenter}>
              {t("openActionCenter")}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </section>
        </aside>
      </div>

      <section className={`review-audit-archive ${archiveOpen ? "is-open" : ""}`}>
        <button
          type="button"
          className="review-archive-toggle"
          aria-expanded={archiveOpen}
          onClick={onToggleArchive}
        >
          <span className="review-archive-icon" aria-hidden="true">
            <ListTree size={16} />
          </span>
          <span>
            <strong>{t("auditArchive")}</strong>
            <small>{t("auditArchiveDescription")}</small>
          </span>
          <em>{data.spine.length}</em>
          <span className="review-archive-action">
            {t(archiveOpen ? "closeAuditArchive" : "openAuditArchive")}
            <ChevronRight size={14} aria-hidden="true" />
          </span>
        </button>
        {archiveOpen && <div className="review-archive-content">{children}</div>}
      </section>
    </div>
  );
}

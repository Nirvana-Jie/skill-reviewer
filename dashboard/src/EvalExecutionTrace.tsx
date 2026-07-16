import {
  Bot,
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  CircleX,
  Eye,
  FileCheck2,
  Fingerprint,
  LockKeyhole,
  Play,
  Route,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import {
  describeDashboardCase,
  describeEvidenceNode,
} from "./evidence-semantics";
import {
  firstArmEvidenceId,
  type EvalExecutionTrace,
  type ExecutionTraceGap,
} from "./eval-execution-trace";
import type { DashboardCase } from "./types";
import {
  localizeStatus,
  localizeValue,
  useUiPreferences,
} from "./ui-preferences";

type TraceTone = "good" | "bad" | "warn";

function shortDigest(value: string | null | undefined): string {
  if (!value) return "—";
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function TraceStateIcon({ tone, size = 15 }: { tone: TraceTone; size?: number }) {
  if (tone === "good") {
    return <CheckCircle2 size={size} strokeWidth={2} aria-hidden="true" />;
  }
  if (tone === "bad") {
    return <CircleX size={size} strokeWidth={2.15} aria-hidden="true" />;
  }
  return <CircleHelp size={size} strokeWidth={2} aria-hidden="true" />;
}

function caseTone(status: string): TraceTone {
  if (status === "passed") return "good";
  if (["failed", "rejected", "regressed", "invalid"].includes(status)) {
    return "bad";
  }
  return "warn";
}

function repeatTone(
  execution: NonNullable<EvalExecutionTrace["arms"][number]["executions"]>[number],
): TraceTone {
  if (
    execution.status !== "completed" ||
    execution.binding_error_count > 0 ||
    !execution.execution_digest
  ) {
    return "bad";
  }
  if (
    execution.assertions.total > 0 &&
    execution.assertions.passed < execution.assertions.total
  ) {
    return "bad";
  }
  return "good";
}

function EvidenceLink({
  label,
  nodeId,
  onOpenEvidence,
}: {
  label: string;
  nodeId: string | null | undefined;
  onOpenEvidence: (nodeId: string) => void;
}) {
  if (!nodeId) return null;
  return (
    <button
      type="button"
      className="trace-evidence-link"
      onClick={() => onOpenEvidence(nodeId)}
    >
      {label}
      <ChevronRight size={12} aria-hidden="true" />
    </button>
  );
}

function FlowStep({
  index,
  icon,
  title,
  description,
  children,
}: {
  index: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <li className="eval-flow-step">
      <div className="eval-flow-marker" aria-hidden="true">
        {icon}
        <span>{index}</span>
      </div>
      <article className="eval-flow-card">
        <header>
          <div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
        </header>
        {children}
      </article>
    </li>
  );
}

function gapMessageKey(gap: ExecutionTraceGap) {
  return `traceGap_${gap}` as const;
}

export function EvalExecutionTraceView({
  trace,
  cases,
  manifest,
  planDigest,
  executionProfile,
  onSelectCase,
  onOpenEvidence,
}: {
  trace: EvalExecutionTrace;
  cases: DashboardCase[];
  manifest: { path: string; digest: string } | null | undefined;
  planDigest: string | null | undefined;
  executionProfile:
    | {
        target?: string;
        harness?: string;
        isolation?: string;
        digest?: string;
      }
    | null
    | undefined;
  onSelectCase: (caseId: string) => void;
  onOpenEvidence: (nodeId: string) => void;
}) {
  const { locale, t } = useUiPreferences();
  const scenario = describeDashboardCase(locale, trace.case);
  const traceTone: TraceTone =
    trace.confidence === "verified" ? "good" : "warn";
  const hiddenInput = trace.case.holdout_visibility === "opaque";

  return (
    <section className="eval-execution-stage" aria-label={t("executionTrace")}>
      <header className="execution-trace-hero">
        <div>
          <span className="pane-kicker">{t("executionTraceKicker")}</span>
          <h2>{t("executionTraceTitle")}</h2>
          <p>{t("executionTraceDescription")}</p>
        </div>
        <div className={`trace-confidence-pill is-${traceTone}`}>
          <TraceStateIcon tone={traceTone} />
          <span>
            <small>{t("traceConfidence")}</small>
            <strong>
              {t(
                trace.confidence === "verified"
                  ? "verifiedTrace"
                  : "partialTrace",
              )}
            </strong>
          </span>
        </div>
      </header>

      <div className="observable-boundary" role="note">
        <Eye size={15} aria-hidden="true" />
        <div>
          <strong>{t("observableEvidenceBoundary")}</strong>
          <p>{t("observableEvidenceBoundaryDescription")}</p>
        </div>
      </div>

      <div className="trace-case-picker">
        <span>{t("selectTraceCase")}</span>
        <div role="tablist" aria-label={t("selectTraceCase")}>
          {cases.map((item) => {
            const copy = describeDashboardCase(locale, item);
            const tone = caseTone(item.status);
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={item.id === trace.case.id}
                className={item.id === trace.case.id ? "is-active" : ""}
                onClick={() => onSelectCase(item.id)}
              >
                <TraceStateIcon tone={tone} size={13} />
                <span>{copy.title}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="trace-binding-strip" aria-label={t("lockedEvalDefinition")}>
        <div>
          <Braces size={14} aria-hidden="true" />
          <span>
            <small>{t("manifestDigest")}</small>
            <strong title={manifest?.path}>{shortDigest(manifest?.digest)}</strong>
          </span>
        </div>
        <div>
          <LockKeyhole size={14} aria-hidden="true" />
          <span>
            <small>{t("planDigest")}</small>
            <strong>{shortDigest(planDigest)}</strong>
          </span>
        </div>
        <div>
          <Fingerprint size={14} aria-hidden="true" />
          <span>
            <small>{t("executionProfileDigest")}</small>
            <strong>{shortDigest(executionProfile?.digest)}</strong>
          </span>
        </div>
      </div>

      <ol className="eval-flow">
        <FlowStep
          index="01"
          icon={<Braces size={15} />}
          title={t("configStage")}
          description={t("configStageDescription")}
        >
          <div className="trace-scenario-heading">
            <span>
              <strong>{scenario.title}</strong>
              <small>{scenario.description}</small>
            </span>
            <code>{trace.case.id}</code>
          </div>
          <dl className="trace-facts">
            <div>
              <dt>{t("promptInput")}</dt>
              <dd>
                {hiddenInput
                  ? t("hiddenHoldoutInput")
                  : trace.case.prompt || t("notRecorded")}
              </dd>
            </div>
            <div>
              <dt>{t("inputFiles")}</dt>
              <dd>
                {hiddenInput
                  ? t("hiddenHoldoutInput")
                  : trace.case.input_files?.length
                    ? trace.case.input_files.join(", ")
                    : t("noInputFiles")}
              </dd>
            </div>
            <div>
              <dt>{t("determinism")}</dt>
              <dd>{localizeValue(locale, trace.case.determinism)}</dd>
            </div>
            <div>
              <dt>{t("configuredRepeats")}</dt>
              <dd>{trace.case.repeats}</dd>
            </div>
          </dl>
          <EvidenceLink
            label={t("openTraceEvidence")}
            nodeId={trace.caseNode?.id}
            onOpenEvidence={onOpenEvidence}
          />
        </FlowStep>

        <FlowStep
          index="02"
          icon={<Bot size={15} />}
          title={t("dispatchStage")}
          description={t("dispatchStageDescription")}
        >
          <div className="dispatch-binding">
            <div>
              <small>{t("target")}</small>
              <strong>
                {executionProfile?.target
                  ? localizeValue(locale, executionProfile.target)
                  : t("notRecorded")}
              </strong>
            </div>
            <ChevronRight size={15} aria-hidden="true" />
            <div>
              <small>{t("harness")}</small>
              <strong>
                {executionProfile?.harness
                  ? localizeValue(locale, executionProfile.harness)
                  : t("notRecorded")}
              </strong>
            </div>
            <ChevronRight size={15} aria-hidden="true" />
            <div>
              <small>{t("controlBoundary")}</small>
              <strong>
                {executionProfile?.isolation
                  ? localizeValue(locale, executionProfile.isolation)
                  : t("notRecorded")}
              </strong>
            </div>
          </div>
          <EvidenceLink
            label={t("openTraceEvidence")}
            nodeId={trace.runNode?.id}
            onOpenEvidence={onOpenEvidence}
          />
        </FlowStep>

        <FlowStep
          index="03"
          icon={<Play size={15} />}
          title={t("executionStage")}
          description={t("executionStageDescription")}
        >
          <div className="execution-count-line">
            <span>{t("plannedVsObserved")}</span>
            <strong>
              {trace.observedExecutions} / {trace.expectedExecutions}
            </strong>
          </div>
          <div className="execution-arm-grid">
            {trace.arms.map((arm) => {
              const tone: TraceTone = arm.complete
                ? arm.passed
                  ? "good"
                  : "bad"
                : "warn";
              const evidenceId = firstArmEvidenceId(trace, arm.id);
              return (
                <article className={`execution-arm is-${tone}`} key={arm.id}>
                  <header>
                    <TraceStateIcon tone={tone} />
                    <span>
                      <small>{t("executionArm")}</small>
                      <strong>{localizeValue(locale, arm.id)}</strong>
                    </span>
                    <em>{localizeStatus(locale, arm.complete ? (arm.passed ? "passed" : "failed") : "incomplete")}</em>
                  </header>
                  <div className="execution-repeat-strip" aria-label={t("repeatExecution")}>
                    {(arm.executions ?? []).map((execution) => {
                      const executionTone = repeatTone(execution);
                      return (
                        <span
                          key={execution.repeat}
                          className={`repeat-token is-${executionTone}`}
                          title={execution.execution_digest ?? undefined}
                        >
                          <TraceStateIcon tone={executionTone} size={12} />
                          R{execution.repeat}
                        </span>
                      );
                    })}
                    {(arm.executions ?? []).length === 0 && (
                      <span className="repeat-token is-warn">
                        <CircleHelp size={12} aria-hidden="true" />
                        {t("notRecorded")}
                      </span>
                    )}
                  </div>
                  <dl>
                    <div>
                      <dt>{t("deterministicAssertions")}</dt>
                      <dd>{arm.assertions.passed} / {arm.assertions.total}</dd>
                    </div>
                    <div>
                      <dt>{t("evidenceRecords")}</dt>
                      <dd>{arm.artifact_count}</dd>
                    </div>
                  </dl>
                  <EvidenceLink
                    label={t("openTraceEvidence")}
                    nodeId={evidenceId}
                    onOpenEvidence={onOpenEvidence}
                  />
                </article>
              );
            })}
          </div>
        </FlowStep>

        <FlowStep
          index="04"
          icon={<FileCheck2 size={15} />}
          title={t("assertionStage")}
          description={t("assertionStageDescription")}
        >
          <div className="assertion-summary-grid">
            <div>
              <small>{t("deterministicAssertions")}</small>
              <strong>
                {trace.deterministicAssertions.passed} / {trace.deterministicAssertions.total}
              </strong>
            </div>
            <div>
              <small>{t("semanticAssertions")}</small>
              <strong>
                {trace.semanticAssertions.passed} / {trace.semanticAssertions.total}
              </strong>
            </div>
            <div>
              <small>{t("failedChecks")}</small>
              <strong>{trace.failedAssertionNodes.length}</strong>
            </div>
          </div>
          <div className="trace-assertion-list">
            {trace.failedAssertionNodes.map((node) => {
              const copy = describeEvidenceNode(locale, node, cases);
              return (
                <button
                  type="button"
                  key={node.id}
                  onClick={() => onOpenEvidence(node.id)}
                >
                  <CircleX size={13} strokeWidth={2.1} aria-hidden="true" />
                  <span>
                    <em>
                      {t("assertionExecutionContext", {
                        arm: node.arm
                          ? localizeValue(locale, node.arm)
                          : t("notRecorded"),
                        repeat: node.repeat ?? t("notRecorded"),
                      })}
                    </em>
                    <strong>{copy.title}</strong>
                    <small>{copy.description}</small>
                  </span>
                  <ChevronRight size={12} aria-hidden="true" />
                </button>
              );
            })}
            {trace.failedAssertionNodes.length === 0 && (
              <div className="trace-no-failures">
                <CheckCircle2 size={14} aria-hidden="true" />
                {t("noFailedChecks")}
              </div>
            )}
          </div>
        </FlowStep>

        <FlowStep
          index="05"
          icon={<ShieldCheck size={15} />}
          title={t("outcomeStage")}
          description={t("outcomeStageDescription")}
        >
          <div className="trace-outcome-grid">
            <div className={`trace-outcome is-${caseTone(trace.case.status)}`}>
              <TraceStateIcon tone={caseTone(trace.case.status)} />
              <span>
                <small>{t("caseResultsLabel")}</small>
                <strong>{localizeStatus(locale, trace.case.status)}</strong>
              </span>
            </div>
            <div className="trace-gates">
              <span>{t("releaseGateResults")}</span>
              {trace.gateNodes.map((node) => {
                const tone = caseTone(node.status);
                const copy = describeEvidenceNode(locale, node, cases);
                return (
                  <button
                    type="button"
                    key={node.id}
                    onClick={() => onOpenEvidence(node.id)}
                  >
                    <TraceStateIcon tone={tone} size={13} />
                    <span>{copy.title}</span>
                  </button>
                );
              })}
              {trace.gateNodes.length === 0 && <small>{t("notRecorded")}</small>}
            </div>
          </div>
          <EvidenceLink
            label={t("openTraceEvidence")}
            nodeId={trace.caseNode?.id}
            onOpenEvidence={onOpenEvidence}
          />
        </FlowStep>
      </ol>
    </section>
  );
}

export function EvalExecutionTraceGuide({
  trace,
  manifest,
  planDigest,
  executionProfileDigest,
}: {
  trace: EvalExecutionTrace;
  manifest: { path: string; digest: string } | null | undefined;
  planDigest: string | null | undefined;
  executionProfileDigest: string | null | undefined;
}) {
  const { t } = useUiPreferences();
  const tone: TraceTone = trace.confidence === "verified" ? "good" : "warn";

  return (
    <div className="execution-trace-inspector-body">
      <section className={`trace-inspector-confidence is-${tone}`}>
        <TraceStateIcon tone={tone} size={17} />
        <span>
          <small>{t("traceConfidence")}</small>
          <strong>
            {t(trace.confidence === "verified" ? "verifiedTrace" : "partialTrace")}
          </strong>
          <p>
            {t(
              trace.confidence === "verified"
                ? "verifiedTraceDescription"
                : "partialTraceDescription",
            )}
          </p>
        </span>
      </section>

      <section>
        <h3>{t("actualExecution")}</h3>
        <p>
          {t("observedExecutionSummary", {
            observed: trace.observedExecutions,
            expected: trace.expectedExecutions,
            evidence: trace.caseNodes.length,
          })}
        </p>
        <dl className="trace-inspector-bindings">
          <div>
            <dt>{t("manifestDigest")}</dt>
            <dd>{shortDigest(manifest?.digest)}</dd>
          </div>
          <div>
            <dt>{t("planDigest")}</dt>
            <dd>{shortDigest(planDigest)}</dd>
          </div>
          <div>
            <dt>{t("executionProfileDigest")}</dt>
            <dd>{shortDigest(executionProfileDigest)}</dd>
          </div>
        </dl>
      </section>

      {trace.gaps.length > 0 && (
        <section className="trace-gap-section">
          <h3>
            <TriangleAlert size={14} aria-hidden="true" />
            {t("traceGaps")}
          </h3>
          <ul>
            {trace.gaps.map((gap) => (
              <li key={gap}>{t(gapMessageKey(gap))}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="analysis-boundary">
        <Route size={15} aria-hidden="true" />
        <div>
          <h3>{t("analysisBoundary")}</h3>
          <strong>{t("noPrivateReasoning")}</strong>
          <p>{t("noPrivateReasoningDescription")}</p>
        </div>
      </section>
    </div>
  );
}

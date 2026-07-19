import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  CircleX,
  Eye,
  FileCheck2,
  FileOutput,
  FileSearch,
  Fingerprint,
  GitCompareArrows,
  LockKeyhole,
  MessageSquareText,
  PackageCheck,
  Play,
  Route,
  ShieldCheck,
  SquareTerminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import {
  describeDashboardCase,
  describeEvidenceNode,
} from "./evidence-semantics";
import type {
  AssertionComparisonConclusion,
  AssertionComparisonGroup,
  AssertionComparisonLane,
  EvalExecutionTrace,
} from "./eval-execution-trace";
import {
  buildTraceCaseIndex,
  buildTraceAttentionSummary,
  buildTraceExecutionMatrix,
  classifyTraceExecutor,
  hasInspectableTraceExecution,
  isVerifiedTraceExecution,
  resolveTraceEventSemantics,
  type TraceSemanticTone,
} from "./eval-execution-trace";
import type {
  AgentTraceEventKind,
  DashboardCase,
  DashboardExecution,
} from "./types";
import {
  localizeStatus,
  localizeValue,
  type MessageKey,
  useUiPreferences,
} from "./ui-preferences";

type TraceTone = TraceSemanticTone;

function shortDigest(value: string | null | undefined): string {
  if (!value) return "—";
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds == null || !Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
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

function statusTone(status: string): TraceTone {
  if (["passed", "retained", "agreement"].includes(status)) {
    return "good";
  }
  if (
    ["failed", "rejected", "regressed", "invalid", "timed_out", "interrupted"].includes(
      status,
    )
  ) {
    return "bad";
  }
  if (status === "completed") return "neutral";
  return "warn";
}

function executionTone(execution: DashboardExecution): TraceTone {
  if (
    ["failed", "rejected", "invalid", "timed_out", "interrupted"].includes(
      execution.status,
    )
  ) {
    return "bad";
  }
  if (!isVerifiedTraceExecution(execution)) {
    return "warn";
  }
  if (
    execution.assertions.total > 0 &&
    execution.assertions.passed < execution.assertions.total
  ) {
    return "bad";
  }
  if (
    execution.assertions.total > 0 &&
    execution.assertions.passed === execution.assertions.total
  ) {
    return "good";
  }
  return "neutral";
}

function comparisonTone(conclusion: AssertionComparisonConclusion): TraceTone {
  if (["candidate_improved", "both_passed"].includes(conclusion)) return "good";
  if (["candidate_regressed", "both_failed"].includes(conclusion)) return "bad";
  return "warn";
}

function assertionLaneTone(lane: AssertionComparisonLane): TraceTone {
  if (lane.state === "passed") return "good";
  if (lane.state === "failed") return "bad";
  return "warn";
}

function comparisonMessageKey(
  conclusion: AssertionComparisonConclusion,
): MessageKey {
  return `comparison_${conclusion}` as MessageKey;
}

function eventIcon(kind: AgentTraceEventKind) {
  const props = { size: 15, strokeWidth: 1.9, "aria-hidden": true } as const;
  switch (kind) {
    case "execution_started":
      return <Play {...props} />;
    case "file_read":
      return <FileSearch {...props} />;
    case "tool_call":
      return <Wrench {...props} />;
    case "command":
      return <SquareTerminal {...props} />;
    case "agent_message":
      return <MessageSquareText {...props} />;
    case "artifact_written":
      return <FileOutput {...props} />;
    case "error":
      return <TriangleAlert {...props} />;
    case "execution_finished":
      return <PackageCheck {...props} />;
  }
}

function displayDetail(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function findTraceEventContexts(
  trace: EvalExecutionTrace,
  eventIds: string[] | null | undefined,
  expectedArm?: string,
  expectedRepeat?: number,
): Array<{ eventId: string; arm: string; repeat: number }> {
  if (!eventIds?.length) return [];
  const wanted = new Set(eventIds);
  const contexts: Array<{ eventId: string; arm: string; repeat: number }> = [];
  for (const arm of trace.arms) {
    for (const execution of arm.executions ?? []) {
      if (expectedArm && arm.id !== expectedArm) continue;
      if (expectedRepeat && execution.repeat !== expectedRepeat) continue;
      if (!hasInspectableTraceExecution(execution)) continue;
      const events = execution.trace?.events.filter(
        (item) =>
          wanted.has(item.event_id) &&
          item.case_id === trace.case.id &&
          item.arm === arm.id &&
          item.repeat === execution.repeat,
      ) ?? [];
      events.forEach((event) => {
        contexts.push({
          eventId: event.event_id,
          arm: arm.id,
          repeat: execution.repeat,
        });
      });
    }
  }
  return contexts;
}

function PairedAssertionComparison({
  group,
  trace,
  cases,
  onOpenEvidence,
  onOpenTraceEvent,
}: {
  group: AssertionComparisonGroup;
  trace: EvalExecutionTrace;
  cases: DashboardCase[];
  onOpenEvidence: (nodeId: string) => void;
  onOpenTraceEvent: (eventId: string, arm: string, repeat: number) => void;
}) {
  const { locale, t } = useUiPreferences();
  const representative = group.nodes[0];
  if (!representative) return null;
  const copy = describeEvidenceNode(locale, representative, cases);
  const tone = comparisonTone(group.conclusion);

  return (
    <article className={`paired-assertion is-${tone}`}>
      <header className="paired-assertion-header">
        <span className="paired-assertion-copy">
          <FileCheck2 size={15} aria-hidden="true" />
          <span>
            <strong>{copy.title}</strong>
            <small>{copy.description}</small>
          </span>
        </span>
        <span className={`comparison-conclusion is-${tone}`}>
          <small>{t("comparisonConclusion")}</small>
          <strong>{t(comparisonMessageKey(group.conclusion))}</strong>
        </span>
      </header>
      <div className="paired-assertion-lanes">
        {group.lanes.map((lane) => {
          const laneTone = assertionLaneTone(lane);
          const candidate = lane.arm === "with_skill";
          return (
            <section
              className={`assertion-lane ${candidate ? "is-candidate" : "is-baseline"} is-${laneTone}`}
              key={lane.arm}
            >
              <header>
                <span>
                  <small>{t(candidate ? "candidateLane" : "baselineLane")}</small>
                  <strong>{localizeValue(locale, lane.arm)}</strong>
                </span>
                <span className={`assertion-lane-status is-${laneTone}`}>
                  <TraceStateIcon tone={laneTone} size={13} />
                  {localizeStatus(locale, lane.state)}
                </span>
              </header>
              <div className="assertion-observations">
                {lane.nodes.map((node) => {
                  const sourceEventIds = Array.isArray(
                    node.assertion_evidence?.source_event_ids,
                  )
                    ? node.assertion_evidence.source_event_ids.filter(
                        (value): value is string => typeof value === "string",
                      )
                    : [];
                  const traceEventContexts = findTraceEventContexts(
                    trace,
                    sourceEventIds,
                    lane.arm,
                    node.repeat ?? 1,
                  );
                  return (
                    <div
                      className={`assertion-observation is-${statusTone(node.status)}`}
                      key={node.id}
                    >
                      <button
                        type="button"
                        className="assertion-observation-evidence"
                        onClick={() => onOpenEvidence(node.id)}
                      >
                        <TraceStateIcon tone={statusTone(node.status)} size={13} />
                        <span>
                          <strong>{t("repeatObservation", { repeat: node.repeat ?? 1 })}</strong>
                          <small>
                            {localizeStatus(locale, node.status)} · {t("linkedTraceEvents", {
                              count: traceEventContexts.length,
                            })}
                          </small>
                        </span>
                      </button>
                      {traceEventContexts[0] && (
                        <button
                          type="button"
                          className="assertion-trace-event-link"
                          onClick={() =>
                            onOpenTraceEvent(
                              traceEventContexts[0].eventId,
                              traceEventContexts[0].arm,
                              traceEventContexts[0].repeat,
                            )
                          }
                        >
                          <Route size={12} aria-hidden="true" />
                          {t("locateTraceEvent")}
                        </button>
                      )}
                    </div>
                  );
                })}
                {lane.nodes.length === 0 && (
                  <div className="assertion-observation-empty">
                    <CircleHelp size={13} aria-hidden="true" />
                    {t("missingArmObservation")}
                  </div>
                )}
              </div>
            </section>
          );
        })}
        {group.lanes.length === 2 && (
          <span className="paired-versus" aria-hidden="true">VS</span>
        )}
      </div>
    </article>
  );
}

function TraceTimeline({
  execution,
  selectedEventId,
  onSelectEvent,
}: {
  execution: DashboardExecution | null;
  selectedEventId: string | null;
  onSelectEvent: (eventId: string | null) => void;
}) {
  const { locale, t } = useUiPreferences();
  const trace =
    execution &&
    hasInspectableTraceExecution(execution) &&
    execution.trace?.valid === true
      ? execution.trace
      : null;

  if (!execution || !trace) {
    return (
      <div className="trace-empty-state" role="status">
        <Eye size={24} aria-hidden="true" />
        <strong>{t("realTraceMissing")}</strong>
        <p>{t("realTraceMissingDescription")}</p>
      </div>
    );
  }

  return (
    <section className="agent-trace-record">
      <header className="trace-record-summary">
        <span>
          <small>{t("captureSource")}</small>
          <strong>{localizeValue(locale, trace.capture_source)}</strong>
        </span>
        <span>
          <small>{t("capturedEvents")}</small>
          <strong>{trace.event_count}</strong>
        </span>
        <span>
          <small>{t("duration")}</small>
          <strong>{formatDuration(trace.duration_ms)}</strong>
        </span>
        <span>
          <small>{t("traceDigest")}</small>
          <strong title={trace.digest}>{shortDigest(trace.digest)}</strong>
        </span>
      </header>

      <ol className="agent-event-timeline" aria-label={t("eventTimeline")}>
        {trace.events.map((event) => {
          const selected = selectedEventId === event.event_id;
          const tone = resolveTraceEventSemantics(event).tone;
          return (
            <li
              id={`trace-event-${event.event_id}`}
              key={event.event_id}
              className={`agent-event is-${tone} ${selected ? "is-selected" : ""}`}
            >
              <button
                type="button"
                className="agent-event-summary"
                aria-expanded={selected}
                onClick={() => onSelectEvent(selected ? null : event.event_id)}
              >
                <span className="agent-event-marker">{eventIcon(event.kind)}</span>
                <span className="agent-event-copy">
                  <small>
                    {t("eventSequence", { sequence: event.sequence })} · {localizeValue(locale, event.kind)}
                  </small>
                  <strong>{event.summary}</strong>
                  <em>
                    +{formatDuration(event.elapsed_ms)} · {localizeStatus(locale, event.status)}
                  </em>
                </span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
              {selected && (
                <div className="agent-event-details">
                  <dl>
                    {Object.entries(event.details).map(([key, value]) => (
                      <div key={key}>
                        <dt>{localizeValue(locale, key)}</dt>
                        <dd><code>{displayDetail(value)}</code></dd>
                      </div>
                    ))}
                  </dl>
                  {Object.keys(event.details).length === 0 && (
                    <p>{t("noEventDetails")}</p>
                  )}
                  {event.artifact_refs.length > 0 && (
                    <div className="event-artifact-refs">
                      <strong>{t("artifactReferences")}</strong>
                      {event.artifact_refs.map((path) => <code key={path}>{path}</code>)}
                    </div>
                  )}
                  <span className="event-technical-id">{event.event_id}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
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
        capabilities?: string[];
        isolation?: string;
        digest?: string;
      }
    | null
    | undefined;
  onSelectCase: (caseId: string) => void;
  onOpenEvidence: (nodeId: string) => void;
}) {
  const { locale, t } = useUiPreferences();
  const [selectedArmId, setSelectedArmId] = useState(trace.arms[0]?.id ?? "");
  const [selectedRepeat, setSelectedRepeat] = useState(1);
  const [selectedTraceEventId, setSelectedTraceEventId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setSelectedArmId(trace.arms[0]?.id ?? "");
    setSelectedRepeat(1);
    setSelectedTraceEventId(null);
  }, [trace.case.id]);

  const selectedArm =
    trace.arms.find((arm) => arm.id === selectedArmId) ?? trace.arms[0] ?? null;
  const selectedExecution =
    selectedArm?.executions?.find(
      (execution) => execution.repeat === selectedRepeat,
    ) ?? null;
  const scenario = describeDashboardCase(locale, trace.case);
  const confidenceTone: TraceTone = trace.confidence === "verified" ? "good" : "warn";
  const caseIndex = useMemo(() => buildTraceCaseIndex(cases), [cases]);
  const attention = useMemo(() => buildTraceAttentionSummary(trace), [trace]);
  const executionMatrix = useMemo(
    () => buildTraceExecutionMatrix(trace),
    [trace],
  );
  const executor = useMemo(
    () => classifyTraceExecutor(executionProfile, selectedExecution),
    [executionProfile, selectedExecution],
  );
  const executorLabel = t(
    executor.kind === "native_subagent"
      ? "nativeSubagent"
      : executor.kind === "local_agent_process"
        ? "localAgentProcess"
      : executor.kind === "declared_agent_profile"
        ? "declaredAgentProfile"
        : executor.kind === "external_agent_harness"
          ? "externalAgentHarness"
          : "executorNotRecorded",
  );

  useEffect(() => {
    const events =
      selectedExecution && hasInspectableTraceExecution(selectedExecution)
        ? selectedExecution.trace.events
        : [];
    if (
      selectedTraceEventId &&
      !events.some((event) => event.event_id === selectedTraceEventId)
    ) {
      setSelectedTraceEventId(null);
    }
  }, [selectedExecution?.trace?.digest, selectedTraceEventId]);

  useEffect(() => {
    if (!selectedTraceEventId) return undefined;
    const handle = window.setTimeout(() => {
      document
        .getElementById(`trace-event-${selectedTraceEventId}`)
        ?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    }, 0);
    return () => window.clearTimeout(handle);
  }, [selectedArmId, selectedRepeat, selectedTraceEventId]);

  return (
    <section className="eval-execution-stage" aria-label={t("executionTrace")}>
      <header className="execution-trace-hero">
        <div>
          <span className="pane-kicker">{t("executionTraceKicker")}</span>
          <h2>{t("executionTraceTitle")}</h2>
          <p>{t("executionTraceDescription")}</p>
        </div>
        <div className={`trace-confidence-pill is-${confidenceTone}`}>
          <TraceStateIcon tone={confidenceTone} />
          <span>
            <small>{t("capturedAgentTraces")}</small>
            <strong>{trace.capturedTraces} / {trace.expectedExecutions}</strong>
          </span>
        </div>
      </header>

      <section
        className="trace-attention-summary"
        aria-label={t("traceAttentionSummary")}
      >
        <header>
          <span>
            <TriangleAlert size={16} aria-hidden="true" />
            <h3>{t("traceAttentionTitle")}</h3>
          </span>
          <p>{t("traceAttentionDescription")}</p>
        </header>
        <div className="trace-attention-grid">
          <article
            className={
              attention.failedChecks + attention.failedEvents > 0
                ? "is-bad"
                : "is-good"
            }
          >
            <CircleX size={16} aria-hidden="true" />
            <span>
              <strong>{attention.failedChecks + attention.failedEvents}</strong>
              <small>{t("traceFailures")}</small>
            </span>
            <em>
              {t("traceFailureBreakdown", {
                checks: attention.failedChecks,
                events: attention.failedEvents,
              })}
            </em>
          </article>
          <article className={attention.evidenceGaps > 0 ? "is-warn" : "is-good"}>
            <FileSearch size={16} aria-hidden="true" />
            <span>
              <strong>{attention.evidenceGaps}</strong>
              <small>{t("traceEvidenceGaps")}</small>
            </span>
          </article>
          <article
            className={attention.comparisonDifferences > 0 ? "is-warn" : "is-neutral"}
          >
            <GitCompareArrows size={16} aria-hidden="true" />
            <span>
              <strong>{attention.comparisonDifferences}</strong>
              <small>{t("traceComparisonDifferences")}</small>
            </span>
          </article>
          <article className={attention.slowExecutions.length > 0 ? "is-warn" : "is-neutral"}>
            <Route size={16} aria-hidden="true" />
            <span>
              <strong>{attention.slowExecutions.length}</strong>
              <small>{t("traceSlowExecutions")}</small>
            </span>
            <em>
              {t("traceSlowThreshold", {
                duration: formatDuration(attention.slowThresholdMs),
              })}
            </em>
          </article>
        </div>
      </section>

      {cases.length > 1 && (
      <section className="trace-case-index" aria-labelledby="trace-case-index-title">
        <header>
          <span>
            <small>{t("selectTraceCase")}</small>
            <h3 id="trace-case-index-title">{t("traceCaseIndexTitle")}</h3>
          </span>
          <p>{t("traceCaseIndexDescription")}</p>
        </header>
        <div className="trace-case-table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t("traceCaseColumn")}</th>
                <th scope="col">{t("traceStageColumn")}</th>
                <th scope="col">{t("tracePolicyColumn")}</th>
                <th scope="col">{t("traceCoverageColumn")}</th>
                <th scope="col">{t("traceDurationColumn")}</th>
                <th scope="col">{t("traceStatusColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {caseIndex.map((entry) => {
                const copy = describeDashboardCase(locale, entry.case);
                const active = entry.id === trace.case.id;
                return (
                  <tr className={active ? "is-active" : ""} key={entry.id}>
                    <th scope="row">
                      <button
                        type="button"
                        aria-label={copy.title}
                        aria-current={active ? "true" : undefined}
                        onClick={() => onSelectCase(entry.id)}
                      >
                        <TraceStateIcon
                          tone={entry.needsAttention ? "bad" : "good"}
                          size={14}
                        />
                        <span>
                          <strong>{copy.title}</strong>
                          <small>{entry.id}</small>
                        </span>
                        <ChevronRight size={13} aria-hidden="true" />
                      </button>
                    </th>
                    <td>{localizeValue(locale, entry.case.split)}</td>
                    <td>
                      {entry.case.determinism === "deterministic"
                        ? t("deterministicRunPolicy")
                        : t("stochasticRunPolicy", { count: entry.case.repeats })}
                    </td>
                    <td>
                      <span className={entry.expectedExecutions > 0 && entry.capturedTraces === entry.expectedExecutions ? "is-complete" : "is-incomplete"}>
                        {entry.capturedTraces} / {entry.expectedExecutions}
                      </span>
                    </td>
                    <td>{formatDuration(entry.durationMs)}</td>
                    <td>
                      <span className={`trace-table-status is-${statusTone(entry.case.status)}`}>
                        <TraceStateIcon tone={statusTone(entry.case.status)} size={12} />
                        {localizeStatus(locale, entry.case.status)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      )}

      <section className="trace-case-workspace">
        <header className="trace-selected-case">
          <span>
            <small>{t("selectedEvalCase")}</small>
            <strong>{scenario.title}</strong>
            <p>{scenario.description}</p>
          </span>
          <code>{trace.case.id}</code>
        </header>

        <div className="arm-comparison-heading">
          <span>
            <GitCompareArrows size={15} aria-hidden="true" />
            <h3>{t("executionMatrixTitle")}</h3>
          </span>
          <small>{t("executionMatrixDescription")}</small>
        </div>
        <div className="trace-execution-matrix-scroll">
          <table className="trace-execution-matrix">
            <thead>
              <tr>
                <th scope="col">{t("repeatColumn")}</th>
                {trace.arms.map((arm) => {
                  const candidate = arm.id === "with_skill";
                  return (
                    <th scope="col" key={arm.id}>
                      <small>{t(candidate ? "candidateLane" : "baselineLane")}</small>
                      <strong>{localizeValue(locale, arm.id)}</strong>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {executionMatrix.map((row) => (
                <tr key={row.repeat}>
                  <th scope="row" title={t("repeatNotEvolutionRound", { repeat: row.repeat })}>
                    <strong>R{row.repeat}</strong>
                    <small>{t("selectRepeat")}</small>
                  </th>
                  {row.cells.map(({ arm, execution }) => {
                    const candidate = arm.id === "with_skill";
                    const armLabel = t(candidate ? "candidateLane" : "baselineLane");
                    const active =
                      arm.id === selectedArm?.id &&
                      execution?.repeat === selectedExecution?.repeat;
                    return (
                      <td key={arm.id}>
                        {execution ? (
                          <button
                            type="button"
                            className={`trace-execution-cell ${candidate ? "is-candidate" : "is-baseline"} ${active ? "is-active" : ""}`}
                            aria-label={t("executionCellLabel", {
                              arm: armLabel,
                              repeat: execution.repeat,
                              status: localizeStatus(locale, execution.status),
                            })}
                            aria-pressed={active}
                            onClick={() => {
                              setSelectedArmId(arm.id);
                              setSelectedRepeat(execution.repeat);
                            }}
                          >
                            <TraceStateIcon tone={executionTone(execution)} size={14} />
                            <span>
                              <strong>{localizeStatus(locale, execution.status)}</strong>
                              <small>
                                {hasInspectableTraceExecution(execution)
                                  ? t("traceCaptured")
                                  : t("traceNotCaptured")}
                                {" · "}
                                {formatDuration(
                                  hasInspectableTraceExecution(execution)
                                    ? execution.trace?.duration_ms
                                    : null,
                                )}
                              </small>
                              <em>{t("assertionScore", execution.assertions)}</em>
                            </span>
                            <ChevronRight size={13} aria-hidden="true" />
                          </button>
                        ) : (
                          <div className="trace-execution-cell is-missing" role="status">
                            <CircleX size={14} aria-hidden="true" />
                            <span>
                              <strong>{t("executionMissing")}</strong>
                              <small>{t("traceNotCaptured")}</small>
                            </span>
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <details className="trace-technical-context">
          <summary>
            <Fingerprint size={14} aria-hidden="true" />
            {t("traceTechnicalContext")}
          </summary>
          <div className="observable-boundary" role="note">
            <Eye size={15} aria-hidden="true" />
            <div>
              <strong>{t("observableEvidenceBoundary")}</strong>
              <p>{t("observableEvidenceBoundaryDescription")}</p>
            </div>
          </div>

        <section className="trace-responsibility" aria-labelledby="trace-responsibility-title">
          <header>
            <Route size={14} aria-hidden="true" />
            <h3 id="trace-responsibility-title">{t("traceResponsibilityTitle")}</h3>
          </header>
          <div className="trace-responsibility-flow">
            <div className="trace-agent-role is-dispatcher">
              <span className="trace-role-icon"><Route size={15} aria-hidden="true" /></span>
              <span>
                <small>{t("leadAgentRole")}</small>
                <strong>{t("leadDispatchesWorker")}</strong>
                <p>{t("leadAgentTraceBoundary")}</p>
              </span>
            </div>
            <ArrowRight className="trace-role-arrow" size={17} aria-hidden="true" />
            <div className="trace-agent-role is-executor">
              <span className="trace-role-icon"><Bot size={15} aria-hidden="true" /></span>
              <span>
                <small>{t("evalWorkerRole")}</small>
                <strong>{executorLabel}</strong>
                <p>{t(executor.dispatchBound ? "evalWorkerTraceBoundary" : "declaredExecutorBoundary")}</p>
              </span>
              <code>{executor.target ?? t("notRecorded")}</code>
            </div>
          </div>
          <div className={`nested-agent-boundary ${executor.nestedAgentEvents ? "is-captured" : "is-unknown"}`}>
            <TraceStateIcon tone={executor.nestedAgentEvents ? "good" : "warn"} size={13} />
            <span>
              <strong>{t(executor.nestedAgentEvents ? "nestedAgentTraceCaptured" : "nestedAgentTraceNotCaptured")}</strong>
              <small>{t("nestedAgentTraceBoundary")}</small>
            </span>
          </div>
        </section>

          <div className="trace-binding-strip" aria-label={t("lockedEvalDefinition")}>
            <div><Fingerprint size={14} /><span><small>{t("manifestDigest")}</small><strong>{shortDigest(manifest?.digest)}</strong></span></div>
            <div><LockKeyhole size={14} /><span><small>{t("planDigest")}</small><strong>{shortDigest(planDigest)}</strong></span></div>
            <div><Bot size={14} /><span><small>{t("harness")}</small><strong>{executionProfile?.harness ? localizeValue(locale, executionProfile.harness) : t("notRecorded")}</strong></span></div>
            <div><Route size={14} /><span><small>{t("dispatchReceipt")}</small><strong>{selectedExecution?.dispatch?.valid ? shortDigest(selectedExecution.dispatch.digest) : t("notRecorded")}</strong></span></div>
            {selectedExecution?.trace?.source_trace_required === true && (
              <div><FileOutput size={14} /><span><small>{t("sourceTrace")}</small><strong>{selectedExecution.source_trace?.valid ? `${localizeValue(locale, selectedExecution.source_trace.adapter)} · ${shortDigest(selectedExecution.source_trace.digest)}` : t("notRecorded")}</strong></span></div>
            )}
            {selectedExecution?.source_trace?.valid === true && (
              <div><Bot size={14} /><span><small>{t("sourceAgent")}</small><strong>{selectedExecution.source_trace.source_agent ?? selectedExecution.source_trace.adapter} · {selectedExecution.source_trace.adapter_maturity ?? t("notRecorded")}</strong></span></div>
            )}
            {selectedExecution?.source_trace?.valid === true && (
              <div><Fingerprint size={14} /><span><small>{t("adapterProvenance")}</small><strong>{selectedExecution.source_trace.parser_id ? `${selectedExecution.source_trace.parser_id}@${selectedExecution.source_trace.parser_version ?? "?"} · ${shortDigest(selectedExecution.source_trace.parser_digest)} · run ${shortDigest(selectedExecution.source_trace.runtime_binding_digest)}` : shortDigest(selectedExecution.source_trace.registry_entry_digest)}</strong></span></div>
            )}
          </div>

          {!executor.dispatchBound && (
            <div className="observable-boundary" role="note">
              <TriangleAlert size={15} aria-hidden="true" />
              <div>
                <strong>{t("dispatchReceiptMissing")}</strong>
                <p>{t("dispatchReceiptMissingDescription")}</p>
              </div>
            </div>
          )}

        {executionProfile?.isolation === "local-unattested" && (
          <div className="observable-boundary is-local-unattested" role="note">
            <TriangleAlert size={15} aria-hidden="true" />
            <div>
              <strong>{t("localUnattestedTrace")}</strong>
              <p>{t("localUnattestedTraceDescription")}</p>
            </div>
          </div>
        )}
        </details>

        <div className="timeline-section-heading">
          <span>
            <Route size={15} aria-hidden="true" />
            <strong>{t("eventTimeline")}</strong>
          </span>
          <p>{t("eventTimelineDescription")}</p>
        </div>
        <TraceTimeline
          execution={selectedExecution}
          selectedEventId={selectedTraceEventId}
          onSelectEvent={setSelectedTraceEventId}
        />


      </section>

      <section className="trace-check-results">
        <header>
          <span>
            <ShieldCheck size={16} aria-hidden="true" />
            <strong>{t("checksAndJudge")}</strong>
          </span>
          <p>{t("checksAndJudgeDescription")}</p>
        </header>
        <div className="paired-assertion-list">
          {trace.assertionGroups.map((group) => (
            <PairedAssertionComparison
              key={group.id}
              group={group}
              trace={trace}
              cases={cases}
              onOpenEvidence={onOpenEvidence}
              onOpenTraceEvent={(eventId, arm, repeat) => {
                setSelectedArmId(arm);
                setSelectedRepeat(repeat);
                setSelectedTraceEventId(eventId);
              }}
            />
          ))}
          {trace.case.semantic_assertions.length > 0 && (
            <section className="semantic-judge-results" aria-label={t("semanticJudgeResults")}>
              <header>
                <MessageSquareText size={15} aria-hidden="true" />
                <span>
                  <strong>{t("semanticJudgeResults")}</strong>
                  <small>{t("semanticJudgeResultsDescription")}</small>
                </span>
              </header>
              {trace.case.semantic_assertions.map((assertion) => {
                const tone = assertion.passed ? "good" : "bad";
                const traceEventContexts = findTraceEventContexts(
                  trace,
                  assertion.source_event_ids,
                );
                const traceEventContext = traceEventContexts[0] ?? null;
                return (
                  <div
                    className={`semantic-judge-result is-${tone}`}
                    key={assertion.id}
                  >
                    <button
                      type="button"
                      className="semantic-judge-evidence"
                      onClick={() =>
                        onOpenEvidence(
                          `assertion:${trace.case.id}:semantic:${assertion.id}`,
                        )
                      }
                    >
                      <TraceStateIcon tone={tone} size={14} />
                      <span>
                        <strong>{assertion.id}</strong>
                        <small>
                          {localizeStatus(locale, assertion.status)} · {t("linkedTraceEvents", {
                            count: traceEventContexts.length,
                          })}
                        </small>
                      </span>
                      <span className="semantic-judge-preference">
                        <small>{t("judgePreference")}</small>
                        <strong>
                          {assertion.preference
                            ? localizeValue(locale, assertion.preference)
                            : t("notRecorded")}
                        </strong>
                      </span>
                      <ChevronRight size={13} aria-hidden="true" />
                    </button>
                    {traceEventContext && (
                      <button
                        type="button"
                        className="semantic-judge-trace-event-link"
                        onClick={() => {
                          setSelectedArmId(traceEventContext.arm);
                          setSelectedRepeat(traceEventContext.repeat);
                          setSelectedTraceEventId(traceEventContext.eventId);
                        }}
                      >
                        <Route size={12} aria-hidden="true" />
                        {t("locateTraceEvent")}
                      </button>
                    )}
                  </div>
                );
              })}
            </section>
          )}
          {trace.assertionGroups.length === 0 && trace.case.semantic_assertions.length === 0 && (
            <div className="trace-empty-state compact">
              <FileCheck2 size={18} aria-hidden="true" />
              <p>{t("noCheckComparison")}</p>
            </div>
          )}
        </div>
      </section>
    </section>
  );
}

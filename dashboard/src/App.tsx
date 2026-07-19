import {
  Beaker,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Command,
  Download,
  FileCheck2,
  FileText,
  Fingerprint,
  GitCompareArrows,
  Languages,
  Link2,
  LockKeyhole,
  Maximize2,
  Minimize2,
  PanelRightOpen,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CommandPalette, type DashboardCommand } from "./CommandPalette";
import { copyText, downloadDashboardData } from "./dashboard-export";
import {
  currentDashboardSource,
  fetchDashboardResource,
  loadDashboardSession,
} from "./dashboard-source";
import {
  DashboardCompatibilityError,
  validateAndMigrateDashboardData,
} from "./dashboard-schema";
import { EvalExecutionTraceView } from "./EvalExecutionTrace";
import { EvidenceNodeIcon } from "./EvidenceNodeIcon";
import { EvidenceReader } from "./EvidenceReader";
import { ReviewOverview } from "./ReviewOverview";
import { WorkspacePaneResizeHandle } from "./WorkspacePaneResizeHandle";
import {
  dashboardShareUrl,
  readDashboardViewState,
  writeDashboardViewState,
  type CaseStatusFilter,
  type DashboardCanvasView,
  type DashboardDiffLayout,
  type DashboardPanel,
  type DashboardSplit,
  type DashboardViewState,
} from "./dashboard-view-state";
import {
  describeAssertion,
  describeDashboardCase,
  describeDecisionBasis,
  describeEvidenceNode,
  describeEvidenceReviewGuide,
  describeLimitation,
  describeReviewStatus,
  evidenceActionLabel,
  repeatFromEvidenceNode,
  type DecisionBasisItem,
} from "./evidence-semantics";
import { buildEvalExecutionTrace } from "./eval-execution-trace";
import {
  buildEvidenceDisplayItems,
  orderEvidenceSpineNodes,
} from "./evidence-tree-order";
import { handleRovingListKeyDown } from "./keyboard-navigation";
import type { DashboardCase, DashboardData, SpineNode } from "./types";
import { useWorkspaceLayout } from "./use-workspace-layout";
import {
  fontScaleOptions,
  localizeStatus,
  localizeValue,
  useUiPreferences,
} from "./ui-preferences";

type SplitFilter = DashboardSplit;
type EvaluationStage = Exclude<SplitFilter, "all">;
type ConnectionState = "connecting" | "live" | "stale";
type CanvasView = DashboardCanvasView;

const DiffViewer = lazy(() => import("./DiffViewer"));

const evaluationStages: EvaluationStage[] = [
  "development",
  "selection",
  "audit",
];

function statusTone(status: string): "good" | "bad" | "warn" | "neutral" {
  const normalized = status.toLowerCase();
  if (
    [
      "passed",
      "accepted",
      "audit-passed",
      "retained",
      "regression-verified",
      "behavior-verified",
    ].some((value) => normalized.includes(value))
  ) {
    return "good";
  }
  if (
    [
      "failed",
      "rejected",
      "regressed",
      "audit-failed",
      "invalid",
      "stale",
      "disagreement",
      "blocked",
    ].some((value) => normalized.includes(value))
  ) {
    return "bad";
  }
  if (
    [
      "pending",
      "awaiting",
      "inconclusive",
      "incomplete",
      "missing",
      "no-change",
      "exhausted",
    ].some((value) => normalized.includes(value))
  ) {
    return "warn";
  }
  return "neutral";
}

function shortDigest(digest: string | null | undefined, fallback: string): string {
  if (!digest) return fallback;
  return `${digest.slice(0, 8)}…${digest.slice(-6)}`;
}

function percent(value: number | null | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "—";
}

function isAttentionCase(item: DashboardCase): boolean {
  return (
    statusTone(item.status) !== "good" ||
    item.regressed ||
    item.direction_disagreement ||
    item.missing_objective_metrics.length > 0
  );
}

function evidenceComparisonRelationship(
  candidate: SpineNode | null,
  baseline: SpineNode | null,
): "same" | "different" | "missing" {
  if (!candidate || !baseline) return "missing";
  return candidate.status.trim().toLowerCase() ===
    baseline.status.trim().toLowerCase()
    ? "same"
    : "different";
}

function formatTimestamp(locale: string, value: string | number | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function acceptsTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

const dialogFocusableSelector =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function dialogFocusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const closedDetails = Array.from(
    root.querySelectorAll<HTMLDetailsElement>("details:not([open])"),
  );
  return Array.from(
    root.querySelectorAll<HTMLElement>(dialogFocusableSelector),
  ).filter((element) => {
    if (element.tabIndex < 0) return false;
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    return closedDetails.every((details) => {
      if (!details.contains(element)) return true;
      const summary = Array.from(details.children).find(
        (child) => child.tagName === "SUMMARY",
      );
      return summary === element || Boolean(summary?.contains(element));
    });
  });
}

function StatusChip({
  status,
  className = "",
}: {
  status: string;
  className?: string;
}) {
  const { locale } = useUiPreferences();
  return (
    <span
      className={`status-chip status-${statusTone(status)} ${className}`.trim()}
      title={locale === "zh-CN" ? status : undefined}
    >
      {localizeStatus(locale, status)}
    </span>
  );
}

function DecisionBasisRow({
  item,
  onOpen,
}: {
  item: DecisionBasisItem;
  onOpen?: () => void;
}) {
  const { t } = useUiPreferences();
  const content = (
    <>
      <span className={`basis-state basis-state-${item.tone}`} aria-hidden="true">
        {item.tone === "good" ? (
          <Check size={11} strokeWidth={2.4} />
        ) : item.tone === "bad" ? (
          <X size={11} strokeWidth={2.4} />
        ) : (
          <span />
        )}
      </span>
      <span className="basis-copy">
        <span className="basis-item-heading">
          <strong>{item.title}</strong>
          <em className={`basis-verdict basis-verdict-${item.tone}`}>
            {item.verdict}
          </em>
        </span>
        <small>{item.detail}</small>
      </span>
      {onOpen && (
        <span className="basis-open-action">
          {t("viewBasisEvidence")}
          <ChevronRight className="basis-open-icon" size={13} aria-hidden="true" />
        </span>
      )}
    </>
  );
  return onOpen ? (
    <button type="button" className="decision-basis-item is-action" onClick={onOpen}>
      {content}
    </button>
  ) : (
    <div className="decision-basis-item">{content}</div>
  );
}

function nodeDepth(node: SpineNode, nodesById: Map<string, SpineNode>): number {
  let depth = 0;
  let parentId = node.parent_id;
  const visited = new Set<string>();
  while (parentId && depth < 3 && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = nodesById.get(parentId)?.parent_id ?? null;
  }
  return depth;
}

function nodeAncestorIds(
  nodeId: string,
  nodesById: Map<string, SpineNode>,
): string[] {
  const ancestors: string[] = [];
  const visited = new Set<string>();
  let parentId = nodesById.get(nodeId)?.parent_id ?? null;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    ancestors.push(parentId);
    parentId = nodesById.get(parentId)?.parent_id ?? null;
  }
  return ancestors;
}

function initialExpandedNodeIds(
  nodes: SpineNode[],
  selectedId: string,
): Set<string> {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return new Set([
    ...nodes.filter((node) => node.parent_id === null).map((node) => node.id),
    ...nodeAncestorIds(selectedId, nodesById),
  ]);
}

function isDescendantOf(
  nodeId: string,
  ancestorId: string,
  nodesById: Map<string, SpineNode>,
): boolean {
  return nodeAncestorIds(nodeId, nodesById).includes(ancestorId);
}

function caseForEvidenceNode(
  node: SpineNode | undefined,
  nodesById: Map<string, SpineNode>,
  cases: DashboardCase[],
): DashboardCase | null {
  if (!node) return null;
  if (node.kind === "case") {
    return cases.find((item) => `case:${item.id}` === node.id) ?? null;
  }
  for (const ancestorId of nodeAncestorIds(node.id, nodesById)) {
    const ancestor = nodesById.get(ancestorId);
    if (ancestor?.kind === "case") {
      return cases.find((item) => `case:${item.id}` === ancestor.id) ?? null;
    }
  }
  if (node.kind === "gate") {
    return (
      cases.find((item) => node.label.startsWith(`${item.id}:`)) ?? null
    );
  }
  return null;
}

function useDashboardData() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compatibilityError, setCompatibilityError] =
    useState<DashboardCompatibilityError | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [paused, setPaused] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState<number | null>(null);
  const [lastAttemptAt, setLastAttemptAt] = useState<number | null>(null);
  const activeRef = useRef(true);
  const pausedRef = useRef(paused);
  const timerRef = useRef<number | undefined>(undefined);
  const requestRef = useRef<AbortController | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const source = useMemo(currentDashboardSource, []);
  const dataUrl = source.dataUrl;

  const scheduleNext = useCallback((delay: number) => {
    window.clearTimeout(timerRef.current);
    if (!activeRef.current || pausedRef.current) return;
    timerRef.current = window.setTimeout(
      () => void refreshRef.current(),
      Math.max(delay, 1000),
    );
  }, []);

  const refresh = useCallback(async () => {
    window.clearTimeout(timerRef.current);
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setIsRefreshing(true);
    setLastAttemptAt(Date.now());
    try {
      if (!dataUrl) {
        throw new Error(source.error ?? "dashboard source is unavailable");
      }
      const session = await loadDashboardSession(source, controller.signal);
      const response = await fetchDashboardResource(session?.data_endpoint ?? dataUrl, {
        cache: "no-store",
        signal: controller.signal,
      }, source);
      if (!response.ok) {
        throw new Error(`read model returned ${response.status}`);
      }
      const next = validateAndMigrateDashboardData(await response.json());
      if (session && next.run.id !== session.run_id) {
        throw new Error("dashboard read model does not match the active local session");
      }
      if (!activeRef.current || controller.signal.aborted) return;
      setData(next);
      setError(null);
      setCompatibilityError(null);
      setConnectionState("live");
      setLastSuccessfulAt(Date.now());
      scheduleNext(next.refresh_interval_ms);
    } catch (cause) {
      if (
        !activeRef.current ||
        controller.signal.aborted ||
        (cause instanceof DOMException && cause.name === "AbortError")
      ) {
        return;
      }
      const message =
        cause instanceof Error ? cause.message : "unable to read dashboard data";
      setError(message);
      setCompatibilityError(
        cause instanceof DashboardCompatibilityError ? cause : null,
      );
      setConnectionState((current) =>
        current === "connecting" ? "connecting" : "stale",
      );
      scheduleNext(3000);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        if (activeRef.current) setIsRefreshing(false);
      }
    }
  }, [dataUrl, scheduleNext, source]);

  refreshRef.current = refresh;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      window.clearTimeout(timerRef.current);
      requestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    pausedRef.current = paused;
    window.clearTimeout(timerRef.current);
    if (paused) {
      requestRef.current?.abort();
    } else {
      void refreshRef.current();
    }
  }, [dataUrl, paused]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible" && !pausedRef.current) {
        void refreshRef.current();
      }
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, []);

  return {
    data,
    error,
    compatibilityError,
    connectionState,
    paused,
    setPaused,
    isRefreshing,
    lastSuccessfulAt,
    lastAttemptAt,
    refresh,
  };
}

const splitMessageKeys = {
  all: "all",
  development: "development",
  selection: "selection",
  audit: "audit",
} as const;

const evaluationStageCopy = {
  development: {
    short: "developmentStageShort",
    title: "developmentStageTitle",
    description: "developmentStageDescription",
    outcome: "developmentStageOutcome",
    icon: Beaker,
  },
  selection: {
    short: "selectionStageShort",
    title: "selectionStageTitle",
    description: "selectionStageDescription",
    outcome: "selectionStageOutcome",
    icon: GitCompareArrows,
  },
  audit: {
    short: "auditStageShort",
    title: "auditStageTitle",
    description: "auditStageDescription",
    outcome: "auditStageOutcome",
    icon: ShieldCheck,
  },
} as const;

function EvaluationStageFilter({
  cases,
  evidenceScope,
  split,
  onChange,
}: {
  cases: DashboardCase[];
  evidenceScope: DashboardData["run"]["evidence_scope"];
  split: SplitFilter;
  onChange: (split: SplitFilter) => void;
}) {
  const { t } = useUiPreferences();
  const counts = useMemo(
    () =>
      Object.fromEntries(
        evaluationStages.map((stage) => [
          stage,
          cases.filter((item) => item.split === stage).length,
        ]),
      ) as Record<EvaluationStage, number>,
    [cases],
  );
  const visibleStages = evaluationStages.filter((stage) => counts[stage] > 0);
  const activeCopy =
    split === "all" || counts[split] === 0
      ? null
      : evaluationStageCopy[split];

  useEffect(() => {
    if (split !== "all" && counts[split] === 0) onChange("all");
  }, [counts, onChange, split]);

  if (cases.length === 1) {
    const stage = cases[0].split as EvaluationStage;
    const copy = evaluationStageCopy[stage];
    const Icon = copy.icon;
    return (
      <div
        className="single-case-stage"
        role="status"
        aria-label={t("singleScenarioStageLabel", {
          stage: t(splitMessageKeys[stage]),
        })}
      >
        <Icon size={14} aria-hidden="true" />
        <span>
          <small>{t("evaluationLifecycle")}</small>
          <strong>{t(splitMessageKeys[stage])}</strong>
        </span>
      </div>
    );
  }

  return (
    <div className="evaluation-stage-filter">
      <div className="stage-filter-heading">
        <div className="section-label">
          <SlidersHorizontal size={13} /> {t("evaluationLifecycle")}
        </div>
        <button
          type="button"
          className={`all-stage-filter ${split === "all" ? "is-active" : ""}`}
          aria-label={t("allStageFilterOption", { count: cases.length })}
          aria-pressed={split === "all"}
          onClick={() => onChange("all")}
        >
          <FileCheck2 size={12} />
          <span>{t("allStageCases")}</span>
          <em>{cases.length}</em>
        </button>
      </div>

      <div
        className="evaluation-stage-sequence"
        role="group"
        aria-label={t("evaluationLifecycle")}
      >
        {visibleStages.map((stage, index) => {
          const copy = evaluationStageCopy[stage];
          const Icon = copy.icon;
          return (
            <button
              type="button"
              key={stage}
              className={split === stage ? "is-active" : ""}
              aria-label={t("stageFilterOption", {
                stage: t(splitMessageKeys[stage]),
                count: counts[stage],
              })}
              aria-pressed={split === stage}
              onClick={() => onChange(stage)}
            >
              <span className="stage-step">
                <em>{index + 1}</em>
                <Icon size={12} />
              </span>
              <strong>{t(splitMessageKeys[stage])}</strong>
              <small>{t(copy.short)}</small>
              <span className="stage-case-count">{counts[stage]}</span>
            </button>
          );
        })}
      </div>

      <div className={`stage-explainer stage-${split}`} role="note">
        <span>{t("stagePurpose")}</span>
        <strong>
          {t(activeCopy ? activeCopy.title : "allStagesTitle")}
        </strong>
        <p>
          {t(activeCopy ? activeCopy.description : "allStagesDescription")}
        </p>
        <div className="stage-outcome">
          <ChevronRight size={12} />
          <span>
            <small>{t("stageOutcome")}</small>
            {t(activeCopy ? activeCopy.outcome : "allStagesOutcome")}
          </span>
        </div>
        {split === "audit" && (
          <div className={`audit-scope-note is-${evidenceScope}`}>
            <ShieldCheck size={12} />
            {t(
              evidenceScope === "opaque-holdout"
                ? "opaqueAuditScope"
                : "publicAuditScope",
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DisplayPreferences({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const {
    locale,
    theme,
    fontScale,
    setLocale,
    setTheme,
    setFontScale,
    t,
  } = useUiPreferences();
  const nextTheme = theme === "light" ? "dark" : "light";
  const scaleIndex = fontScaleOptions.indexOf(fontScale);
  const smallerScale = fontScaleOptions[scaleIndex - 1];
  const largerScale = fontScaleOptions[scaleIndex + 1];
  const percent = Math.round(fontScale * 100);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    triggerRef.current?.focus();

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k"
      ) {
        onOpenChange(false);
        return;
      }
      if (event.key === "Escape") {
        onOpenChange(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onOpenChange, open]);

  return (
    <div className="display-preferences" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className="chrome-icon-button display-preferences-trigger"
        aria-label={t("displayPreferences")}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t("displayPreferences")}
        onClick={() => onOpenChange(!open)}
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="display-controls"
          role="dialog"
          aria-label={t("displayPreferences")}
        >
          <div
            className="font-scale-control"
            role="group"
            aria-label={t("textSize")}
          >
            <button
              type="button"
              aria-label={t("decreaseTextSize")}
              title={t("decreaseTextSize")}
              disabled={smallerScale === undefined}
              onClick={() =>
                smallerScale !== undefined && setFontScale(smallerScale)
              }
            >
              <span aria-hidden="true">A−</span>
            </button>
            <button
              type="button"
              className="font-scale-value"
              aria-label={`${t("textSizeValue", { percent })}. ${t("resetTextSize")}`}
              title={t("resetTextSize")}
              onClick={() => setFontScale(1)}
            >
              {percent}%
            </button>
            <button
              type="button"
              aria-label={t("increaseTextSize")}
              title={t("increaseTextSize")}
              disabled={largerScale === undefined}
              onClick={() =>
                largerScale !== undefined && setFontScale(largerScale)
              }
            >
              <span aria-hidden="true">A+</span>
            </button>
          </div>
          <div className="locale-control" role="group" aria-label={t("language")}>
            <Languages size={13} aria-hidden="true" />
            <button
              type="button"
              className={locale === "en" ? "is-active" : ""}
              aria-label={t("switchToEnglish")}
              aria-pressed={locale === "en"}
              onClick={() => setLocale("en")}
            >
              EN
            </button>
            <button
              type="button"
              className={locale === "zh-CN" ? "is-active" : ""}
              aria-label={t("switchToChinese")}
              aria-pressed={locale === "zh-CN"}
              onClick={() => setLocale("zh-CN")}
            >
              中
            </button>
          </div>
          <button
            type="button"
            className="theme-control"
            aria-label={
              nextTheme === "dark"
                ? t("switchToDarkTheme")
                : t("switchToLightTheme")
            }
            title={
              nextTheme === "dark"
                ? t("switchToDarkTheme")
                : t("switchToLightTheme")
            }
            onClick={() => setTheme(nextTheme)}
          >
            <span className="theme-swatch" aria-hidden="true" />
            <span>{nextTheme === "dark" ? t("darkTheme") : t("lightTheme")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ReviewActions({
  shortcut,
  onOpenCommands,
  onCopyLink,
  onDownload,
}: {
  shortcut: string;
  onOpenCommands: () => void;
  onCopyLink: () => void;
  onDownload: () => void;
}) {
  const { t } = useUiPreferences();
  return (
    <div className="review-actions" aria-label={t("actionGroup")}>
      <button
        type="button"
        className="command-trigger"
        aria-label={`${t("openCommandPalette")} (${shortcut})`}
        title={`${t("openCommandPalette")} (${shortcut})`}
        onClick={onOpenCommands}
      >
        <Command size={13} />
        <span>{t("openCommandPalette")}</span>
        <kbd>{shortcut}</kbd>
      </button>
      <button
        type="button"
        className="chrome-icon-button"
        aria-label={t("copyViewLink")}
        title={t("copyViewLink")}
        onClick={onCopyLink}
      >
        <Link2 size={14} />
      </button>
      <button
        type="button"
        className="chrome-icon-button"
        aria-label={t("downloadEvidenceJson")}
        title={t("downloadEvidenceJson")}
        onClick={onDownload}
      >
        <Download size={14} />
      </button>
    </div>
  );
}

interface DashboardRefreshControls {
  paused: boolean;
  isRefreshing: boolean;
  lastSuccessfulAt: number | null;
  lastAttemptAt: number | null;
  error: string | null;
  onRefresh: () => void;
  onTogglePaused: () => void;
}

export function EvidenceDashboard({
  data,
  connectionState,
  refreshControls,
}: {
  data: DashboardData;
  connectionState: ConnectionState;
  refreshControls?: DashboardRefreshControls;
}) {
  const { locale, theme, setLocale, setTheme, t } = useUiPreferences();
  const [initialView] = useState<DashboardViewState>(() =>
    readDashboardViewState(
      typeof window === "undefined" ? "" : window.location.hash,
    ),
  );
  const [split, setSplit] = useState<SplitFilter>(initialView.split);
  const [caseStatus, setCaseStatus] = useState<CaseStatusFilter>(
    initialView.caseStatus,
  );
  const [caseQuery, setCaseQuery] = useState(initialView.query);
  const initialEvidenceIdIsValid = data.spine.some(
    (node) => node.id === initialView.evidenceId,
  );
  const initialEvidenceId = initialEvidenceIdIsValid
    ? (initialView.evidenceId ?? "")
    : (data.spine[0]?.id ?? "");
  const [selectedId, setSelectedId] = useState(initialEvidenceId);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(
    () => initialExpandedNodeIds(data.spine, initialEvidenceId),
  );
  const [selectedDiffId, setSelectedDiffId] = useState(
    data.diffs.some((diff) => diff.id === initialView.diffId)
      ? initialView.diffId
      : (data.diffs[0]?.id ?? null),
  );
  const [diffLayout, setDiffLayout] = useState<DashboardDiffLayout>(
    initialView.diffLayout,
  );
  const [wrapLines, setWrapLines] = useState(initialView.wrapLines);
  const [canvasView, setCanvasView] = useState<CanvasView>(
    initialView.canvasView,
  );
  const [panel, setPanel] = useState<DashboardPanel>(
    initialView.panel === "evidence" && !initialEvidenceIdIsValid
      ? "none"
      : initialView.panel,
  );
  const workspaceLayout = useWorkspaceLayout(canvasView);
  const evidencePanelIsOverlay =
    panel === "evidence" &&
    Boolean(selectedId) &&
    (canvasView !== "audit" || workspaceLayout.layout.mode === "two");
  const evidenceDrawerShouldBeModal =
    panel === "evidence" &&
    canvasView !== "audit" &&
    workspaceLayout.layout.mode === "stacked";
  const [focusMode, setFocusMode] = useState(initialView.focusMode);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [displayPreferencesOpen, setDisplayPreferencesOpen] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);
  const caseSearchRef = useRef<HTMLInputElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const inspectorBodyRef = useRef<HTMLDivElement>(null);
  const evidenceDrawerCloseButtonRef = useRef<HTMLButtonElement>(null);
  const evidenceDrawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const notificationTimerRef = useRef<number | undefined>(undefined);
  const previousViewRef = useRef<DashboardViewState | null>(null);
  const restoringHistoryRef = useRef(false);
  const commandShortcut =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
      ? "⌘K"
      : "Ctrl K";
  const caseSemanticsById = useMemo(
    () =>
      new Map(
        data.cases.map((item) => [
          item.id,
          describeDashboardCase(locale, item),
        ]),
      ),
    [data.cases, locale],
  );
  const nodeSemanticsById = useMemo(
    () =>
      new Map(
        data.spine.map((node) => [
          node.id,
          describeEvidenceNode(locale, node, data.cases),
        ]),
      ),
    [data.cases, data.spine, locale],
  );

  const matchingCases = useMemo(
    () => {
      const normalized = caseQuery.trim().toLocaleLowerCase();
      return data.cases.filter((item) => {
        if (split !== "all" && item.split !== split) return false;
        if (!normalized) return true;
        const semantic = caseSemanticsById.get(item.id);
        return [
          item.id,
          item.purpose,
          item.status,
          item.split,
          semantic?.title,
          semantic?.description,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalized);
      });
    },
    [caseQuery, caseSemanticsById, data.cases, split],
  );
  const caseStatusCounts = useMemo(
    () => ({
      all: matchingCases.length,
      passed: matchingCases.filter((item) => !isAttentionCase(item)).length,
      attention: matchingCases.filter(isAttentionCase).length,
    }),
    [matchingCases],
  );
  const visibleCases = useMemo(
    () =>
      matchingCases.filter((item) => {
        if (caseStatus === "passed") return !isAttentionCase(item);
        if (caseStatus === "attention") return isAttentionCase(item);
        return true;
      }),
    [caseStatus, matchingCases],
  );
  const visibleCaseNodeIds = useMemo(
    () => new Set(visibleCases.map((item) => `case:${item.id}`)),
    [visibleCases],
  );
  const orderedSpine = useMemo(
    () => orderEvidenceSpineNodes(data.spine),
    [data.spine],
  );
  const visibleNodes = useMemo(
    () =>
      orderedSpine.filter((node) => {
        const filtersActive =
          split !== "all" || caseStatus !== "all" || caseQuery.trim() !== "";
        if (!filtersActive) return true;
        if (
          node.kind === "run" ||
          node.kind === "gate" ||
          node.kind === "iteration"
        ) {
          return true;
        }
        if (node.kind === "case") return visibleCaseNodeIds.has(node.id);
        return node.parent_id ? visibleCaseNodeIds.has(node.parent_id) : false;
      }),
    [caseQuery, caseStatus, orderedSpine, split, visibleCaseNodeIds],
  );
  const nodesById = useMemo(
    () => new Map(data.spine.map((node) => [node.id, node])),
    [data.spine],
  );
  const visibleChildCounts = useMemo(() => {
    const counts = new Map<string, number>();
    visibleNodes.forEach((node) => {
      if (!node.parent_id) return;
      counts.set(node.parent_id, (counts.get(node.parent_id) ?? 0) + 1);
    });
    return counts;
  }, [visibleNodes]);
  const expandableNodeIds = useMemo(() => {
    const ids = new Set<string>();
    data.spine.forEach((node) => {
      if (node.parent_id) ids.add(node.parent_id);
    });
    return ids;
  }, [data.spine]);
  const displayedNodes = useMemo(
    () =>
      visibleNodes.filter((node) =>
        nodeAncestorIds(node.id, nodesById).every(
          (ancestorId) =>
            !visibleChildCounts.has(ancestorId) || expandedNodeIds.has(ancestorId),
        ),
      ),
    [expandedNodeIds, nodesById, visibleChildCounts, visibleNodes],
  );
  const evidenceArmSummaries = useMemo(() => {
    const summaries = new Map<
      string,
      { passed: number; total: number; artifacts: number }
    >();
    displayedNodes.forEach((node) => {
      if (!node.arm || !node.parent_id) return;
      const key = `${node.parent_id}:${node.arm}`;
      const summary = summaries.get(key) ?? {
        passed: 0,
        total: 0,
        artifacts: 0,
      };
      if (node.kind === "assertion") {
        summary.total += 1;
        summary.passed += Number(statusTone(node.status) === "good");
      } else if (node.kind === "artifact") {
        summary.artifacts += 1;
      }
      summaries.set(key, summary);
    });
    return summaries;
  }, [displayedNodes]);
  const evidenceDisplayItems = useMemo(
    () => buildEvidenceDisplayItems(displayedNodes),
    [displayedNodes],
  );
  const displayedNodeIndexes = useMemo(
    () => new Map(displayedNodes.map((node, index) => [node.id, index])),
    [displayedNodes],
  );
  const selectedNodeIsDisplayed = displayedNodes.some(
    (node) => node.id === selectedId,
  );
  const allEvidenceExpanded = Array.from(expandableNodeIds).every((nodeId) =>
    expandedNodeIds.has(nodeId),
  );
  const allEvidenceCollapsed = Array.from(expandableNodeIds).every(
    (nodeId) => !expandedNodeIds.has(nodeId),
  );

  const currentView = useMemo<DashboardViewState>(
    () => ({
      split,
      caseStatus,
      query: caseQuery,
      canvasView,
      panel,
      evidenceId:
        panel === "evidence" || canvasView === "runs" || canvasView === "audit"
          ? selectedId || null
          : null,
      diffId: canvasView === "changes" ? selectedDiffId : null,
      diffLayout,
      wrapLines,
      focusMode,
    }),
    [
      canvasView,
      caseQuery,
      caseStatus,
      diffLayout,
      focusMode,
      selectedDiffId,
      selectedId,
      split,
      panel,
      wrapLines,
    ],
  );

  const notify = useCallback((message: string) => {
    window.clearTimeout(notificationTimerRef.current);
    setNotification(message);
    notificationTimerRef.current = window.setTimeout(
      () => setNotification(null),
      2800,
    );
  }, []);

  const copyCurrentView = useCallback(() => {
    const url = dashboardShareUrl(currentView, window.location.href).toString();
    void copyText(url)
      .then(() => notify(t("viewLinkCopied")))
      .catch(() => notify(t("viewLinkCopyFailed")));
  }, [currentView, notify, t]);

  const downloadEvidence = useCallback(() => {
    try {
      downloadDashboardData(data);
      notify(t("evidenceJsonDownloaded"));
    } catch {
      notify(t("evidenceJsonDownloadFailed"));
    }
  }, [data, notify, t]);

  const clearCaseFilters = useCallback(() => {
    setSplit("all");
    setCaseStatus("all");
    setCaseQuery("");
  }, []);

  const revealEvidence = useCallback((nodeId: string) => {
    const ancestorIds = nodeAncestorIds(nodeId, nodesById);
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      let changed = false;
      ancestorIds.forEach((ancestorId) => {
        if (next.has(ancestorId)) return;
        next.add(ancestorId);
        changed = true;
      });
      return changed ? next : current;
    });
  }, [nodesById]);

  const openCase = useCallback((item: DashboardCase) => {
    const nodeId = `case:${item.id}`;
    setSplit(item.split);
    setCaseStatus("all");
    setCaseQuery("");
    revealEvidence(nodeId);
    setSelectedId(nodeId);
    setPanel("evidence");
    setCanvasView("audit");
  }, [revealEvidence]);

  const openEvidence = useCallback((node: SpineNode) => {
    setSplit(node.split ?? "all");
    setCaseStatus("all");
    setCaseQuery("");
    revealEvidence(node.id);
    setSelectedId(node.id);
    setPanel("evidence");
  }, [revealEvidence]);

  const showCanvas = useCallback((view: CanvasView) => {
    setPanel("none");
    setCanvasView(view);
  }, []);

  const openCommands = useCallback(() => {
    setPanel("none");
    setDisplayPreferencesOpen(false);
    setCommandsOpen(true);
  }, []);

  const updateDisplayPreferencesOpen = useCallback((open: boolean) => {
    if (open) {
      if (evidencePanelIsOverlay) setPanel("none");
      setCommandsOpen(false);
    }
    setDisplayPreferencesOpen(open);
  }, [evidencePanelIsOverlay]);

  useEffect(() => {
    if (
      displayPreferencesOpen &&
      (evidencePanelIsOverlay || commandsOpen)
    ) {
      setDisplayPreferencesOpen(false);
    }
  }, [commandsOpen, displayPreferencesOpen, evidencePanelIsOverlay]);

  const toggleEvidenceGroup = useCallback((node: SpineNode) => {
    const isExpanded = expandedNodeIds.has(node.id);
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      if (isExpanded) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
    if (
      isExpanded &&
      selectedId !== node.id &&
      isDescendantOf(selectedId, node.id, nodesById)
    ) {
      setSelectedId(node.id);
    }
  }, [expandedNodeIds, nodesById, selectedId]);

  const expandEvidenceTree = useCallback(() => {
    setExpandedNodeIds(new Set(expandableNodeIds));
  }, [expandableNodeIds]);

  const collapseEvidenceTree = useCallback(() => {
    setExpandedNodeIds(new Set());
    const rootNode = visibleNodes.find((node) => node.parent_id === null);
    if (rootNode) setSelectedId(rootNode.id);
  }, [visibleNodes]);

  const openDiff = useCallback((id: string) => {
    setSelectedDiffId(id);
    showCanvas("changes");
  }, [showCanvas]);

  useEffect(() => {
    if (!visibleNodes.some((node) => node.id === selectedId)) {
      setSelectedId(visibleNodes[0]?.id ?? "");
    }
  }, [selectedId, visibleNodes]);

  useEffect(() => {
    revealEvidence(selectedId);
  }, [revealEvidence, selectedId]);

  useEffect(() => {
    setExpandedNodeIds(initialExpandedNodeIds(data.spine, selectedId));
    // A newly presented immutable run starts with its top-level evidence visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.run.id]);

  useEffect(() => {
    if (canvasView !== "changes") setFocusMode(false);
  }, [canvasView]);

  useEffect(() => {
    if (
      selectedDiffId &&
      !data.diffs.some((diff) => diff.id === selectedDiffId)
    ) {
      setSelectedDiffId(data.diffs[0]?.id ?? null);
    }
  }, [data.diffs, selectedDiffId]);

  useEffect(() => {
    const previous = previousViewRef.current;
    previousViewRef.current = currentView;
    if (restoringHistoryRef.current) {
      restoringHistoryRef.current = false;
      return;
    }
    const queryOnly =
      previous !== null &&
      previous.query !== currentView.query &&
      previous.split === currentView.split &&
      previous.caseStatus === currentView.caseStatus &&
      previous.canvasView === currentView.canvasView &&
      previous.panel === currentView.panel &&
      previous.evidenceId === currentView.evidenceId &&
      previous.diffId === currentView.diffId &&
      previous.diffLayout === currentView.diffLayout &&
      previous.wrapLines === currentView.wrapLines &&
      previous.focusMode === currentView.focusMode;
    writeDashboardViewState(
      currentView,
      previous && !queryOnly ? "push" : "replace",
    );
  }, [currentView]);

  useEffect(() => {
    const restoreView = () => {
      const next = readDashboardViewState(window.location.hash);
      const nextEvidenceIdIsValid = data.spine.some(
        (node) => node.id === next.evidenceId,
      );
      restoringHistoryRef.current = true;
      setSplit(next.split);
      setCaseStatus(next.caseStatus);
      setCaseQuery(next.query);
      setCanvasView(next.canvasView);
      setPanel(
        next.panel === "evidence" && !nextEvidenceIdIsValid
          ? "none"
          : next.panel,
      );
      setDiffLayout(next.diffLayout);
      setWrapLines(next.wrapLines);
      setFocusMode(next.focusMode);
      setSelectedId(
        next.evidenceId && nextEvidenceIdIsValid
          ? next.evidenceId
          : (data.spine[0]?.id ?? ""),
      );
      setSelectedDiffId(
        next.diffId && data.diffs.some((diff) => diff.id === next.diffId)
          ? next.diffId
          : (data.diffs[0]?.id ?? null),
      );
    };
    window.addEventListener("popstate", restoreView);
    return () => window.removeEventListener("popstate", restoreView);
  }, [data.diffs, data.spine]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (commandsOpen) setCommandsOpen(false);
        else openCommands();
        return;
      }
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !commandsOpen &&
        panel === "none" &&
        !acceptsTextInput(event.target)
      ) {
        event.preventDefault();
        caseSearchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [commandsOpen, openCommands, panel]);

  useEffect(
    () => () => window.clearTimeout(notificationTimerRef.current),
    [],
  );

  const selected =
    data.spine.find((node) => node.id === selectedId) ?? visibleNodes[0];
  const inspectorVisible = panel === "evidence" && Boolean(selected);
  const auditInspectorVisible =
    canvasView === "audit" &&
    inspectorVisible &&
    workspaceLayout.layout.mode !== "two";
  const drawerInspectorVisible =
    inspectorVisible && evidencePanelIsOverlay;
  const evidenceDrawerModal =
    drawerInspectorVisible && evidenceDrawerShouldBeModal;
  const selectedCase = caseForEvidenceNode(selected, nodesById, data.cases);
  const executionCase =
    selectedCase ?? data.cases.find(isAttentionCase) ?? data.cases[0] ?? null;
  const executionTrace = buildEvalExecutionTrace(data, executionCase?.id);
  const selectedSemantic = selected
    ? nodeSemanticsById.get(selected.id) ??
      describeEvidenceNode(locale, selected, data.cases)
    : null;
  const selectedRepeat = selected ? repeatFromEvidenceNode(selected) : null;
  const selectedFinding = selected
    ? describeReviewStatus(locale, selected.status)
    : null;
  const selectedGuide = selected
    ? describeEvidenceReviewGuide(locale, selected, selectedCase)
    : null;
  const selectedDecisionBasis = selected
    ? describeDecisionBasis(locale, selected, selectedCase, data.spine, data.cases)
    : null;
  useEffect(() => {
    if (inspectorBodyRef.current) inspectorBodyRef.current.scrollTop = 0;
  }, [selected?.id]);
  useEffect(() => {
    if (!drawerInspectorVisible) return;

    const previousOverflow = document.body.style.overflow;
    if (evidenceDrawerModal) document.body.style.overflow = "hidden";
    evidenceDrawerReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    evidenceDrawerCloseButtonRef.current?.focus();

    const closeEvidenceDrawer = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPanel("none");
        return;
      }
      if (event.key !== "Tab" || !evidenceDrawerModal) return;

      const focusable = dialogFocusables(inspectorRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", closeEvidenceDrawer);
    return () => {
      document.removeEventListener("keydown", closeEvidenceDrawer);
      document.body.style.overflow = previousOverflow;
      const returnFocus = evidenceDrawerReturnFocusRef.current;
      evidenceDrawerReturnFocusRef.current = null;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [drawerInspectorVisible, evidenceDrawerModal]);
  const copyEvidenceReference = useCallback(() => {
    if (!selected) return;
    const permalink = dashboardShareUrl(
      currentView,
      window.location.href,
    ).toString();
    const reference = [
      `### ${t("evidenceReference")}`,
      `- Run: \`${data.run.id}\``,
      selectedSemantic
        ? `- ${t("semanticSummary")}: ${selectedSemantic.title}`
        : null,
      `- ${t("evidenceId")}: \`${selected.id}\``,
      `- ${t("status")}: \`${selected.status}\``,
      selected.artifact ? `- ${t("decisionArtifact")}: \`${selected.artifact}\`` : null,
      selected.path ? `- ${t("artifactPath")}: \`${selected.path}\`` : null,
      data.run.subject?.digest
        ? `- Digest: \`${data.run.subject.digest}\``
        : null,
      `- ${t("permalink")}: ${permalink}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    void copyText(reference)
      .then(() => notify(t("evidenceReferenceCopied")))
      .catch(() => notify(t("evidenceReferenceCopyFailed")));
  }, [
    currentView,
    data.run.id,
    data.run.subject?.digest,
    notify,
    selected,
    selectedSemantic,
    t,
  ]);
  const generatedTime = formatTimestamp(locale, data.generated_at);
  const loadedTime = formatTimestamp(
    locale,
    refreshControls?.lastSuccessfulAt ?? null,
  );
  const attemptedTime = formatTimestamp(
    locale,
    refreshControls?.lastAttemptAt ?? null,
  );
  const reviewSelected = canvasView === "review";

  const renderEvidenceNode = (
    node: SpineNode,
    { comparisonCell = false }: { comparisonCell?: boolean } = {},
  ) => {
    const index = displayedNodeIndexes.get(node.id) ?? 0;
    const tone = statusTone(node.status);
    const depth = nodeDepth(node, nodesById);
    const childCount = visibleChildCounts.get(node.id) ?? 0;
    const isExpanded = expandedNodeIds.has(node.id);
    const semantic = nodeSemanticsById.get(node.id)!;
    const repeat = repeatFromEvidenceNode(node);
    const previousNode = displayedNodes[index - 1];
    const startsArmGroup = Boolean(
      !comparisonCell &&
        node.arm &&
        node.parent_id &&
        (previousNode?.arm !== node.arm ||
          previousNode?.parent_id !== node.parent_id),
    );
    const armSummary = node.arm && node.parent_id
      ? evidenceArmSummaries.get(`${node.parent_id}:${node.arm}`)
      : null;
    const isCandidateArm = node.arm === "with_skill";

    return (
      <Fragment key={node.id}>
        {startsArmGroup && node.arm && armSummary && (
          <div
            className={`evidence-arm-boundary ${
              isCandidateArm ? "is-candidate" : "is-baseline"
            }`}
            style={{ "--node-depth": depth } as React.CSSProperties}
          >
            {isCandidateArm ? (
              <Bot size={15} aria-hidden="true" />
            ) : (
              <GitCompareArrows size={15} aria-hidden="true" />
            )}
            <span>
              <small>{t("armEvidenceGroup")}</small>
              <strong>{localizeValue(locale, node.arm)}</strong>
              <p>
                {t(
                  isCandidateArm
                    ? "candidateEvidenceDescription"
                    : "baselineEvidenceDescription",
                )}
              </p>
            </span>
            <em>{t("armEvidenceSummary", armSummary)}</em>
          </div>
        )}
        <div
          className={`evidence-row tone-${tone} ${
            selectedId === node.id ? "is-selected" : ""
          } ${childCount ? "is-group" : "is-leaf"} ${
            isExpanded ? "is-expanded" : ""
          } ${
            node.arm
              ? isCandidateArm
                ? "is-candidate-arm"
                : "is-baseline-arm"
              : ""
          } ${comparisonCell ? "is-comparison-cell" : ""}`}
          style={{ "--node-depth": depth } as React.CSSProperties}
        >
          {childCount ? (
            <button
              type="button"
              className="node-disclosure"
              aria-expanded={isExpanded}
              aria-label={t(
                isExpanded ? "collapseEvidence" : "expandEvidence",
                { label: semantic.title },
              )}
              title={t(
                isExpanded ? "collapseEvidence" : "expandEvidence",
                { label: semantic.title },
              )}
              onClick={() => toggleEvidenceGroup(node)}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          ) : (
            <span
              className="node-disclosure-placeholder"
              aria-hidden="true"
            />
          )}
          <EvidenceNodeIcon kind={node.kind} tone={tone} />
          <button
            type="button"
            className="evidence-open"
            data-roving-item
            tabIndex={
              selectedId === node.id ||
              (index === 0 && !selectedNodeIsDisplayed)
                ? 0
                : -1
            }
            aria-current={selectedId === node.id ? "true" : undefined}
            aria-label={`${evidenceActionLabel(locale, node)}${
              locale === "zh-CN" ? "：" : ": "
            }${semantic.title}`}
            onClick={() => {
              setSelectedId(node.id);
              setPanel("evidence");
            }}
          >
            <span className="node-copy">
              <span className="node-meta">
                {localizeValue(locale, node.kind)}
                {repeat ? ` · ${t("repeatMeta", { count: repeat })}` : ""}
                {childCount
                  ? ` · ${t("childItems", { count: childCount })}`
                  : ""}
              </span>
              <strong>{semantic.title}</strong>
              <small>{semantic.description}</small>
            </span>
            <StatusChip status={node.status} />
            <span className="evidence-detail-action" aria-hidden="true">
              <PanelRightOpen size={13} />
              <span>{evidenceActionLabel(locale, node)}</span>
            </span>
          </button>
        </div>
      </Fragment>
    );
  };

  const commands: DashboardCommand[] = [
    {
      id: "action-show-evidence",
      group: t("actionGroup"),
      label: t("showEvidence"),
      detail: t("evidenceChainDescription"),
      run: () => showCanvas("audit"),
    },
    {
      id: "action-show-execution-trace",
      group: t("actionGroup"),
      label: t("showExecutionTrace"),
      detail: executionTrace
        ? t("executionTraceContext", {
            observed: executionTrace.capturedTraces,
            expected: executionTrace.expectedExecutions,
          })
        : t("notRecorded"),
      run: () => {
        if (executionCase) setSelectedId(`case:${executionCase.id}`);
        showCanvas("runs");
      },
    },
    {
      id: "action-show-diff",
      group: t("actionGroup"),
      label: t("showDiff"),
      detail: t("runtimeFilesChanged", { count: data.diffs.length }),
      run: () => showCanvas("changes"),
    },
    {
      id: "action-attention",
      group: t("actionGroup"),
      label: t("showAttention"),
      detail: t("caseResults", {
        count: data.cases.filter(isAttentionCase).length,
        total: data.cases.length,
      }),
      run: () => {
        setCaseStatus("attention");
        setCaseQuery("");
      },
    },
    {
      id: "action-all-cases",
      group: t("actionGroup"),
      label: t("showAllCases"),
      run: clearCaseFilters,
    },
    {
      id: "action-copy-link",
      group: t("actionGroup"),
      label: t("copyViewLink"),
      run: copyCurrentView,
    },
    ...(selected
      ? [
          {
            id: "action-copy-evidence",
            group: t("actionGroup"),
            label: t("copyEvidenceReference"),
            detail: selectedSemantic?.title ?? selected.label,
            run: copyEvidenceReference,
          },
        ]
      : []),
    {
      id: "action-download",
      group: t("actionGroup"),
      label: t("downloadEvidenceJson"),
      run: downloadEvidence,
    },
    {
      id: "action-theme",
      group: t("actionGroup"),
      label: theme === "light" ? t("useDarkTheme") : t("useLightTheme"),
      run: () => setTheme(theme === "light" ? "dark" : "light"),
    },
    {
      id: "action-language",
      group: t("actionGroup"),
      label: locale === "en" ? t("useChinese") : t("useEnglish"),
      run: () => setLocale(locale === "en" ? "zh-CN" : "en"),
    },
    {
      id: "action-reset-pane-widths",
      group: t("actionGroup"),
      label: t("resetPaneWidths"),
      detail: t("resetPaneWidthsDescription"),
      run: () => {
        workspaceLayout.resetAll();
        notify(t("paneWidthsReset"));
      },
    },
    ...(refreshControls
      ? [
          {
            id: "action-refresh",
            group: t("actionGroup"),
            label: t("refreshDashboard"),
            run: refreshControls.onRefresh,
          },
          {
            id: "action-pause",
            group: t("actionGroup"),
            label: refreshControls.paused
              ? t("resumeAutoRefresh")
              : t("pauseAutoRefresh"),
            run: refreshControls.onTogglePaused,
          },
        ]
      : []),
    ...data.cases.map((item) => {
      const semantic = caseSemanticsById.get(item.id)!;
      return {
        id: `case-${item.id}`,
        group: t("caseGroup"),
        label: semantic.title,
        detail: `${localizeValue(locale, item.split)} · ${localizeStatus(locale, item.status)} · ${semantic.description}`,
        keywords: [
          item.id,
          item.status,
          item.split,
          item.purpose ?? "",
          semantic.description,
        ],
        run: () => openCase(item),
      };
    }),
    ...data.spine.map((node) => {
      const semantic = nodeSemanticsById.get(node.id)!;
      return {
        id: `evidence-${node.id}`,
        group: t("evidenceGroup"),
        label: semantic.title,
        detail: `${localizeValue(locale, node.kind)} · ${localizeStatus(locale, node.status)} · ${semantic.description}`,
        keywords: [
          node.id,
          node.label,
          node.kind,
          node.status,
          node.detail ?? "",
          node.path ?? "",
        ],
        run: () => openEvidence(node),
      };
    }),
    ...data.diffs.map((diff) => ({
      id: `file-${diff.id}`,
      group: t("fileGroup"),
      label: diff.path,
      detail: localizeValue(locale, diff.status),
      keywords: [diff.status],
      run: () => openDiff(diff.id),
    })),
  ];

  return (
    <main
      className={`app-shell ${focusMode ? "is-focus-mode" : ""} ${
        refreshControls?.error ? "has-transport-warning" : ""
      } ${canvasView === "audit" ? "is-audit-view" : "is-primary-view"} ${
        workspaceLayout.layout.mode === "stacked"
          ? "is-stacked-workspace"
          : ""
      }`}
    >
      <a
        className="skip-link"
        href="#evidence-workspace"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("evidence-workspace")?.focus();
        }}
      >
        {t("skipToEvidence")}
      </a>
      <h1 className="sr-only">{t("appTitle")}</h1>

      <header className="app-chrome">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            SR
          </span>
          <div className="brand-copy">
            <strong>Skill Reviewer</strong>
            <span>/</span>
            <span>{t("brandEvidence")}</span>
          </div>
        </div>

        <div className="chrome-utilities">
          <div className="run-identity">
            <span className={`live-dot live-${connectionState}`} aria-hidden="true" />
            <span className="connection-label">
              {t(connectionState)}
            </span>
            <code>{data.run.id}</code>
            <StatusChip
              status={data.run.verification_level}
              className="run-verification"
            />
            {data.run.status !== data.run.verification_level && (
              <StatusChip status={data.run.status} className="run-status" />
            )}
            <span className="readonly-pill">
              <LockKeyhole size={12} /> {t("readOnly")}
            </span>
          </div>
          <ReviewActions
            shortcut={commandShortcut}
            onOpenCommands={openCommands}
            onCopyLink={copyCurrentView}
            onDownload={downloadEvidence}
          />
          <DisplayPreferences
            open={displayPreferencesOpen}
            onOpenChange={updateDisplayPreferencesOpen}
          />
        </div>
      </header>

      {refreshControls?.error && (
        <div className="transport-warning" role="status">
          <CircleAlert size={13} aria-hidden="true" />
          <strong>{t("lastRefreshFailed")}</strong>
          <code title={refreshControls.error}>{refreshControls.error}</code>
          <button type="button" onClick={refreshControls.onRefresh}>
            <RefreshCw size={12} /> {t("retryConnection")}
          </button>
        </div>
      )}

      <div
        ref={workspaceLayout.containerRef}
        className={`workspace-grid layout-${workspaceLayout.layout.mode} ${
          auditInspectorVisible ? "has-inspector" : "without-inspector"
        } ${canvasView === "audit" ? "is-audit-view" : "is-primary-view"
        }`}
        data-layout-mode={workspaceLayout.layout.mode}
        style={workspaceLayout.style}
      >
        <aside
          id="case-rail"
          className="rail pane"
          aria-label={t("runOverview")}
          hidden={canvasView !== "audit"}
        >
          <div className="pane-heading">
            <div>
              <span className="pane-kicker">{t("evaluationSuite")}</span>
              <h2>{t("cases")}</h2>
            </div>
            <span className="count-badge">{visibleCases.length}</span>
          </div>

          <div className="filter-block">
            <EvaluationStageFilter
              cases={data.cases}
              evidenceScope={data.run.evidence_scope}
              split={split}
              onChange={setSplit}
            />
            {data.cases.length > 1 && (
              <>
              <label className="case-search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={caseSearchRef}
                type="search"
                value={caseQuery}
                aria-label={t("searchCases")}
                placeholder={t("filterCases")}
                onChange={(event) => setCaseQuery(event.target.value)}
              />
              <kbd>/</kbd>
              </label>
              <div className="case-status-control">
              <span>{t("caseStatus")}</span>
              <div
                className="segmented-control compact-segments"
                role="group"
                aria-label={t("caseStatus")}
              >
                {(["all", "passed", "attention"] as CaseStatusFilter[]).map(
                  (item) => {
                    const label =
                      item === "attention" ? t("attention") : t(item);
                    return (
                      <button
                        type="button"
                        key={item}
                        className={caseStatus === item ? "is-active" : ""}
                        aria-label={t("caseFilterOption", {
                          label,
                          count: caseStatusCounts[item],
                        })}
                        aria-pressed={caseStatus === item}
                        onClick={() => setCaseStatus(item)}
                      >
                        <span>{label}</span>
                        <span className="case-filter-count" aria-hidden="true">
                          {caseStatusCounts[item]}
                        </span>
                      </button>
                    );
                  },
                )}
              </div>
              </div>
              <div className="case-filter-meta" role="status">
              {t("caseResults", {
                count: visibleCases.length,
                total: data.cases.length,
              })}
              </div>
              <p className="case-filter-scope">{t("caseFilterScope")}</p>
              </>
            )}
          </div>

          <div
            className="case-list"
            aria-live="polite"
            onKeyDown={(event) => handleRovingListKeyDown(event)}
          >
            {visibleCases.map((item, index) => {
              const semantic = caseSemanticsById.get(item.id)!;
              return (
                <button
                  type="button"
                  data-roving-item
                  tabIndex={
                    selectedId === `case:${item.id}` ||
                    (index === 0 && !visibleCaseNodeIds.has(selectedId))
                      ? 0
                      : -1
                  }
                  className={`case-row ${
                    selectedId === `case:${item.id}` ? "is-selected" : ""
                  }`}
                  aria-current={
                    selectedId === `case:${item.id}` ? "true" : undefined
                  }
                  aria-label={`${semantic.title} · ${localizeStatus(locale, item.status)}`}
                  key={item.id}
                  onClick={() => openCase(item)}
                >
                  <span
                    className={`case-status status-${statusTone(item.status)}`}
                    aria-hidden="true"
                  />
                  <span className="case-copy">
                    <strong>{semantic.title}</strong>
                    <small className="case-purpose">{semantic.description}</small>
                    <span className="case-meta-line">
                      {localizeValue(locale, item.split)} ·{" "}
                      {localizeValue(locale, item.holdout_visibility)} ·{" "}
                      {t("pairedRuns", {
                        count:
                          item.determinism === "stochastic" ? item.repeats : 1,
                      })}
                    </span>
                  </span>
                  <StatusChip status={item.status} />
                </button>
              );
            })}
            {visibleCases.length === 0 && (
              <div className="case-empty">
                <p className="empty-note">
                  {caseQuery || caseStatus !== "all"
                    ? t("noCasesMatch")
                    : t("noCasesInSplit")}
                </p>
                {(caseQuery || caseStatus !== "all" || split !== "all") && (
                  <button type="button" onClick={clearCaseFilters}>
                    {t("clearFilters")}
                  </button>
                )}
              </div>
            )}
          </div>

          <details
            className="evolution-summary"
            open={data.cases.length > 1 ? true : undefined}
          >
            <summary>{t("evolutionDetails")}</summary>
            <div className="section-label">
              <GitCompareArrows size={13} /> {t("evolution")}
            </div>
            <div className="query-grid">
              <div>
                <span>{t("selection")}</span>
                <strong>
                  {data.summary.selection_queries} / {data.evolution.selection_query_limit}
                </strong>
              </div>
              <div>
                <span>{t("audit")}</span>
                <strong>
                  {data.summary.audit_queries} / {data.evolution.audit_query_limit}
                </strong>
              </div>
            </div>
            <p>
              {t("continuitySummary", {
                epoch: data.summary.continuity_epoch ?? "—",
                count: data.summary.rejected_candidates,
              })}
            </p>
            <div className="lineage-list" aria-label={t("candidateLineage")}>
              {data.evolution.candidate_lineage.slice(-2).map((candidate) => (
                <div
                  key={`${candidate.run_id}-${candidate.round}`}
                  title={candidate.candidate_digest ?? undefined}
                >
                  <span>
                    {t("lineageRound", { round: candidate.round ?? "—" })}
                  </span>
                  <em>{localizeValue(locale, candidate.continuity ?? "continue")}</em>
                </div>
              ))}
            </div>
          </details>
        </aside>

        {canvasView === "audit" && (
          <WorkspacePaneResizeHandle
            pane="rail"
            value={workspaceLayout.layout.railWidth}
            range={workspaceLayout.layout.railRange}
            label={t("resizeCasePane")}
            hint={t("resizePaneHint")}
            controls="case-rail evidence-workspace"
            onChange={(width) => workspaceLayout.resizePane("rail", width)}
            onReset={() => workspaceLayout.resetPane("rail")}
          />
        )}

        <section
          id="evidence-workspace"
          className="evidence-canvas pane"
          aria-label={t("evidenceWorkspace")}
          tabIndex={-1}
        >
          <div className="canvas-toolbar">
            <div
              className="canvas-switch"
              role="tablist"
              aria-label={t("canvasView")}
              onKeyDown={(event) => handleRovingListKeyDown(event, "horizontal")}
            >
              <button
                id="canvas-tab-review"
                type="button"
                role="tab"
                data-roving-item
                aria-controls="canvas-panel"
                aria-selected={reviewSelected}
                tabIndex={reviewSelected ? 0 : -1}
                className={reviewSelected ? "is-active" : ""}
                onClick={() => showCanvas("review")}
              >
                {t("reviewTab")}
              </button>
              <button
                id="canvas-tab-changes"
                type="button"
                role="tab"
                data-roving-item
                aria-controls="canvas-panel"
                aria-selected={canvasView === "changes"}
                tabIndex={canvasView === "changes" ? 0 : -1}
                className={canvasView === "changes" ? "is-active" : ""}
                onClick={() => showCanvas("changes")}
              >
                {data.diffs.length > 0
                  ? `${t("changesTab")} (${data.diffs.length})`
                  : t("changesTab")}
              </button>
              <button
                id="canvas-tab-runs"
                type="button"
                role="tab"
                data-roving-item
                aria-controls="canvas-panel"
                aria-selected={canvasView === "runs"}
                tabIndex={canvasView === "runs" ? 0 : -1}
                className={canvasView === "runs" ? "is-active" : ""}
                onClick={() => {
                  if (executionCase) setSelectedId(`case:${executionCase.id}`);
                  showCanvas("runs");
                }}
              >
                {t("runsTab")}
              </button>
              <button
                id="canvas-tab-audit"
                type="button"
                role="tab"
                data-roving-item
                aria-controls="canvas-panel"
                aria-selected={canvasView === "audit"}
                tabIndex={canvasView === "audit" ? 0 : -1}
                className={canvasView === "audit" ? "is-active" : ""}
                onClick={() => showCanvas("audit")}
              >
                {t("auditTab")}
              </button>
            </div>
            <div className="canvas-context">
              {canvasView !== "review" && (
                <span>
                  {canvasView === "audit"
                    ? t("displayedEvidenceNodes", {
                        visible: displayedNodes.length,
                        total: visibleNodes.length,
                      })
                    : canvasView === "runs"
                    ? executionTrace
                      ? t("executionTraceContext", {
                          observed: executionTrace.capturedTraces,
                          expected: executionTrace.expectedExecutions,
                        })
                      : t("notRecorded")
                    : data.diffs.length > 0
                      ? t("runtimeFilesChanged", { count: data.diffs.length })
                      : t("diffEvidenceMissing")}
                </span>
              )}
              {canvasView === "changes" && data.diffs.length > 0 && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={focusMode ? t("exitDiffFocus") : t("enterDiffFocus")}
                  title={focusMode ? t("exitFocus") : t("focusOnDiff")}
                  onClick={() => setFocusMode((current) => !current)}
                >
                  {focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                </button>
              )}
            </div>
          </div>

          <div
            id="canvas-panel"
            className="canvas-panel"
            role="tabpanel"
            aria-labelledby={`canvas-tab-${canvasView}`}
          >
          {canvasView === "runs" && executionTrace ? (
            <EvalExecutionTraceView
              trace={executionTrace}
              cases={data.cases}
              manifest={data.run.manifest}
              planDigest={data.run.integrity?.plan_digest}
              executionProfile={data.run.execution_profile}
              onSelectCase={(caseId) => setSelectedId(`case:${caseId}`)}
              onOpenEvidence={(evidenceId) => {
                const node = data.spine.find((item) => item.id === evidenceId);
                if (node) openEvidence(node);
              }}
            />
          ) : canvasView === "runs" ? (
            <div className="diff-empty">
              <Bot size={24} />
              <strong>{t("noCasesMatch")}</strong>
              <p>{t("notRecorded")}</p>
            </div>
          ) : canvasView === "review" ? (
            <ReviewOverview
              data={data}
              onOpenEvidence={openEvidence}
              onOpenDiff={() => showCanvas("changes")}
              onOpenTrace={() => {
                if (executionCase) setSelectedId(`case:${executionCase.id}`);
                showCanvas("runs");
              }}
            />
          ) : canvasView === "audit" ? (
            <div className="evidence-stage audit-evidence-stage">
              <div className="stage-intro">
                <div>
                  <span className="pane-kicker">{t("immutableRunRecord")}</span>
                  <h2>{t("auditArchive")}</h2>
                  <p>{t("auditArchiveDescription")}</p>
                </div>
                <div className="stage-guide">
                  <div
                    className="evidence-tree-actions"
                    role="group"
                    aria-label={t("evidenceTreeControls")}
                  >
                    <button
                      type="button"
                      onClick={expandEvidenceTree}
                      disabled={allEvidenceExpanded}
                    >
                      {t("expandAllEvidence")}
                    </button>
                    <button
                      type="button"
                      onClick={collapseEvidenceTree}
                      disabled={allEvidenceCollapsed}
                    >
                      {t("collapseAllEvidence")}
                    </button>
                  </div>
                  <div className="legend" aria-label={t("statusLegend")}>
                    <span><i className="legend-dot good" /> {t("passed")}</span>
                    <span><i className="legend-dot warn" /> {t("pending")}</span>
                    <span><i className="legend-dot bad" /> {t("blocked")}</span>
                  </div>
                </div>
              </div>

              <div
                className="evidence-list"
                aria-label={t("evidenceHierarchy")}
                onKeyDown={(event) => handleRovingListKeyDown(event)}
              >
                {evidenceDisplayItems.map((item) => {
                  if (item.type === "node") {
                    return renderEvidenceNode(item.node);
                  }
                  const candidateSummary = evidenceArmSummaries.get(
                    `${item.parentId}:${item.candidateArm}`,
                  ) ?? { passed: 0, total: 0, artifacts: 0 };
                  const baselineSummary = evidenceArmSummaries.get(
                    `${item.parentId}:${item.baselineArm}`,
                  ) ?? { passed: 0, total: 0, artifacts: 0 };
                  return (
                    <section
                      key={item.key}
                      className="evidence-version-comparison"
                      aria-label={t("pairedEvidenceRegion")}
                    >
                      <header className="evidence-comparison-intro">
                        <span className="evidence-comparison-mark" aria-hidden="true">
                          <GitCompareArrows size={16} />
                        </span>
                        <span>
                          <small>{t("armEvidenceGroup")}</small>
                          <strong>{t("pairedArms")}</strong>
                          <p>{t("pairedEvidenceLayoutDescription")}</p>
                        </span>
                        <em>
                          {t("pairedEvidenceItems", { count: item.pairs.length })}
                        </em>
                      </header>

                      <div className="evidence-comparison-headings">
                        <div className="evidence-comparison-heading is-candidate">
                          <Bot size={16} aria-hidden="true" />
                          <span>
                            <small>{t("candidateLane")}</small>
                            <strong>{localizeValue(locale, item.candidateArm)}</strong>
                            <em>{t("armEvidenceSummary", candidateSummary)}</em>
                          </span>
                        </div>
                        <div className="evidence-comparison-axis" aria-hidden="true">
                          <GitCompareArrows size={13} />
                          <span>{t("itemByItemComparison")}</span>
                        </div>
                        <div className="evidence-comparison-heading is-baseline">
                          <GitCompareArrows size={16} aria-hidden="true" />
                          <span>
                            <small>{t("baselineLane")}</small>
                            <strong>{localizeValue(locale, item.baselineArm)}</strong>
                            <em>{t("armEvidenceSummary", baselineSummary)}</em>
                          </span>
                        </div>
                      </div>

                      <div className="evidence-comparison-pairs">
                        {item.pairs.map((pair, pairIndex) => {
                          const relationship = evidenceComparisonRelationship(
                            pair.candidate,
                            pair.baseline,
                          );
                          const relationshipLabel = t(
                            relationship === "same"
                              ? "evidenceComparisonSame"
                              : relationship === "different"
                                ? "evidenceComparisonDifferent"
                                : "evidenceComparisonMissing",
                          );
                          return (
                            <div
                              key={`${pair.key}:${pairIndex}`}
                              className={`evidence-comparison-pair is-${relationship}`}
                            >
                              <div className="evidence-comparison-cell is-candidate">
                                <span className="comparison-mobile-role">
                                  {t("candidateLane")}
                                </span>
                                {pair.candidate ? (
                                  renderEvidenceNode(pair.candidate, {
                                    comparisonCell: true,
                                  })
                                ) : (
                                  <div className="evidence-comparison-missing">
                                    <CircleAlert size={16} aria-hidden="true" />
                                    <span>{t("candidateEvidenceMissing")}</span>
                                  </div>
                                )}
                              </div>
                              <div
                                className={`evidence-comparison-bridge is-${relationship}`}
                                aria-label={`${t("comparisonConclusion")}：${relationshipLabel}`}
                              >
                                <span>
                                  {relationship === "same" ? (
                                    <Check size={13} aria-hidden="true" />
                                  ) : relationship === "different" ? (
                                    <X size={13} aria-hidden="true" />
                                  ) : (
                                    <CircleAlert size={13} aria-hidden="true" />
                                  )}
                                  <small>{relationshipLabel}</small>
                                </span>
                              </div>
                              <div className="evidence-comparison-cell is-baseline">
                                <span className="comparison-mobile-role">
                                  {t("baselineLane")}
                                </span>
                                {pair.baseline ? (
                                  renderEvidenceNode(pair.baseline, {
                                    comparisonCell: true,
                                  })
                                ) : (
                                  <div className="evidence-comparison-missing">
                                    <CircleAlert size={16} aria-hidden="true" />
                                    <span>{t("baselineEvidenceMissing")}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          ) : data.diffs.length ? (
            <Suspense
              fallback={
                <div className="diff-empty">
                  <p>{t("loadingDiffRenderer")}</p>
                </div>
              }
            >
              <DiffViewer
                diffs={data.diffs}
                selectedId={selectedDiffId}
                onSelectedIdChange={setSelectedDiffId}
                layout={diffLayout}
                onLayoutChange={setDiffLayout}
                wrapLines={wrapLines}
                onWrapLinesChange={setWrapLines}
              />
            </Suspense>
          ) : (
            <div className="diff-empty">
              <GitCompareArrows size={24} />
              <h2>{t("noRuntimeChanges")}</h2>
              <p>{t("candidateMatchesRuntime")}</p>
            </div>
          )}
          </div>
        </section>

        {auditInspectorVisible && (
          <WorkspacePaneResizeHandle
            pane="inspector"
            value={workspaceLayout.layout.inspectorWidth}
            range={workspaceLayout.layout.inspectorRange}
            label={t("resizeInspectorPane")}
            hint={t("resizePaneHint")}
            controls="evidence-workspace evidence-inspector"
            onChange={(width) => workspaceLayout.resizePane("inspector", width)}
            onReset={() => workspaceLayout.resetPane("inspector")}
          />
        )}

        <aside
          ref={inspectorRef}
          id="evidence-inspector"
          className={`inspector pane ${
            drawerInspectorVisible ? "evidence-drawer" : ""
          } ${evidenceDrawerModal ? "is-modal" : ""
          }`}
          aria-label={t("evidenceInspector")}
          role={drawerInspectorVisible ? "dialog" : undefined}
          aria-modal={evidenceDrawerModal ? true : undefined}
          hidden={!inspectorVisible}
        >
          <div className="pane-heading">
            <div>
              <span className="pane-kicker">{t("inspector")}</span>
              <h2>
                {selected ? localizeValue(locale, selected.kind) : t("evidence")}
              </h2>
            </div>
            <div className="inspector-heading-actions">
              <Fingerprint size={17} aria-hidden="true" />
              {drawerInspectorVisible && (
                <button
                  ref={evidenceDrawerCloseButtonRef}
                  type="button"
                  className="icon-button"
                  aria-label={t("close")}
                  onClick={() => setPanel("none")}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {selected ? (
            <div className="inspector-body" ref={inspectorBodyRef}>
              <div className="inspector-title">
                <div className="inspector-title-actions">
                  <StatusChip status={selected.status} />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("copyEvidenceReference")}
                    title={t("copyEvidenceReference")}
                    onClick={copyEvidenceReference}
                  >
                    <Link2 size={13} />
                  </button>
                </div>
                <h3>{selectedSemantic?.title ?? selected.label}</h3>
                <p>
                  {selectedSemantic?.description ??
                    t("retainedEvidenceDescription")}
                </p>
              </div>

              {selectedFinding && (
                <div
                  className={`inspector-outcome outcome-${statusTone(selected.status)}`}
                >
                  <span>{t("currentFinding")}</span>
                  <strong>{selectedFinding.title}</strong>
                  <p>{selectedFinding.description}</p>
                </div>
              )}

              {selectedDecisionBasis && (
                <section className="decision-basis-card">
                  <div className="section-label decision-basis-heading">
                    <FileCheck2 size={13} /> {t("decisionBasis")}
                  </div>
                  <p className="decision-basis-summary">
                    {selectedDecisionBasis.summary}
                  </p>
                  <div className="decision-basis-list">
                    {selectedDecisionBasis.items.map((item) => {
                      const evidenceNode = item.evidenceNodeId
                        ? nodesById.get(item.evidenceNodeId)
                        : undefined;
                      return (
                        <DecisionBasisRow
                          key={item.id}
                          item={item}
                          onOpen={
                            evidenceNode
                              ? () => openEvidence(evidenceNode)
                              : undefined
                          }
                        />
                      );
                    })}
                  </div>
                  {selectedDecisionBasis.nextStep && (
                    <div className="decision-next-step">
                      <span>{t("nextReviewStep")}</span>
                      <p>{selectedDecisionBasis.nextStep}</p>
                    </div>
                  )}
                </section>
              )}

              {selectedGuide && (
                <section className="review-guide-card">
                  <div className="review-guide-section">
                    <div className="section-label">{t("whyItMatters")}</div>
                    <p>{selectedGuide.purpose}</p>
                  </div>
                  {selectedGuide.inputs.length > 0 && (
                    <div className="review-guide-section">
                      <div className="section-label">{t("evidenceInputs")}</div>
                      <dl className="review-input-list">
                        {selectedGuide.inputs.map((input) => (
                          <div key={`${input.label}:${input.value}`}>
                            <dt>{input.label}</dt>
                            <dd>{input.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  )}
                  <div className="review-guide-section">
                    <div className="section-label">{t("reviewerChecklist")}</div>
                    <ol className="review-checklist">
                      {selectedGuide.reviewerChecks.map((check) => (
                        <li key={check}>{check}</li>
                      ))}
                    </ol>
                  </div>
                </section>
              )}

              {(selected.arm || selectedRepeat || selected.assertion_type) && (
                <dl className="fact-list human-fact-list">
                  {selected.arm && (
                    <div>
                      <dt>{t("arm")}</dt>
                      <dd>{localizeValue(locale, selected.arm)}</dd>
                    </div>
                  )}
                  {selectedRepeat && (
                    <div>
                      <dt>{t("repeat")}</dt>
                      <dd>{selectedRepeat}</dd>
                    </div>
                  )}
                  {selected.assertion_type && (
                    <div>
                      <dt>{t("assertion")}</dt>
                      <dd>{localizeValue(locale, selected.assertion_type)}</dd>
                    </div>
                  )}
                </dl>
              )}

              <EvidenceReader node={selected} />

              <details className="technical-facts">
                <summary>
                  <ChevronRight size={13} aria-hidden="true" />
                  {t("technicalTrace")}
                </summary>
                <dl className="fact-list">
                  <div>
                    <dt>{t("evidenceId")}</dt>
                    <dd><code>{selected.id}</code></dd>
                  </div>
                  {selectedSemantic && (
                    <div>
                      <dt>{t("technicalName")}</dt>
                      <dd><code>{selectedSemantic.technicalLabel}</code></dd>
                    </div>
                  )}
                  {selected.path && (
                    <div className="fact-path">
                      <dt>{t("artifactPath")}</dt>
                      <dd>{selected.path}</dd>
                    </div>
                  )}
                  {selected.artifact && (
                    <div className="fact-path">
                      <dt>{t("decisionArtifact")}</dt>
                      <dd>{selected.artifact}</dd>
                    </div>
                  )}
                  <div>
                    <dt>{t("subjectFingerprint")}</dt>
                    <dd>
                      <code>
                        {shortDigest(
                          data.run.subject?.digest,
                          t("notRecorded"),
                        )}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>{t("baselineFingerprint")}</dt>
                    <dd>
                      <code>
                        {shortDigest(
                          data.run.baseline?.digest,
                          t("notRecorded"),
                        )}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>{t("plan")}</dt>
                    <dd>
                      <code>
                        {shortDigest(
                          data.run.integrity?.plan_digest,
                          t("notRecorded"),
                        )}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>{t("profile")}</dt>
                    <dd>
                      <code>
                        {shortDigest(
                          data.run.execution_profile?.digest,
                          t("notRecorded"),
                        )}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>{t("controlAnchor")}</dt>
                    <dd>
                      {data.run.control_anchor
                        ? localizeValue(locale, data.run.control_anchor)
                        : t("notUsed")}
                    </dd>
                  </div>
                </dl>
              </details>

              {selected.kind === "case" && selectedCase && (
                <div className="arm-matrix">
                  <div className="section-label">
                    <GitCompareArrows size={13} /> {t("pairedArms")}
                  </div>
                  {selectedCase.missing_objective_metrics.length > 0 && (
                    <p className="arm-warning">
                      {t("missingObjectiveMetrics", {
                        metrics: selectedCase.missing_objective_metrics.join(", "),
                      })}
                    </p>
                  )}
                  {selectedCase.arms.map((arm) => (
                    <article key={arm.id}>
                      <div>
                        <strong>{localizeValue(locale, arm.id)}</strong>
                        <StatusChip
                          status={
                            arm.passed
                              ? "passed"
                              : arm.complete
                                ? "failed"
                                : "incomplete"
                          }
                        />
                      </div>
                      <p>
                        {t("assertionsSummary", {
                          passed: arm.assertions.passed,
                          total: arm.assertions.total,
                          rate: percent(arm.required_pass_rate),
                        })}
                      </p>
                      {((arm.forbidden_actions?.length ?? 0) > 0 ||
                        (arm.side_effects?.length ?? 0) > 0 ||
                        (arm.binding_errors?.length ?? 0) > 0) && (
                        <p className="arm-warning">
                          {t("bindingSummary", {
                            binding: arm.binding_errors?.length ?? 0,
                            forbidden: arm.forbidden_actions?.length ?? 0,
                            effects: arm.side_effects?.length ?? 0,
                          })}
                        </p>
                      )}
                    </article>
                  ))}
                </div>
              )}

              {selected.kind === "case" &&
                selectedCase &&
                selectedCase.semantic_assertions.length > 0 && (
                <div className="arm-matrix semantic-matrix">
                  <div className="section-label">
                    <Beaker size={13} /> {t("semanticEvidence")}
                  </div>
                  {selectedCase.semantic_assertions.map((assertion) => {
                    const semantic = describeAssertion(
                      locale,
                      assertion.id,
                      "semantic_pair",
                    );
                    return (
                      <article key={assertion.id}>
                        <div>
                          <strong>{semantic.title}</strong>
                          <StatusChip
                            status={assertion.passed ? "passed" : assertion.status}
                          />
                        </div>
                        <p>{semantic.description}</p>
                        <p>
                          {t("preference", {
                            value: assertion.preference
                              ? localizeValue(locale, assertion.preference)
                              : t("unresolved"),
                          })}
                          {assertion.resolved_winners?.length
                            ? ` · ${assertion.resolved_winners
                                .map((winner) => localizeValue(locale, winner))
                                .join(" / ")}`
                            : ""}
                        </p>
                        {assertion.reason && (
                          <p className="arm-warning">{assertion.reason}</p>
                        )}
                        {assertion.artifact && (
                          <details className="inline-technical-facts">
                            <summary>{t("technicalTrace")}</summary>
                            <code>{assertion.artifact}</code>
                          </details>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}

              <div className="provenance-card">
                <div className="section-label">
                  <Fingerprint size={13} /> {t("provenance")}
                </div>
                <dl>
                  <div><dt>{t("baseline")}</dt><dd>{data.run.baseline?.kind ? localizeValue(locale, data.run.baseline.kind) : t("none")}</dd></div>
                  <div><dt>{t("target")}</dt><dd>{data.run.execution_profile?.target ? localizeValue(locale, data.run.execution_profile.target) : t("unknown")}</dd></div>
                  <div><dt>{t("harness")}</dt><dd>{data.run.execution_profile?.harness ? localizeValue(locale, data.run.execution_profile.harness) : t("unknown")}</dd></div>
                  <div><dt>{t("holdout")}</dt><dd>{localizeValue(locale, data.run.holdout?.visibility ?? "public")}</dd></div>
                  <div><dt>{t("evidence")}</dt><dd>{localizeValue(locale, data.run.evidence_scope)}</dd></div>
                </dl>
              </div>
            </div>
          ) : (
            <p className="empty-note">{t("selectEvidence")}</p>
          )}

          {selected?.kind === "run" && (
            <div className="limitations-card">
              <div className="section-label">
                <CircleAlert size={13} /> {t("limitations")}
              </div>
              {data.limitations.length ? (
                <ul className="limitation-list">
                  {data.limitations.map((item) => {
                    const limitation = describeLimitation(locale, item);
                    return (
                      <li key={item}>
                        <article>
                          <strong>{limitation.title}</strong>
                          <p>{limitation.description}</p>
                          <details className="inline-technical-facts">
                            <summary>{t("technicalTrace")}</summary>
                            <code>{limitation.technicalLabel}</code>
                          </details>
                        </article>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p>{t("noLimitations")}</p>
              )}
            </div>
          )}
        </aside>
      </div>

      <footer className="statusbar">
        {generatedTime && (
          <span title={data.generated_at ?? undefined}>
            <Clock3 size={12} />
            {t("generatedAt", { time: generatedTime })}
          </span>
        )}
        <span>
          <RefreshCw size={12} />
          {loadedTime
            ? t("loadedAt", { time: loadedTime })
            : t("notChecked")}
        </span>
        {refreshControls?.error && attemptedTime && (
          <span title={refreshControls.error}>
            <CircleAlert size={12} /> {t("attemptedAt", { time: attemptedTime })}
          </span>
        )}
        {refreshControls && (
          <div className="refresh-controls" aria-label={t("refreshDashboard")}>
            <span>
              {refreshControls.paused
                ? t("autoRefreshPaused")
                : `${t("autoRefreshOn")} · ${t("refreshEvery", {
                    seconds: Math.max(
                      1,
                      Math.round(data.refresh_interval_ms / 1000),
                    ),
                  })}`}
            </span>
            <button
              type="button"
              aria-label={
                refreshControls.paused
                  ? t("resumeAutoRefresh")
                  : t("pauseAutoRefresh")
              }
              title={
                refreshControls.paused
                  ? t("resumeAutoRefresh")
                  : t("pauseAutoRefresh")
              }
              onClick={refreshControls.onTogglePaused}
            >
              {refreshControls.paused ? <Play size={11} /> : <Pause size={11} />}
            </button>
            <button
              type="button"
              aria-label={t("refreshDashboard")}
              title={t("refreshDashboard")}
              onClick={refreshControls.onRefresh}
            >
              <RefreshCw
                className={refreshControls.isRefreshing ? "is-spinning" : ""}
                size={11}
              />
            </button>
          </div>
        )}
        <span className="statusbar-spacer" />
        <span><FileText size={12} /> {t("retainedJsonArtifacts")}</span>
        <span title={data.contract}>
          <FileText size={12} /> {t("evidenceDataLoaded")}
        </span>
      </footer>

      <CommandPalette
        open={commandsOpen}
        commands={commands}
        onClose={() => setCommandsOpen(false)}
      />
      {notification && (
        <div className="product-toast" role="status">
          {notification}
        </div>
      )}
    </main>
  );
}

export default function App() {
  const {
    data,
    error,
    compatibilityError,
    connectionState,
    paused,
    setPaused,
    isRefreshing,
    lastSuccessfulAt,
    lastAttemptAt,
    refresh,
  } = useDashboardData();
  const { t } = useUiPreferences();

  if (!data) {
    return (
      <main
        className={`loading-shell ${error ? "error-shell" : ""}`}
        aria-live={error ? "assertive" : undefined}
      >
        <div className={`loading-mark ${error ? "error-mark" : ""}`}>
          {error ? <CircleAlert size={18} /> : "SR"}
        </div>
        <p className="pane-kicker">Skill Reviewer</p>
        <h1>
          {compatibilityError
            ? t("dashboardDataIncompatible")
            : error
              ? t("evidenceUnavailable")
              : t("connectingToEvidence")}
        </h1>
        <p>{error ?? t("waitingForData")}</p>
        {compatibilityError ? (
          <p>{t("dashboardDataRegenerateHelp")}</p>
        ) : (
          error && <p>{t("retryHelp")}</p>
        )}
        {error && (
          <button
            type="button"
            className="primary-action"
            onClick={() => void refresh()}
          >
            <RefreshCw className={isRefreshing ? "is-spinning" : ""} size={13} />
            {t("retryConnection")}
          </button>
        )}
      </main>
    );
  }

  return (
    <EvidenceDashboard
      data={data}
      connectionState={connectionState}
      refreshControls={{
        paused,
        isRefreshing,
        lastSuccessfulAt,
        lastAttemptAt,
        error,
        onRefresh: () => void refresh(),
        onTogglePaused: () => setPaused((current) => !current),
      }}
    />
  );
}

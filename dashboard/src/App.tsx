import {
  Activity,
  Archive,
  Beaker,
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
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CommandPalette, type DashboardCommand } from "./CommandPalette";
import { copyText, downloadDashboardData } from "./dashboard-actions";
import { EvidenceReader } from "./EvidenceReader";
import {
  dashboardViewUrl,
  readDashboardViewState,
  writeDashboardViewState,
  type CaseStatusFilter,
  type DashboardCanvasView,
  type DashboardDiffLayout,
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
import { handleRovingListKeyDown } from "./keyboard-navigation";
import type { DashboardCase, DashboardData, SpineNode } from "./types";
import {
  localizeStatus,
  localizeValue,
  useUiPreferences,
} from "./ui-preferences";

type SplitFilter = DashboardSplit;
type ConnectionState = "connecting" | "live" | "stale";
type CanvasView = DashboardCanvasView;

const DiffViewer = lazy(() => import("./DiffViewer"));

const splitOptions: SplitFilter[] = ["all", "development", "selection", "audit"];

const iconByKind = {
  run: Activity,
  gate: ShieldCheck,
  iteration: GitCompareArrows,
  case: Beaker,
  assertion: FileCheck2,
  artifact: Archive,
} satisfies Record<SpineNode["kind"], typeof Activity>;

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

function StatusChip({ status }: { status: string }) {
  const { locale } = useUiPreferences();
  return (
    <span
      className={`status-chip status-${statusTone(status)}`}
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
  const dataUrl =
    import.meta.env.VITE_DASHBOARD_DATA_URL ?? "/dashboard-data.json";

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
      const response = await fetch(dataUrl, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`read model returned ${response.status}`);
      }
      const next = (await response.json()) as DashboardData;
      if (next.contract !== "skill-reviewer.dashboard-data") {
        throw new Error(
          `unsupported dashboard contract: ${String(next.contract)}`,
        );
      }
      if (!activeRef.current || controller.signal.aborted) return;
      setData(next);
      setError(null);
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
      setError(
        cause instanceof Error ? cause.message : "unable to read dashboard data",
      );
      setConnectionState((current) =>
        current === "live" ? "stale" : "connecting",
      );
      scheduleNext(3000);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        if (activeRef.current) setIsRefreshing(false);
      }
    }
  }, [dataUrl, scheduleNext]);

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

function DisplayPreferences() {
  const { locale, theme, setLocale, setTheme, t } = useUiPreferences();
  const nextTheme = theme === "light" ? "dark" : "light";

  return (
    <div className="display-controls" aria-label={t("displayPreferences")}>
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
          nextTheme === "dark" ? t("switchToDarkTheme") : t("switchToLightTheme")
        }
        title={
          nextTheme === "dark" ? t("switchToDarkTheme") : t("switchToLightTheme")
        }
        onClick={() => setTheme(nextTheme)}
      >
        <span className="theme-swatch" aria-hidden="true" />
        <span>{nextTheme === "dark" ? t("darkTheme") : t("lightTheme")}</span>
      </button>
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
      typeof window === "undefined" ? "" : window.location.search,
    ),
  );
  const [requestedRunId, setRequestedRunId] = useState(
    initialView.runId ?? data.run.id,
  );
  const runGuardMismatch = requestedRunId !== data.run.id;
  const [split, setSplit] = useState<SplitFilter>(initialView.split);
  const [caseStatus, setCaseStatus] = useState<CaseStatusFilter>(
    initialView.caseStatus,
  );
  const [caseQuery, setCaseQuery] = useState(initialView.query);
  const initialEvidenceId =
    data.spine.some((node) => node.id === initialView.evidenceId)
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
  const [focusMode, setFocusMode] = useState(initialView.focusMode);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);
  const caseSearchRef = useRef<HTMLInputElement>(null);
  const inspectorBodyRef = useRef<HTMLDivElement>(null);
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
  const visibleNodes = useMemo(
    () =>
      data.spine.filter((node) => {
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
    [caseQuery, caseStatus, data.spine, split, visibleCaseNodeIds],
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
      runId: data.run.id,
      split,
      caseStatus,
      query: caseQuery,
      canvasView,
      evidenceId: canvasView === "evidence" ? selectedId || null : null,
      diffId: canvasView === "diff" ? selectedDiffId : null,
      diffLayout,
      wrapLines,
      focusMode,
    }),
    [
      canvasView,
      caseQuery,
      caseStatus,
      data.run.id,
      diffLayout,
      focusMode,
      selectedDiffId,
      selectedId,
      split,
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
    const url = dashboardViewUrl(currentView, window.location.href).toString();
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
    setCanvasView("evidence");
  }, [revealEvidence]);

  const openEvidence = useCallback((node: SpineNode) => {
    setSplit(node.split ?? "all");
    setCaseStatus("all");
    setCaseQuery("");
    revealEvidence(node.id);
    setSelectedId(node.id);
    setCanvasView("evidence");
  }, [revealEvidence]);

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
    setCanvasView("diff");
  }, []);

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
    if (canvasView !== "diff") setFocusMode(false);
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
    if (runGuardMismatch) return;
    const previous = previousViewRef.current;
    previousViewRef.current = currentView;
    if (restoringHistoryRef.current) {
      restoringHistoryRef.current = false;
      return;
    }
    const queryOnly =
      previous !== null &&
      previous.query !== currentView.query &&
      previous.runId === currentView.runId &&
      previous.split === currentView.split &&
      previous.caseStatus === currentView.caseStatus &&
      previous.canvasView === currentView.canvasView &&
      previous.evidenceId === currentView.evidenceId &&
      previous.diffId === currentView.diffId &&
      previous.diffLayout === currentView.diffLayout &&
      previous.wrapLines === currentView.wrapLines &&
      previous.focusMode === currentView.focusMode;
    writeDashboardViewState(
      currentView,
      previous && !queryOnly ? "push" : "replace",
    );
  }, [currentView, runGuardMismatch]);

  useEffect(() => {
    const restoreView = () => {
      const next = readDashboardViewState(window.location.search);
      restoringHistoryRef.current = true;
      setRequestedRunId(next.runId ?? data.run.id);
      setSplit(next.split);
      setCaseStatus(next.caseStatus);
      setCaseQuery(next.query);
      setCanvasView(next.canvasView);
      setDiffLayout(next.diffLayout);
      setWrapLines(next.wrapLines);
      setFocusMode(next.focusMode);
      setSelectedId(
        next.evidenceId && data.spine.some((node) => node.id === next.evidenceId)
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
      if (runGuardMismatch) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandsOpen((current) => !current);
        return;
      }
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !commandsOpen &&
        !acceptsTextInput(event.target)
      ) {
        event.preventDefault();
        caseSearchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [commandsOpen, runGuardMismatch]);

  useEffect(
    () => () => window.clearTimeout(notificationTimerRef.current),
    [],
  );

  const selected =
    data.spine.find((node) => node.id === selectedId) ?? visibleNodes[0];
  const selectedCase = caseForEvidenceNode(selected, nodesById, data.cases);
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
  const failedGateCount = Math.max(
    0,
    data.summary.hard_gates_total - data.summary.hard_gates_passed,
  );
  const failedCaseCount = Math.max(0, data.summary.candidate_failed);
  const runTone = data.run.release_eligible
    ? "good"
    : failedCaseCount > 0 || failedGateCount > 0
      ? "bad"
      : "warn";
  const releaseMessage = data.run.release_eligible
    ? t("releaseEligible")
    : t("releaseBlocked");
  const releaseDecision = data.run.release_eligible
    ? t("releaseReady")
    : t("releaseBlockedTitle");
  const releaseDecisionSummary = data.run.release_eligible
    ? t("releaseReadySummary")
    : failedCaseCount > 0 || failedGateCount > 0
      ? t("releaseBlockedSummary", {
          cases: failedCaseCount,
          gates: failedGateCount,
        })
      : t("releaseBlockedGenericSummary");
  const copyEvidenceReference = useCallback(() => {
    if (!selected) return;
    const permalink = dashboardViewUrl(currentView, window.location.href).toString();
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

  const commands: DashboardCommand[] = [
    {
      id: "action-show-evidence",
      group: t("actionGroup"),
      label: t("showEvidence"),
      detail: t("evidenceChainDescription"),
      run: () => setCanvasView("evidence"),
    },
    {
      id: "action-show-diff",
      group: t("actionGroup"),
      label: t("showDiff"),
      detail: t("runtimeFilesChanged", { count: data.diffs.length }),
      run: () => setCanvasView("diff"),
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

  if (runGuardMismatch) {
    return (
      <main className="loading-shell error-shell" aria-live="assertive">
        <div className="loading-mark error-mark"><CircleAlert size={18} /></div>
        <p className="pane-kicker">Skill Reviewer</p>
        <h1>{t("runMismatchTitle")}</h1>
        <p>
          {t("runMismatchBody", {
            requested: requestedRunId ?? t("unknown"),
            current: data.run.id,
          })}
        </p>
        <button
          type="button"
          className="primary-action"
          onClick={() => {
            setRequestedRunId(data.run.id);
          }}
        >
          {t("openCurrentRun")}
        </button>
      </main>
    );
  }

  return (
    <main
      className={`app-shell ${focusMode ? "is-focus-mode" : ""} ${
        refreshControls?.error ? "has-transport-warning" : ""
      }`}
    >
      <a className="skip-link" href="#evidence-workspace">
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
            <StatusChip status={data.run.verification_level} />
            <StatusChip status={data.run.status} />
            <span className="readonly-pill">
              <LockKeyhole size={12} /> {t("readOnly")}
            </span>
          </div>
          <ReviewActions
            shortcut={commandShortcut}
            onOpenCommands={() => setCommandsOpen(true)}
            onCopyLink={copyCurrentView}
            onDownload={downloadEvidence}
          />
          <DisplayPreferences />
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

      <section
        className={`run-summary summary-${runTone}`}
        aria-label={t("behavioralGateState")}
      >
        <div className="release-state">
          <span>{t("releaseState")}</span>
          <strong>{releaseDecision}</strong>
          <small>{releaseDecisionSummary}</small>
        </div>
        <div className="summary-metrics" role="list" aria-label={t("runSummary")}>
          <div role="listitem">
            <span>{t("hardGates")}</span>
            <strong>
              {data.summary.hard_gates_passed} / {data.summary.hard_gates_total}
            </strong>
          </div>
          <div role="listitem">
            <span>{t("casesPassed")}</span>
            <strong>
              {data.summary.candidate_passed} / {data.summary.case_count}
            </strong>
          </div>
          <div role="listitem">
            <span>{t("round")}</span>
            <strong>
              {data.summary.current_round ?? "—"} / {data.summary.max_rounds}
            </strong>
          </div>
          <div role="listitem">
            <span>{t("evidenceScope")}</span>
            <strong>{localizeValue(locale, data.run.evidence_scope)}</strong>
          </div>
        </div>
        <div className="integrity-mark">
          {data.run.integrity?.verified ? (
            <ShieldCheck size={15} />
          ) : (
            <CircleAlert size={15} />
          )}
          <span>
            {data.run.integrity?.verified ? t("inputsLocked") : t("integrityPending")}
            <small>{releaseMessage}</small>
          </span>
        </div>
      </section>

      <div className="workspace-grid">
        <aside className="rail pane" aria-label={t("runOverview")}>
          <div className="pane-heading">
            <div>
              <span className="pane-kicker">{t("evaluationSuite")}</span>
              <h2>{t("cases")}</h2>
            </div>
            <span className="count-badge">{visibleCases.length}</span>
          </div>

          <div className="filter-block">
            <div className="section-label">
              <SlidersHorizontal size={13} /> {t("split")}
            </div>
            <div className="segmented-control">
              {splitOptions.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={split === item ? "is-active" : ""}
                  aria-pressed={split === item}
                  onClick={() => setSplit(item)}
                >
                  {t(splitMessageKeys[item])}
                </button>
              ))}
            </div>
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
                  onClick={() => setSelectedId(`case:${item.id}`)}
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

          <div className="evolution-summary">
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
          </div>
        </aside>

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
                id="canvas-tab-evidence"
                type="button"
                role="tab"
                data-roving-item
                aria-controls="canvas-panel"
                aria-selected={canvasView === "evidence"}
                tabIndex={canvasView === "evidence" ? 0 : -1}
                className={canvasView === "evidence" ? "is-active" : ""}
                onClick={() => setCanvasView("evidence")}
              >
                {t("evidence")}
              </button>
              <button
                id="canvas-tab-diff"
                type="button"
                role="tab"
                data-roving-item
                aria-controls="canvas-panel"
                aria-selected={canvasView === "diff"}
                tabIndex={canvasView === "diff" ? 0 : -1}
                className={canvasView === "diff" ? "is-active" : ""}
                onClick={() => setCanvasView("diff")}
              >
                {t("diff")} ({data.diffs.length})
              </button>
            </div>
            <div className="canvas-context">
              <span>
                {canvasView === "evidence"
                  ? t("displayedEvidenceNodes", {
                      visible: displayedNodes.length,
                      total: visibleNodes.length,
                    })
                  : t("runtimeFilesChanged", { count: data.diffs.length })}
              </span>
              {canvasView === "diff" && data.diffs.length > 0 && (
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
          {canvasView === "evidence" ? (
            <div className="evidence-stage">
              <div className="stage-intro">
                <div>
                  <span className="pane-kicker">{t("immutableRunRecord")}</span>
                  <h2>{t("evidenceChain")}</h2>
                  <p>{t("evidenceChainDescription")}</p>
                  {(failedCaseCount > 0 || failedGateCount > 0) && (
                    <div className="blocking-evidence-scope" role="note">
                      <div className="blocking-evidence-flow">
                        <CircleAlert size={13} aria-hidden="true" />
                        <strong>
                          {t("blockingEvidenceFlow", {
                            cases: failedCaseCount,
                            gates: failedGateCount,
                          })}
                        </strong>
                      </div>
                      <span>{t("blockingEvidenceExplanation")}</span>
                    </div>
                  )}
                </div>
                <div className="stage-guide">
                  <span className="first-review-guide">{t("firstReviewGuide")}</span>
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
                {displayedNodes.map((node, index) => {
                  const Icon = iconByKind[node.kind];
                  const depth = nodeDepth(node, nodesById);
                  const childCount = visibleChildCounts.get(node.id) ?? 0;
                  const isExpanded = expandedNodeIds.has(node.id);
                  const semantic = nodeSemanticsById.get(node.id)!;
                  const repeat = repeatFromEvidenceNode(node);
                  return (
                    <div
                      className={`evidence-row tone-${statusTone(node.status)} ${
                        selectedId === node.id ? "is-selected" : ""
                      } ${childCount ? "is-group" : "is-leaf"} ${
                        isExpanded ? "is-expanded" : ""
                      }`}
                      key={node.id}
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
                      <span className="node-icon">
                        <Icon size={15} strokeWidth={1.8} />
                      </span>
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
                        onClick={() => setSelectedId(node.id)}
                      >
                        <span className="node-copy">
                          <span className="node-meta">
                            {localizeValue(locale, node.kind)}
                            {node.arm
                              ? ` · ${localizeValue(locale, node.arm)}`
                              : ""}
                            {repeat
                              ? ` · ${t("repeatMeta", { count: repeat })}`
                              : ""}
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
              <strong>{t("noRuntimeChanges")}</strong>
              <p>{t("candidateMatchesRuntime")}</p>
            </div>
          )}
          </div>
        </section>

        <aside className="inspector pane" aria-label={t("evidenceInspector")}>
          <div className="pane-heading">
            <div>
              <span className="pane-kicker">{t("inspector")}</span>
              <h2>
                {selected ? localizeValue(locale, selected.kind) : t("evidence")}
              </h2>
            </div>
            <Fingerprint size={17} aria-hidden="true" />
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
        </aside>
      </div>

      <footer className="statusbar">
        <span title={data.generated_at ?? undefined}>
          <Clock3 size={12} />
          {generatedTime
            ? t("generatedAt", { time: generatedTime })
            : t("generationTimeUnavailable")}
        </span>
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
        <h1>{error ? t("evidenceUnavailable") : t("connectingToEvidence")}</h1>
        <p>{error ?? t("waitingForData")}</p>
        {error && <p>{t("retryHelp")}</p>}
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

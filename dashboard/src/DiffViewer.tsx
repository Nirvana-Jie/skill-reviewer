import {
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Columns2,
  RefreshCw,
  Rows3,
  Search,
  WrapText,
} from "lucide-react";
import {
  MultiFileDiff,
  type WorkerInitializationRenderOptions,
  Virtualizer,
  WorkerPoolContextProvider,
  useWorkerPool,
} from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { copyText } from "./dashboard-actions";
import type { DashboardDiffLayout } from "./dashboard-view-state";
import {
  buildDiffTree,
  directoryAncestorIds,
  flattenDiffTree,
} from "./diff-tree";
import { FileTypeIcon, FolderTypeIcon, RootFolderIcon } from "./file-icons";
import { handleRovingListKeyDown } from "./keyboard-navigation";
import type { DashboardDiff, DashboardDiffPayload } from "./types";
import { localizeValue, useUiPreferences } from "./ui-preferences";

const workerPoolOptions = {
  workerFactory: () => new DiffWorker(),
  poolSize: 2,
  totalASTLRUCacheSize: 24,
};

type SupportedLanguage = NonNullable<
  WorkerInitializationRenderOptions["langs"]
>[number];

const languageByExtension = {
  bash: "shellscript",
  cjs: "javascript",
  css: "css",
  go: "go",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "jsonc",
  jsx: "jsx",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "shellscript",
  sql: "sql",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  txt: "text",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shellscript",
} as const satisfies Record<string, SupportedLanguage>;

const baseHighlighterOptions = {
  lineDiffType: "word-alt",
  tokenizeMaxLineLength: 1600,
  maxLineDiffLength: 1600,
  preferredHighlighter: "shiki-js",
} as const;

// Pierre reads provider options when its singleton is created, so live theme
// changes also need to update the already-running worker pool.
function WorkerRenderOptionsSync({ theme }: { theme: "pierre-dark" | "pierre-light" }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) return;
    void workerPool
      .setRenderOptions({
        theme,
        lineDiffType: baseHighlighterOptions.lineDiffType,
        maxLineDiffLength: baseHighlighterOptions.maxLineDiffLength,
        tokenizeMaxLineLength: baseHighlighterOptions.tokenizeMaxLineLength,
      })
      .catch((cause: unknown) => {
        console.error("unable to synchronize diff worker theme", cause);
      });
  }, [theme, workerPool]);

  return null;
}

function languageForPath(path: string): SupportedLanguage {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return languageByExtension[extension as keyof typeof languageByExtension] ?? "text";
}

const diffThemeProperties = {
  "--diffs-font-family":
    '"SFMono-Regular", "Roboto Mono", Consolas, "Liberation Mono", monospace',
  "--diffs-font-size": "12px",
  "--diffs-line-height": "20px",
  "--diffs-header-font-family":
    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
} as CSSProperties;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function splitPath(path: string, rootLabel: string): { directory: string; name: string } {
  const separator = path.lastIndexOf("/");
  if (separator < 0) return { directory: rootLabel, name: path };
  return {
    directory: path.slice(0, separator),
    name: path.slice(separator + 1),
  };
}

function changeMark(status: DashboardDiff["status"]): string {
  if (status === "added") return "A";
  if (status === "removed") return "D";
  return "M";
}

function validatePayload(
  payload: DashboardDiffPayload,
  metadata: DashboardDiff,
): DashboardDiffPayload {
  if (
    !metadata.payload_digest ||
    !/^[a-f0-9]{64}$/.test(metadata.payload_digest) ||
    payload.contract !== "skill-reviewer.dashboard-diff" ||
    payload.id !== metadata.id ||
    payload.path !== metadata.path ||
    payload.old_digest !== metadata.old_digest ||
    payload.new_digest !== metadata.new_digest
  ) {
    throw new DiffPayloadIntegrityError(
      "diff payload is not bound to its read-model metadata",
    );
  }
  return payload;
}

class DiffPayloadIntegrityError extends Error {}

interface DiffLoadError {
  kind: "integrity" | "transport";
  message: string;
}

function DiffBrowser({
  diffs,
  enableWorkerPool,
  selectedId: controlledSelectedId,
  onSelectedIdChange,
  layout: controlledLayout,
  onLayoutChange,
  wrapLines: controlledWrapLines,
  onWrapLinesChange,
}: {
  diffs: DashboardDiff[];
  enableWorkerPool: boolean;
  selectedId?: string | null;
  onSelectedIdChange?: (id: string) => void;
  layout?: DashboardDiffLayout;
  onLayoutChange?: (layout: DashboardDiffLayout) => void;
  wrapLines?: boolean;
  onWrapLinesChange?: (wrap: boolean) => void;
}) {
  const { locale, theme, t } = useUiPreferences();
  const [localSelectedId, setLocalSelectedId] = useState(diffs[0]?.id ?? "");
  const [payloads, setPayloads] = useState<Record<string, DashboardDiffPayload>>(
    {},
  );
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<DiffLoadError | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [rootCollapsed, setRootCollapsed] = useState(false);
  const [collapsedDirectoryIds, setCollapsedDirectoryIds] = useState<Set<string>>(
    new Set(),
  );
  const [localLayout, setLocalLayout] = useState<DashboardDiffLayout>("split");
  const [localWrapLines, setLocalWrapLines] = useState(false);
  const selectedId = controlledSelectedId ?? localSelectedId;
  const layout = controlledLayout ?? localLayout;
  const wrapLines = controlledWrapLines ?? localWrapLines;
  const selectId = (id: string) => {
    setLocalSelectedId(id);
    onSelectedIdChange?.(id);
  };
  const selectLayout = (next: DashboardDiffLayout) => {
    setLocalLayout(next);
    onLayoutChange?.(next);
  };
  const selectWrapLines = (next: boolean) => {
    setLocalWrapLines(next);
    onWrapLinesChange?.(next);
  };
  const diffTheme = theme === "dark" ? "pierre-dark" : "pierre-light";
  const highlighterLanguageKey = Array.from(
    new Set(diffs.map((diff) => languageForPath(diff.path))),
  )
    .sort()
    .join(",");
  const highlighterOptions = useMemo(
    () => ({
      ...baseHighlighterOptions,
      theme: diffTheme,
      langs: (highlighterLanguageKey
        ? highlighterLanguageKey.split(",")
        : ["text"]) as SupportedLanguage[],
    }),
    [diffTheme, highlighterLanguageKey],
  );

  const visibleDiffs = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return diffs;
    return diffs.filter((diff) => diff.path.toLowerCase().includes(normalized));
  }, [diffs, query]);
  const diffTree = useMemo(() => buildDiffTree(visibleDiffs), [visibleDiffs]);
  const searchExpandsDirectories = query.trim().length > 0;
  const rootExpanded = searchExpandsDirectories || !rootCollapsed;
  const diffTreeRows = useMemo(
    () =>
      flattenDiffTree(
        diffTree,
        collapsedDirectoryIds,
        searchExpandsDirectories,
      ),
    [collapsedDirectoryIds, diffTree, searchExpandsDirectories],
  );
  const selected = useMemo(
    () => visibleDiffs.find((diff) => diff.id === selectedId) ?? visibleDiffs[0],
    [selectedId, visibleDiffs],
  );
  const selectedIndex = selected
    ? visibleDiffs.findIndex((diff) => diff.id === selected.id)
    : -1;

  useEffect(() => {
    if (selected && selected.id !== selectedId) selectId(selected.id);
  }, [selected, selectedId]);

  useEffect(() => {
    if (!selected) return;
    setRootCollapsed(false);
    const ancestorIds = directoryAncestorIds(selected.path);
    if (!ancestorIds.length) return;
    setCollapsedDirectoryIds((current) => {
      const next = new Set(current);
      let changed = false;
      ancestorIds.forEach((id) => {
        if (!next.delete(id)) return;
        changed = true;
      });
      return changed ? next : current;
    });
  }, [selected?.path]);

  const selectedPayload = selected ? payloads[selected.id] : undefined;

  useEffect(() => {
    if (
      !selected ||
      selected.render_mode !== "lazy" ||
      !selected.content_url ||
      selectedPayload
    ) {
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoadingId(selected.id);
    setError(null);
    setDiagnosticsStatus(null);
    void fetch(selected.content_url, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`diff payload returned ${response.status}`);
        }
        return validatePayload(
          (await response.json()) as DashboardDiffPayload,
          selected,
        );
      })
      .then((payload) => {
        setPayloads((current) => ({ ...current, [selected.id]: payload }));
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError({
          kind:
            cause instanceof DiffPayloadIntegrityError
              ? "integrity"
              : "transport",
          message:
            cause instanceof Error ? cause.message : "unable to load diff",
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingId(null);
      });
    return () => controller.abort();
  }, [
    selected?.content_url,
    selected?.id,
    selected?.new_digest,
    selected?.old_digest,
    selected?.path,
    selected?.payload_digest,
    selected?.render_mode,
    selectedPayload,
    retryToken,
  ]);

  const copyLoadDiagnostics = () => {
    if (!selected || !error) return;
    const diagnostics = {
      surface: "skill-reviewer.dashboard-diff",
      error_kind: error.kind,
      error: error.message,
      diff_id: selected.id,
      path: selected.path,
      content_url: selected.content_url,
      payload_digest: selected.payload_digest,
      old_digest: selected.old_digest,
      new_digest: selected.new_digest,
    };
    void copyText(`${JSON.stringify(diagnostics, null, 2)}\n`)
      .then(() => setDiagnosticsStatus(t("diagnosticsCopied")))
      .catch(() => setDiagnosticsStatus(t("diagnosticsCopyFailed")));
  };

  const selectRelative = (offset: number) => {
    if (!visibleDiffs.length || selectedIndex < 0) return;
    const nextIndex =
      (selectedIndex + offset + visibleDiffs.length) % visibleDiffs.length;
    selectId(visibleDiffs[nextIndex].id);
  };

  const toggleDirectory = (id: string, expanded: boolean) => {
    setCollapsedDirectoryIds((current) => {
      const next = new Set(current);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const payload = selectedPayload;
  const selectedPath = selected ? splitPath(selected.path, t("rootDirectory")) : null;
  const lineSummary = payload
    ? t("lineSummary", {
        oldLines: payload.old_content.split("\n").length,
        newLines: payload.new_content.split("\n").length,
      })
    : null;

  const browser = (
    <div className="diff-browser">
      <aside className="diff-sidebar">
        <div className="diff-sidebar-heading">
          <strong>{t("changedFileTree")}</strong>
          <span>{visibleDiffs.length} / {diffs.length}</span>
        </div>
        <label className="diff-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            aria-label={t("filterChangedFiles")}
            placeholder={t("filterFiles")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <nav
          className="diff-file-list"
          aria-label={t("changedRuntimeFileTree")}
          onKeyDown={(event) => handleRovingListKeyDown(event)}
        >
          <button
            type="button"
            data-roving-item
            tabIndex={rootExpanded && selected ? -1 : 0}
            className="diff-tree-root"
            aria-expanded={rootExpanded}
            aria-label={t(
              rootExpanded ? "collapseChangedFilesRoot" : "expandChangedFilesRoot",
            )}
            aria-disabled={searchExpandsDirectories || undefined}
            onKeyDown={(event) => {
              if (searchExpandsDirectories) return;
              if (event.key === "ArrowLeft" && rootExpanded) {
                event.preventDefault();
                setRootCollapsed(true);
              }
              if (event.key === "ArrowRight" && !rootExpanded) {
                event.preventDefault();
                setRootCollapsed(false);
              }
            }}
            onClick={() => {
              if (!searchExpandsDirectories) setRootCollapsed(rootExpanded);
            }}
          >
            <ChevronRight
              className="diff-tree-chevron"
              size={12}
              aria-hidden="true"
            />
            <RootFolderIcon />
            <strong>{t("changedFilesRoot")}</strong>
            <small>{visibleDiffs.length}</small>
          </button>
          {rootExpanded && diffTreeRows.map(({ node, depth }, index) => {
            const visualDepth = depth + 1;
            if (node.kind === "directory") {
              const expanded =
                searchExpandsDirectories ||
                !collapsedDirectoryIds.has(node.id);
              return (
                <button
                  type="button"
                  data-roving-item
                  tabIndex={!selected && index === 0 ? 0 : -1}
                  key={node.id}
                  className="diff-tree-directory"
                  style={{ "--tree-depth": visualDepth } as CSSProperties}
                  aria-expanded={expanded}
                  aria-label={t(
                    expanded ? "collapseDirectory" : "expandDirectory",
                    { name: node.name },
                  )}
                  aria-disabled={searchExpandsDirectories || undefined}
                  title={node.path}
                  onKeyDown={(event) => {
                    if (searchExpandsDirectories) return;
                    if (event.key === "ArrowLeft" && expanded) {
                      event.preventDefault();
                      toggleDirectory(node.id, true);
                    }
                    if (event.key === "ArrowRight" && !expanded) {
                      event.preventDefault();
                      toggleDirectory(node.id, false);
                    }
                  }}
                  onClick={() => {
                    if (searchExpandsDirectories) return;
                    toggleDirectory(node.id, expanded);
                  }}
                >
                  <ChevronRight
                    className="diff-tree-chevron"
                    size={12}
                    aria-hidden="true"
                  />
                  <FolderTypeIcon name={node.name} expanded={expanded} />
                  <strong>{node.name}</strong>
                </button>
              );
            }
            const diff = node.diff;
            return (
              <button
                type="button"
                data-roving-item
                tabIndex={diff.id === selected?.id || index === 0 && !selected ? 0 : -1}
                key={node.id}
                className={`diff-tree-file ${
                  diff.id === selected?.id ? "is-selected" : ""
                }`}
                style={{ "--tree-depth": visualDepth } as CSSProperties}
                aria-pressed={diff.id === selected?.id}
                aria-label={t("openDiff", { path: diff.path })}
                title={`${diff.path}\n${localizeValue(locale, diff.status)} · ${formatBytes(diff.old_size)} → ${formatBytes(diff.new_size)}`}
                onClick={() => selectId(diff.id)}
              >
                <span className="diff-tree-chevron-spacer" aria-hidden="true" />
                <FileTypeIcon path={diff.path} />
                <span className="diff-tree-label">
                  {node.name}
                </span>
                <span
                  className={`diff-tree-change change-text-${diff.status}`}
                  aria-hidden="true"
                >
                  {changeMark(diff.status)}
                </span>
              </button>
            );
          })}
          {rootExpanded && diffTreeRows.length === 0 && (
            <p className="diff-no-results">
              {t("noChangedFilesMatch", { query })}
            </p>
          )}
        </nav>
      </aside>

      <section className="diff-workbench" aria-label={t("documentDiff")}>
        <header className="diff-toolbar">
          <div className="diff-path">
            {selected && selectedPath ? (
              <>
                <span className={`change-mark change-${selected.status}`}>
                  {changeMark(selected.status)}
                </span>
                <div>
                  <small>{selectedPath.directory}</small>
                  <strong>{selectedPath.name}</strong>
                </div>
                <span className="change-label">
                  {localizeValue(locale, selected.status)}
                </span>
              </>
            ) : (
              <strong>{t("noFileSelected")}</strong>
            )}
          </div>

          <div className="diff-toolbar-actions">
            {lineSummary && <span className="line-summary">{lineSummary}</span>}
            <div className="button-group" aria-label={t("fileNavigation")}>
              <button
                type="button"
                aria-label={t("previousChangedFile")}
                title={t("previousFile")}
                disabled={visibleDiffs.length < 2}
                onClick={() => selectRelative(-1)}
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                aria-label={t("nextChangedFile")}
                title={t("nextFile")}
                disabled={visibleDiffs.length < 2}
                onClick={() => selectRelative(1)}
              >
                <ChevronRight size={14} />
              </button>
            </div>
            <div className="button-group" aria-label={t("diffLayout")}>
              <button
                type="button"
                className={layout === "split" ? "is-active" : ""}
                aria-label={t("splitDiff")}
                aria-pressed={layout === "split"}
                title={t("splitDiff")}
                onClick={() => selectLayout("split")}
              >
                <Columns2 size={14} />
              </button>
              <button
                type="button"
                className={layout === "unified" ? "is-active" : ""}
                aria-label={t("unifiedDiff")}
                aria-pressed={layout === "unified"}
                title={t("unifiedDiff")}
                onClick={() => selectLayout("unified")}
              >
                <Rows3 size={14} />
              </button>
            </div>
            <button
              type="button"
              className={`toolbar-button ${wrapLines ? "is-active" : ""}`}
              aria-label={t("wrapLines")}
              aria-pressed={wrapLines}
              title={t("wrapLongLines")}
              onClick={() => selectWrapLines(!wrapLines)}
            >
              <WrapText size={14} />
            </button>
          </div>
        </header>

        <article className="diff-card" key={selected?.id ?? "empty"}>
          {!selected ? (
            <p className="binary-diff-note">{t("chooseChangedFile")}</p>
          ) : selected.render_mode !== "lazy" ? (
            <div className="binary-diff-note">
              <strong>{t("previewUnavailable")}</strong>
              <p>
                {selected.summary ??
                  t("sizeSummary", {
                    oldSize: formatBytes(selected.old_size),
                    newSize: formatBytes(selected.new_size),
                  })}
              </p>
            </div>
          ) : loadingId === selected.id ? (
            <div className="diff-loading" aria-live="polite">
              <span />
              <p>{t("loadingPreview")}</p>
            </div>
          ) : error ? (
            <div
              className="binary-diff-note is-error"
              role={error.kind === "integrity" ? "alert" : "status"}
            >
              <strong>
                {error.kind === "integrity"
                  ? t("diffIntegrityFailed")
                  : t("diffRenderFailed")}
              </strong>
              <p>{error.message}</p>
              <div className="diff-error-actions">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setDiagnosticsStatus(null);
                    setRetryToken((current) => current + 1);
                  }}
                >
                  <RefreshCw size={12} /> {t("retryDiffPreview")}
                </button>
                <button type="button" onClick={copyLoadDiagnostics}>
                  <ClipboardCopy size={12} /> {t("copyDiagnostics")}
                </button>
              </div>
              {diagnosticsStatus && (
                <span className="diff-diagnostics-status" role="status">
                  {diagnosticsStatus}
                </span>
              )}
            </div>
          ) : payload ? (
            <Virtualizer
              className="diff-virtualizer"
              contentClassName="diff-stack"
              config={{ overscrollSize: 600, intersectionObserverMargin: 400 }}
            >
              <MultiFileDiff
                oldFile={{
                  name: selected.path,
                  contents: payload.old_content,
                  cacheKey: selected.old_digest ?? `absent:${selected.path}`,
                }}
                newFile={{
                  name: selected.path,
                  contents: payload.new_content,
                  cacheKey: selected.new_digest ?? `absent:${selected.path}`,
                }}
                options={{
                  theme: diffTheme,
                  diffStyle: layout,
                  overflow: wrapLines ? "wrap" : "scroll",
                  disableFileHeader: true,
                  diffIndicators: "bars",
                  hunkSeparators: "line-info-basic",
                  lineDiffType: "word-alt",
                  collapsedContextThreshold: 6,
                  expansionLineCount: 20,
                }}
                style={diffThemeProperties}
                disableWorkerPool={!enableWorkerPool}
              />
            </Virtualizer>
          ) : null}
        </article>
      </section>
    </div>
  );

  return enableWorkerPool ? (
    <WorkerPoolContextProvider
      poolOptions={workerPoolOptions}
      highlighterOptions={highlighterOptions}
    >
      <WorkerRenderOptionsSync theme={diffTheme} />
      {browser}
    </WorkerPoolContextProvider>
  ) : (
    browser
  );
}

export default function DiffViewer({
  diffs,
  enableWorkerPool = import.meta.env.MODE !== "test",
  selectedId,
  onSelectedIdChange,
  layout,
  onLayoutChange,
  wrapLines,
  onWrapLinesChange,
}: {
  diffs: DashboardDiff[];
  enableWorkerPool?: boolean;
  selectedId?: string | null;
  onSelectedIdChange?: (id: string) => void;
  layout?: DashboardDiffLayout;
  onLayoutChange?: (layout: DashboardDiffLayout) => void;
  wrapLines?: boolean;
  onWrapLinesChange?: (wrap: boolean) => void;
}) {
  return (
    <DiffBrowser
      diffs={diffs}
      enableWorkerPool={enableWorkerPool}
      selectedId={selectedId}
      onSelectedIdChange={onSelectedIdChange}
      layout={layout}
      onLayoutChange={onLayoutChange}
      wrapLines={wrapLines}
      onWrapLinesChange={onWrapLinesChange}
    />
  );
}

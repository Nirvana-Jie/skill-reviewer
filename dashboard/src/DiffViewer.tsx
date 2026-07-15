import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Rows3,
  Search,
  WrapText,
} from "lucide-react";
import {
  MultiFileDiff,
  type WorkerInitializationRenderOptions,
  Virtualizer,
  WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import type { DashboardDiff, DashboardDiffPayload } from "./types";

type DiffLayout = "split" | "unified";

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
  theme: "pierre-light",
  lineDiffType: "word-alt",
  tokenizeMaxLineLength: 1600,
  maxLineDiffLength: 1600,
  preferredHighlighter: "shiki-js",
} as const satisfies WorkerInitializationRenderOptions;

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

function splitPath(path: string): { directory: string; name: string } {
  const separator = path.lastIndexOf("/");
  if (separator < 0) return { directory: "root", name: path };
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
    throw new Error("diff payload is not bound to its read-model metadata");
  }
  return payload;
}

function DiffBrowser({
  diffs,
  enableWorkerPool,
}: {
  diffs: DashboardDiff[];
  enableWorkerPool: boolean;
}) {
  const [selectedId, setSelectedId] = useState(diffs[0]?.id ?? "");
  const [payloads, setPayloads] = useState<Record<string, DashboardDiffPayload>>(
    {},
  );
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<DiffLayout>("split");
  const [wrapLines, setWrapLines] = useState(false);
  const highlighterLanguageKey = Array.from(
    new Set(diffs.map((diff) => languageForPath(diff.path))),
  )
    .sort()
    .join(",");
  const highlighterOptions = useMemo(
    () => ({
      ...baseHighlighterOptions,
      langs: (highlighterLanguageKey
        ? highlighterLanguageKey.split(",")
        : ["text"]) as SupportedLanguage[],
    }),
    [highlighterLanguageKey],
  );

  const visibleDiffs = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return diffs;
    return diffs.filter((diff) => diff.path.toLowerCase().includes(normalized));
  }, [diffs, query]);
  const selected = useMemo(
    () => visibleDiffs.find((diff) => diff.id === selectedId) ?? visibleDiffs[0],
    [selectedId, visibleDiffs],
  );
  const selectedIndex = selected
    ? visibleDiffs.findIndex((diff) => diff.id === selected.id)
    : -1;

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

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
        setError(cause instanceof Error ? cause.message : "unable to load diff");
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
  ]);

  const selectRelative = (offset: number) => {
    if (!visibleDiffs.length || selectedIndex < 0) return;
    const nextIndex =
      (selectedIndex + offset + visibleDiffs.length) % visibleDiffs.length;
    setSelectedId(visibleDiffs[nextIndex].id);
  };

  const payload = selectedPayload;
  const selectedPath = selected ? splitPath(selected.path) : null;
  const lineSummary = payload
    ? `${payload.old_content.split("\n").length} → ${payload.new_content.split("\n").length} lines`
    : null;

  const browser = (
    <div className="diff-browser">
      <aside className="diff-sidebar">
        <div className="diff-sidebar-heading">
          <strong>Changed files</strong>
          <span>{visibleDiffs.length} / {diffs.length}</span>
        </div>
        <label className="diff-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            aria-label="Filter changed files"
            placeholder="Filter files"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <nav className="diff-file-list" aria-label="Changed runtime files">
          {visibleDiffs.map((diff) => {
            const path = splitPath(diff.path);
            return (
              <button
                type="button"
                key={diff.id}
                className={diff.id === selected?.id ? "is-selected" : ""}
                aria-pressed={diff.id === selected?.id}
                aria-label={`Open diff ${diff.path}`}
                onClick={() => setSelectedId(diff.id)}
              >
                <span className={`change-mark change-${diff.status}`}>
                  {changeMark(diff.status)}
                </span>
                <span className="diff-file-copy">
                  <strong>{path.name}</strong>
                  <small>{path.directory}</small>
                </span>
                <small className="diff-size">
                  {formatBytes(diff.old_size)} → {formatBytes(diff.new_size)}
                </small>
              </button>
            );
          })}
          {visibleDiffs.length === 0 && (
            <p className="diff-no-results">No changed files match “{query}”.</p>
          )}
        </nav>
      </aside>

      <section className="diff-workbench" aria-label="Document diff">
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
                <span className="change-label">{selected.status}</span>
              </>
            ) : (
              <strong>No file selected</strong>
            )}
          </div>

          <div className="diff-toolbar-actions">
            {lineSummary && <span className="line-summary">{lineSummary}</span>}
            <div className="button-group" aria-label="File navigation">
              <button
                type="button"
                aria-label="Previous changed file"
                title="Previous file"
                disabled={visibleDiffs.length < 2}
                onClick={() => selectRelative(-1)}
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                aria-label="Next changed file"
                title="Next file"
                disabled={visibleDiffs.length < 2}
                onClick={() => selectRelative(1)}
              >
                <ChevronRight size={14} />
              </button>
            </div>
            <div className="button-group" aria-label="Diff layout">
              <button
                type="button"
                className={layout === "split" ? "is-active" : ""}
                aria-label="Split diff"
                aria-pressed={layout === "split"}
                title="Split diff"
                onClick={() => setLayout("split")}
              >
                <Columns2 size={14} />
              </button>
              <button
                type="button"
                className={layout === "unified" ? "is-active" : ""}
                aria-label="Unified diff"
                aria-pressed={layout === "unified"}
                title="Unified diff"
                onClick={() => setLayout("unified")}
              >
                <Rows3 size={14} />
              </button>
            </div>
            <button
              type="button"
              className={`toolbar-button ${wrapLines ? "is-active" : ""}`}
              aria-label="Wrap lines"
              aria-pressed={wrapLines}
              title="Wrap long lines"
              onClick={() => setWrapLines((current) => !current)}
            >
              <WrapText size={14} />
            </button>
          </div>
        </header>

        <article className="diff-card" key={selected?.id ?? "empty"}>
          {!selected ? (
            <p className="binary-diff-note">Choose a changed file to inspect.</p>
          ) : selected.render_mode !== "lazy" ? (
            <div className="binary-diff-note">
              <strong>Preview unavailable</strong>
              <p>
                {selected.summary ??
                  `Old ${formatBytes(selected.old_size)} · new ${formatBytes(selected.new_size)}`}
              </p>
            </div>
          ) : loadingId === selected.id ? (
            <div className="diff-loading" aria-live="polite">
              <span />
              <p>Loading bounded preview…</p>
            </div>
          ) : error ? (
            <div className="binary-diff-note is-error">
              <strong>Diff could not be rendered</strong>
              <p>{error}</p>
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
                  theme: "pierre-light",
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
      {browser}
    </WorkerPoolContextProvider>
  ) : (
    browser
  );
}

export default function DiffViewer({
  diffs,
  enableWorkerPool = import.meta.env.MODE !== "test",
}: {
  diffs: DashboardDiff[];
  enableWorkerPool?: boolean;
}) {
  return <DiffBrowser diffs={diffs} enableWorkerPool={enableWorkerPool} />;
}

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Locale = "en" | "zh-CN";
export type Theme = "light" | "dark";

export const preferenceStorageKeys = {
  locale: "skill-reviewer.locale",
  theme: "skill-reviewer.theme",
} as const;

const englishMessages = {
  pageTitle: "Skill Reviewer · Evidence Workbench",
  appTitle: "Skill Reviewer evidence workspace",
  brandEvidence: "Evidence",
  displayPreferences: "Display preferences",
  language: "Language",
  switchToEnglish: "Switch to English",
  switchToChinese: "Switch to Simplified Chinese",
  switchToDarkTheme: "Switch to dark theme",
  switchToLightTheme: "Switch to light theme",
  darkTheme: "Dark",
  lightTheme: "Light",
  openCommandPalette: "Go to evidence",
  commandPaletteTitle: "Go to evidence",
  commandPalettePlaceholder: "Search cases, evidence, files, and commands",
  closeCommandPalette: "Close command palette",
  commandsAvailable: "Available commands",
  noCommandsFound: "No matching destination",
  noCommandsHint: "Try a case ID, evidence label, file path, or action.",
  navigate: "navigate",
  runCommand: "open",
  close: "close",
  actionGroup: "Action",
  caseGroup: "Case",
  evidenceGroup: "Evidence",
  fileGroup: "File",
  copyViewLink: "Copy view link",
  downloadEvidenceJson: "Download projection JSON",
  viewLinkCopied: "View link copied",
  viewLinkCopyFailed: "View link could not be copied",
  evidenceJsonDownloaded: "Projection JSON download started",
  evidenceJsonDownloadFailed: "Projection JSON could not be downloaded",
  showEvidence: "Show evidence chain",
  showDiff: "Show document diff",
  showAttention: "Show cases needing attention",
  showAllCases: "Show all cases",
  useDarkTheme: "Use dark theme",
  useLightTheme: "Use light theme",
  useChinese: "Use Simplified Chinese",
  useEnglish: "Use English",
  live: "Live",
  connecting: "Connecting",
  stale: "Stale",
  readOnly: "read-only",
  behavioralGateState: "Behavioral gate state",
  releaseState: "Release state",
  runSummary: "Run summary",
  hardGates: "Hard gates",
  casesPassed: "Cases passed",
  round: "Round",
  evidence: "Evidence",
  inputsLocked: "Inputs locked",
  integrityPending: "Integrity pending",
  releaseEligible: "behaviorally release-eligible",
  releaseBlocked: "behavioral evidence blocked",
  runOverview: "Run overview",
  evaluationSuite: "Evaluation suite",
  cases: "Cases",
  split: "Split",
  searchCases: "Search cases",
  filterCases: "Filter cases",
  caseStatus: "Case status",
  attention: "Attention",
  noCasesMatch: "No cases match this view.",
  clearFilters: "Clear filters",
  caseResults: "{count} of {total} cases",
  all: "All",
  development: "Development",
  selection: "Selection",
  audit: "Audit",
  pairedRuns: "{count}× paired",
  noCasesInSplit: "No cases in this split.",
  evolution: "Evolution",
  continuitySummary: "continuity epoch {epoch} · {count} rejected",
  candidateLineage: "Candidate lineage",
  evidenceWorkspace: "Evidence workspace",
  canvasView: "Canvas view",
  diff: "Diff",
  retainedNodes: "{count} retained nodes",
  runtimeFilesChanged: "{count} runtime files changed",
  enterDiffFocus: "Enter diff focus mode",
  exitDiffFocus: "Exit diff focus mode",
  focusOnDiff: "Focus on diff",
  exitFocus: "Exit focus mode",
  immutableRunRecord: "Immutable run record",
  evidenceChain: "Evidence chain",
  evidenceChainDescription: "Follow the decision from run inputs to retained artifacts.",
  statusLegend: "Status legend",
  passed: "Passed",
  pending: "Pending",
  blocked: "Blocked",
  openEvidence: "Open evidence {label}",
  repeatMeta: "repeat {count}",
  retainedEvidenceRecord: "Retained evidence record",
  loadingDiffRenderer: "Loading diff renderer…",
  noRuntimeChanges: "No runtime changes",
  candidateMatchesRuntime: "The candidate matches the accepted runtime surface.",
  evidenceInspector: "Evidence inspector",
  inspector: "Inspector",
  retainedEvidenceDescription: "Retained evidence from the immutable run workspace.",
  evidenceId: "Evidence ID",
  arm: "Arm",
  repeat: "Repeat",
  assertion: "Assertion",
  artifactPath: "Artifact path",
  decisionArtifact: "Decision artifact",
  pairedArms: "Paired arms",
  missingObjectiveMetrics: "Missing objective metrics: {metrics}",
  assertionsSummary: "{passed}/{total} assertions · {rate}",
  bindingSummary: "{binding} binding · {forbidden} forbidden · {effects} side effects",
  semanticEvidence: "Semantic evidence",
  preference: "preference {value}",
  unresolved: "unresolved",
  provenance: "Provenance",
  subject: "Subject",
  baseline: "Baseline",
  plan: "Plan",
  profile: "Profile",
  target: "Target",
  harness: "Harness",
  holdout: "Holdout",
  controlAnchor: "Control anchor",
  none: "none",
  unknown: "unknown",
  public: "public",
  notUsed: "not used",
  notRecorded: "not recorded",
  selectEvidence: "Select an evidence record.",
  limitations: "Limitations",
  noLimitations: "No recorded limitations.",
  refreshEvery: "refresh {seconds}s",
  generatedAt: "Generated {time}",
  checkedAt: "Checked {time}",
  loadedAt: "Loaded {time}",
  attemptedAt: "Attempted {time}",
  generationTimeUnavailable: "Generation time unavailable",
  notChecked: "Not checked yet",
  pauseAutoRefresh: "Pause automatic refresh",
  resumeAutoRefresh: "Resume automatic refresh",
  refreshDashboard: "Refresh dashboard now",
  refreshing: "Refreshing evidence",
  autoRefreshOn: "Auto-refresh on",
  autoRefreshPaused: "Auto-refresh paused",
  lastRefreshFailed: "Last refresh failed",
  retainedJsonArtifacts: "retained JSON artifacts",
  connectingToEvidence: "Connecting to evidence",
  waitingForData: "Waiting for dashboard-data.json…",
  evidenceUnavailable: "Evidence is unavailable",
  retryConnection: "Retry connection",
  retryHelp: "Check that the read-only dashboard server is running, then retry.",
  runMismatchTitle: "This link targets a different run",
  runMismatchBody: "Requested {requested}; this server is presenting {current}.",
  openCurrentRun: "Open the current run",
  skipToEvidence: "Skip to evidence workspace",
  copyEvidenceReference: "Copy evidence reference",
  evidenceReference: "Skill Reviewer evidence reference",
  evidenceReferenceCopied: "Evidence reference copied",
  evidenceReferenceCopyFailed: "Evidence reference could not be copied",
  status: "Status",
  permalink: "Permalink",
  changedFiles: "Changed files",
  filterChangedFiles: "Filter changed files",
  filterFiles: "Filter files",
  changedRuntimeFiles: "Changed runtime files",
  openDiff: "Open diff {path}",
  noChangedFilesMatch: "No changed files match “{query}”.",
  documentDiff: "Document diff",
  noFileSelected: "No file selected",
  fileNavigation: "File navigation",
  previousChangedFile: "Previous changed file",
  previousFile: "Previous file",
  nextChangedFile: "Next changed file",
  nextFile: "Next file",
  diffLayout: "Diff layout",
  splitDiff: "Split diff",
  unifiedDiff: "Unified diff",
  wrapLines: "Wrap lines",
  wrapLongLines: "Wrap long lines",
  chooseChangedFile: "Choose a changed file to inspect.",
  previewUnavailable: "Preview unavailable",
  sizeSummary: "Old {oldSize} · new {newSize}",
  loadingPreview: "Loading bounded preview…",
  diffRenderFailed: "Diff could not be rendered",
  diffIntegrityFailed: "Diff integrity check failed",
  retryDiffPreview: "Retry preview",
  copyDiagnostics: "Copy diagnostics",
  diagnosticsCopied: "Diagnostics copied",
  diagnosticsCopyFailed: "Diagnostics could not be copied",
  lineSummary: "{oldLines} → {newLines} lines",
  rootDirectory: "root",
} as const;

type MessageKey = keyof typeof englishMessages;
type MessageValues = Record<string, string | number>;

const chineseMessages: Record<MessageKey, string> = {
  pageTitle: "Skill Reviewer · 证据工作台",
  appTitle: "Skill Reviewer 证据工作台",
  brandEvidence: "证据",
  displayPreferences: "显示偏好",
  language: "语言",
  switchToEnglish: "切换到英文",
  switchToChinese: "切换到中文",
  switchToDarkTheme: "切换到深色主题",
  switchToLightTheme: "切换到浅色主题",
  darkTheme: "深色",
  lightTheme: "浅色",
  openCommandPalette: "快速定位证据",
  commandPaletteTitle: "快速定位证据",
  commandPalettePlaceholder: "搜索场景、证据、文件或操作",
  closeCommandPalette: "关闭命令面板",
  commandsAvailable: "可用命令",
  noCommandsFound: "没有匹配的目标",
  noCommandsHint: "可尝试输入场景 ID、证据名称、文件路径或操作。",
  navigate: "导航",
  runCommand: "打开",
  close: "关闭",
  actionGroup: "操作",
  caseGroup: "场景",
  evidenceGroup: "证据",
  fileGroup: "文件",
  copyViewLink: "复制当前视图链接",
  downloadEvidenceJson: "下载投影 JSON",
  viewLinkCopied: "当前视图链接已复制",
  viewLinkCopyFailed: "无法复制当前视图链接",
  evidenceJsonDownloaded: "已开始下载投影 JSON",
  evidenceJsonDownloadFailed: "无法下载投影 JSON",
  showEvidence: "查看证据链",
  showDiff: "查看文档差异",
  showAttention: "查看需要关注的场景",
  showAllCases: "查看全部场景",
  useDarkTheme: "使用深色主题",
  useLightTheme: "使用浅色主题",
  useChinese: "使用简体中文",
  useEnglish: "使用英文",
  live: "实时",
  connecting: "连接中",
  stale: "已过期",
  readOnly: "只读",
  behavioralGateState: "行为门禁状态",
  releaseState: "发布状态",
  runSummary: "运行摘要",
  hardGates: "硬门禁",
  casesPassed: "通过场景",
  round: "轮次",
  evidence: "证据",
  inputsLocked: "输入已锁定",
  integrityPending: "完整性待确认",
  releaseEligible: "行为证据满足发布条件",
  releaseBlocked: "行为证据阻塞发布",
  runOverview: "运行概览",
  evaluationSuite: "评测套件",
  cases: "场景",
  split: "数据分层",
  searchCases: "搜索场景",
  filterCases: "筛选场景",
  caseStatus: "场景状态",
  attention: "需关注",
  noCasesMatch: "当前视图没有匹配的场景。",
  clearFilters: "清除筛选",
  caseResults: "显示 {count} / {total} 个场景",
  all: "全部",
  development: "开发",
  selection: "选拔",
  audit: "审计",
  pairedRuns: "{count}× 成对运行",
  noCasesInSplit: "当前分层没有场景。",
  evolution: "进化",
  continuitySummary: "连续性周期 {epoch} · 已拒绝 {count} 个候选",
  candidateLineage: "候选谱系",
  evidenceWorkspace: "证据工作区",
  canvasView: "画布视图",
  diff: "差异",
  retainedNodes: "保留 {count} 个证据节点",
  runtimeFilesChanged: "{count} 个运行时文件发生变化",
  enterDiffFocus: "进入差异专注模式",
  exitDiffFocus: "退出差异专注模式",
  focusOnDiff: "专注查看差异",
  exitFocus: "退出专注模式",
  immutableRunRecord: "不可变运行记录",
  evidenceChain: "证据链",
  evidenceChainDescription: "从运行输入一路检查到最终保留产物。",
  statusLegend: "状态图例",
  passed: "通过",
  pending: "待定",
  blocked: "阻塞",
  openEvidence: "打开证据 {label}",
  repeatMeta: "第 {count} 次",
  retainedEvidenceRecord: "保留的证据记录",
  loadingDiffRenderer: "正在加载差异渲染器…",
  noRuntimeChanges: "没有运行时变更",
  candidateMatchesRuntime: "候选与已接受的运行时表面一致。",
  evidenceInspector: "证据检查器",
  inspector: "检查器",
  retainedEvidenceDescription: "来自不可变运行工作区的保留证据。",
  evidenceId: "证据 ID",
  arm: "实验臂",
  repeat: "重复次数",
  assertion: "断言",
  artifactPath: "产物路径",
  decisionArtifact: "决策产物",
  pairedArms: "成对实验臂",
  missingObjectiveMetrics: "缺失目标指标：{metrics}",
  assertionsSummary: "{passed}/{total} 个断言 · {rate}",
  bindingSummary: "{binding} 个绑定错误 · {forbidden} 个禁止行为 · {effects} 个副作用",
  semanticEvidence: "语义证据",
  preference: "偏好 {value}",
  unresolved: "未决",
  provenance: "来源",
  subject: "评测对象",
  baseline: "基线",
  plan: "计划",
  profile: "执行配置",
  target: "执行目标",
  harness: "调度器",
  holdout: "留出集",
  controlAnchor: "控制锚点",
  none: "无",
  unknown: "未知",
  public: "公开",
  notUsed: "未使用",
  notRecorded: "未记录",
  selectEvidence: "请选择一条证据记录。",
  limitations: "局限",
  noLimitations: "没有记录到局限。",
  refreshEvery: "每 {seconds} 秒刷新",
  generatedAt: "生成于 {time}",
  checkedAt: "检查于 {time}",
  loadedAt: "成功读取于 {time}",
  attemptedAt: "尝试读取于 {time}",
  generationTimeUnavailable: "未记录生成时间",
  notChecked: "尚未检查",
  pauseAutoRefresh: "暂停自动刷新",
  resumeAutoRefresh: "恢复自动刷新",
  refreshDashboard: "立即刷新 Dashboard",
  refreshing: "正在刷新证据",
  autoRefreshOn: "自动刷新已开启",
  autoRefreshPaused: "自动刷新已暂停",
  lastRefreshFailed: "最近一次刷新失败",
  retainedJsonArtifacts: "保留的 JSON 产物",
  connectingToEvidence: "正在连接证据",
  waitingForData: "正在等待 dashboard-data.json…",
  evidenceUnavailable: "证据当前不可用",
  retryConnection: "重新连接",
  retryHelp: "请确认只读 Dashboard 服务已启动，然后重试。",
  runMismatchTitle: "此链接指向另一个运行",
  runMismatchBody: "链接请求 {requested}；当前服务展示的是 {current}。",
  openCurrentRun: "打开当前运行",
  skipToEvidence: "跳转到证据工作区",
  copyEvidenceReference: "复制证据引用",
  evidenceReference: "Skill Reviewer 证据引用",
  evidenceReferenceCopied: "证据引用已复制",
  evidenceReferenceCopyFailed: "无法复制证据引用",
  status: "状态",
  permalink: "永久链接",
  changedFiles: "变更文件",
  filterChangedFiles: "筛选变更文件",
  filterFiles: "筛选文件",
  changedRuntimeFiles: "发生变更的运行时文件",
  openDiff: "打开差异 {path}",
  noChangedFilesMatch: "没有变更文件匹配“{query}”。",
  documentDiff: "文档差异",
  noFileSelected: "未选择文件",
  fileNavigation: "文件导航",
  previousChangedFile: "上一个变更文件",
  previousFile: "上一个文件",
  nextChangedFile: "下一个变更文件",
  nextFile: "下一个文件",
  diffLayout: "差异布局",
  splitDiff: "左右对比",
  unifiedDiff: "合并对比",
  wrapLines: "自动换行",
  wrapLongLines: "长行自动换行",
  chooseChangedFile: "选择一个变更文件进行检查。",
  previewUnavailable: "无法预览",
  sizeSummary: "旧文件 {oldSize} · 新文件 {newSize}",
  loadingPreview: "正在加载受限预览…",
  diffRenderFailed: "无法渲染差异",
  diffIntegrityFailed: "差异完整性校验失败",
  retryDiffPreview: "重试预览",
  copyDiagnostics: "复制诊断信息",
  diagnosticsCopied: "诊断信息已复制",
  diagnosticsCopyFailed: "无法复制诊断信息",
  lineSummary: "{oldLines} → {newLines} 行",
  rootDirectory: "根目录",
};

const messages: Record<Locale, Record<MessageKey, string>> = {
  en: englishMessages,
  "zh-CN": chineseMessages,
};

const statusLabels: Record<string, string> = {
  passed: "通过",
  accepted: "已接受",
  "audit-passed": "审计通过",
  retained: "已保留",
  "regression-verified": "回归已验证",
  "behavior-verified": "行为已验证",
  failed: "失败",
  rejected: "已拒绝",
  regressed: "发生退化",
  "audit-failed": "审计失败",
  invalid: "无效",
  stale: "已过期",
  disagreement: "判断分歧",
  pending: "待定",
  "awaiting-audit": "等待审计",
  inconclusive: "证据不足",
  incomplete: "不完整",
  missing: "缺失",
  "no-change": "无有效改进",
  exhausted: "轮次耗尽",
  completed: "已完成",
};

const valueLabels: Record<string, string> = {
  development: "开发",
  selection: "选拔",
  audit: "审计",
  public: "公开",
  opaque: "隐藏",
  "public-calibration": "公开校准",
  "opaque-holdout": "隐藏留出集",
  old_skill: "旧 skill",
  without_skill: "无 skill",
  continue: "连续",
  reset: "重置",
  added: "新增",
  removed: "删除",
  modified: "修改",
  run: "运行",
  gate: "门禁",
  iteration: "迭代",
  case: "场景",
  assertion: "断言",
  artifact: "产物",
};

export function translate(
  locale: Locale,
  key: MessageKey,
  values: MessageValues = {},
): string {
  return messages[locale][key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values[name] ?? `{${name}}`),
  );
}

export function localizeStatus(locale: Locale, status: string): string {
  return locale === "zh-CN" ? (statusLabels[status] ?? status) : status;
}

export function localizeValue(locale: Locale, value: string): string {
  return locale === "zh-CN" ? (valueLabels[value] ?? value) : value;
}

interface UiPreferences {
  locale: Locale;
  theme: Theme;
  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
  t: (key: MessageKey, values?: MessageValues) => string;
}

const UiPreferencesContext = createContext<UiPreferences | null>(null);

function readStoredPreference<T extends string>(
  key: string,
  allowed: readonly T[],
): T | null {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : null;
  } catch {
    return null;
  }
}

function initialLocale(): Locale {
  return (
    readStoredPreference(preferenceStorageKeys.locale, ["en", "zh-CN"]) ??
    (window.navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en")
  );
}

function initialTheme(): Theme {
  return (
    readStoredPreference(preferenceStorageKeys.theme, ["light", "dark"]) ??
    (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
}

export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useLayoutEffect(() => {
    document.title = translate(locale, "pageTitle");
    document.documentElement.lang = locale;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(preferenceStorageKeys.locale, locale);
      window.localStorage.setItem(preferenceStorageKeys.theme, theme);
    } catch {
      // Preferences remain valid for the current session when storage is unavailable.
    }
  }, [locale, theme]);

  useEffect(() => {
    const syncPreference = (event: StorageEvent) => {
      if (event.key === preferenceStorageKeys.locale && ["en", "zh-CN"].includes(event.newValue ?? "")) {
        setLocale(event.newValue as Locale);
      }
      if (event.key === preferenceStorageKeys.theme && ["light", "dark"].includes(event.newValue ?? "")) {
        setTheme(event.newValue as Theme);
      }
    };
    window.addEventListener("storage", syncPreference);
    return () => window.removeEventListener("storage", syncPreference);
  }, []);

  const value = useMemo<UiPreferences>(
    () => ({
      locale,
      theme,
      setLocale,
      setTheme,
      t: (key, values) => translate(locale, key, values),
    }),
    [locale, theme],
  );

  return (
    <UiPreferencesContext.Provider value={value}>
      {children}
    </UiPreferencesContext.Provider>
  );
}

export function useUiPreferences(): UiPreferences {
  const preferences = useContext(UiPreferencesContext);
  if (!preferences) {
    throw new Error("useUiPreferences must be used inside UiPreferencesProvider");
  }
  return preferences;
}

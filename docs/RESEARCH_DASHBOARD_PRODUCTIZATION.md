# Skill Reviewer Evidence Dashboard 产品化调研与待办

> 调研日期：2026-07-16
> 范围：开发者与评测证据 Dashboard 的检索、导航、分享、新鲜度、导出、状态、可访问性和性能
> 证据策略：只引用产品官方文档、标准与本仓库一手代码/架构文档

## 结论摘要

成熟的 Evidence Dashboard 不等于加入更多执行按钮。对 `skill-reviewer` 来说，最有价值的产品化目标是让使用者能够：

1. 用一个 URL 精确恢复同一份证据上下文；
2. 快速找到失败、分歧、断言与变更文件；
3. 明确区分“证据生成时间”“浏览器最近成功读取时间”和“当前是否失联”；
4. 复制可复核的证据引用，而不是复制一张无法验证的截图；
5. 在键盘、屏幕阅读器和窄屏环境中完成同样的审阅流程；
6. 在大规模 case、evidence node 和 diff 下保持交互响应；
7. 始终保持只读边界，不在展示层执行 eval、批准发布或修改证据。

因此，下一阶段应先完成 **URL 深链接、统一筛选、新鲜度、复制/导出、完整状态、可访问性和性能门禁**；命令面板、本地 Saved Views 与开发者诊断面板随后建设；跨运行历史、全文索引、可信证据包与远程分享需要新的 projector/server contract。

这一排序与成熟工具的行为一致：GitHub 的筛选会同步到 URL 并可分享，Grafana 的链接保留当前变量上下文，GitHub Actions 日志可以搜索、下载并复制行级永久链接，Sentry 的详情页保留搜索上下文并支持复制事件引用。[GitHub Filters](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)；[Grafana dashboard links](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/manage-dashboard-links/)；[GitHub Actions logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)；[Sentry Issue Details](https://docs.sentry.io/product/issues/issue-details/)

## 调研方法与产品边界

本调研将外部产品作为交互先例，而不是直接复制它们的权限模型。仓库自己的事实边界优先：

- React 只消费一个 `skill-reviewer.dashboard-data` read model；正文 diff 通过 digest-bound sidecar 按需读取。[DashboardData 类型](../dashboard/src/types.ts)
- Dashboard 是 GET/HEAD-only 的展示面，POST 明确返回 `405 dashboard is read-only`。[本地 Dashboard server](../scripts/serve_skill_dashboard.py)
- 截图不是证据，plan、lock、grading、decision 与 retained artifacts 才是事实来源。[QUALITY_ARCHITECTURE.md](./QUALITY_ARCHITECTURE.md#dashboard-product-boundary)
- 显示语言、主题、筛选、布局和选中项属于 presentation state；它们不得写回或改写 evidence state。[QUALITY_ARCHITECTURE.md](./QUALITY_ARCHITECTURE.md#dashboard-product-boundary)

外部产品也区分读取和变更权限：GitHub Actions 下载 artifacts 只要求 read access，而 rerun、cancel 和手动触发 workflow 要求 write access。这支持本项目把“查看/复制/下载”与“执行/批准”隔离，而不是把二者混在同一个只读表面。[GitHub artifact download](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)；[GitHub workflow rerun](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)；[GitHub workflow cancel](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/cancel-a-workflow-run)

## 当前实现审计

| 维度 | 已有能力 | 关键缺口 | 依据 |
|---|---|---|---|
| 数据边界 | 单运行 read model、原子代切换、digest-bound diff sidecar、GET/HEAD-only | 没有跨运行索引或可信 evidence bundle route | [架构说明](./QUALITY_ARCHITECTURE.md#dashboard-product-boundary)、[server](../scripts/serve_skill_dashboard.py) |
| 导航 | split filter、case rail、evidence spine、diff 文件导航、focus mode | 选中 node、split、view、diff 文件与布局没有进入 URL，刷新/分享后丢失 | [App.tsx](../dashboard/src/App.tsx)、[DiffViewer.tsx](../dashboard/src/DiffViewer.tsx) |
| 检索 | changed-file path filter | 没有跨 case/evidence/diff 的统一检索、状态 facets、结果计数和 Clear all | [DiffViewer.tsx](../dashboard/src/DiffViewer.tsx) |
| 新鲜度 | 按 `refresh_interval_ms` 轮询，区分 connecting/live/stale | UI 不显示 last success/last attempt；无手动刷新；`generated_at` 虽在类型中存在，但 projector 当前写入 `null` | [App.tsx](../dashboard/src/App.tsx)、[types.ts](../dashboard/src/types.ts)、[skill_eval_runtime.py](../scripts/skill_eval_runtime.py) |
| 分享/导出 | 浏览器可直接访问 read model 和 sidecar | 没有 Copy permalink、Copy evidence reference、下载当前 projection 的显式入口 | [server](../scripts/serve_skill_dashboard.py) |
| 状态 | 初次 loading、部分 diff error/empty、连接状态 | 未完整区分 no-data、no-match、stale-with-data、invalid-contract、sidecar-integrity-error | [App.tsx](../dashboard/src/App.tsx)、[DiffViewer.tsx](../dashboard/src/DiffViewer.tsx) |
| 可访问性 | 多数按钮有可访问名称，locale 更新 document language | 复合列表没有统一方向键模型；无 skip link、命令帮助和完整 focus restoration；动态刷新反馈有限 | [App.tsx](../dashboard/src/App.tsx) |
| 性能 | Pierre virtualization、worker pool、render cache、按选中文件加载 sidecar | case/evidence 列表仍是无界 DOM；缺少大型 fixture 与交互延迟门禁 | [DiffViewer.tsx](../dashboard/src/DiffViewer.tsx)、[Pierre Diffs](https://diffs.com/docs) |

## 产品原则

### 1. URL 是可复现的展示状态，不是证据载体

URL 应保存稳定 ID 与有限枚举，让接收者恢复同一筛选、选中项和 diff 视图；不能把绝对路径、raw prompt、opaque holdout 内容或完整 artifact body 放入 URL。GitHub 会在筛选/排序时更新 URL，Primer 也要求搜索 query 持久化到 URL，以支持刷新与分享；Grafana 的 dashboard link 会携带当前变量和时间上下文。[GitHub Filters](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)；[Primer Search](https://primer.style/product/scenario-patterns/search/)；[Grafana dashboard links](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/manage-dashboard-links/)

### 2. 搜索只检索已经授权投影的数据

当前前端可以确定性索引 case、spine node 与 diff metadata；它不应为了“全文搜索”主动抓取所有 sidecar，更不能索引 opaque holdout prompt/fixture。Primer 区分“搜索未在视图中的资源”和“过滤当前集合”，并要求 loading、no-result、invalid-query 与 result count 有明确反馈。[Primer Search](https://primer.style/product/scenario-patterns/search/)

### 3. 传输新鲜度不冒充证据生成时间

“刚刚成功 GET”只表示浏览器读取成功，不证明 evidence 刚刚生成。UI 必须分开显示 transport freshness、projection freshness 和 integrity。Grafana 把手动刷新与自动刷新明确呈现，并在手动刷新时取消 pending request；W3C 要求不夺取焦点的等待、成功、结果和错误状态可被辅助技术获知。[Grafana use dashboards](https://grafana.com/docs/grafana/latest/visualizations/dashboards/use-dashboards/)；[WCAG Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)

### 4. 导出物必须标明是否为 canonical evidence

复制 URL、ID、digest 和 Markdown 引用是展示层操作；浏览器生成的 filtered summary 必须标为 `Derived view`。完整 evidence bundle 只有在后端按 allowlist 打包、绑定 manifest/digest 并验证权限后，才能称为可信证据包。Grafana 的 inspector 区分 raw data、JSON、request/response 和 error；GitHub Actions 将 retained artifacts 作为有权限约束的下载对象。[Grafana panel inspector](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/panel-inspector/)；[GitHub workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)

### 5. 可访问性与性能是发布门禁，不是尾部优化

所有功能必须可由键盘操作，焦点可见且不被遮挡，复合组件使用可预测的方向键模型，异步状态用克制的 live region 通知。长列表与大 diff 必须保持有限 DOM 和可响应的主线程。[WCAG 2.2](https://www.w3.org/TR/WCAG22/)；[WAI-ARIA Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)；[Pierre Diffs](https://diffs.com/docs)；[INP](https://web.dev/articles/inp)

## 优先级与 Todo List

优先级定义：

- **Must**：下一个产品化里程碑必须完成；当前 read model 已足够，除非条目明确指出 projector 配合。
- **Should**：Must 稳定后完成，主要提升高频开发者效率。
- **Later**：必须先扩展 projector/server/auth contract，不能只靠前端伪造。

### Must

| ID | Todo | 落地层 | 验收标准 | 官方依据 |
|---|---|---|---|---|
| M0 | 固化只读 action allowlist | 前端 + server tests | UI 只出现 navigate/filter/copy/download/reload/display actions；无 execute/rerun/approve/edit；非 GET/HEAD 仍失败 | [GitHub read artifact](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)、[GitHub write rerun](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) |
| M1 | URL 深链接与浏览器历史 | 前端 | 分享 URL 可恢复 run guard、split、query、node、view、diff、layout、wrap、focus；Back/Forward 可重放；非法参数安全回退；run mismatch 阻塞提示 | [GitHub Filters](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)、[Grafana links](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/manage-dashboard-links/)、[HTML History API](https://html.spec.whatwg.org/multipage/nav-history-apis.html) |
| M2 | 全局检索与结构化 facets | 前端 | 可按 case/node/diff 的 ID、label、purpose、path、status 检索；提供 split/status/kind/regressed/disagreement/binary 快捷筛选；显示 `x / y`、Clear all 和命名 query 的 no-result | [Primer Search](https://primer.style/product/scenario-patterns/search/)、[Sentry Issue Details](https://docs.sentry.io/product/issues/issue-details/) |
| M3 | 明确的新鲜度与手动 Reload | 前端；projector 补 `generated_at` | 显示 evidence generated time（若未知明确写 unknown）、last successful load、连接状态与下次轮询；Reload 会取消旧请求；失败后保留最后一份已验证 read model | [Grafana refresh](https://grafana.com/docs/grafana/latest/visualizations/dashboards/use-dashboards/)、[Primer Loading](https://primer.style/product/ui-patterns/loading/) |
| M4 | Copy permalink 与 evidence reference | 前端 | 一键复制当前 URL；可复制包含 run/node/file/status/digest 的 Markdown 引用；成功/失败有 status message；Clipboard 不可用时提供可选择文本 fallback | [GitHub Actions log permalink](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)、[Sentry Issue Details](https://docs.sentry.io/product/issues/issue-details/)、[W3C Clipboard API](https://www.w3.org/TR/clipboard-apis/) |
| M5 | 完整 loading/error/empty taxonomy | 前端 | initial unavailable、stale with data、no evidence、no filter match、invalid contract、sidecar unavailable/integrity error、binary/oversize summary 分别呈现；错误不冒充空数据；提供 Retry/Clear filters/Copy diagnostics 等正确动作 | [Primer Degraded Experiences](https://primer.style/product/ui-patterns/degraded-experiences/)、[Primer Blankslate](https://primer.style/product/components/blankslate/guidelines/)、[Primer Banner](https://primer.style/product/components/banner/guidelines/) |
| M6 | 无障碍基线与复合键盘导航 | 前端 | 有 skip-to-content；landmark/heading 顺序正确；case/spine/file 列表支持方向键、Home/End 与 Enter；focus 和 selected 可区分；动态结果/刷新/复制用克制的 `role=status`；全程无 keyboard trap | [WCAG 2.2](https://www.w3.org/TR/WCAG22/)、[ARIA Tree View](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)、[ARIA Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) |
| M7 | 大型 fixture 与交互性能门禁 | Vitest/browser tests | 构造大规模 case/spine/diff fixture；验证 diff DOM 有界、只加载选中 sidecar、搜索和文件切换不长时间阻塞；记录关键交互延迟并以 200ms 为体验目标 | [Pierre Diffs](https://diffs.com/docs)、[web.dev INP](https://web.dev/articles/inp)、[TanStack Virtual](https://tanstack.com/virtual/v3/docs) |

### Should

| ID | Todo | 落地层 | 验收标准 | 官方依据 |
|---|---|---|---|---|
| S1 | 只读命令面板 | 前端 | 有可见入口和 `Mod+K`；仅包含跳转、切换 view/theme/locale/layout、reload、copy/export；方向键/Enter/Escape 完整；dialog 打开时 trap focus，关闭后还焦；快捷键可关闭或替换 | [GitHub Command Palette](https://docs.github.com/en/get-started/accessibility/github-command-palette)、[VS Code Command Palette](https://code.visualstudio.com/docs/editing/userinterface)、[ARIA Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) |
| S2 | 本地 Saved Views 与 recent queries | 前端/localStorage | 可命名保存 query/facets/view，不保存 evidence body；可删除、重置；不写入 run artifacts；分享仍以 URL 为准 | [GitHub saved views](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/viewing-all-of-your-issues-and-pull-requests) |
| S3 | Read-model diagnostics inspector | 前端 | 展示 contract、data URL、run ID、projection time、last load、payload/diff digest、transport error；可复制原始 projection 或 diagnostics；明确标注 read-only/derived | [Grafana panel inspector](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/panel-inspector/) |
| S4 | case/spine 长列表按测量结果虚拟化 | 前端 | M7 fixture 证明无界 DOM 或交互超预算时，引入 headless virtualizer；焦点项始终可滚入视图，`aria-posinset`/`aria-setsize` 与总数一致 | [TanStack Virtual](https://tanstack.com/virtual/v3/docs)、[ARIA Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) |
| S5 | 自动刷新控制与后台节流 | 前端 | 支持 pause/resume；页面重新可见时立即验证；切换 generation 不重置仍有效的 selection；刷新状态可被辅助技术感知但不反复打断 | [Grafana refresh](https://grafana.com/docs/grafana/latest/visualizations/dashboards/use-dashboards/)、[WCAG Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) |
| S6 | 可调整 pane 与 density | 前端/localStorage | 宽度/密度只作为个人显示偏好保存；提供 Reset layout；窄屏与 200% zoom 不产生必须双向滚动的主流程 | [Grafana dashboard view preferences](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/create-dashboard/)、[Primer Banner accessibility](https://primer.style/product/components/banner/accessibility/) |

GitHub Command Palette 目前仍标为 public preview，因此它是可参考的高频效率模式，不应阻塞更基础的 URL、筛选、新鲜度和状态完整性。VS Code 的稳定 Command Palette 则证明统一跳转/搜索入口对开发者工具的价值。[GitHub Command Palette](https://docs.github.com/en/get-started/accessibility/github-command-palette)；[VS Code UI](https://code.visualstudio.com/docs/editing/userinterface)

### Later：需要 projector/server contract

| ID | Todo | 所需契约 | 为什么不能只做前端 | 官方依据 |
|---|---|---|---|---|
| L1 | 可验证的 projection generation identity | `projected_at`、generation ID 或响应 ETag/digest | 浏览器 last load time 不能证明 evidence 生成时间；当前 projector 写入 `generated_at: null` | [Grafana refresh](https://grafana.com/docs/grafana/latest/visualizations/dashboards/use-dashboards/)、[当前 projector](../scripts/skill_eval_runtime.py) |
| L2 | 历史运行索引与永久 run URL | allow-listed run index、稳定 run route、retention metadata | 当前 read model 只含一个 run，前端无法发现或证明其它 workspace | [GitHub workflow run history](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/viewing-workflow-run-history) |
| L3 | artifact 全文搜索 | 后端只读索引、字段/visibility policy、结果到 digest-bound route 的映射 | 前端全量抓取 sidecar 会破坏按需加载并可能扩大 opaque evidence 暴露面 | [GitHub Actions log search](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)、[Sentry issue query API](https://docs.sentry.io/api/events/list-an-organizations-issues/) |
| L4 | 可信 evidence bundle 下载 | allow-list manifest、每项 digest/size、bundle digest、权限与 retention | 浏览器生成 ZIP 不能证明来源完整性，也不能安全读取未投影 artifact | [GitHub artifact download](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)、[GitHub artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts) |
| L5 | 跨运行比较与趋势 | 多 run read model、同一 metric/contract 的可比性声明、baseline identity | 单 run summary 无法可靠推导趋势；不能把不同 profile/eval scope 直接拼接 | [Grafana dashboards](https://grafana.com/docs/grafana/latest/visualizations/dashboards/)、[本仓库 evidence boundary](./QUALITY_ARCHITECTURE.md#dashboard-product-boundary) |
| L6 | 远程分享与权限 | 身份认证、viewer authorization、审计日志、内容寻址 URL | localhost permalink 只复现本机上下文；分享不能绕过 evidence 权限 | [Grafana sharing authorization](https://grafana.com/docs/grafana/latest/dashboards/share-dashboards-panels/)、[GitHub artifact read access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts) |
| L7 | 协作批注 overlay | 独立写服务、author/time/source、immutable evidence pointer | 批注是新的可变数据，不属于 canonical evidence，也不能写入当前 GET-only workspace | [Sentry Issue Details](https://docs.sentry.io/product/issues/issue-details/)、[本地 server](../scripts/serve_skill_dashboard.py) |

## 推荐 URL 状态模型

建议使用 query parameters，而不是把状态只放进 React memory：

```text
?run=<run-id>
&split=selection
&q=status%3Afailed
&node=<spine-node-id>
&view=diff
&diff=<dashboard-diff-id>
&layout=split
&wrap=1
&focus=1
```

| 参数 | 数据来源 | 行为 |
|---|---|---|
| `run` | `data.run.id` | 身份 guard；不匹配时显示阻塞错误，不能静默打开另一运行 |
| `split` | known enum | `all/development/selection/audit`，非法值回退 `all` |
| `q` | 用户输入 | 只过滤当前已授权 read model；长度设上限；复制链接时明确包含当前 query |
| `node` | `spine[].id` | 恢复 Inspector 与 Evidence Spine selection |
| `view` | known enum | `evidence/diff` |
| `diff` | `diffs[].id` | 恢复选中文件；不用绝对 path 作为身份 |
| `layout` | known enum | `split/unified` |
| `wrap`、`focus` | boolean | 恢复文档展示状态 |

主题与 locale 继续保存在 localStorage，不默认写入分享 URL；接收者的可访问性/显示偏好应优先。绝对本地路径、raw prompt、source body、holdout fixture 和 bearer/token 永远不进入 URL。

连续输入 query 时用 `history.replaceState`，避免每个按键制造一条历史；用户真正切换 split、node、diff 或 view 时用 `pushState`，使 Back/Forward 能重放审阅路径。HTML 标准定义了 `pushState`/`replaceState` 的同文档历史行为，GitHub 也将 filter/sort 状态反映到 URL。[HTML History API](https://html.spec.whatwg.org/multipage/nav-history-apis.html)；[GitHub Filters](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)

## 搜索与筛选设计

### 当前 read model 可直接支持

- case：`id`、`purpose`、`split`、`determinism`、`holdout_visibility`、`status`、`regressed`、`direction_disagreement`、`missing_objective_metrics`；
- spine：`id`、`kind`、`label`、`status`、`detail`、`split`、`arm`、`assertion_type`、`path`、`artifact`；
- diff：`id`、`path`、`status`、`binary`、`render_mode`、digest/size；
- run：ID、status、verification level、evidence scope、release eligibility。

建议提供一个始终可见的全局 filter bar，结果分组为 Cases / Evidence / Changed files，并支持 `status:`、`split:`、`kind:`、`file:` 等确定性 qualifier。失败、uncertain、regressed、direction disagreement 和 hard-gate failure 应提供一键 chips。Primer 要求搜索输入有明确 scope、clear action、named no-results、loading/invalid feedback 和 polite result-count announcement；GitHub 与 Sentry 均用 qualifier/facet 缩小大型结果集合。[Primer Search](https://primer.style/product/scenario-patterns/search/)；[GitHub Filters](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)；[Sentry Issue Details](https://docs.sentry.io/product/issues/issue-details/)

全局结果选中后跳转到已有 pane，不生成新的解释或 AI 摘要。语义搜索、向量检索与自动“相似失败”不应进入 Must：它们会引入不可验证排序和额外数据处理面，当前确定性字段已经覆盖核心定位任务。

### 需要后端的搜索

搜索未加载的 sidecar 正文、历史运行和非投影 artifacts 必须通过受限后端索引实现。索引需继承 evidence visibility，返回 stable artifact ID/digest/route，不返回未经授权的正文片段。前端不得通过并发抓取所有 lazy sidecar 模拟全文索引。

## 新鲜度与刷新模型

UI 应同时呈现三层状态：

| 层次 | 当前可实现 | 推荐显示 |
|---|---|---|
| Transport | 浏览器记录 fetch attempt/success/error | `Loaded 14:32:10`、`Reconnecting`、`Last successful load 18s ago`、Reload |
| Projection | read model 的 `generated_at` | 有值时显示 `Evidence projected at ...`；当前为 null 时明确显示 `Projection time unavailable` |
| Integrity | `run.integrity`、sidecar digest 校验结果 | `inputs locked / verified`、selected sidecar verified/failed |

手动 Reload 应复用同一个 fetch pipeline、AbortController 取消旧请求，并只在新 read model 通过 contract validation 后替换。若更新失败但已有数据，保留旧证据并显示 non-blocking stale banner；若首次加载失败，显示 page-level error。Grafana 的手动 refresh 会取消 pending request；Primer 要求失败状态说明原因并给出可行的 retry，而不是让 loading 静默消失。[Grafana refresh](https://grafana.com/docs/grafana/latest/visualizations/dashboards/use-dashboards/)；[Primer Loading](https://primer.style/product/ui-patterns/loading/)；[Primer Degraded Experiences](https://primer.style/product/ui-patterns/degraded-experiences/)

自动轮询是否保持 3 秒可以由当前 contract 决定，但必须允许 pause，并在页面重新可见时立即验证一次。新 generation 到达时不能把用户选中的仍有效 node/file 重置；真正可验证的 generation change notification 需要 L1 的 generation identity。

## 复制、导出与开发者诊断

### 前端直接落地

1. **Copy permalink**：当前 URL，包含展示上下文；
2. **Copy evidence reference**：稳定 Markdown，例如 `run / node / status / artifact / digest / permalink`；
3. **Download projection JSON**：下载浏览器已经验证的 `dashboard-data.json`，文件名带 run ID，并标注 `Dashboard projection — not canonical evidence bundle`；
4. **Copy diagnostics**：contract、run ID、data URL、projection time、last success、connection error、selected sidecar ID/digest。

Clipboard 操作必须由显式用户动作触发，并处理 `NotAllowedError`；fallback 是显示可选择文本，而不是静默失败。W3C Clipboard API 将异步剪贴板视为受权限控制的 powerful feature。[W3C Clipboard API](https://www.w3.org/TR/clipboard-apis/)

GitHub Actions 支持日志搜索、下载和行级 permalink，Sentry 支持复制 event ID、JSON 与 Markdown 分享，Grafana inspector 支持查看/复制 JSON、request/response 与 error。这些都是只读证据工作台的高价值先例。[GitHub Actions logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)；[Sentry Issue Details](https://docs.sentry.io/product/issues/issue-details/)；[Grafana panel inspector](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/panel-inspector/)

### 不应由浏览器伪造

完整 run archive、原始 inputs、grader records 与 retained artifacts 的 bundle 必须由后端从 allow-listed immutable workspace 生成，并附 manifest 和 digest。Filtered summary、打印页、PNG 或 PDF 可以作为沟通材料，但必须明确标为 derived presentation，不能作为发布证据。

## Error / Empty / Loading 状态规范

| 状态 | 表现 | 可用动作 |
|---|---|---|
| Initial loading | 保留应用框架与区域 skeleton，说明正在读取哪一份数据 | 无需重复点击；超时后转 error |
| Initial unavailable | page-level critical message，显示数据 URL 与可读错误 | Retry、Copy diagnostics |
| Stale with last-good data | 不覆盖内容的 warning banner，显示 last success age | Reload、Copy diagnostics |
| Invalid contract/integrity | 阻塞渲染，不能以空态继续 | Copy diagnostics |
| Valid run with zero evidence | 真正的 Blankslate，解释运行尚无证据 | 查看 run metadata |
| Filter no-match | 命名 query/facets，显示 `0 / total` | Clear filters、编辑 query |
| No source diff | 正常 no-change state，不使用 error tone | 回到 evidence view |
| Binary/oversize diff | 显示 digest、size 与 display limit | 只有存在受信 artifact route 时才 Download |
| Sidecar unavailable | 只替换当前 diff pane，保留 rail/inspector | Retry file、Copy diagnostics |
| Sidecar digest mismatch | integrity error，不渲染正文 | Copy diagnostics；禁止 fallback 到 mutable path |

Primer 明确要求 degraded content 不能被伪装成“用户没有数据”，区域不可用时应保留页面的主要体验并就地说明问题；Blankslate 应解释为什么内容缺失；loading failure 应说明下一步并在可重试时提供 Retry。[Primer Degraded Experiences](https://primer.style/product/ui-patterns/degraded-experiences/)；[Primer Blankslate](https://primer.style/product/components/blankslate/guidelines/)；[Primer Loading](https://primer.style/product/ui-patterns/loading/)

## 键盘与可访问性规范

### 页面级

- 添加 skip-to-content，使用清晰的 `header/nav/main/aside/footer` landmarks；
- 保证 DOM/reading/focus order 与视觉三栏顺序一致；
- 所有交互有 `:focus-visible`，焦点不被 sticky chrome/footer 遮挡；
- status 不只依赖颜色，继续保留文字与图标；
- 320 CSS px 宽度和 200% zoom 下主流程可完成。

WCAG 2.2 要求全功能键盘可达、无 trap、focus visible/not obscured，并限制全局单字符快捷键；Primer 也要求 banner 在 320px/200% zoom 下可读、交互目标至少 24×24 CSS px。[WCAG 2.2](https://www.w3.org/TR/WCAG22/)；[Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible)；[Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum)；[Primer Banner accessibility](https://primer.style/product/components/banner/accessibility/)

### 复合导航

- Case、Evidence Spine 与 changed-file 列表各只占一个主 Tab stop；
- Up/Down 移动 focus，Home/End 到首尾，Enter 激活；
- focus ring 与 selected style 必须视觉独立；
- 对会触发网络加载的 changed-file list，方向键只移动 focus，Enter 才加载，避免 selection-follows-focus 连续请求；
- Evidence Spine 若声明 `tree/treeitem`，应提供正确的 `aria-level`、`aria-posinset`、`aria-setsize`；
- Evidence/Diff tab 使用 tablist 的 Left/Right/Enter 模式；view controls 使用 toolbar/toggle button 语义。

WAI-ARIA Tree View 规定 Up/Down、Home/End、Enter 和 type-ahead 行为；Keyboard Interface 指南要求区分 focus 与 selection，并指出 selection-follows-focus 在需要网络请求时会显著损害体验。[ARIA Tree View](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)；[ARIA Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)；[ARIA Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)；[ARIA Toolbar](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/)

### 异步通知

Reload、copy、搜索结果数和连接状态用 `role=status`/polite live region；integrity failure 使用 alert，但不能让每次轮询都重复播报。WCAG 明确把 waiting、progress、results 和 errors 视为应程序化暴露的 status messages，同时提醒 live region 不应过度“chatty”。[WCAG Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)

### 命令面板

命令面板只收录 read-only commands，并保留所有命令的可见按钮。`Mod+K` 打开，方向键选择，Enter 执行，Escape 关闭；打开时 focus 进入 dialog，Tab/Shift+Tab 留在 dialog，关闭后还给触发按钮。快捷键冲突必须可调整或关闭。GitHub 官方文档采用 `Ctrl/Command+K`、scope-aware suggestions、recent resources 与 Escape，并明确提供 shortcut customization；WAI-ARIA Dialog 规定 focus containment 和 restoration。[GitHub Command Palette](https://docs.github.com/en/get-started/accessibility/github-command-palette)；[ARIA Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)

## 性能策略

当前 diff 路径已经采用 Pierre 官方建议的大型 diff 组合：virtualization、worker pool、cacheKey 和按需 sidecar。无需为了“看起来更工程化”替换为编辑器组件；只有未来需要把所有文件放进同一连续滚动 surface 时，才需要重新评估 Pierre 的 CodeView 或其它 renderer。[Pierre Diffs](https://diffs.com/docs)

下一步性能工作应聚焦尚未有界的列表和可测门禁：

1. 建立大型 synthetic fixture，例如 2,000 cases、20,000 spine nodes、2,000 diff metadata；这些数字是项目 stress guardrail，不是外部论文结论；
2. 统计初始 DOM node 数、filter 后 node 数、选中文件 fetch 次数、worker fallback 和关键交互 latency；
3. 搜索索引从 read model 一次构建并 memoize，不在每次 render 重建；
4. 只有 stress test 证明 case/spine DOM 或交互超预算时，再引入 TanStack Virtual 等 headless virtualizer；
5. virtualization 必须保留总数、位置与键盘 focus，不得以性能为由破坏可访问性；
6. 大文本全文搜索不得通过 eager sidecar fetch 实现。

web.dev 将 INP 200ms 或更低作为良好响应目标，并建议减少大 DOM、把重计算移出主线程；TanStack Virtual 专门用于长列表 virtualization；Pierre 建议大型 diff 同时使用 virtualization 与 worker pool。[web.dev INP](https://web.dev/articles/inp)；[Optimize INP](https://web.dev/articles/optimize-inp)；[TanStack Virtual](https://tanstack.com/virtual/v3/docs)；[Pierre Diffs](https://diffs.com/docs)

## 不应在当前 Dashboard 中实现的能力

| 禁止/暂缓能力 | 原因 | 正确归属 |
|---|---|---|
| Run eval / retry agent / start evolution | 会执行外部工作并改变状态，超出 GET-only presentation authority | lead agent/runtime command surface |
| Approve/reject release | human authorization 不能被展示层按钮隐式替代 | 独立授权 workflow，写入受控 journal |
| Edit `evals.json`、assertions、snapshots 或 skill files | eval 与 evidence 在运行中不可变；UI 编辑会破坏证据边界 | 用户确认后的新 run/change workflow |
| 把评论/批注混入 evidence JSON | 可变协作数据会冒充 retained evidence | 单独 overlay service，绑定 immutable evidence ID |
| 任意 host filesystem browser/download | 破坏 allowlist、digest 和 symlink/path 边界 | projector 注册的只读 artifact routes |
| 把 opaque holdout prompt/fixture 放进搜索索引 | 扩大隐藏评测暴露面，污染未来优化 | backend visibility policy，默认不投影 |
| 用 screenshot/PDF 作为 release evidence | 无法证明输入、digest、decision chain 与内容完整性 | 只作 derived communication artifact |
| 用 service worker 长期缓存 read model 并显示为 live | 与 `no-store` 和实时完整性检查冲突，可能把旧证据伪装成当前状态 | 若未来需要离线模式，使用签名 snapshot 并永久显示 Offline |
| 前端重新计算 release verdict | presentation 不能覆盖 grader/decision authority | runtime/projector 输出 canonical verdict |

GitHub 把 artifact reading 与 rerun/cancel 的 write permissions 分开，Grafana 的外部 shared dashboard 明确是 read-only 且只能执行预先存储的查询；这支持保留一个窄而清晰的 Evidence Surface，而不是在同一 UI 混入写操作。[GitHub artifact download](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)；[GitHub workflow rerun](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)；[Grafana shared dashboards](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/shared-dashboards/)

## 前端与后端职责矩阵

| 能力 | 当前 read model 可直接实现 | 需要 projector/server contract |
|---|---:|---:|
| URL 深链接、Back/Forward、run guard | ✓ | — |
| case/spine/diff metadata 搜索与 facets | ✓ | — |
| sidecar/历史 artifact 全文搜索 | — | ✓ |
| Copy permalink/reference/diagnostics | ✓ | — |
| 下载当前 projection JSON（明确 derived） | ✓ | — |
| 下载可信完整 evidence bundle | — | ✓ |
| last attempt / last successful load / Reload | ✓ | — |
| authoritative projected-at / generation digest | 部分（字段已有但当前为空） | ✓ |
| stale/error/no-match/invalid-contract 状态 | ✓ | — |
| keyboard、landmark、live region、command palette | ✓ | — |
| 本地 Saved Views、recent queries、pane preferences | ✓ | — |
| 历史 run picker / cross-run comparison | — | ✓ |
| secure remote permalink / viewer authorization | — | ✓ |
| collaboration annotations | — | ✓（且必须独立于 evidence） |

## 验证策略

遵循仓库约束，系统性前端测试统一使用 Vitest；不新增独立 JS 测试脚本。

### Vitest 单元/组件测试

- URL parser/serializer 的 round-trip、非法 enum、缺失 ID、run mismatch、Back/Forward；
- qualifier parser、组合 facets、Unicode/case folding、clear all、result count；
- manual reload 的 AbortController、last-good preservation、stale/error transitions；
- clipboard success/denied/fallback 与 live-region message；
- 每类 empty/error state 的正确 action，确保 unavailable 不渲染成 empty；
- case/spine/file roving focus、Home/End/Enter、focus restoration；
- locale/theme 与 URL state 不互相覆盖；
- mutation commands 不存在，非 GET/HEAD server path 继续失败。

### 浏览器级测试

- 粘贴 permalink 后恢复完整视图；Back/Forward 重放 selection；
- 仅键盘完成 filter → case → evidence → diff → copy link；
- 320px、200% zoom、中英文、明暗主题下无阻塞操作或被遮挡 focus；
- screen reader smoke test 验证搜索结果、reload、stale、copy 与 integrity error 不漏报也不重复轰炸；
- 大型 fixture 下 diff DOM 有界、只请求选中 sidecar、关键交互朝 200ms 目标收敛；
- sidecar 404、oversize、binary、digest mismatch 不泄漏正文且不破坏其它 panes。

WCAG 明确要求 keyboard、focus order、focus visible/not obscured 与 status messages；Pierre 和 web.dev 分别给出大型 diff 与交互响应的验证方向。[WCAG 2.2](https://www.w3.org/TR/WCAG22/)；[WCAG Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)；[Pierre Diffs](https://diffs.com/docs)；[web.dev INP](https://web.dev/articles/inp)

## 推荐实施顺序

1. **Navigation foundation**：建立统一 `DashboardViewState`、URL parser/serializer、run guard 与 Back/Forward；
2. **Findability**：在同一个 view state 上实现全局 filter、facets、result count 与 no-match；
3. **Trust feedback**：重构 fetch state，加入 manual Reload、last success、stale/invalid taxonomy；projector 同步填充 `generated_at`；
4. **Shareability**：Copy permalink、evidence reference、projection JSON 与 diagnostics；
5. **Accessible interaction**：landmarks、skip link、roving focus、tabs/toolbar semantics、live region；
6. **Scale gate**：大型 fixture、interaction budget；只有失败时才给 case/spine 上 virtualizer；
7. **Efficiency layer**：只读 command palette、local Saved Views、diagnostics inspector；
8. **Contract expansion**：generation identity、run history、全文索引、可信 evidence bundle、远程授权分享。

这个顺序使每一步都建立在当前 immutable read model 上，不要求先引入新的写权限，也不会让产品化工作模糊 evidence authority。

## 本轮落地结果（2026-07-16）

本轮按上述边界完成了当前 read model 能安全承载的高优先级能力。状态中的“部分完成”不是把缺口藏进前端，而是明确保留需要性能测量或新后端契约的部分。

| ID | 状态 | 已交付 / 剩余工作 |
|---|---|---|
| M0 | 已完成 | 顶栏、命令面板和错误恢复只包含 navigate/filter/copy/download/reload/display；没有 execute/rerun/approve/edit。server 的 GET/HEAD-only 门禁保持不变。 |
| M1 | 已完成 | `run/split/caseStatus/q/node/view/diff/layout/wrap/focus` 可解析、序列化、复制和通过 History API 重放；非法 enum 与超长输入安全回退；初始链接、Back/Forward 和轮询中出现的新 run 都受 run guard 保护。 |
| M2 | 部分完成 | case rail 已有文本检索、split/status（passed/attention）筛选、结果计数、Clear filters；`Mod+K` 可跨 case、spine metadata、diff path 与只读操作检索。更细的 kind/regressed/disagreement/binary qualifier parser 仍保留为后续项。 |
| M3 | 前端已完成 | browser 分开显示 projection generated time、last successful load、last failed attempt 与连接状态；手动刷新取消旧请求，失败保留 last-good projection；支持 pause/resume 和页面重新可见时验证。projector 的 authoritative `generated_at` 仍属于 L1。 |
| M4 | 基本完成 | 可复制完整 view permalink、带 run/node/status/digest 的 Markdown evidence reference，并下载明确命名为 projection 的 JSON；Clipboard API 不可用时使用 DOM copy fallback。若两种浏览器复制路径都被策略阻断，当前只报告失败，显式可选择文本面板仍可继续增强。 |
| M5 | 已完成 | 初次不可用、stale-with-data、run mismatch、case no-match、无 diff、binary/oversize、sidecar transport error 与 sidecar integrity error 分开呈现；对应提供 Retry、Clear filters 或 Copy diagnostics。 |
| M6 | 基线已完成 | skip link、Evidence/Diff tabs、case/spine/file roving focus、Home/End、可见 focus、modal focus containment/restoration、status/alert live feedback 已落地；更完整的 screen-reader 与 200% zoom 回归继续作为发布 QA。 |
| M7 | 待完成 | Pierre diff 仍保持 virtualizer + worker pool + lazy sidecar；case/spine 的 synthetic stress fixture、交互计时和是否需要 headless virtualizer 尚未用数据证明，不能提前宣称完成。 |
| S1 | 已完成 | 可见入口和 `Mod+K`、跨证据定位、方向键/Enter/Escape、focus trap/restore 均已实现；命令集合保持只读。 |
| S2 | 待完成 | Saved Views/recent queries 需要在 URL 契约稳定后作为 local-only presentation state 实现。 |
| S3 | 部分完成 | footer 已展示 contract、generation/load/attempt/connection，sidecar failure 可复制绑定诊断；独立 read-model diagnostics inspector 仍待建设。 |
| S4 | 等待 M7 | 是否虚拟化 case/spine 必须由大型 fixture 和实际交互预算决定。 |
| S5 | 已完成 | pause/resume、visibility refresh、AbortController 与 last-good preservation 已交付。 |
| S6 | 待完成 | pane resize、density 和 reset layout 尚未建设，优先级低于 M7 与 diagnostics。 |
| L1–L7 | 契约待办 | generation identity、run history、全文索引、可信 evidence bundle、跨 run 比较、远程授权分享和批注 overlay 均未在前端伪造。 |

对应实现集中在 `dashboard/src/dashboard-view-state.ts`、`dashboard/src/CommandPalette.tsx`、`dashboard/src/App.tsx`、`dashboard/src/DiffViewer.tsx` 与 `dashboard/src/dashboard-actions.ts`。Vitest 覆盖 URL round-trip/非法值、history replay、run guard、筛选、键盘命令面板、copy、freshness controls、sidecar retry 与 integrity diagnostics；生产构建和真实浏览器中英文、明暗主题、桌面/390px 窄屏检查也纳入本轮交付验证。

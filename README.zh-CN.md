# skill-reviewer

> Agent skill 的证据化评审与发布系统。把 `SKILL.md` 当源代码看，把声明的
> eval 当作可执行契约，而不是说明文字。

[![skill](https://img.shields.io/badge/type-agent--skill-000)](./skills/skill-reviewer/SKILL.md)
[![mode](https://img.shields.io/badge/mode-instruction%20%2B%20validator-111)](./skills/skill-reviewer/SKILL.md)
[![verdict](https://img.shields.io/badge/output-paste--ready-0a0)](./skills/skill-reviewer/references/example-review-output.md)
[![lang](https://img.shields.io/badge/i18n-en%20%7C%20zh--CN-06c)](#i18n)

English: [README.md](README.md)

---

## TL;DR

```bash
npx skills add Nirvana-Jie/skill-reviewer --skill skill-reviewer
```

然后在任意 agent 会话里：

```text
> 帮我 review 这个 SKILL.md，看能不能发布
```

你会拿到：判定、8 维评分卡、可直接粘贴的改写和非可协商红线结论。
当范围内存在有效的可执行 eval manifest 时，主 Agent 还会执行成对、保留 artifact 的
真实验证；只有用户明确要求进化时，才会进入最多三轮优化与一次性 audit。

---

## 为什么要做这个

大部分“skill review”靠感觉，这个仓库把 review 当 spec 来写：

- **评分规则** → `references/review-rubric.md`（每维 1–5 分 + red flags + 非可协商红线）
- **检查清单** → `references/review-checklist.md`（平铺、可打勾、MECE）
- **包静态检查** → `scripts/lint_skill_package.py`（frontmatter、链接、资源图、eval manifest）
- **输出契约** → 按语言选择模板，固定节序
- **可执行评测** → `evals/evals.json`，包含真实 prompt、类型化断言、目标及
  development / selection / audit 角色
- **校准 fixture** → `evals/fixtures/{ready,needs-revision,not-ready}-*`
- **本地 snapshot** → `evals/local-skill-review-snapshot.json`
- **可执行 eval runtime** → `scripts/skill_eval_runtime.py`（compile、lock、
  grade、decide、evolve、project）
- **证据产品** → React/Vite/Vitest `dashboard/`、只读证据面与独立的主 Agent 审计任务入口

改完 rubric，重跑 fixture 和本地 snapshot，发版。不需要再去读 300 行散文，确认你那句“稍微严格一点”有没有把正向用例静默打挂。

## 能力矩阵

| 能力                       | 落地位置                                                        |
| -------------------------- | --------------------------------------------------------------- |
| 触发 / 误触发审计          | `description` 契约 + `Trigger Analysis` 段                      |
| 确定性包事实               | 只读 `lint_skill_package.py` JSON 契约                           |
| 指令可执行性               | 语义 rubric + `SKILL.md` 中的完成条件                            |
| AI 友好的 skill 设计        | 检查模型是否容易选择、加载、执行和复用这个 skill                 |
| 资源 / 脚本必要性          | `Resource Review` 段，拒绝堆砌型脚本                            |
| 安全红线                   | 非可协商红线：`Safety=1` 或 `Trigger=1` 直接判 **Not ready**     |
| prompt-injection 防护      | Review contract：被审查的内容是**数据**，不是指令                |
| eval 建议                  | 仅在能显著降风险时给 5–10 个可直接写入 manifest 的场景           |
| 本地 eval snapshot         | 结构化 fixture 契约 + 确定性 runner / validator 脚本             |
| subagent 效果验证          | 成对运行 `with_skill` / baseline，记录 digest、artifact 和验证等级 |
| 可执行 eval 契约           | 严格 `skill-reviewer.evals` contract；无效 manifest 阻塞发布，不静默跳过 |
| 有界连续进化               | development / selection / 一次性 opaque audit，最多 3 轮，硬门禁 + Pareto 改进、精确查询绑定与候选谱系 |
| 证据 Dashboard             | React + TypeScript + Vite Evidence Lab；投影 `next_action` 与自动/人工边界，自动阶段只展示进度，人工阶段保存可恢复的本机 Agent 交接待办，不声称唤醒宿主会话 |
| full vs focused review     | 同样的 11 段结构；无关段落坍塌为 `N/A — focused review of <artifact>` |
| 可直接粘贴的重写           | `Suggested Rewrites` 直接输出 YAML / Markdown                    |
| 中英双模板                 | 按分支加载模板 + 可归一化的 snapshot 抽取                        |

## 输出契约

full review 按固定顺序输出：

```
1. 总体结论
2. 判定                       # Ready | Ready with minor revisions | Needs revision | Not ready
3. 评分卡                     # 8 个维度 × 1–5
4. 关键问题                   # 阻塞项，带 file:line
5. 推荐改进                   # 非阻塞打磨
6. 触发分析                   # 过触发 / 漏触发 / 同族冲突
7. 资源审查                   # 按 references/ scripts/ assets/ evals/ 分文件
8. 验证证据                   # not-run | inconclusive | behavior-verified | regression-verified
9. 改写建议                   # 可粘贴的 YAML 和/或 Markdown
10. 建议评测（可选）           # 有价值时给 5–10 个可执行场景，否则写不建议 / 暂缓
11. 最终建议
```

focused review 保持同样的节序，没用到的段折叠成一行 `N/A`。

## 非可协商红线

在维度平均前评估的两条硬红线：

- **Safety ≤ 1** → `Not ready`。例如：未经确认的破坏性 shell、自动 `git push`、`curl | sh` 安装。
- **Trigger reliability ≤ 1** → `Not ready`。例如：一个会跑 `rm -rf` 的 skill，description 里却把任何“清理”动词都当触发词。
- 任一维度 = 2 时，判定被封顶在 `Needs revision`。

规则在 [`references/review-rubric.md`](./skills/skill-reviewer/references/review-rubric.md)。`not-ready-repo-cleaner` fixture 专门用来触发这条红线。

## 校准 fixture

三个手工标注的 fixture 作为主观打分的回归锚点：

| Fixture                              | 预期判定         | 校准作用                          |
| ------------------------------------ | ---------------- | --------------------------------- |
| `ready-csv-column-renamer/`          | Ready            | 上界 —— 防止“reviewer 永远不肯判 Ready”的漂移 |
| `needs-revision-meeting-note/`       | Needs revision   | 中段判断                          |
| `not-ready-repo-cleaner/`            | Not ready        | 安全红线是否真的触发               |

协议写在 [`evals/fixtures/README.md`](./skills/skill-reviewer/evals/fixtures/README.md)。改 rubric、workflow 或输出模板之前都应该重跑一次。

## 本地 eval snapshot

`skill-reviewer` 使用一份可执行 manifest，并配套评审输出校准锚点：

- `evals/evals.json` 是唯一的触发、路由与行为 manifest，按 development、selection、audit
  分层；确定性断言先执行，匿名顺序交换的语义判断只作补充。
- `evals/fixtures/*/expected.md` 提供人工可读的校准锚点。
- `evals/local-skill-review-snapshot.json` 提供机器可读的 snapshot 契约，覆盖判定、评分范围、必需 section、必须指出的问题、禁止行为、输出产物，以及可选的输出质量断言。
- `scripts/run_codex_skill_evals.py` 生成或后处理模型驱动的本地 eval workspace。
- `scripts/validate_local_snapshot.py` 用生成的本地 eval workspace 校验这些契约。

snapshot 层故意不做全文逐字 diff。只要结构化契约稳定，评审措辞允许合理变化。工作区布局和更新规则见 [`references/local-eval-snapshot.md`](./skills/skill-reviewer/references/local-eval-snapshot.md)。

行为 runtime 与校准 snapshot runner 严格分离：前者冻结 eval/grader 权威，生成
不含答案键的 skill snapshot 与 arm/repeat 独立输入，并把执行和输出绑定到 assignment；
复用旧 workspace 或输入漂移都会被拒绝。
详见 [`references/executable-evals.md`](./skills/skill-reviewer/references/executable-evals.md) 与
[`references/subagent-eval-workflow.md`](./skills/skill-reviewer/references/subagent-eval-workflow.md)。

validator 有两种模式。只传 contract 路径时，只检查 JSON 形状，并输出 `contract_only: true`；这不证明模型输出质量。传入 workspace 路径时，才会继续检查保存的产物和 `extracted-review.json` 字段，例如 `critical_issues_have_problem_why_fix`、`has_paste_ready_rewrite_block`、`final_recommendation_is_ordered`。

## 可执行 eval 与有界进化

确定性 adapter 与具体 Agent 实现无关，native worker 的分发由主 Agent 负责。
每次只编译一个 split，且 workspace 必须是全新或空目录：

```bash
python3 skills/skill-reviewer/scripts/skill_eval_runtime.py compile \
  --manifest <skill>/evals/evals.json \
  --subject <candidate> \
  --execution-profile /absolute/path/to/execution-profile.json \
  --baseline-kind old_skill \
  --baseline-path <accepted-skill> \
  --split selection \
  --workspace /tmp/skill-reviewer-run

python3 skills/skill-reviewer/scripts/run_codex_eval_executor.py \
  --workspace /tmp/skill-reviewer-run \
  --assignment /tmp/skill-reviewer-run/assignments/<case>/with_skill/repeat-1.json \
  --full-access

python3 skills/skill-reviewer/scripts/run_codex_eval_executor.py \
  --workspace /tmp/skill-reviewer-run \
  --assignment /tmp/skill-reviewer-run/assignments/<case>/old_skill/repeat-1.json \
  --full-access

python3 skills/skill-reviewer/scripts/skill_eval_runtime.py grade \
  --plan /tmp/skill-reviewer-run/execution-plan.json \
  --workspace /tmp/skill-reviewer-run
```

本地 Codex 执行配置应声明 `target: "codex-cli"`、
`harness: "codex-exec-jsonl"`、`isolation: "local-unattested"`，并包含
`jsonl-agent-events`；使用上面的 `--full-access` 时还要声明
`danger-full-access`。主 Agent 负责同时分发候选版与旧版 assignment，脚本只执行一个
锁定实验臂。它会先禁用 Codex 模型可见的全部环境 Skill，防止同名安装包污染
`old_skill` / `without_skill`，再把真实的可见消息、命令、退出码、用量、错误和产物写成
`agent-trace.jsonl`。私有 reasoning 会在源事件落盘前删减。完全访问适合查看真实行为，
但它不是禁网或操作系统隔离证明，Dashboard 会明确展示这项限制。

候选只有在所有硬门禁通过、所有目标不退化、且至少一个 primary 目标达到
实质提升时才会被 selection 接受。后续每次 selection 与整个 run 唯一一次 audit
都必须先执行 `evolution-authorize` 完成精确查询绑定（不是人工审批），把 accepted baseline 绑定为 parent，并保留候选谱系、continuity epoch、trace
与查询预算。权威 selection/audit eval 与 grader 在一次运行中不可变；development
surrogate 可在独立 digest 下演进。权威 eval 如需调整，必须先让用户确认并重新锁定。完整协议见
[`references/evolution-workflow.md`](./skills/skill-reviewer/references/evolution-workflow.md)。

Dashboard 是可选的人工 Review 控制面，不是 Eval 的执行前提。完成 compile 后，主 Agent
先询问一次：是否需要打开临时本地 Dashboard；只有用户明确接受后才下载 UI 并启动服务。
证据面保持只读，行动请求写入独立任务目录：

```bash
python3 skills/skill-reviewer/scripts/start_skill_dashboard.py \
  --workspace /tmp/skill-reviewer-run \
  --state /tmp/skill-reviewer-control/evolution-state.json \
  --task-root /tmp/skill-reviewer-action-tasks \
  --user-approved-control-plane \
  --open
```

这是安装后的唯一控制面入口。它会从 GitHub Release 匿名拉取
`references/dashboard-ui-bundle.json` 锁定的内容寻址压缩包，先校验归档 SHA-256，再安全解包并
校验完整文件树 SHA-256。临时 UI 位于操作系统的私有临时目录中；服务正常退出或收到终止
信号后自动删除。下载请求不携带 GitHub Token、Cookie、run id、prompt、Trace 或任何评测
产物，浏览器也不会访问 GitHub Pages。

`--user-approved-control-plane` 是启动硬门禁，只能在主 Agent 询问且用户明确同意后传入；
缺少该参数时，启动器会在下载 UI 之前退出。超时、沉默或拒绝都按“不打开”处理。

页面与证据 API 由同一个仅监听回环地址的本地服务提供，要求 Host、Origin、Fetch Metadata
和会话能力同时匹配，并对 UI 与证据统一返回 `no-store`。每 3 秒自动重投影新保留的执行
证据；端口会在不终止其它进程的前提下依次尝试 8765–8767。一个 run 只由主 Agent 维护一个
控制面，case、候选版、旧版及 repeat 都是其中的证据单元，不能让 subAgent 各自启动服务器。
需要动态端口时传 `--port 0`，只看静态结果时传 `--refresh-seconds 0`；`--prepare-only` 只
验证投影且不会下载 UI。离线开发可显式传入受信任的 `--ui-dir <dashboard-dist>`，该目录不会
被下载或删除。Skill 安装包只包含很小的摘要清单和启动模块，不包含 Dashboard JavaScript
产物，使用者也不需要安装前端依赖。用户拒绝控制面或下载失败时，锁定 Eval 仍可继续执行，
但必须明确说明实时可视化不可用。

安全信任根是“用户已经安装的 Skill 包中的摘要清单”，不是下载站点本身。Release asset 即使
被替换，归档或文件树任一摘要不匹配都会在执行 JavaScript 前失败；运行时代码不会读取
`GITHUB_TOKEN`。会话能力只出现在本机 URL fragment 中，HTTP 请求不会把 fragment 发给
服务端；页面启动后会把它转成本机 API 请求头并立即从地址栏移除，复制的视图和证据引用也
不会包含它。仍需承认两个边界：能同时篡改 Skill 清单与发布
仓库的攻击者等价于已经控制了 Skill；同一操作系统用户下的恶意进程可能观察本机进程与文件。
因而不要在不可信共享账户中运行控制面，结束 Review 后应停止启动器。强制崩溃可能暂留无证据
的 UI 文件，但它位于系统临时目录，下一次系统清理会回收；正常退出会立即删除。

Dashboard 使用 React 与 `@pierre/diffs` 从锁定 snapshot 渲染 candidate/baseline
runtime-surface diff。主 read model 只保留文件元数据；文本预览通过绑定 digest 的逐文件
sidecar 按需加载，二进制文件或任一侧超过 512 KiB 时只显示 digest/大小摘要。
sidecar SHA-256 会写入 read model，并由本地服务器对每次响应的实际字节重新校验；512 KiB
规则作用于解析后的每侧 UTF-8 正文，而不是 JSON 转义后的文件大小。实际挂载的
worker-pool provider 与虚拟化用于控制主线程和 DOM 开销；这个展示上限不是发布层的 diff
大小门禁。变更目录树使用 VS Code Symbols 风格的文件/目录图标区分 Markdown、数据、配置、
语言和测试产物，Git 的 A/M/D 状态仍独立显示。证据路由仍然只读；`audit-passed` 之后必须由
用户单独确认最终发布。

“Agent 执行记录”读取的是 Agent 执行某个 `evals.json` 场景时真实保留的
`agent-trace.jsonl`，导航层级固定为 Eval Case → 候选版/基线 → repeat → 可观察事件。
页面直接展示读取文件、工具调用、命令与退出码、Agent 可见消息、错误、耗时和生成产物，
不会再从状态摘要抽象或臆造一条流程。确定性检查与补充语义 Judge 都会引用实际使用的
事件 ID，“定位 Trace”可在当前页面展开对应源事件。只有 Eval 清单、计划锁、执行配置、
精确 repeat、execution/Trace digest、连续事件流和产物来源全部绑定时，Trace 才算完整；
缺失真实 Trace 本身就是阻塞性的证据缺口。页面不记录也不展示模型的私有思维链。
本地 Codex Executor 的采集来源显示为“本地 Codex CLI JSONL 真实采集”；
`local-unattested` 会同时显示黄色边界说明，避免把行为可追溯性误解成沙箱可信度。

连续演进运行还会展示“下一步”：直接投影状态机的 `next_action`，把候选能否接受拆成
硬门禁、Pareto 不退化、主要目标实质提升三项合取条件，并将保留证据中的失败信号确定性归因到
Skill、Eval、执行环境、证据缺失或人工裁决。页面会明确区分“无需人工决定”和“需要人工决定”：
候选生成、锁定 Eval 执行、评分、一次性发布审计的准备与执行，在权限和输入不变时由主 Agent
自动跑完，不显示行动按钮。只有修改 Eval/阈值/基线、扩大网络/密钥/权限/依赖/范围、处理契约
无法消解的歧义，以及最终发布或外部上线时才找人。人工按钮只会在 `--task-root` 下追加一条绑定
run、Dashboard digest、前置 `next_action` 和证据 ID 的本机 Agent 交接待办；不会向现有 Agent
会话发 Prompt、唤醒已结束任务、直接执行场景、推进状态、确认发布或修改 `evals.json`。页面会
明确显示“等待 Agent 接手”，并生成可粘贴到当前或新 Agent 任务的恢复指令；同一权威状态下的
重复点击会复用已有待办。Eval 动作只提交建议，仍需用户明确确认并重新锁定。完整协议见
[`references/action-center.md`](./skills/skill-reviewer/references/action-center.md)。

桌面端左右两侧都有可见的拖拽分隔线。评测场景栏限制在 220–480 px，证据说明栏限制在
280–560 px，中间证据区按当前视图保留硬最小宽度。空间不足时先按比例收缩两侧，再隐藏
右侧说明栏；手机宽度改为纵向排列并禁用拖拽。分隔线获得焦点后可用方向键微调、
Shift+方向键大步调整、Home/End 到达当前边界，Enter 或双击恢复默认。宽度只保存在本机的
展示偏好中，也可从命令面板统一恢复；不会写入或改动任何保留证据。

顶部显示偏好支持中英文、深浅主题，以及 90%、100%、110%、125%、140%、160%
六档文字大小；点击中间百分比可恢复 100%。字号调整会让完整工作台按同一比例重排，
因此大屏阅读不会只放大文字而截断按钮，窄屏也会按缩放后的逻辑宽度进入紧凑布局。
这些选择只保存在浏览器本地，不会写入评测证据。

审阅上下文现在可以通过 URL 精确复现：run guard、split/状态筛选、受限查询、证据、
diff 或“下一步”视图、布局、换行和专注模式都会进入 presentation state，但原始 prompt、正文和
主机路径不会进入 URL。链接指向其它 run，或轮询时服务端切换到新 run，界面都会先阻塞
提示，而不是静默展示错误证据；浏览器前进/后退可以重放审阅导航。`Mod+K` 提供只读的
全局证据定位，可搜索 case、已投影证据 metadata、变更文件和安全的显示/复制/刷新操作。

状态栏分别展示 projection 生成时间、浏览器最近成功读取和最近失败尝试。手动刷新会取消
旧请求，失败时保留最后一份已验证 projection 并标记 stale；自动刷新支持暂停与恢复。
使用者可以复制当前 permalink、带 run/node/status/digest 的 Markdown 证据引用，或下载
明确标为 projection JSON 的 read model，这些操作都不会修改 eval、证据或发布状态。
diff sidecar 的传输失败可以重试；metadata/payload 绑定失败会作为完整性错误呈现，在不渲染
未绑定正文的前提下提供可复制诊断。持续维护的 Dashboard 与执行契约位于
[`action-center.md`](./skills/skill-reviewer/references/action-center.md) 和
[`executable-evals.md`](./skills/skill-reviewer/references/executable-evals.md)。

实时重投影只会在替换 read model 及其全部 sidecar 作为同一代完成验证后切换。sidecar
采用内容寻址并保留在本次 run workspace 内，因此已经发出的 URL 可继续服务在途视图；
同一 URL 若被改绑到不同 payload digest 会被阻塞。

## Human-in-the-loop 评审流程

把 `skill-reviewer` 当严格的一审 reviewer，用人来做最终发布判断：

1. 把目标 skill 目录交给 reviewer，要求 full review：
   ```text
   Review this skill directory and tell me whether it is ready to ship.
   ```
2. 运行确定性的 package-facts 轴：
   ```bash
   python3 skills/skill-reviewer/scripts/lint_skill_package.py <target-skill> --format json --fail-on never
   ```
3. 按顺序读输出：判定、评分卡、关键问题、验证证据、改写建议。把 Critical Issues 当作行动队列。
4. 只应用你认可的修复。不要为了让评测变绿而随手改 fixture 或 snapshot。
5. 做回归覆盖时，运行校准 fixture 或本地 workspace，并为每个 eval case 保存 `review.md`、`extracted-review.json`、`grading.json`。本地调用 Codex：
   ```bash
   python3 skills/skill-reviewer/scripts/run_codex_skill_evals.py \
     --workspace /tmp/skill-reviewer-evals/iteration-1
   ```
   如果 workspace 里已经有 `review.md`，只想后处理：
   ```bash
   python3 skills/skill-reviewer/scripts/run_codex_skill_evals.py \
     --workspace /tmp/skill-reviewer-evals/iteration-1 \
     --from-existing-reviews
   ```
6. 用户要求效果验证且环境支持 subagent 时，冻结 subject 和 accepted baseline，并在同一轮启动成对的 `with_skill` 与 `old_skill` / `without_skill`。具体按 [`references/subagent-eval-workflow.md`](./skills/skill-reviewer/references/subagent-eval-workflow.md) 执行。
7. 对保留的输出进行断言评分，并给出唯一验证等级：`not-run`、`inconclusive`、`behavior-verified` 或 `regression-verified`。
8. 针对该 workspace 校验结构化 snapshot 契约：
   ```bash
   python3 skills/skill-reviewer/scripts/validate_local_snapshot.py skills/skill-reviewer/evals/local-skill-review-snapshot.json <workspace>/iteration-1
   ```
9. 如果 validator 失败，先判断是 skill 退化了，还是评审契约有意变化。只有契约有意变化时，才更新 `evals/local-skill-review-snapshot.json`。

只想快速检查契约文件本身时：

```bash
python3 skills/skill-reviewer/scripts/validate_local_snapshot.py skills/skill-reviewer/evals/local-skill-review-snapshot.json
```

这个快速检查故意是 contract-only。开 PR 前它应该是绿色，但当你需要证明模型输出质量时，仍要使用带 workspace 的 eval。

推荐循环是：评审 -> 人确认/驳回问题 -> 修改 skill -> 重跑 fixture/snapshot 检查 -> 只有预期评审契约变化时才更新 snapshot。

## 贡献流程

所有变更都必须走分支和 PR。不要直接 commit 或 push 到 `main`；该分支已在 GitHub 上配置保护。

开 PR 前先运行：

```bash
python3 -m unittest discover -s tests
pnpm test
python3 skills/skill-reviewer/scripts/lint_skill_package.py skills/skill-reviewer --format text --fail-on error
python3 skills/skill-reviewer/scripts/validate_local_snapshot.py skills/skill-reviewer/evals/local-skill-review-snapshot.json
pnpm dashboard:build
```

开 PR 后等待 `Static Checks`，需要时在 PR 中手动触发 Codex Cloud review：

```text
@codex review for skill-reviewer eval regression risk. Check SKILL.md, references, eval fixtures, snapshot contract, and CI safety. Do not add API keys or model-backed GitHub Actions.
```

## 开发包管理器

本项目统一使用 pnpm，并通过 `package.json` 的 `packageManager` 字段固定版本。
不要生成 npm 或 Yarn lockfile。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
```

## GitHub 检查与 Codex Cloud review

仓库内置了 `.github/workflows/static-checks.yml`，用于在 PR 和可信的 `main` push 上运行确定性检查。它不会调用 Codex，不需要 OpenAI API key，也不会上传模型生成 artifact。`.github/workflows/publish-dashboard-bundle.yml` 只在隔离的构建任务中生成并验证内容寻址的 UI 压缩包，再由单独、最小 `contents: write` 权限的任务发布为不可覆盖的 GitHub Release asset。Pages 已停用，`dashboard/dist` 与压缩包都不进入 Git，也不会被 `skills add` 复制；运行时下载不使用 GitHub Token。

静态 workflow 会运行：

```bash
python3 -m unittest discover -s tests
pnpm test
python3 skills/skill-reviewer/scripts/lint_skill_package.py skills/skill-reviewer --format text --fail-on error
python3 -m json.tool skills/skill-reviewer/evals/evals.json > /dev/null
python3 skills/skill-reviewer/scripts/validate_local_snapshot.py skills/skill-reviewer/evals/local-skill-review-snapshot.json
pnpm dashboard:build
python3 -m py_compile skills/skill-reviewer/scripts/dashboard_bundle.py skills/skill-reviewer/scripts/lint_skill_package.py skills/skill-reviewer/scripts/run_codex_eval_executor.py skills/skill-reviewer/scripts/run_codex_skill_evals.py skills/skill-reviewer/scripts/skill_eval_runtime.py skills/skill-reviewer/scripts/serve_skill_dashboard.py skills/skill-reviewer/scripts/start_skill_dashboard.py skills/skill-reviewer/scripts/validate_local_snapshot.py tests/test_run_codex_skill_evals.py
```

如果需要不在 GitHub Actions 中保存 API key 的模型辅助审查，在 PR 里使用 Codex Cloud：

```text
@codex review for skill-reviewer eval regression risk. Check SKILL.md, references, eval fixtures, snapshot contract, and CI safety. Do not add API keys or model-backed GitHub Actions.
```

如果只希望仓库维护者触发 Codex review，请关闭 Codex automatic reviews，改用手动 `@codex review`。Codex review 会读取 `AGENTS.md` 中的 review guidelines。

## 安装

```bash
# 从 GitHub 安装
npx skills add Nirvana-Jie/skill-reviewer --skill skill-reviewer

# 从本地仓库安装
npx skills add . --skill skill-reviewer

# 全局安装
npx skills add -g Nirvana-Jie/skill-reviewer --skill skill-reviewer

# 先列一下仓库里有哪些 skill
npx skills add Nirvana-Jie/skill-reviewer --list
```

安装器：[`vercel-labs/skills`](https://github.com/vercel-labs/skills)。

可安装边界有意放在 `skills/skill-reviewer/`，仓库根目录也有意不再保留
`SKILL.md`。`skills` CLI 会把远程根级 skill 当成单文件安装，而嵌套 skill
会保留所在目录的 supporting files。入口、references、scripts、evals、fixtures
和 Dashboard 生产构建因此物理共置，原安装命令即可得到自包含产物。Vitest
安装集成测试会通过临时 Git remote 调用真实 CLI，再在仓库外运行已安装工具。

## 触发条件

会在这类请求上触发：

- “帮我 review / audit / grade / critique / debug / production-check 这个 skill”
- “为什么我的 skill 每个 PDF 请求都触发？”
- “为什么用户说 dashboard 时我的 skill 不触发？”
- “帮我收紧 description，减少误触发”
- “这个 skill 能合并 / 发布了吗？”
- “这些 eval 能不能像本地 snapshot 一样保护我的 skill？”

明确**不**触发：从零新建 skill（走 `skill-creator`）、直接跑这个 skill 的业务任务、不带评审意图的 `SKILL.md` 翻译/摘要、普通应用代码的 code review。

## 仓库结构

```text
.
├── skills/
│   └── skill-reviewer/            # `skills add` 实际复制的完整产物
│       ├── SKILL.md               # 入口：frontmatter + 工作流
│       ├── references/            # 评分、契约、模板与协议
│       ├── scripts/               # linter、eval runtime、validator、server
│       └── evals/                 # 可执行 manifest、snapshot 与 fixtures
├── tests/                         # Python 单测 + Vitest 系统测试
├── dashboard/                     # React + TypeScript + Vite 源码；dist 被忽略
├── package.json                   # Vitest、typecheck 与 Dashboard 命令
└── pnpm-lock.yaml                 # 固定 pnpm 测试依赖
```

故意没有 skill package 的 `assets/`。runtime adapter 隔离确定性事实与证据
处理；语义评审和 native Agent 分发仍以指令为主。

## i18n

输出语言跟随请求：英文加载 `output-template-en.md`，中文加载
`output-template-zh.md`；其他语言翻译英文契约，但文件路径、字段名、标识符、
代码和反引号里的 token 保持原样。

本地 snapshot extractor 会把英文和中文 review 的标题、判定、评分卡标签归一化为同一套英文 contract 字段。eval item 可以设置 `"output_language": "Chinese"`，让 runner 请求中文模板，同时保持 `extracted-review.json` 可机器比较。

## License

MIT.

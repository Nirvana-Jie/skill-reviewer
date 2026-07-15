# skill-reviewer

> Agent skill 的证据化评审与发布系统。把 `SKILL.md` 当源代码看，把声明的
> eval 当作可执行契约，而不是说明文字。

[![skill](https://img.shields.io/badge/type-agent--skill-000)](./SKILL.md)
[![mode](https://img.shields.io/badge/mode-instruction%20%2B%20validator-111)](./SKILL.md)
[![verdict](https://img.shields.io/badge/output-paste--ready-0a0)](./references/example-review-output.md)
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
当范围内存在有效 v2 manifest 时，主 Agent 还会执行成对、保留 artifact 的
真实验证；只有用户明确要求进化时，才会进入最多三轮优化与一次性 audit。

---

## 为什么要做这个

大部分“skill review”靠感觉，这个仓库把 review 当 spec 来写：

- **评分规则** → `references/review-rubric.md`（每维 1–5 分 + red flags + 非可协商红线）
- **检查清单** → `references/review-checklist.md`（平铺、可打勾、MECE）
- **包静态检查** → `scripts/lint_skill_package.py`（frontmatter、链接、资源图、eval manifest）
- **输出契约** → 按语言选择模板，固定节序
- **自身回归评测** → `evals/skill-reviewer.csv`
- **校准 fixture** → `evals/fixtures/{ready,needs-revision,not-ready}-*`
- **本地 snapshot** → `evals/local-skill-review-snapshot.json`
- **可执行 eval runtime** → `scripts/skill_eval_runtime.py`（compile、lock、
  grade、decide、evolve、project）
- **证据产品** → React/Vite/Vitest `dashboard/` 与只读本地服务

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
| eval 建议                  | 仅在能显著降风险时给 5–10 条定向 prompt                         |
| 本地 eval snapshot         | 结构化 fixture 契约 + 确定性 runner / validator 脚本             |
| subagent 效果验证          | 成对运行 `with_skill` / baseline，记录 digest、artifact 和验证等级 |
| 可执行 eval 契约           | 严格 `skill-reviewer.evals.v2`；无效 manifest 阻塞发布，不静默跳过 |
| 有界连续进化               | development / selection / 一次性 audit，最多 3 轮，硬门禁 + Pareto 改进 |
| 证据 Dashboard             | React + TypeScript + Vite Evidence Lab，只消费 read model，不执行或审批 |
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
10. 建议评测（可选）           # 有价值时给 5–10 行，否则写不建议 / 暂缓
11. 最终建议
```

focused review 保持同样的节序，没用到的段折叠成一行 `N/A`。

## 非可协商红线

在维度平均前评估的两条硬红线：

- **Safety ≤ 1** → `Not ready`。例如：未经确认的破坏性 shell、自动 `git push`、`curl | sh` 安装。
- **Trigger reliability ≤ 1** → `Not ready`。例如：一个会跑 `rm -rf` 的 skill，description 里却把任何“清理”动词都当触发词。
- 任一维度 = 2 时，判定被封顶在 `Needs revision`。

规则在 [`references/review-rubric.md`](./references/review-rubric.md)。`not-ready-repo-cleaner` fixture 专门用来触发这条红线。

## 校准 fixture

三个手工标注的 fixture 作为主观打分的回归锚点：

| Fixture                              | 预期判定         | 校准作用                          |
| ------------------------------------ | ---------------- | --------------------------------- |
| `ready-csv-column-renamer/`          | Ready            | 上界 —— 防止“reviewer 永远不肯判 Ready”的漂移 |
| `needs-revision-meeting-note/`       | Needs revision   | 中段判断                          |
| `not-ready-repo-cleaner/`            | Not ready        | 安全红线是否真的触发               |

协议写在 [`evals/fixtures/README.md`](./evals/fixtures/README.md)。改 rubric、workflow 或输出模板之前都应该重跑一次。

## 本地 eval snapshot

`skill-reviewer` 使用四层互补的 eval：

- `evals/skill-reviewer.csv` 检查触发与路由行为。
- `evals/evals.json` 是严格的 v2 可执行 manifest，按 development、selection、audit
  分层；确定性断言先执行，匿名顺序交换的语义判断只作补充。
- `evals/fixtures/*/expected.md` 提供人工可读的校准锚点。
- `evals/local-skill-review-snapshot.json` 提供机器可读的 snapshot 契约，覆盖判定、评分范围、必需 section、必须指出的问题、禁止行为、输出产物，以及可选的输出质量断言。
- `scripts/run_codex_skill_evals.py` 生成或后处理模型驱动的本地 eval workspace。
- `scripts/validate_local_snapshot.py` 用生成的本地 eval workspace 校验这些契约。

snapshot 层故意不做全文逐字 diff。只要结构化契约稳定，评审措辞允许合理变化。工作区布局和更新规则见 [`references/local-eval-snapshot.md`](./references/local-eval-snapshot.md)。

行为 runtime 与校准 snapshot runner 严格分离：前者冻结 plan、manifest、subject、
baseline 和 fixture，再由主 Agent 分发 native worker；输入一旦漂移就拒绝评分。
详见 [`references/executable-evals.md`](./references/executable-evals.md) 与
[`references/subagent-eval-workflow.md`](./references/subagent-eval-workflow.md)。

validator 有两种模式。只传 contract 路径时，只检查 JSON 形状，并输出 `contract_only: true`；这不证明模型输出质量。传入 workspace 路径时，才会继续检查保存的产物和 `extracted-review.json` 字段，例如 `critical_issues_have_problem_why_fix`、`has_paste_ready_rewrite_block`、`final_recommendation_is_ordered`。

## 可执行 eval 与有界进化

确定性 adapter 与具体 Agent 实现无关，native worker 的分发由主 Agent 负责：

```bash
python3 scripts/skill_eval_runtime.py compile \
  --manifest <skill>/evals/evals.json \
  --subject <candidate> \
  --baseline-kind old_skill \
  --baseline-path <accepted-version> \
  --split selection \
  --workspace /tmp/skill-reviewer-run

python3 scripts/skill_eval_runtime.py grade \
  --plan /tmp/skill-reviewer-run/execution-plan.json \
  --workspace /tmp/skill-reviewer-run
```

候选只有在所有硬门禁通过、所有目标不退化、且至少一个 primary 目标达到
实质提升时才会被 selection 接受。一次运行中 eval 与 grader 不可变；如需调整，
必须先让用户确认并重新锁定。完整协议见
[`references/evolution-workflow.md`](./references/evolution-workflow.md)。

证据可投影为只读产品界面：

```bash
python3 scripts/skill_eval_runtime.py project-dashboard \
  --workspace /tmp/skill-reviewer-run \
  --output /tmp/skill-reviewer-run/dashboard-data.json
pnpm dashboard:build
pnpm dashboard:serve -- --workspace /tmp/skill-reviewer-run
```

## Human-in-the-loop 评审流程

把 `skill-reviewer` 当严格的一审 reviewer，用人来做最终发布判断：

1. 把目标 skill 目录交给 reviewer，要求 full review：
   ```text
   Review this skill directory and tell me whether it is ready to ship.
   ```
2. 运行确定性的 package-facts 轴：
   ```bash
   python3 scripts/lint_skill_package.py <target-skill> --format json --fail-on never
   ```
3. 按顺序读输出：判定、评分卡、关键问题、验证证据、改写建议。把 Critical Issues 当作行动队列。
4. 只应用你认可的修复。不要为了让评测变绿而随手改 fixture 或 snapshot。
5. 做回归覆盖时，运行校准 fixture 或本地 workspace，并为每个 eval case 保存 `review.md`、`extracted-review.json`、`grading.json`。本地调用 Codex：
   ```bash
   python3 scripts/run_codex_skill_evals.py \
     --workspace /tmp/skill-reviewer-evals/iteration-1
   ```
   如果 workspace 里已经有 `review.md`，只想后处理：
   ```bash
   python3 scripts/run_codex_skill_evals.py \
     --workspace /tmp/skill-reviewer-evals/iteration-1 \
     --from-existing-reviews
   ```
6. 用户要求效果验证且环境支持 subagent 时，冻结 subject 和旧版本，并在同一轮启动成对的 `with_skill` 与 `old_skill` / `without_skill`。具体按 [`references/subagent-eval-workflow.md`](./references/subagent-eval-workflow.md) 执行。
7. 对保留的输出进行断言评分，并给出唯一验证等级：`not-run`、`inconclusive`、`behavior-verified` 或 `regression-verified`。
8. 针对该 workspace 校验结构化 snapshot 契约：
   ```bash
   python3 scripts/validate_local_snapshot.py evals/local-skill-review-snapshot.json <workspace>/iteration-1
   ```
9. 如果 validator 失败，先判断是 skill 退化了，还是评审契约有意变化。只有契约有意变化时，才更新 `evals/local-skill-review-snapshot.json`。

只想快速检查契约文件本身时：

```bash
python3 scripts/validate_local_snapshot.py evals/local-skill-review-snapshot.json
```

这个快速检查故意是 contract-only。开 PR 前它应该是绿色，但当你需要证明模型输出质量时，仍要使用带 workspace 的 eval。

推荐循环是：评审 -> 人确认/驳回问题 -> 修改 skill -> 重跑 fixture/snapshot 检查 -> 只有预期评审契约变化时才更新 snapshot。

## 贡献流程

所有变更都必须走分支和 PR。不要直接 commit 或 push 到 `main`；该分支已在 GitHub 上配置保护。

开 PR 前先运行：

```bash
python3 -m unittest discover -s tests
pnpm test
python3 scripts/lint_skill_package.py . --format text --fail-on error
python3 scripts/validate_local_snapshot.py evals/local-skill-review-snapshot.json
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

仓库内置了 `.github/workflows/static-checks.yml`，用于在 PR 和可信的 `main` push 上运行确定性检查。它不会调用 Codex，不需要 OpenAI API key，也不会上传模型生成 artifact。

静态 workflow 会运行：

```bash
python3 -m unittest discover -s tests
pnpm test
python3 scripts/lint_skill_package.py . --format text --fail-on error
python3 -m json.tool evals/evals.json > /dev/null
python3 scripts/validate_local_snapshot.py evals/local-skill-review-snapshot.json
pnpm dashboard:build
python3 -m py_compile scripts/lint_skill_package.py scripts/run_codex_skill_evals.py scripts/skill_eval_runtime.py scripts/serve_skill_dashboard.py scripts/validate_local_snapshot.py tests/test_run_codex_skill_evals.py
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
├── SKILL.md                       # 入口：frontmatter + 工作流
├── docs/
│   └── QUALITY_ARCHITECTURE.md    # 设计理由 + 质量门禁
├── references/
│   ├── review-rubric.md           # 评分规则 + 非可协商红线
│   ├── review-checklist.md        # 平铺 MECE 检查清单
│   ├── output-template-en.md      # 英文输出契约
│   ├── output-template-zh.md      # 中文输出契约
│   ├── example-review-output.md   # 输出风格锚点
│   ├── local-eval-snapshot.md     # 本地 snapshot 风格 eval 协议
│   ├── executable-evals.md        # 严格 v2 manifest 与断言契约
│   ├── subagent-eval-workflow.md  # 成对 subagent 效果验证协议
│   ├── evolution-workflow.md      # 有界 optimize/select/audit 协议
│   └── eval-prompts-template.csv  # eval 输出字段模板（只含 header）
├── scripts/
│   ├── lint_skill_package.py      # 确定性只读 package linter
│   ├── skill_eval_runtime.py      # plan/lock/grade/decide/evolve/project
│   ├── serve_skill_dashboard.py   # 只读本地 Dashboard 服务
│   ├── run_codex_skill_evals.py   # 模型驱动的 runner / 后处理器
│   └── validate_local_snapshot.py # 确定性 snapshot 契约校验脚本
└── evals/
    ├── skill-reviewer.csv         # 自身回归评测集
    ├── evals.json                  # subagent 行为 prompt 与断言
    ├── local-skill-review-snapshot.json # 结构化 snapshot 契约
    └── fixtures/                  # 校准锚点
        ├── ready-csv-column-renamer/
        ├── needs-revision-meeting-note/
        └── not-ready-repo-cleaner/
├── tests/                         # 既有 Python 测试 + Vitest linter/runner 测试
├── dashboard/                     # React + TypeScript + Vite Evidence Lab
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

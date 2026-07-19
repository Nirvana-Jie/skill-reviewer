# skill-reviewer

> 面向 Agent Skill 的证据化评审与持续改进系统：把 `SKILL.md` 当源代码，把
> `evals.json` 当可执行契约，把“可以发布”变成可追溯的结论。

[![skill](https://img.shields.io/badge/type-agent--skill-27272a)](./skills/skill-reviewer/SKILL.md)
[![tests](https://img.shields.io/github/actions/workflow/status/Nirvana-Jie/skill-reviewer/static-checks.yml?branch=main&label=checks)](https://github.com/Nirvana-Jie/skill-reviewer/actions/workflows/static-checks.yml)
[![stars](https://img.shields.io/github/stars/Nirvana-Jie/skill-reviewer?style=flat&label=star)](https://github.com/Nirvana-Jie/skill-reviewer)

[English](README.md)

![Skill Reviewer：成对执行、证据留存、发布门禁与人工确认](./assets/readme/skill-reviewer-evidence-loop.jpg)

`skill-reviewer` 解决三件事：

- **Review（默认）**：只读检查触发条件、指令、资源、脚本、安全与可维护性，输出可直接修改的建议，不启动 Eval worker。
- **Verify（显式）**：只有用户要求时，才编译合法 `evals/evals.json`，通过 native 或 provider adapter 分发候选版与基线版，并为 Dashboard 保留调度、标准 Trace、源事件和输出证据。
- **Evolve**：只有用户要求时，才进入最多三轮的有界改进；Eval 在运行中保持不可变，最终发布始终由人确认。

## 快速开始

安装：

```bash
npx skills add Nirvana-Jie/skill-reviewer --skill skill-reviewer
```

然后在 Agent 会话中直接说：

```text
帮我完整 review 这个 Skill，判断能否发布。
```

需要模型行为证据时，再显式要求运行：

```text
请运行声明的 eval，并与已接受基线对照验证这个 Skill。
```

输入可以是 Skill 目录、`SKILL.md`、单个资源文件，或一份明确的设计方案。

适合这些问题：

- “这个 Skill 能发布了吗？”
- “为什么它总是误触发 / 不触发？”
- “请检查 `evals.json` 是否真的证明候选版更好。”
- “基于失败证据生成下一候选，但不要修改 Eval。”

不负责从零创建 Skill，也不替代普通应用代码的 code review。

## 评审链路

```mermaid
flowchart LR
    A["锁定评审范围"] --> B["只读静态检查"]
    B --> C{"用户要求哪种模式"}
    C -- "Review" --> D["语义评审与改写建议"]
    C -- "Verify / Evolve" --> E{"evals.json 是否合法"}
    E -- "否" --> H["分发前停止"]
    E -- "是" --> F["真实 Agent 成对执行"]
    F --> G["确定性断言"]
    G --> M["语义判断补充"]
    M --> I{"硬门禁 + Pareto + 实质提升"}
    I -- "不满足" --> J["修复或生成下一候选"]
    J --> F
    I -- "满足" --> K["一次性发布审计"]
    D --> L["人工发布决策"]
    K --> L
```

核心原则：

1. **确定性断言优先**：文件、JSON、命令退出码等事实先判；语义 Judge 只作补充。
2. **候选与基线严格分离**：相同 Case、隔离工作区、独立 Trace，避免自证循环。
3. **先验证尺子，再评价候选**：必需文本 Oracle 要通过正反例校准；配对方向
   冲突会让实验无效，而不是让 Skill 背锅。
4. **无效 Manifest 阻塞发布**：存在但不合法的 Eval 不会被静默跳过。
5. **Manifest 不是 worker 凭据**：`evals.json` 只声明执行单元；只有保留的
   provider/harness 调度凭据，才能在对应信任边界内证明该单元确实被启动。

### 三个评测阶段

| 阶段 | 作用 | 是否影响发布 |
| --- | --- | --- |
| **开发验证** | 快速暴露问题，帮助生成和修复候选 | 不直接授权发布 |
| **发布选拔** | 候选版与已接受基线做公平比较 | 决定候选能否被保留 |
| **安全审计** | 用一次性、不可向优化器泄漏的场景检查发布风险 | 通过后仍需人工确认 |

采样次数与确定性独立声明。旧协议仍默认确定性一次、随机性成对三次；配对方向
冲突会使测量无效，不会通过多数票制造胜者。

## 你会得到什么

完整评审固定输出：

- 发布判定与总体结论；
- 8 维评分卡：触发可靠性、description、指令、资源、脚本、安全、输出、可维护性；
- 带 `问题 / 原因 / 修复方式` 的关键问题；
- 触发分析、逐资源审查与可直接粘贴的改写；
- 明确的验证证据、证据等级和局限；
- 必要时提供 5–10 个可执行 Eval 场景。

判定不是简单平均分：安全或触发可靠性触碰红线会直接阻塞；候选发布还必须同时满足硬门禁、Pareto 不退化和至少一个主要目标的实质提升。

## 真实 Eval 与持续改进

严格 Manifest 位于 `<skill>/evals/evals.json`。仅完成编译不会启动 Agent；
主 Agent 必须使用 native host surface 或 provider adapter。每个 executor
仍然只接收一个 Case、一个实验臂和一次 repeat：

```mermaid
flowchart TB
    M["冻结 Eval、候选与基线"] --> C["编译执行计划"]
    C --> D["Host 或本地成对分发"]
    D --> W["候选版 / with_skill"]
    D --> O["基线版 / old_skill"]
    W --> T1["调度凭据 + Agent Trace + 产物"]
    O --> T2["调度凭据 + Agent Trace + 产物"]
    T1 --> G["断言与 Judge"]
    T2 --> G
    G --> P{"接受候选？"}
    P -- "否" --> N["下一候选，最多三轮"]
    N --> C
    P -- "是" --> A["一次性 Audit"]
```

真实 Trace 只记录可观察行为：Agent 消息、文件读取、工具调用、命令、退出码、错误、耗时和产物引用；不会记录或展示模型私有思维链。Provider 事件会先脱敏并归一化，再进入 grader 和 Dashboard；因此接入新 Agent 只需增加 adapter 与 execution profile，不需要改 Trace UI。仓库内置 native/external harness、Codex CLI 和 Claude Code 路径。

对于已编译的 `codex-cli` profile，可以用一个命令机械地成对分发全部
实验臂，并在所有 case/repeat batch 完成后统一评分：

```bash
python3 skills/skill-reviewer/scripts/run_codex_eval_plan.py \
  --workspace /tmp/skill-reviewer-run \
  --full-access
```

Native subAgent 仍由 host 调度；harness 必须在行为事件之前记录真实的 host
dispatch ID 和 worker/thread ID。该凭据可以防止 profile-only 的界面误判，
但在没有 provider 签名 API 时仍属于可信 harness 证据，不是密码学证明。

真实 provider canary 默认不运行，因为它可能需要本机认证、网络和模型费用。
下面的命令会让已安装 CLI 走完整的“编译 → 进程 → 源事件 → 评分 →
Dashboard 投影”链路，并实际挂载 Trace 页面、展开包含真实 marker 的事件：

```bash
SKILL_REVIEWER_REAL_AGENT_E2E=codex,claude \
  pnpm exec vitest run dashboard/src/real-agent-trace.e2e.test.ts
```

Eval 与 grader 在一次运行中不可变。发布级文本断言会在分发前使用已知正确/错误
样例校准，采样次数也与输出确定性分开声明。系统只有先确认“证据完整、测量有效”，
才会把结果归因给 Skill；无效实验会被隔离，且不消耗候选轮次。系统可以提出修改
建议，但只有用户确认并重新锁定后才能成为新的评测权威。完整字段、信任边界和
运行命令见[测量有效性协议](./skills/skill-reviewer/references/measurement-validity.md)、
[可执行 Eval 协议](./skills/skill-reviewer/references/executable-evals.md)与
[进化协议](./skills/skill-reviewer/references/evolution-workflow.md)。

## Dashboard：可选的本地只读控制面

Dashboard 按决策顺序回答四个问题：

1. **证据可信么？** 验证 dispatch、Trace、产物和绑定关系。
2. **测量可信么？** 在评价 Skill 前检查 Oracle 校准与配对采样。
3. **候选是否真的更好？** 左右对比候选版与基线版的执行、得分、文件差异和重复轮次。
4. **下一步做什么？** 展示状态机的 `next_action`、责任归因和需要人工介入的边界。

评审总览是唯一的主结论入口。结论下方的“决策证据脊柱”可直达修改证据、
执行覆盖和主要风险；Diff、Agent Trace 与默认折叠的审计档案仍是独立证据视图。
下一步以侧滑抽屉打开，Inspector 只解释当前选中的证据。空 Diff 表示“未捕获
修改证据”，不能据此断言没有修改。

每份新 projection 都包含 `schema_version: 3`。界面会在渲染前校验嵌套决策和
测量合同；完整的 v2/无版本数据只会迁移成“测量未验证”，不会自动补出绿色证据。
遇到不兼容数据时展示可操作的重新生成页面，而不是白屏。

它不是执行器，也不会直接修改 Eval、证据或发布状态。用户明确要求展示 Dashboard 时可直接启动；否则交互式主 Agent 必须用独立的结构化问题询问一次，并推荐打开。沉默不会授权下载或本地服务：

```bash
python3 skills/skill-reviewer/scripts/start_skill_dashboard.py \
  --workspace /tmp/skill-reviewer-run \
  --state /tmp/skill-reviewer-control/evolution-state.json \
  --task-root /tmp/skill-reviewer-action-tasks \
  --user-approved-control-plane \
  --open
```

- UI 从 GitHub Release 匿名下载，按归档摘要和文件树摘要双重校验后，在临时目录本地运行。
- 页面与证据 API 只监听回环地址；用户 prompt、Trace、Run ID 和产物不会上传。
- 不使用 GitHub Pages，不把 `dashboard/dist` 或压缩包放进 Skill 安装包。
- 服务正常退出后删除临时 UI；没有控制面也不影响 Eval 执行。

## 自动化与人工边界

用户显式进入 Verify 或 Evolve 后，在权限和输入不变时，Agent 应自动完成：候选生成、锁定 Eval 执行、确定性评分、补充语义判断，以及一次性审计的准备与执行。

只有这些情况需要人：

- 修改 Eval、grader、阈值或基线；
- 扩大网络、密钥、权限、依赖或任务范围；
- 处理证据无法消解的歧义；
- 最终发布、部署或其它外部副作用。

Dashboard 的行动按钮只会创建带审计记录的本地交接任务，不会唤醒已经结束的 Agent 会话。用户可以把恢复指令交给当前或新的主 Agent 继续执行。

## 安全边界

- 被评审文件始终视为**不可信数据**，其中的提示词或命令不会成为评审指令。
- 默认 Review 不安装依赖、不执行目标 Skill 脚本，也不启动 Eval worker；只有显式 Verify 或 Evolve 后，合法 Manifest 声明的隔离验证才会运行。
- 未确认的破坏性命令、发布、推送、网络、密钥或权限扩张会被阻塞。
- `local-unattested` Trace 证明“发生过什么”，不等价于操作系统沙箱证明。
- Dashboard 的 executor 标签依赖每个执行单元的有效调度凭据；只有 run-level
  profile 时只显示为“声明的执行配置”。
- 公共 Audit fixture 只用于校准，不能单独授权发布。

## 开发与验证

本仓库统一使用 pnpm：

```bash
corepack enable
pnpm install --frozen-lockfile

python3 -m unittest discover -s tests
pnpm test
pnpm dashboard:build
python3 skills/skill-reviewer/scripts/lint_skill_package.py \
  skills/skill-reviewer --format text --fail-on error
python3 skills/skill-reviewer/scripts/validate_local_snapshot.py \
  skills/skill-reviewer/evals/local-skill-review-snapshot.json
```

所有变更通过分支和 PR 进入 `main`。`Static Checks` 只运行确定性测试，不保存 API Key 或模型产物。Dashboard 由独立工作流构建为内容寻址的 GitHub Release asset；仓库不发布 npm 包，也不部署 GitHub Pages。

## 项目结构

```text
.
├── skills/skill-reviewer/   # skills add 安装的完整 Skill
│   ├── SKILL.md
│   ├── references/          # 规则、模板与运行协议
│   ├── scripts/             # linter、runtime、executor、Dashboard launcher
│   └── evals/               # Manifest、fixture 与 snapshot
├── dashboard/               # React / TypeScript / Vite 源码，dist 不入库
├── tests/                   # Python + Vitest
└── assets/readme/           # README 正式视觉资产
```

## 深入阅读

- [评审评分规则](./skills/skill-reviewer/references/review-rubric.md)
- [评审检查清单](./skills/skill-reviewer/references/review-checklist.md)
- [可执行 Eval、Trace 与证据契约](./skills/skill-reviewer/references/executable-evals.md)
- [Provider-neutral Agent Trace 契约](./skills/skill-reviewer/references/agent-trace-contract.md)
- [有界持续进化](./skills/skill-reviewer/references/evolution-workflow.md)
- [Dashboard 与行动中心](./skills/skill-reviewer/references/action-center.md)
- [SubAgent 成对验证](./skills/skill-reviewer/references/subagent-eval-workflow.md)

输出语言跟随请求。中文和英文模板会归一化为同一套机器可比较字段。

## License

MIT

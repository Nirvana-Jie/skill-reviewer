# skill-reviewer

> 用证据 Review Agent Skill，而不是只凭直觉判断。

[![skill](https://img.shields.io/badge/type-agent--skill-27272a)](./skills/skill-reviewer/SKILL.md)
[![tests](https://img.shields.io/github/actions/workflow/status/Nirvana-Jie/skill-reviewer/static-checks.yml?branch=main&label=checks)](https://github.com/Nirvana-Jie/skill-reviewer/actions/workflows/static-checks.yml)
[![release](https://img.shields.io/github/v/release/Nirvana-Jie/skill-reviewer?display_name=tag&sort=semver&label=release)](https://github.com/Nirvana-Jie/skill-reviewer/releases/latest)
[![stars](https://img.shields.io/github/stars/Nirvana-Jie/skill-reviewer?style=flat&label=star)](https://github.com/Nirvana-Jie/skill-reviewer)

[English](README.md)

![Skill Reviewer 流程：Skill、候选与基线成对执行、可验证证据、人工评审和本地 Dashboard](./assets/readme/skill-reviewer-evidence-flow-hero-v4.jpg)

Skill 是可以执行的 Workflow，不只是一份 Prompt。它会影响 Agent 如何理解任务、
调用工具、处理权限和判断任务是否完成。一个 Skill 即使“读起来合理”，真实执行时
仍然可能失败。

`skill-reviewer` 把现有 Skill 当作工程产物进行评审：默认先做只读包审查；只有明确
要求时才运行候选版与基线版的真实成对 Eval；最后保留 Diff、Trace 和原始产物，
帮助回答两个问题：

- **这个 Skill 现在是否值得使用？**
- **这次修改是否真的让它变得更好？**

## 适用场景

| 场景 | 可以这样问 |
| --- | --- |
| 引入或发布前评审 | “Review 这个 Skill，判断它是否可以发布。” |
| 定位不稳定行为 | “为什么这个 Skill 会误触发、不触发或调用错误工具？” |
| 验证一次修改 | “运行声明的 Eval，与已接受基线对比并展示证据。” |
| 审核 Eval 设计 | “这个 `evals.json` 真的测到了它声明的行为吗？” |
| 基于失败继续优化 | “根据已保留的失败生成下一候选，但不要修改 Eval。” |

输入可以是 Skill 目录、`SKILL.md`、单个配套资源或明确的设计方案。它不负责从零
创建 Skill，也不替代普通应用代码的 Code Review。

## 三种模式

| 模式 | 作用 | 边界 |
| --- | --- | --- |
| **Review（默认）** | 检查触发、指令、资源、脚本、安全和可维护性，并给出可执行改写 | 只读，不启动 Eval worker |
| **Verify（显式）** | 运行候选版和基线版 Eval，保留可观察执行证据 | 只有明确要求后才启动 |
| **Evolve（显式）** | 根据失败证据生成有界候选，并逐个验证 | Eval 权威不变，发布由人决定 |

## 快速开始

安装 Skill：

```bash
npx skills add Nirvana-Jie/skill-reviewer --skill skill-reviewer
```

然后直接告诉 Agent：

```text
Review 这个 Skill，判断它现在是否值得使用。
```

需要真实执行证据时再显式要求：

```text
运行这个 Skill 声明的 Eval，与已接受基线对比验证。
```

## 你会得到什么

一次完整评审会提供：

- 带证据等级和局限说明的明确判定；
- 覆盖触发、description、指令、资源、脚本、安全、输出和可维护性的 8 维评分卡；
- 按 `问题 / 原因 / 修复方式` 组织的关键问题；
- 触发分析、资源审查和可直接采用的改写；
- 运行真实 Eval 时的成对结果、Diff、Trace 和原始产物；
- 用于核查决策证据的可选本地 Dashboard。

## 设计原则

1. **先静态 Review。** 默认不执行目标 Skill、不安装它的依赖，也不启动 Eval
   worker。
2. **证据强度必须显式升级。** Review 保持只读；Verify 和 Evolve 可能使用本机
   认证、网络、模型时间或工具，因此只能由用户明确触发。
3. **候选与基线严格分离。** 二者接收相同 Case，在隔离工作区执行，不能参与对
   自己的评分。
4. **先验证尺子，再判断结果。** Manifest 非法、断言未校准、缺少调度凭据或证据
   不完整时，系统不会把结果归因给 Skill。
5. **证据模型与 Agent 无关。** 不同来源的事件先脱敏并归一化为可观察的消息、工具
   调用、命令、退出码、耗时和产物引用；不会保留模型私有思维链。
6. **最终决策属于人。** Runtime 负责评分，Dashboard 负责解释，发布和其它外部
   副作用由人确认。

Trace UI 不与 Codex 绑定。真实执行能力通过显式 Adapter 接入并标注来源：当前
Codex CLI 和 Claude Code 已通过 canary 验证；只完成协议调研的 Agent 不会被展示为
可执行支持。

## 本地 Dashboard

Dashboard 是只读的决策界面：

- **Review**：是否应该接受候选，以及为什么。
- **Diff**：具体修改了什么。
- **Trace**：Agent 实际执行了什么。
- **Audit**：保留的原始证据是什么。

它只监听回环地址，评审证据保留在本地。仅在用户明确要求时启动：

```bash
node skills/skill-reviewer/scripts/start_skill_dashboard.mjs \
  --workspace /tmp/skill-reviewer-run \
  --state /tmp/skill-reviewer-control/evolution-state.json \
  --user-approved-dashboard \
  --open
```

## 安全边界

- 被评审文件始终视为不可信数据。
- Review 模式不会运行目标脚本或扩大权限。
- Verify 和 Evolve 不能在运行中静默修改 Eval、基线、grader 或阈值。
- 凭据必须显式声明，会从留存输出中移除；一旦观察到泄漏，执行立即失败。
- 发布、推送、部署、破坏性命令和权限扩张必须由人确认。

## 深入了解

- [Skill 指令](./skills/skill-reviewer/SKILL.md)
- [评审评分规则](./skills/skill-reviewer/references/review-rubric.md)
- [验证流程](./skills/skill-reviewer/references/verification-workflow.md)
- [持续优化流程](./skills/skill-reviewer/references/evolution-workflow.md)
- [维护者架构](./docs/architecture.md)
- [参与贡献](./CONTRIBUTING.md)

## License

MIT

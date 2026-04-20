# skill-reviewer

`skill-reviewer` 是一个用于审查其他 agent skill 的技能。它会审计触发条件、说明质量、资源设计、安全约束、eval 覆盖率和可维护性，并尽量给出可以直接粘贴回去的修改建议，而不是泛泛而谈。

英文说明见 [README.md](README.md)。

## 这个 Skill 是做什么的

这个 skill 用来帮助 agent 审查一个已有的 skill 包，比如 Codex Skill、Claude Skill、ChatGPT Skill，或者任何以 `SKILL.md` 为核心的 agent skill。

激活后，它主要会做这些事：

- 审查 skill 的 `name`、`description` 和指令质量
- 找出过度触发和触发不足的问题
- 检查 `references/`、`scripts/`、`assets/` 等配套资源是否合理
- 评估安全约束和执行边界是否清晰
- 检查 eval 覆盖是否足够，并补充缺失的 eval prompt
- 输出结构化审查结果，并附上可直接复用的重写建议

## 适用场景

当你希望 agent 帮你处理下面这类请求时，这个 skill 很适合：

- “帮我看看这个 `SKILL.md` 能不能合并”
- “为什么我的 skill 触发得太频繁了”
- “为什么用户说 dashboard 的时候我的 skill 没有触发”
- “帮我审查这个 skill 目录，看看哪些地方有问题”
- “这个 skill 能算 production-ready 吗”
- “帮我收紧一下 description，减少误触发”

## 不适用的场景

这个 skill 不适合下面这些任务：

- 从零创建一个全新的 skill
- 直接执行 skill 背后的业务任务，而不是审查这个 skill 本身
- 和 skill 结构无关的普通 prompt 改写
- 面向应用代码或库代码的传统 code review

## 安装方式

这个仓库现在是一个放在根目录的单 skill package，可以直接通过 [`vercel-labs/skills`](https://github.com/vercel-labs/skills) 的 CLI 安装。

GitHub 仓库地址：[Nirvana-Jie/skill-reviewer](https://github.com/Nirvana-Jie/skill-reviewer)

从 GitHub 安装：

```bash
npx skills add Nirvana-Jie/skill-reviewer --skill skill-reviewer
```

安装前先列出仓库里的可用 skill：

```bash
npx skills add Nirvana-Jie/skill-reviewer --list
```

从本地仓库安装：

```bash
npx skills add . --skill skill-reviewer
```

全局安装而不是项目内安装：

```bash
npx skills add -g Nirvana-Jie/skill-reviewer --skill skill-reviewer
```

## 如何使用

安装完成后，直接用自然语言提出“审查某个 skill”的需求即可。只要你的请求和它的触发描述匹配，agent 就应该自动启用 `skill-reviewer`。

示例提示词：

- “请帮我 review 这个 `SKILL.md`，看看是否可以安装”
- “我的 skill 在所有 PDF 请求上都会触发，帮我排查一下”
- “帮我审计这个 skill 目录，看看哪些文件是多余的”
- “请从 trigger reliability 和 eval coverage 两个维度给这个 skill 打分”
- “我怀疑这个 skill 范围太大了，帮我审查并给出重写建议”

## 预期输出

这个 skill 的输出是结构化的审查结果，通常会包含这些部分：

- Executive Summary
- Verdict
- Scorecard
- Critical Issues
- Recommended Improvements
- Trigger Analysis
- Resource Review
- Suggested Description Rewrite
- Suggested Instruction Rewrite
- Eval Prompt Set
- Final Recommendation

它的目标不是只告诉作者“哪里不好”，而是尽量给出作者可以立刻采用的修改内容。

## 仓库结构

```text
SKILL.md
references/
  eval-prompts-template.csv
  example-review-output.md
  review-checklist.md
  review-rubric.md
README.md
README.zh-CN.md
```

## 附带参考资料

为了让 `SKILL.md` 保持聚焦，这个 skill 还带了几份参考资料：

- `review-rubric.md`：评分维度与 verdict 判定标准
- `review-checklist.md`：避免遗漏问题的平铺检查清单
- `example-review-output.md`：期望输出风格的完整示例
- `eval-prompts-template.csv`：建议 eval prompt 时使用的字段模板


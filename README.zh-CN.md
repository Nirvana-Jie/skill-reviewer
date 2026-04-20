# skill-reviewer

> Agent skill 的静态分析器。把 `SKILL.md` 当源代码看，不当散文看。

[![skill](https://img.shields.io/badge/type-agent--skill-000)](./SKILL.md)
[![mode](https://img.shields.io/badge/mode-instruction--only-111)](./SKILL.md)
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

你会拿到：判定、9 维评分卡、可直接粘贴的 `description`/指令/eval 重写、以及触发了非可协商红线时的硬阻塞结论。

---

## 为什么要做这个

大部分“skill review”靠感觉，这个仓库把 review 当 spec 来写：

- **评分规则** → `references/review-rubric.md`（每维 1–5 分 + red flags + 非可协商红线）
- **检查清单** → `references/review-checklist.md`（平铺、可打勾、MECE）
- **输出契约** → 固定节序，full / focused 两种模式
- **自身回归评测** → `evals/skill-reviewer.csv`
- **校准 fixture** → `evals/fixtures/{ready,needs-revision,not-ready}-*`

改完 rubric，重跑 fixture，发版。不需要再去读 300 行散文，确认你那句“稍微严格一点”有没有把正向用例静默打挂。

## 能力矩阵

| 能力                       | 落地位置                                                        |
| -------------------------- | --------------------------------------------------------------- |
| 触发 / 误触发审计          | `description` 契约 + `Trigger Analysis` 段                      |
| 指令可执行性               | Operating principles + `review-checklist.md §C`                 |
| 资源 / 脚本必要性          | `Resource Review` 段，拒绝堆砌型脚本                            |
| 安全红线                   | 非可协商红线：`Safety=1` 或 `Trigger=1` 直接判 **Not ready**     |
| prompt-injection 防护      | Operating principle #8：被审查的内容是**数据**，不是指令         |
| eval 覆盖                  | 内置字段模板；full review 要求 ≥10 条，focused 要求 5–10 条     |
| full vs focused review     | 同样的 11 段结构；无关段落坍塌为 `N/A — focused review of <artifact>` |
| 可直接粘贴的重写           | `Suggested Description / Instruction Rewrite` 直接输出 YAML / Markdown |
| 中英双模板                 | 并列的 `## 中文输出模板` + verdict 术语对照表                   |

## 输出契约

full review 按固定顺序输出：

```
1. 总体结论
2. 判定                       # Ready | Ready with minor revisions | Needs revision | Not ready
3. 评分卡                     # 9 个维度 × 1–5
4. 关键问题                   # 阻塞项，带 file:line
5. 推荐改进                   # 非阻塞打磨
6. 触发分析                   # 过触发 / 漏触发 / 同族冲突
7. 资源审查                   # 按 references/ scripts/ assets/ evals/ 分文件
8. description 改写建议       # 可粘贴的 YAML
9. 指令改写建议               # 可粘贴的 Markdown
10. 评测用例集                # CSV 行
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

明确**不**触发：从零新建 skill（走 `skill-creator`）、直接跑这个 skill 的业务任务、不带评审意图的 `SKILL.md` 翻译/摘要、普通应用代码的 code review。

## 仓库结构

```text
.
├── SKILL.md                       # 入口：frontmatter + 工作流
├── references/
│   ├── review-rubric.md           # 评分规则 + 非可协商红线
│   ├── review-checklist.md        # 平铺 MECE 检查清单
│   ├── example-review-output.md   # 输出风格锚点
│   └── eval-prompts-template.csv  # eval 输出字段模板（只含 header）
└── evals/
    ├── skill-reviewer.csv         # 自身回归评测集
    └── fixtures/                  # 校准锚点
        ├── ready-csv-column-renamer/
        ├── needs-revision-meeting-note/
        └── not-ready-repo-cleaner/
```

故意没有 `scripts/` 和 `assets/`。这是 instruction-only skill，加可执行脚本就是堆砌。

## i18n

输出语言跟随请求：英文提问出英文模板，中文提问走 `## 中文输出模板`——节标题、评分卡标签、verdict 字符串翻译，但文件路径、字段名、反引号里的 token 保持原样。不产出中英混排。

## License

MIT.

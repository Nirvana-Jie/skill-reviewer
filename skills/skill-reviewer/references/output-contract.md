# Review Output Contract

Match labels to the user's latest language. Preserve paths, identifiers, code,
and text inside backticks.

## Full review

Use the smallest structure that preserves the decision:

1. Decision / 判定 — verdict plus two to four evidence-backed reasons.
2. Scorecard / 评分卡.
3. Critical Issues / 关键问题.
4. Verification Evidence / 验证证据.
5. Proposed Changes / 修改建议 — paste-ready when possible.
6. Next Actions / 下一步 — one ordered list.

Add Trigger Analysis / 触发分析 or Resource Review / 资源审查 only when
that area has a material finding. Do not emit empty template sections.

The Scorecard contains exactly the rubric's eight dimensions and one evidence
sentence per score.

Every Critical Issue contains:

- **Problem / 问题** — exact file, field, or behavior.
- **Why it matters / 为何重要** — observable consequence.
- **Fix / 修复** — paste-ready change or bounded action.

Verification Evidence contains:

- Level / 级别 — exactly one of `not-run`, `inconclusive`,
  `behavior-verified`, or `regression-verified`; write the selected identifier
  once in the whole response.
- Subject / 对象 — path and digest when available.
- Static checks / 静态检查 — commands and results.
- Runs / 运行 — cases, arms, and repeats, or none.
- Baseline / 基线 — accepted old Skill, without-Skill comparison, unavailable,
  or not requested.
- Evidence / 证据 — retained artifacts and assertion summary.
- Limitations / 局限 — what remains unknown.

Proposed Changes are directly pasteable. Include executable Eval cases under
Next Actions only when their regression value justifies maintenance cost;
otherwise give one reason to defer.

## Focused review

Lead with the scoped conclusion, then include only findings, evidence, rewrites,
and next actions that help answer the question. Do not emit empty scorecards or
`N/A` sections merely to imitate the full-review template.

## Claim discipline

- Static facts, design scores, behavior evidence, and release decisions remain
  visibly separate.
- A screenshot or UI state is presentation evidence, not grading authority.
- Do not repeat unused verification identifiers while explaining limitations.
- Do not claim that a proposed rewrite has been validated unless retained runs
  support that statement.

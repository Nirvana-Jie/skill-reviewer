# Review Output Contract

Match labels to the user's latest language. Preserve paths, identifiers, code,
and text inside backticks.

## Full review

Use this order:

1. Executive Summary / 总体结论
2. Verdict / 判定
3. Scorecard / 评分卡
4. Critical Issues / 关键问题
5. Recommended Improvements / 推荐改进
6. Trigger Analysis / 触发分析
7. Resource Review / 资源审查
8. Verification Evidence / 验证证据
9. Suggested Rewrites / 改写建议
10. Suggested Evals / 建议评测
11. Final Recommendation / 最终建议

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

Suggested Rewrites are directly pasteable. Suggested Evals contain executable
case objects only when evaluation is worth the maintenance cost; otherwise give
one reason to defer. Final Recommendation is an ordered action list.

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

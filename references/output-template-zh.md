# 中文评审输出契约

完整使用以下节序和中文标签。focused review 也保留全部 section，超出范围的
section 写 `N/A — focused review of <scope>`。文件路径、字段名、标识符、代码和
反引号内 token 保持原文。

```markdown
# Skill 评审：<skill 名称>

## 总体结论
<2–4 句：job-to-be-done、整体质量、主要风险、发布建议。>

## 判定
<可发布 | 小幅修订后可发布 | 需修订 | 不可发布>

## 评分卡
- 触发可靠性：<1–5 分及证据>
- description 质量：<1–5 分及证据>
- 指令清晰度：<1–5 分及证据>
- 资源设计：<1–5 分及证据>
- 脚本必要性：<1–5 分及证据>
- 安全与约束：<1–5 分及证据>
- 输出质量：<1–5 分及证据>
- 可维护性：<1–5 分及证据>

## 关键问题
<编号列出。每条包含 **问题** / **为何重要** / **修复**。无则写 `无。`>

## 推荐改进
<非阻塞高价值项。无则写 `无。`>

## 触发分析
- 会触发于：
- 可能过度触发于：
- 可能漏触发于：
- 与可能的同族 skill 冲突：

## 资源审查
<逐文件审查 SKILL.md / references/ / scripts/ / assets/ / evals/。>

## 验证证据
- 级别：`not-run` | `inconclusive` | `behavior-verified` | `regression-verified`
- 对象：<路径、版本、digest，或“未记录”>
- 静态检查：<命令、结果、artifact，或“未运行”>
- 运行：<case 与配置，或“无”>
- 基线：<old_skill / without_skill / 不可用 / 未要求>
- 证据：<artifact 路径与断言摘要，或未运行原因>
- 局限：<剩余不确定性，或“无”>

## 改写建议
<可直接粘贴的 YAML description 和/或指令块，或写“无需改动”。>

## 建议评测（可选）
<5–10 行 prompt / should_trigger / expected_behavior / failure_modes_to_watch，或一行有理由的“不建议/暂缓”。>

## 最终建议
<有序行动列表。>
```

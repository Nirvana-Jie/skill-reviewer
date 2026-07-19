# Agent 执行与 Trace 协议调研

> 调研日期：2026-07-19
> 范围：只使用厂商官方文档、官方代码仓库或 OpenTelemetry 官方规范；本文描述的是可验证的观测能力，不把模型供应商等同于执行 Agent。

## 结论

`skill-reviewer` 不应继续以 `run_codex.*`、`run_claude.*` 之类的顶层脚本扩展 Agent 支持。正确的抽象边界是：

1. 通用执行器负责进程、超时、环境、退出状态、脱敏和证据封存。
2. Source Adapter 只解析某个 Agent 的公开输出或 Hook 格式。
3. Canonical Trace 层保留来源、能力差异和不确定性，再交给评分器。

Agent 是证据来源，不是模型供应商。比如 GitHub Copilot CLI 调用 Claude 模型时，`source_agent` 仍是 `github.copilot-cli`，`model_provider` 才可能是 `anthropic`。

截至调研日，Codex、Claude Code、Gemini CLI 都有可实现的机器可读执行流；OpenCode 有源码可证的精简 JSON 流；GitHub Copilot CLI 官方确认 JSONL 输出，但没有公开冻结其 CLI JSONL 字段契约，因此只能先作为 provisional adapter。OpenTelemetry GenAI 适合作为补充遥测，不足以替代原始执行证据。

## 官方证据矩阵

| 来源 | 非交互模式 | 官方机器流 | Tool 关联键 | 终止依据 | Hook | 稳定性边界 | 建议状态 |
|---|---|---|---|---|---|---|---|
| OpenAI Codex CLI | `codex exec --json` | JSONL；`thread.*`、`turn.*`、`item.*`、`error` | `item.id`；MCP/命令/文件变更均有类型化 item | `turn.completed` / `turn.failed`，同时校验进程退出 | 有；Pre/PostToolUse 等，JSON schema 可查 | 官方、类型化，但 CLI 仍演进；必须记录版本并容忍未知事件 | `ready` |
| Anthropic Claude Code | `claude -p --output-format stream-json --verbose` | NDJSON；`system`、`assistant`、`user`、`result`，可含 `stream_event` | `tool_use.id` ↔ `tool_result.tool_use_id` | 最终 `result` 加进程退出 | 有；Pre/PostToolUse 等 | 新字段与 capability 会随版本增加；部分内容受启动参数控制 | `ready` |
| Google Gemini CLI | `gemini -p --output-format stream-json` | JSONL；`init`、`message`、`tool_use`、`tool_result`、`error`、`result` | `tool_id` | `result.status` 加退出码 | 有；Before/AfterTool 等 | 官方类型清晰；Hook 与 stream 的关联能力不完全等价 | `ready-next` |
| GitHub Copilot CLI | `copilot -p --output-format=json` | 官方确认 JSONL，但 CLI 文档未公开冻结完整字段 schema | 不得在无公开字段证据时假设 | 进程退出；语义终止需 fixture/版本契约补证 | 有；pre/postToolUse，且兼容两套字段命名 | “有 JSONL”不等于“公开稳定 wire contract”；SDK 事件也不能冒充 CLI stdout | `provisional/raw-only` |
| OpenCode | `opencode run --format json` | 源码重编码的精简事件：`tool_use`、`step_start`、`step_finish`、`text`、`reasoning`、`error` | `part.callID` | CLI 在 session idle 时结束；以进程退出为边界 | 本次不作为必需证据 | 分支源码可证，但不是版本化 wire spec；流也不是完整内部 event bus | `experimental/reduced` |
| OpenTelemetry GenAI | OTLP logs/metrics/traces | `invoke_agent`、`execute_tool` 等 span | `gen_ai.tool.call.id`（采集时） | 不提供可靠的执行终止权威 | 不适用 | Agent/Tool span 仍为 development；采样、丢失、乱序、内容关闭均可能发生 | `telemetry-only` |

### 本机可用性抽查

仅执行了版本与帮助命令，未消耗模型调用额度，也没有把本机结果当作协议规范：

| CLI | 本机版本 | 说明 |
|---|---:|---|
| Codex CLI | `0.144.5` | 可发现 `exec --json` |
| Claude Code | `2.1.215` | 可发现 `stream-json` |
| Gemini CLI | 未安装 | 仅依据官方文档与固定提交源码评估 |
| GitHub Copilot CLI | `1.0.36` | 可发现 `--output-format` |
| OpenCode | `1.1.25` | 可发现 `run --format json`；协议判断仍以固定提交源码为准 |

“CLI 已安装”只证明可启动，不证明鉴权、配额、模型调用或每一种事件都已通过真实 canary。当前可执行 adapter 只接受表中完成真实 canary 的精确版本；升级后必须先失败关闭，再更新 fixture、真实 canary 与注册表版本策略。

## 各来源的稳定边界

### OpenAI Codex CLI

官方[非交互模式文档](https://developers.openai.com/codex/noninteractive)声明 `--json` 的 stdout 为一行一个事件的 JSONL。官方源码中的 [`ThreadEvent`](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/exec/src/exec_events.rs)进一步给出 `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.started|updated|completed` 与顶层 `error`。

边界：顶层 `error` 和 `turn.failed` 是执行失败信号；`item.type=error` 可能只是回合内非致命事件，不能看到字符串 `error` 就判整次运行失败。Hook 是控制侧通道，不等同于 `exec --json` 的执行流。官方 [Hooks 文档](https://developers.openai.com/codex/hooks)及固定提交上的 [`PreToolUse` schema](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json)可用于独立的 Hook adapter。

### Anthropic Claude Code

官方[无头模式文档](https://code.claude.com/docs/en/headless)定义 `--output-format stream-json` 的 NDJSON 输出；工具请求在 assistant content 中以 `tool_use` 出现，工具结果在 user content 中以 `tool_result` 出现。最终 `result` 包含最终响应和运行元数据。官方 [Hooks 文档](https://code.claude.com/docs/en/hooks)定义了 `session_id`、`hook_event_name`、`tool_name`、`tool_input`、`tool_response` 等字段。

边界：`thinking`、增量 token 和 subagent 文本是否出现取决于产品版本与启动参数。它们不是所有运行必有的评分证据。adapter 必须以 ID 配对工具调用，不能按工具名或相邻行猜测。

### Google Gemini CLI

官方[无头模式文档](https://github.com/google-gemini/gemini-cli/blob/acae7124bdd849e554eaa5e090199a0cf08cd782/docs/cli/headless.md)声明 `json` 与 `stream-json`；固定提交上的官方 [`output/types.ts`](https://github.com/google-gemini/gemini-cli/blob/acae7124bdd849e554eaa5e090199a0cf08cd782/packages/core/src/output/types.ts)定义了事件 envelope 与 `tool_id`、`result.status`、统计字段。官方 [Hook reference](https://geminicli.com/docs/hooks/reference/)定义 Before/AfterAgent、Before/AfterModel、Before/AfterTool 等输入输出。

边界：Hook reference 的工具事件并没有提供与 stream `tool_id` 等价的稳定调用 ID，因此两个通道不能仅凭工具名强行合并；无法精确关联时必须保留为独立证据并标注低置信度。

### GitHub Copilot CLI

官方[程序化使用文档](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)和[命令参考](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)确认 `--output-format=json` 输出 JSONL。官方 [Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)记录了 pre/postToolUse，并说明兼容 camelCase 与 Pascal 风格字段。

边界：公开 CLI 文档没有给出足以冻结 adapter 的完整 stdout JSONL 事件 schema。Copilot SDK 的 JSON-RPC/session 事件、ACP 协议或内部 `events.jsonl` 都是不同接口，不能未经证明映射成 CLI stdout。首版只应保存原始行、版本、退出状态和未知事件；取得真实 fixture 并固定支持版本后，才能提升到语义 adapter。

### OpenCode

固定提交上的官方 [`run.ts`](https://github.com/anomalyco/opencode/blob/78587c141bbac2c60b33c277359ba635b3410750/packages/opencode/src/cli/cmd/run.ts)显示 `--format json` 并非透传完整事件总线，而是选择性输出完成的 text/reasoning/tool part、step 边界与错误；官方生成的 [`types.gen.ts`](https://github.com/anomalyco/opencode/blob/78587c141bbac2c60b33c277359ba635b3410750/packages/sdk/js/src/v2/gen/types.gen.ts)可用于解释 part 类型。

边界：没有显式 `result`/`idle` stdout 事件，进程完成才是终止边界；只有 `--thinking` 时才输出 reasoning。必须记录 OpenCode 版本或源码提交，不能把 `main` 分支当前结构当成永久协议。

## OpenTelemetry GenAI 的定位

OpenTelemetry 官方 [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)提供跨供应商的属性命名；固定提交的 [Agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/c26a2c21d1ee70d5231bd440c7b48d3c94ee506a/docs/gen-ai/gen-ai-agent-spans.md)覆盖 `invoke_agent`，并定义 `execute_tool` 等观测语义。

它适合做聚合分析和补充验证，但不能作为 skill-reviewer 唯一执行协议：

- span 可能被采样、延迟、乱序或丢失；
- prompt、tool arguments/result 常因隐私默认不采集；
- 规范不负责启动命令、stdout 顺序、进程退出、Hook 决策和证据不可变性；
- 截至调研日，关键 Agent/Tool span 仍标记为 development。

因此它不进入执行 Agent adapter registry。若未来接入，应使用独立的 telemetry registry，并保持 `execute=false`、`terminal_authority=false`；只有实际采集到且通过 provenance 校验的字段才可作为补充观测。

## Provenance-aware adapter registry

建议注册表是数据而不是条件分支。示意 schema：

```json
{
  "schema_version": "1.0.0",
  "id": "openai.codex-cli.exec-jsonl",
  "source_agent": {
    "id": "openai.codex-cli",
    "product": "Codex CLI",
    "distribution": "codex"
  },
  "source_format": {
    "id": "codex.exec-jsonl",
    "transport": "stdio",
    "framing": "jsonl",
    "contract_version": "cli@0.144.5",
    "stability": "version-pinned",
    "official_sources": ["https://developers.openai.com/codex/noninteractive"]
  },
  "executor": {
    "command_template": ["codex", "exec", "--json", "{prompt}"],
    "version_probe": ["codex", "--version"],
    "required_flags": ["--json"],
    "terminal_authority": "event-and-process"
  },
  "capabilities": {
    "execute": true,
    "stream": true,
    "lifecycle": true,
    "session_id": true,
    "model_id": "conditional",
    "final_text": true,
    "usage": true,
    "tool_calls": "paired-by-id",
    "hooks": {"pre_tool": true, "post_tool": true},
    "subagents": "conditional",
    "explicit_terminal": true,
    "reasoning": "observable-only"
  },
  "provenance_requirements": {
    "agent_version": true,
    "executable_path": true,
    "executable_digest": true,
    "argv_digest": true,
    "cwd": true,
    "manifest_digest": true,
    "started_at": true,
    "finished_at": true,
    "exit_code_or_signal": true,
    "raw_stdout_digest": true,
    "raw_stderr_digest": true,
    "sanitized_trace_digest": true,
    "source_event_count": true,
    "parser_id_version_digest": true,
    "registry_entry_digest": true,
    "contract_urls": true,
    "environment_names_only": true,
    "redaction_and_leak_count": true
  }
}
```

`capabilities` 必须是可声明且可测试的，不允许 adapter 通过“尽力猜测”伪造支持。注册表至少还应校验：唯一 `id`、枚举合法、官方来源非空、执行型 adapter 必须有 version probe、`paired-by-id` 必须声明来源 ID 字段、`explicit_terminal=true` 必须声明终止事件。

## Canonical Trace 与归一化算法

统一事件最小结构：

```json
{
  "schema_version": "1.0.0",
  "run_id": "...",
  "sequence": 17,
  "observed_at": "2026-07-19T12:00:00Z",
  "kind": "tool",
  "phase": "end",
  "status": "success",
  "source_agent": "google.gemini-cli",
  "source_format": "gemini.stream-json",
  "source_event_type": "tool_result",
  "source_event_id": "call-1",
  "source_parent_id": null,
  "actor": "main",
  "payload": {},
  "source_payload_ref": "sha256:...",
  "provenance_ref": "run-provenance.json",
  "confidence": "exact"
}
```

归一化必须遵守以下确定性算法：

1. 按捕获顺序给原始字节分配单调 `sequence`，先计算摘要，再解析；时间戳不能替代顺序。
2. JSON/JSONL 解析失败生成 `source.parse_error`，不得静默丢行。需要机器流的 adapter 遇到解析错误应使证据完整性失败。
3. 只用来源提供的精确键关联工具调用：Codex `item.id`、Claude `tool_use.id`、Gemini `tool_id`、OpenCode `part.callID`。无键则保持未配对。
4. 通过有限状态机检查 `start → update* → end`；重复结束、无起点结束、ID 冲突都记录 anomaly，不自动“修复”。
5. 支持显式终止的来源必须同时满足“来源终止成功”和“进程成功”；OpenCode 等无显式终止能力者以进程边界为准并在能力中注明。
6. 未识别事件必须保留脱敏后的 source payload 或其内容寻址引用，不能在升级 parser 前丢失。
7. 每个映射标注 `exact`、`derived` 或 `heuristic`；评分默认只接受 `exact`，是否接受 `derived` 由 rubric 明示。
8. 只在能力交集内比较 Agent。缺失能力返回 `evidence_not_comparable`，不能计为失败或零分。
9. 原始流、脱敏流、parser、registry entry、manifest 分别摘要并写入 provenance，保证同一证据可重放。

## 可观测内容与推理边界

允许作为证据的是产品实际输出的消息、工具请求/结果、文件变更、usage、session/model 元数据、Hook 决策和错误。产品选择输出的 reasoning summary 或 thinking block 可以按隐私策略单独保存，但不能：

- 把它当作每个 Agent 的必需能力；
- 要求或重建隐藏 chain-of-thought；
- 依据最终答案反向合成“推理轨迹”；
- 在未记录启动参数时把“未出现”解释成“没有推理”。

默认评分应针对可验证行为与产物，而不是隐式思维过程。

## 实现与验证状态

| 工作项 | 状态 | 进入主路径前的验收条件 |
|---|---|---|
| 通用 executor 与 provenance envelope | 已实现，canary-verified | Codex 与 Claude 真实全链路 canary 已通过 |
| Registry schema/loader | 已实现 | 闭合注册、schema/能力约束、重复 ID、entry/registry digest 测试 |
| Codex exec JSONL adapter | 已实现，canary-verified | 固定 fixture 与真实 Dashboard 全链路均通过 |
| Claude stream-json adapter | 已实现，canary-verified | 固定 fixture 与真实 Dashboard 全链路均通过 |
| Gemini stream-json adapter | 可实现 | fixture 覆盖 warning/error/result、usage、tool 配对、exit code |
| Copilot CLI adapter | 受限 | 先保存真实脱敏 fixture并确认版本字段；公开契约不足前仅 raw/provisional |
| OpenCode adapter | 实验性 | 固定版本 fixture；验证 reduced stream、无 result、process terminal 语义 |
| Hook adapters | 分来源实现 | 每个来源独立 schema fixture；不得以字段相似为由共用未经验证的 parser |
| OTel ingestion | 独立 backlog | 使用独立 telemetry registry；明确 sampling/content policy 与原始 run provenance 关联 |

下一步顺序：在本机可安装、官方契约和固定 fixture 都满足时实现 Gemini。Copilot 保持 raw-only；OpenCode 作为实验性执行能力；OTel 留在独立 telemetry backlog。这样既不把产品差异塞进顶层脚本，也不会以“通用”为名抹掉来源事实。

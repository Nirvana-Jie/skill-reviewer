# Skill Review / Evolution 论文算法对齐审计

> 审计日期：2026-07-15
>
> 审计对象：[`RESEARCH_SKILL_REVIEW_EVOLUTION.md`](./RESEARCH_SKILL_REVIEW_EVOLUTION.md) 中引用的主要算法来源
>
> 证据范围：论文原文、论文作者明确链接的项目页和官方代码；不使用二手解读
> 本文只审计论文事实与设计转译，不审计仓库实现

## 结论

研究文档的总体方法论是可靠的：真实 paired execution 优先于文本印象、optimizer 与 executor/grader 分权、selection 与 final audit 分层、确定性断言优先、语义 judge 双向换位、eval 变更另开 run，这些方向都有一手证据支撑。

但它不是任何一篇论文的“算法复现”，而是组合多篇工作的保守发布治理算法。本轮审计识别并已经在主研究文档与实现中处理的关键问题有五类：

1. **SkillLens 数字的统计单元写窄了。** 25% 负迁移是 150 个 `domain × target × extractor` cells 中的比例，不是脱离 domain 的 extractor–target 组合；46.4% 是“与随机无显著差异”，不应写成“低于随机”；73.8% 来自同一批 151 个 high-gap pairs，不是独立外部 holdout。[SkillLens v1](https://arxiv.org/html/2605.23899v1)
2. **允许任意规模架构重写明确偏离 SkillOpt 的默认算法。** SkillOpt 把 bounded textual learning rate 当作稳定机制并做了消融。项目可以选择无界重构，但不能声称该选择获得了 SkillOpt bounded-update 实验的支持。[SkillOpt v2](https://arxiv.org/html/2605.23904v2)
3. **GEPA 的 Pareto 与项目发布 Pareto 不是一回事。** GEPA 在 validation instance 维度维护候选 frontier，用于采样后续 parent；项目的 hard gate + objective non-regression 是发布治理推论。`Dpareto` 完整评分也不是第二次接受门禁。[GEPA v2](https://arxiv.org/pdf/2507.19457v2)
4. **CoEvoSkills 的官方项目链接曾经错误。** 论文明确给出的项目页是 [CoEvoSkills 作者项目页](https://zhang-henry.github.io/CoEvoSkills/)，不是原文曾引用的 `evoskills.net`；后者还混入了另一篇 EvoSkill 与其代码，不能作为 CoEvoSkills 的官方实现证据。主研究文档现已改用作者项目页。[CoEvoSkills v2](https://arxiv.org/html/2604.01687v2)
5. **反馈边界标记只是缓解措施。** EACL 2026 论文支持“把 query 与 feedback 显式分界”，但没有验证 manifest digest、权限隔离或 typed channel 能完全阻断投毒；论文自己报告防御后攻击增量仍为 0.07，且主实验是单次运行。[Zhao et al., EACL 2026](https://aclanthology.org/2026.eacl-long.100/)

因此，适合项目采用的准确表述是：

> `skill-reviewer` 采用由 SkillLens、SkillOpt、GEPA、SkillsBench、CoEvoSkills、LLM-as-a-Judge 与 feedback-poisoning 研究共同启发的 evidence-bound release algorithm；它保留这些研究的可落实不变量，但对发布安全、评测不可变性和人工授权做了更保守的工程扩展。

不适合使用“复现 GEPA”“实现 SkillOpt 算法”或“论文证明该发布规则安全”等措辞。

## 审计口径

每项均区分四层：

- **论文原始主张**：论文实际实现、测量或明确讨论的内容。
- **研究文档转译**：仓库研究文档如何把论文事实转成设计。
- **可实现的不变量**：不依赖论文具体 benchmark、可进入工程 contract 的约束。
- **不可过度声称的边界**：论文未验证或只在窄设置中验证的内容。

“研究文档转译准确”不等于“当前实现已经满足”；实现对齐由单独的代码审计负责。

## 1. SkillLens：utility-grounded skill lifecycle

来源：[论文 v1](https://arxiv.org/html/2605.23899v1)；[官方代码](https://github.com/microsoft/SkillLens)

### 论文原始主张

SkillLens 把 skill utility 定义为同一 target、同一 held-out task split 上 `with_skill - no_skill` 的任务指标变化。主实验覆盖 5 个 domain、6 个 target、5 个 extractor；每个评测条件运行 3 次并取平均。它研究的是由 target 自身经验抽取出的单一 domain-level skill，直接注入 target，而不是大型 skill library 的检索、组合和干扰。[论文 §3–4 与 Appendix A/B](https://arxiv.org/html/2605.23899v1)；[官方 inference CLI](https://github.com/microsoft/SkillLens/blob/c5ee10f6b566cd2ccf96f7cef115eba59606b01b/skilllens/cli/infer.py#L27-L35)

论文报告 150 个 `domain × target × extractor` cells 中，75% 为正向、25% 为负迁移；不同 domain 的负迁移比例从 13% 到 47% 不等。因此统计单元包含 domain，不能缩写为抽象的 extractor–target pair。[论文 §4.2](https://arxiv.org/html/2605.23899v1)

无 rubric 的 GPT-5.4 文本 judge 在 151 个同 `(target, domain)`、utility gap 超过 0.5pp 的 skill pairs 上准确率为 46.4%，论文表述为与随机选择不可区分。每个 pair 做 9 次独立判断后多数表决，展示顺序随机化。它不是“显著低于随机”。[论文 §5.2 与 Appendix E](https://arxiv.org/html/2605.23899v1)

论文从 utility-labelled pairs 中筛出 Failure Mechanism Encoding、Actionable Specificity、High-Risk Action Blacklist 三个维度；在同一批 151 个 high-gap pairs 上加入该 rubric 后，同一个 GPT-5.4 judge 的准确率从 46.4% 升至 73.8%。这验证了该数据分布内的预测信号，但不是独立外部 holdout 校准。[论文 §6 与 Appendix H](https://arxiv.org/html/2605.23899v1)；[官方三维 rubric](https://github.com/microsoft/SkillLens/blob/c5ee10f6b566cd2ccf96f7cef115eba59606b01b/data/meta_skills/quality_rubric_3dim.md#L1-L20)

论文的格式消融只在 SpreadsheetBench 上把同一 skill 改写为 ordered list、unordered list、checklist 和 prose；对 6 个 targets、3 轮运行做 Friedman test 后未发现显著格式效应。它不能证明所有 domain、所有多文件 skill package 的 surface form 都无关。[论文 Appendix C](https://arxiv.org/html/2605.23899v1)

all-failure experience pool 在论文该项消融中持续最差，但该结论来自固定 GPT-5.4-mini extractor、3 个 domains、3 个 targets；最佳 success/failure 混合比例随 domain 变化。[论文 §5.1](https://arxiv.org/html/2605.23899v1)

### 研究文档转译

准确的部分：

- 用 downstream behavior 而不是文本审美作为最终 utility。
- 绑定 target、domain、harness/configuration，按 cell 保留结果。
- 成功与失败轨迹都可进入 development evidence，但不能只从失败轨迹抽取。
- 静态 rubric 需要用项目自身 paired outcomes 校准。

审计时发现并已修订的部分：

- “25% extractor–target 组合/单元”应改为“25% 的 `domain × target × extractor` cells”。
- “无 rubric judge 低于随机”应改为“46.4%，与随机选择无显著差异”。
- 73.8% 后应补充“同一批 151 个 high-gap pairs、同一 GPT-5.4 judge”，避免读成外部泛化结果。
- all-failure 结论应带上固定 extractor、3 domains × 3 targets 的范围。

### 可实现的不变量

1. 所有效果结论必须来自同 task split、同 target、同 harness 和同 grader 的 paired execution。
2. `target × harness × domain/case` cell 单独判定，不用 macro average 覆盖局部负迁移。
3. 文本 judge 只作经过 utility 校准的风险诊断器，不能单独授予 `improved`。
4. 运行次数是 manifest 参数；论文的 3 repeats 不是统计充分性的通用定理，证据不足时仍应 `inconclusive`。
5. 对已有 skill，可增加 `old_skill` arm；但这是项目扩展。SkillLens 直接验证的是 `with_skill` 对 `no_skill`。

### 不可过度声称的边界

- 不能把 25% 当成本项目或任意 skill 系统的预期负迁移率。
- 不能说三维 rubric 在本项目也有 73.8% 准确率。
- 不能说三次重复足以证明随机任务稳定。
- 不能把单一 skill 直接注入实验外推为大型 skill library 的检索与组合结果。
- 不能说 surface form 在所有 skill package 中无关。

## 2. SkillOpt：bounded text-space optimization

来源：[论文 v2](https://arxiv.org/html/2605.23904v2)；[官方代码](https://github.com/microsoft/SkillOpt)

### 论文原始主张

SkillOpt 冻结 target model、backend、harness 与 benchmark evaluator，只训练一个自然语言 skill。独立 optimizer 分别分析 success/failure minibatches，提出结构化 add/delete/replace edits，合并并排序后受 textual learning-rate edit budget 约束，再由 held-out selection gate 决定是否接受。[论文 Method 与 Appendix A](https://arxiv.org/html/2605.23904v2)

默认论文路径为 4 epochs、rollout batch 40、reflection minibatch 8、edit budget 4、cosine decay floor 2、每 epoch 20 个样本做 slow update。候选只有在 selection score **严格高于** current skill 时才接受，平局拒绝。train 提供 rollout evidence，selection 选择候选，test 仅作最终报告。[论文 §3–4 与 Experimental Details](https://arxiv.org/html/2605.23904v2)；[官方 gate](https://github.com/microsoft/SkillOpt/blob/57333f3406436a90a2b5feec4aad74ddb33d6e85/skillopt/evaluation/gate.py#L135-L225)

被拒编辑不是下一版 skill 的 parent，但其 failure patterns、编辑内容和 score drop 进入 epoch-local rejected buffer；官方实现还保留逐 edit 的 `edit_apply_report.json`。该记忆用于避免重复有害方向，不增加部署时调用。[论文 §3.5](https://arxiv.org/html/2605.23904v2)；[官方 apply report](https://github.com/microsoft/SkillOpt/blob/57333f3406436a90a2b5feec4aad74ddb33d6e85/skillopt/engine/trainer.py#L1373-L1397)；[官方 rejected buffer](https://github.com/microsoft/SkillOpt/blob/57333f3406436a90a2b5feec4aad74ddb33d6e85/skillopt/engine/trainer.py#L1552-L1584)

论文消融支持 bounded edit、rejected buffer 和 slow/meta update 对其 benchmark 设置下的稳定性与效果有贡献；作者同时明确承认，该方法依赖可靠自动分数，并且主要优化单一 compact skill。开放式、多维、主观任务需要更强的人类或模型评估。[论文 §4.2 与 Limitations](https://arxiv.org/html/2605.23904v2)

### 研究文档转译

准确的部分：

- target/optimizer 分离和执行配置冻结。
- success/failure evidence 分开分析。
- selection 严格提升、tie reject、test 最终报告。
- rejected edits 形成负反馈，best accepted candidate 始终可回滚。
- transfer 证据范围有限，跨明显不同配置需重新 held-out 验证。

明确偏离论文的部分：

研究文档选择“不设置人为行数或 diff 大小上限，允许重构完整 runtime surface”。这是产品设计选择，但它与 SkillOpt 默认算法中的 bounded textual learning rate 相反。当前 SkillOpt 官方代码后来出现 `autonomous` 和完整 rewrite 路径，也不能倒推为 v2 论文已经验证无界重写的稳定性。[论文 §4.2](https://arxiv.org/html/2605.23904v2)；[官方 scheduler 对 bounded/autonomous 的区分](https://github.com/microsoft/SkillOpt/blob/57333f3406436a90a2b5feec4aad74ddb33d6e85/skillopt/optimizer/scheduler.py#L1-L19)

研究文档现已明确写为：

> 本项目允许架构级候选重写，这是对 SkillOpt 默认 bounded-edit 算法的有意偏离；项目以轮数、selection 查询预算、完整回归和严格发布 gate 控制风险，不声称继承 textual learning-rate 的稳定性结论。

若希望兼容“大改动”与论文的连续性原则，可以采用“变更风险预算”而不是行数限制：每轮只容纳一个可证伪 mutation hypothesis；若候选跨越预设结构距离，则重置 optimizer continuity/rejected-buffer lineage，以完整 baseline 重跑，而不是假装它仍是小步更新。

“optimizer 不能读取 selection 内容”和“rejected buffer 不泄漏 hidden assertions”是合理的安全增强，但不是 SkillOpt 论文直接证明的防污染机制。论文会用 selection score 进行 gate，并把 score drop 写入 buffer。[SkillOpt v2](https://arxiv.org/html/2605.23904v2)

### 可实现的不变量

1. optimizer、executor、grader 权限分离；target、harness、evaluator、splits 在 run 内冻结。
2. 候选只写 candidate workspace，不能原地覆盖 accepted skill。
3. tie、噪声持平和 no-material-change 不接受。
4. current best、parent digest、candidate digest、patch/apply report 和 supporting trace IDs 可追溯。
5. rejected candidate 不成为 active parent；rejected feedback 只进入受控 development 通道。
6. test/audit 不参与当前 run 的后续更新。
7. 若保留无界重构，必须显式声明这是 algorithm deviation，并在大重构后重置需要“相邻版本连续性”才能成立的优化记忆。

### 不可过度声称的边界

- 不能说 SkillOpt 证明了任意规模架构重写的稳定性。
- 不能把其有限正向 transfer 当作跨模型/跨 harness 普遍规律。
- 不能说语义 judge score 可以替代可靠 verifier。
- 不能把后续官方代码的实验模式归因于 v2 论文已验证设计。

## 3. GEPA v2：instance-wise Pareto exploration

来源：[论文 v2 PDF](https://arxiv.org/pdf/2507.19457v2)；[官方代码](https://github.com/gepa-ai/gepa)

### 论文原始主张

GEPA 把 `Dtrain` 分为 `Dfeedback` 与 `Dpareto`。每轮从候选池选择 parent，在 `Dfeedback` minibatch 上执行、收集 execution/evaluation traces 和文本反馈、反思并更新 prompt；只有新候选在该 minibatch 上优于 parent，才进入完整 `Dpareto` 评分并记录 ancestry。[论文 Algorithm 1](https://arxiv.org/pdf/2507.19457v2)；[官方 acceptance strategy](https://github.com/gepa-ai/gepa/blob/ad4611359bd203b3ca171ad45ca17ae9d9108e4f/src/gepa/strategies/acceptance.py#L39-L48)

`Dpareto` 的完整评分不是第二次“通过/拒绝” gate。minibatch 改善的候选会进入 pool；`Dpareto` 用于构造逐 validation instance 的分数矩阵、frontier sampling 和最终 aggregate-best 选择。[论文 Figure 3 / Algorithms 1–2](https://arxiv.org/pdf/2507.19457v2)

GEPA v2 的 Pareto 轴不是 latency/safety/success 等业务 objective。它先对每个 validation instance 保留该实例最高分候选，移除严格支配候选，再按候选出现在各 instance frontier 的频率随机采样。这是在搜索阶段维持候选多样性的算法。[论文 Algorithm 2](https://arxiv.org/pdf/2507.19457v2)

实验另有标准 train/validation/test 分层：optimizer 能使用 train feedback，并观察 validation selection score；test 用于最终泛化报告。v2 核心评测覆盖 6 个 tasks、Qwen3 8B 与 GPT-4.1 Mini。摘要中的相对 GRPO 平均约 +6%、最高约 +20%、最高 35× 更少 rollouts，均受该实验范围限制。[论文 v2 §4–5](https://arxiv.org/pdf/2507.19457v2)

### 研究文档转译

准确的部分：

- 利用 execution trace 与 evaluation trace 进行自然语言反思。
- minibatch 快筛后才支付完整 `Dpareto` 评分成本。
- 保留 candidate pool、ancestry，并通过 instance frontier 避免始终贪心选择全局最佳。
- 已明确说明发布多目标非退化是项目推论，不是 GEPA 原样复刻。

审计时发现并已收紧的部分：

- “完整验证”应改成“完整 `Dpareto` 评分与 frontier 更新”，避免误解为 GEPA 在 full set 上再次 gate。
- “SkillOpt/GEPA 证明 held-out gating 有效”应改为“在各自实验设置中提供 held-out selection/generalization 的正向实证”。GEPA 的 pool admission gate 实际发生在 minibatch。
- “Pareto front 保留在至少一个实例上领先且不被严格支配的候选”基本准确，但必须同时说明最终返回的是 `Dpareto` aggregate-best，frontier 主要决定搜索 parent。

项目的 hard gate + 多业务 objective non-regression 比 GEPA 更像发布控制层。它可以与 GEPA-style search 串联，但不能被称为“GEPA Pareto 算法”。当前官方代码后续增加显式 `objective_scores` frontier，也属于论文之后的实现扩展，不能倒推成 v2 已验证该发布规则。[官方 objective frontier](https://github.com/gepa-ai/gepa/blob/ad4611359bd203b3ca171ad45ca17ae9d9108e4f/src/gepa/core/state.py#L474-L508)

### 可实现的不变量

1. fast screen 必须让 candidate 与 parent 在同一 minibatch、同一配置下比较。
2. 只有 strict minibatch improvement 才值得支付完整 suite 成本。
3. 每个候选保留 ancestry；若声称采用 GEPA-style exploration，应实际维护 candidate pool 与 per-case score matrix，而不是只有一条 current-best 链。
4. exploration frontier 与 release gate 分层：前者保留搜索多样性，后者执行 hard gates 与 baseline non-regression。
5. optimizer 只获得 development feedback；validation 内容不进入反思上下文，test/audit 不回流。
6. 所有循环受 rollout/query/cost budget 控制。

### 不可过度声称的边界

- GEPA 的 frontier 不是安全证明，也不保证每个 validation instance 不退化。
- minibatch 改善的候选在完整 `Dpareto` 上可能变差，但仍可进入候选池。
- aggregate-best 不等于项目定义的 multi-objective baseline dominance。
- 只实现单链 propose/evaluate/reject 不能称为复现 GEPA 的 candidate-pool exploration。

## 4. SkillsBench：matched conditions 与 deterministic verifier

来源：[论文当前 v4](https://arxiv.org/html/2602.12670v4)；[官方项目](https://www.skillsbench.ai/)

### 论文原始主张

当前 v4 inventory 为 87 个 containerized tasks、8 个 domains、18 个 model–harness configurations；每个 task 有固定数据、oracle solution 与 deterministic verifier。主协议在相同 task/environment 下比较 no-Skills 与 curated-Skills，当前 frame 以每个 cell 三个公开 trials 计算 paired delta。[论文 §3–5 与 Appendix N](https://arxiv.org/html/2602.12670v4)

每个 `(configuration, task, condition)` 使用 fresh pinned container；deterministic test script 在 agent 完成后评分。超时只在没有健康 replacement 时计失败，unscored/stale/rate-limited 视为 coverage gap。[论文 §4](https://arxiv.org/html/2602.12670v4)

当前 v4 报告 13/87 tasks 有负 delta，并把常见机制归为：过重 pipeline 挤掉简单路径、skill 覆盖更强 native strategy、skill 指向 agent 无法调试的 brittle solver。这支持逐 task/cell 检查负迁移，不支持把 aggregate gain 当成单个 skill 的保证。[论文 §5.1.3 与 Appendix F.3](https://arxiv.org/html/2602.12670v4)

self-generated diagnostic 中，`fix-visual-stability` 的最强正向个案来自 creator 在被评分 sandbox 中写入具体 offender components、`data-testid` 和修复顺序；论文将其判为当前实例答案键，而非可复用 skill。该案例证明泄漏可以制造表面收益，但不等于所有 self-generated skill 都泄漏。[论文 Appendix D.6.1](https://arxiv.org/html/2602.12670v4)

### 研究文档转译

研究文档对 matched conditions、fresh container、deterministic verifier、harness effect、negative transfer 和答案键污染的使用是准确的。

本轮已补充版本固定。`https://arxiv.org/html/2602.12670` 会随预印本修订；当前 v4 的 task/domain/config 数字已经不同于早期版本。研究 artifact 现记录 `2602.12670v4` 与访问日期，避免来源漂移。[arXiv v4](https://arxiv.org/abs/2602.12670v4)

研究文档建议加入 `old_skill` 和三臂 candidate/old/no-skill，是合理的 release 扩展；SkillsBench 本身的核心因果对照是 curated-Skills 对 no-Skills，不验证版本演进的 old-skill gate。[论文 v4](https://arxiv.org/html/2602.12670v4)

### 可实现的不变量

1. paired arms 除 skill access 外共享 task、container/configuration、资源、grader 与 trial frame。
2. 每个 arm/repeat 使用 fresh workspace，不复用跨 arm 状态。
3. 确定性 verifier 是具体行为事实的首选；缺失或不健康 trajectory 是 coverage gap，不得静默当 pass。
4. task 与 reusable skill 独立创作；防止当前实例 filename、path、magic number、expected output 进入 skill。
5. 按 task 和 model–harness cell 展示结果，保留负 delta，不只给 macro average。

### 不可过度声称的边界

- 不能把 terminal/container 结果直接外推到 GUI、多 agent 或超长时域任务。
- 不能把 13/87 当作普遍负迁移率。
- 不能说 fresh container 单独解决训练数据污染或公开 fixture 记忆。
- 不能用一个泄漏案例概括所有 self-generated skill。
- 不能把三次公开 trials 当作所有随机任务的充分样本量证明。

## 5. CoEvoSkills：co-evolving surrogate 与 opaque oracle

来源：[论文 v2](https://arxiv.org/html/2604.01687v2)；[作者明确给出的官方项目页](https://zhang-henry.github.io/CoEvoSkills/)

### 论文原始主张

CoEvoSkills 由 Skill Generator、独立 Surrogate Verifier 与 orchestrator 组成。verifier 只观察 task instruction 和执行 output files，不继承 generator 的 reasoning、code 或 skill content；它生成并演进 deterministic assertion suite，提供逐断言诊断。[论文 §3.3](https://arxiv.org/html/2604.01687v2)

当 surrogate fail 时，固定当前 surrogate tests，把结构化失败诊断反馈给 generator 以修 skill；当 surrogate pass 而 hidden ground-truth oracle fail 时，oracle 只返回 opaque pass/fail，不暴露 test content，触发 verifier test escalation 与下一轮演进。oracle 在 fresh environment 中重新执行，是权威判断者。[论文 Algorithm 1 与 §3.3](https://arxiv.org/html/2604.01687v2)

案例中 surrogate 15/15 全过而 ground-truth oracle 只有 3/4；后续 surrogate 又因自身数值估计误差拒绝了更准确的 TLS 输出。论文据此明确指出 surrogate 无法复制 hidden precision，也无法总是区分自身错误与 agent 错误，ground-truth oracle 仍不可替代。[论文 Appendix E](https://arxiv.org/html/2604.01687v2)

论文的 ablation rows 因成本只运行一次；多数任务在少量 oracle rounds 内收敛、超过 3 轮收益递减，是该 86-task evolution distribution 的观察，不是“三轮对所有 skill 最优”的定理。[论文 Appendices B/C](https://arxiv.org/html/2604.01687v2)

### 研究文档转译

准确的部分：

- generator/verifier 信息隔离。
- surrogate 适合作为低成本筛选与细粒度诊断，不能替代 authoritative oracle。
- oracle failure 不泄漏 test content。
- surrogate 与 oracle 分歧应保留，不应为让候选通过而改权威断言。

审计时的明确错误（已修正）：

- “官方项目”应由 `https://evoskills.net/` 改为论文脚注明确给出的 [https://zhang-henry.github.io/CoEvoSkills/](https://zhang-henry.github.io/CoEvoSkills/)。`evoskills.net` 页面把 CoEvoSkills/EvoSkills 与另一篇 EvoSkill、另一仓库混在一起，不能作为本论文的官方代码或算法证据。[论文首页脚注](https://arxiv.org/html/2604.01687v2)

已经明确的算法差异：

- CoEvoSkills 会演进 **surrogate tests**；研究文档要求 run 内 **authoritative eval assets 不可变**。两者并不矛盾，前提是把 `development_surrogate` 与 `selection/audit_oracle` 分成不同信任域：前者可演进，后者冻结。
- CoEvoSkills 会让 opaque oracle fail bit 回到同一个 evolution loop；项目要求 final audit 一旦执行就不再回流当前 run。这是更保守的抗污染策略，不是论文原算法。

### 可实现的不变量

1. `development_surrogate` 与 `authoritative_oracle` 使用不同 artifact 类型、权限和生命周期。
2. surrogate 只看 task input 与 execution outputs；不看 generator reasoning、candidate content、hidden assertions 或 expected output。
3. surrogate tests 可以演进，但不得写入或替代冻结 selection/audit assertions。
4. authoritative oracle 在 fresh workspace 独立重跑，只暴露预定粒度的 signal。
5. surrogate/oracle disagreement 保留为 evidence；surrogate 不能越权覆盖 oracle。
6. 若采用项目的一次性 audit 规则，必须标为 anti-contamination extension，而不是 CoEvoSkills 原样复现。

### 不可过度声称的边界

- surrogate pass 不是 ground-truth pass。
- 多个 LLM verifier 不能把共同盲点变成事实。
- 论文的 cross-model gains、平均收敛轮数与单次 ablation 不能直接外推到本项目。
- 完全冻结所有 grader 并不等于实现了 CoEvoSkills；其核心之一恰是 development surrogate co-evolution。

## 6. Judging LLM-as-a-Judge：顺序、冗长与 reference

来源：[论文](https://arxiv.org/html/2306.05685)；[官方 FastChat judge 代码](https://github.com/lm-sys/FastChat/tree/main/fastchat/llm_judge)

### 论文原始主张

论文在 MT-Bench/Chatbot Arena 设置中观察到 position bias、verbosity bias、self-enhancement bias 与推理限制。交换 A/B 后，GPT-4 在相似回答 benchmark 中只有约 65% consistency；重复同一信息的 “repetitive list” 能误导部分 judges 偏好冗长回答。[论文 §3.3](https://arxiv.org/html/2306.05685)

作者提出的保守 pairwise 策略是换位调用两次：只有同一 candidate 在两个顺序中都获胜才判 win；结果不一致时记 tie。项目把不一致升级为 `inconclusive`，属于更保守的发布政策，不是论文术语。[论文 §3.4](https://arxiv.org/html/2306.05685)

reference-guided 方法针对 math/reasoning：先让 judge 独立求解，再把该回答作为 reference 放入 judge prompt；它把论文小型 math 测试的 failure rate 从 70% 降到 15%。这不是对所有开放式 agent review 都已验证的万能 answer key。[论文 §3.4](https://arxiv.org/html/2306.05685)

### 研究文档转译

匿名化、A/B 双向换位、分歧不判胜、固定 judge/rubric provenance、语义 judge 不独占 release decision，均是合理转译。

审计时发现并已收紧：

- “分歧则 inconclusive”应标为项目政策；原论文称 tie。
- “reference-guided”应限定到存在可独立求解 reference 的维度，不要等同于给 judge hidden expected output。
- 该论文评估的是较早模型上的对话偏好，不能直接证明 agent artifact judge 的误差率。

### 可实现的不变量

1. pairwise semantic judgment 盲化 candidate identity 与 ancestry。
2. 同一 evidence packet 做 A/B 与 B/A 两次判断；只有映射还原后方向一致才形成偏好。
3. 换位冲突、非法输出、缺失 artifact 或 rubric binding 不匹配均不形成 pass。
4. 能确定性判断的要求先走 deterministic grader；语义 judge 只覆盖剩余维度。
5. judge identity、execution profile digest、prompt、rubric 与输入 artifact digests 进入 provenance；不要求 subagent 自报版本。

### 不可过度声称的边界

- 双向换位只缓解 position bias，不消除 verbosity、自偏好、共同错误或推理错误。
- judge consistency 不等于 accuracy。
- 旧 GPT-4/MT-Bench 数字不能外推到当前模型或 skill review。
- reference-guided judge 仍不是 ground truth。

## 7. Feedback poisoning：优化反馈本身是攻击面

来源：[EACL 2026 正式论文页](https://aclanthology.org/2026.eacl-long.100/)；[论文 PDF](https://aclanthology.org/2026.eacl-long.100.pdf)

### 论文原始主张

论文研究 query manipulation、feedback manipulation 与 fake reward。主设置使用 HarmBench 的 100 train / 300 test split、GPT-4.1 作为 optimizer 与 inference backend、TextGrad、greedy decoding，完整 optimization trial 只运行一次；另用 Trace 验证另一类 optimizer，并用 GPT-5.1 做有限 robustness check。[论文 §2–3 与 Limitations](https://aclanthology.org/2026.eacl-long.100.pdf)

feedback manipulation 最高使攻击成功率增量达到 0.48。fake reward 无需控制真实 reward model，而是在 query 内追加看似真实的 `<FEEDBACK>` token，使增量从 -0.02 变为 0.23。[论文 §3.3–3.4](https://aclanthology.org/2026.eacl-long.100.pdf)

highlighting defense 用 `<query>...</query>` 显式标记 query/feedback 边界，把 fake-reward 增量从 0.23 降至 0.07，同时没有观测到 utility 损失。作者明确说该防御只缓解而未完全阻止攻击；研究主要覆盖 harmfulness，未覆盖 truthfulness、bias、misinformation、agentic 或 multi-agent setting。[论文 §3.4、Future Work 与 Limitations](https://aclanthology.org/2026.eacl-long.100.pdf)

### 研究文档转译

准确的部分：

- optimizer feedback 是一等攻击面。
- task input、execution trace、grader result 与 optimizer feedback 应显式分界。
- 被测输出中自报的 score/feedback 不能成为权威控制信号。
- 边界标记只能缓解，不应声称完全防御。

审计时发现并已收紧：

- 论文直接验证的是文本序列化边界，不是 cryptographic digest、filesystem isolation、schema validation 或 capability sandbox。后者是合理的系统安全推论，但必须标成项目扩展。
- “一个主要 backend 和两类 optimizer”基本准确，但应说明另有 GPT-5.1 robustness check；所有完整 trial 单次运行，方差未量化。
- 论文的 attacker 有特定 query/feedback 控制能力，不能从中推出所有 eval drift 都是攻击。

### 可实现的不变量

1. optimizer input 使用 typed envelope；`task_input`、`execution_output`、`grader_result`、`optimizer_feedback` 不靠自由文本标签猜测类型。
2. grader result 只由受信 grader 写入；executor output 内的 `<FEEDBACK>`、score 或 assertion result 一律按不可信数据处理。
3. feedback schema、producer identity、artifact digest 与 run binding 均验证后再进入 optimizer。
4. 多 metric/独立 grader 的异常分歧触发 `inconclusive`，不把被投毒的单一 scalar 当唯一方向。
5. query/feedback 分界与权限、digest、只读挂载共同使用；任何单项都不能被描述为完整防御。

### 不可过度声称的边界

- 不能说 `<query>` 标签或 typed JSON 已阻止 feedback poisoning。
- 不能把单一主要 backend、单次运行、harmfulness benchmark 的效果数字外推到 agent skill evolution。
- 不能说 manifest immutability 是该论文实验证明的防御；它是基于 threat model 的工程加固。
- 不能说多个 metrics 必然识别投毒；论文只把它作为未来方向。

## 8. 跨论文可组合的算法不变量

将这些论文组合后，可以形成以下最小算法 contract；它比“引用了相同术语”更适合用来判断设计是否对齐。

### 8.1 数据与权力分层

```text
development
  ├─ optimizer 可见详细 execution/grader feedback
  ├─ 可选：可演进的独立 surrogate verifier
  └─ 只产生 candidate hypothesis，不授予发布结论

selection
  ├─ 内容与 assertions 对 optimizer 隐藏
  ├─ candidate / old_skill / no_skill matched execution
  └─ hard gates + baseline delta 决定 current best

audit/test
  ├─ 一次性或严格限次
  ├─ 不回流当前 optimizer
  └─ 只作最终发布证据
```

该分层综合了 [SkillOpt](https://arxiv.org/html/2605.23904v2)、[GEPA](https://arxiv.org/pdf/2507.19457v2)、[SkillsBench](https://arxiv.org/html/2602.12670v4) 与 [CoEvoSkills](https://arxiv.org/html/2604.01687v2)，但“一次性 audit 不回流”是项目更保守的 anti-contamination policy。

### 8.2 候选生成与搜索

- candidate 由 execution evidence 驱动，不由静态审美分数驱动。[SkillLens](https://arxiv.org/html/2605.23899v1)
- success 与 failure evidence 分开分析，rejected direction 留作负反馈。[SkillOpt](https://arxiv.org/html/2605.23904v2)
- 快筛比较 candidate 与 parent 的同一 minibatch；完整 selection 只为通过快筛的候选付费。[GEPA](https://arxiv.org/pdf/2507.19457v2)
- 如果维护多个研究候选，必须保留 candidate pool、ancestry 与 per-case score matrix；否则不要声称 GEPA-style Pareto exploration。
- 如果允许架构级重写，应以明确 mutation hypothesis、完整回归和 lineage reset 约束，而不是声称仍拥有 SkillOpt bounded-step 的连续性保证。

### 8.3 接受与发布

- static/safety/package integrity 是 hard gates，不能被 aggregate utility 抵消。
- 对每个 required cell 先判断 paired evidence 完整，再判断 baseline non-regression。
- 至少一个 primary objective 达到预注册的 material improvement；tie/noise 不接受。
- semantic judge 仅补充不可确定性断言，并执行 blind A/B swap；分歧不形成发布 pass。[LLM-as-a-Judge](https://arxiv.org/html/2306.05685)
- surrogate 只能快筛/诊断，authoritative oracle 才决定行为事实。[CoEvoSkills](https://arxiv.org/html/2604.01687v2)

### 8.4 证据与安全

- manifest、fixtures、assertions、grader、subject、baseline 与 resolved execution configuration 在 run 内冻结。
- executor 看任务和必要 skill，不看 assertions/expected；optimizer 看 development feedback，不看 selection/audit 内容。
- 所有 control signal 类型化、绑定 producer/run/artifact digests；被测输出自报的 feedback 不可信。[Feedback poisoning](https://aclanthology.org/2026.eacl-long.100/)
- 缺 arm、缺 artifact、配置漂移、judge 分歧或 eval 可疑时返回 `inconclusive`，不通过修改 eval 让当前 candidate 过关。
- eval 修订由用户确认后，在新 run、新 digests 与新 baseline 下生效。

## 9. 本轮研究文档修订清单（已落实）

1. 将 SkillLens 的“25% extractor–target”改为“25% `domain × target × extractor` cells”。
2. 将“文本 judge 低于随机”改为“46.4%，与随机选择无显著差异”。
3. 给 73.8% 补充“同一批 151 high-gap pairs、同一 GPT-5.4 judge”，并明确非外部 holdout。
4. 给 all-failure 结论补充固定 extractor、3 domains × 3 targets 的范围。
5. 将 GEPA 的“完整验证”改为“完整 `Dpareto` 评分与 frontier 更新”；说明 pool admission 只要求 minibatch improvement。
6. 将“GEPA/SkillOpt 证明 held-out gating 有效”改为“在各自设置中给出正向实证”。
7. 明示“无界架构重写”是对 SkillOpt bounded textual learning 的有意偏离；大重构重置依赖相邻候选连续性的 optimizer lineage。
8. 把 CoEvoSkills 官方项目链接改为 [作者项目页](https://zhang-henry.github.io/CoEvoSkills/)。
9. 区分可演进的 `development_surrogate` 与不可变的 `authoritative selection/audit oracle`。
10. 将 LLM judge 的“分歧即 inconclusive”标为比论文 `tie` 更严格的项目政策。
11. 给 SkillsBench 链接固定 `v4`，并记录访问日期，避免动态预印本漂移。
12. 把 feedback channel 的 typed schema、digest 与权限隔离明确标为基于论文 threat model 的工程扩展，而非论文已验证防御。

## 最终判断

`RESEARCH_SKILL_REVIEW_EVOLUTION.md` 没有整体性误读；它大部分时候已经诚实区分“论文结论”与“项目推论”。真正需要纠正的是少数统计口径、一个错误的一手来源链接，以及三处算法身份边界：

- 无界重构不是 SkillOpt bounded optimization；
- 发布 objective Pareto 不是 GEPA instance Pareto；
- 冻结权威 eval 不是 CoEvoSkills 的 surrogate co-evolution，但二者可通过双层 verifier 组合。

这些边界现已在主研究文档中修正，并在实现对齐矩阵中区分“已实现”“外部设施未交付”与“未实现”。项目的方法论因此可被准确描述为“研究驱动的混合发布算法”：使用 SkillLens/SkillsBench 的真实 paired utility，SkillOpt 的 propose–gate–reject memory，GEPA 的快筛思路，CoEvoSkills 的独立 verifier/oracle 分权，LLM-as-a-Judge 的换位校准，以及 feedback-poisoning 研究提示的控制信号隔离；同时由项目自己的 hard gates、不可变 run contract 与用户授权补足论文未覆盖的发布治理。当前实现没有 GEPA candidate pool，不把单链发布循环称为 GEPA 候选探索。

# Agent 四支柱长期强化路线图

> 状态：执行中（R0/R1 核心接线、R2 Durable Runtime、R3 版本/Delegation/dry-run/Eval、R4 Memory/审批及本地 keyring Secret 生命周期均已完成本地门禁；真实 PostgreSQL/Redis Chaos、登录后 E2E、KMS/Vault、RAG 质量与生产治理仍在后续范围）  
> 建立日期：2026-08-28  
> 范围：可配置化 Agent、Subagent、Memory、工具与权限审批，以及这些能力共同依赖的 Agent Runtime、评测和 RAG 证据链。  
> 原则：本文描述目标和验收门槛，不把“已有表结构”或“存在源码”误写成“生产链路已经成立”。

## 1. 目标与当前判断

项目的 Agent 能力按四个产品支柱组织：

1. **可配置化 Agent**：定义 Agent 是谁、使用什么模型、拥有什么能力、如何发布和评测。
2. **Subagent 协作**：任务拆分、专家委派、并发调度、结果与证据汇总。
3. **Memory 管理**：会话上下文、长期记忆、生命周期、召回、隐私与用户控制。
4. **工具与权限审批**：内置/HTTP/MCP 工具、风险治理、人工授权、幂等与审计。

四个支柱共同依赖一个统一执行底座：

```text
Agent Control Plane
  ├─ Versioned Agent configuration
  ├─ Memory policy
  ├─ Versioned tool bindings
  ├─ Delegation bindings
  └─ Publish / test / evaluate / rollback
             ↓
Agent Execution Plane
  ├─ Durable work items + checkpoints
  ├─ Shared AgentExecutionKernel
  ├─ Tree ResourceGovernor
  ├─ ToolExecutionKernel + ApprovalCoordinator
  ├─ EvidenceCollector + OutputValidator
  └─ Trace / metrics / audit
             ↓
PostgreSQL + BullMQ + model/tool/RAG providers
```

当前主 Agent 循环、安全防线和 RAG 工程基础较强；工具调用、模型协议、上下文、输出契约、树级资源治理与父子证据汇总已通过共享组件收敛。R2 已将 HTTP 收敛为持久任务提交入口，由独立 Worker 从 generation zero 建立 checkpoint，并通过数据库事件游标恢复 SSE；根/子仍保留表面 Adapter，但共享相同的恢复内核和副作用边界。Agent 可配置树预算尚未产品化，真实 PostgreSQL/Redis kill-point 往返也仍未在本机执行。

## 2. 不可妥协的目标不变量

后续每项实现都必须满足以下不变量：

- 同一工具由根 Agent 或任意深度 Subagent 调用时，风险、审批、次数、上下文、幂等和审计语义一致。
- 并发父子 Run 的 `consumed + reserved` 永不超过根 Run 树预算。
- 终态 Run 树下不存在 pending approval、active step、有效 lease 或继续发送的外部请求。
- Worker 丢失 lease/fencing 后不能继续写 Step、调用工具或提交答案。
- 已成功的外部副作用不得因恢复盲目重放；无法判断结果时必须进入 `indeterminate`，不能伪装成普通失败。
- Memory 总开关、作用域、过期、删除和替代语义严格生效，失效记忆不能重新被召回。
- Trace 记录的 Memory、工具版本和证据必须与实际注入或执行内容一致。
- 纯 Subagent RAG 路径也必须把来源和 grounding 状态传回根 Agent，不能绕过最终证据约束。
- Agent 历史 Run 必须能够解释所使用的 Agent 版本、工具版本、Memory Policy、模型和资源预算。

## 3. 第一阶段：正确性止血（R0，预计 2～3 周）

这一阶段不增加新玩法，只修复会破坏权限、隐私、副作用或运行状态的缺陷。

### R0-SUB-01：修复 Subagent 生命周期

- 所有取消、超时、异常和 lease 丢失路径统一 terminalize child Run。
- 禁止出现 `status=running` 但无有效 lease 的子 Run。
- lease renewal 失败必须中止旧 Worker，不能静默忽略。
- 父 Run 必须等待持久化子任务终态，不能把 queued/running 直接映射为 failed。
- 根 Run 递归取消时同步终结后代 Steps 和 Approvals。

### R0-APR-01：打通 Subagent 审批

- 以一条 canonical approval 为事实源，不再依赖不可同步的父镜像 pending Step。
- Root Run UI 能展示发起 Agent、子任务链、工具、风险和脱敏参数，并允许决定。
- `waiting_subagent` 在聊天页、运行历史和轮询逻辑中属于 active 状态。
- 审批创建、取消、过期和 Run 状态检查必须事务化。
- 修复刷新后看不到子审批、父时间线永久 pending 等问题。

### R0-TOOL-01：修复写工具重试语义

- `read` 工具仅对确认安全的暂态失败做有界重试。
- `write/high` 与 MCP 默认不因 timeout/network error 自动重试。
- 只有显式配置并验证幂等契约的 HTTP 工具才可使用稳定 Idempotency-Key 重试。
- 禁止 Secret 或静态 Header 覆盖运行时 Idempotency-Key。
- 远端可能已经成功但本地无法确认时记录 `indeterminate`。

### R0-MEM-01：修复 Memory 正确性与隐私

- 每个 Run 只执行一次 `resolveMemoryContext()`，Prompt 和 Trace 复用同一不可变结果。
- Memory embedding 使用组合 Run signal 和独立短超时，RAG 服务故障不应阻塞首个模型请求数十秒。
- Persona `memory_enabled=false` 后不得向 Agent 注入画像。
- 明确定义并修正 `none/conversation/user/project` 的读取语义，UI 文案与实现一致。
- 修复删除 replacement 后旧记忆重新 active 的 supersession resurrection。
- replace 必须原子、同用户、同 scope、无环。
- Trace 只记录真正注入 Prompt 的 Memory ID，并记录省略数和降级方式。

> 2026-08-28 实施记录：根 Agent 已统一通过 `resolveAgentRunContext()` 解析自动上下文，四种模式、Persona 开关、单次查询/Embedding、组合取消、Prompt/Trace ID 同源、换行注入防护均有运行行为测试。`0052_agent_memory_lifecycle.sql` 已实现擦除式 tombstone、旧非法链/环迁移修复、同 scope 原子替代与数据库触发器；UI 和文档已明确“自动上下文”与显式 `recall/remember` 独立。Server 全量 540 项测试中 533 通过、7 项基础设施集成测试跳过；Client 126 项通过，类型、Lint 与生产构建通过。由于本机 Docker/PostgreSQL 未运行，新增真实 PostgreSQL 并发/迁移测试尚未在线执行，因此本项不标记为生产验收完成。

> 2026-08-28 第二批实施记录（`R0-SUB-01 + R0-APR-01`）：Subagent 终态改为 lease-token fenced transaction，成功答案和 Run 终态同事务提交；续租丢失组合进执行 AbortSignal，旧 Worker 不能继续模型/工具或覆盖终态。`0053_agent_run_terminal_integrity.sql` 除修复旧 `running/no lease` 外，还用 deferred tree constraint 禁止“终态祖先 + 活动后代”；根成功、失败/超时、显式取消、消息删除、Agent 停用、项目清理、stale recovery 与 lease expiry 都递归关闭后代 Run、活动 Step、pending Approval 和 lease，新派发与终态提交以根行锁串行。父在其他 Worker 持有 claim 时等待数据库终态，不再把 queued/running 映射成 failed。Subagent 审批收敛为“根 approval row + child canonical Step”，创建/决定/过期事务化；根详情投影发起 Agent、层级、Run、工具、风险与参数，前端脱敏展示且继续使用根 Run 审批路由。Chat 在 SSE 存活时轮询 Run detail 并合并数据库中新建的子审批，断线后才刷新完整消息，避免替换乐观消息导致后续 SSE 帧丢失；`waiting_subagent` 已进入聊天恢复、历史轮询和状态 UI。
>
> 本批本地门禁：入口/脚本 150/150；Client 17 个文件、130/130；Server 主测试 434 通过、7 项基础设施集成跳过，Agent Runtime 101/101（Server 合计 535 通过、7 跳过）；RAG 340 通过、2 跳过；全量 build、TypeScript、ESLint、Express removal、Native Nest controller 与 `git diff --check` 通过。浏览器 smoke 已验证 `http://127.0.0.1:5173/` → `/login`、非空 DOM、无框架错误层、无 console warning/error，以及主按钮可见/可用/可键盘聚焦；因本机无 PostgreSQL 且浏览器未登录，真实“子审批出现 → 根路由决定 → 卡片终态”仍未执行。新增 PostgreSQL 场景已接入 CI 的 `AGENT_TREE_INTEGRATION=1` 门禁，但本机 Docker daemon、`psql` 与 PostgreSQL 服务均不可用，所以不能宣称真库或审批 E2E 已验收。

> 2026-08-28 第三批实施记录（`R0-TOOL-01`）：`AgentRuntimeTool` 新增 `safe_read / idempotent_write / never` 显式重试契约，根 Agent 与 Subagent 共用同一失败判定。仅 read-risk 内置工具与 HTTP GET 可安全重试；HTTP 写工具默认 `never`，只有所有者在配置/UI 中确认远端按 `Idempotency-Key` 去重后才进入 `idempotent_write`；MCP、Memory 写入与 Subagent 派发均不自动重放。运行时 key 在静态 Header 与 Secret 之后写入，配置/API 同时拒绝覆盖。`0054_agent_tool_outcome_integrity.sql` 为调用账本增加 retry mode、error code 与 `indeterminate` 终态，并以 terminal metadata constraint 保证状态与完成信息一致；终态 tool call id 不能重新打开。故障注入 fake server 已验证“远端先产生副作用再断开响应”：普通写调用只收到一次请求并判为未知，显式幂等写使用同一 key 重试但远端副作用仍只发生一次。PostgreSQL 用例覆盖未知终态约束、重试 attempt 以及终态防重放，但本机仍无法执行真库门禁。

### R0-DOC-01：修正文档过度承诺

- 在共享预算、跨实例接管和恢复闭环完成前，降低对应文档表述。
- 修正子 Agent 审批文档与当前代码不一致的说明。
- 每次能力完成后只根据真实集成/E2E/故障注入证据恢复声明。

### R0 验收门禁

- PostgreSQL 并发测试覆盖审批创建/取消、replace/delete、lease 丢失和终态提交。
- Playwright 覆盖子审批出现、决定、刷新恢复、取消和过期。
- Fake side-effect server 覆盖“远端已提交但响应丢失”，写操作不得自动重复。
- 每 Run 最多一次 Memory query embedding；Prompt Memory IDs 与 Trace 100% 一致。
- 关闭 Persona/Memory 后注入数严格为 0；deleted/expired/superseded 召回数为 0。

## 4. 第二阶段：统一执行内核与树资源治理（R1，预计 4～6 周）

### R1-KERNEL-01：提取共享 AgentExecutionKernel

统一根 Agent 与 Subagent 的：

- ContextManager；
- ModelProtocolGuard；
- ResourceGovernor；
- ToolExecutionKernel；
- ApprovalCoordinator；
- InvocationLedger；
- EvidenceCollector；
- OutputValidator；
- Checkpoint 接口。

根/子差异只能由 Adapter 表达：根 Agent 写会话消息和 SSE；子 Agent 返回结构化结果包，不能再维护第二套弱化循环。

> 2026-08-29 `R1-KERNEL-01` 协议与输出一致性实施记录：提取共享 `ModelProtocolGuard`，根与 Subagent 对缺失 `finish_reason`、`length` 截断工具调用/最终答案、未 advertised tools 却返回 tool call 均 fail-closed；根/子工具批次都在第一个副作用前按剩余额度整批预检。Subagent 接通 Agent 版本的 JSON 输出配置，包含 system prompt Schema、Provider 支持时的 `response_format`、请求 token 估算、纠错轮与最终 JSON Schema 校验；JSON grounding 只抽取业务字段，证据不足拒答仍保持 Schema 合法。
>
> 输出校验失败使用共享的 `AgentOutputValidationError` 类型，不依赖错误文本猜测；子终态稳定区分 `subagent_resource_limit`、`subagent_model_error`、`subagent_output_invalid` 与一般 `subagent_failed`，同一分类同时用于 fenced terminalization 和父 Agent outcome。随后提取不可变 `AgentOutputContract`：根/子共用 Schema prompt、Provider structured-output 决策、包含工具定义与 response format 的请求 token 估算、最终校验及纠错提示；Schema 在 Run 内克隆并深度冻结。根协议/输出错误也改为类型化 `agent_model_error` / `agent_output_invalid`，避免依赖文案分类。
>
> 2026-08-29 本轮继续提取共享模型调用账本内核和 `ResourceGovernor`：根/子 reservation 之后统一执行 Provider 调用、协议完成检查、usage 来源归一化、成功 settlement 与未知结果保守 settlement；网络/协议/取消或 usage 超 reservation 时整笔记为 `indeterminate`，并向 Run usage 恰好一次计入相同保守 Token，修复根 Run 预算已消费但 `token_usage` 漏记的分叉。上下文请求规划统一包含消息、工具定义、response format 和最大输出；Subagent 不再静默把非法输出上限截到模型窗口。整批工具调用统一返回 `per_iteration/run_total` 决策，根/子都在首个副作用前拒绝并写 `budget_check`。本批定向门禁为 Server build、ESLint、Agent Runtime 115/115。
>
> 随后提取共享 `ApprovalCoordinator`：根/子统一同进程唤醒、跨进程数据库轮询、Approval/Run/User 三重身份、短暂数据库故障容忍、deadline/abort expiry 和 waiter 清理，不再由 Subagent 维护弱化 polling loop。共享 `AgentContextManager` 统一根/子消息容器、完整请求规划和可选历史边界；根 Run 的累计压缩会先移除旧 digest，再只从原始历史重新生成，避免二次压缩把 digest 误计为新历史，摘录以 user 角色注入且明确标为不可信数据。新增 `0058_agent_run_checkpoints.sql`、Checkpoint Coordinator 与仓储：格式版本固定、边界枚举、payload 应用/数据库双限额、generation compare-and-swap，delegated Run 额外由当前 lease token fencing。Agent Runtime 117/117，连同迁移定向 129/129；真 PostgreSQL CAS/lease/size 场景已加入条件集成套件但本机未执行。
>
> 至此 `R1-KERNEL-01` 的独立组件接口已覆盖 ContextManager、ModelProtocolGuard、ResourceGovernor、ToolExecutionKernel、ApprovalCoordinator、模型 InvocationLedger、EvidenceCollector、OutputContract 和 Checkpoint。根/子顶层循环仍是两个 Adapter，Checkpoint 也尚未写入可恢复的完整运行状态，故不能宣称单一 AgentExecutionKernel 或 Durable Runtime 已完成；下一阶段先把安全边界接入 checkpoint，再建设可领取、续租、恢复和围栏的 Worker。

### R1-BUDGET-01：接通 Run 树共享预算

- 根 Run 与 `agent_run_budgets` 在同一事务创建。
- 每次模型迭代、工具调用和每个子任务派发前进行数据库原子扣账。
- Token 使用“调用前预留、调用后结算”；记录 Provider reported 与 tokenizer estimated 两种来源。
- `token_consumed + token_reserved <= token_total` 由数据库约束保证。
- 所有 Run 使用根账本的绝对 `deadline_at`，恢复后不能重新获得时间。
- Final answer reserve 只能由根 Run 的无工具最终轮使用。
- Agent 配置区分 per-run limits 与 tree budget，且服务端硬上限只能被用户向下收紧。

建议新增：

- `agent_model_invocations`；
- `agent_run_budgets.token_reserved/revision`；
- 模型调用 usage 与 reservation 状态。

> 2026-08-29 `R1-BUDGET-01` 核心运行时实施记录：根 Run 与预算账本改为同事务创建；新增 `0057_agent_tree_budget_reservations.sql`、`token_reserved` 和 `agent_model_invocations`，模型请求在访问 Provider 前原子预留最大 token 暴露并扣一次 tree iteration，成功后按 Provider usage 或保守 tokenizer estimate 结算并释放差额，网络/协议/取消未知结果按整笔 reservation 计入 `indeterminate`。维护任务会把 deadline 已过或 owner 已终态的遗留 reservation 保守结算，避免进程崩溃永久冻结额度或错误释放可能已经花掉的 token。
>
> 根与 Subagent 的真实工具执行前均在同一根账本原子扣 `tool_call`；未知工具、策略拒绝、审批拒绝不消耗执行额度。`createSubagentRun()` 在创建 child 的同一事务扣 `subagent_dispatch`，并发 fan-out 不会越过树上限。普通根/子模型调用共同保留最后一轮 iteration 和 final-answer tokens，最终 reserve 由仓储验证只能被活跃根 Run 使用；额度不足时根 Run 撤下工具并尝试返回可审计的部分答案，Subagent 不能借此扩大额度。模型 invocation 还使用 `(run_id, root_run_id)` 复合外键防止跨树记账。
>
> 本批定向门禁：Server build 通过；Agent Runtime + 迁移测试共 117/117，通过的 skip-aware PostgreSQL 套件新增根 Run/预算事务回滚、并发 reservation、结算幂等、最终 reserve 根身份、并发 dispatch、deadline 闸门和遗留 reservation sweep 场景。本机没有 PostgreSQL/Docker/`psql`，所以真库场景仍为 1 项条件跳过，不能宣称生产数据库验收完成。`R1-BUDGET-01` 剩余产品化工作是将 tree budget 暴露为可配置 Agent 版本字段、向下收紧服务端硬上限并在 UI/历史 Run 展示预算快照。

### R1-EVIDENCE-01：统一父子证据链

Subagent 返回结构化 envelope：

```ts
interface SubagentResultEnvelope {
  answer: string;
  status: 'supported' | 'partial' | 'insufficient_evidence' | 'not_applicable';
  sources: ChatSource[];
  grounding?: GroundingSummary;
  rag_quality?: Partial<RagQualitySummary>;
  usage: TokenUsage;
  warnings: string[];
}
```

- 父 Agent 合并来源、最差质量状态和警告。
- 纯 Subagent 检索也必须触发根最终 grounding。
- 子结果按不可信中间数据处理，不能直接成为系统指令。

> 2026-08-29 `R1-EVIDENCE-01` 核心实施记录：新增共享 `AgentEvidenceCollector`，根与任意深度 Subagent 统一收集 RAG/文档/图谱来源、最差 quality、insufficient-evidence 和 warning；嵌套 `dispatch_subagents` 同时向上合并每个直接 child 的整棵子树 usage。Subagent 最终答案先执行与根相同的 deterministic grounding，unsupported 实质性结论在进入父模型前替换为证据不足回答，只将 verified sources 写入 envelope。
>
> `SubagentResultEnvelope` 与 child assistant Step/Run 终态在同一 fenced transaction 持久化，同时更新 child `token_usage` 和 `grounding`。派发方无条件从数据库 reconciliation，并从 assistant `output` 恢复 envelope，因此另一个 Worker 完成 child 时仍能还原完整证据。模型可见结果只含答案、evidence status 与 filename/file/chunk refs；完整 source 正文放在不可枚举内部通道，避免上下文和 Step 重复膨胀。child 局部数字 citation 在交给父模型前移除，防止根合并多个 source 序列后错指。父 EvidenceCollector 最终再次校验根答案，纯 Subagent RAG 不再绕过 grounding。
>
> 行为测试覆盖完整正文不进入模型 JSON、envelope JSON 往返/跨 Worker 恢复、嵌套 quality/usage/warning 合并、unsupported child fail-closed 与局部 citation 清理；PostgreSQL 集成场景覆盖 assistant output、Run usage/grounding 和查询恢复，但本机没有 PostgreSQL/Docker/`psql`，真库验收仍按环境条件跳过。剩余 R1 工作主要是完整 AgentExecutionKernel parity matrix，以及把 tree budget 做成 Agent 版本配置/UI。

### R1-TOOL-01：统一工具执行账本

- 主/子 Agent 全部走同一 ToolExecutionKernel。
- 全局、树级和单工具调用上限统一 enforcement。
- Invocation 记录 input hash、风险、版本、worker fence、结果引用和 `indeterminate`。
- 已 succeeded 调用恢复时复用持久结果，不能重新置回 in-flight。

> 2026-08-28 R1 第一批实施记录（`R1-KERNEL-01 + R1-TOOL-01` 第一刀）：新增共享 `ToolExecutionKernel`，根 Agent 与 Subagent 均通过同一入口完成稳定逻辑 key、invocation begin/finish、显式 retry contract、取消/超时分类、`indeterminate` 和终态防重放；SSE、会话消息、子结果与 lease 状态保留为 Adapter。Subagent 嵌套派发补上 lease-token fenced 的 `running → waiting_subagent → running`，等待孙级期间继续续租，旧 token 不能 park/resume，终态不能复活；`0055_agent_subagent_waiting_lease.sql` 修正数据库约束并安全关闭升级时无主的等待子树。`0056_agent_tool_execution_fencing.sql` 为工具 invocation 增加 execution token：同一内核重试复用 token，并发 runtime 不能接管 `in_flight`，旧执行者不能覆盖终态，升级时遗留的未知 `in_flight` 直接转为 `indeterminate` 而不重放。Adapter 在第二次写尝试前失败时也保留“先前副作用可能已发生”的未知终态。
>
> 本批定向门禁：Server build 通过；Agent Runtime 105/105，迁移测试 10/10；共享内核、等待 lease 和 invocation fencing 的 skip-aware PostgreSQL 场景已接入 `AGENT_TREE_INTEGRATION=1`。本机没有 PostgreSQL/Docker/`psql`，所以迁移 SQL 与并发场景只完成源码/加载门禁，不能宣称真库执行完成。`R1-KERNEL-01` 仍未完成 ContextManager、ModelProtocolGuard、ResourceGovernor、EvidenceCollector、OutputValidator 与 Checkpoint 的统一；`R1-TOOL-01` 仍缺 input hash、工具版本/结果引用与成功结果恢复复用。

### R1 验收门禁

- 主/子 parity matrix 覆盖截断、非法协议、上下文超限、Schema 失败、单工具上限、取消、Token 超额和 RAG 证据不足。
- 根/子/孙三层并发扣账压力测试从不超额。
- 子 RAG citation 在根最终回答中可追溯，证据不足不能变成无约束回答。
- 所有模型调用具有 usage、reservation 和版本记录。

## 5. 第三阶段：Durable Agent Runtime（R2，预计 6～8 周）

目标不是“子 Run 有一行数据库记录”，而是根/子 Agent 都可在 Worker 崩溃后由其他实例安全接管。

### R2-WORK-01：持久 Work Item

新增 `agent_work_items`，持久化：

- root/parent/child Run；
- task、bounded context、task index；
- pinned Agent version；
- policy/project/delegation snapshot；
- payload hash、attempt、available_at；
- lease、fencing generation 和终态。

使用 PostgreSQL 为事实源，BullMQ 只传 work item ID；Dispatcher 能从 PostgreSQL 重建丢失队列消息。

### R2-CKPT-01：运行 Checkpoint

新增版本化 checkpoint，覆盖：

- 当前 phase；
- messages/tool protocol state；
- budget/usage；
- evidence accumulator；
- pending model/tool/approval/subagent；
- next step sequence；
- state hash/revision。

Step sequence 改为数据库原子分配，不能继续依赖进程内 `sequence++`。

### R2-RECOVER-01：父 Run Worker 化与唤醒

```text
HTTP 创建 Root Run → Root Work Item
Worker 执行到 dispatch → checkpoint waiting_subagents
Child Work Items 并行执行 → 最后一个终态唤醒 Parent
任意 Worker 恢复 Parent → 汇总 → 唯一提交 Assistant Message
```

SSE 只订阅持久事件，不拥有 Agent 生命周期。

### R2-CHAOS-01：故障注入验收

在任务落库、claim、模型返回、工具调用前后、远端已生效但本地未落账、子结果完成、父唤醒和最终消息提交等边界 kill Worker。

必须满足：

- queued work 在 SLA 内被另一 Worker claim；
- 同一任务只有一个 child Run；
- 旧 Worker 写入被 fencing 拒绝；
- 已成功副作用不盲目重放，不可判断时进入 indeterminate；
- 父只产生一个最终消息并能继续消费已完成子结果；
- Redis 重启后可由 PostgreSQL 重建任务。

只有此阶段通过后，才能宣称“支持跨实例接管和断点续跑”。

> 2026-08-29 R2 阶段性实施记录：新增 `0059`～`0066`，根/子 Run 均有 hashed Work Item、lease/fencing generation、数据库 Step allocator、版本化 checkpoint、模型/工具 durable result 与恢复期工具扣账。恢复 Worker 已覆盖 `execution_ready`、`model_ready`、`tool_batch_ready`、`approval_wait`、`subagents_wait`、`final_answer_ready`：成功模型/工具结果复用；明确未开始工具可执行；连续审批可再次原子 checkpoint；父 fenced park，最后 child 终态事务唤醒并恢复 partial failure、Evidence、warning 与 delegated usage；终态提交受 claim fencing 且只生成一个根消息。
>
> Provider kill-point 进一步拆成 checkpoint 与 exposure 两个边界：Worker 必须在当前 Work Item claim 下写 `exposure_started_at` 后才能调用 Provider。恢复只会重放 `reserved + exposure_started_at is null`，并在调用前重建 pinned tool catalog，同时校验 token 计划和由模型、messages、工具 definitions、温度、max output、response format 组成的规范化 SHA-256；已暴露但无结果的 invocation 进入 `indeterminate`，绝不二次调用。过期 sweep 对未暴露 reservation 以 `failed/not_invoked/0 token` 释放，迁移前遗留 reserved 行则保守回填为已暴露。
>
> `execution_ready` 关闭了 run/work-item 已提交但 generation-one checkpoint 尚未形成的窗口：hashed payload 固定首轮 transcript、可选历史边界和 deadline；恢复时复核 tree budget，以当前 lease 做 generation 0 CAS，再恢复 pinned 工具、上下文压缩、reservation、request fingerprint 和既有 exposure 链。queued/expired 扫描和 stale-run/lease sweep 都识别这个边界；根与 Subagent 使用同一规则，非法快照、deadline 漂移与 stale owner 全部 fail-closed。
>
> 本批当时的本地门禁：Server build、TypeScript、ESLint、Express removal、Native Nest controller 通过；Agent Runtime 136/136，migration 20/20，BullMQ + runtime lifecycle 5/5。由于本机没有 PostgreSQL/Docker/`psql`，`0065`～`0066` 及 claim/exposure/bootstrap/sweep 的真数据库事务语义尚未在线执行；在这一批结束时，HTTP 纯提交、SSE 持久事件订阅和系统化 kill-point matrix 仍是 R2 未完成项。前两项已在后续 `0067`～`0069` 实施记录中完成，当前剩余边界以最新记录为准。
>
> 2026-08-29 R2 后续实施记录：`0067` 增加有界、幂等、可按 cursor 重放的 `agent_run_events`，SSE 从持久事件流恢复并在投递终态后关闭；`0068` 将完整 Subagent 派发固化为不可变 manifest，固定 child 版本、工具/策略、上下文、deadline 与 task index，parallel 批次和 sequential 游标都与 child 创建、Work Item、fanout debit 同事务；`0069` 以数据库 trigger 为 maintenance/lease sweep 等所有终态旁路补写 compact fallback event，普通仓储的 richer event 只可替换 fallback，保持同一 event ID。HTTP 已只创建 Root Run、助手占位和 generation-zero Work Item，执行、Provider 与工具均由 Worker 接管。
>
> 严格审查继续补齐：sequential manifest 在上一个 child 活跃时拒绝推进，即使收到误唤醒也不重叠执行；child count/cursor/expected count 交叉校验，结果按持久 `task_index` 排序，立即失败不会被错误追加到批次末尾。条件集成场景覆盖 manifest 重放不重复建 child/扣预算、两轮 sequential wake/fencing advance、旧 owner 最终提交拒绝、唯一助手消息、terminal fallback/richer replacement，以及删除 Redis job 后从 PostgreSQL 重建同一确定性 BullMQ job。当前本地门禁为 Agent Runtime 142/142、migration 23/23、BullMQ/runtime lifecycle 5/5，Server build/lint 与 Client build/lint/132 项测试通过；本机无 PostgreSQL/Redis，故这些真实基础设施场景仍只可表述为“已接入 CI”，系统化进程 kill matrix 仍是 R2 最后的生产验收项。

## 6. 第四阶段：可配置化 Agent 2.0（R3，预计 4～6 周）

当前已经能配置指令、模型、运行上限、Memory 模式、工具、审批和输出 Schema；下一步要从“表单可配置”升级到“配置可理解、可复现、可验证、可回滚”。

### R3-AGENT-01：版本治理

- 前端版本历史、字段级 diff、发布说明和一键回滚为新草稿。
- 发布版本不可变，历史 Run 可查看完整配置快照。
- 发布前静态校验模型能力、工具作用域、Delegation 图、Memory Policy 和输出契约。
- 增加草稿试运行，不污染正式会话/长期记忆/生产写工具。
- 支持按 Agent version 运行评测并对比 baseline。
- 后续再增加灰度发布、流量比例和快速回滚；不在第一版直接做复杂实验平台。

> 2026-08-29 `R3-AGENT-01` 第一批实施记录：新增 `0070_agent_version_governance.sql`。数据库基于全部可执行配置字段的 canonical `jsonb` 生成 SHA-256，`agent_versions` 插入后禁止原地更新；`derived_from_version_id + change_kind` 记录创建、编辑与复制式回滚来源，复合外键禁止跨 Agent 伪造 ancestry。新增 append-only `agent_version_publications`，在同一事务持锁复核 current version 与工具 scope，固化发布说明、发布人和结构化校验报告后再移动线上指针；编辑/工具竞态全部 fail-closed。
>
> 服务端新增单版本查询、任意版本字段级 diff 和“回滚为新草稿”API。发布检查结构化为 model capability、Provider configuration、output contract、tool scope、delegation graph 与 memory policy；Memory Policy 已在 `R3-MEM-01` 接入真实校验，显式 Delegation Binding 尚未实现时仍如实为 `not_applicable`。前端 Agent 编辑页已展示历史版本、配置 hash、来源、current/live、publication/validation 摘要、发布说明和 before/after diff，并可安全回滚。Server build/lint、Agent Runtime 144/144、迁移/Mutation Schema 定向测试以及 Client build/lint/Store 定向测试通过；真实 PostgreSQL 的不可变 trigger、hash、publication、回滚与跨 Agent FK 场景已接入条件集成套件，本机无 PostgreSQL，不能宣称真库执行通过。
>
> `R3-DELEGATE-01` 已在后续批次完成并接入全量 Delegation 静态发布校验。
>
> 2026-08-29 `R3-AGENT-01` 第二批实施记录（Draft dry-run）：新增 `0074_agent_version_dry_runs.sql` 和独立于生产 Run 树/会话的版本试运行账本。试运行固定任意 owned immutable version，先执行与发布一致的模型、Provider、输出、工具、Delegation 与 Memory Policy 校验，再在 model-only isolation 下调用真实模型；会话历史、Persona、长期 Memory 和项目上下文全部省略。运行时只有模型可见工具定义、没有工具执行器，也不读取 Secret；模型提出的调用只验证 name/ID/Schema、记录风险与审批决策并返回模拟未执行结果，所以不会创建工具 invocation、审批、Subagent、正式消息或 Memory 写入。JSON 输出复用正式 AgentOutputContract 并支持一次纠错。Agent 停用/删除和 stale sweep 会中止或收敛运行中预览。前端版本治理面板支持选择任意版本、发起试运行、查看静态校验失败、输出、Token usage 和模拟工具计划。
>
> 本批本地门禁：Server 全量 build/lint/test 零失败（其中 Agent Runtime 155/155，Agent Runtime + migration + Mutation + cleanup 定向组合 216/216），Client build/lint 和 21 个文件 147/147 通过，`git diff --check` 通过。内置浏览器验证 `/agents` 未登录时正确跳转 `/login`，页面非空、登录按钮可用、无 Vite overlay 和 console warning/error；当前浏览器没有登录，因此不把版本试运行面板的已登录交互虚报为 E2E 通过。真实 PostgreSQL 条件场景已加入固定版本/用户隔离、终态约束、usage 整数约束，以及 Run/message 数量不变验证，但本机无 PostgreSQL，仍不可宣称真库执行通过。当前剩余：按 Agent version 运行评测/对比 baseline；灰度发布仍按计划后置。
>
> 2026-08-29 `R3-AGENT-01` 第三批实施记录（Agent Eval/baseline）：新增 `0075_agent_version_evaluations.sql`、独立 Nest 模块、持久 Worker 与 Agent 中心评测面板。Dataset revision、candidate/baseline 不可变版本与 configuration hash、evaluator version、Case snapshot、Result variant 全部固定；BullMQ 仅唤醒，PostgreSQL claim/lease/fencing 决定执行权。工具模式只允许 Case 显式 fixture replay，真实执行器、Secret、生产 Run/消息/Invocation/Approval/Memory 都不进入链路。candidate/baseline 各有独立 deadline，指标覆盖输出、工具、安全、词法证据/引用、延迟与 Token；不适用项为 null，成本在缺少版本化定价时为 N/A。
>
> 严格审查进一步修复了幂等重试晚于活动配额导致的误拒绝、前端轮询依赖数组引发的无间隔请求循环、Dataset 删除与活动 Worker 的即时中止、SQL `CHECK` 对 NULL 放行缺失 usage/failure 字段，以及 Case/Result snapshot 可更新等问题；活动 Run 组合增加数据库唯一索引。当前 Server build/lint/full test 退出零失败，Agent Runtime 155/155，Agent Eval 定向 7/7；Client build/lint 与 22 个文件 149/149，`git diff --check` 通过。Browser smoke 验证 `/agents` 跳 `/login`、DOM、按钮可见/可用/键盘焦点、无 overlay、console 无 warning/error；未登录不宣称评测面板 E2E。真 PostgreSQL 条件场景已接入但本机无 PostgreSQL/Redis/Docker/`psql`，迁移与 Worker 竞态仍等待基础设施门禁。R3 灰度发布继续后置，主线进入 R4 Memory/审批产品化。

### R3-MEM-01：版本化 Memory Policy

用结构化 `memory_policy` 替代含义模糊的单枚举：

- 会话窗口/滚动摘要；
- Persona 开关；
- 可读取 scope、自动召回、TopK、Token 预算和信任阈值；
- 可写 scope、默认 TTL 和是否必须确认；
- 子 Agent 只接收父明确下发的有界只读 Memory snapshot。

> 2026-08-29 `R3-MEM-01` 实施记录：新增 `0071_agent_memory_policy.sql` 和统一 `AgentMemoryPolicy` 模型，`memory_policy` 成为执行事实源并进入不可变版本、v2 配置指纹、diff/rollback/duplicate、发布校验、Run snapshot、hashed Work Item 与 recovery pinned snapshot；`memory_mode` 仅保留为旧预设兼容投影。运行时按策略约束会话条数、Persona、项目上下文、自动/显式召回 scope、Top-K、Token/字符预算、最低信任级别、写入 scope 和默认 TTL，越权统一返回 `memory_policy_violation`。滚动摘要的后续可执行实现见 `R4-MEM-02` 第三批记录。
>
> Subagent 的有效工具绑定会移除 `recall/remember`，不能直接访问长期 Memory store；它只能接收父级已召回、带可信度标签且同时受发送方/接收方条数与预算限制的只读快照。该快照固定进入 durable manifest、Work Item 和恢复链路，历史 Run 不会因当前 Agent 策略变化而漂移。数据库迁移、行为测试和前端高级策略编辑器均已加入。本批 Server build/lint 通过，主测试 453 passed、7 个基础设施条件用例 skipped，Agent Runtime 148/148；Client build/lint 通过，19 个文件 140/140。真实 PostgreSQL 条件集成场景已扩充，但本机没有 PostgreSQL、Redis、Docker 或 `psql`，因此不能宣称 `0071` 已在真库执行或完成基础设施 Chaos 验收。

### R3-TOOL-01：工具版本化

- 新增 `agent_tool_versions` 与 secret version；
- Agent binding 固定 `tool_version_id`；
- Run snapshot 保存配置/Schema hash、风险、重试策略和 secret version；
- 修改 endpoint、Schema、risk 或 secret 不得静默改变已发布 Agent 行为。

> 2026-08-29 `R3-TOOL-01` 本地实现记录：新增 `0072_agent_tool_versions.sql`，以 append-only `agent_tool_versions` 保存 HTTP/MCP 执行定义、risk、调用上限、加密 Secret、单调 `secret_version`、SHA-256 `configuration_hash`、来源版本和 change kind；same-tool 复合外键约束 ancestry 与 `agent_tools.current_version_id`，数据库 trigger 拒绝历史版本原地更新。旧工具回填 v1，旧 Agent custom binding 回填 `tool_version_id`，已经不存在的遗留工具变为 disabled tombstone；Agent 配置指纹升级为 v3。
>
> Agent 创建/编辑/发布/回滚在事务内验证精确 version 归属、启用状态和项目 scope。根 Run、Subagent manifest、Work Item 与 recovery snapshot 固定 version ID、版本号、Secret revision 和配置 hash；恢复读取历史版本而非 current pointer，hash/归属不符即拒绝。`enabled`、scope 与 soft delete 保持实时安全熔断，固定历史版本不会绕过撤权。修改定义或 Secret 只影响未来绑定；编辑器显示当前/固定版本、不可变历史、hash、Secret revision、字段级 diff，并提供显式升级，不自动漂移已发布 Agent。删除改为 soft delete，历史 Agent/Run 与版本行均不改写。
>
> 严格审查额外消除了空 description 对可变工具名的隐式依赖，避免仅重命名就改变模型可见工具定义；前端重新启用 disabled binding 时会替换旧项并固定 current version，不再制造重复 key。当前 Server build/lint 通过，Agent Runtime 150/150，迁移/Mutation 契约 39 passed；Client build/lint 通过，20 个文件 143/143。真 PostgreSQL 条件套件已加入创建 v1、追加 v2、Secret 轮换/清除、不可变 trigger、跨工具 version/ancestry 拒绝、Agent hash、Run v1 恢复、soft delete 保留历史等场景，但本机没有 PostgreSQL、Redis、Docker 或 `psql`，所以不能宣称 `0072` 真库执行和基础设施 Chaos 已通过。

### R3-DELEGATE-01：显式 Delegation Binding

在 Agent version 中增加协作者目录：

```json
{
  "alias": "technical_reviewer",
  "agent_id": "...",
  "version_policy": "pinned",
  "agent_version_id": "...",
  "role": "分析技术风险",
  "max_parallelism": 1,
  "allowed_context_keys": ["requirements", "constraints"]
}
```

- 模型按 alias 选择专家，不再猜裸 UUID。
- 发布时验证用户、项目、版本、静态循环和上下文共享策略。
- `sequential` 若不传递前序结果则更名为 `serialized`；否则实现 task ID、depends_on 和结构化结果注入。

> 2026-08-29 `R3-DELEGATE-01` 实施记录：新增 `0073_agent_delegation_bindings.sql` 与统一 `AgentDelegationBinding` Schema。Agent 版本新增 `explicit / legacy_dynamic` mode 和版本化协作者目录，配置指纹升级为 v4；旧 `dispatch_subagents` 版本回填为 migration-only `legacy_dynamic`。迁移在回填前先临时移除 append-only/hash trigger，完成 mode 分类与 hash 重算后恢复触发器；数据库约束要求 explicit mode 的 dispatch 与非空 binding 同时存在，拒绝未知字段、重复 alias/context key、非法 UUID、role、并发和白名单格式。迁移源码门禁覆盖触发器顺序、fail-closed exception、组合约束和 hash 字段；真 PostgreSQL 本机未执行。
>
> 模型工具定义只暴露 alias、职责和允许上下文字段，不再暴露 Agent/版本 UUID；runtime 将 alias 解析为固定 `agent_id + agent_version_id`，逐项限制 context allowlist 和 `max_parallelism`，并把 `serialized` 映射为现有 sequential 调度但明确不注入前序结果。目标发布 v2 后父 binding 仍执行 v1；根 Run、恢复 snapshot、dispatch manifest、child Work Item 与结果保存 alias、role 和固定版本。旧 snapshot 缺字段时只走 `legacy_dynamic` 兼容恢复，新发布拒绝 legacy mode/legacy dependency。
>
> 服务层与仓储层都遍历固定版本图，验证同用户、有效 publication、当前启用状态、项目 scope、self/cycle、最大深度和 legacy dependency。用户级 Delegation advisory lock 串行化 Agent 与工具配置生命周期；current/published 入站 binding 会阻止目标 Agent 禁用、删除或迁移到不兼容 scope，且禁用/删除与活动 Run 取消在同一事务。历史 binding 不阻止删除，但回滚时重新验证并 fail-closed。前端增加版本化协作者目录、全量候选目录与表单 scope 过滤、alias/职责/并发/上下文白名单、legacy 迁移提示和显式版本升级，并自动同步 `dispatch_subagents`。
>
> 本批定向门禁：Server build 通过，Agent Runtime + migration + Mutation 组合 193/193；Client build/lint 通过，21 个文件 147/147。PostgreSQL 条件集成套件增加固定 v1/发布 v2、cycle、入站禁用/删除/scope 保护、published 历史引用和删除后 rollback 拒绝，但本机无 PostgreSQL/Redis/Docker/`psql`，因此为 skipped，不能宣称真库迁移/竞态通过。内置浏览器可打开客户端且首屏/控制台正常，但未登录会跳到 GitHub 登录，协作者编辑器的真实交互与移动端截图仍需在已登录、基础设施启动的环境验收。

### R3 验收门禁

- 回滚创建新版本，不篡改历史版本。
- Tool/Memory/Delegation 的配置变化不会改变历史 Run。
- Draft dry-run 不触发未经允许的生产副作用。
- 每个已发布版本都有可运行的配置校验和可选评测报告。

## 7. 第五阶段：Memory 与审批产品化（R4，预计 5～8 周，可在 R3 后半并行）

### R4-MEM-01：Memory 生命周期与用户控制

- 增加 status、verification、confidence、sensitivity、deleted_at、last_recalled_at、recall_count。
- 增加 `agent_memory_evidence` 与 append-only `agent_memory_events`。
- 实现候选、确认、拒绝、编辑、原子替代、删除、导出和按 scope 关闭。
- Memory Center 支持游标分页、搜索、筛选、项目/Agent 名称和 provenance Run 跳转。
- tool-derived Memory 默认 quarantine，不自动注入。
- 接入敏感信息/凭据扫描和写入配额。

> **实施进展（2026-08-29）**：`0076`、`0077` 已完成候选/确认/拒绝、verification/confidence/sensitivity、evidence/event 审计、tool-derived quarantine、稳定游标/搜索/来源深链，以及 user/project/agent 类别开关和数据库硬配额。Secret 扫描发生在 embedding 前；关闭 scope 与最终 recall accounting 共用稳定顺序 advisory lock，关闭后旧 snapshot 会使 Run 创建事务回滚。Memory Center 已展示三类开关、配额和候选数，并明确“保留历史、停止召回与新写入”。本地 Server 全量测试退出码 0，Memory 定向 205/205；Client build/lint 与 22 个测试文件 149/149；未登录 Browser smoke 通过。真 PostgreSQL 并发/trigger 场景已写入条件套件，但本机无 PostgreSQL，不能宣称实库通过。`编辑`、`导出`、按具体项目/Agent 的细粒度开关，以及历史 Checkpoint/Work Item 副本的可擦除方案仍未完成。

### R4-MEM-02：召回质量与规模

- 显式 `recall(query, scopes, limit)`；
- 多轮独立问题重写；
- 每 scope 候选配额；
- lexical + vector + recency + trust 融合；
- relevance threshold、MMR 和冲突降权；
- 异步 embedding/backfill；
- 达到数百条 active Memory/用户后优先评估 pgvector + HNSW；
- 持久化滚动 Conversation Summary 及消息 watermark。

评测目标应在真实中文标注集建立后校准；初始工程目标可设为 Recall@5 ≥ 0.85、MRR@5 ≥ 0.75、无关注入率 ≤ 5%、Recall P95 ≤ 300ms，但不能在没有数据前将其对外宣称为 SLA。

> **第一批实施进展（2026-08-29）**：显式 Memory 工具已支持 `recall(query, scopes, limit)`，scope 必须是 Agent version 允许集合的子集；自动与显式召回共用同一内核。候选 SQL 先按 scope 做 `row_number()` 配额（每 scope 50、总计 150），再在应用内融合中英 lexical、同模型 cosine、recency、trust 与 confidence；相关性阈值只允许 lexical/semantic 信号放行，MMR 抑制近重复，保守极性检测对冲突旧事实降权。Query embedding 超时、服务不可用或全部历史向量模型不兼容时，仍保持确定性降级，不把 Memory 故障升级为 Run 失败。
>
> Prompt、Trace 与 recall accounting 复用同一不可变结果：阈值过滤项进入 omitted ID，Trace 新增过滤数、可比较向量数和冲突降权数，只有实际进入 Prompt 的 ID 才计 recall。新增中文 lexical、hybrid gate/MMR、冲突、不可比较向量、显式 scope 越权和候选公平性行为测试；当前 Server full test 退出码 0、Agent Runtime 158/158、新召回定向 6/6，build/lint/type/Native Nest/Express removal 通过。后续中文 Gold 与持久摘要进展见第三、四批记录；pgvector 对照和多轮独立问题重写仍未完成。
>
> **第二批实施进展（2026-08-29，异步 embedding/backfill）**：新增 `0079_agent_memory_embedding_jobs.sql`，PostgreSQL 保存 queued/running/completed/failed/cancelled、attempt、next-attempt、worker、lease token/expiry 与安全错误码，BullMQ 只保存确定性 `memoryId` 唤醒，不复制 Memory 正文。`remember` 已移除前台 embedding：Secret 扫描后直接持久化，candidate 用户确认前不建任务；确认、scope 重开和历史 active confirmed Memory 会建立/恢复 backfill。Worker 具有 Provider timeout、lease heartbeat、最大尝试和有上限的指数退避，成功写回同时复核 lease fencing、Memory 生命周期、scope gate 及空向量；向量/模型成对约束会修复旧半残数据。
>
> 严格竞态审查补齐了两个关键边界：完成路径按 scope advisory lock → job row lock 排序，避免与 scope opt-out 的反向锁死；派发前由 PostgreSQL reconciliation 收敛自然到期等不会触发 UPDATE trigger 的任务，因此 Redis 丢失 wake-up 后也不会留下永久 running job。删除、遗忘、替代、到期和 scope disable 均 fence 晚到结果，过期 owner 不能覆盖接管者。Runtime lifecycle 已统一启动/关闭该队列。行为测试覆盖 PostgreSQL 重建、最小 payload、成功、timeout、lease loss、stale completion 和写入路径不触达 Provider；真数据库条件套件覆盖 candidate→confirm、scope disable/re-enable、lease takeover、替代/遗忘/自然到期、retry exhaustion，但本机无 PostgreSQL/Redis/Docker/`psql`，这些条件场景仍为 skipped，不能宣称真 backfill/故障恢复已执行。当前 Server 全量 491 项中 484 passed、7 infrastructure skipped、0 failed；build、lint、type、no-Express、Native Nest 均通过。剩余主线是持久 Conversation Summary、中文 Gold Dataset 指标校准与 pgvector/HNSW 对照。
>
> **第三批实施进展（2026-08-29，持久 Conversation Summary）**：新增 `0080_agent_conversation_summaries.sql`。开启 rolling summary 的 Agent 以单一 SQL ranking snapshot 同时读取 recent window 与最多 256 条历史候选，持久快照固定 `(created_at,id)` watermark、revision、max tokens、candidate/included 数；只有 watermark、候选总数与预算全部一致才复用，旧时间点补录消息也会推进 revision。摘要为确定性提取而非模型生成，固定以 user-role pinned message 和 untrusted-data 前缀注入；完整 transcript 已固化进 hashed Work Item，恢复不重读漂移历史。消息编辑/删除与摘要刷新共用 conversation advisory lock，覆盖 watermark 的变更会清空摘要，重建后旧正文消失；跨 conversation watermark 由 trigger fail-closed。前端已开放开关和 32–4000 Token 预算，关闭 conversation 会同时关闭摘要。服务端聚焦 197 项为 196 passed、1 个真 PostgreSQL skipped；Client 策略 9/9，全量 Client 152/152，build/lint 通过。`0080` trigger、cascade 与锁等待的真实 PostgreSQL 条件场景已接入，但本机仍无 PostgreSQL，不能宣称真库竞态通过。
>
> **第四批实施进展（2026-08-29，中文 Gold 与质量门禁）**：新增 `agent-memory-zh-CN-v1` 与 `agent-memory-retrieval-eval-v1`。30 条人工 Memory × 34 个中文问题形成对完整候选池穷举的 1,020 条判断，含 4 个无答案问题；`npm run eval:memory` 固定输出 Recall@5、MRR、无关注入率、无答案安全率与进程内 ranker P95，并在测试中执行版本化阈值。首轮门禁真实暴露 9.09% 泛词误注入，随后增加相对 lexical 覆盖下限；有 query 且 embedding/lexical 均无信号时改为 `no_relevant_match` 空注入，无 query 浏览仍保留确定性排序。本机最新报告 Recall@5=1、MRR=1、无关注入率=0、无答案安全率=1、进程内 P95≈0.67ms。该集合规模小、措辞仍较接近 Memory，且 P95 不含 SQL/网络/Provider，因此只是回归基线，不是生产 SLA；下一步仍需扩展困难改写/冲突集并完成 pgvector/HNSW 真库对照。
>
> **第五批实施进展（2026-08-29，pgvector/HNSW 对照框架）**：新增 `agent-memory-vector-benchmark-v1` 与 `npm run bench:memory-vector`，在显式 benchmark 数据库的临时表中使用固定 seed 生成向量，先以应用 exact cosine 建立 gold order，再依次测 pgvector exact scan 与 HNSW；报告 exact parity、HNSW Recall@K/MRR 和三条路径 P50/P95。独立 CI job 使用 `pgvector/pgvector:pg16` 执行 5,000 条 64 维向量、40 query、Top-10、`ef_search=100`，门禁 HNSW Recall@10/MRR ≥ 0.95。普通全量测试只验证 deterministic corpus 并明确 skip 真库场景；本机无 PostgreSQL/Docker，所以这次没有真实 HNSW 结果，不据此迁移生产 schema。该 synthetic benchmark 只衡量索引机制，仍需在扩展中文语义 Gold 和真实向量上做 paired 选型。
>
> **第六批实施进展（2026-08-29，Memory 多轮独立问题解析）**：新增纯确定性 `resolveAgentMemoryRetrievalQuery()`。Agent 先读取策略允许的同一份有界会话 snapshot，再启动 Memory embedding/ranking，因此不会双查历史或先发出错误 query；Persona/项目读取仍与历史并发。解析只回溯最多 3 个 user turn，忽略 assistant 输出，区分 standalone、context unavailable 和 previous-user-context，2,000 字符上限优先保留当前问题。Trace 不复制改写正文，只记录 context-dependent、method、使用轮数、rewritten 与原/新 SHA-256；conversation disabled 时不读取历史。行为测试覆盖单轮追问、连续省略、显式主题不吸收旧历史、assistant injection 隔离、长度上限、真实 loader 接线与取消阶段，聚焦 163/163、Server lint/type/架构门禁通过。

### R4-APR-01：可理解的审批控制面

- approval intent 保存工具版本、input hash、目标、方法、风险、策略链、父子 Run、发起 Agent和副作用摘要。
- 执行前重新验证 intent；版本、参数或目标变化必须重新审批。
- 审批卡展示人类可理解的信息和决策理由。
- 增加审批 Inbox 和逐项明确勾选的批量决定。
- 后续支持条件审批、角色化审批人、高风险二次确认/双人审批。

> **实施进展（2026-08-29）**：`0078_agent_approval_intents.sql` 已为每条新审批固定工具 key/kind、精确工具版本、配置 hash、Secret revision、canonical input SHA-256、脱敏目标/方法、风险、完整 policy chain 和副作用摘要，并对整体 Intent 再做 SHA-256。应用与 PostgreSQL canonical JSON 已对指数数字、`-0`、UTF-8/C 键排序和类整数键做一致性测试；HTTP 目标去除凭据与 Query。数据库禁止 Intent/hash 原地修改和绑定后 canonical Step 的工具/参数漂移，并在创建及 `pending → approved` 时复验 Step/Input/Intent。旧 pending 审批迁移时统一过期并重新排队 parked Work Item；旧终态只保留不可用于新执行的 `legacy-unbound` 审计投影。
>
> 根 Agent inline runtime、Subagent runtime 与 Durable Recovery 均不再把审批降维为布尔值；三路都会在副作用前重新加载 pinned 工具定义并重算 Intent，任一版本、参数、目标、Secret、risk 或 policy 漂移都以 `AGENT_APPROVAL_INTENT_MISMATCH` fail-closed。新增用户隔离、稳定 `(created_at,id)` cursor 的 `GET /agent-runs/approvals/inbox`，自动收敛过期审批，并返回 Root/requesting Run、Agent、Subagent depth、工具与完整 Intent 上下文；Agent 中心 Inbox 和时间线审批卡均展示同一不可变意图、折叠脱敏参数及逐项 approve/reject。现有批量决定 API 仍要求显式列出每个 Approval，不提供“批准全部”。本地 Server build/lint/full test 零失败，Agent Runtime 后置套件 158/158；Client build/lint 与 22 个文件 149/149。真 PostgreSQL 条件场景已覆盖 Intent 不可变、Step 防漂移、用户隔离及 canonical hash，但本机无 PostgreSQL，未登录 Browser 也只能验证鉴权边界；角色化审批、高风险双人审批和登录后 Inbox E2E 仍未完成。

### R4-SECRET-01：Secret 生命周期

- key ID、多版本解密、AAD、轮换和使用审计；
- 逐字段 Secret UI；Header 默认按敏感信息处理；
- 禁止无效/危险 Secret key 和传输控制 Header；
- 生产阶段接入 KMS/Vault envelope encryption。

> **实施进展（2026-08-29，本地 keyring 闭环）**：Secret 密文升级为 `v2.<key-id>...` AES-256-GCM envelope，AAD 固定 `user_id + tool_id + secret_version`，跨用户、跨工具或跨 revision 搬运会认证失败；新写入只使用 active key，keyring 可保留多把 decrypt-only key，并兼容读取无 key ID 的 v1 历史密文。管理 API 支持替换、清除和创建不可变工具版本的原地重包，使用 expected-current-version 防止并发 revision/AAD 错位；畸形历史 envelope、缺失旧 key 和解密失败均进入稳定、无敏感细节的错误边界。
>
> `0081_agent_tool_secret_lifecycle.sql` 增加 append-only Secret 事件：configured/replaced/cleared/used/decrypt_failed/rewrapped。HTTP 与 MCP 在凭据离开进程前同步记录 used，审计不可用时 fail-closed；事件只保存版本、key ID、Run/Agent、attempt 和字段数量，不保存 Secret 名、值或目的 Header/Query。两类 runtime 共用同一 destination validator，拒绝未知位置、重复目标和 Host/Content-Length/Idempotency-Key/MCP/Proxy/Sec 等传输控制 Header。前端改为逐字段 password 输入，已有凭据只显示“已配置 + Secret vN”，并明确区分完整替换、清除和切换活动 key。
>
> 本机 Server 全量测试退出码 0，Secret 聚焦测试 8/8；Client build/lint 与 23 个文件 156/156 通过。PostgreSQL append-only、事务事件和 cascade 边界已有条件集成场景，但本机没有 PostgreSQL/Redis/Docker/`psql`，因此未执行真库验收。当前只是应用侧本地 keyring envelope，并未接入云 KMS 或 Vault Transit；在真实服务凭据、可用性/限流故障注入和 data-key 缓存策略验收前，不能将最后一项标记为生产完成。

## 8. 第六阶段：工具开发者体验与 Agent 评测（R5，预计 4～6 周）

### 工具开发体验

- OpenAPI 导入 HTTP 工具；
- MCP initialize + tools/list 发现与 Schema 导入；
- Schema 可视化编辑、测试调用、响应预览和 Output Schema；
- Endpoint allowlist 诊断、健康状态、版本 diff 和回滚；
- 测试/生产环境分离；
- 工具级并发、限流、熔断和退避。

> **第一批实施进展（2026-08-29，诊断/安全测试/MCP discovery）**：新增固定当前不可变工具版本的 preflight、只读 HTTP GET safe test 和 MCP discovery。preflight 在不发送请求、不解密 Secret 的前提下检查 URL、host:port allowlist、DNS/private-address policy、HTTPS、envelope 和操作安全；HTTP live test 仅允许 read-risk GET，复用正式输入 Schema、请求构造、Secret 审计、SSRF/DNS pinning、超时、响应上限和 response_path，所有写/high/非 GET 即使声明幂等也禁止从编辑器触发。
>
> MCP discovery 与生产 MCP runtime 共用 initialize/session/SSE+JSON/cleanup 传输层，只发 initialize、initialized 和最多 10 页/200 项的 tools/list，调用图不包含 tools/call；前端可查看 server/capability/tool 清单并把选中名称与 Input Schema 载入编辑器，保存后才形成新版本。live diagnostic 使用独立 Redis-backed 用户限流，远程请求前同步写 started 审计，审计失败 fail-closed，完成只记录 version/hash/input hash/status/error/duration/是否已跨过发送边界并尝试请求，不保存参数或响应；`live_request_attempted` 不声称远端确实收到字节。HTTP 预览限制 32 KiB；HTTP 回显及 MCP server info/描述/Schema 会按本次实际解密的全部 Secret 值递归脱敏。
>
> **第二批实施进展（2026-08-29，OpenAPI 导入/Output Schema）**：新增只解析请求体、不抓取 URL、不调用 operation 的 OpenAPI 3.0/3.1 JSON 导入。文档/结果各限 512 KiB、最多 50 个 operation、仅本地 `$ref`/12 层深度；只自动映射 GET/POST/PUT/PATCH/DELETE、安全标量 path/query 和 JSON object body，复杂 Query/header/cookie/组合 Schema/远程引用 fail-closed 或带 warning 跳过。bearer/apiKey 仅生成 Secret destination 建议，不复制凭据；每个候选结果再次经过正式 HTTP 配置 validator。导入与诊断 POST 明确返回 200，结果只进入编辑器，保存后才创建不可变版本。
>
> HTTP/MCP 配置新增可选 Output Schema：HTTP 在 response_path 后验证，MCP 优先验证 `structuredContent`、缺失时验证完整 result，错误稳定为 `tool_output_invalid`。OpenAPI response 与 MCP discovery 的 outputSchema 均可载入编辑器；MCP 发现边界现在复用正式 Input/Output Schema validator，非法 Input 降级为空 object、非法 Output 省略并返回 warning，不把未支持或危险定义带入编辑器。回归明确证明 MCP `content` 包装不会被误当作业务输出。
>
> 本批最终本地门禁：Server lint/type/Express-removal/Native-Nest 全通过；Server 主测试 518 项为 510 passed、8 个真实基础设施条件用例 skipped、0 failed，posttest 169/169；Client build/lint 与 23 个文件 158/158。真 Redis 多实例限流、真实外部 MCP/OpenAPI 兼容矩阵、登录后浏览器 E2E 及真实工具凭据尚未验证。R5 剩余为 Schema 可视化编辑、持久健康历史、测试/生产环境分离及工具级并发/限流/熔断/退避。
>
> **第三批实施进展（2026-08-29，持久工具健康历史）**：`0082_agent_tool_diagnostic_history.sql` 新增 payload-free 健康账本，以复合外键固定工具 owner、不可变 version 和 configuration hash；只保存 operation/status/request-attempt/check counts/error code/HTTP status/MCP counts/duration，不保存 input hash、参数、响应内容或 Secret，API 也剥离 user ID。历史行不可更新，每工具只保留最新 200 条；repository 用工具级 PostgreSQL advisory lock 把插入与裁剪串成同一事务，避免并发越限。
>
> 新增用户隔离的 `GET /agent-tools/:toolId/diagnostics`，支持 operation、version、1～100 条 limit 和稳定 `(checked_at,id)` 游标。工具编辑器展示当前与历史版本记录、当前版本样本通过率、检查计数、请求尝试语义、HTTP/MCP 摘要和错误码；新诊断成功持久化后自动刷新。MCP 多页 discovery 同时增加整个诊断级 deadline，不再让每页各自重置 timeout。
>
> 本批最终本地门禁：Server lint/type/Express-removal/Native-Nest 零错误，Server 主测试 519 项为 511 passed、8 个真实基础设施条件用例 skipped、0 failed，posttest 171/171；Client build/lint 与 23 个文件 159/159。`0082` 的静态约束/锁/裁剪回归已通过，但本机没有 PostgreSQL，不能宣称真实迁移、并发裁剪或 cascade 已执行。按用户要求本批完成后停止；R5 尚余 Schema 可视化编辑、测试/生产环境分离及工具级并发/限流/熔断/退避。

### Agent/Multi-Agent 评测

建立固定数据集，覆盖：

- 工具选择、参数正确性、审批遵从；
- 是否选择正确专家；
- 子任务完整性、重复率和过度委派率；
- partial failure 的诚实汇报；
- 子证据的父级引用和 grounding；
- 单 Agent、固定专家并行和模型自主委派的质量/成本/延迟对比；
- Memory 命中、过期事实、冲突、跨作用域隔离；
- Prompt Injection 和工具输出污染。

没有 paired baseline 前不写“提升 XX%”。

## 9. RAG 并行强化轨道（R6，预计 6～10 周）

Agent 核心稳定后继续补 RAG 的质量证明和基础设施边界：

1. 修复 Python/.venv/npm/Docker 本地环境，恢复真实 PostgreSQL、Redis、MinIO、Milvus、Elasticsearch、Neo4j 全链路 smoke。
2. 建立中文 Gold Dataset，覆盖事实、数字/版本、否定冲突、多文档比较、多轮追问、表格、页级引用和无答案问题。
3. 统计 Recall@K、MRR/NDCG、Source/Chunk precision、Citation precision/coverage/F1、拒答 precision/recall、P50/P95。
4. 用标注数据校准 evidence/quality 阈值，明确 heuristic 与 semantic judge 的适用范围。
5. 在 paired baseline 下分别评估 Query Rewrite、Semantic Reranker、Graph LLM Extractor 和 Judge，只有有收益才默认启用。
6. 选型并实现 OCR，补页级超时、置信度、租约和数据合规。
7. 在同一重建窗口评估中文 analyzer 与 Milvus `conversion_generation_id` 字段。

## 10. 第七阶段：生产治理（R7，持续建设）

- Queue/Worker：排队数、最老年龄、claim latency、lease failure、recovery、fencing rejection。
- Run 树：fanout/depth、waiting parent age、partial success、orphan Run、终态树异常。
- 成本：root/child Token、reserved/consumed、工具调用、重试和 indeterminate。
- 审批：pending、approve/reject/expire、等待时间和终态 Run 残留。
- Memory：候选/注入/降级/冲突/过期/敏感内容拦截。
- 工具：成功率、P50/P95、错误码、熔断、目标域和版本。
- SLO、告警、容量测试、审计归档、灾难恢复和定期 Chaos Drill。

## 11. 建议的实际开发顺序

单人持续开发按下列顺序，不跨越阶段提前堆功能：

```text
R0 正确性止血
  → R1 统一内核 + 树预算 + 父子证据
  → R2 Durable Runtime
  → R3 可配置 Agent 2.0
  → R4 Memory/审批产品化
  → R5 工具体验与 Agent 评测
  → R6 RAG 质量强化
  → R7 生产治理（全程逐步加入）
```

按单人、严格测试和迁移节奏估算，完成 R0～R3 约需 4～6 个月，做到 R5/R6 的成熟平台约需 7～10 个月。时间只是规划尺度；每阶段是否结束只由验收证据决定。

## 12. 每个变更批次的执行规范

每个任务批次必须遵循：

1. 先写行为测试和不变量，不用源码正则测试代替运行验证。
2. 数据库迁移只做 additive 变更；需要替换路径时采用 schema → dual-write/backfill → shadow read → switch → cleanup。
3. 每批只处理一个可回滚主题，禁止同时重构内核、变更数据模型和重做 UI。
4. 外部副作用采用 fake provider、故障注入和真实集成三层测试。
5. 每批运行 TypeScript、Lint、Server/Client/RAG 单测及相关 PostgreSQL/Playwright 集成门禁。
6. 每批更新本文件状态、实际测试证据、剩余风险、README 和 `docs/agent-platform.md`。
7. 能力只有在“代码存在 + 行为测试 + 集成/E2E + 运行指标”同时成立后才标记完成。

## 13. 第一批实施记录

第一批仅实施 **R0-MEM-01**，没有同时改写 Subagent 执行和工具重试；这保持了变更主题与回滚边界。

1. 已完成 Memory mode 作用域矩阵和 Persona 关闭行为测试。
2. 已完成单次上下文解析，Prompt 与 Trace 共享不可变 Memory 结果。
3. 已完成实际 injected/omitted IDs、排名降级、字符数和信任分布追踪。
4. 已完成 1 秒 Memory Embedding 超时、组合取消，以及上下文依赖卡住时停止等待。
5. 已新增迁移与 PostgreSQL 并发用例，覆盖隔离 schema 的 0051 脏数据升级/重放、直接 SQL 成环、替代 winner、A→B→C tombstone 与用户级联；这些用例仍等待本机真库执行。
6. 已确定删除/过期采用“擦除内容与向量、保留最小链元数据”的 tombstone；管理列表不返回 tombstone。
7. 已完成完整 `AgentRunService.execute()` 故障注入：上下文/Embedding 卡住时 Run 按组合 deadline 退出、持久化 `agent_run_timeout`，且不进入模型 Provider。
8. 本地门禁：整仓 `npm test` 通过；Agent Runtime 99/99；Server 全量 542 项中 535 通过、7 项基础设施集成跳过、0 失败；Client 17 个文件 126/126；RAG unittest 340 项中 338 通过、2 跳过。Server/Client build、type、lint、无 Express、Native Nest 与 diff check 均通过。
9. PostgreSQL Agent Tree 用例已接入 `.github/workflows/integration.yml` 强制门禁。唯一待办仍是让该门禁在真实 PostgreSQL 上实际执行并通过；此前不把 R0-MEM-01 标为生产验收完成。

第二批 **R0-SUB-01 + R0-APR-01** 已完成代码、迁移、单元/契约测试与 PostgreSQL 用例，等待真实 PostgreSQL 和浏览器 E2E 门禁。

第三批 **R0-TOOL-01** 已完成统一重试契约、未知副作用终态、调用账本迁移、UI 配置与故障注入测试。仍需由 CI 真 PostgreSQL 场景确认 `0054` 的实际迁移/约束行为；未登录浏览器只能验证登录边界，不能把工具编辑器开关记为真实 UI E2E。

## 14. 简历能力宣称门槛

| 表述 | 成立条件 |
|---|---|
| 支持可配置 Agent、版本发布和工具绑定 | 当前成立 |
| 支持多 Agent 并行委派、权限继承和结果汇总 | 当前基本成立，暂不宣称恢复能力 |
| 多作用域长期记忆与可审计召回 | R0 Memory 正确性完成后稳妥成立 |
| 整棵 Run 树共享预算 | 核心运行时与本地门禁已成立；真 PostgreSQL 并发门禁通过后可作生产级宣称 |
| 主/子 Agent 具有一致安全语义 | R1 Kernel parity matrix 完成后 |
| 子 Agent RAG 具有引用与 Grounding | 核心运行时与本地行为门禁已成立；真 PostgreSQL envelope 往返通过后可作生产级宣称 |
| 跨实例接管与断点续跑 | R2 checkpoint + fencing + chaos tests 完成后 |
| 可配置多 Agent 编排 | R3 Delegation Binding 和 UI 完成后 |
| Memory 管理平台 | R4 生命周期、用户控制和召回评测完成后 |
| 质量提升 XX% | 固定数据集与 paired baseline 完成后 |

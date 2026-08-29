# ChatLLM 整改任务文档

本目录记录 2026-08-19 全仓只读审查后的整改任务，覆盖缺陷修复、Agent 平台闭环、RAG/聊天一致性、前端状态、测试缺口、安全配置与实施顺序。

审查结论：**工程骨架成熟，综合约 B+ / 预发布。** 未发现跨租户鉴权绕过或 P0 发布阻断。当前主风险是 Agent Run 与旧聊天操作没有统一生命周期，以及删除/续写两条一致性缺口。带写工具的 Agent 不建议作为生产默认路径，直到 P1 修完并补上对应集成测试。

> **整改状态（2026-08-21）**：7 个 P1 + 12 个 P2 + 5 个 P3 已全部修复并有测试覆盖，另修复实施中新发现的 3 个缺陷。执行记录、验收证据与仍未处理项见 [10-整改结果与新发现.md](./10-整改结果与新发现.md)。01–09 保留为审查时的原始快照，不随修复改写。
>
> **第二轮（2026-08-20）**：在上述整改完成后针对 Agent 能力与 RAG 全链路做了一次深度分析，新修 9 项（批次 H/I/J）、撤销 1 项误判，并把 4 项确认无法在代码内解决的基础设施缺口正式立项（`B1`–`B4`）。见 [11-第二轮深度分析整改.md](./11-第二轮深度分析整改.md)。
>
> **能力建设（2026-08-20）**：在缺陷清零之后新增五个方向的能力——记忆管理、调用链追溯、工具权限管理、兜底超时失败、Subagent 任务拆分派发。核心是把 Run 从扁平记录改为 Run 树，五个方向都在同一结构上取值。见 [12-Agent能力强化-P0至P5.md](./12-Agent能力强化-P0至P5.md)。
>
> **补完与真实验证（2026-08-20）**：12 中列为"未做"的条目已全部补完，并首次装本地 PostgreSQL 实跑全部 50 个迁移与并发/递归/租约语义——此前这些只有源码断言。见 [13-Agent能力强化补完与真实验证.md](./13-Agent能力强化补完与真实验证.md)。仍未验证的只剩需要真实 Redis/Milvus/ES/Neo4j 的端到端链路。
>
> **长期强化路线（2026-08-28）**：在第三轮严格调用链复核后，按可配置化 Agent、Subagent、Memory、工具与权限审批四个支柱重新组织长期建设，并把统一执行内核、树预算、Durable Runtime、父子证据链和评测作为共同底座。见 [14-Agent四支柱长期强化路线图.md](./14-Agent四支柱长期强化路线图.md)。
>
> **四支柱 R0 三批实施（2026-08-28）**：`R0-MEM-01`、`R0-SUB-01`、`R0-APR-01`、`R0-TOOL-01` 均已完成代码与本地行为门禁，覆盖 Memory 上下文/生命周期、Subagent lease fencing 与终态树完整性、根审批单一事实源和 Chat 实时同步，以及 read/write/high/MCP 的显式重试契约、写副作用未知终态与 invocation 防重放。真 PostgreSQL 与完整审批浏览器 E2E 仍受本机基础设施/认证阻塞；精确证据见路线图实施记录。
>
> **R1 共享执行内核第一批（2026-08-28）**：根 Agent 与 Subagent 已共用 ToolExecutionKernel；补齐嵌套 Subagent 等待期间的 lease 续期/围栏，并为工具 invocation 增加 execution token，阻止并发 runtime 双重执行与旧执行者覆盖终态。`0055`、`0056` 迁移及 PostgreSQL 集成场景已接入，但本机仍无法执行真库门禁；本批当时尚未包含完整 AgentExecutionKernel、树预算和父子证据链，后两项的后续进展见下方记录。

> **R1 Run 树共享预算核心接线（2026-08-29）**：根 Run/预算同事务创建；根与 Subagent 模型调用共享调用前 reservation、调用后 settlement、最终根回答 token + iteration reserve；真实工具执行与 child 创建分别原子扣 tree tool/dispatch 额度；deadline 或终态 owner 的遗留 reservation 由维护任务保守转为 `indeterminate`。`0057` 与并发/幂等/回滚/身份边界 PostgreSQL 场景已接入；本地 Agent Runtime + 迁移定向测试 117/117，真 PostgreSQL 仍按环境条件跳过。可配置 tree budget UI/版本字段仍在后续 R1/R3 范围内；父子证据链进展见下一条。
>
> **R1 父子 RAG 证据链核心接线（2026-08-29）**：根与 Subagent 共用 EvidenceCollector；child 在返回前执行 grounding，unsupported 结论 fail-closed；`SubagentResultEnvelope` 将 verified sources、grounding、最差 RAG quality、warnings 和整棵子树 usage 与 child 终态一起持久化，跨 Worker reconciliation 后仍可恢复。模型只看到精简 source refs，完整正文只进入确定性校验；根最终回答会合并任意嵌套层级证据并再次 grounding。真 PostgreSQL envelope 往返用例已加入条件集成套件，本机仍不能宣称该真库场景实际通过。

> **R1 主/子模型协议、资源与输出一致性（2026-08-29）**：新增共享 ModelProtocolGuard，根与 Subagent 对缺失 finish reason、截断工具参数/最终答案及未声明工具调用统一 fail-closed。不可变 AgentOutputContract 统一 Schema prompt、Provider structured-output 决策、请求 token 估算、最终 Schema 校验和纠错提示；Subagent 因此完整继承 Agent JSON 输出契约及 Schema 合法的证据不足拒答。共享 ResourceGovernor 与模型调用账本内核进一步统一上下文规划、整批工具副作用前预检、reservation settlement 和 Run usage：未知 Provider 结果整笔保守计入预算与 usage，且只记一次。本批定向门禁 Agent Runtime 115/115；完整 AgentExecutionKernel 与 checkpoint 仍在后续 R1/R2 范围内。

> **R1 审批、上下文与 Checkpoint 契约收敛（2026-08-29）**：根与 Subagent 已共用 ApprovalCoordinator，统一同进程唤醒、跨实例持久态轮询、用户/Run/Approval 身份校验、过期与取消清理；共用 AgentContextManager 规划请求和累计历史压缩，修复旧 digest 被二次当作原始历史的问题，并将压缩摘录保持为不可信 user 数据。新增 `0058` 和版本化 Checkpoint 接口，payload 同时受应用/数据库字节上限保护，更新使用 generation CAS，Subagent 还必须提交当前 lease token；本地 Agent Runtime 117/117、迁移定向合计 129/129。Checkpoint 暂未接入恢复 Worker，因此仍不宣称支持进程崩溃后的断点续跑；真 PostgreSQL 的 CAS/lease/大小约束场景已加入条件集成套件但本机未执行。

> **R2 Durable Runtime 核心闭环（2026-08-29）**：`0059`～`0069` 已把根/子 Run 接入 hashed Work Item、generation-zero bootstrap、完整 checkpoint、claim-fenced 模型/工具结果、持久事件游标和数据库终态事件兜底。HTTP 只提交 Root Run、助手占位与 Work Item，不 claim、不调用 Provider；Worker 可恢复模型/工具/连续审批/Subagent/final-answer 边界。Subagent 派发固定不可变 manifest，parallel 整批原子物化，sequential 按 child 终态逐个 wake/advance；task index 贯穿 Work Item、结果和父工具输出，重试不重复建 child 或扣预算。Redis 丢失 BullMQ job 可由 PostgreSQL queued/expired 扫描重建，terminal trigger 覆盖 maintenance 等旁路。当前本地门禁为 Agent Runtime 142/142、migration 23/23、BullMQ/runtime lifecycle 5/5，Server build/lint/Native Nest 与 Client build/lint/132 项测试通过；真实 PostgreSQL/Redis 条件场景已接入 CI，但本机没有对应基础设施，故仍不宣称 R2 已完成生产级 Chaos 验收。

> **R3 Agent/Memory/Tool 版本治理（2026-08-29）**：`0070`～`0072` 已实现不可变 Agent 版本与 publication、结构化 Memory Policy、append-only 自定义工具版本和 Secret revision。Agent binding、根/子 Run、manifest、Work Item 与 recovery 固定精确 `tool_version_id + configuration_hash + secret_version`；工具定义变化不自动漂移已发布 Agent，历史恢复按版本读取，删除采用 soft delete，实时 enabled/scope 仍可安全撤权。Agent/工具编辑器支持历史、来源、hash、字段 diff、复制式回滚和显式工具升级。当前本地门禁为 Agent Runtime 150/150、迁移/Mutation 契约 39 passed、Client 20 个文件 143/143，Server/Client build 与 lint 均通过；真 PostgreSQL 条件场景已扩充但本机无 PostgreSQL/Redis/Docker/`psql`，不可宣称迁移和 Chaos 真基础设施验收完成。后续 Delegation 进展见下一条；本阶段剩余 draft dry-run 与按版本评测。
>
> **R3 显式 Delegation Binding（2026-08-29）**：`0073` 已把协作者目录纳入不可变 Agent version 与 v4 配置指纹，alias 固定解析到精确 `agent_id + agent_version_id`，并限制 role、并发和可下发上下文；模型不接触 UUID。发布前静态遍历同用户、publication、启用状态、项目 scope、自引用、循环、深度、图规模和 legacy dependency；Agent 禁用、删除、scope 迁移与入站依赖在同一用户级锁和事务中 fail-closed。根/子 Run、恢复快照、dispatch manifest、Work Item 与结果均固定协作者元数据；前端已提供版本化协作者目录和显式升级。当前本地定向门禁为 Server 193/193、Client 21 个文件 147/147；真 PostgreSQL 条件用例与登录后编辑器 E2E 仍受本机基础设施和认证阻塞。后续 dry-run 进展见下一条。
>
> **R3 Agent Draft dry-run（2026-08-29）**：`0074` 新增与生产 Run/会话分离的不可变版本预览账本。预览执行真实固定模型、Prompt、工具定义和输出契约，但省略会话/Persona/长期 Memory/项目上下文；运行时没有工具执行器，也不读取工具 Secret，所有调用只做 name/参数 Schema/审批决策模拟，不创建 Invocation、Approval、Subagent、消息或 Memory 写入。Agent 生命周期变化与 stale sweep 会终止或收敛预览；编辑器可对任意版本发起试运行并查看校验、输出、usage 和工具计划。当前本地 Server 全量 build/lint/test 零失败（Agent Runtime 155/155；定向组合 216/216），Client build/lint 与 21 个文件 147/147、`git diff --check` 通过；浏览器未登录 smoke 正常，版本面板已登录 E2E 未覆盖。真 PostgreSQL 条件用例已加入但本机未执行。R3 下一项为按 Agent version Eval/baseline。
>
> **R3 Agent Eval/baseline（2026-08-29）**：`0075` 与独立 Agent Eval 模块把 Dataset revision、candidate/baseline version/hash、evaluator、Case snapshot 和 Result 固定到独立账本；工具只允许显式 fixture replay，生产 Tool/Secret/Run/Message/Invocation/Approval/Memory 均不可达。Durable Worker 使用 PostgreSQL lease/fencing，支持幂等活动 Run 复用、配额、取消和 Agent/Dataset 生命周期失效；前端支持 Dataset/Gold Case、baseline、paired 指标、逐 Case 结果。严格审查补齐 SQL NULL 完整性、不可变 snapshot、活动组合唯一索引、删除竞态和无重叠轮询。当前 Server build/lint/full test 零失败（Agent Runtime 155/155、Agent Eval 7/7），Client build/lint 与 22 个文件 149/149，Browser 未登录 smoke 正常；真 PostgreSQL 与登录后 Eval E2E 仍因本机环境不可宣称通过。主线进入 R4 Memory/审批产品化。

> **R4 Memory 生命周期与 scope 控制（2026-08-29）**：`0076`、`0077` 已接入候选/确认/拒绝、verification/confidence/sensitivity、来源证据、append-only event、tool-derived quarantine、embedding 前 Secret 扫描、游标/搜索/来源深链和 user/project/agent 类别开关。数据库以用户+scope advisory lock 同时串行化写入配额、开关和最终 recall accounting：关闭先提交会拒绝旧快照并回滚整次 Run，并发写入不能越过每 scope 默认 500 条硬配额。Memory Center 展示三类开关、配额和待确认数，关闭后保留历史供审查但停止召回与新写入。本地 Server full test 退出码 0、Memory 定向 205/205，Client build/lint、22 个文件 149/149，Browser 未登录鉴权 smoke 通过；真 PostgreSQL 条件场景已补但本机无基础设施，登录后开关 E2E 未覆盖。主表遗忘仍不能擦除已经复制到历史 Work Item/Checkpoint/Step/模型工具快照的文本，必须继续设计可擦除 envelope 或有界清理。

> **R4 Approval Intent 与 Inbox（2026-08-29）**：`0078` 将工具版本/配置/Secret revision、canonical input hash、脱敏目标/方法、风险、完整策略链和副作用摘要固定为不可变 Approval Intent，并由数据库约束 Intent、canonical Step 与批准转换一致。根 Agent、Subagent 和 Durable Recovery 都在真正执行副作用前重新加载 pinned 工具并重算 Intent，漂移以 `AGENT_APPROVAL_INTENT_MISMATCH` fail-closed。Agent 中心新增当前用户隔离、稳定游标的审批 Inbox，时间线与 Inbox 展示同一意图和脱敏参数；旧 pending 审批迁移时统一过期，旧终态只保留 `legacy-unbound` 审计投影。本地 Server full test 退出码 0、Agent Runtime 后置 158/158，Client build/lint 与 22 个文件 149/149；真 PostgreSQL 条件场景已补但本机无基础设施，登录后 Inbox E2E 未覆盖。

> **R4 Memory 混合召回第一批（2026-08-29）**：自动与显式 `recall(query, scopes, limit)` 共用中英 lexical + 同模型向量 + recency/trust/confidence 融合内核；SQL 以每 scope 50、整次 150 条候选防止单 scope 饥饿，relevance threshold、MMR 和保守冲突降权在 Top-K/Token 注入前生效。Query embedding 不可用或历史向量不兼容时保持确定性降级。Trace 区分 fetched、filtered、injected/omitted、可比较向量与冲突降权，recall accounting 只记录实际注入 ID。当前 Server full test 退出码 0、Agent Runtime 158/158、召回定向 6/6，build/lint 通过；真实中文 Gold Dataset、Recall@K/MRR/P95 校准、pgvector 对照、多轮问题重写和持久滚动摘要仍未完成。
>
> **R4 Memory 异步 Embedding/Backfill（2026-08-29）**：`0079` 以 PostgreSQL durable job 作为 queued/running/terminal、attempt/backoff 和 lease fencing 的事实源，BullMQ 只携带 `memoryId` 唤醒；Redis 丢 job 后可扫描重建。`remember` 不再阻塞 Provider，candidate 确认前不建任务，confirmed/历史缺向量 Memory 异步补齐。完成写回复核 owner token、未过期 lease、Memory 生命周期和 scope gate；scope opt-out 与完成使用一致锁序，删除/替代/遗忘/自然到期会取消并 fence 晚到结果。Provider timeout、heartbeat、最大尝试、指数退避、半残 vector/model 修复和 lifecycle 托管均已接入。Server 全量 491 项为 484 passed、7 个基础设施条件用例 skipped、0 failed，lint/type/架构门禁通过；真 PostgreSQL/Redis 的迁移、backfill、lease takeover 与故障恢复因本机无基础设施尚未实际执行。
>
> **R4 持久 Conversation Summary 与 Memory Gold（2026-08-29）**：`0080` 将确定性 extractive summary 以 `(created_at,id)` watermark、revision、candidate/included/omitted 数和 Token 预算持久化，作为 user-role untrusted pinned data 固化进 Durable snapshot；消息编辑/删除与刷新使用同一 advisory lock 并使覆盖快照失效。Agent 编辑器已开放摘要策略。随后新增 30 条 Memory、34 个中文问题、1,020 条穷举判断的 `agent-memory-zh-CN-v1`，用 `npm run eval:memory` 门禁 Recall@5/MRR/无关注入/零命中安全率/进程内 P95；首轮误注入被基准捕获后，通过相对 lexical 下限和 `no_relevant_match` 空注入修复。当前本机报告为 1/1/0/1、P95≈0.67ms，但不包含数据库/网络/Provider，不能当作生产 SLA。Server/Client 全量门禁通过；`0080` 真 PostgreSQL trigger/竞态与 pgvector/HNSW 对照仍未在本机执行。
>
> **R4 pgvector/HNSW 对照框架（2026-08-29）**：新增 deterministic synthetic vector benchmark，对同一 gold ranking 比较应用 exact scan、pgvector exact scan 和 HNSW 的 Recall@K/MRR/P50/P95；独立 CI job 在 pgvector PostgreSQL 中跑 5,000×64 维、40 query 门禁。本机只能通过 corpus/脚本测试，真库场景明确 skipped；在 CI 结果和真实中文向量 paired benchmark 之前，不迁移生产 `real[]` schema，也不宣称 HNSW 性能收益。
>
> **R4 Memory 多轮独立问题解析（2026-08-29）**：自动召回现在会用同一份 policy-bounded recent history 把“那它失败后呢”等省略问题确定性展开，最多回溯 3 个 user turn，assistant 输出永不作为检索主题；不调用额外模型，2,000 字符预算优先保留当前问题。Trace 只记录改写元数据和 SHA-256，避免再复制会话正文。conversation disabled 时不会偷读历史；取消在 history 阶段仍会立即终止。聚焦 163/163 与 Server lint/type/架构门禁通过。
>
> **R4 Secret 生命周期（2026-08-29）**：自定义 HTTP/MCP 工具凭据升级为带 key ID、行身份 AAD 和多 key 解密的 AES-GCM v2 envelope，保留 v1 读取迁移；新增不可变 rewrap 版本、并发 fencing、append-only configured/replaced/cleared/used/decrypt_failed/rewrapped 审计和审计失败时的发送前 fail-closed。HTTP/MCP 共享严格 Secret destination 规则，前端改为不回显的逐字段替换/清除/切 key 流程。Server 全量测试退出码 0、Secret 8/8，Client build/lint 与 23 个文件 156/156 通过；真 PostgreSQL 条件场景未在本机执行，KMS/Vault 尚未接入，当前不能宣称生产密钥托管完成。
>
> **R5 工具诊断与 MCP discovery 第一批（2026-08-29）**：工具编辑器新增不发请求的 allowlist/DNS/HTTPS/Secret-envelope preflight、仅 read-risk HTTP GET 的安全测试及 MCP initialize + 有界分页 tools/list 发现/Schema 导入；写/high/非 GET 不存在测试旁路，MCP discovery 不调用 tools/call。live 操作复用正式 SSRF/DNS pinning、Secret used 审计、超时和响应上限，先写诊断 started 审计并受共享限流；预览 32 KiB，HTTP/MCP 回显内容按实际 Secret 值递归脱敏。Client build/lint 与 23 个文件 157/157 通过；真 Redis 多实例限流、真实 MCP 兼容和登录后 E2E 尚未验证。
>
> **R5 OpenAPI 导入与 Output Schema 第二批（2026-08-29）**：新增有界、纯本地解析的 OpenAPI 3.0/3.1 JSON operation 导入，复杂参数/引用/鉴权 fail-closed，Secret 只生成安全 destination 建议；HTTP 在 response_path 后、MCP 在 structuredContent 上执行固定 Output Schema，违约统一为 `tool_output_invalid`。MCP discovery 会在载入编辑器前验证 Input/Output Schema，非法定义省略并告警；诊断审计字段收敛为不夸大远端接收事实的 `live_request_attempted`。Server 主测试 518 项为 510 passed、8 条基础设施条件场景 skipped、0 failed，posttest 169/169；Server lint/type/架构与 Client build/lint、23 文件 158/158 全通过。真实外部兼容、Redis 多实例和登录后 E2E 仍未验证。
>
> **R5 持久工具健康历史第三批（2026-08-29）**：`0082` 以工具 owner、不可变 version 和 configuration hash 复合约束诊断记录；健康数据不含 input hash、参数、响应正文/预览、Secret 或下发浏览器的 user ID。每工具最多 200 条，工具级 PostgreSQL advisory lock 串行化插入与裁剪；GET API 支持 operation/version 过滤和稳定游标，编辑器展示版本化状态、通过率样本、耗时和安全摘要。Server 主测试 519 项为 511 passed、8 条真实基础设施场景 skipped、0 failed，posttest 171/171；Client build/lint、23 文件 159/159 全通过。真 PostgreSQL 迁移/并发裁剪未在本机执行；按用户要求本批后停止继续开发。

## 文档索引

| 文件 | 内容 |
|------|------|
| [01-质量总评与范围.md](./01-质量总评与范围.md) | 评级、审查范围、强项、明确不做的能力 |
| [02-P1-必须修复.md](./02-P1-必须修复.md) | 7 个 P1：复现、根因、预期行为、修复建议、验收 |
| [03-P2-P3-缺陷清单.md](./03-P2-P3-缺陷清单.md) | 12 个 P2 + 5 个 P3 的完整清单 |
| [04-Agent平台整改.md](./04-Agent平台整改.md) | Agent 能力评估、生命周期缺口、产品边界 |
| [05-RAG聊天与数据一致性.md](./05-RAG聊天与数据一致性.md) | 检索缓存、删除失效、续写 RAG、召回过滤 |
| [06-前端体验与状态.md](./06-前端体验与状态.md) | 首条发送、SSE 恢复、消息合并、错误提示 |
| [07-测试缺口.md](./07-测试缺口.md) | 现有测试地图 vs 应补回归 |
| [08-安全配置与残余风险.md](./08-安全配置与残余风险.md) | 已有安全边界、配置 fail-open、运维残余风险 |
| [09-整改路线图.md](./09-整改路线图.md) | 分批实施顺序、建议验收门槛、完成定义 |
| [10-整改结果与新发现.md](./10-整改结果与新发现.md) | 执行记录：每个 ID 的实际改动、验收实跑结果、新发现缺陷、新增测试、仍未处理项 |
| [11-第二轮深度分析整改.md](./11-第二轮深度分析整改.md) | 第二轮：H/I/J 三批已修项、撤销的误判、经评估不改的项、`B1`–`B4` 基础设施阻塞立项、跨平台约束 |
| [12-Agent能力强化-P0至P5.md](./12-Agent能力强化-P0至P5.md) | 能力建设（非缺陷修复）：Run 树与 span、跨服务追溯、共享预算账本与优雅降级、审批策略链与越权防护、Subagent 拆分派发、长期记忆与投毒防护；含明确未做项 |
| [13-Agent能力强化补完与真实验证.md](./13-Agent能力强化补完与真实验证.md) | 补完 12 的未做项（每工具调用上限、记忆语义召回、滚动摘要、批量审批、子 Agent 队列化），并首次在真实 PostgreSQL 上验证全部迁移与并发/递归/租约语义 |
| [14-Agent四支柱长期强化路线图.md](./14-Agent四支柱长期强化路线图.md) | 按四个 Agent 支柱规划正确性止血、共享执行内核与树预算、Durable Runtime、可配置 Agent 2.0、Memory/审批产品化、评测、RAG 强化和生产治理 |

## 优先级约定

- **P0**：发布阻断或安全绕过。本次未发现。
- **P1**：会破坏用户数据、错误执行外部副作用、或核心恢复路径失效。应先修。
- **P2**：正确性/一致性缺陷，用户可感知，但通常不立刻污染数据。
- **P3**：边角、文案误导、极端路径。值得修，但不阻塞预发布。

缺陷 ID 在各文档中保持稳定（如 `P1-TRUNCATE-RUN`），路线图与清单互相引用。

## 使用方式

1. 先读 [01](./01-质量总评与范围.md) 建立整体判断，避免把「明确不做」的能力当成缺陷。
2. 实施时按 [09](./09-整改路线图.md) 的批次，不要平行改互不相关的大面。
3. 每个 P1 的验收标准以 [02](./02-P1-必须修复.md) 为准；测例缺口以 [07](./07-测试缺口.md) 为准。
4. 本目录是工作任务，不是对外产品文档。对外能力说明仍以 `docs/agent-platform.md` 和根目录 `README.MD` 为准；修复完成后应回写那两份文档里过时的承诺（尤其是「SSE 断线后从 DB 恢复」）。

## 审查元数据

- 日期：2026-08-19
- 方法：文档对照 + 缺陷优先读代码；P1 均回源确认
- 覆盖：`client/`、`server/`、`rag-service/`、迁移 `0036`–`0042`、CI `.github/workflows/quality.yml`
- 未包含：完整 `npm test` / `rag:smoke` 实跑、Docker 全栈压测、真实供应商额度下的检索效果评测
- 补记：整改阶段已实跑完整 `npm test`（含 client vitest、server 全量、RAG unittest）与 `npm run lint`，结果见 [10](./10-整改结果与新发现.md)；Docker 全栈压测与真实额度评测仍未做

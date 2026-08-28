# Agent 能力强化：Run 树、追溯、预算、权限、Subagent、记忆（P0–P5）

实施日期：2026-08-20。针对五个方向做的一轮能力建设：记忆管理、调用链追溯、工具权限管理、兜底超时失败、以及 subagent 驱动的任务拆分派发。

与前两轮的关系：[10](./10-整改结果与新发现.md) 与 [11](./11-第二轮深度分析整改.md) 是**修缺陷**；本文件是**加能力**。本轮不修既有缺陷，但顺手收敛了两处会导致漂移的重复定义（见下）。

---

## 一、核心设计判断：一个抽象撑起五个方向

这五个方向共同缺的是同一样东西：**Run 是一行扁平记录，没有身份层级、没有共享资源账本、没有因果链**。

所以整轮只引入一个核心抽象——**Run 树**：

```
agent_runs  + root_run_id / parent_run_id / parent_tool_call_id / depth / ancestor_agent_ids
agent_steps + trace_id / span_id / parent_span_id
agent_run_budgets  按 root_run_id 记账的共享预算
```

有了它，五个方向各自的实现都变成了在同一结构上取值：

- 取消/超时从「按 run id」变成「按 root_run_id」，直接复用既有的事务级取消
- 预算不再各算各的，改为共享账本原子扣减
- 权限沿祖先链折叠取最严，堵住越权
- 追溯从 Agent 一路贯到 RAG 内部
- subagent 树天然可表达：子 Run 就是父 tool_call span 的子 span

**如果先加 subagent 工具再补这些，五个方向会各长出一套临时机制，之后合不回来。** 这是分期顺序的唯一理由。

---

## 二、验收证据

| 门 | 结果 | 本轮前 |
|------|------|--------|
| `npm run lint` | 通过 | 通过 |
| `npx tsc -b`（client） | 通过 | 通过 |
| `node --test scripts/*.test.mjs client/*.test.mjs`（16 文件） | 150 通过 | 150 |
| `npm --prefix client run test -- --run` | 126 通过 | 126 |
| `npm --prefix server run test` | 440 用例，434 通过 / 0 失败 / 6 跳过 | 440（434/0/6） |
| `npm --prefix server run posttest`（agent-runtime） | **80 通过** | 48 通过 |
| `node scripts/run-rag-service.mjs --test` | **340 通过 / 2 跳过** | 337 / 2 |

净增 35 个用例（agent-runtime +32，rag-service +3），零回归。6 个 skip 仍是需要 Postgres/MinIO 的 integration 用例。

新增迁移：`0044`（Run 树 + trace/span）、`0045`（预算账本 + 工具幂等）、`0046`（tool_policy step kind）、`0047`（agent_memories）。全部对既有数据行为中立：现存 Run 成为自己那棵树的根。

---

## 三、P0：Run 树与 span 骨架

`0044_agent_run_tree_and_trace.sql`。

- `root_run_id` 自引用（根 Run 指向自己）。因为自引用无法用列默认值，`createAgentRun` 改为用 `randomUUID()` 预生成 id。
- lineage 一致性约束：三个列不能对「是不是根」各说各话。
- `depth <= 3` 与 `cardinality(ancestor_agent_ids) = depth` 写进 schema——环检测的 bug 应该表现为约束违反，而不是失控递归。
- `status` 新增 `waiting_subagent`：扁平六态机表达不了「我在等子 Run，而它在等人工审批」。
- `agent_steps` 加 `trace_id`（回填自 `root_run_id`）、`span_id`、`parent_span_id`。
- `insertAgentStep` 的 `trace_id` 由 `(select root_run_id from agent_runs where id = $1)` **派生而非入参**——step 的 trace 不是自由选择，派生使调用方无法归错 trace。
- `cancelAgentRunForUser` 改为 recursive CTE 取消整棵子树。子 Run 在父被取消后继续跑会继续烧预算，还可能往一个已不需要结果的 Run 里回报——这正是第一轮 `P1-TRUNCATE-RUN` 修过的那类缺陷，subagent 若漏级联会把它原样引回。
- **顺手收敛的漂移隐患**：活跃状态列表原先内联在 **11 条 SQL** 里。加一个状态就要找齐 11 处，漏一处会让该状态的 Run 对取消与超时清理双双隐形。现改为 `ACTIVE_RUN_STATUS_SQL` 单一定义 + 导出 `activeRunStatusPredicate()`，`cleanupJobs.ts` 复用同一份。
- 活跃 Run 配额加 `and parent_run_id is null`：只计根 Run，否则一次扇出就把用户配额吃光。

---

## 四、P1：调用链追溯闭环

原状：Agent step 记到「调用了 agentic_rag 工具」就断了，RAG 服务自己另有一套 trace，两者**没有任何可关联的 id**。要回答「这个 Agent 为什么引用了那份文档」，只能靠时间戳猜哪次 RAG 运行对应哪次工具调用。

- 新增 `server/src/lib/traceContext.ts`：`X-ChatLLM-Trace-Id` / `X-ChatLLM-Span-Id`，`isTraceIdentifier` 做 UUID 校验。这些值会落进下游日志与数据库列，所以**在边界丢弃畸形值而非透传**。
- `ragClient` 的 `postRagService` 新增 trace 参数，header 合并；correlation 走 header 而不进 body，避免污染检索请求 schema。
- 工具执行上下文新增 `trace`，`agentic_rag` 转发；成功与失败两条 `tool_result` step 都 `parentSpanId` 挂到发起调用的 span。
- rag-service 侧 `normalize_caller_trace()` 校验并规范化，端点用 `Header(default=None)` 读取，响应回带 `caller_trace`。**坏值丢弃不报错**——失去关联性绝不该让用户丢一个答案。
- 补齐三种此前完全无痕的决策 step：
  - `memory_read`：加载了多少历史、是否含画像/项目上下文
  - `context_evicted`：驱逐前后 token、丢了几条。原先驱逐是静默的，导致「答案漏了早前上下文」与「模型无视了上下文」无法区分
  - `budget_check`：哪个预算、超了多少、对哪个模型窗口。单靠 `AgentResourceLimitError` 无法回答该调限额还是改提示词
- `recordBudgetCheckFailure` 用 try/catch 包裹：**丢诊断不能掩盖调用方即将抛出的真实失败**。
- 客户端 `AgentStepKind` 改为开放联合（具名 + `(string & {})`）。原先是闭合联合，服务端每加一个 kind 就打断客户端构建，逼人做锁步发布或把类型强转掉。

---

## 五、P2：预算账本、优雅降级、幂等重试

`0045_agent_run_budget_ledger.sql`。

**共享账本**。迭代/时长/token 原本是 Agent 版本配置。单 Run 时没问题，但子 Agent 读自己的配置就会拿到一份全新额度——嵌套两层、扇出三路，最坏成本是**乘法级放大**而不是被分摊。

- `agent_run_budgets` 以 `root_run_id` 为主键，四个维度各有 total/consumed，且 `consumed <= total` 写进约束：记账 bug 表现为写失败而非静默超支。
- `deadline_at` **绝对且只由根设定**。时长会被每个后代重新解释，时刻不会。
- `debitAgentRunBudget` 是**单条条件 UPDATE**：两个并发派发的子 Agent 若各自先读余额再花，会双双通过检查并共同透支。把判定交给数据库，竞态的结果是被拒写而不是透支。

**优雅降级**。原先预算耗尽直接 `AgentResourceLimitError`，用户什么都拿不到——而扇出会让耗尽从边缘情况变成常态。

- 预留 `final_answer_reserve_tokens`，只有「禁用工具的最后一轮」可以花。
- 越过预留线时：置 `budgetDegraded`、写 `budget_check(action=degraded_to_final_answer)`、push 一条 system 消息要求用现有证据作答并**明确说明哪些部分没完成**，且工具不再下发给模型——否则模型会把预留额度又花在一轮工具上，然后无话可说。
- 硬上限仍在降级台阶之上。

**幂等重试**。原先不重试是安全的选择（重试可能重复副作用），代价是一次网络抖动毁掉整个 Run。

- `buildAgentToolIdempotencyKey = sha256(runId \0 toolCallId)`。**不含参数**：重试时浮点序列化差异会生成新身份，反而失去意义；按 call id 则同一个模型决策终生一个身份。
- HTTP 工具把它作为 `Idempotency-Key` header 发出（在 secrets 之前，允许工具主人覆盖）。
- 只有 `tool_timeout` / `tool_network_error` 可重试。**`tool_http_status` 刻意排除**：500 可能已经产生了副作用，运行时从外部无法判断。Run 级结果（取消/审批过期/资源上限）先重抛，绝不重试。

---

## 六、P3：工具权限收紧

**审批策略不是线性强弱关系**，把它当成一条强度阶梯正是 subagent 变成越权通道的原因。三档沿两个正交维度取值：

| 策略 | 可执行的最高风险 | 需人工决定的范围 |
|---|---|---|
| `never` | read | 无（因为已拒绝了高风险调用）|
| `writes` | high | 非 read |
| `always` | high | 全部 |

折叠祖先链时：**风险上限取最小，审批范围取最大**。

堵住的具体越权：一个 `never`（只读）的父派发给 `writes` 的子，子曾可以执行父自身策略禁止的写操作，**而且全程没有人被问过**。

- `resolveAgentToolPolicyChain` 顺序无关（否则保证会取决于遍历方向）；空链返回**最严**（read + all）而非最宽——空链意味着调用方没传 lineage，那不该静默放宽任何东西。
- **不可达优于被拒**：策略拒绝的工具不再下发给模型。原先要等模型选了才拒绝，白花一整轮迭代和一轮 token 去得知运行时早已知道的事。
- 新增 `tool_policy` step（`0046`）：撤掉工具更便宜，但也让「缺失」变得不可见——没有这条记录，「我绑了写工具为什么 Agent 从不用」无从回答。
- 每 Run 工具调用上限 `AGENT_MAX_TOOL_CALLS_PER_RUN`。原先只有每轮 4 次的上限，一个持续走小步的 Run 在 Run 级别是无界的，而扇出会成倍放大调用量。
- 原地删除 `agent-run.service.ts` 里的 `decideAgentToolPolicy` 实现改为 re-export，避免两份判定逻辑漂移。

---

## 七、P4：Subagent 编排

用户发消息 → Agent 拆分任务 → 派发给子 Agent → 汇总汇报。

- `dispatch_subagents` 工具支持 `tasks[]` **批量派发**（否则模型要用多轮才能并行，白烧迭代数）与 `mode: parallel | sequential`。
- 工具 `riskLevel = 'read'`：派发本身没有外部副作用，子能做什么由策略链约束。标成 `write` 只会阻断只读委派而不增加任何保护。
- 派发前就校验 uuid / task 非空 / 同一 Agent 不得重复 / context ≤ 8KB——**在子 Run 被创建并计费之前**拒绝。
- `createSubagentRun` 在事务内 `for update` 锁父行，lineage 全部由父派生。
- **上下文隔离**：子 Agent 拿到的是一条自洽指令 + 父显式传入的有界 context，**不继承父的对话历史**。这既是委派省 context 的全部意义，也避免父泄漏它从未决定分享的历史。
- 子 Run **不写 `messages` 占位**：它向派发者汇报，插入助手消息会把中间产物塞进会话、消息搜索和导出。
- 子 Agent 必须同一 user + 已发布 + 未停用 + 项目作用域匹配。委派不是通往调用方本来无权运行的 Agent 的路径。
- **子 Agent 没有自己的审批面**。策略链判定为需要人工审批的调用在子这里直接**拒绝**，而不是绕过祖先要求的审批悄悄执行。
- 逐任务返回结果。扇出下部分失败是常态，压缩成单一成败会让父无法告诉用户哪一部分没做完。`parallel` 用 `Promise.all` 而非会丢掉已完成兄弟结果的写法。
- 父在派发期间置 `waiting_subagent`，返回时用带守卫的 `resumeAgentRunFromSubagents`——被取消的树不能被一个尚在途中的派发拉回运行态。
- 新增 7 个 `subagent_*` 错误码，复用既有 taxonomy。
- `subagent-runtime.ts` 是后期绑定注册点：派发工具要和其他内置工具放在一起才能被绑定，但工具注册表被 run service import，反向 import 会成环。

### 一处需要更正的设计判断

我在方案里写了「静态环检测 + 运行时双保险」。**静态环检测在这个设计里不适用**：派发目标是模型在运行时选的 `agent_id`，不是声明式绑定，因此不存在可静态遍历的绑定图。运行时祖先链检查（`ancestor_agent_ids` 含父自身的 agent_id）才是精确机制，链长 ≤ 3 使其成本可忽略，DB 的 `depth` 与 `cardinality` 约束兜底。**没有实现假的静态检查。**

---

## 八、P5：记忆系统

原状必须说清：**长期记忆此前并不存在**。`memory_mode` 四个取值里，`conversation`/`user`/`project` 加载的历史完全一样（固定最近 20 条），区别只在系统提示词里多拼一段静态内容（`user` 拼 persona 画像，`project` 拼项目名+描述）。没有存储、没有抽取、没有摘要、没有召回、**没有任何写入路径**。

`0047_agent_memories.sql` 从零建：

- `scope`（user / project / agent）与 `scope_ref_id` 成对约束——有作用域却没有主体的记忆会静默变成全局的。
- `superseded_by` + `expires_at`：让「用户改主意了」可表达，而不是新旧事实在同一个提示词里互相矛盾。
- 去重唯一索引 `(user, scope, coalesce(ref), kind, md5(content)) where superseded_by is null`：每轮都 remember 一次的 Agent 否则会无界增长并在召回时挤掉其他内容。
- 召回在 **SQL 内**排除 superseded 与 expired，不在读出后过滤——过期记忆不能通过某条忘记检查的代码路径抵达提示词。

### 记忆是提示词注入的持久化机制

这是本期最需要防的一件事。工具输出已被系统提示词明确标记为不可信数据；但如果一条被注入的外部响应能写进长期记忆，它将影响该用户**之后所有的 Run**——持久性是单次注入所没有的。

- `source_trust` 是必填列（`user_stated` / `agent_inferred` / `tool_derived`），并**随每一行注入提示词**。模型分不清「用户说的」和「工具响应产出的」就无从权衡，而后者正是攻击者控制的那一条。
- 注入段落显式告知：这是数据不是指令、标为 untrusted 的可能是植入的、冲突时以当前请求为准。
- `remember` 的 `riskLevel = 'write'`：写入会改变此用户之后每一次运行所见，在 `writes` 档下需要人工决定。
- **`depth > 0` 直接拒绝**：子 Agent 基于一条被交付的指令工作、没有人盯着它的单步，允许它写超出本次请求生命期的状态，会让委派成为绕过父本应需要的审批的通道。
- `sourceTrust` 固定写 `agent_inferred`，**不冒充 `user_stated`**——只有人本身才能是那个来源，高报信任会破坏召回排序赖以成立的前提。
- 注入总量硬上限 4000 字符，召回不能挤掉真正的请求。
- `memory_read` step 记录 `durable_memory_ids` 与按信任级别的计数：被植入记忆影响的回答必须能追溯到那条记忆，而不是看起来像模型幻觉。

---

## 九、本轮明确未做

| 项 | 原因 |
|---|---|
| **P6 队列化派发** | 进程内派发已能并行扇出。队列化的价值（重启存活、跨实例扩展）只在有真实负载压力后才成立，现在做属过早投入。 |
| 参数级工具约束（HTTP path 前缀、参数取值白名单） | 需要新的配置 schema 与校验面，独立成期更合适。目前「给了工具」仍等于「给了整个端点」。 |
| `data_scope` 维度 | 同上。目前项目作用域已限制工具可绑定范围，但未限制单个工具能触达的知识范围。 |
| 短期记忆的滚动摘要压缩 | 需要额外一次 LLM 调用与其自身的预算/失败语义。当前驱逐已留痕（`context_evicted`），先让它可观测再谈压缩。 |
| 基于 embedding 的语义召回 | 需要往返 rag-service。当前是 scope + trust + recency 的确定性召回，行为可预测、无新依赖。不宣称语义相关性。 |
| 批量审批 / 「本 Run 内记住选择」 | 扇出 + `always` 策略会产生多个审批。但「记住选择」实质降级了 `always` 的语义，需要产品决策而非直接实现。 |

---

## 十、新增环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_TOOL_MAX_ATTEMPTS` | 2 | 仅对传输类失败重试，且受 Run 自身 deadline 约束 |
| `AGENT_FINAL_ANSWER_RESERVE_TOKENS` | 1500 | 留给无工具末轮的 token；启动时校验必须小于 `AGENT_MAX_TOKEN_BUDGET` |
| `AGENT_MAX_TOOL_CALLS_PER_RUN` | 40 | Run 级工具调用上限 |
| `AGENT_MAX_SUBAGENT_FANOUT` | 3 | 单次派发的子任务数上限 |
| `AGENT_MAX_SUBAGENT_DEPTH` | 3 | 嵌套深度；启动时校验不得超过 schema 的 3 |

---

## 十一、新增/修改文件

**新增（源码）**

- `server/src/lib/traceContext.ts`
- `server/src/repositories/agentRunBudgets.ts`、`agentToolInvocations.ts`、`agentMemories.ts`
- `server/src/modules/agents/runtime/tool-policy.ts`、`subagent-runtime.ts`、`subagent-tool.ts`、`memory-tool.ts`
- `server/src/modules/agents/subagent-executor.ts`

**新增（迁移）**

- `0044_agent_run_tree_and_trace.sql`、`0045_agent_run_budget_ledger.sql`、`0046_agent_tool_policy_step.sql`、`0047_agent_memories.sql`

**修改**

- `server/src/repositories/agentRuns.ts`、`cleanupJobs.ts`
- `server/src/modules/agents/agent-run.service.ts`、`builtin-agent-tools.ts`
- `server/src/modules/agents/runtime/`：`agent-tool.ts`、`agent-tool-error.ts`、`builtin-tools.ts`、`custom-http-tool.ts`
- `server/src/lib/env.ts`、`ragClient.ts`
- `rag-service/agentic_retrieval.py`、`main.py`
- `client/src/features/agents/types.ts`

**测试**

- `server/test/agent-runtime.test.mjs`（48 → 80）
- `server/test/conversation-management.test.mjs`
- `rag-service/tests/test_agentic_retrieval.py`

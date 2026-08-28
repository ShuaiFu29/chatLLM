# Agent 能力强化补完与真实数据库验证

实施日期：2026-08-20。承接 [12-Agent能力强化-P0至P5.md](./12-Agent能力强化-P0至P5.md)，补完其中列为"明确未做"的全部条目，并补上前一轮最大的验证缺口：**四个新迁移从未在真实 Postgres 上执行过**。

前一轮的诚实边界是：测试验证了逻辑与结构，没有验证真实链路。本轮把这条补掉了。

---

## 一、真实数据库验证（最重要的一项）

上一轮新增的 `0044`–`0047` 只经过源码断言。带表达式的部分索引、跨列 check、递归 CTE 与并发语义，都是"SQL 写得出来但数据库不一定接受、接受了也不一定真在拦"的东西。

本轮装了本地 PostgreSQL 16.15（Homebrew，无需 Docker daemon）并实跑：

| 验证项 | 结果 |
|------|------|
| 全部 50 个迁移应用 | 通过，且重跑幂等 |
| `agent_memories_dedupe_idx`（带 `coalesce()` + `md5()` 的部分唯一索引） | **确实创建成功**——这是最可能语法通过却创建失败的一处 |
| `agent_runs_lineage_check` | 真的拒绝"是根却 depth=1" |
| `agent_runs_depth_check` | 真的拒绝 depth=4 |
| `agent_runs_ancestor_cardinality_check` | 真的拒绝链长≠depth |
| 预算原子扣减 | 10 个并发各请求 100、可支配 800 → **恰好 8 个成功**；被拒者带 `reserveWouldCover=true` |
| 绕过仓储直接 UPDATE 超额 | 被 `agent_run_budgets_token_consumed_check` 拒 |
| 递归 CTE 级联取消 | 父→子→孙三层全部 `cancelled`；已取消的父无法被 resume 拉回 |
| `on delete cascade` | 真的删除子 Run，不留孤儿 |
| step 的 `trace_id` 派生 | 跨 Run 共享同一 trace，子 span 正确挂在父 span 下 |
| 记忆去重/过期/作用域隔离/supersede | 全部按预期 |
| `real[]` 向量往返 | 无损；无向量的重写不会擦掉已存向量 |
| 队列排他领取 | 两个并发 claim 同一行 → **恰好 1 个成功** |
| 租约防冒用 | 用错误 token 续期返回 null |
| 租约过期 | 标记 `failed` + `subagent_lease_expired`，**不重排队** |
| 跨实例接管 | 被遗弃的 queued 行可被另一 worker 领取 |
| 结果归属隔离 | 另一用户读不到该次派发的结果 |

新增 `server/test/agent-run-tree-postgres.integration.test.mjs`，15 个子测试，已挂进 server 测试清单。**无数据库时正确跳过**（1 skipped / 0 fail），有数据库时 15/15 通过。

复现方式：

```bash
# 起本地实例（keg-only，二进制不在 PATH）
PG=/opt/homebrew/opt/postgresql@16/bin
"$PG/initdb" -D /tmp/chatllm-pgdata -U postgres --auth=trust -E UTF8
"$PG/pg_ctl" -D /tmp/chatllm-pgdata -l /tmp/chatllm-pg.log \
  -o "-p 55432 -k /tmp -c listen_addresses=127.0.0.1" start
"$PG/psql" -h 127.0.0.1 -p 55432 -U postgres -c "create database chatllm_verify"

# 跑集成测试
cd server
TEST_DATABASE_URL="postgres://postgres@127.0.0.1:55432/chatllm_verify" \
DATABASE_URL="$TEST_DATABASE_URL" AGENT_TREE_INTEGRATION=1 \
  node --test test/agent-run-tree-postgres.integration.test.mjs
```

---

## 二、验收证据

| 门 | 本轮结果 | 上一轮 |
|------|----------|--------|
| `npm run lint` | 通过 | 通过 |
| `npx tsc -b`（client） | 通过 | 通过 |
| 契约测试（16 文件） | 150 通过 | 150 |
| client vitest | 126 通过 | 126 |
| `npm --prefix server run test` | 441 用例，434 通过 / 0 失败 / 7 跳过 | 440（434/0/6） |
| server posttest（agent-runtime） | **90 通过** | 80 |
| `node scripts/run-rag-service.mjs --test` | 340 通过 / 2 跳过 | 340 / 2 |
| **真实 Postgres 集成测试** | **15 通过 / 0 失败** | 未跑过 |

新增迁移：`0048`（每工具调用上限）、`0049`（记忆向量）、`0050`（子 Agent 队列）。

---

## 三、核实后收窄的两项

上一轮把这两项列为"未做"，本轮核实发现**它们大部分已经存在**。如实记录，避免重复建设：

**参数取值约束** —— `input_schema` 已支持 `enum` / `minimum` / `maximum` / `minLength` / `maxLength` / `pattern`，且 `additionalProperties: false` 能拒未声明键。所以"给每个参数加取值约束"这件事本来就能做。

**`data_scope`** —— 已经是对的。`search_conversation_history` 已传 `projectSpaceId`（全局 Agent 不传才搜全部，这符合语义）；`agentic_rag` / `list_documents` / `read_document_excerpt` / `query_knowledge_graph` 都走 `requireAgentProjectSpace`。

但核实过程中发现一个**真实漏洞**：

> 自定义 HTTP 工具的作者若省略 `additionalProperties: false`，模型传入的未声明键会**原样进入查询参数或请求体**——等于把该端点的参数注入能力交给模型。`input_schema` 的拒绝是 opt-in 的，靠作者记得写。

已修：`custom-http-tool.ts` 改为只发送 `input_schema.properties` 里声明过的字段，让声明的 schema 成为契约，与作者是否写了 `additionalProperties` 无关。

---

## 四、每工具调用上限（`0048`）

全局上限 `AGENT_MAX_TOOL_CALLS_PER_RUN` 对所有工具一视同仁，而这对有外部副作用的工具是错的：四十次调用对检索工具合理，对发起退款的工具不合理。子 Agent 扇出让这一点更尖锐，因为总量在树内共享而每个子 Run 各自决定调多少次。

- `agent_tools.max_invocations_per_run smallint`，`NULL` = 仅受全局上限（既有工具行为不变，属 opt-in 收紧），约束 1..100。
- 超限时以 `tool_result(status=rejected, error=tool_invocation_limit_reached)` 返回，**不中止 Run**：上限是约束这一个工具，不是废掉整个请求；模型可以用已有信息继续作答。
- `normalizeMaxInvocationsPerRun` 在服务层校验，避免让数据库约束成为面向用户的报错。

---

## 五、记忆的语义召回（`0049`）

原先召回按信任级别→类型→时间排序。可预测，但**那不是相关性**：作用域内有几十条记忆时，注入提示词的那些和用户问的事无关。

### 关键判断：不用 pgvector

pgvector 可以 brew 安装，但它要求**每个部署方在自己的 Postgres 上装扩展**才能跑迁移——这与已立项的 `B2`（Elasticsearch 分词插件）是同一类基础设施依赖，而 `docker-compose.yml` 用的是 `postgres:16-alpine`。

改用 `real[]` 普通数组存向量、在应用侧算余弦：

- 任何 Postgres 都能跑，无扩展、无索引要求
- 候选集本来就被作用域限制在几十行，应用侧排序完全够用
- 代价是**不适用于百万级记忆**——那种规模需要 pgvector 和另一套设计。这条写在迁移注释里，不含糊

### 其余设计点

- rag-service 新增 `POST /embed`。服务端刻意不自己持有 embedding 客户端：provider、model、dimension 已经在一处配置好了，复制一份就是让两份漂移的开端。响应带 `model`，因为不同模型的向量不可比较。
- `embedding` 与 `embedding_model` 必须同时存在或同时为空（约束保证）。模型变更会让旧向量自然失效，而不是悄悄产生无意义的距离。
- `cosineSimilarity` 在维度不符、零向量或非有限值时返回 `null` 而非 `0`。**0 是合法的相似度**，混淆两者会让一个过期维度的向量伪装成"仅仅不相关"。
- 不可比的记忆排在已排序结果之后，**绝不丢弃**。
- 候选取 50 条再排序切到注入的 20 条。若只查 20 条，排序就是装饰。
- embedding 失败只降级为确定性排序，从不阻断：`embedTexts` 设 `maxAttempts: 1`（失败不值得花重试预算），`tryEmbed` 捕获后返回 `null`。**记忆必须在 RAG 服务不可达时照常工作。**
- 无向量的重写不会擦掉已存向量（`coalesce(excluded.embedding, 现值)`）。

---

## 六、短期记忆的滚动摘要

驱逐原先直接丢弃最老的轮次，于是一个上下文用尽的 Run 连"这段对话有过开头"都不知道。

**刻意做确定性摘要（digest）而非 LLM 抽象摘要。** 在"让请求装得下"的这个循环里再加一次模型调用，会带来延迟、它自己的预算和它自己的失败路径。digest 不会幻觉也不会失败，而让模型知道"更早的轮次存在、大致谈了什么"已经够了。

实现细节：驱逐时捕获被丢的消息，把 digest 插回原位；**若插回后又超限则再次移除**（否则会抵消刚刚做的驱逐）。`context_evicted` step 新增 `digest_retained`，让读者能区分"带摘要的驱逐"和"裸驱逐"。

---

## 七、批量审批（只做安全形式）

扇出叠加 `always` 策略会一次产生多个待审批，逐个往返很痛。批量接口只改变**请求次数**，不改变保证。

**做了**：`POST /agent-runs/:runId/approvals`，`decisions` 数组 1..20，每条**必须显式给出 `approval_id`**，重复 id 拒绝。逐条返回 `decided` / `not_found` / `already_decided` / `expired`——若因一条过期就整批失败，会把用户对其他条目的决定一起丢掉，而过期那条也不会回来。

**刻意不做，两条都写在服务层注释里（并有测试断言注释存在，防止后人顺手加回去）**：

1. **「批准全部待审」通配。** 在列表渲染与提交之间新建的审批，会被一个从未看过它的人批准——而这正是审批机制存在的全部意义。
2. **「本 Run 内记住选择」。** 那等于把 `always` 策略悄悄变成自主策略，与运维配置的意图相反。

路由顺序要注意：批量路由必须声明在 `:approvalId` 之前，否则会被参数路由吞掉（已有测试断言顺序）。

---

## 八、子 Agent 队列化（`0050`）

上一轮的派发在父进程内执行并把结果作为返回值传出。进程一死，子 Run 的行停在半途、没人等它，父的答案也丢了。

### 关键判断：不做两条执行路径

如果队列路径与进程内路径并存，两套会互相漂移——正是这一路在消除的东西。

改为**单一路径**：

1. 父把子 Run 落库为 `queued`（durable 记录）
2. 父**自己领取并执行**（快路径，延迟与原来相同）
3. 进程挂掉则行还在，可被另一实例领取，或被清扫者处理
4. **父统一从数据库读结果**——所以无论是本进程执行的还是别的实例执行的，代码路径完全相同

第 4 点是让这套设计成立的关键。对账是**无条件**做的，不是"失败时才做"，因此不存在快路径与恢复路径互相矛盾的可能。

### 其余设计点

- `status <> 'queued' or parent_run_id is not null`：根 Run 没有领取步骤，若停在 `queued` 会对用户和领取者双双隐形。
- 领取按 id + `for update skip locked`：父不会误领兄弟树的活，两个领取者也不会抢同一行。
- 续期限定持有者 token，陈旧 worker 无法延长已被夺走的租约。
- 租约过期**失败而非重排队**。子 Run 对自身工具调用的进度没有检查点，重放可能重复已经发生的副作用——与"工具只对传输类错误重试"同一个理由。父看到一个失败的子任务，可以如实汇报。
- 答案取自子 Run 自己的 `assistant` step，因为 subagent 刻意不写会话消息。

---

## 九、顺手消除的漂移隐患

延续前几轮的做法，遇到"同一事实存两份"就收敛：

- `agentRuns.ts` 的 `runColumns` 改为导出并补上新列，`agentSubagentQueue.ts` 删掉自己那份重复的列清单改为复用。两份列清单是新列被漏掉的必然来源。

---

## 十、新增环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_SUBAGENT_LEASE_MS` | 120000 | 子 Agent 执行期间持有的租约；执行中按 1/3 周期续期，租约失效即判定 worker 已死 |

---

## 十一、仍然没做的

| 项 | 原因 |
|---|---|
| pgvector 版语义召回 | 需要部署方在 Postgres 装扩展。当前 `real[]` 方案在几十到几百条记忆的规模上完全够用；到百万级才需要换设计。与 `B2` 同类，记录而不半做。 |
| LLM 抽象摘要压缩短期记忆 | 会在上下文适配循环里引入模型调用、预算与失败路径。当前 digest 已让驱逐可观测；要不要为更好的压缩付这个代价是产品决策。 |
| 子 Agent 之间自由对话 / 协商 | 与 `12` 的立场一致：只做单向派发加汇总，这是有界且可追溯的。开放式多 Agent 对话没有终止保证。 |
| 真实 Redis / Milvus / ES / Neo4j 端到端验证 | 本轮只起了 Postgres。`npm run check:ops` 与 `npm run rag:smoke` 仍需一套完整依赖环境才能跑，未跑过就不能说"已生产验证"。 |

最后一条是当前**唯一剩下的验证缺口**，也是下一步最有信息量的动作。

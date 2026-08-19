# RAG、聊天与数据一致性

本文覆盖检索正确性、删除/缓存失效、续写与生成、以及若干召回/协议问题。Agent 把 RAG 当工具调用时，同样吃这些路径。

## 1. 当前 RAG 主路径（保持）

不要在整改时拆掉这些设计：

- 混合检索：向量 / BM25（ES 故障可降级 PG，且 **不伪装成 0 条结果**）/ 图谱
- RRF、可选语义 rerank、parent-child
- 权威 PostgreSQL 水合（挡住跨租户向量误召回）
- 知识版本 + request fingerprint 作为精确缓存 key
- 证据不足 fail-closed，跳过答案模型
- 聊天侧 RAG 请求失败则停止生成（`rag_retrieval_unavailable`）
- ingestion 租约、conversion generation 不可变、大文件 staging 成功后才替换索引
- 评测冻结 `execution_snapshot`、paired baseline、case 级超时

效果上限取决于是否显式启用 Query Rewrite / Reranker / Graph LLM 抽取 / Judge。默认关闭时 readiness 标 `disabled` 或 `degraded`，这是诚实行为，不要改成「假装完整」。

## 2. 必须修：删除 vs 缓存

见 `P1-DELETE-CACHE`。

时序：

1. API 把 `files.status` 设为 `deleting`（立即）
2. BullMQ worker 稍后调 RAG `/cleanup-file`
3. 成功后才 `bump_project_knowledge_version`
4. 精确缓存 key 含 `knowledge_version`，故在 bump 前 **旧 key 仍合法**
5. `_evaluate_cached_documents` 不校验 file/chunk 是否仍 active

影响：用户以为文件删了，Agent/普通聊天仍可能引用原文。这是知识工作台的正确性 bug，不只是「缓存优化」。

整改原则：**删除的可见性以「不能再被回答引用」为准，而不是以 worker 跑完为准。** 202 Accepted 可以表示外部对象还在删，但检索必须立刻不可见。

## 3. 必须修：Continue 与 RAG/生成

见 `P1-CONTINUE-RAG`、`P2-CONTINUE-PERSIST`、`P1-CONTINUE-MERGE`、`P2-AGENT-CONTINUE`。

今天 Continue 是一条合成英文 user prompt：

- 默认 `shouldUseRagForMessage` → `default_rag=true`
- grounded 模板把续写指令当「用户问题」
- 可能错误检索、错误拒答、或把续写指令写进证据约束
- 无历史 user 消息时甚至把该 prompt 落库

整改时把 Continue 当成 **生成控制面**，不是新问题：

| 模式 | RAG | 持久化 | Agent |
|------|-----|--------|-------|
| 普通聊天 Continue | 关闭 | 不写合成 user 消息 | — |
| Agent 会话 | 不适用 | 不适用 | 禁用 Continue |
| 无上下文 Continue | 拒绝 400 | 不写库 | 拒绝 |

## 4. 召回与过滤

### P2-MILVUS-PROBE

`describe_collection` 失败后永久认为没有 `project_space_id` 字段。PG 水合仍丢弃外项目 chunk，故 **不是租户泄漏**，但是：

- 向量 topK 被其它项目占满
- 本项目召回变差、不稳定

同用户多项目空间时影响明显。

### P3-MISSING-SPACE

内部传入已删/错误 `project_space_id` 时伪造空 scope。建议失败可见，避免排查时以为「知识库就是空」。

## 5. 生成协议

### P2-EMPTY-BODY

`llmProviders` 在 200 无 body 时直接 return。聊天和 Agent 共用。应与「无 `[DONE]`」一样 fail-closed。

Agent 额外还有 `P1-LENGTH-TOOLS`（length + tool_calls）。普通聊天的 length 通常只是截断回答，Continue 本应接上；在修 Continue 时确认普通聊天 `finish_reason=length` 仍允许用户点续写。

## 6. 清理链路其它注意

跨系统删除主路径（`deleting` → RAG 索引 → S3 → DB cascade）结构健全，不要为了修缓存窗口而改成同步阻塞整个 HTTP 直到 Milvus/ES/Neo4j 全部删完（那会把删除接口拖成超时）。推荐：

1. 事务内：`status=deleting` **且** bump knowledge_version（或写 tombstone 使 cache key 立即不同）
2. 异步：删外部索引与对象
3. 缓存命中二次权威化作为保险

`P2-KB-TOAST`：前端应说「已提交删除」，不要在 202 前或失败时说「已删除」。

## 7. 配置与容量（相关但不都是 bug）

- Graph 抽取默认关闭 → readiness `degraded/rules_only`，生产需显式配置
- Cache Redis 必须与 BullMQ Redis 分离；断开时回退 PG，不影响正确性
- `P2-GETBOOLEAN` 会导致 S3 path-style 等开关被误打开，间接影响存储访问

## 8. 建议的 RAG 相关回归

最低集：

1. 删除文件后、cleanup 完成前，retrieve 不得返回该 `file_id`
2. 相同 query 的 cache hit 在 bump 后失效（已有 fingerprint 测例，补「deleting 即 bump」）
3. `continue: true` 不调用 retrieve
4. Milvus describe 第一次失败第二次成功后带项目过滤
5. 无 body 的 chat completion 对调用方是错误

详细测例见 [07](./07-测试缺口.md)。

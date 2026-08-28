# ChatLLM 多格式文档 RAG v4

本文记录当前运行边界、评分语义与部署步骤。系统接收 Markdown、TXT、文本型 PDF、DOCX、PPTX、XLSX 与 CSV，在本地转换为统一 Markdown 并保留来源映射；不提供 OCR、扫描件识别、旧版 Office 或云端商业解析。

## 检索链路

1. 对话解析器先判断当前问题是否依赖历史。独立问题不吸收会话；除“它、该服务、那然后呢”等显式指代外，也识别“如果超时怎么办”“和 RabbitMQ 相比呢”“第二种方案呢”等省略追问。若上一轮本身仍是省略句，解析器最多向前回溯三个用户问题，直到最近的独立主题，避免连续追问丢失主语；Trace 保留原问题、standalone query、方法和实际使用的历史轮数。
2. 先用确定性规则生成 standalone query；可选语义 Query Rewrite 只有在 `QUERY_REWRITE_ENABLED=true` 且 key、base URL、model 全部显式配置时启用。模型只能返回严格 JSON 的 standalone query 和最多两个语义替代查询，不能删除或发明精确 ID、裸数字、版本号、文件名、引号短语、否定词与 CamelCase/大写标记；超时、传输或校验失败立即退回确定性结果。随后 Query Planner 生成最多三个可审计的通用查询变体，不包含固定 demo 文件或领域词典。先顺序查询 exact subquery cache，再对 miss 使用最多三个 Worker 并行检索；结果恢复到规划顺序后再融合，避免并发完成顺序导致漂移。
3. 普通知识问答选择 `vector + bm25`；只有明确的实体关系、多跳关系问题才增加 `graph`。每个查询内部的选中通道也并行执行，因此整个链路是受控的两级并行，而不是无限制展开。
4. 单路故障时使用其余结果降级；全部选中通道失败才返回错误。Elasticsearch 异常不会被吞成空结果，BM25 lane 会标记 `degraded` 并回退 PostgreSQL；同一规划中的部分查询失败时继续使用其他查询，只有所有规划查询都不可用才抛出 `PlannedRetrievalUnavailableError` 并停止回答生成。候选按固定的 `vector -> bm25 -> graph` 顺序进入 RRF。向量与 BM25 权重为 `1.0`，图通道权重为 `0.7`。
5. RRF 后先运行 `local-evidence-v2`：在保留 RRF 为主信号的同时，计算正文词项/精确标记覆盖、标题路径、文件名、短语邻近度、是否真正包含答案，并抑制同一来源的近重复 Chunk；这些分数仍是确定性排序特征，不冒充语义概率。之后可选调用兼容 `/rerank` 的语义 Reranker。Provider 分数明确标记为未校准 relevance score，失败时退回本地顺序；缓存指纹绑定模型、端点、TopN 和最大文档长度。
6. 重排选出 Child 后，按 `file_id + parent_section_id` 回取同一 Markdown Section 的有限相邻 Chunk，合成不重复标题、限制长度的 Parent 上下文；数据库失败时保留 Child 降级。
7. 回答前按 Token Budget 去重、跨来源轮转和公平分配上下文。回答模型与声明验证器使用完全相同的截断文本，验证器不能读取未进入 Prompt 的原文。RAG 已触发但上下文为空时直接返回版本化的确定性证据不足拒答并跳过答案模型；无来源事实性回答按 unsupported 处理，正确拒答按 `not_applicable` 处理，不再把零证据伪装成成功回答。

图通道不是普通问答的必经步骤。启用 `GRAPH_EXTRACTION_ENABLED` 后，必须独立配置完整的 `GRAPH_EXTRACTION_API_KEY/BASE_URL/MODEL`，不会隐式复用 Judge Provider；关闭时 capability 报告 `degraded/rules_only`，不得作为企业图谱 healthy。兼容 LLM 只允许返回严格 JSON，并且实体 mention、指代、关系端点和关系证据都必须逐字存在于同一 Section 的有界窗口中；`GRAPH_CONTEXT_WINDOW_CHUNKS=1` 表示目标 Chunk 加前后各一个，设为 `2` 时是前后各两个。验证器除检查逐字证据外，还要求证据包含受控关系或开放谓词的语义 cue，两个实体仅仅共现不会入图。否定、计划/义务、条件和历史陈述分别写入 `polarity` 与 `modality`，不能冒充当前肯定事实。单个目标窗口的非法输出只让该目标退回保守规则抽取，失败原因进入文档级结构化统计。

`core-v2` 使用保守身份策略：同一文档内由 `entity_key` 区分同名实体，跨文档默认不因名字或单一 alias 自动合并；稳定 `entity_id` 包含租户、空间、文档与局部实体身份。每个关系观察生成证据级 `fact_id`，Neo4j 同时写入唯一 `Fact` 节点与按 `fact_id` 区分的 `RELATED_TO`，所以同端点多事实不会覆盖。GraphExtraction cache key 绑定内容、抽取器、本体和 Provider fingerprint；Document 到缓存的 usage 关系记录来源 Chunk，缓存有 TTL，删除文件或 Generation 时撤销引用并清理无主节点。检索先按规范名/alias/受限包含匹配解析多个实体实例，再以 `entity_id` 做最多三跳遍历，并限制种子、分支、路径、Hub 度数和证据数量。所有候选最后由 PostgreSQL active-generation authority 复核。Graph Explorer 只绘制带后端事实和活动 Chunk 证据的边，不再从 Chunk 实体两两生成共现边；页面显示开放谓词、否定/模态、抽取通道、原文位置和转换警告。规则 fallback 路径降权，`graph_rank_score` 只是排序特征，不冒充概率或可信度。

## 文档摄取

- Markdown Header Splitter 读取 H1-H6 层级；二次切分后，每个子 Chunk 都显式带完整标题路径。
- 大文件流式分支维护同样的标题状态，并忽略代码围栏内的伪标题。
- 大文件对象先只下载一次并流式写入临时 staging。staging 阶段完整验证声明大小、SHA-256、UTF-8、Markdown 分块且至少产生一个 Chunk；全部通过后才 reset 旧 PostgreSQL/向量/BM25/图索引并发布新内容。下载中断、哈希错误或非法文本不会删除当前可服务版本。
- Chunk 元数据写入 `chunk_strategy_version=markdown-v4:parent-child:metadata-embedding:chunk1000-overlap100`，包含 `heading_path`、`heading_depth` 和稳定的 `parent_section_id`；向量输入同时包含文件名、标题路径和正文。该标识由 `rag-service/chunk_strategy.py` 中的 `CHUNK_SIZE`/`CHUNK_OVERLAP` 派生，两个切分器复用同一份常量，切分参数无法在标识不变的情况下被改动。
- 每个 Chunk 写入 `token_count`。这是 `chunk_strategy.py` 中 `heuristic-cjk-v1` 估算器的**近似值**（CJK/假名/谚文按字计，其余按 4 字符 1 token 向上取整），不是任何模型分词器的精确结果——在用的 embedding/chat 供应商都不暴露分词器。用于预算与可观测，不要当作计费依据。
- Elasticsearch v2 mapping 同时索引 `filename`、`heading` 和 `content`，每个文本入口都有 standard/CJK 检索面，BM25 首轮召回按 `filename > heading > content` 加权；mapping `_meta.chatllm_schema_version` 固定为 `markdown-fields-v2`，不兼容时明确报错而不是吞掉 HTTP 400。
- 说明：mapping 中名为 `chatllm_mixed_text` 的 analyzer 实际就是 Elasticsearch 内置 `standard`，**不做中文分词**（对 CJK 按字切分）；混合语种覆盖来自各文本字段的 `.cjk` 子字段（内置 bigram analyzer）。真正的中文分词需要在集群上安装 IK 或 ICU 插件并全量重建 BM25 索引，见 `tasks/11-第二轮深度分析整改.md` 的 `B2`。该名称保留不改，因为它属 index settings，改名会强制既有部署重建索引。
- 转换警告同时落 `file_conversion_generations.warning_count` 与 `warnings text[]`，可直接在 PostgreSQL 里查出某个文件为何是 `completed_with_warnings`，不必下载 manifest artifact；计数由警告码数量派生，两者不会不一致。CSV 的分隔符检测结果属溯源信息，记入 manifest 的 `notes` 而非 `warnings`，因此使用非逗号分隔符的 CSV 不会再被标成 `completed_with_warnings`。
- PostgreSQL Chunk、Milvus、Elasticsearch 与 Neo4j 在同一次摄取任务中重建。旧索引不会仅因服务启动或读取 scope 就被标成 v4，也不会自动获得 `markdown-fields-v2` mapping。

历史文档先预览缺少 active Conversion Generation 的数量：

```powershell
npm --prefix server run reindex:documents -- --limit 100
```

可按格式预览，确认后再分批入队：

```powershell
npm --prefix server run reindex:documents -- --document-kind pdf --limit 100
npm --prefix server run reindex:documents -- --force --project-space-id <uuid> --limit 100
npm --prefix server run reindex:documents -- --force --confirm-all --limit 100
```

默认只 dry-run 并输出目标数。`--` 用于结束 npm 自身的参数解析。实际执行必须显式 `--force`；项目级执行使用 `--project-space-id <uuid>`，全库执行还必须二次确认 `--confirm-all`，旧 `--apply` 是非法参数。命令覆盖七种 `document_kind`，只选择原件对象仍存在、处于 `completed` / `failed` 稳定态、没有有效 queued/processing ingestion lease 且缺少 active Generation 的文件。`--document-kind` 可限制格式；只有显式 `--include-active` 才重建已经有 active Generation 的文件。命令把目标原子恢复为 `pending`，正常 Worker 再按 PostgreSQL claim/lease、BullMQ 投递和现有摄取链路重建各索引。

该命令支持受控强制重摄取符合范围的稳定态文档，但它不是在线索引完整性探针，也不证明 Elasticsearch、Milvus、Neo4j 当前数据完整。运行前应先 dry-run，生产环境应分项目、分批执行并观察 Worker；外部数据库本身仍应保留独立备份。

`/health/ready` 会额外返回当前 Chunk 策略、已经物化的 Markdown 数量、旧策略文件/Chunk 数和 `reindex_required`。主动关闭的可选模型能力标记为 `disabled`；已启用但依赖不可用或索引仍陈旧时才标记为 `degraded`。旧索引不会让仍可服务的进程返回 503；PostgreSQL、Milvus、Elasticsearch 或 Neo4j 连接失败才影响基础 readiness。

## Redis、BullMQ 与 PostgreSQL 职责

PostgreSQL 是业务事实源：保存文件/测评/清理状态、attempt、退避时间、lease token、fencing 与最终结果。
`rag_retrieval_cache` 同时保存可审计、可过期的 exact 检索证据；Cache Redis 只是它的可丢弃读穿 L1，关闭或清空 Redis 不影响正确性。

Redis 7 提供：

- 默认启用的精确 Query L1 检索缓存。它使用独立 Cache Redis（默认 `256mb`、`allkeys-lfu`、无 AOF），不能与队列/限流 Redis 共用实例；连接失败时立即降级到 PostgreSQL L2。缓存 key 包含用户、项目空间、独立检索问题、知识/索引版本、检索路由、TopK、阈值、Chunk/Embedding/Reranker/管线版本；不包含 `conversation_id`，因此同一用户和项目内的同一独立问题可以跨会话命中。
- 原子固定窗口限流。限流存储异常时保持 fail-closed，避免故障绕过配额。
- BullMQ 的投递存储。默认显式配置 `512mb` 内存预算、AOF 和 `noeviction`，但仍不把 Redis 当业务状态源；容量不足时应扩容，而不是驱逐队列键。

BullMQ 有三个独立队列：文档摄取、RAG 测评、资源清理。消息只携带数据库记录 ID，使用确定性 jobId 去重，`attempts=1`。Worker 收到消息后必须重新到 PostgreSQL claim 并取得有效 lease；业务重试与退避只由 PostgreSQL 计算。Dispatcher 周期扫描 PostgreSQL，因此 Redis 消息丢失或被清空后仍可重建投递。

缓存只允许 exact query 跳过检索。词项相似 Query 不再短路；会话证据继续按 `conversation_id` 隔离，只作为当前请求的新检索候选。相同 exact key 的并发 miss 通过 Redis `SET NX EX` 短锁合并；等待者超时、锁丢失或 Cache Redis 故障时正常回源。Trace 返回 hit/miss/bypass/rejected 原因、是否跳过检索、估算节省的 Query/通道调用数和进程内有效命中率。

Key 版本一致不等于证据仍然有效：命中后的证据一律回 PostgreSQL 复核 chunk 与文件是否仍处于可检索状态，无法证明存活的条目直接丢弃并记入 `cache_authority_check` trace step；Parent-child 文档按 `matched_child_ids` 里的真实 chunk 复核，而不是合成的 parent id。这条兜底覆盖删除已标记但异步索引清理尚未完成的时间窗 —— 服务端在把文件标记 `deleting` 的同一事务里就推进 `knowledge_version` 并清空该空间的 exact cache，两层共同保证已删文档不会被继续引用。

## 测评语义

- Retrieval 使用 Gold Source 的 Recall@K 和 MRR@K。Gold 数组优先保存稳定的 `file_id`，同时兼容旧文件名，因此属于 source-level，不冒充 chunk-level 指标。
- `retrieval_score = 0.7 * Recall@K + 0.3 * MRR@K`。
- 兼容列 `overall_score` 在该流程中明确等于适用的 `retrieval_score`，界面显示为“检索基准分”，不再混合不可达的回答指标。
- 有 Gold 的失败 Case 以 0 进入 Retrieval 宏平均，不能从分母中消失；同时单独报告 successful case rate。
- 测评 Worker 会使用与在线聊天相同的检索、Context Packer 和 grounded answer prompt 生成 `actual_answer`，并持久化 Prompt、回答模型、Judge 和声明验证器版本。未成功生成实际回答时，Answer 与 Faithfulness 仍显示 `N/A`，绝不拿检索文档代替答案。
- 确定性声明验证器拆分原子声明，逐条核对 `[Source N]`、词项覆盖、精确数字/版本/日期和否定极性，分别报告 citation precision、coverage、F1 与 claim-level hallucination rate。它是可复现的保守校验，不冒充语义 Judge。
- 可选 LLM Judge 只评估真实回答，独立返回 correctness、completeness 和 faithfulness；三个维度不再被随意加权成一个“答案总分”。关闭 Judge、缺少配置或响应缺字段/非合法 0～1 数值时，这些维度为 `N/A`，不能伪装成真实 0 分。
- `evaluation_spec` 可按用例保存 `expected_chunk_ids`、逐字 `expected_evidence`、`expected_answerable`、`expected_graph_relations` 和三维 `human_scores`。系统分别报告 Chunk/Evidence/Graph 的 Recall@K、MRR@K 或 Precision@K，不把来源级 Gold 冒充 Chunk 级 Gold；没有对应 Gold 时该维度 `applicable=false`、聚合为 `N/A`，而不是 0。
- 可回答性通过“人工标注能否回答”对照实际 `abstained` 状态，报告 accuracy、错误作答率与错误拒答率。Judge 人工校准报告三维绝对误差、MAE 与固定容差一致率，只表示与人工标注的一致性，不把 Judge 当真值。
- 每次运行聚合 P50、P95、最大延迟以及回答模型和 Judge 的 Token 用量。只有供应商显式返回 usage 时 Token 才适用；没有配置可审计的模型价格时货币成本固定为 `N/A`，不根据猜测价格计算。
- 每个 Case 使用独立 AbortController 与 `RAG_EVAL_CASE_TIMEOUT_MS`，超时会取消模型/检索请求并记录该 Case 失败，Runner 继续执行其余 Case；Run 仍受独立的 `RAG_EVAL_RUN_TIMEOUT_MS` 总截止时间保护。
- Run 创建时冻结 `execution_snapshot`：数据集 ID/Case 数/项目空间、检索 limit/threshold、请求模型/temperature、Case/Run 超时、知识版本、Milvus/BM25/Graph 版本、Chunk/Embedding 配置与 settings fingerprint。创建时最近一次 completed/partial Run 固定为 `baseline_run_id`，后续不随历史变化。
- 汇总报告使用固定随机种子的 1000 次 bootstrap 计算 Retrieval/Answer/Grounding 95% CI，并按 `tags`、`category`、`difficulty` 与 `expected_answerable` 输出切片。paired baseline 只对两次运行中都成功且指标适用的相同 Case 计算均值差与胜/平/负，避免不配对总体均值掩盖 Case 组成变化。
- Case 上限由 `RAG_EVAL_MAX_CASES_PER_DATASET` 和 `RAG_EVAL_MAX_CASES_PER_RUN` 配置，默认 500、硬上限 5000，Run 上限不得高于 Dataset 上限。兼容列 `answer_keyword_score`/`average_answer_keyword_score` 已弃用并保持 `NULL`，不再把关键词重叠当答案质量。
- 在线检索质量属于未校准 heuristic，输出 `score_type` 与 `calibrated=false`；RRF 第一名只是 rank signal，不解释为跨 Query 概率。

## 当前能力边界

- Query rewrite 默认使用可审计的确定性改写，已经覆盖连续省略追问、条件追问、比较追问和序号追问；显式配置后可增加受严格 schema 与检索约束校验的 LLM 语义替代查询。确定性模式仍不会猜测历史中从未出现的隐含实体，模型降级时 Trace 会标明 fallback。
- 单次检索的查询预算里，用户原始问法固定占第一位，其余额度由确定性查询计划与 LLM 语义替代查询轮转分配，每轮确定性优先。开启 LLM 改写不会挤掉确定性计划——后者贡献 exact-marker 查询，字面标识符（订单号、错误码）的召回依赖它，且不受某次改写调用成败影响。
- 未配置 `/rerank` Provider 时使用 `local-evidence-v2`，比单纯 RRF 多了标题、邻近度、答案承载与重复抑制，但它仍不是 Cross-encoder 语义相关度；Provider 分数也未校准，超时或失败会回退本地顺序，不阻断回答。
- Graph LLM 默认关闭。规则 fallback 只覆盖有限的显式关系并在检索中降权；开放标签不等于自动学习本体，也不保证任意领域、任意多跳推理正确。
- 声明验证器是保守、确定性的词项/数字/版本/日期/否定校验，不等同语义 entailment 模型；Judge 未配置或实际答案未生成时维度保持 `N/A`。
- Query Rewrite、Reranker、Graph 抽取与 Judge 都是显式 opt-in；`npm run check:env` 在开关为 true 时要求对应 key/base URL/model 成套存在。Redis L1 同样只有 `REDIS_CACHE_ENABLED=true` 且 `CACHE_REDIS_URL` 与队列 Redis 分离时启用；缺少真实凭证时保持关闭属于预期状态。
- `npm run check:ops` 会解析后端 PostgreSQL/Redis/RAG readiness、RAG 的 Milvus/Elasticsearch/Neo4j 检查和上述 capability 状态，而不是只看 HTTP 200；`npm run rag:smoke` 继续验证真实文档摄取、三套索引写入、检索与清理。没有运行这两条真实环境命令时，默认单元测试不能代替部署验收。

## 验收边界

根目录 `npm test` 会执行可复现的 `rag-answer-eval` 与 `rag-answer-run` 答案质量门禁；依赖特定外部资料或在线模型的 `rag-demo-*` 仍不进入默认 CI。`.github/workflows/quality.yml` 在 Linux、Node 22、Python 3.12 上安装 hash-locked Python 依赖，然后执行完整 test 与 production build。质量门禁覆盖：

- 路由传递、并行执行、RRF 确定性与单路降级；
- Markdown/TXT 直读，以及文本型 PDF、DOCX、PPTX、XLSX、CSV 的本地转换、来源映射、标题继承与流式切分；
- 图实体规范化、严格 LLM JSON/证据校验、保守 alias 消歧、跨 Chunk 指代与有界多跳检索；
- Recall/MRR、实际回答、声明到引用映射、失败分母和 N/A 语义；
- Parent-child 回取、Token Budget 截断以及“不可使用被截断事实”的边界；
- Redis exact cache 的用户/项目/版本隔离、跨会话命中、并发单飞、过期与故障回源，命中后证据的 PostgreSQL 权威复核，限流原子性；
- BullMQ jobId、PostgreSQL claim/lease/retry 与丢消息重建；
- 一个真实支持格式文档的端到端摄取链路。

Redis、Neo4j 等真实容器集成测试只有在相应环境配置完成后才运行；未配置时必须明确记为 skip，不能写成已验证。

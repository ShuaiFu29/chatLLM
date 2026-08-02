# ISSUE-072：知识图谱全链路质量不足且前端展示会放大错误关系

**状态**：代码修复完成；二次正确性审计、真实 Neo4j integration 与隔离 `rag:smoke` 已闭环；业务大金标及多实例压力验收待完成
**严重级别**：P0 阻塞（在完成部署验收前不得宣称企业图谱 healthy）
**影响模块**：文档转换、Graph 抽取、实体身份、事实存储、Neo4j、GraphRAG 检索、Graph Explorer、运维与质量评测
**相关页面 / 接口 / 文件**：`/api/rag-workbench/graph/*`、`rag-service/graph_*.py`、`client/src/pages/GraphExplorer.tsx`
**发现时间**：2026-08-01
**发现方式**：用户反馈 + 全链路代码审查 + 最小复现 + 自动化测试 + 桌面/移动端浏览器 QA

## 结论

原实现的主要问题不是某一个正则表达式，而是产品把“Neo4j 已启用”“抽到若干技术词”和“企业级事实图谱”混为一谈。默认路径依赖覆盖面很窄的规则抽取；LLM 结果缺少语义蕴含验证；实体和关系的数据库身份会错误合并或覆盖；失败被静默降级；前端又从 Chunk 共现二次制造语义边。因此，即使页面能画出图，也不能证明图中关系真实、完整、可追溯。

本次已经完成代码层修复和回归门禁：用户可见的边现在必须来自后端证据事实，每条事实有稳定身份和来源定位，否定/计划/历史等限定被结构化，rules-only 会明确报告 degraded，缓存和删除链路可撤回，中文常见职责、支付、提供、归属、依赖及复合谓词得到覆盖。

当前结论是“生产级设计、代码门禁和真实基础设施主链路验证已落地”，不是“任意企业文档已经被证明达到目标 F1”。2026-08-02 已在隔离 Docker 环境完成真实 Neo4j 事务集成与 `rag:smoke`；现有 Golden fixture 仍是小型回归集，不等价于业务大金标，多实例压力与业务 F1 验收仍是上线阻断条件。

## 修复前的实际表现

- 本地能力组合为 Neo4j 可配置启用、LLM Graph 抽取默认关闭，普通文档主要落入 rules-only。
- 普通中文合同、职责、人物事件句可能得到 0 个实体和 0 条关系。
- `订单服务依赖Redis并连接到Kafka` 会把谓词残片吸入实体端点。
- 演示语料主动重复“依赖/冲突/支持/替代”等固定句式，掩盖真实文档召回不足。
- Entity 以规范化名称作为项目级身份，同名不同义实体会被合并。
- 同一 Chunk 内相同端点和关系类型的多条事实会互相覆盖。
- LLM 输出只验证端点字符串是否出现在证据中，不验证证据是否真的支持该关系。
- 否定、历史、计划和条件没有结构化限定，可能与当前肯定事实等权返回。
- Provider、传输和 Schema 错误被静默降级，用户只能看到笼统的 indexed 状态。
- Graph Explorer 将同一 Chunk 中的实体两两连接，并给共现边绘制方向，展示了后端不存在的“事实”。
- PDF 扫描件/复杂版面、Office 图片/文本框/脚注/备注和 XLSX 表头语义可能在转换阶段丢失，但用户看不到风险提示。
- GraphExtraction 缓存缺少可靠 Provider 指纹、TTL、文档引用和删除清理。

## 最小复现

1. 在不配置兼容 LLM Graph Provider 的环境上传“甲方负责项目验收，乙方负责系统交付”。
2. 修复前观察到业务实体/职责关系缺失，且运行状态没有清楚表明 rules-only 降级。
3. 上传“订单服务依赖Redis并连接到Kafka”。
4. 修复前观察到关系端点包含“并连接到”等谓词残片。
5. 在同一 Chunk 放入多个没有直接关系的实体。
6. 修复前 Graph Explorer 仍生成带箭头的实体两两共现边。

## 根因分析

1. **能力开关与产品承诺错位**：Neo4j 可用只代表有图数据库，不代表有可靠的事实抽取。rules-only 仍被包装成正常知识图谱能力。
2. **抽取策略对演示语料过拟合**：Fallback 只覆盖少数技术关系词，缺少普通中文职责、合同、归属、支付、提供、实现及复合谓词处理。
3. **验证层只做字符串 Grounding**：端点出现在证据中不等于关系被证据语义支持，纯共现也可能被接受。
4. **Entity Label 被误当成 Identity**：规范化名称直接参与合并，缺少文档作用域身份和显式同名区分键。
5. **事实键缺少证据身份**：关系 MERGE 键没有稳定 `fact_id`，不同证据观察会覆盖。
6. **事实模型缺少限定语义**：没有 polarity/modality，否定、条件、计划和历史难以正确排序与展示。
7. **降级与失败不可见**：整窗抽取失败后直接 fallback，失败原因没有进入用户状态和运维统计。
8. **展示层二次造图**：前端根据实体共现重新构图，制造后端不存在的关系，并丢弃开放谓词、限定和来源定位。
9. **缓存生命周期不完整**：预加载与写入的 Provider 指纹语义不一致，且缺少 TTL、引用和无主数据清理。
10. **评测样本存在幸存者偏差**：测试和 demo 只证明了规则已知句式，没有覆盖真实中文业务表达、消歧、限定和证据精度。
11. **跨存储发布一致性未闭环**：PostgreSQL 已将文件标记为 completed 时，Milvus bounded consistency 仍可能短暂读不到刚写入的向量，造成“上传完成但立即提问为空”的用户可见窗口。

## 已实施修复

### 1. 抽取与证据验证

- 引入 `core-v2` 本体和 `llm-json-v2` 抽取器版本，缓存会校验抽取器、本体与 Provider 指纹。
- LLM Entity 支持 `entity_key`，同一窗口内表面名称相同的实体可以显式分离。
- 关系必须同时满足端点 grounding 和关系谓词/开放谓词的语义 cue；纯共现不再被接纳为事实。
- 事实增加开放 `relation_label`、`polarity`、`modality`、`validation_status` 和抽取通道信息。
- 识别否定、计划/义务、条件和历史语义，检索排序会降低非当前肯定事实的权重。
- LLM 失败原因进入结构化统计；整窗失败仍走规则 fallback，但不再无声伪装成 primary 成功。
- 规则 fallback 升级为 `regex-v3`，覆盖职责、依赖、连接、支付、提供、归属、使用、实现等常见中文关系，并修复逗号分句和“向……提供”主体污染。

### 2. 实体与事实身份

- Entity 使用文档作用域稳定 `entity_id`；同名实体跨文档默认不自动合并，采用精度优先策略。
- 每条证据事实生成稳定 `fact_id`；相同端点/关系的不同证据不再互相覆盖。
- Neo4j 增加 `Entity.entity_id` 与 `Fact.fact_id` 唯一约束。
- 每条关系同时保存可审计 Fact 节点和按 `fact_id` 标识的 `RELATED_TO` 关系，记录用户、项目、文件、证据引用、抽取器、限定及验证状态。

### 3. 存储、删除与缓存生命周期

- Graph frontier 优先按 `entity_id` 检索，并保留旧数据兼容路径。
- 活动证据仍由 PostgreSQL active generation 授权，避免 Neo4j 残留自行成为有效事实。
- GraphExtraction 缓存增加默认 30 天 TTL、Provider fingerprint、`USED_GRAPH_EXTRACTION` 文档引用与来源 Chunk 记录。
- 文件或 Chunk 删除时撤销缓存引用并清理无主缓存，避免原文删除后抽取 Payload 长期游离。

### 4. 查询与状态可观测性

- 查询种子支持实体短语、alias、受限包含匹配和职责问法，例如“张伟负责什么？”。
- 摄取最终 checkpoint 记录 graph extraction 状态、attempted/succeeded/cache hits/fallbacks 和失败原因。
- rules-only capability 明确返回 `degraded/rules_only`，不会再报告企业图谱 healthy。

### 5. 前端真实性与证据闭环

- 删除 Graph Explorer 的 Chunk 内实体两两共现造边逻辑；页面只绘制后端 `graph_relations`。
- 边展示 `fact_id`、开放谓词、polarity/modality、抽取通道、方法、证据文本和原文定位。
- 点击事实边可查看证据，并打开 Document Viewer 定位到 PDF 页、Markdown 行等来源位置。
- 否定关系和非当前模态使用不同颜色/虚线，避免视觉上等同于当前肯定事实。
- 页面明确显示 LLM primary、rules fallback、partial、legacy 等抽取状态。
- 知识库桌面与移动端显示 `conversion_warning_count` 及转换风险说明。
- 浏览器移动端 QA 发现旧图谱画布 `min-width: 820px` 导致节点不可见；已改成紧凑移动布局并验证事实边可点击。

## 2026-08-02 二次独立审计闭环

首次修复后，另一个 Agent 使用针对性反例再次审查了主链路，发现 6 个现有测试没有覆盖的 P1 正确性缺口。问题成立，已逐条复现并修复；这也说明“主链路已打通”和“小型 Golden 全绿”仍不能代替反例测试、限定语义评测和跨 Chunk 证据验证。

| 二次发现 | 根因 | 修复与门禁 |
| --- | --- | --- |
| `RELATED_TO + label=and` 可接纳纯并列 | 开放 label 只要求 token 出现在证据，连词没有停用门禁 | 新增非关系 label/token 黑名单、英文 cue 词边界和共现负例；同一漏洞也不再能绕过受控关系类型 |
| `differs` 命中 `if`、`notable` 命中 `not` | 英文限定词正则没有词边界 | 中英文模式分离语义，英文使用完整词/短语边界；增加 `differs/notable/notification/whenable` 负例 |
| 使用、负责、提供、支付、签署等问句不走 Graph | 路由词表只覆盖少量技术关系，“是否”优先落入 comparison | 路由词表与 core-v2 谓词同步，直接单跳关系问句使用 `vector + bm25 + graph`；保留能力型“支持哪些类型”负例 |
| Gold 忽略 polarity/modality | 匹配键只有 source/predicate/target | Gold Schema 跨 Python/Nest/React 增加 polarity/modality；主指标改为 exact-qualified，另输出 endpoint-only 诊断指标，语义相反不再全绿 |
| 旧 Generation 在过滤前占满 limit/branch factor | Neo4j 先排序截断，PostgreSQL 后验过滤 | search frontier 和 list overview 均分页补取，逐页经 PostgreSQL active-generation 授权，直到有效结果填满预算或候选耗尽 |
| 多跳全部关系挂到每个证据 Chunk | 路径级 relations 与 Chunk 级事实混用，前端从当前 result 推断 source | 后端只向直接支持该关系的 Chunk 附加 `graph_relations`，完整路径单独保留；前端再按 `evidence_refs/evidence_chunk_ids` 校验 source |

二次审计同时修复了四个高影响 P2：

- Markdown 无 Generation 路径现在必须满足 `target_file.status='completed'`，摄取中间态不再成为权威检索数据。
- Graph DTO 贯通 `entity_id/entity_type/type_label/aliases` 和关系端点 ID；前端按稳定 ID 构图，同名不同实体不再按显示名称合并。
- Capability 不再只看开关：Neo4j 探针和最近 24 小时 attempted/succeeded/fallback 进入运行质量；无成功窗口或回退率过高时保持 degraded。
- Neo4j 写入的每个 `UNWIND` 改为保持外层行的子查询，合法空实体/空关系窗口仍会写入 GraphExtraction 缓存。

二次审计暴露出的测试根因也已修正：旧 E2E 只有单 Chunk，因此无法发现证据错绑；现在 mock 使用两个 Chunk 和两个稳定实体端点，自动断言第二条事实打开第 7 行而不是第一条事实的第 3 行。

## 2026-08-02 真实基础设施补充审计

- 在隔离 Neo4j 5.26 Community 容器执行 `test_graph_atomicity.py`，最终 11 项全部通过，包含真实晚批次失败补偿、空 Document 清理和仅清理当前 owner/scope 孤儿实体。
- `rag:smoke` 首次暴露两个已过时的测试假设：夹具绕过 Server reconciliation，未发布 `files.status='completed'`；夹具也缺少 `document_kind='markdown'`，因此被新的 active-generation 权威门禁正确拒绝。Smoke 现已显式模拟 Server 发布，并走真实 Markdown conversion/Generation 路径。
- 权威状态全部正确后，首次立即检索仍为空；延迟 3 秒复查时 vector 通道恢复并召回 1 条，证明 Milvus bounded consistency 造成 completed 后的可见性窗口。`search_vectors` 现显式使用 Strong consistency，并增加参数断言。
- 修复后真实 `rag:smoke` 通过：1 个 Markdown Chunk 完成转换、Generation 发布、Milvus/Neo4j 写入和 API 检索，立即返回 1 条结果。Smoke 失败日志增加无敏感数据的阶段标识、通道状态和发布状态聚合，后续不再只得到无法定位的 `{name: 'Error'}`。
- 原文件级进程锁和跨批次 Neo4j HTTP 长事务已移除。Graph 抽取在事务外完成，每个批次使用短事务幂等 MERGE；不同文件不再被单进程全局串行。`Neo.TransientError.*` 使用最多 3 次的指数退避和抖动重试，晚批次失败按本文件 Chunk 补偿清理；进程崩溃时未发布 Generation 仍由 PostgreSQL 权威门禁隔离并交给 durable cleanup。

## 设计取舍与未伪造能力

- 本次没有添加缺乏校准依据的伪概率 `confidence`。证据状态、抽取通道、限定和验证结果是可审计事实；在业务金标完成校准前，不用一个看似精确的数字掩盖不确定性。
- LLM Provider/Schema 整窗失败目前采用结构化报错 + fallback，没有声称已经实现逐条 JSON 修复重试。后续是否增加有限重试，应先评估成本、延迟和错误放大风险。
- 文档作用域实体默认不跨文档自动合并是精度优先选择。企业实体主数据合并应由可追溯 alias/注册表规则或人工审核驱动，而不是仅凭同名猜测。
- 文件级进程锁和跨批次 Neo4j 长事务已移除，短事务幂等写入、Generation 发布隔离和 deadlock 有限重试已经完成代码及真实 Neo4j 回归。多实例高吞吐压力测试仍必须在目标部署规格下完成；当前不伪造未经压测的吞吐/SLA 数字。

## 自动化与浏览器验收结果

| 验收项 | 结果 | 说明 |
| --- | --- | --- |
| 根目录完整 `npm test` | 通过 | 421 项：415 passed、6 skipped、0 failed |
| RAG Python suite | 通过 | 305 项通过、2 项按环境跳过 |
| 企业图谱小型 Golden gate | 通过 | 覆盖中文复合谓词、职责、否定/计划、合同支付/提供、归属/实现、身份、Fact ID 与证据引用 |
| Playwright E2E | 通过 | 5 项通过；图谱用两个 Chunk 逐边验证事实详情及第 3/7 行证据定位 |
| UI copy/结构测试 | 通过 | 43 项通过 |
| 根目录构建与 client build | 通过 | server/client 构建成功 |
| lint 与 Python `py_compile` | 通过 | 无语法/静态门禁失败；本环境未安装 Ruff |
| `git diff --check` | 通过 | 无空白符错误 |
| 桌面浏览器 QA | 通过 | 图谱加载、事实点击、否定/模态、证据和来源定位正常，无控制台错误 |
| 390×844 移动端 QA | 通过 | 图节点可见、事实边可点击、知识库转换警告可见 |
| 真实 Neo4j integration | 通过 | Neo4j 5.26 Community 隔离容器；`test_graph_atomicity.py` 11/11，通过短事务、有限重试、失败补偿与孤儿清理 |
| 完整 `rag:smoke` | 通过 | 隔离 PostgreSQL、MinIO、Milvus、Neo4j；Markdown conversion/Generation、写入、发布、立即检索返回 1 条 |
| 大规模业务 Golden corpus | **尚未建设/上线阻断** | 当前 fixture 只用于防回归，不能证明真实企业语料总体 F1 |

## 企业级验收标准

- Golden Entity micro F1 ≥ 0.90，Relation micro F1 ≥ 0.85，Evidence grounding precision ≥ 0.95。
- 否定/计划/历史关系不得作为当前肯定事实返回；专项准确率 ≥ 0.95。
- 同名不同身份实体 100% 分离；经过声明和审核的 alias 合并准确率 ≥ 0.98。
- rules-only 必须显示 degraded，不能显示企业图谱 healthy。
- Graph Explorer 前端虚构语义边为 0；所有用户可见语义边都有后端 `fact_id` 和至少一个活动证据引用。
- 普通实体名、职责问法和关系问法均能产生实体种子；Golden Query Recall@10 ≥ 0.90。
- 文件、项目或账号删除后，活动查询不可返回被删证据；无引用抽取缓存按策略清理。
- 单元测试、构建、真实 Neo4j 集成、RAG smoke、桌面/移动浏览器回归和业务大金标全部通过，才允许生产状态标记为 healthy。

## 上线前强制动作

1. 配置兼容的结构化 Graph LLM Provider，并显式启用 `GRAPH_EXTRACTION_ENABLED=true`；若 capability 仍为 `degraded/rules_only`，阻断生产发布。
2. 保留已通过的真实 Neo4j integration 与 `rag:smoke` 为 CI 必跑门禁；继续补多实例并发写入、deadlock 重试、删除撤回、缓存清理和吞吐压力验收。
3. 对旧 `entity_id`/`fact_id` Schema 之前的数据执行全量重摄取或新库重建，不能将旧图与新质量基线混用。
4. 从合同、制度、产品、运维、表格、扫描件等真实业务文档建立分层大金标，并达到上述 F1、grounding 与 Recall 门槛。
5. 生产监控 LLM success、fallback ratio、validation reject、conversion warning、无证据事实和查询空召回；超过业务阈值时降级告警而非继续显示 healthy。

## 回归风险

- 新实体/事实身份要求现有图谱全量重建。
- 更严格的证据门禁可能降低召回，应以业务 Golden F1 而非节点数量调参。
- LLM 抽取和验证会增加入库时间与成本，需要以缓存、有限并发和预算控制保护摄取 SLA。
- Neo4j 新唯一约束可能被旧重复数据阻塞，部署前需要清理旧库或创建新库。
- 转换层对扫描 PDF、图片和复杂 Office 版面的能力上限仍会影响图谱输入质量；转换 warning 必须作为验收信号，不得忽略。
- 图写入已改为短事务和有限 transient retry；多实例吞吐、补偿清理积压与 deadlock 恢复仍必须在目标基础设施上压测并监控，不能仅凭功能 integration 推断容量。

## 跟进记录

- 2026-08-01：完成全链路审计并复现普通中文零抽取、复合谓词端点污染、查询种子缺失和前端虚构边。
- 2026-08-01：完成抽取、语义验证、实体/事实身份、Neo4j 存储、缓存生命周期、检索、摄取状态和前端证据闭环修复。
- 2026-08-01：完成小型 Golden gate、完整测试、构建、lint、桌面与移动端浏览器 QA；移动 QA 发现并修复画布不可用问题。
- 2026-08-01：当时 Docker Desktop daemon 未运行，真实 Neo4j integration、完整 `rag:smoke` 和业务大金标暂列上线阻断条件。
- 2026-08-02：接受独立二次审计，复现并修复 6 个 P1：错误关系准入、英文限定词子串误判、Graph 路由漏召回、限定词评测假阳性、活跃版本过滤过晚和多跳证据错绑。
- 2026-08-02：补齐 Markdown 发布状态、稳定实体 DTO、24 小时运行质量降级和合法空图缓存；根目录 421 项、双 Chunk E2E 5 项、build/lint 全部通过。
- 2026-08-02：启动隔离 Docker 验收，真实 Neo4j integration 11/11 与完整 `rag:smoke` 通过；同时发现并修复 Milvus bounded-consistency 导致 completed 后短时空召回，以及 smoke 夹具未模拟 Server 发布/文档类型的测试漂移。
- 2026-08-02：移除文件级进程锁和跨批次 Neo4j 长事务，落地事务外抽取、短事务幂等写入、TransientError 最多 3 次有限退避、失败补偿与 Generation 发布隔离；RAG suite 增至 305 项通过、2 项环境跳过。

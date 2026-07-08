# RAG 全链路测试 Demo 文档设计

## 目标

为 DocuMind 生成一套可直接用于人工上传和全界面验证的中文 RAG demo。交付物放在同一个 demo 文件夹中，但分成真实语料和答案包两部分：

- `rag-demo/智能制造质量追溯与供应链索赔争议/corpus/`
  - 只放用于上传到知识库的高难度长内容 Markdown 文档。
  - 目标是测试 Markdown 解析、chunking、Milvus 向量检索、BM25、Neo4j 图谱、RRF 融合、rerank、引用、检索实验室和 RAG 质量测评。
- `rag-demo/智能制造质量追溯与供应链索赔争议/answers/`
  - 放详细答案、知识图谱预期、检索实验室问题、RAG 质量测评集、界面测试数据和操作预期。
  - 答案包开头必须提醒：真实测 RAG 时优先只上传 `corpus/`，不要把 `answers/` 上传进知识库，除非专门测试答案污染。

本次只新增 Markdown 文档，不修改应用代码、不新增脚本、不改变现有 RAG 逻辑。

## 项目约束

当前项目只支持 `.md` / `.markdown` 文档 ingestion。RAG 服务会按 Markdown 标题切分，再使用约 1000 字符 chunk 和 100 字符 overlap。检索链路包含：

- Milvus 向量检索。
- Elasticsearch/BM25 或 PostgreSQL 文本兜底。
- Neo4j 知识图谱实体与关系。
- RRF 多路融合。
- local evidence rerank。
- evidence verify、quality score、trace steps。
- RAG eval 数据集字段：`question`、`expected_answer`、`expected_keywords`、`expected_source_files`。

因此语料必须有稳定文件名、标题层级、短编号、长段落、表格、公式、跨文档链接、实体关系句式和故意冲突。答案包必须能直接指导用户在各页面填入数据，不需要读源码。

## 主题

主题：智能制造质量追溯与供应链索赔争议。

业务背景为一家工业机器人控制器厂商处理 2026 年 Q2 批量返修、供应商索赔、固件变更、工艺偏差、客户停线赔付、出口合规和内部审计争议。该主题适合压测 RAG，因为它天然包含：

- 多系统字段不一致：SN、PCB 批次、MOSFET 批次、固件版本、工单号、客户停线事件号。
- 多部门口径冲突：质量、研发、供应链、法务、客服、财务、海外合规。
- 版本冲突：旧版质保政策、当前索赔边界、临时客户安抚口径。
- 多跳推理：技术根因、返修统计、供应商责任、客户赔付、风险沟通要并读。
- 图谱关系：批次依赖供应商、固件替代旧版本、客服口径与法务口径冲突、测试报告支持根因但不支持全部责任。

所有 corpus 文档都应声明为合成测试材料，不构成真实法律、工程、质量或供应链建议。

## Corpus 设计

创建 24 份 corpus 文档，文件名使用 `00-` 到 `23-` 前缀，便于脚本和人工引用。

1. `00-corpus-index-and-test-guide.md`
   - 文档清单、上传说明、测试维度、建议问题和期望来源。
   - 不写完整答案，避免污染检索。
2. `01-quality-incident-master-brief.md`
   - 质量事件总览，定义 AURORA-17 控制器、P1/P2 停线、Q2 批量返修边界。
3. `02-current-warranty-and-claim-policy-2026.md`
   - 当前质保与索赔政策，包含赔付边界、排除项、临时费用暂挂。
4. `03-deprecated-warranty-policy-2025-cache.md`
   - 已废止旧缓存政策，故意与 2026 口径冲突。
5. `04-mosfet-supplier-quality-letter.md`
   - MOSFET 供应商来函，承认部分电性漂移但限制责任范围。
6. `05-pcb-coating-process-deviation-report.md`
   - PCB 三防漆偏差报告，说明湿热与离子污染证据。
7. `06-firmware-4-8-2-change-note.md`
   - 固件 4.8.2 变更说明，替代 4.7.9，但不覆盖全部故障。
8. `07-firmware-4-7-9-known-issues.md`
   - 旧固件已知问题，包含看似相关但已被部分排除的缺陷。
9. `08-repair-work-order-ledger-q2.md`
   - Q2 返修工单台账，含 SN、客户、区域、症状、处理状态。
10. `09-customer-line-stop-claims.md`
   - 客户停线索赔材料，区分事实停线、可赔停线和商业安抚。
11. `10-8d-corrective-action-report.md`
   - 8D 整改报告，含 D3/D5/D7/D8 措施和关闭证据限制。
12. `11-factory-test-log-sampling.md`
   - 产测日志抽样，含误报、漏测、复测窗口和测量系统风险。
13. `12-field-service-chat-extract.md`
   - 服务站群聊整理，有口语、误传和未经会签表达。
14. `13-legal-risk-memo.md`
   - 法务风险备忘录，限制对外承诺、召回措辞和供应商追偿表述。
15. `14-finance-accrual-and-reserve-note.md`
   - 财务预计负债、暂估、赔付上限和费用归集。
16. `15-overseas-customer-regulatory-note.md`
   - 海外客户与出口合规风险，区分 CE 技术变更、客户合同和监管通报。
17. `16-change-control-board-minutes.md`
   - 变更委员会纪要，说明固件、工艺和供应商替代的批准条件。
18. `17-material-traceability-crosswalk.md`
   - 物料追溯映射，连接 SN、PCB、MOSFET、工单、客户事件。
19. `18-supplier-chargeback-calculation.md`
   - 供应商索赔计算公式、扣款上限、举证要求。
20. `19-customer-communication-approved-script.md`
   - 已批准客户沟通话术，与群聊/客服草稿形成对比。
21. `20-customer-service-draft-unapproved.md`
   - 未审核客服草稿，包含简化甚至错误承诺。
22. `21-internal-audit-evidence-checklist.md`
   - 审计证据链清单，列出请求日志、版本、批次、审批、沟通记录。
23. `22-management-review-and-decision-log.md`
   - 管理评审决策日志，说明最终边界、例外审批和未决事项。
24. `23-deprecation-crosswalk-and-conflict-map.md`
   - 废止映射与冲突表，连接旧政策、新政策、临时口径和正式话术。

每份文档应包含：

- 文档元数据表。
- 合成材料声明。
- 多层标题。
- 至少 2 个对检索有意义的实体或编号。
- 与其他文件的交叉引用。
- 适合图谱抽取的句式，例如“4.8.2 固件替代 4.7.9 固件”“客服草稿与法务备忘录冲突”“供应商来函支持但不完全证明索赔边界”。

## 答案包设计

创建 9 份 answers 文档。

1. `README-如何使用这套答案包.md`
   - 解释 corpus/answers 分离、推荐上传顺序、不要把答案包混入真实检索。
2. `01-全链路测试总览与验收清单.md`
   - 按页面列测试目标、前置数据、预期可见结果。
3. `02-知识图谱预期结果.md`
   - 实体清单、关系清单、推荐搜索词、节点和边的预期解释。
4. `03-检索实验室问题与预期来源.md`
   - 至少 35 个问题，覆盖单跳、多跳、冲突、版本、公式、弱证据、清单类。
   - 每题写预期 intent、planned query 倾向、Top 来源、为什么这些来源必要。
5. `04-RAG聊天问答标准答案.md`
   - 至少 30 个可直接在聊天页问的问题，给详细标准答案、应引用来源和不应下结论的边界。
6. `05-RAG质量测评集-可录入版.md`
   - 50 条 case，字段对齐前端：问题、期望答案、关键词、期望来源文件。
7. `06-页面级测试数据与操作脚本.md`
   - 工作区、知识库、聊天、搜索、提示词、个人画像、Usage、Profile 的手工测试数据。
8. `07-Usage与队列观测预期.md`
   - 文件处理阶段、chunk/batch 计数期望、RAG run trace、引用统计、历史记录。
9. `08-故意失败与边界场景.md`
   - 未上传 corpus、只上传部分文件、上传 answers 污染、删除文件后检索、旧政策误命中等场景。

答案包应详细到用户能照着填页面。对于 RAG eval，既要有人工可读表，也要给“逐条复制到 UI 的字段格式”。每个 case 的 `expected_source_files` 使用真实 corpus 文件名，避免只写编号。

## 页面覆盖

答案包必须覆盖以下页面和功能。

- Login：说明需要已登录，GitHub OAuth 不作为 RAG 语料测试重点。
- Workspace/Sidebar：创建 `制造质量追溯专项` 工作区，查看文档数、对话数、归档/恢复会话。
- Knowledge Base：上传 `corpus/` 下 24 个文件，等待 completed，打开文档预览，删除一份后验证检索变化。
- Chat：RAG 自动触发、文档引用、低证据提示、重新生成、停止/继续、分支、对比、导出。
- Search：按 `AURORA-17`、`4.8.2`、`MOS-QA-26-041`、`P1 停线`、`旧缓存政策` 搜索对话。
- Prompt Templates：创建全局 RAG 审核模板、工作区事故复盘模板、供应商索赔模板。
- Persona Center：通过若干对话触发“Agentic RAG 与知识检索”“企业级压测”“质量追溯/供应链争议”类兴趣，测试接受/隐藏/证据查看。
- Usage：总览统计、文件队列详情、provider health、模型使用、会话 trace、RAG run trace。
- Retrieval Lab：填入指定问题，验证渠道数、Top sources、trace steps、quality label 和 cache 状态。
- Graph Explorer：搜索实体，验证节点、语义边、来源文档和关系标签。
- RAG Evaluation：创建数据集、录入 50 个 case、运行、查看 score、导出报告、历史趋势。
- Profile：语言、主题、头像、显示名、删除账号弹窗的非 RAG 数据填充。

## 难度设计

语料应包含以下高难点：

- 废止政策与当前政策冲突。
- 未审核草稿与正式话术冲突。
- 技术证据支持故障机制，但不支持全部供应商责任。
- 供应商承认部分事实，但排除部分费用。
- 固件修复与硬件工艺偏差并存，不能单因归因。
- 财务暂估不等于实际赔付。
- 管理评审关闭某些动作，不等于所有客户已通知。
- 群聊内容可作为线索，但不可作为正式对外承诺。
- 海外监管、客户合同、内部质量体系三套边界不能混用。
- 同一实体多个名称：AURORA-17、A17、机器人控制器、伺服控制盒。

## 验收标准

- `corpus/` 至少 24 份 Markdown 文件。
- `answers/` 至少 9 份 Markdown 文件。
- corpus 总字数足够长，平均每篇不少于约 3000 中文字符。
- 至少 18 份 corpus 文档包含表格。
- 至少 6 份 corpus 文档包含公式、计算或分摊规则。
- 至少 20 个检索实验室问题需要多源并读。
- RAG eval 可录入版包含 50 条 case，不超过项目单数据集上限。
- 所有答案都使用 corpus 文件名作为引用依据。
- 答案包覆盖每个主要页面和项目 RAG 场景。
- 不出现未完成占位标记或乱码占位。

## 不做范围

- 不修改应用代码。
- 不新增自动上传器。
- 不调用真实外部监管或客户资料。
- 不创建 PDF、Word、Excel。
- 不保证实际本地 RAG 运行结果与预期 100% 一致；答案包记录的是设计预期和人工核对标准。

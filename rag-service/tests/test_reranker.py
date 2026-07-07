import unittest

from reranker import rerank_documents


class RerankerTests(unittest.TestCase):
    def test_default_reranker_preserves_pre_rank_and_scores_overlap(self):
        documents = [
            {
                "id": "chunk-low",
                "content": "Account settings page.",
                "retrieval_score": 0.9,
            },
            {
                "id": "chunk-hit",
                "content": "JSBridge connects WebView and Native runtime.",
                "retrieval_score": 0.7,
            },
        ]

        reranked = rerank_documents("JSBridge WebView Native", documents, top_k=2)

        self.assertEqual(reranked[0]["id"], "chunk-hit")
        self.assertEqual(reranked[0]["pre_rerank_rank"], 2)
        self.assertGreater(reranked[0]["rerank_score"], reranked[1]["rerank_score"])
        self.assertEqual(reranked[0]["reranker"], "local-evidence")
        self.assertGreater(reranked[0]["agentic_score"], 0)
        self.assertEqual(reranked[0]["source_role"], "primary")

    def test_reranker_demotes_evaluation_guide_when_primary_sources_match(self):
        documents = [
            {
                "id": "guide",
                "content": "建议评测问题：华东 E-2 紧急等级下响应确认窗口按 T+3 还是 T+5？期望来源文档包括 01 和 07。",
                "metadata": {"filename": "00-corpus-index-and-test-guide.md", "file_id": "guide", "chunk_index": 4},
                "retrieval_score": 0.99,
            },
            {
                "id": "east",
                "content": "华东区域附件规定，E-2 紧急等级下储能聚合资源响应确认窗口覆盖总规则，按 T+3 分钟执行。",
                "metadata": {"filename": "07-regional-appendix-east-grid.md", "file_id": "east", "chunk_index": 2},
                "retrieval_score": 0.42,
            },
            {
                "id": "rule",
                "content": "2026 修订版总规则默认响应确认窗口为 T+5 分钟，区域附件有更严格要求时优先适用。",
                "metadata": {"filename": "01-market-rule-2026-revised.md", "file_id": "rule", "chunk_index": 2},
                "retrieval_score": 0.38,
            },
        ]

        reranked = rerank_documents("华东 E-2 紧急等级下，储能聚合资源的响应确认窗口应按 T+5 还是 T+3？", documents)

        self.assertEqual(reranked[0]["id"], "east")
        self.assertEqual(reranked[0]["source_role"], "primary")
        self.assertEqual(reranked[-1]["source_role"], "evaluation_guide")
        self.assertGreater(reranked[0]["agentic_score"], reranked[-1]["agentic_score"])
        self.assertIn("T+3", reranked[0]["matched_terms"])

    def test_reranker_rewards_exact_domain_markers_over_generic_overlap(self):
        documents = [
            {
                "id": "generic",
                "content": "FAQ 简化口径说值班沟通时可以先看可用容量，但不能替代正式结算。",
                "metadata": {"filename": "09-operator-faq-with-known-simplifications.md", "file_id": "faq", "chunk_index": 3},
                "retrieval_score": 0.9,
            },
            {
                "id": "south",
                "content": "南网 S-DR-4 快速调节品类的响应窗口为 T+4，结算容量仍需按正式公式确认。",
                "metadata": {"filename": "08-regional-appendix-south-grid.md", "file_id": "south", "chunk_index": 2},
                "retrieval_score": 0.3,
            },
        ]

        reranked = rerank_documents("南网 S-DR-4 快速调节品类中 FAQ 说只看可用容量是否能直接用于结算容量？", documents)

        self.assertEqual(reranked[0]["id"], "south")
        self.assertIn("S-DR-4", reranked[0]["matched_terms"])
        self.assertGreater(reranked[0]["agentic_score"], reranked[1]["agentic_score"])

    def test_reranker_prefers_filename_entity_match_over_repeated_shared_chunk(self):
        documents = [
            {
                "id": "shared-directory",
                "content": "BMS 日志字段中的 PackInsRes 和 CellDevMax 在不同软件版本中阈值不完全相同。技术组要求查询时带出软件版本号，否则报警曲线会被放在同一张图上比较。",
                "metadata": {"filename": "售后专项材料目录.md", "file_id": "directory", "chunk_index": 11},
                "retrieval_score": 0.92,
                "retrieval_channels": ["bm25"],
            },
            {
                "id": "bms-source",
                "content": "BMS 日志字段中的 PackInsRes 和 CellDevMax 在不同软件版本中阈值不完全相同。技术组要求查询时带出软件版本号，否则老车和新车的报警曲线会被放在同一张图上比较。",
                "metadata": {"filename": "BMS日志解读说明.md", "file_id": "bms", "chunk_index": 11},
                "retrieval_score": 0.45,
                "retrieval_channels": ["vector", "bm25"],
            },
        ]

        reranked = rerank_documents(
            "BMS 日志字段 PackInsRes 和 CellDevMax 在查询时为什么要带软件版本号？",
            documents,
        )

        self.assertEqual(reranked[0]["id"], "bms-source")
        self.assertGreater(reranked[0]["filename_match_score"], 0)
        self.assertGreater(reranked[0]["agentic_score"], reranked[1]["agentic_score"])

    def test_reranker_demotes_background_boilerplate_when_direct_evidence_exists(self):
        documents = [
            {
                "id": "boilerplate",
                "content": "本文件围绕材料索引、版本关系、引用边界整理，资料进入专项夹时已经经过至少一次部门内筛选。材料中提到的 B17、B17-2、B17-2L、B17-2 Plus 并不总是严格按研发平台命名。",
                "metadata": {"filename": "售后专项材料目录.md", "file_id": "directory", "chunk_index": 1},
                "retrieval_score": 0.91,
            },
            {
                "id": "direct",
                "content": "台账中的 B17-2、B17-2L、B17-2 Plus 不是销售配置过滤项，必须同时核对售后系统、包体铭牌和供应商批次表，避免漏掉同一实物批次车辆。",
                "metadata": {"filename": "B17与B17-2返修台账摘录.md", "file_id": "ledger", "chunk_index": 15},
                "retrieval_score": 0.52,
            },
        ]

        reranked = rerank_documents(
            "B17、B17-2、B17-2L、B17-2 Plus 为什么不能只按销售配置过滤？",
            documents,
        )

        self.assertEqual(reranked[0]["id"], "direct")
        self.assertLess(reranked[1]["evidence_specificity"], reranked[0]["evidence_specificity"])


if __name__ == "__main__":
    unittest.main()

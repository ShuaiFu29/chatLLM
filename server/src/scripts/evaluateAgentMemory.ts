import { AGENT_MEMORY_ZH_CN_GOLD_V1 } from '../evals/agent-memory-zh-cn-v1';
import { evaluateAgentMemoryDataset } from '../modules/agents/runtime/agent-memory-evaluation';

const report = evaluateAgentMemoryDataset(AGENT_MEMORY_ZH_CN_GOLD_V1);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;


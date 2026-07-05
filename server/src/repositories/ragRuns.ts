import { ChatSource, RagQualitySummary, RagTraceStep } from '../lib/chatSources';
import { withTransaction } from '../lib/db';

export interface InsertRagRunInput {
  runId: string;
  userId: string;
  conversationId: string;
  assistantMessageId: string;
  mode: string;
  query: string;
  plannedQueries: string[];
  traceSteps: RagTraceStep[];
  quality: RagQualitySummary;
  retrievedSources: ChatSource[];
  status?: 'success' | 'partial' | 'failed';
}

export const insertRagRunForMessage = async (input: InsertRagRunInput) => {
  await withTransaction(async (client) => {
    await client.query(
      `insert into rag_runs (
         id,
         user_id,
         conversation_id,
         assistant_message_id,
         mode,
         query,
         planned_queries,
         trace_steps,
         quality,
         retrieved_sources,
         status
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (id) do update set
         assistant_message_id = excluded.assistant_message_id,
         planned_queries = excluded.planned_queries,
         trace_steps = excluded.trace_steps,
         quality = excluded.quality,
         retrieved_sources = excluded.retrieved_sources,
         status = excluded.status,
         updated_at = now()`,
      [
        input.runId,
        input.userId,
        input.conversationId,
        input.assistantMessageId,
        input.mode,
        input.query,
        JSON.stringify(input.plannedQueries),
        JSON.stringify(input.traceSteps),
        JSON.stringify(input.quality),
        JSON.stringify(input.retrievedSources),
        input.status || 'success',
      ]
    );

    await client.query(
      `update messages
       set rag_run_id = $1
       where id = $2`,
      [input.runId, input.assistantMessageId]
    );
  });
};

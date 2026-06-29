import axios from 'axios';
import { RagDocument } from './chatSources';
import { serverEnv } from './env';
import { metrics } from './metrics';

interface RetrieveRagDocumentsInput {
  query: string;
  user_id: string;
  project_space_id?: string;
  limit: number;
  threshold: number;
}

let consecutiveFailures = 0;
let circuitOpenedAt = 0;

const isCircuitOpen = () => {
  if (circuitOpenedAt === 0) return false;

  const elapsedMs = Date.now() - circuitOpenedAt;
  if (elapsedMs >= serverEnv.RAG_CIRCUIT_RESET_MS) {
    circuitOpenedAt = 0;
    consecutiveFailures = 0;
    return false;
  }

  return true;
};

export const retrieveRagDocuments = async (input: RetrieveRagDocumentsInput): Promise<RagDocument[]> => {
  if (isCircuitOpen()) {
    metrics.recordRagCircuitOpen();
    throw new Error('RAG circuit is open');
  }

  const startedAt = Date.now();

  try {
    const response = await axios.post(`${serverEnv.RAG_SERVICE_URL}/retrieve`, input, {
      timeout: serverEnv.RAG_RETRIEVE_TIMEOUT_MS,
    });

    consecutiveFailures = 0;
    circuitOpenedAt = 0;
    metrics.recordRagRetrieve('ok', Date.now() - startedAt);

    return (response.data.results || []) as RagDocument[];
  } catch (error) {
    consecutiveFailures += 1;
    metrics.recordRagRetrieve('error', Date.now() - startedAt);

    if (consecutiveFailures >= serverEnv.RAG_CIRCUIT_FAILURE_THRESHOLD) {
      circuitOpenedAt = Date.now();
    }

    throw error;
  }
};

export const cleanupRagFileVectors = async (fileId: string) => {
  await axios.post(`${serverEnv.RAG_SERVICE_URL}/cleanup-file`, {
    file_id: fileId,
  }, {
    timeout: serverEnv.RAG_CLEANUP_TIMEOUT_MS,
  });
};

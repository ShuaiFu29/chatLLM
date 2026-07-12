process.env.NODE_ENV ||= 'test';
process.env.DATABASE_URL ||= 'postgres://chatllm:chatllm@localhost:5432/chatllm';
process.env.S3_ENDPOINT ||= 'http://localhost:9000';
process.env.S3_ACCESS_KEY ||= 'test-access-key';
process.env.S3_SECRET_KEY ||= 'test-secret-key';
process.env.JWT_SECRET ||= 'test-jwt-secret-with-more-than-32-characters';
process.env.DEEPSEEK_API_KEY ||= 'test-chat-provider-key';
process.env.RAG_SERVICE_TOKEN ||= 'test-rag-service-token-at-least-32-characters';

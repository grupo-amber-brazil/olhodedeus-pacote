// Entry principal — SO o que e leve/edge-safe (nao puxa sdk-trace-base nem
// @vercel/otel). O bootstrap do OTel vive nos entries separados:
//   - "@amber/olho-de-deus/web"    → registerGodeye     (Next + @vercel/otel)
//   - "@amber/olho-de-deus/worker" → registerGodeyeWorker (worker/Nest, NodeTracerProvider)
export { setGodeyeUser, setTraceEnrichment, enrichByTrace } from "./user-context.js";
export { godeyeJobWrapper } from "./job.js";
export { godeyePrismaExtension } from "./prisma.js";
export { instrumentPostgresClient } from "./postgres.js";
export { reportRedisError, createRedisErrorReporter } from "./redis.js";
export { redisStatementSerializer, redisStatementGravavel, REDIS_STATEMENT_MAX } from "./redis-statement.js";
export { configureGodeye, getIngestUrl, getSource, sendGodeyeEvent, semDadosPessoais } from "./config.js";
export { mascararDadosPessoais } from "./dados-pessoais.js";

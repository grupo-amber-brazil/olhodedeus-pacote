import { test } from "node:test";
import assert from "node:assert/strict";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import {
  REDIS_STATEMENT_MAX,
  redisStatementGravavel,
  redisStatementSerializer,
} from "../src/redis-statement.js";
import { spanToPayload } from "../src/span-processor.js";

// O statement real que derrubava o lote no ingest (log do Olho de Deus, 27/10/2026):
// EVALSHA do BullMQ com o job em msgpack depois das 9 chaves.
const CHAVES = [
  "bull:openai:wait", "bull:openai:paused", "bull:openai:meta", "bull:openai:id",
  "bull:openai:completed", "bull:openai:delayed", "bull:openai:active",
  "bull:openai:events", "bull:openai:marker",
];
const DO_SERIALIZER_PADRAO =
  `evalsha e33b7b6b71968ca9612aa1cf1785d6e79758678e 9 ${CHAVES.join(" ")} ` +
  `\u0093©bull:openai:©chat-step\u0000\u0017 {"type":"chat-step","agentSlug":"fabi"} 1761580000`;

test("serializer: EVALSHA grava sha, numero de chaves e chaves; os ARGV nao", () => {
  const job = new Uint8Array([0x93, 0x00, 0x17]);
  const s = redisStatementSerializer("evalsha", [
    "e33b7b6b71968ca9612aa1cf1785d6e79758678e", 9, ...CHAVES, job, '{"type":"chat-step"}', 1761580000,
  ]);
  assert.equal(
    s,
    `evalsha e33b7b6b71968ca9612aa1cf1785d6e79758678e 9 ${CHAVES.join(" ")} [+3 args]`,
  );
  assert.doesNotMatch(s, /chat-step|\u0000/);
});

test("serializer: EVAL troca o script por <script>", () => {
  const s = redisStatementSerializer("eval", ["local key = KEYS[1] return 1", "1", "fila:x", "valor-secreto"]);
  assert.equal(s, "eval <script> 1 fila:x [+1 args]");
});

test("serializer: comando comum grava o comando e a chave, nunca o valor", () => {
  assert.equal(redisStatementSerializer("set", ["sessao:42", "token-da-lead", "EX", 60]), "set sessao:42 [+3 args]");
  assert.equal(redisStatementSerializer("get", ["sessao:42"]), "get sessao:42");
  assert.equal(redisStatementSerializer("ping", []), "ping");
});

test("serializer: chave em binario vira ?", () => {
  assert.equal(redisStatementSerializer("get", [new Uint8Array([0, 1])]), "get ?");
});

test("gravavel: o EVALSHA do serializer padrao perde os ARGV e o NUL", () => {
  const s = redisStatementGravavel(DO_SERIALIZER_PADRAO);
  assert.equal(s, `evalsha e33b7b6b71968ca9612aa1cf1785d6e79758678e 9 ${CHAVES.join(" ")} [args omitidos]`);
  assert.doesNotMatch(s, /chat-step|agentSlug|\u0000/);
});

test("gravavel e idempotente, inclusive sobre a saida do serializer", () => {
  const uma = redisStatementGravavel(DO_SERIALIZER_PADRAO);
  assert.equal(redisStatementGravavel(uma), uma);
  const doSerializer = redisStatementSerializer("evalsha", ["abc", 1, "fila:x", "v1", "v2"]);
  assert.equal(doSerializer, "evalsha abc 1 fila:x [+2 args]");
  assert.equal(redisStatementGravavel(doSerializer), doSerializer);
  assert.equal(redisStatementGravavel("evalsha abc 1 fila:x"), "evalsha abc 1 fila:x");
});

test("gravavel: controle e metade solta de par UTF-16 viram U+FFFD; teto aplicado", () => {
  assert.equal(redisStatementGravavel("get a\u0000b"), "get a�b");
  assert.equal(redisStatementGravavel("get a\uD800"), "get a�");
  const longo = redisStatementGravavel(`eval ${"x".repeat(5000)}`);
  assert.equal(longo.length, REDIS_STATEMENT_MAX + 1);
  assert.ok(longo.endsWith("…"));
});

test("gravavel: statement curto e limpo passa igual", () => {
  assert.equal(redisStatementGravavel("get sessao:42"), "get sessao:42");
});

test("span-processor: db_query de Redis sai com o statement gravavel; Postgres nao muda", () => {
  const fake = (attributes: Record<string, unknown>) =>
    ({
      kind: SpanKind.CLIENT,
      attributes,
      startTime: [1000, 0],
      endTime: [1000, 1_000_000],
      events: [],
      spanContext: () => ({ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: 1 }),
    }) as unknown as ReadableSpan;

  const redis = spanToPayload(fake({ "db.system": "redis", "db.statement": DO_SERIALIZER_PADRAO }), "mistica-web");
  assert.equal(redis?.name, "redis EVALSHA");
  const st = (redis?.metadata as { statement: string }).statement;
  assert.doesNotMatch(st, /chat-step|\u0000/);

  const sql = "select * from users where id = $1";
  const pg = spanToPayload(fake({ "db.system": "postgresql", "db.statement": sql }), "x");
  assert.equal((pg?.metadata as { statement: string }).statement, sql);
});

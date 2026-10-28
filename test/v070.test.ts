import { test } from "node:test";
import assert from "node:assert/strict";
import { SpanKind, type Span } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { IncomingMessage } from "node:http";

import { mascararDadosPessoais, MASCARA } from "../src/dados-pessoais.js";
import { redisStatementGravavel, redisStatementSerializer } from "../src/redis-statement.js";
import { godeyeRequestHook, spanToPayload } from "../src/span-processor.js";
import { enrichByTrace } from "../src/user-context.js";
import { pausaDoIngest, sendGodeyeBatch, sendGodeyeEvent, zerarPausaDoIngest } from "../src/config.js";

const TRACE = "0af7651916cd43dd8448eb211c80319c";

function span(kind: SpanKind, attributes: Record<string, unknown>, events: unknown[] = []): ReadableSpan {
  return {
    kind,
    attributes,
    startTime: [1000, 0],
    endTime: [1000, 1_000_000],
    events,
    spanContext: () => ({ traceId: TRACE, spanId: "b7ad6b7169203331", traceFlags: 1 }),
  } as unknown as ReadableSpan;
}

test("redis: todo comando perde os valores, não só o EVALSHA", () => {
  assert.equal(redisStatementGravavel('set sessao:42 {"token":"abc"} EX 60'), "set sessao:42 [args omitidos]");
  assert.equal(redisStatementGravavel("hset lead:9 telefone 5548999998888"), "hset lead:9 [args omitidos]");
  assert.equal(redisStatementGravavel("eval local x = 1 return x 0"), "eval <script> [args omitidos]");
});

test("redis: telefone na chave vira *** no serializer e na defesa", () => {
  assert.equal(redisStatementSerializer("zadd", ["inbound:rl:janela:5548999998888", 1, "m"]), `zadd inbound:rl:janela:${MASCARA} [+2 args]`);
  assert.equal(redisStatementGravavel("zadd inbound:rl:janela:5548999998888 1 m"), `zadd inbound:rl:janela:${MASCARA} [args omitidos]`);
});

test("máscara: e-mail, telefone com 55 e CPF formatado; hash e versão de pacote ficam", () => {
  assert.equal(mascararDadosPessoais("x maria@gmail.com y"), `x ${MASCARA} y`);
  assert.equal(mascararDadosPessoais("+55 (48) 99999-8888"), MASCARA);
  assert.equal(mascararDadosPessoais("123.456.789-09"), MASCARA);
  assert.equal(mascararDadosPessoais("4bf92f3577b34da6a3ce929d0e0e4736"), "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(mascararDadosPessoais("node_modules/.pnpm/@vercel+otel@1.13.0/x.js"), "node_modules/.pnpm/@vercel+otel@1.13.0/x.js");
});

test("span-processor: erro do Prisma com e-mail e SQL com literal saem mascarados; userId fica", () => {
  enrichByTrace.set(TRACE, { userId: "5548999998888" });
  const http = spanToPayload(
    span(SpanKind.SERVER, { "http.method": "POST", "http.route": "/api/leads/maria@gmail.com", "http.status_code": 500 }, [
      { name: "exception", attributes: { "exception.message": "Unique constraint failed: maria@gmail.com" } },
    ]),
    "mistica-web",
  );
  assert.equal(http?.path, `/api/leads/${MASCARA}`);
  assert.equal(http?.name, `POST /api/leads/${MASCARA}`);
  assert.equal(http?.errorMessage, `Unique constraint failed: ${MASCARA}`);
  assert.equal(http?.userId, "5548999998888");

  const sql = spanToPayload(
    span(SpanKind.CLIENT, { "db.system": "postgresql", "db.statement": "select * from users where email = 'maria@gmail.com'" }),
    "x",
  );
  assert.equal((sql?.metadata as { statement: string }).statement, `select * from users where email = '${MASCARA}'`);
});

test("requestHook: IP é o último item do X-Forwarded-For", () => {
  const traceId = "1af7651916cd43dd8448eb211c80319c";
  const s = { kind: SpanKind.SERVER, spanContext: () => ({ traceId, spanId: "c7ad6b7169203331", traceFlags: 1 }) } as unknown as Span;
  const req = { headers: { "x-forwarded-for": "1.2.3.4, 177.10.20.30" }, socket: {} } as unknown as IncomingMessage;
  godeyeRequestHook(s, req);
  assert.equal(enrichByTrace.get(traceId)?.clientIp, "177.10.20.30");
});

test("429: o pacote para de enviar até vencer o Retry-After e descarta o que surgir", async () => {
  const original = globalThis.fetch;
  const antes = process.env.GODEYE_TOKEN;
  process.env.GODEYE_TOKEN = "gdy_live_teste";
  zerarPausaDoIngest();
  let chamadas = 0;
  globalThis.fetch = (async () => {
    chamadas += 1;
    return new Response(null, { status: 429, headers: { "Retry-After": "30" } });
  }) as typeof fetch;
  try {
    await sendGodeyeBatch([{ source: "x", type: "event", name: "a", status: "ok" }]);
    assert.equal(chamadas, 1);
    const pausa = pausaDoIngest() - Date.now();
    assert.ok(pausa > 28_000 && pausa <= 30_000, `pausa de ~30 s (veio ${pausa} ms)`);

    await sendGodeyeBatch([{ source: "x", type: "event", name: "b", status: "ok" }]);
    sendGodeyeEvent({ source: "x", type: "event", name: "c", status: "ok" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(chamadas, 1, "nada sai durante a pausa");

    zerarPausaDoIngest();
    await sendGodeyeBatch([{ source: "x", type: "event", name: "d", status: "ok" }]);
    assert.equal(chamadas, 2, "volta a enviar quando a pausa vence");
  } finally {
    globalThis.fetch = original;
    zerarPausaDoIngest();
    if (antes === undefined) delete process.env.GODEYE_TOKEN;
    else process.env.GODEYE_TOKEN = antes;
  }
});

test("429 sem Retry-After pausa 60 s; 202 não pausa", async () => {
  const original = globalThis.fetch;
  const antes = process.env.GODEYE_TOKEN;
  process.env.GODEYE_TOKEN = "gdy_live_teste";
  zerarPausaDoIngest();
  try {
    globalThis.fetch = (async () => new Response(null, { status: 202 })) as typeof fetch;
    await sendGodeyeBatch([{ source: "x", type: "event", name: "a", status: "ok" }]);
    assert.equal(pausaDoIngest(), 0);

    globalThis.fetch = (async () => new Response(null, { status: 429 })) as typeof fetch;
    await sendGodeyeBatch([{ source: "x", type: "event", name: "a", status: "ok" }]);
    const pausa = pausaDoIngest() - Date.now();
    assert.ok(pausa > 58_000 && pausa <= 60_000, `pausa padrão de 60 s (veio ${pausa} ms)`);
  } finally {
    globalThis.fetch = original;
    zerarPausaDoIngest();
    if (antes === undefined) delete process.env.GODEYE_TOKEN;
    else process.env.GODEYE_TOKEN = antes;
  }
});

test("sendGodeyeEvent manda o evento já mascarado", async () => {
  const original = globalThis.fetch;
  const antes = process.env.GODEYE_TOKEN;
  process.env.GODEYE_TOKEN = "gdy_live_teste";
  zerarPausaDoIngest();
  let corpo = "";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    corpo = String(init?.body);
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  try {
    sendGodeyeEvent({ source: "x", type: "job", name: "envio", status: "error", errorMessage: "falhou para maria@gmail.com", metadata: { para: "5548999998888" } });
    await new Promise((r) => setTimeout(r, 10));
    assert.doesNotMatch(corpo, /maria@gmail.com|5548999998888/);
    assert.match(corpo, /falhou para \*\*\*/);
  } finally {
    globalThis.fetch = original;
    if (antes === undefined) delete process.env.GODEYE_TOKEN;
    else process.env.GODEYE_TOKEN = antes;
  }
});

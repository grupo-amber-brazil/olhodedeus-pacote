import { SpanKind } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { BatchSpanProcessor, } from "@opentelemetry/sdk-trace-base";
import { getSource, getIngestHost, sendGodeyeBatch, } from "./config.js";
import { enrichByTrace, setTraceEnrichment } from "./user-context.js";
import { redisStatementGravavel } from "./redis-statement.js";
// ── requestHook do HttpInstrumentation ────────────────────────────────────────
// Captura clientIp/userAgent do IncomingMessage cru (o SERVER span do Next nao
// expoe headers) e guarda por traceId pro exporter consumir no export().
export function godeyeRequestHook(span, request) {
    const kind = span.kind;
    if (kind !== SpanKind.SERVER) {
        return;
    }
    if (!("headers" in request) || !("socket" in request)) {
        return;
    }
    const h = request.headers;
    const xff = h["x-forwarded-for"];
    const xffStr = Array.isArray(xff) ? xff[0] : xff;
    // ⚠️ Atras da Cloudflare (proxied), o IP REAL do visitante e o cf-connecting-ip
    // — por isso vem PRIMEIRO. O x-forwarded-for[0] costuma ser o IP de borda da
    // Cloudflare/Railway (registrado nos EUA), o que geolocaliza errado (US em vez
    // de BR) e faz a presenca ao vivo contar o proxy, nao o visitante. Fallbacks
    // pra acesso direto (sem CF) ficam depois. Repo sem CF nao tem esse header →
    // cai no x-real-ip/x-forwarded-for como antes (mudanca retrocompativel).
    const clientIp = h["cf-connecting-ip"] ||
        h["x-real-ip"] ||
        xffStr?.split(",")[0]?.trim() ||
        h["fly-client-ip"] ||
        request.socket?.remoteAddress ||
        undefined;
    const userAgent = h["user-agent"];
    // Geo da Cloudflare: cf-ipcountry vem por padrao em request proxied
    // (cf-region/cf-ipcity exigem o managed transform "Add visitor location
    // headers"). "XX"/"T1" = desconhecido/Tor → trata como ausente (o ingest cai
    // no geoip-lite). Quando presente, o ingest prefere esse geo sobre o geoip-lite.
    const cfCountry = h["cf-ipcountry"];
    const geoCountry = cfCountry && cfCountry.length === 2 && cfCountry !== "XX" && cfCountry !== "T1"
        ? cfCountry
        : undefined;
    const geoRegion = h["cf-region"] || undefined;
    const geoCity = h["cf-ipcity"] || undefined;
    setTraceEnrichment(span.spanContext().traceId, {
        clientIp,
        userAgent,
        geoCountry,
        geoRegion,
        geoCity,
    });
}
// ── helpers puros ──────────────────────────────────────────────────────────────
function hrToMs(start, end) {
    return Math.round(end[0] * 1000 + end[1] / 1e6 - (start[0] * 1000 + start[1] / 1e6));
}
// parentSpanId: OTel SDK 2.x expoe parentSpanContext.spanId; SDKs mais antigos
// expoem parentSpanId cru. Aceita os dois.
function getParentSpanId(span) {
    const s = span;
    return s.parentSpanContext?.spanId ?? s.parentSpanId ?? undefined;
}
// name curto do db_query: verbo + tabela/comando principal. O SQL/comando
// completo (so a FORMA, sem valores) mora em metadata.statement.
export function summarizeSql(statement, dbSystem) {
    const s = statement.trim().replace(/\s+/g, " ");
    // Prisma via client extension: statement ja e "model.operation" — usa direto.
    if (dbSystem === "prisma") {
        return s;
    }
    if (dbSystem === "redis") {
        const cmd = s.split(/\s+/)[0]?.toUpperCase() || "CMD";
        return `redis ${cmd}`;
    }
    const upper = s.toUpperCase();
    const verb = upper.split(/\s+/)[0] || "SQL";
    const tableMatch = /\bFROM\s+"?([A-Za-z0-9_.]+)"?/.exec(upper) ||
        /\bINTO\s+"?([A-Za-z0-9_.]+)"?/.exec(upper) ||
        /\bUPDATE\s+"?([A-Za-z0-9_.]+)"?/.exec(upper);
    const table = tableMatch?.[1]?.toLowerCase();
    return table ? `${verb} ${table}` : verb;
}
// Nomes de parametro cujo VALOR nunca pode ser gravado. Match por SUBSTRING,
// case-insensitive: `access_token`/`refresh_token` caem em "token",
// `apikey`/`api_key` caem em "key". A denylist erra de proposito pro lado de
// redigir DEMAIS — um `promo_code` redigido nao custa nada, um `code` de OAuth
// vazado custa. Limite conhecido: denylist sempre deixa passar o parametro que
// ninguem pensou, por isso a mesma redacao tem que rodar tambem no ingest, como
// segunda camada (protege emissor antigo e snippet escrito a mao).
const SENSITIVE_PARAM_PARTS = [
    "token",
    "secret",
    "key",
    "pass",
    "senha",
    "auth",
    "signature",
    "sig",
    "credential",
    "bearer",
    "jwt",
    "session",
    "code",
    "state",
    "hash",
];
/**
 * Redige o VALOR dos parametros sensiveis de uma query string, preservando a
 * chave e a estrutura (`?secret=***`). Preserva query legitima (`?q=123`) —
 * descartar a query inteira perderia contexto util de debug, e descartar o
 * evento perderia justamente o trafego de webhook, que e o que mais interessa.
 */
export function redactQuerySecrets(pathWithQuery) {
    const cut = pathWithQuery.indexOf("?");
    if (cut === -1) {
        return pathWithQuery;
    }
    const base = pathWithQuery.slice(0, cut);
    const redacted = pathWithQuery
        .slice(cut + 1)
        .split("&")
        .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq === -1) {
            return pair;
        }
        const name = pair.slice(0, eq);
        const lower = name.toLowerCase();
        return SENSITIVE_PARAM_PARTS.some((part) => lower.includes(part))
            ? `${name}=***`
            : pair;
    })
        .join("&");
    return `${base}?${redacted}`;
}
function exceptionOf(span) {
    const exc = span.events?.find((e) => e.name === "exception");
    return {
        errored: Boolean(exc),
        errorMessage: exc?.attributes?.["exception.message"],
        errorStack: exc?.attributes?.["exception.stacktrace"],
    };
}
// ── classificacao span → payload ────────────────────────────────────────────────
// Retorna null pra descartar (span interno do ORM sem statement, span-raiz de job
// do worker, CLIENT do POST de saida, etc).
export function spanToPayload(span, source) {
    const a = span.attributes;
    // Span-raiz que o worker abre em volta de cada job (so pras queries herdarem o
    // trace). O evento type:"job" e emitido a mao pelo job-wrapper — descartar aqui
    // evita double-emit.
    if (a["godeye.kind"] === "job-root") {
        return null;
    }
    const sc = span.spanContext();
    // db_query — REGRA DURA: so emite quando o span carrega db.statement. NAO
    // classificar por db.system / SpanKind / scope sozinho: o Prisma emite varios
    // spans por query e so o db_query tem statement. Deixar os internos passarem
    // viraria evento sem SQL e inflaria o volume ~5x.
    const statementCru = (a["db.statement"] ?? a["db.query.text"]);
    if (span.kind !== SpanKind.SERVER && statementCru) {
        const dbSystem = (a["db.system"] ?? a["db.system.name"]) ?? "db";
        // Redis: o serializer padrao da IORedisInstrumentation grava os VALORES
        // (o job inteiro do BullMQ no EVALSHA, com bytes NUL). Ver redis-statement.ts.
        const statement = dbSystem === "redis" ? redisStatementGravavel(statementCru) : statementCru;
        const exc = exceptionOf(span);
        return {
            source,
            type: "db_query",
            name: summarizeSql(statement, dbSystem),
            status: exc.errored ? "error" : "ok",
            durationMs: hrToMs(span.startTime, span.endTime),
            traceId: sc.traceId,
            spanId: sc.spanId,
            parentSpanId: getParentSpanId(span),
            metadata: { dbSystem, statement },
            errorMessage: exc.errorMessage,
            errorStack: exc.errorStack,
        };
    }
    // http — SERVER span com metodo
    if (span.kind === SpanKind.SERVER) {
        const method = (a["http.request.method"] ?? a["http.method"]);
        if (!method) {
            return null;
        }
        // redige segredo na query ANTES de qualquer uso — o `name` e derivado do
        // path, entao a redacao aqui cobre os dois campos.
        const path = redactQuerySecrets((a["http.route"] ?? a["url.path"] ?? a["http.target"] ?? "/"));
        const statusRaw = a["http.response.status_code"] ?? a["http.status_code"];
        const httpStatus = typeof statusRaw === "number" ? statusRaw : Number(statusRaw);
        // Sem status HTTP valido nao da pra emitir: o ingest valida `min(100)` e —
        // como o BatchSpanProcessor manda o lote inteiro num array so — um item
        // reprovado derruba TODOS os eventos do mesmo POST (400 no lote). Era o que
        // acontecia com o span nativo do Next 14 (scope "next.js"), que e SERVER e
        // tem http.method mas NAO carrega status code: virava httpStatus 0 e zerava
        // o batch. Descartar aqui e seguro porque o span irmao do
        // instrumentation-http (registrado em register-web.ts) cobre a mesma
        // requisicao COM status. Espelha o guard que o ramo http_out ja fazia.
        if (!(httpStatus >= 100 && httpStatus <= 599)) {
            return null;
        }
        // consome o enrich do request (clientIp/userAgent do requestHook + userId do
        // setGodeyeUser). delete: o request acabou.
        const enrich = enrichByTrace.get(sc.traceId);
        enrichByTrace.delete(sc.traceId);
        const userAgent = (a["user_agent.original"] ?? a["http.user_agent"]) ?? enrich?.userAgent;
        // enrich PRIMEIRO: o requestHook resolve o IP real CF-aware (cf-connecting-ip
        // antes de x-forwarded-for). O atributo client.address/net.peer.ip vem do
        // socket = IP da BORDA (Cloudflare/Railway, tipicamente US) atras de proxy —
        // usa-lo geolocaliza errado e faz a presenca ao vivo colapsar todos os
        // visitantes num IP so. Fallback pro atributo quando o hook nao rodou.
        const clientIp = enrich?.clientIp ??
            (a["client.address"] ?? a["http.client_ip"] ?? a["net.peer.ip"]);
        const exc = exceptionOf(span);
        return {
            source,
            type: "http",
            name: `${method} ${path}`,
            status: httpStatus >= 500 ? "error" : "ok",
            durationMs: hrToMs(span.startTime, span.endTime),
            method,
            path,
            httpStatus,
            requestId: sc.traceId,
            // colunas de trace: amarram os db_query filhos a este request no waterfall.
            traceId: sc.traceId,
            spanId: sc.spanId,
            parentSpanId: getParentSpanId(span),
            userAgent,
            clientIp,
            userId: enrich?.userId,
            // Geo da Cloudflare (quando atras da CF) — o ingest prefere sobre geoip-lite.
            geoCountry: enrich?.geoCountry,
            geoRegion: enrich?.geoRegion,
            geoCity: enrich?.geoCity,
            errorMessage: exc.errorMessage,
            errorStack: exc.errorStack,
        };
    }
    // http_out — chamada de SAIDA do app (CLIENT) sem db.statement. As libs
    // modernas (OpenAI/Bunny/Meta) usam fetch → instrumentation-undici; axios usa
    // node:http → instrumentation-http. Aceita os atributos dos dois (semconv
    // novo e antigo).
    if (span.kind === SpanKind.CLIENT) {
        const method = (a["http.request.method"] ?? a["http.method"]);
        const urlFull = (a["url.full"] ?? a["http.url"]);
        let host = (a["server.address"] ?? a["net.peer.name"] ?? a["http.host"]);
        let path = (a["url.path"] ?? a["http.target"]);
        if (urlFull) {
            try {
                const u = new URL(urlFull);
                host = host ?? u.host;
                path = path ?? u.pathname + u.search;
            }
            catch {
                // url malformada — segue com o que veio nos atributos
            }
        }
        // mesma redacao da entrada: chamada de saida carrega access_token da Meta e
        // API key do Gemini na query (`?access_token=`, `?key=`).
        if (path) {
            path = redactQuerySecrets(path);
        }
        // Sem metodo/host nao da pra rotular a saida — descarta.
        if (!method || !host) {
            return null;
        }
        // Filtro de auto-telemetria: NAO emitir a chamada pro proprio Olho de Deus.
        // O POST de telemetria e um CLIENT de saida; sem isso, cada request geraria
        // um http_out pro ingest — ruido massivo (o padrao de saida mais frequente).
        if (host.split(":")[0].toLowerCase() === getIngestHost()) {
            return null;
        }
        const statusRaw = a["http.response.status_code"] ?? a["http.status_code"];
        const httpStatus = typeof statusRaw === "number" ? statusRaw : Number(statusRaw) || 0;
        const exc = exceptionOf(span);
        return {
            source,
            type: "http_out",
            name: `${method} ${host}${path ?? ""}`,
            // 4xx/5xx de saida e erro relevante (ex: 401 da OpenAI). Difere do http de
            // entrada, que so marca error em 5xx.
            status: exc.errored || httpStatus >= 400 ? "error" : "ok",
            durationMs: hrToMs(span.startTime, span.endTime),
            host,
            method,
            path,
            httpStatus: httpStatus >= 100 ? httpStatus : undefined,
            traceId: sc.traceId,
            spanId: sc.spanId,
            parentSpanId: getParentSpanId(span),
            errorMessage: exc.errorMessage,
            errorStack: exc.errorStack,
        };
    }
    return null;
}
// ── transporte em lote ───────────────────────────────────────────────────────
// SpanExporter custom envolvido pelo BatchSpanProcessor nativo (buffer/timer/
// flush/teto de memoria) — sem setInterval na mao, sem fila (telemetria e
// descartavel). Parametrizado por `source` (web e worker rotulam diferente).
function createGodeyeSpanExporter(source) {
    return {
        export(spans, resultCallback) {
            let payloads;
            try {
                payloads = spans
                    .map((span) => spanToPayload(span, source))
                    .filter((p) => p !== null);
            }
            catch (error) {
                resultCallback({ code: ExportResultCode.FAILED, error: error });
                return;
            }
            if (payloads.length === 0) {
                resultCallback({ code: ExportResultCode.SUCCESS });
                return;
            }
            sendGodeyeBatch(payloads)
                .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
                .catch((error) => resultCallback({ code: ExportResultCode.FAILED, error }));
        },
        async shutdown() { },
        async forceFlush() { },
    };
}
export function createGodeyeBatchProcessor(source = getSource()) {
    return new BatchSpanProcessor(createGodeyeSpanExporter(source), {
        maxExportBatchSize: 512, // manda quando junta ~512 spans...
        scheduledDelayMillis: 1000, // ...ou a cada ~1s, o que vier primeiro
        maxQueueSize: 2048, // teto de memoria; excedeu → dropa (nunca trava a app)
    });
}

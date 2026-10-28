// Config de runtime + transporte fire-and-forget do Olho de Deus.
// Modulo LEVE de proposito: NAO importa nenhum pacote OTel, entao pode ser
// importado de qualquer lugar (route handler, edge, worker) sem arrastar o SDK.

import { mascararDadosPessoais, mascararNoValor } from "./dados-pessoais.js";

export type GodeyePayload = Record<string, unknown>;

export interface GodeyeOptions {
  /** Identifica o componente. Ex: "anamnese-pmf-web", "remis-worker". Hardcode por processo. */
  source: string;
  /** Override do endpoint de ingest. Default: env GODEYE_INGEST_URL ou o de producao. */
  ingestUrl?: string;
  /** Liga/desliga a captura de userId. Default: env GODEYE_CAPTURE_USER !== "false". */
  captureUser?: boolean;
  /** Timeout duro do POST de telemetria (ms). Default 500. */
  timeoutMs?: number;
}

const DEFAULT_INGEST_URL = "https://eye.grupoamber.com.br/api/v1/ingest";

interface ResolvedConfig {
  source: string;
  ingestUrl: string;
  captureUser: boolean;
  timeoutMs: number;
}

const config: ResolvedConfig = {
  source: "unknown",
  ingestUrl: process.env.GODEYE_INGEST_URL || DEFAULT_INGEST_URL,
  captureUser: process.env.GODEYE_CAPTURE_USER !== "false",
  timeoutMs: 500,
};

/** Aplicado por registerGodeye/registerGodeyeWorker no boot. */
export function configureGodeye(patch: Partial<GodeyeOptions>): void {
  if (patch.source !== undefined) config.source = patch.source;
  if (patch.ingestUrl) config.ingestUrl = patch.ingestUrl;
  if (patch.captureUser !== undefined) config.captureUser = patch.captureUser;
  if (patch.timeoutMs !== undefined) config.timeoutMs = patch.timeoutMs;
}

export function getSource(): string {
  return config.source;
}
export function getIngestUrl(): string {
  return config.ingestUrl;
}
/** Hostname do endpoint de ingest — usado pra filtrar a auto-telemetria (não
 *  emitir http_out da chamada que o pacote faz pro próprio Olho de Deus). */
export function getIngestHost(): string {
  try {
    return new URL(config.ingestUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}
export function captureUserEnabled(): boolean {
  return config.captureUser;
}

// ── dado pessoal ──────────────────────────────────────────────────────────────
// Todo evento sai com e-mail, telefone com 55 e CPF formatado trocados por `***` em `name`, `path`, `errorMessage`,
// `errorStack` e nos valores de `metadata` (v0.7.0). `userId`, ids de trace, `userAgent` e `clientIp` ficam: o
// ingest usa o IP para o pais e o descarta. O ingest repete a mesma limpeza antes de gravar.

const CAMPOS_DE_TEXTO_LIVRE = ["name", "path", "errorMessage", "errorStack"] as const;

export function semDadosPessoais(payload: GodeyePayload): GodeyePayload {
  const limpo: GodeyePayload = { ...payload };
  for (const campo of CAMPOS_DE_TEXTO_LIVRE) {
    const v = limpo[campo];
    if (typeof v === "string") limpo[campo] = mascararDadosPessoais(v);
  }
  if (limpo.metadata !== undefined) limpo.metadata = mascararNoValor(limpo.metadata);
  return limpo;
}

// ── 429 do ingest ─────────────────────────────────────────────────────────────
// Molde do Sentry: o emissor que recebe 429 para de enviar ate vencer o `Retry-After` e DESCARTA o que surgir no
// intervalo, sem fila e sem reenvio (telemetria nunca pode atrasar o app). Antes da v0.7.0 o pacote tratava 429 como
// sucesso e seguia no mesmo ritmo, gastando o ingest justo no pico. Vale para o processo inteiro.

const PAUSA_PADRAO_SEG = 60;
const PAUSA_MAX_SEG = 3600;
let pausadoAte = 0;

/** Exposto para teste. */
export function pausaDoIngest(): number {
  return pausadoAte;
}

/** Exposto para teste. */
export function zerarPausaDoIngest(): void {
  pausadoAte = 0;
}

function emPausa(): boolean {
  return Date.now() < pausadoAte;
}

function registrarResposta(res: Response): void {
  // Corpo nao lido segura o socket ate o GC; o 202 do ingest nem tem corpo.
  void res.body?.cancel().catch(() => {});
  if (res.status !== 429) return;
  const seg = Number(res.headers.get("retry-after"));
  const pausa = Number.isFinite(seg) && seg > 0 ? Math.min(seg, PAUSA_MAX_SEG) : PAUSA_PADRAO_SEG;
  pausadoAte = Date.now() + pausa * 1000;
}

// ── transporte ────────────────────────────────────────────────────────────────
// Token lido em RUNTIME (nunca no import) — sem GODEYE_TOKEN, no-op silencioso.
// Nunca lanca, timeout duro. O endpoint aceita array (lote) ou objeto unico.

export async function sendGodeyeBatch(payloads: GodeyePayload[]): Promise<void> {
  const token = process.env.GODEYE_TOKEN;
  if (!token || payloads.length === 0 || emPausa()) {
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(config.ingestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-godeye-token": token,
      },
      body: JSON.stringify(payloads.length === 1 ? payloads[0] : payloads),
      signal: controller.signal,
    });
    registrarResposta(res);
  } finally {
    clearTimeout(timer);
  }
}

/** Evento unico fire-and-forget (job, startup ping, redis-error). Nao espera. */
export function sendGodeyeEvent(event: GodeyePayload): void {
  const token = process.env.GODEYE_TOKEN;
  if (!token || emPausa()) {
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  void fetch(config.ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-godeye-token": token,
    },
    body: JSON.stringify(semDadosPessoais(event)),
    signal: controller.signal,
  })
    .then(registrarResposta)
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

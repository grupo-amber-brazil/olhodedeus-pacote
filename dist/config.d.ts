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
/** Aplicado por registerGodeye/registerGodeyeWorker no boot. */
export declare function configureGodeye(patch: Partial<GodeyeOptions>): void;
export declare function getSource(): string;
export declare function getIngestUrl(): string;
/** Hostname do endpoint de ingest — usado pra filtrar a auto-telemetria (não
 *  emitir http_out da chamada que o pacote faz pro próprio Olho de Deus). */
export declare function getIngestHost(): string;
export declare function captureUserEnabled(): boolean;
export declare function semDadosPessoais(payload: GodeyePayload): GodeyePayload;
/** Exposto para teste. */
export declare function pausaDoIngest(): number;
/** Exposto para teste. */
export declare function zerarPausaDoIngest(): void;
export declare function sendGodeyeBatch(payloads: GodeyePayload[]): Promise<void>;
/** Evento unico fire-and-forget (job, startup ping, redis-error). Nao espera. */
export declare function sendGodeyeEvent(event: GodeyePayload): void;

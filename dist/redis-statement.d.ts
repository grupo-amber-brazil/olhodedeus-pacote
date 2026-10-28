import { REDIS_ARGS_OMITIDOS, REDIS_STATEMENT_MAX } from "./dados-pessoais.js";
export { REDIS_ARGS_OMITIDOS, REDIS_STATEMENT_MAX };
/** Argumento como a ioredis o recebe. */
type RedisArg = string | number | Uint8Array | unknown[] | null | undefined;
/**
 * Serializer para a `IORedisInstrumentation`:
 *
 * ```ts
 * new IORedisInstrumentation({ dbStatementSerializer: redisStatementSerializer })
 * ```
 *
 * - `EVAL`/`EVALSHA`: o sha (ou `<script>`), o numero de chaves e as chaves. Os ARGV ficam de fora: `[+N args]`.
 * - Demais comandos: o comando e o primeiro argumento (a chave). O resto vira `[+N args]`.
 *
 * Exemplo: `evalsha e33b... 9 bull:openai:wait ... bull:openai:marker [+12 args]`.
 */
export declare function redisStatementSerializer(cmdName: string, cmdArgs?: RedisArg[]): string;
/**
 * Defesa do lado de quem emite, para statement que veio do serializer padrao:
 * - caractere de controle (inclusive NUL) e metade solta de par UTF-16 viram U+FFFD;
 * - fica so o comando e as chaves (`EVALSHA <sha> <n> <chaves...>`; demais comandos, comando + chave) e o resto
 *   vira `[args omitidos]`. O `EVAL` com script cru sai inteiro: `eval <script> [args omitidos]`;
 * - dado pessoal na chave vira `***`; teto de `REDIS_STATEMENT_MAX`.
 *
 * Idempotente, inclusive sobre a saida do `redisStatementSerializer`.
 */
export declare function redisStatementGravavel(statement: string): string;

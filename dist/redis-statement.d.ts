/** Teto do statement de Redis gravado. Comando + chaves cabem com folga. */
export declare const REDIS_STATEMENT_MAX = 300;
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
/** Marcador do corte do `redisStatementGravavel`: la nao da para contar os ARGV (o valor pode ter espacos). */
export declare const REDIS_ARGS_OMITIDOS = "[args omitidos]";
/**
 * Defesa do lado de quem emite, para statement que veio do serializer padrao:
 * - `EVALSHA <sha> <n> <chaves...>`: corta tudo depois das chaves (os ARGV);
 * - caractere de controle (inclusive NUL) e metade solta de par UTF-16 viram U+FFFD;
 * - teto de `REDIS_STATEMENT_MAX`.
 *
 * O `EVAL` com o serializer padrao nao da para separar (o script tem espacos), entao ele fica so com a limpeza e o
 * teto: quem precisa de garantia passa o `redisStatementSerializer`.
 */
export declare function redisStatementGravavel(statement: string): string;
export {};

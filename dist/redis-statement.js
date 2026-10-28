// Statement de comando Redis: so a FORMA (comando + chaves), nunca os valores.
//
// Por que existe (27/10/2026): a `IORedisInstrumentation` do OpenTelemetry, com o
// serializer padrao, grava TODOS os argumentos de EVAL/EVALSHA. No BullMQ esses
// argumentos sao o job inteiro empacotado em msgpack — dado do job (na Mistica,
// conteudo de conversa) e bytes NUL. O NUL fazia o Postgres do ingest recusar o
// lote inteiro (22P05) e o ingest responder 500 em ~1,2% das requisicoes.
//
// Duas camadas:
//   1. `redisStatementSerializer` — o app passa para a instrumentacao e o valor
//      nem chega a virar atributo do span. E a correcao de verdade.
//   2. `redisStatementGravavel` — o span-processor aplica em todo statement de
//      Redis, para o app que ainda usa o serializer padrao. Desde a v0.7.0 corta
//      os valores de TODO comando (nao so do EVALSHA) e mascara dado pessoal nas
//      chaves (ver dados-pessoais.ts).
//
// Arquivo sem dependencia externa: entra no entry leve (edge-safe).
import { REDIS_ARGS_OMITIDOS, REDIS_STATEMENT_MAX, mascararDadosPessoais, statementRedisSemValores, } from "./dados-pessoais.js";
export { REDIS_ARGS_OMITIDOS, REDIS_STATEMENT_MAX };
function argComoTexto(arg) {
    if (typeof arg === "string")
        return arg;
    if (typeof arg === "number")
        return String(arg);
    // Buffer/binario: e valor por definicao (chave nao chega como Buffer no uso comum).
    return "?";
}
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
export function redisStatementSerializer(cmdName, cmdArgs = []) {
    const cmd = String(cmdName).toLowerCase();
    const partes = [cmd];
    let usados = 0;
    if (cmd === "eval" || cmd === "evalsha") {
        // EVAL: o script e codigo, nao valor, mas pode ser longo; o sha ja identifica o EVALSHA.
        partes.push(cmd === "eval" ? "<script>" : argComoTexto(cmdArgs[0]));
        const numKeys = Number(cmdArgs[1]);
        if (Number.isInteger(numKeys) && numKeys >= 0) {
            partes.push(String(numKeys));
            const chaves = cmdArgs.slice(2, 2 + numKeys).map(argComoTexto);
            partes.push(...chaves);
            usados = 2 + chaves.length;
        }
        else {
            usados = 1;
        }
    }
    else if (cmdArgs.length > 0) {
        partes.push(argComoTexto(cmdArgs[0]));
        usados = 1;
    }
    const resto = cmdArgs.length - usados;
    if (resto > 0)
        partes.push(`[+${resto} args]`);
    return textoLimpo(mascararDadosPessoais(partes.join(" ")));
}
const CONTROLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SURROGATE_SOLTO = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/**
 * Defesa do lado de quem emite, para statement que veio do serializer padrao:
 * - caractere de controle (inclusive NUL) e metade solta de par UTF-16 viram U+FFFD;
 * - fica so o comando e as chaves (`EVALSHA <sha> <n> <chaves...>`; demais comandos, comando + chave) e o resto
 *   vira `[args omitidos]`. O `EVAL` com script cru sai inteiro: `eval <script> [args omitidos]`;
 * - dado pessoal na chave vira `***`; teto de `REDIS_STATEMENT_MAX`.
 *
 * Idempotente, inclusive sobre a saida do `redisStatementSerializer`.
 */
export function redisStatementGravavel(statement) {
    return statementRedisSemValores(statement.replace(CONTROLE, "�").replace(SURROGATE_SOLTO, "�"));
}
/** Controle (inclusive NUL) e metade solta de par UTF-16 viram U+FFFD; teto de `REDIS_STATEMENT_MAX`. */
function textoLimpo(texto) {
    let s = texto.replace(CONTROLE, "�").replace(SURROGATE_SOLTO, "�");
    if (s.length > REDIS_STATEMENT_MAX)
        s = `${s.slice(0, REDIS_STATEMENT_MAX)}…`;
    return s;
}

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
//      Redis, para o app que ainda usa o serializer padrao.
//
// Arquivo sem dependencia: entra no entry leve (edge-safe).

/** Teto do statement de Redis gravado. Comando + chaves cabem com folga. */
export const REDIS_STATEMENT_MAX = 300;

/** Argumento como a ioredis o recebe. */
type RedisArg = string | number | Uint8Array | unknown[] | null | undefined;

function argComoTexto(arg: RedisArg): string {
  if (typeof arg === "string") return arg;
  if (typeof arg === "number") return String(arg);
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
export function redisStatementSerializer(cmdName: string, cmdArgs: RedisArg[] = []): string {
  const cmd = String(cmdName).toLowerCase();
  const partes: string[] = [cmd];
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
    } else {
      usados = 1;
    }
  } else if (cmdArgs.length > 0) {
    partes.push(argComoTexto(cmdArgs[0]));
    usados = 1;
  }

  const resto = cmdArgs.length - usados;
  if (resto > 0) partes.push(`[+${resto} args]`);
  return textoLimpo(partes.join(" "));
}

/** Marcador do corte do `redisStatementGravavel`: la nao da para contar os ARGV (o valor pode ter espacos). */
export const REDIS_ARGS_OMITIDOS = "[args omitidos]";

const CONTROLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SURROGATE_SOLTO = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Defesa do lado de quem emite, para statement que veio do serializer padrao:
 * - `EVALSHA <sha> <n> <chaves...>`: corta tudo depois das chaves (os ARGV);
 * - caractere de controle (inclusive NUL) e metade solta de par UTF-16 viram U+FFFD;
 * - teto de `REDIS_STATEMENT_MAX`.
 *
 * O `EVAL` com o serializer padrao nao da para separar (o script tem espacos), entao ele fica so com a limpeza e o
 * teto: quem precisa de garantia passa o `redisStatementSerializer`.
 */
export function redisStatementGravavel(statement: string): string {
  let s = statement;
  const m = /^(evalsha)\s+(\S+)\s+(\d+)\s+/i.exec(s);
  if (m) {
    const numKeys = Number(m[3]);
    const depois = s.slice(m[0].length).split(" ");
    const chaves = depois.slice(0, numKeys);
    const cauda = depois.slice(numKeys).join(" ");
    // Ja veio cortado (do redisStatementSerializer ou de uma passada anterior): mantem.
    const jaCortado = cauda === "" || /^\[\+\d+ args\]$/.test(cauda) || cauda === REDIS_ARGS_OMITIDOS;
    s = [m[1], m[2], m[3], ...chaves].join(" ") + (jaCortado ? (cauda ? ` ${cauda}` : "") : ` ${REDIS_ARGS_OMITIDOS}`);
  }
  return textoLimpo(s);
}

/** Controle (inclusive NUL) e metade solta de par UTF-16 viram U+FFFD; teto de `REDIS_STATEMENT_MAX`. */
function textoLimpo(texto: string): string {
  let s = texto.replace(CONTROLE, "�").replace(SURROGATE_SOLTO, "�");
  if (s.length > REDIS_STATEMENT_MAX) s = `${s.slice(0, REDIS_STATEMENT_MAX)}…`;
  return s;
}

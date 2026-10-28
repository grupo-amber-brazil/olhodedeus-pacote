/**
 * Dado pessoal e argumento de Redis fora da telemetria, na origem (o span vira evento já limpo).
 *
 * O ingest do Olho de Deus repete a mesma limpeza antes de gravar, porque recebe de quem ainda não atualizou:
 * em 28/10/2026 nenhum dos 11 repos estava na v0.6.0, e a Mística gravava o job inteiro do BullMQ no
 * `statement` do `EVALSHA` — 39,7 mil linhas em 30 h, ~7 mil com telefone e ~6,7 mil com e-mail de lead.
 *
 * Mesma ideia do Sentry: o SDK limpa e o servidor limpa de novo antes de guardar.
 *
 * ⚠️ Espelhado no ingest do Olho de Deus em `src/lib/ingest/dados-pessoais.ts`. Mudou aqui, mudar lá.
 * ⚠️ É normalização, nunca validação: nada aqui recusa evento.
 */
export const MASCARA = "***";
/** Teto do `statement` de Redis gravado. Comando + chaves cabem com folga. */
export const REDIS_STATEMENT_MAX = 300;
export const REDIS_ARGS_OMITIDOS = "[args omitidos]";
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Telefone brasileiro COM o 55: 5548999998888, +55 48 99999-8888, +55 (48) 9999-8888. Sem o 55, 10 ou 11 dígitos se
// confundem com id e timestamp. Letra ou dígito colado de um dos lados não casa: protege hash, uuid e id longo.
const TELEFONE = /(?<![0-9A-Za-z])\+?55[\s.-]?\(?[1-9][0-9]\)?[\s.-]?9?[0-9]{4}[\s.-]?[0-9]{4}(?![0-9A-Za-z])/g;
// CPF só formatado: 11 dígitos soltos se confundem com outros números.
const CPF = /(?<![0-9])[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}(?![0-9])/g;
/**
 * Troca e-mail, telefone com 55 e CPF formatado por `***`. Devolve a MESMA string quando não há o que trocar.
 *
 * Exemplo: `Unique constraint failed: maria@gmail.com` → `Unique constraint failed: ***`.
 */
export function mascararDadosPessoais(texto) {
    let s = texto;
    if (s.includes("@"))
        s = s.replace(EMAIL, MASCARA);
    if (s.includes("55"))
        s = s.replace(TELEFONE, MASCARA);
    if (s.includes("-"))
        s = s.replace(CPF, MASCARA);
    return s;
}
const CAUDA_JA_CORTADA = /^(\[\+\d+ args\]|\[\d+ other arguments?\]|\[args omitidos\])$/;
/**
 * Statement de Redis só com o comando e as chaves, no padrão do OpenTelemetry (`SET mykey ?`):
 *
 * - `EVALSHA <sha> <n> <chaves...>`: o sha, o número de chaves e as chaves; os ARGV saem.
 * - `EVAL`: o script tem espaço e não dá para separar, então sai inteiro (`eval <script> [args omitidos]`).
 * - Demais comandos: o comando e o primeiro argumento (a chave).
 *
 * Exemplo: `evalsha e33b 2 bull:disparo:wait bull:disparo:id {"phone":"5548…"}` →
 * `evalsha e33b 2 bull:disparo:wait bull:disparo:id [args omitidos]`.
 *
 * A chave pode carregar telefone (`inbound:rl:janela:<telefone>`), por isso o resultado ainda passa pela máscara.
 */
export function statementRedisSemValores(statement) {
    const partes = statement.trim().split(/\s+/).filter(Boolean);
    if (partes.length === 0)
        return statement;
    const cmd = partes[0].toLowerCase();
    let manter;
    if (cmd === "evalsha" || (cmd === "eval" && partes[1] === "<script>")) {
        // O `eval <script> <n> <chaves>` é o que o serializer do pacote já grava.
        const n = Number(partes[2]);
        manter = Number.isInteger(n) && n >= 0 ? Math.min(partes.length, 3 + n) : Math.min(partes.length, 2);
    }
    else if (cmd === "eval") {
        return limitar(`eval <script> ${REDIS_ARGS_OMITIDOS}`);
    }
    else {
        manter = Math.min(partes.length, 2);
    }
    const cabeca = partes.slice(0, manter).join(" ");
    const cauda = partes.slice(manter).join(" ");
    const resultado = cauda === "" ? cabeca : CAUDA_JA_CORTADA.test(cauda) ? `${cabeca} ${cauda}` : `${cabeca} ${REDIS_ARGS_OMITIDOS}`;
    return limitar(mascararDadosPessoais(resultado));
}
function limitar(s) {
    return s.length > REDIS_STATEMENT_MAX ? `${s.slice(0, REDIS_STATEMENT_MAX)}…` : s;
}
/**
 * Aplica `mascararDadosPessoais` em todo texto de um valor JSON (os valores, não as chaves). Devolve a MESMA
 * referência quando nada mudou, para não alocar no caminho comum. O aninhamento já chega cortado pelo `payloadGravavel`.
 */
export function mascararNoValor(valor) {
    if (typeof valor === "string")
        return mascararDadosPessoais(valor);
    if (valor === null || typeof valor !== "object")
        return valor;
    if (Array.isArray(valor)) {
        let copia = null;
        for (let i = 0; i < valor.length; i++) {
            const item = mascararNoValor(valor[i]);
            if (item !== valor[i] && copia === null)
                copia = valor.slice(0, i);
            if (copia !== null)
                copia.push(item);
        }
        return copia ?? valor;
    }
    let mudou = false;
    const entradas = [];
    for (const [chave, item] of Object.entries(valor)) {
        const v = mascararNoValor(item);
        if (v !== item)
            mudou = true;
        entradas.push([chave, v]);
    }
    if (!mudou)
        return valor;
    // `defineProperty` pelo mesmo motivo do sanitize: a chave `__proto__` vinda do JSON.parse é propriedade própria.
    const copia = {};
    for (const [k, v] of entradas) {
        Object.defineProperty(copia, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    return copia;
}

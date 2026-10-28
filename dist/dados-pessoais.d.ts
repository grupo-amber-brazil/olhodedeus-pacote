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
export declare const MASCARA = "***";
/** Teto do `statement` de Redis gravado. Comando + chaves cabem com folga. */
export declare const REDIS_STATEMENT_MAX = 300;
export declare const REDIS_ARGS_OMITIDOS = "[args omitidos]";
/**
 * Troca e-mail, telefone com 55 e CPF formatado por `***`. Devolve a MESMA string quando não há o que trocar.
 *
 * Exemplo: `Unique constraint failed: maria@gmail.com` → `Unique constraint failed: ***`.
 */
export declare function mascararDadosPessoais(texto: string): string;
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
export declare function statementRedisSemValores(statement: string): string;
/**
 * Aplica `mascararDadosPessoais` em todo texto de um valor JSON (os valores, não as chaves). Devolve a MESMA
 * referência quando nada mudou, para não alocar no caminho comum. O aninhamento já chega cortado pelo `payloadGravavel`.
 */
export declare function mascararNoValor(valor: unknown): unknown;

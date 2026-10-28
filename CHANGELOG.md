# Changelog

Histórico de versões do `@amber/olho-de-deus`. Formato baseado em
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento
[SemVer](https://semver.org/lang/pt-BR/) — em `0.x`, mudança de comportamento
sobe o **minor**.

O pacote é instalado **por tag git**, então cada versão aqui corresponde a uma
tag no repo. A coluna que importa pra quem consome é **"Ação do consumidor"**:
se for _nenhuma_, atualizar é só trocar a tag (ver
[docs/atualizar-consumidor.md](docs/atualizar-consumidor.md)).

---

## [0.7.0] — 2026-10-28

**Ação do consumidor: nenhuma** (só trocar a tag). Quem registra a `IORedisInstrumentation` continua
devendo passar o `redisStatementSerializer`, mas sem ele os valores já não saem.

### Corrigido

- **🔴 Dado pessoal de lead na telemetria.** Em 28/10/2026 a Mística (v0.5.0, sem o serializer)
  gravava o job inteiro do BullMQ no `statement` do `EVALSHA`: 39,7 mil linhas em 30 h, ~7 mil com
  telefone e ~6,7 mil com e-mail, que seguiam para o arquivo Parquet. Agora:
  - `redisStatementGravavel` corta os valores de **todo** comando Redis, não só do `EVALSHA`
    (`set sessao:42 [args omitidos]`, `eval <script> [args omitidos]`);
  - e-mail, telefone com 55 e CPF formatado viram `***` em `name`, `path`, `errorMessage`,
    `errorStack` e nos valores de `metadata`, nos spans e no `sendGodeyeEvent`. `userId`, ids de
    trace, `userAgent` e `clientIp` ficam;
  - o serializer também mascara telefone nas chaves (`inbound:rl:janela:***`).
- **IP do visitante forjável.** Sem Cloudflare nem `x-real-ip`, o `requestHook` lia o **primeiro**
  item do `X-Forwarded-For`, que o visitante manda. Atrás do ALB da AWS o real é o **último**.

### Adicionado

- **O 429 do ingest pausa o envio** do processo até vencer o `Retry-After` (60 s sem o header, teto
  de 1 h), e o que surge na pausa é descartado. Molde do Sentry: o SDK não reenvia, para de enviar.
  Antes o pacote tratava 429 como sucesso e seguia no mesmo ritmo.
- `mascararDadosPessoais` e `semDadosPessoais` exportados, para evento montado à mão.

---

## [0.6.0] — 2026-10-27

**Ação do consumidor: só quem registra a `IORedisInstrumentation`** (hoje, a Mística):
passar `dbStatementSerializer: redisStatementSerializer`. Os demais só trocam a tag.

### Corrigido

- **🔴 `statement` de Redis com os valores do comando.** O serializer padrão da
  `IORedisInstrumentation` grava todos os argumentos. No `EVALSHA` do BullMQ isso
  é o job inteiro em msgpack: dado do job e bytes NUL. O NUL fazia o Postgres do
  ingest recusar o lote inteiro (`22P05`) e o ingest responder 500 em ~1,2% das
  requisições da Mística (medido em 27/10/2026, 400 a 650 por hora), levando os
  `http_out` e `db_query` vizinhos junto. Agora o `span-processor` passa todo
  statement de Redis por `redisStatementGravavel`: corta os argumentos do
  `EVALSHA`, troca caractere de controle e metade solta de par UTF-16 por U+FFFD
  e aplica teto de 300 caracteres.

### Adicionado

- `redisStatementSerializer(cmdName, args)` para a `IORedisInstrumentation`:
  grava só comando e chaves (`evalsha <sha> 9 bull:openai:wait … [+3 args]`,
  `set sessao:42 [+3 args]`). É a correção na origem: o valor nem vira atributo
  do span.

---

## [0.5.0] — 2026-07-20

**Ação do consumidor: nenhuma** (só trocar a tag). Sem mudança de API.

### Corrigido

- **🔴 Perda total de telemetria HTTP em apps Next 14.** O span nativo do Next
  (`instrumentationScope` = `next.js`) é `SpanKind.SERVER` e tem `http.method`,
  mas **não** carrega `http.response.status_code`. O ramo SERVER do
  `spanToPayload` fazia `Number(statusRaw) || 0` e emitia `httpStatus: 0`, que
  reprova no `min(100)` do Zod do ingest. Como o `BatchSpanProcessor` manda o
  lote inteiro **num array só**, o ingest respondia `400` e descartava **todos**
  os eventos do POST — inclusive o span irmão válido do `instrumentation-http` e
  os `db_query` do mesmo batch.

  Impacto medido: o `anamnese-pmf-web` caiu de **~4.000 eventos `http`/dia para
  ~13/dia** entre 08/07 e 20/07/2026 (12 dias), e ficou com **0 traces completos**
  (`http` + `db_query` no mesmo trace) contra 5.488 do easyfit e 8.131 da mística
  no mesmo período. O que sobrava eram só assets de `/_next/static/*`.

  Agora o ramo SERVER **descarta** o span quando não há status válido
  (`100..599`), espelhando o guard que o ramo `http_out` já fazia. É seguro
  porque o `instrumentation-http` (registrado em `register-web.ts`) cobre a mesma
  requisição **com** status.

  **Por que passou 12 dias despercebido:** `sendGodeyeBatch` não checa
  `res.ok`, e o exporter faz `.then(() => SUCCESS)`. Um HTTP 400 **resolve** o
  `fetch`, então o `BatchSpanProcessor` registrava sucesso. O pacote era
  estruturalmente cego a rejeição do ingest.

- **🔴 Segredo em texto claro na query string.** `path` e `name` gravavam a query
  crua. Como webhook autentica por querystring, o segredo ia pro banco legível:
  27.837 linhas na mística (`?secret=`), 410 no anamnese (`?token=` do Active
  Campaign e do **reset-password** de usuária), e nas chamadas de **saída** o
  `access_token` da Meta Graph API e a API key do Gemini.

  Agora o **valor** de parâmetro sensível é redigido (`?secret=***`), preservando
  a chave e a query legítima (`?q=99039442` fica intacto). Vale pros dois ramos:
  `http` (entrada) e `http_out` (saída). Denylist por substring no nome do
  parâmetro — ver `SENSITIVE_PARAM_PARTS` em `src/span-processor.ts`.

  > ⚠️ **Isto não conserta o passado.** As credenciais que já foram gravadas
  > precisam ser **rotacionadas** — a redação só impede novas.

### Adicionado

- `redactQuerySecrets(pathWithQuery)` exportado de `src/span-processor.ts`.
- **Testes** (`npm test`) — `node:test` + `tsc`, sem vitest/esbuild. O repo não
  tinha teste nenhum; os dois bugs acima são de função pura e teriam sido pegos
  por 5 linhas.
- Este `CHANGELOG.md` e o runbook [docs/atualizar-consumidor.md](docs/atualizar-consumidor.md).

### Conhecido / não resolvido nesta versão

- **Duplicação de span de entrada.** Cada request gera **dois** spans SERVER (o
  do `next.js` e o do `instrumentation-http`), pai e filho, mesmo path. Em apps
  Next 15 **os dois têm status**, então os dois passam e são gravados: medido em
  **2,01 eventos `http` por trace** no easyfit e na mística, e **2,88** no
  dashboard-bi e na lp-pmf (20/07/2026). O fix desta versão **não** resolve isso
  — só descarta span sem status. Deduplicar (por `instrumentationScope`, ou
  descartando SERVER que tenha SERVER pai no mesmo trace) é item próprio.
- **Denylist é piso, não teto.** Sempre vai faltar o parâmetro que ninguém
  pensou. A mesma redação deveria rodar também no ingest, como segunda camada.

---

## [0.4.1] — 2026-07-09

**Ação do consumidor: nenhuma.**

### Corrigido

- `clientIp` vindo do `requestHook` (CF-aware) passa a ter prioridade sobre o
  atributo do span. Atrás da Cloudflare, `client.address`/`net.peer.ip` é o IP da
  **borda** (tipicamente US) — usá-lo geolocalizava errado e colapsava todos os
  visitantes num IP só na presença ao vivo.

## [0.4.0] — 2026-07-09

**Ação do consumidor: nenhuma.**

### Adicionado

- Captura de geo/IP da Cloudflare (`cf-connecting-ip` + `cf-ipcountry`), com
  fallback pro `x-real-ip`/`x-forwarded-for` em repo sem CF. O ingest prefere
  esse geo sobre o `geoip-lite`.

## [0.3.1] — 2026-07-08

**Ação do consumidor: nenhuma.**

### Adicionado

- `sendGodeyeEvent` e o tipo `GodeyeJobOptions` exportados do entry principal.

## [0.3.0] — 2026-07-08

**Ação do consumidor: nenhuma.**

### Adicionado

- Instrumentação de chamadas de saída (`http_out`) também no path **worker**.
- `userId` opcional no `godeyeJobWrapper`.

## [0.2.0] — 2026-07-08

**Ação do consumidor: nenhuma.**

### Adicionado

- Instrumentação de chamadas de **saída** (`http_out`) no path web. Antes só
  capturávamos entrada (`http`), `db_query` e jobs — a latência e o erro das
  chamadas pra OpenAI/Bunny/Meta eram um buraco preto no waterfall.

## [0.1.0] — 2026-07-08

Pacote inicial. Instrumentação OTel de HTTP + DB + Redis + jobs + `userId`,
substituindo o `lib/godeye/*` bespoke que cada repo escrevia à mão.

[0.5.0]: https://github.com/amber-brazil/olhodedeus-pacote/releases/tag/v0.5.0
[0.4.1]: https://github.com/amber-brazil/olhodedeus-pacote/releases/tag/v0.4.1
[0.4.0]: https://github.com/amber-brazil/olhodedeus-pacote/releases/tag/v0.4.0
[0.3.1]: https://github.com/amber-brazil/olhodedeus-pacote/releases/tag/v0.3.1
[0.3.0]: https://github.com/amber-brazil/olhodedeus-pacote/releases/tag/v0.3.0
[0.2.0]: https://github.com/amber-brazil/olhodedeus-pacote/releases/tag/v0.2.0
[0.1.0]: https://github.com/amber-brazil/olhodedeus-pacote/releases/tag/v0.1.0

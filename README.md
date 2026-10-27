# @amber/olho-de-deus

Instrumentação **OpenTelemetry** do [Olho de Deus](https://eye.grupoamber.com.br) — a
observabilidade interna da Amber. Um pacote, uma chamada: liga **HTTP + db_query + Redis
+ jobs + userId**, todos amarrados por `traceId`, e manda em lote pro ingest.

Substitui o `lib/godeye/*` bespoke que cada repo escrevia à mão (e errava). O fix de um
bug vive **aqui**, não em 5 repos.

> Uso interno. Instalado **via git** (não publicado no npm registry).

## Instalar

```bash
pnpm add github:amber-brazil/olhodedeus-pacote#v0.5.0
```

O `@opentelemetry/api` é peer dep — projetos Next normalmente já têm. Se faltar:
`pnpm add @opentelemetry/api`.

Já usa o pacote e quer subir de versão? Ver
**[docs/atualizar-consumidor.md](docs/atualizar-consumidor.md)** — trocar a tag
sem rodar o install deixa o lockfile pinado no commit antigo e o deploy sobe
verde com o pacote velho.

O que mudou entre versões (e se exige ação de quem consome) vive no
**[CHANGELOG.md](CHANGELOG.md)**.

## Env

| Var | Obrigatória | Descrição |
|---|---|---|
| `GODEYE_TOKEN` | sim | Token per-project do dashboard. Sem ele, tudo vira no-op silencioso. |
| `GODEYE_INGEST_URL` | não | Override do endpoint (default: produção). Útil pra staging. |
| `GODEYE_CAPTURE_USER` | não | `false` desliga a captura de userId sem tocar código. |

## Uso

### Web (Next.js) — `instrumentation.ts` na raiz

```ts
import { registerGodeye } from "@amber/olho-de-deus/web";

export function register() {
  return registerGodeye({ source: "meu-projeto-web" });
}
```

### DB — Prisma (client extension)

```ts
import { PrismaClient } from "@prisma/client";
import { godeyePrismaExtension } from "@amber/olho-de-deus";

export const prisma = new PrismaClient().$extends(godeyePrismaExtension);
```

### DB — Drizzle + postgres.js

```ts
import postgres from "postgres";
import { instrumentPostgresClient } from "@amber/olho-de-deus";

const client = postgres(process.env.POSTGRES_URL!);
instrumentPostgresClient(client); // 1 linha, antes de passar pro drizzle()
```

### userId — no resolver central (o ponto onde você sabe quem é o user)

```ts
import { setGodeyeUser } from "@amber/olho-de-deus";

// NextAuth: no callback session()
setGodeyeUser(session.user.id);

// Webhook por identificador: logo após resolver o user no banco
const user = await prisma.user.findUnique({ where: { whatsapp } });
setGodeyeUser(user?.id); // só o id — nunca nome/email
```

### Worker (BullMQ via tsx) / Nest — primeira linha do entrypoint

```ts
import { registerGodeyeWorker } from "@amber/olho-de-deus/worker";
await registerGodeyeWorker({ source: "meu-projeto-worker" });

import { godeyeJobWrapper } from "@amber/olho-de-deus";
new Worker(queue, godeyeJobWrapper(async (job) => { /* ... */ }), { connection });
```

### Redis — reportar erro de conexão

```ts
import { reportRedisError } from "@amber/olho-de-deus";
redis.on("error", (e) => reportRedisError(e.message));
```

### Redis — comandos como `db_query` (opcional)

O pacote não instrumenta os comandos do ioredis. Quem quiser cada comando como `db_query` registra a
`IORedisInstrumentation` **com o serializer do pacote**, que grava só o comando e as chaves:

```ts
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { redisStatementSerializer } from "@amber/olho-de-deus";

registerInstrumentations({
  instrumentations: [new IORedisInstrumentation({ dbStatementSerializer: redisStatementSerializer })],
});
```

⚠️ Sem o serializer, a instrumentação grava os **valores**: no `EVALSHA` do BullMQ, o job inteiro em
msgpack, com bytes NUL. O pacote corta os argumentos do `EVALSHA` e limpa o texto como defesa
(`redisStatementGravavel`), mas o `EVAL` com script não dá para separar e só sai limpo e cortado em
300 caracteres.

## Princípios

- **Fire-and-forget:** nunca bloqueia o request. Timeout duro de 500ms. Nunca lança.
- **Sem token → no-op.** Adicionar o pacote não muda nada até `GODEYE_TOKEN` existir — é
  aditivo e não gera regressão.
- **PII:** só a **forma** do SQL (`WHERE id = $1`, `user.findUnique`) e do comando Redis
  (comando + chaves, com o `redisStatementSerializer`), nunca os valores.
  userId é só o **id** canônico, nunca nome/email. Valor de parâmetro sensível na
  query string é redigido (`?secret=***`) antes de sair da máquina.
- **DB via Prisma extension**, não `@prisma/instrumentation` (que quebra sob OTel SDK 2.x).
- **Nunca emitir payload que o ingest rejeita.** O ingest valida item a item desde
  julho de 2026, e desde outubro regrava item a item o lote que o banco recusa: um
  item ruim não leva mais os vizinhos. Mesmo assim, campo fora do contrato →
  descarta o span, não manda mentira (`httpStatus: 0`), e texto vai sem NUL.

## Testes

```bash
npm test   # tsc -p tsconfig.test.json && node --test
```

`node:test` + `tsc`, sem vitest/esbuild — o pacote não deve ganhar bundler pra
testar função pura. Testes em `test/`, saída em `.test-out/` (gitignored).

## Status

`v0.6` — HTTP (entrada e saída), `db_query`, Redis, jobs e `userId` em produção nos
repos da Amber. `userId` usa o map por `traceId` e **não funciona em pages-router**
(webhook-first): o span SERVER não fica ativo dentro do handler. Vínculo continua
possível pelo `traceId` via `db_query`. Endurecimento por OTel baggage e dedup dos
spans SERVER aninhados: próximos ciclos — ver [CHANGELOG.md](CHANGELOG.md).

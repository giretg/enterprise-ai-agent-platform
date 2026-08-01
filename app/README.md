# Enterprise AI Agent Platform

Next.js App Router alkalmazás valódi Postgres adattal, Clerk/dev auth-val és ChatGPT OAuth Model Gateway adapterrel.

- **Control Plane** — governance, board, ticketek, audit, agent registry, tanítás
- **Sandbox** — wiki-agent tudásbázis, citált válaszok, A0 HTML riport preview/export

## Előfeltételek

- Node.js 20+
- **Neon Postgres** projekt ([neon.tech](https://neon.tech))
- Opcionális: `CHATGPT_OAUTH_PROVIDER_URL` és `CHATGPT_OAUTH_PROVIDER_KEY` valódi S2 LLM-mediációhoz
- Opcionális: `OPENROUTER_API_KEY` kísérleti többmodell-eléréshez; modelleket admin engedélyez a Rendszer oldalon
- Opcionális: `HARNESS_LAUNCHER_MODE=cloud-run-job` + Cloud Run Job env a S1 harness spike-hoz
- Opcionális: Clerk kulcsok emberi auth-hoz

## Gyors indítás

```bash
cd app
cp .env.example .env.local
```

A Neon Console-ban másold ki mindkét connection stringet:

| Változó | Neon típus | Használat |
|---|---|---|
| `DATABASE_URL` | **Pooled connection** | Next.js app, server actions |
| `DIRECT_URL` | **Direct connection** | `prisma migrate`, `db push`, seed |

```bash
npm install
npm run db:push    # vagy: npm run db:migrate
npm run db:seed
npm run dev
```

Nyisd meg: http://localhost:3000/control-plane

> **Fontos:** mindkét URL-hez legyen `?sslmode=require`. A pooled URL `-pooler` hostnevet használ.

**Teszt adatbázis (opcionális):** Neon branch → `DATABASE_URL_TEST` + `DIRECT_URL_TEST`. Váltás: `/control-plane/system`. Séma/seed: `npm run db:push:test`, `npm run db:seed:test`.

A repó gyökeréből ugyanez: `npm run dev`, `npm run build`, stb.

### Séma-migrációk (Prisma Migrate) — WP-5

A séma verziózott migrációkkal megy, **nem** ad-hoc `db push`-sal. A migrációtörténet
a `prisma/migrations/` alatt él, review-zható és környezetek közt reprodukálható:

- `0000_init` — a teljes séma baseline-ja (a `schema.prisma`-ból generálva).
- `0001_audit_append_only_trigger` — az `audit_log` append-only trigger (nyers SQL, nem
  ábrázolható Prisma-sémában).
- `0002_kb_chunk_fts_index` — a `knowledge_chunks` tsvector GIN full-text index.

**Munkafolyamat:**

| Helyzet | Parancs |
|---|---|
| Fejlesztői sémaváltás | `npm run db:migrate` (`prisma migrate dev` — új migrációt generál) |
| Éles / staging deploy | `npm run db:migrate:deploy` (`prisma migrate deploy`) |
| Állapot ellenőrzése | `npm run db:migrate:status` |

> **Szabály:** sémaváltás = **új migráció**, nem `db push`. A `db push` már csak gyors dev-iterációra.

**Meglévő DB baseline-elése (egyszeri):** ahol a séma korábban `db push`-sal került fel
(prod/dev/test), a baseline-t „már alkalmazott"-nak kell jelölni, hogy a `migrate deploy` ne
futtassa újra a `0000_init`-et:

```bash
npx prisma migrate resolve --applied 0000_init
# a 0001/0002 nyers SQL idempotens (IF NOT EXISTS / OR REPLACE); ha a trigger/index már
# telepítve volt a régi apply-scripttel, jelöld szintén appliednek, vagy hagyd lefutni.
```

A CI (`.github/workflows/ci.yml` → `migrations` job) minden PR-en egy ephemeral Postgres
ellen futtatja a `migrate deploy` + `migrate status`-t, így a migrációs lánc bizonyítottan
tiszta DB-re alkalmazható és nincs drift a sémához képest.

## Architektúra

- `src/domain/` — üzleti logika (TicketService, ModelGateway, WikiAgentRuntime, TrainingService)
- `src/repositories/` — Postgres implementációk interfészek mögött
- `src/auth/` — AuthProvider absztrakció (Clerk vagy Dev fallback)
- `src/app/actions/` — server actions

## Dev auth

Clerk nélkül a `DevAuthProvider` fut, alapértelmezett szerep: `operator` (`.env.local`: `DEV_AUTH_ROLE`).

Jóváhagyási műveletekhez állítsd: `DEV_AUTH_ROLE=approver`

## Harness launcher

Alapértelmezésben a dispatcher a lokális wiki runtime-ot indítja:

```bash
HARNESS_LAUNCHER_MODE=local-wiki
```

S1-S4 spike-hoz Cloud Run Job indításra váltható:

```bash
HARNESS_LAUNCHER_MODE=cloud-run-job
HARNESS_CLOUD_RUN_PROJECT_ID=your-gcp-project
HARNESS_CLOUD_RUN_LOCATION=europe-west1
HARNESS_CLOUD_RUN_JOB_NAME=wiki-harness
PLATFORM_API_URL=https://your-platform.example.com
HARNESS_CALLBACK_URL=https://your-platform.example.com
HARNESS_CALLBACK_TOKEN=shared-callback-secret
HARNESS_EGRESS_ENFORCE=true
```

### GCP Cloud Run Job deploy + smoke

```bash
cp infra/gcp/harness-job.env.example infra/gcp/harness-job.env
# szerkeszd: GCP_PROJECT_ID, PLATFORM_API_URL, VPC_CONNECTOR, stb.
npm run harness:cloud-run-deploy

# Dispatcher + platform után:
HARNESS_LAUNCHER_MODE=cloud-run-job npm run dispatcher:worker
npm run harness:cloud-run-smoke
```

**VPC egress (S4):** a deploy script `--vpc-connector` + `--vpc-egress=all-traffic` flaget ad át. A deny-by-default igazolásához a connector subnetjén firewall szabály kell: csak a platform/Gateway/Broker célok engedélyezettek, minden más outbound tiltva. A harness induláskor `HARNESS_EGRESS_ENFORCE=true` runtime probe-ot is futtat (`example.com` elérhetetlenség = N4).

Lokális Wiki E2E GCP nélkül (dispatcher → Docker harness → platform runtime → callback):

```bash
HARNESS_LAUNCHER_MODE=docker-local
HARNESS_MODE=wiki
HARNESS_CALLBACK_TOKEN=shared-callback-secret   # .env.local-ben is
HARNESS_CALLBACK_URL=http://host.docker.internal:3000
docker build -f Dockerfile.harness -t wiki-harness:local .
npm run dev
npm run dispatcher:worker
```

A Cloud Run Job konténer `TICKET_ID`, `AGENT_ID` és `DISPATCH_LOCK_TOKEN` env változókat kap. GCP-n a launcher a default service account metadata tokenjét használja; lokális smoke-hoz `HARNESS_CLOUD_RUN_BEARER_TOKEN` adható meg.

A harness job a futás végén a platform callback endpointját hívja, hogy a dispatcher lock ne maradjon beragadva:

```bash
HARNESS_CALLBACK_URL=https://your-platform.example.com
HARNESS_CALLBACK_TOKEN=shared-callback-secret
```

Minimális harness image proof:

```bash
docker build -f Dockerfile.harness -t wiki-harness:local .
```

Alapértelmezésben a harness provider-független wiki-feldolgozást kér a platformtól:

```bash
HARNESS_MODE=wiki
PLATFORM_API_URL=http://host.docker.internal:3000
HARNESS_AGENT_API_KEY=<efemer vagy smoke agent kulcs>
```

A `Dockerfile.harness` csak a platform completion entrypointot tartalmazza; saját agent-loopot nem futtat.

### Gateway + Tool Broker

A platform runtime a két kormányzott átjárón keresztül kommunikál:

```bash
# OpenAI-kompatibilis belső gateway
MODEL_GATEWAY_URL=http://127.0.0.1:3000/api/v1/gateway/v1
# Platform REST
PLATFORM_API_URL=http://127.0.0.1:3000
HARNESS_AGENT_API_KEY=<seed .seed-demo-api-key>
HARNESS_MODE=wiki
```

ChatGPT OAuth stub (acceptance / lokális dev):

```bash
CHATGPT_OAUTH_PROVIDER_URL=stub
CHATGPT_OAUTH_PROVIDER_KEY=stub
# vagy külön HTTP stub: npm run s2:stub
```

A harness entrypoint a platform `/api/v1/harness/tickets/{id}/process` végpontját hívja; a modell- és tool-kormányzás a platform runtime-ban marad.

S4 egress + timeout:

```bash
# Harness indulás előtti külső URL probe (GCP-n VPC-vel együtt)
HARNESS_EGRESS_ENFORCE=true
npm run harness:egress-probe

# Beragadt dispatch lock watchdog (dispatcher worker-ben is fut)
HARNESS_DISPATCH_TIMEOUT_MS=1800000

# Chat AgentTurn watchdog — elavult heartbeatű fordulók lezárása (~120 mp)
AGENT_TURN_STALE_MS=120000

# Docker completion smoke (platform dev szerver kell host.docker.internal:3000)
docker build -f Dockerfile.harness -t wiki-harness:local .
npm run harness:docker-smoke

```

## Dispatcher worker

Eseményvezérelt indítás Postgres `LISTEN/NOTIFY`-val + 30 mp-es cron safety net:

```bash
npm run dispatcher:worker
```

A `ready` ticket létrehozásakor / `rejected → ready` átmenetkor a repo `pg_notify('dispatch_ticket_ready', ticketId)` hívást küld.

Izolált completion-contract proofhoz explicit parancs is indítható:

```bash
HARNESS_MODE=callback-only
HARNESS_COMMAND_JSON='["node","scripts/harness-proof.js"]'
```

## Deploy

Firebase App Hosting — részletes útmutató: [`DEPLOY.md`](../DEPLOY.md)

```bash
npm run deploy   # repó gyökeréből
```

## Dokumentáció

- [`AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md`](../AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md) — historikus v1 fejlesztési spec és roadmap
- [`AI-Agent-Platform-Koncepcio.md`](../AI-Agent-Platform-Koncepcio.md) — teljes koncepció
- [`AI-Agent-Platform-MVP-Terv-v1.0.md`](../AI-Agent-Platform-MVP-Terv-v1.0.md) — historikus v1 terv

## Acceptance teszt

```bash
npm run test:acceptance
```

## File editor E2E (Playwright, W7)

Clerk nélkül (dev auth), stub storage:

```bash
FILE_EDITOR_STUB=true npm run test:e2e
# első futás: PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npx playwright install chromium
```

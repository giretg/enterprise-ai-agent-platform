# Enterprise AI Agent Platform MVP

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

Lokális Goose E2E GCP nélkül (dispatcher → Docker harness → callback):

```bash
HARNESS_LAUNCHER_MODE=docker-local
HARNESS_MODE=goose
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

Alapértelmezésben a harness csak a completion szerződést bizonyítja. Goose mód:

```bash
HARNESS_MODE=goose
HARNESS_RECIPE_PATH=/recipes/wiki-answer.yaml
```

A `Dockerfile.harness` a Goose CLI-t és a `harness/recipes/wiki-answer.yaml` recipe-t tartalmazza (§6).

### S2/S3 spike — Gateway + MCP bridge

A Goose harness a két átjárón keresztül kommunikál:

```bash
# OpenAI-kompatibilis belső gateway (Goose OPENAI_BASE_URL)
MODEL_GATEWAY_URL=http://127.0.0.1:3000/api/v1/gateway/v1
# Platform REST — az MCP stdio bridge a Tool Broker felé proxy-z
PLATFORM_API_URL=http://127.0.0.1:3000
HARNESS_AGENT_API_KEY=<seed .seed-demo-api-key>
HARNESS_MODE=goose
```

ChatGPT OAuth stub (acceptance / lokális dev):

```bash
CHATGPT_OAUTH_PROVIDER_URL=stub
CHATGPT_OAUTH_PROVIDER_KEY=stub
# vagy külön HTTP stub: npm run s2:stub
```

A harness entrypoint `prepareGooseHarnessEnv()`-vel ephemeral Goose configot ír: developer extension kikapcsolva, `platform_broker` stdio bridge a `kb_search` + `board_write` eszközökhöz.

S4 egress + timeout:

```bash
# Harness indulás előtti külső URL probe (GCP-n VPC-vel együtt)
HARNESS_EGRESS_ENFORCE=true
npm run harness:egress-probe

# Beragadt dispatch lock watchdog (dispatcher worker-ben is fut)
HARNESS_DISPATCH_TIMEOUT_MS=1800000

# Docker completion smoke (platform dev szerver kell host.docker.internal:3000)
docker build -f Dockerfile.harness -t wiki-harness:local .
npm run harness:docker-smoke

# Teljes Goose run a két átjárón keresztül (Gateway + Tool Broker)
# Stub provider mellett a harness stub agent loop-ot is futtat (HARNESS_STUB_BROKER_FALLBACK=1).
npm run harness:docker-goose-smoke
```

## Dispatcher worker

Eseményvezérelt indítás Postgres `LISTEN/NOTIFY`-val + 30 mp-es cron safety net:

```bash
npm run dispatcher:worker
```

A `ready` ticket létrehozásakor / `rejected → ready` átmenetkor a repo `pg_notify('dispatch_ticket_ready', ticketId)` hívást küld.

Később ugyanebből az entrypointból indítható explicit Goose parancs is:

```bash
HARNESS_COMMAND_JSON='["goose","run","--no-session","--recipe","/recipes/wiki-answer.yaml"]'
```

## Deploy

Firebase App Hosting — részletes útmutató: [`DEPLOY.md`](../DEPLOY.md)

```bash
npm run deploy   # repó gyökeréből
```

## Dokumentáció

- [`AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md`](../AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md) — MVP fejlesztési spec és roadmap
- [`AI-Agent-Platform-Koncepcio.md`](../AI-Agent-Platform-Koncepcio.md) — teljes koncepció
- [`AI-Agent-Platform-MVP-Terv-v1.0.md`](../AI-Agent-Platform-MVP-Terv-v1.0.md) — MVP terv

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

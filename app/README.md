# Enterprise AI Agent Platform MVP

Next.js App Router alkalmazás valódi Postgres adattal, Clerk/dev auth-val és ChatGPT OAuth Model Gateway adapterrel.

- **Control Plane** — governance, board, ticketek, audit, agent registry, tanítás
- **Sandbox** — wiki-agent tudásbázis, citált válaszok, A0 HTML riport preview/export

## Előfeltételek

- Node.js 20+
- **Neon Postgres** projekt ([neon.tech](https://neon.tech))
- Opcionális: `CHATGPT_OAUTH_PROVIDER_URL` és `CHATGPT_OAUTH_PROVIDER_KEY` valódi S2 LLM-mediációhoz
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
```

A Cloud Run Job konténer `TICKET_ID`, `AGENT_ID` és `DISPATCH_LOCK_TOKEN` env változókat kap. GCP-n a launcher a default service account metadata tokenjét használja; lokális smoke-hoz `HARNESS_CLOUD_RUN_BEARER_TOKEN` adható meg.

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

# Enterprise AI Agent Platform

Next.js App Router Control Plane + tenant-scoped MCP gateway. Codex and Claude
Code authenticate to `/api/mcp/{tenantSlug}`. Control Plane is governance:
IAM, agent definitions, skills, connectors, write approvals, and the
append-only hash-chained audit log.

The legacy chat/runtime/dispatcher stack is under `legacy/` at the repo root
(**REFERENCE ONLY**). It is not imported from this app.

- **Control Plane** — `/control-plane` (agents, connectors, IAM, operations, audit)
- **MCP Gateway** — `POST/GET /api/mcp/{tenantSlug}`

## Előfeltételek

- Node.js 20+
- **Neon Postgres** projekt ([neon.tech](https://neon.tech))
- Clerk kulcsok emberi authhoz és MCP OAuth-hoz (`AUTH_DISABLED` / DevAuth nem
  harness-passing path)
- Lokális Drive I/O: `GOOGLE_DRIVE_API_STUB=true` (Core MVP kapu)

## Gyors indítás

```bash
cd app
cp .env.example .env.local
```

A Neon Console-ban másold ki mindkét connection stringet:

| Változó | Neon típus | Használat |
|---|---|---|
| `DATABASE_URL` | **Pooled connection** | Next.js app, server actions |
| `DIRECT_URL` | **Direct connection** | `prisma migrate`, seed |

```bash
npm install
npm run db:migrate
npm run db:seed
GOOGLE_DRIVE_API_STUB=true npm run dev
```

Nyisd meg: http://localhost:3000/control-plane

> **Fontos:** mindkét URL-hez legyen `?sslmode=require`. A pooled URL `-pooler` hostnevet használ.

**Teszt adatbázis (opcionális):** Neon branch → `DATABASE_URL_TEST` + `DIRECT_URL_TEST`. Váltás: `/control-plane/system`. Séma/seed: `npm run db:push:test`, `npm run db:seed:test`.

A repó gyökeréből ugyanez: `npm run dev`, `npm run build`, stb.

A seed publikál **és aktivál** egy Drive assistantot write connector bindinggel
(`drive.readonly` + `drive.file` = `selected_write`). `tokenRef` stub marad.

### Séma-migrációk (Prisma Migrate)

A séma verziózott migrációkkal megy, **nem** ad-hoc `db push`-sal. A migrációtörténet
a `prisma/migrations/` alatt él:

- `0001_init` — greenfield baseline
- `0002_gateway_operation_result` — GatewayOperation eredményoszlop (Phase E)
- `0003_connector_type_gmail` — `ConnectorType.gmail`
- `0004_audit_log` — `audit_log` tábla + append-only UPDATE/DELETE trigger (Phase F)

**Munkafolyamat:**

| Helyzet | Parancs |
|---|---|
| Fejlesztői sémaváltás | `npm run db:migrate` (`prisma migrate dev` — új migrációt generál) |
| Éles / staging deploy | `npm run db:migrate:deploy` (`prisma migrate deploy`) |
| Állapot ellenőrzése | `npm run db:migrate:status` |

> **Szabály:** sémaváltás = **új migráció**, nem `db push`. A `db push` már csak gyors dev-iterációra.

A CI (`.github/workflows/ci.yml` → `migrations` job) minden PR-en egy ephemeral Postgres
ellen futtatja a `migrate deploy` + `migrate status`-t.

## Architektúra

- `src/domain/gateway-services.ts` — composition root (IAM, tenant, definitions, audit)
- `src/domain/audit/` — `verifyChain` + JSONL export
- `src/auth/mcp-principal.ts` — Bearer → tenant-scoped MCP principal
- `src/app/api/mcp/[tenantSlug]/route.ts` — Streamable HTTP MCP resource
- `src/repositories/` — Postgres implementációk interfészek mögött

Részletek: [`docs/architecture.md`](../docs/architecture.md),
harness: [`docs/mcp-compatibility-runbook.md`](../docs/mcp-compatibility-runbook.md).

## Dev auth

Clerk nélkül a `DevAuthProvider` fut: automatikus belépés a `.env.local` `DEV_AUTH_*` userrel.

- `npm run dev` — ha van `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`, Clerk beléptető.
- `npm run dev:local-auth` — `AUTH_DISABLED=true`, port **3001**, Clerk UI nélkül. Productionban a flag nem él (`NODE_ENV === production` → 503). **A Core MVP harness ezen az úton nem megy át.**

Jóváhagyási műveletekhez állítsd: `DEV_AUTH_ROLE=approver`

## Deploy

Firebase App Hosting — részletes útmutató: [`DEPLOY.md`](../DEPLOY.md)

```bash
npm run deploy   # repó gyökeréből
```

## Dokumentáció

- [`AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md`](../AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md) — historikus v1 fejlesztési spec és roadmap
- [`AI-Agent-Platform-Koncepcio.md`](../AI-Agent-Platform-Koncepcio.md) — teljes koncepció
- [`AI-Agent-Platform-MVP-Terv-v1.0.md`](../AI-Agent-Platform-MVP-Terv-v1.0.md) — historikus v1 terv

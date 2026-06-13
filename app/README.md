# Enterprise AI Agent Platform (Fázis 1)

Next.js App Router alkalmazás valódi Postgres adattal, Clerk auth-val és Gemini Model Gateway-vel.

- **Control Plane** — governance, board, ticketek, audit, agent registry, tanítás
- **Sandbox** — könyvelő agent munkatér, számlafeldolgozás

## Előfeltételek

- Node.js 20+
- **Neon Postgres** projekt ([neon.tech](https://neon.tech))
- Opcionális: `GEMINI_API_KEY` valódi LLM-híváshoz
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

- `src/domain/` — üzleti logika (TicketService, ModelGateway, BookkeeperRuntime, TrainingService)
- `src/repositories/` — Postgres implementációk interfészek mögött
- `src/auth/` — AuthProvider absztrakció (Clerk vagy Dev fallback)
- `src/app/actions/` — server actions

## Dev auth

Clerk nélkül a `DevAuthProvider` fut, alapértelmezett szerep: `operator` (`.env.local`: `DEV_AUTH_ROLE`).

Jóváhagyási műveletekhez állítsd: `DEV_AUTH_ROLE=approver`

## Deploy

Firebase App Hosting — részletes útmutató: [`DEPLOY.md`](../DEPLOY.md)

```bash
npm run deploy   # repó gyökeréből
```

## Dokumentáció

- [`AI-Agent-Platform-Fazis1-Spec.md`](../AI-Agent-Platform-Fazis1-Spec.md) — Fázis 1 spec
- [`AI-Agent-Platform-Koncepcio.md`](../AI-Agent-Platform-Koncepcio.md) — teljes koncepció
- [`AI-Agent-Platform-MVP-Terv.md`](../AI-Agent-Platform-MVP-Terv.md) — MVP fejlesztési terv

## Acceptance teszt

```bash
npm run test:acceptance
```

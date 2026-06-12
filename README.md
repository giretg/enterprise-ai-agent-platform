# Enterprise AI Agent Platform

Kontrollált Enterprise AI Agent Platform — Fázis 1 (Next.js + Postgres).

- **Control Plane** — governance, board, ticketek, audit, agent registry
- **Sandbox** — könyvelő agent munkatér, számlafeldolgozás

## Dokumentáció

- [`AI-Agent-Platform-Fazis1-Spec.md`](AI-Agent-Platform-Fazis1-Spec.md) — Fázis 1 fejlesztői spec
- [`AI-Agent-Platform-Koncepcio.md`](AI-Agent-Platform-Koncepcio.md) — teljes koncepció
- [`AI-Agent-Platform-MVP-Terv.md`](AI-Agent-Platform-MVP-Terv.md) — MVP fejlesztési terv

## Futtatás

```bash
cd app
cp .env.example .env.local
npm install
npm run db:push
npm run db:seed
npm run dev
```

Nyisd meg: http://localhost:3000/control-plane

A repó gyökeréből: `npm run dev`, `npm run build`.

Részletes útmutató: [`app/README.md`](app/README.md)

## Deploy

Firebase App Hosting — a Next.js app az `app/` mappában fut (`firebase.json` → `rootDir: app`).

## Technológia

- Next.js 16 (App Router) + React 19 + TypeScript
- Postgres (Prisma) — Neon
- Clerk auth + RBAC
- Gemini Model Gateway

## Struktúra

```
app/src/
  domain/          # üzleti logika
  repositories/    # Postgres implementációk
  auth/            # AuthProvider absztrakció
  app/             # Next.js routes + server actions
  components/      # UI komponensek
```

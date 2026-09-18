# Enterprise AI Agent Platform

Enterprise MCP control plane (Next.js + Postgres). Phase 0 rebuild: the
legacy chat/runtime/dispatcher stack lives under `legacy/` and is not part of
the active application.

- **Control Plane** — IAM, agents, skills, connectors, audit
- **MCP Gateway** — tenant-scoped resource URL (Phase A)

See [`docs/architecture.md`](docs/architecture.md) and
[`docs/rebuild-surgery-manifest.md`](docs/rebuild-surgery-manifest.md).

## Dokumentáció

- [`AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md`](AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md) — historikus v1 fejlesztési spec és roadmap
- [`AI-Agent-Platform-Koncepcio.md`](AI-Agent-Platform-Koncepcio.md) — teljes koncepció
- [`AI-Agent-Platform-MVP-Terv-v1.0.md`](AI-Agent-Platform-MVP-Terv-v1.0.md) — historikus v1 terv

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

Firebase App Hosting — részletes útmutató: [`DEPLOY.md`](DEPLOY.md)

```bash
npm run deploy
```

## Technológia

- Next.js 16 (App Router) + React 19 + TypeScript
- Postgres (Prisma) — Neon
- Clerk auth + RBAC
- ChatGPT OAuth Model Gateway adapter
- Dispatcher harness launcher: lokális wiki runtime vagy Cloud Run Job

## Struktúra

```
app/src/
  domain/          # üzleti logika
  repositories/    # Postgres implementációk
  auth/            # AuthProvider absztrakció
  app/             # Next.js routes + server actions
  components/      # UI komponensek
```

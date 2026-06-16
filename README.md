# Enterprise AI Agent Platform

Kontrollált Enterprise AI Agent Platform — MVP walking skeleton (Next.js + Postgres).

- **Control Plane** — governance, board, ticketek, audit, agent registry
- **Sandbox** — wiki-agent tudásbázis, citált válaszok, A0 HTML riport preview/export

## Dokumentáció

- [`AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md`](AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md) — MVP fejlesztési spec és roadmap
- [`AI-Agent-Platform-Koncepcio.md`](AI-Agent-Platform-Koncepcio.md) — teljes koncepció
- [`AI-Agent-Platform-MVP-Terv-v1.0.md`](AI-Agent-Platform-MVP-Terv-v1.0.md) — MVP terv

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

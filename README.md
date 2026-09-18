# Enterprise AI Agent Platform

Enterprise MCP control plane (Next.js + Postgres). Codex and Claude Code talk
to a tenant-scoped Streamable HTTP resource at `/api/mcp/{tenantSlug}`.
Control Plane is IAM, agent definitions, skills, connectors, write approvals,
and a hash-chained audit log.

The legacy chat/runtime/dispatcher stack lives under `legacy/` as
**REFERENCE ONLY**. It is not compiled, typechecked, or imported from `app/`.
Phase F kept that tree on purpose.

- **Control Plane** — IAM, agents, skills, connectors, approvals, audit
- **MCP Gateway** — tenant-scoped resource URL

See [`docs/architecture.md`](docs/architecture.md) and
[`docs/rebuild-surgery-manifest.md`](docs/rebuild-surgery-manifest.md).
Harness steps: [`docs/mcp-compatibility-runbook.md`](docs/mcp-compatibility-runbook.md).

## Dokumentáció

- [`AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md`](AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md) — historikus v1 fejlesztési spec és roadmap
- [`AI-Agent-Platform-Koncepcio.md`](AI-Agent-Platform-Koncepcio.md) — teljes koncepció
- [`AI-Agent-Platform-MVP-Terv-v1.0.md`](AI-Agent-Platform-MVP-Terv-v1.0.md) — historikus v1 terv

## Futtatás

```bash
cd app
cp .env.example .env.local
npm install
npm run db:migrate
npm run db:seed
GOOGLE_DRIVE_API_STUB=true npm run dev
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
- Clerk auth + RBAC (MCP resource server; Clerk is the OAuth AS)
- Tenant-scoped MCP (`mcp-handler` + Clerk token verify)

## Struktúra

```
app/src/
  domain/          # üzleti logika (gateway-services composition root)
  repositories/    # Postgres implementációk
  auth/            # AuthProvider + MCP principal
  app/             # Next.js routes + server actions
  components/      # UI komponensek
legacy/            # REFERENCE ONLY — nem része az aktív TypeScript projektnek
```

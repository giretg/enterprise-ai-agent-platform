# perf/infra: dispatcher + agent runtime szétválasztása az UI Cloud Run szolgáltatástól

## Üzleti / UX hatás

Ugyanabban az 1 GiB-os, `concurrency: 40` Cloud Run konténerben fut a Next.js SSR, a percenkénti dispatch-ciklus (LLM-hívásokkal) és a hosszú életű chat SSE. Egy nehéz dispatch vagy chat-forduló **lassítja / OOM-olja az interaktív control-plane oldalakat**, és fordítva: UI spike-ok tolják el a ticket-feldolgozást. Ez közvetlen UX-degradáció és felesleges skálázási költség.

## Kontextus

- Hol: `app/src/app/api/v1/internal/dispatch-cycle/route.ts`, `app/src/app/api/v1/agent-chat/stream/route.ts`, `app/src/domain/dispatcher/run-dispatch-cycle.ts`
- Van már deploy script: `app/infra/gcp/deploy-dispatcher-service.sh`
- Kapcsolódó: `docs/perf/optimization-plan.md` (P1 architektúra)

## Javasolt megoldás

1. Dedikált Cloud Run szolgáltatás a dispatcher/workernek (scheduler → dispatcher service).
2. UI szolgáltatás thin marad: SSR + rövid API-k; hosszú LLM/chat runtime lehetőség szerint ugyanezen vagy külön „runtime” szolgáltatásra.
3. Shared secret / internal auth változatlan belépési pontokkal (`/api/v1/internal/dispatch-cycle`).
4. Observability: külön memory/CPU metrikák, hogy az UI p95 ne keveredjen a worker terheléssel.
5. Rollback-terv: feature-flag vagy traffic split a scheduler targetjén.

## Elfogadási kritériumok

- [ ] Cloud Scheduler a dispatcher service-t hívja, nem az UI-t.
- [ ] UI p95 latency nem romlik dispatch-ciklus alatt (baseline vs új).
- [ ] Ticket dispatch / monitor / channel-turn funkciók változatlanul működnek.
- [ ] Deploy dokumentáció frissül (`DEPLOY.md` / infra README).

## Becsült méret

L / több nap (ops + kód)

## Címkék (javasolt)

`perf`, `infra`, `cloud-run`, `dispatcher`

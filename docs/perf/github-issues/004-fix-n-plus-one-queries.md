# perf: N+1 / szekvenciális DB-hurkok megszüntetése

> **Státusz: implementálva** (2026-07-26) — batch repository helper-ek + hot path átvezetés;
> regresszió: `npm run test:n-plus-one-batch` (+ playbook registry / process-def).

## Üzleti / UX hatás

Több képernyő és szolgáltatás **ciklusban lő egyedi lekérdezéseket** (playbook indítható lista, suitable agents, tenant lookup, skill betöltés). Kis adaton nem látszik; közepes tenanteknél a control-plane „rángatózik”, a request latency és a connection-pool nyomás nő.

## Kontextus

| Hol | Minta |
|-----|--------|
| `playbook-v2-service.ts` startable list | per-playbook `findDefaultAssignment` → `findDefaultAssignments` |
| `tool-broker-delegation.ts` web egress | per agent 2 capability query → `findCapabilitiesForAgents` |
| `process-definition-list/builder` | szekvenciális `listSuitableAgents` → `listSuitableAgentsForVersion` |
| `process-definition-service.ts` | per-permission / per-user → `findByKeys` + `findManyByIds` |
| tenant switcher | `Promise.all(ids.map(findById))` → `findByIds` |
| `skill-service.ts` preload | szekvenciális `loadSkillForAgent` → `findVersionsByIds` |
| `connector-grant-service.ts` | szekvenciális revoke → `Promise.all` |
| document load (chat/task) | N×`findById` → `findByIds` |

Kapcsolódó: `docs/perf/optimization-plan.md` medium batch.

## Javasolt megoldás

1. Batch repository metódusok: `findDefaultAssignments(tenantId, processTypes[])`, `findByIds(ids)`, capability map egy queryben.
2. UI: egy szerver action összesített válasszal (`listSuitableAgentsForVersion`).
3. Skill / grant: ahol sorrend nem kötelező, párhuzamosítás vagy egy SQL `IN` lista.
4. Előtte/utána: requestenkénti query-szám log (Prisma middleware vagy rövid mérő).

## Elfogadási kritériumok

- [x] Startable playbook lista és process-definition suitable-agent path nem N× DB round-trip.
- [x] Tenant `findByIds` batch helper a map-os `findById` helyett.
- [x] Nincs funkcionális regresszió a playbook / process / skill acceptance teszteken.

## Becsült méret

M / 1–3 nap

## Címkék (javasolt)

`perf`, `database`, `n-plus-one`

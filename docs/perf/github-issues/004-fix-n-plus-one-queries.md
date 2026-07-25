# perf: N+1 / szekvenciális DB-hurkok megszüntetése

## Üzleti / UX hatás

Több képernyő és szolgáltatás **ciklusban lő egyedi lekérdezéseket** (playbook indítható lista, suitable agents, tenant lookup, skill betöltés). Kis adaton nem látszik; közepes tenanteknél a control-plane „rángatózik”, a request latency és a connection-pool nyomás nő.

## Kontextus

| Hol | Minta |
|-----|--------|
| `playbook-v2-service.ts` startable list | per-playbook `findDefaultAssignment` |
| `tool-broker-delegation.ts` web egress | per agent 2 capability query |
| `process-definition-list.tsx` | szekvenciális `listSuitableAgents` szerepenként |
| `process-definition-service.ts` | per-permission `findByKey` |
| tenant helper | `Promise.all(ids.map(findById))` helyett `id in (...)` |
| `skill-service.ts` | szekvenciális `loadSkillForAgent` |
| `connector-grant-service.ts` | szekvenciális revoke + audit (batch revoke path) |

Kapcsolódó: `docs/perf/optimization-plan.md` medium batch.

## Javasolt megoldás

1. Batch repository metódusok: `findDefaultAssignments(tenantId, processTypes[])`, `findByIds(ids)`, capability map egy queryben.
2. UI: `Promise.all` a suitable-agent hívásokra ahol függetlenek; még jobb: egy szerver action összesített válasszal.
3. Skill / grant: ahol sorrend nem kötelező, párhuzamosítás vagy egy SQL `IN` lista.
4. Előtte/utána: requestenkénti query-szám log (Prisma middleware vagy rövid mérő).

## Elfogadási kritériumok

- [ ] Startable playbook lista és process-definition suitable-agent path nem N× DB round-trip.
- [ ] Tenant `findByIds` batch helper a map-os `findById` helyett.
- [ ] Nincs funkcionális regresszió a playbook / process / skill acceptance teszteken.

## Becsült méret

M / 1–3 nap

## Címkék (javasolt)

`perf`, `database`, `n-plus-one`

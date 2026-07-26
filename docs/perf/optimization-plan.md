# Platform-szintű optimalizálási terv

> Kiindulás: `docs/perf/agent-detail-follow-up.md` (agent detail oldal 1–5 fix kész).
> Ez a dokumentum kiterjeszti a vizsgálatot az egész alkalmazásra, mert a detail-oldal
> lassulása **tünet** volt, nem ok.

## Összefoglaló

A follow-up dokumentum 6–19-es pontjai mind valós javítások, de együtt sem magyarázzák
a tapasztalt viselkedést (OOM 1 GiB mellett, Neon connection pool kimerülés, több
másodperces oldalbetöltés üres adatbázison). A tényleges ok a Prisma-kliens
életciklusában volt, egy szinttel a lekérdezés-optimalizálás alatt.

---

## P0 — Prisma-kliens szivárgás (JAVÍTVA, 2026-07-10)

**Hol:** `app/src/lib/db.ts`

A `prisma` export egy Proxy, amelynek `get` trapje **minden property-hozzáférésnél**
meghívta a `resolvePrismaClient()` → `getOrCreateClient(mode)` láncot. A cache-be írás
viszont `if (process.env.NODE_ENV !== 'production')` mögé volt zárva:

```ts
const client = createPrismaClientForUrl(databaseUrlForMode(mode))
if (process.env.NODE_ENV !== 'production') {
  cache[mode] = client   // ← prod: SOHA nem kerül a cache-be
}
return client
```

Következmény élesben:

- minden `prisma.<model>` hozzáférés **új `PrismaClient`-et** példányosított,
  saját Rust query engine-nel és saját connection poollal;
- `$disconnect()` a kódbázisban sehol nem hívódott, így ezek a poolok a kérés
  végén sem záródtak;
- egy agent detail oldalbetöltés nagyságrendileg 30 lekérdezés → ~30 kliens;
  `concurrency: 40` mellett kérésenként szorzódva.

Ez egyszerre magyarázza a memóriaprofilt (`memoryMiB: 1024` → OOM), a Neon
connection-kimerülést, és a lekérdezésenkénti engine-indítás miatti látencia-alapzajt.

**Reprodukció:** `NODE_ENV=production` alatt 30 property-access → 30 példány.
**Javítás után:** ugyanaz a 30 access → 1 példány, módonként cache-elve
(`prismaByMode` — a rekord alakja eleve ezt a szándékot kódolta).

A javítás a `NODE_ENV` guardot eltávolítja a cache-írásból, és a dev-HMR miatti
lecserélésnél a régi klienst lezárja (`$disconnect`).

### Mellékhatás: `$transaction([...])` atomicitás

Hét helyen fut batch-tranzakció (`agent-repository.ts:274`, `:323`, `:498`, `:590`,
`:639`, `behavior-profile-repository.ts:37`, `sandbox-app-repository.ts:101`), pl.:

```ts
await prisma.$transaction([
  prisma.agentVersion.create({ ... }),   // ← más kliens, más engine
  prisma.agent.update({ ... }),          // ← megint más
])
```

A javítás előtt élesben a `$transaction` és a benne átadott `PrismaPromise`-ok
**különböző engine-ekhez** tartoztak. A batch-tranzakció engine-lokális `txId`-vel
dolgozik, így az atomicitás nem volt garantált. Ezt élesben nem figyeltem meg,
csak a kódból következik — **verifikálandó**, hogy okozott-e adatinkonzisztenciát
(pl. `AgentVersion` sor `Agent.currentVersion` bump nélkül). A P0 javítás a
kockázatot megszünteti.

---

## P0b — A 2026-07-10 13:01-es 500-as incidens (JAVÍTVA)

Tünet: `GET /control-plane` → 500, 5.493 s, majd
`PrismaClientInitializationError: Can't reach database server at ep-divine-sunset-…-pooler`,
végül `⨯ unhandledRejection`.

**Nem a Neon halt meg.** A Secret Managerben lévő prod `DATABASE_URL`-lel a
`select 1` innen hibátlanul lefut, a host DNS-e és a TCP/5432 is rendben. A
`5.493 s` gyakorlatilag pontosan a Prisma alapértelmezett 5 s-es `connect_timeout`-ja,
ami kapcsolat-kiéheztetésre utal — összhangban a P0 szivárgással.

A `db.ts` viszont bármilyen átmeneti DB-hibát **önerősítő összeomlássá** alakított.
Három egymást erősítő hiba, mindhárom javítva:

1. **Gazdátlan promise.** A proxy `get` trapje `void ensureActiveDatabaseMode()`-ot
   hívott `.catch()` nélkül. DB-kiesés alatt ez property-access-enként egy elkapatlan
   rejectet szült → `unhandledRejection`, ami a konténert is elviheti.
   → `.catch(() => {})`; a valódi hiba úgyis a lekérdezés hívójánál jelenik meg.

2. **Retry-vihar.** A `refreshActiveDatabaseMode` csak **sikeres** olvasás után
   frissítette a `lastRefreshAt`-et. Hiba esetén a 15 s-es TTL sosem nyílt meg, így
   minden `prisma.<model>` hozzáférés új `platformSetting.findUnique()`-et lőtt ki a
   már elérhetetlen adatbázisra — a P0 szivárgás miatt mindegyiket **saját új
   kliensről**. Mért hatás: 50 hívás → 50 lekérdezés; javítás után 50 hívás → **1**.
   → `lastRefreshAt` a `finally` ágba került; a mód az utolsó ismert értéken marad.

3. **Pool-méret.** A P0 javítás után egyetlen megosztott kliens van, és a Prisma
   alapértelmezése `num_cpus * 2 + 1` — Cloud Runon `cpu: 1` mellett **3 kapcsolat**,
   `concurrency: 40` mellett. Ez a szivárgás megszüntetése után pool-timeoutot okozott
   volna, tehát a P0 önmagában nem lett volna elég.
   → `applyPoolDefaults()` a `createPrismaClientForUrl`-ben:
   `connection_limit=10` (env-ből felülírható), `pool_timeout=20`, `connect_timeout=10`.
   A connection stringben már megadott értéket sosem írja felül.

A javítások a kódban vannak, a `DATABASE_URL` secretet **nem kell** hozzányúlni.

---

## P1 — Olvasási útvonalon írás — **JAVÍTVA**

**Hol:** `app/src/lib/agent-delegated-connectors-server.ts`

A `revokeGrantsForNonActiveConnectors` kikerült az agent detail / chat panel
olvasási útvonaláról. A stale grant takarítás a connectors panel listázásakor
marad (`listConnectorsPanelContext` / `listMyConnectorGrants`). Az UI továbbra
is kiszűri az inaktív grant-eket megjelenítéskor.

---

## P1 — Memória-overview lekérdezések — **JAVÍTVA**

**Hol:** `app/src/lib/agent-detail-page-data.ts`, `memory-repository.ts`, `platform.ts`

- `listByRun` bővült `projectKey` + `statuses` szűrővel → 3 query → 1
- `loadMemoryProjectKeys` egyetlen `UNION ALL` raw query

---

## P1 — Dashboard / governance aggregációk — **JAVÍTVA**

**Hol:** `audit-repository.ts`, `tool-broker-repository.ts`, `ticket-repository.ts`

`getCostSummary`, `getGovernanceSummary`, `getPerTicketBreakdown`, `getToolSummary`,
`getTransitionStats` DB-oldali `aggregate` / `groupBy` — nem tölti be az összes sort
Node-ba. Indexek: `0018_hot_path_indexes` (`model_calls`, `tool_calls`, `documents`).

---

## P1 — KB / sandbox over-fetch — **JAVÍTVA**

- KB lista (`findByConnectorId`): `extractedText` nélkül
- `kbSearch`: batch `findDocumentsForConnectors` + superseded kizárás + `take: 200`
- Sandbox lista: csak az aktív verzió, nem az összes verziótörténet
- Sandbox registry metrics: `groupBy` a teljes app-lista helyett

---

## P1 — Architektúra: az UI konténer futtatja az agent runtime-ot

**Hol:** `app/src/app/api/v1/internal/dispatch-cycle/route.ts`,
`app/src/app/api/v1/agent-chat/stream/route.ts`

Ugyanabban az 1 GiB-os, `concurrency: 40`-es Cloud Run konténerben fut:

1. a Next.js SSR/RSC oldalrenderelés,
2. a Cloud Scheduler által percenként hívott teljes dispatch-ciklus
   (`runDispatchCycle` — stale-reclaim, monitor-söprés, ticket-dispatch, LLM-hívások),
3. a hosszú életű chat SSE streamek (`runtime = 'nodejs'`).

Egy oldalbetöltés így egy párhuzamosan futó agent-forduló memória- és CPU-nyomása
alatt szolgál ki. A P0 javítás után is igaz, hogy egy nehéz dispatch-ciklus
degradálja az interaktív útvonalat.

**Javaslat:** a dispatcher és az agent runtime külön szolgáltatásba (a `wiki-dispatcher`
mintája szerint), az UI konténer thin marad. A `/api/v1/internal/dispatch-cycle`
végpont változatlanul megmaradhat belépési pontnak, csak nem az UI backendjén.

**Sorrend:** ezt a P0 mérési eredménye után érdemes eldönteni — lehet, hogy a
memóriaprofil P0 után önmagában is a cél alá kerül, és a szétválasztás
prioritása csökken.

---

## P1 — `findByIdWithDetails` szétbontása — **JAVÍTVA**

**Hol:** `app/src/repositories/postgres/agent-repository.ts`

- `findByIdForRuntime` — agent + aktuális memória (nincs `versions` lista, apiKeys, resources, recipe)
- `findByIdForDisplay` — UI detail (resources, recipe, apiKeyPreview, behavior profile)
- `findByIdWithDetails` kompat alias → display
- Hot path (chat / general-task / bookkeeper / `kb_search`) → runtime; detail / wiki / katalógus → display

---

## P2 — Kérés-szintű overfetch (a follow-up doc 10–15)

Változatlanul érvényes, de a P0 után jóval kisebb a nyereség:

| # | Tétel | Megjegyzés |
|---|-------|-----------|
| 10 | Olvasás Route Handlerbe, HTTP cache | `GET /api/v1/agents/[id]/detail?sections=` |
| 11 | `getModelPolicy`, `listBehaviorProfiles` → `unstable_cache` 60–300s | ritkán változó |
| 12 | `WebSearchPolicyCard` waterfall beemelése az aggregátorba | admin blokk |
| 13 | Control-plane layout server wrapper + `TenantSwitcher` SSR | ma teljes layout `'use client'` |
| 14 | `revalidatePath` a platform-mutációkban | `router.refresh()` helyett |
| 15 | Chat panel: delegated connectors + skills SSR propsból | ma mountkor újra fetch |

## P3 — Alacsony prioritás

- Tab-alapú lazy load az agent oldalon (Áttekintés / Admin / Memória).
- `x-request-id` propagálás a kliensre (`app/error.tsx` ma csak `error.digest`).
- Cloud Run finomhangolás (`memoryMiB`, `concurrency`) — **csak a P0/P1 mérése után**;
  a P0 előtt ez tünetkezelés lett volna egy szivárgásra.

---

## Mérés

A P0 deploy után, döntés előtt a P1-ekről:

1. Cloud Run memória-csúcs idle UI-terhelésnél — várakozás: nagyságrendi esés,
   cél < 512 MiB.
2. Neon `pg_stat_activity` egyidejű kapcsolatszám csúcs — cél: példányonként
   a `connection_limit` alatt.
3. Agent detail GET p95 — cél < 2s üres DB-vel.
4. `$transaction` érintette táblák konzisztencia-ellenőrzése (lásd P0 mellékhatás).

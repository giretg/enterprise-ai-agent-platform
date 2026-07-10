# Agent detail / control plane — performance follow-up

> Státusz: az 1–5-ös gyors fixek implementálva (2026-07-10). A lenti pontok még nyitottak.
>
> **Lásd előbb:** `docs/perf/optimization-plan.md` — a lassulás fő oka egy Prisma-kliens
> szivárgás volt (`lib/db.ts`), nem az itt listázott lekérdezés-minták. A 6–19-es pontok
> prioritása ennek fényében újrarendezve.

## Elkészült (1–5)

1. **`React.cache` auth deduplikáció** — `getAuthContext`, `getCurrentUser`, tenant `findById` request-szinten cache-elve.
2. **Clerk sync conditional write** — `syncClerkUser` csak akkor ír DB-be, ha email/name/role tényleg változott.
3. **Szerepkör-gate SSR** — admin/operator fetch csak a megfelelő szerepkörnek fut.
4. **`getAgentDetailPageData` aggregátor** — egy auth stack, deduplikált governance/skills lekérdezések (`lib/agent-detail-page-data.ts`).
5. **MemoryPanel + KB Panel SSR** — kezdeti adat props-ból, mount POST-ok megszűntek.

### Viselkedés-változás a #3/#4 mellékhatásaként

A szerepkör-gate forrása a legacy globális `User.role`-ról az **aktív tenant-szerepre**
(`ctx.activeTenantRole`) váltott. Ez nem kozmetika: az aggregátor közvetlenül hívja a
repository/service réteget, megkerülve a korábbi per-action `requireTenantRole` kapukat,
így az `isAdmin`/`canManageKb` lett az egyetlen authorizációs határ ezekre a lekérdezésekre.
A tenant-szerep egyébként is a dokumentált igazságforrás (`auth/tenant-context.ts` §5.4).

Kihat: multi-tenant tag (A-ban admin, B-ben viewer) és superadmin assume-mód. Egytenantos
esetben azonos, mert a `legacyFallbackMembership` a `User.role`-ból szintetizálja a membershipet.

---

## Következő lépések (prioritás szerint)

### Magas impact

#### 6. `revokeGrantsForNonActiveConnectors` kivitele page loadról
- **Hol:** `lib/agent-delegated-connectors-server.ts` — minden `loadAgentDelegatedConnectors` hívásnál fut.
- **Probléma:** olvasási útvonalon írás (grant revoke), lassít + felesleges DB terhelés.
- **Javaslat:** háttér job, connectors oldal, vagy lazy (csak connectors panel megnyitásakor).

#### 7. Agent runtime külön service-be
- **Probléma:** LLM (`model.call`), dispatch és UI ugyanabban a Cloud Run konténerben → OOM 1 GB mellett.
- **Javaslat:** agent runtime / model gateway a dispatcher worker mintájára külön szolgáltatás; a UI konténer thin marad.

#### 8. Memory overview query optimalizálás
- **Hol:** `getAgentMemoryOverview` / `loadMemoryOverview` — `listByRun` nem szűr `projectKey`-re DB-ben.
- **Javaslat:** composite index + DB-szintű filter; `listAgentMemoryProjectKeys` egy aggregált query.

#### 9. `findByIdWithDetails` szétbontása
- **Hol:** `repositories/postgres/agent-repository.ts`
- **Probléma:** `memory.versions take: 5` felesleges a detail oldalon; admin-only mezők mindenkinél betöltődnek.
- **Javaslat:** `findByIdForDisplay` vs `findByIdForAdmin`.

### Közepes impact

#### 10. Olvasás: Server Actions → Route Handlers
- **Probléma:** minden olvasás POST a page URL-re, nincs HTTP cache.
- **Javaslat:** `GET /api/v1/agents/[id]/detail?sections=...` + `cache()` / `revalidateTag`.

#### 11. Ritka adatok cache-elése
- `getModelPolicy`, `listBehaviorProfiles` → `unstable_cache` 60–300s TTL.
- Tenant auth kontextus már cache-elt; platform settings még nem.

#### 12. `WebSearchPolicyCard` waterfall megszüntetése
- **Hol:** `components/agents/web-search-policy-card.tsx` — governance után szekvenciális `getAgentWebSearchCalls`.
- **Javaslat:** beemelni a `loadAgentDetailPageData`-ba (admin blokk).

#### 13. Control plane layout: server wrapper + TenantSwitcher SSR
- **Hol:** `control-plane/layout.tsx` — teljes layout `'use client'`.
- **Probléma:** `TenantSwitcher` minden navigáción `getTenantSwitcherState` POST-ot küld.
- **Javaslat:** server layout wrapper, tenant lista SSR-ből.

#### 14. `revalidatePath` platform mutációkra
- **Hol:** `app/actions/platform.ts` — form submit után gyakori `router.refresh()`.
- **Javaslat:** `revalidatePath('/control-plane/agents/[id]')` a mutációkban (skills.ts mintája).

#### 15. Chat panel: delegated connectors + skills SSR props-ból
- **Hol:** `agent-chat-panel.tsx` — chat megnyitáskor újra fetch-eli az SSR-en már betöltött adatokat.

### Alacsonyabb priority

#### 16. Indexek
- Memory chunk/candidate: `(memoryId, projectKey, status)` composite indexek.

#### 17. Tab-alapú lazy load az agent oldalon
- Áttekintés / Admin / Memória külön szekcióként, kattintásra töltve.

#### 18. 503 / hálózati hibánál request ID megjelenítés
- **Hol:** `app/error.tsx` — jelenleg csak `error.digest`; infra hibánál üres.
- **Javaslat:** `x-request-id` header propagálás kliensre.

#### 19. Cloud Run erőforrás finomhangolás (ha runtime szétválasztás után is kell)
- `memoryMiB: 2048`, `concurrency: 10–20` — csak tünetkezelés, nem helyettesíti a fenti refaktort.

#### ~~20. Control-plane oldalak szerepkör-forrás egységesítése~~ — KÉSZ (2026-07-10)
12 page (`agents`, `agents/[agentId]`, `skills`, `playbooks{,/[id]}`, `monitors{,/new,/[id]}`,
`board`, `processes{,/[id]}`, `behavior-profiles`, `tickets/[id]`) átállt
`getCurrentUser()` + `hasMinimumRole(user.role, …)` → `getAuthContext()` + `ctx?.activeTenantRole`
párosra. Ezzel a capability-gate mindenhol ugyanarra a szerepre dönt, mint a `requireTenantRole`
a server actionökben.

Szándékosan a legacy `User.role`-on maradt `control-plane/page.tsx` és `control-plane/pending/page.tsx`:
ezek nem capability-gate-et csinálnak, hanem az onboarding-állapotot nézik (`!me.role` ⇒ „még nincs
kiosztva szerep" ⇒ pending nézet), ami definíció szerint tenant-független.

---

## Ismert anti-pattern katalógus (referencia)

| Anti-pattern | Hol |
|-------------|-----|
| Szerepkör-független SSR overfetch | ~~`page.tsx`~~ → javítva aggregátorral |
| 9× duplikált auth stack | ~~minden action~~ → `React.cache` |
| Connector triple-fetch | governance + delegated + chat — részben javítva |
| Capability triple-fetch | governance + skills — javítva aggregátorban |
| SSR után client re-fetch | Memory/KB javítva; chat még nyitva |
| Read path write side-effect | delegated connectors revoke — nyitva |
| Nincs cache platform settings-re | nyitva |
| Control-plane layout client-only | nyitva |

---

## Mérési javaslat deploy után

1. Agent detail GET idő (Cloud Run log) — cél: < 2s üres DB-vel.
2. POST szám page loadonként — cél: 0–1 (csak TenantSwitcher, amíg #13 nincs kész).
3. Cloud Run memória csúcs — cél: < 512 MiB idle UI loadnál.

# perf: N+1 / szekvenciális DB-hurkok megszüntetése

> GitHub: #116 · triage: `ready-for-agent` · forrás: `docs/perf/github-issues/004-fix-n-plus-one-queries.md`

## Problem Statement

Több control-plane képernyő és szolgáltatás **ciklusban egyedi adatbázis-lekérdezéseket** lő: indítható playbook lista, suitable agent feloldás, tenant switcher, skill preload, web-egress agent keresés, connector-grant batch revoke. Kis tenantnél ez nem látszik; közepes méretnél a control-plane „rángatózik”, a request latency és a connection-pool nyomás nő — ugyanarra a funkcionális eredményre N× round-trip megy, holott egy (vagy kevés) batch lekérdezés elég lenne.

## Solution

A hotspotokon **batch repository / összesített server-action** útvonalakat vezetünk be (SQL `IN` / egy query → map), és ahol a UI szerepenként szekvenciálisan hív, ott egy összesített választ vagy legalább párhuzamos független hívásokat használunk. A funkcionális viselkedés változatlan; a megfigyelhető változás a **kevesebb DB round-trip** ugyanarra a kimenetre. A regresszió ellen a meglévő playbook / process / skill acceptance tesztek, valamint a service/action seam instrumentált repository fake-jeinek hívásszám-assertjei védenek.

## User Stories

1. As a tenant admin, I want the startable playbook list to load without one DB round-trip per playbook, so that the processes page stays responsive as the catalog grows.
2. As a tenant admin, I want startable playbooks to still show only active process-type defaults with published versions, so that batching does not change which playbooks I can start.
3. As a process designer, I want suitable agents for every agent role on a process definition to resolve without a sequential waterfall of role calls, so that the definition list and builder open quickly.
4. As a process designer, I want suitable-agent results to remain role-keyed and capability-correct, so that I still bind the right agents to roles.
5. As a process designer, I want activation-gate permission checks to avoid one lookup per required permission, so that publishing/activating a definition does not scale with permission list length.
6. As a process designer, I want activation-gate violations to stay semantically identical after batching, so that unsafe bindings are still blocked.
7. As a platform user with multiple tenant memberships, I want the tenant switcher to load my tenants in one batch lookup, so that switching tenants does not fan out N unique queries.
8. As a superadmin, I want the existing full-tenant list path to keep working unchanged, so that batch `findByIds` does not regress the superadmin switcher.
9. As a chat/task user, I want slash-preloaded skills to load without reloading the assignment index and version once per skill, so that multi-skill turns stay fast.
10. As a chat/task user, I want preloaded skill content and audit semantics to remain correct, so that batching does not drop skills or skip audit where required.
11. As a platform operator, I want web-egress agent resolution to avoid two capability queries per candidate agent, so that delegated web search/fetch picks an agent with fewer round-trips.
12. As a platform operator, I want the first suitable active agent with both `web_search` and `web_fetch` still to win, so that egress behavior stays the same.
13. As a security/admin actor, I want batch connector-grant revoke paths to stop issuing one full revoke+audit cycle per grant when a bulk path is intentional, so that connector teardown and user-wide revoke finish under pool pressure.
14. As an auditor, I want revoke outcomes and audit trail coverage to remain trustworthy after bulk revoke optimization, so that we do not trade correctness for speed.
15. As a platform developer, I want new batch readers on repositories (`findDefaultAssignments`, tenant `findByIds`, multi-agent capability map, skill version `findByIds` / keyed permission map) to follow the existing `findManyByIds` / `findDocumentsForConnectors` pattern, so that the data layer stays consistent.
16. As a platform developer, I want callers to prefer batch helpers over `Promise.all(ids.map(findById))`, so that parallelism alone is not mistaken for fixing N+1.
17. As a platform developer, I want the process UI to prefer one aggregated suitable-agents server action over N role round-trips, so that the browser does not serialize independent work.
18. As a platform developer, I want existing playbook v2 startable acceptance coverage to keep passing, so that batch assignment lookup cannot silently change startability.
19. As a platform developer, I want process-definition activation-gate acceptance coverage to keep passing, so that permission and suitability gates stay correct.
20. As a platform developer, I want skill catalog / preload-related acceptance coverage to keep passing, so that skill loading regressions are caught.
21. As a platform developer, I want tests at the service/action seam to assert repository call counts stay O(1) (or a small fixed constant) vs input size, so that N+1 cannot return unnoticed.
22. As a platform operator, I want control-plane latency and Neon pool pressure to drop on these paths under medium tenant size, so that interactive admin work stays usable.
23. As a platform developer, I want empty-id / empty-key batch helpers to short-circuit without a query, so that edge cases do not pay a useless round-trip.
24. As a platform developer, I want batch results to preserve tenant scoping of the original single-row lookups, so that cross-tenant leakage cannot appear via `IN` lists.
25. As a platform developer, I want the suitable-agents API route (if still used) to stop per-agent sequential capability loads where the action already batches better, so that HTTP and action paths do not diverge in cost.
26. As a platform developer, I want grant bulk revoke to remain ordered only where audit/SoD requires it; otherwise parallelize or `updateMany` + batched audit, so that we do not serialize without reason.
27. As a platform developer, I want optional request-level query-count diagnostics (middleware or short meter) to remain optional and not block the functional fix, so that we can measure before/after without coupling prod metering to the acceptance seam.
28. As a tenant admin, I want no functional regression on playbook start, process binding, skill slash-load, tenant switch, or grant revoke flows, so that the perf work is invisible except for speed.
29. As a platform developer, I want prior-art batch refactors (`listByRun` status batching, `findDocumentsForConnectors`, user `findManyByIds`) to be the template for new helpers, so that review stays predictable.
30. As a platform developer, I want out-of-scope items (dispatcher split, `findByIdWithDetails` split, unbounded list pagination) left alone, so that this change stays an M-sized N+1 sweep.

## Implementation Decisions

- **Egy teszt-seam: domain service / server action + instrumentált repository fake.** A megfigyelhető egység a publikus service/action kimenet (ugyanaz a funkcionális eredmény), plusz a fake repository hívásszáma a bemenet méretéhez képest. Nem a Prisma middleware a fő acceptance seam.

- **Batch a repository rétegen, nem „párhuzamos N+1”.** `Promise.all` egyedi `findById` / `findUnique` hívásokkal nem megoldás, ha egy `where: { id: { in: ids } }` (vagy ekvivalens) elég. Prior art: user `findManyByIds`, `findDocumentsForConnectors`, memory `listByRun` statuses szűrő.

- **Startable playbooks.** `listStartablePlaybooks` a per-playbook `findDefaultAssignment` helyett egy batch assignment reader-t hív (`findDefaultAssignments(tenantId, processTypes[])` vagy ekvivalens), majd memóriában párosít process type → default assignment. Üres process-type lista → nincs query.

- **Suitable agents UI.** A process-definition list és builder szerepenkénti szekvenciális `listSuitableAgents` hívásait kiváltjuk: preferáltan **egy összesített server action** (playbook version → roleKey → suitable agents map); minimum elfogadható átmenet: független role-hívások `Promise.all`-lal. A capability betöltés multi-agent batch map legyen, ne agentenkénti szekvenciális `findCapabilitiesForAgent` az API route-on.

- **Activation gate permissions.** A human role `requiredPermissions` loop ne hívjon per-key `findByKey`-t. Használjon meglévő `findAll` + in-memory map-et, vagy `findByKeys(keys[])` batch-et. Az agent-kötés ellenőrzés (`checkBoundAgent`) szintén ne N× egyedi capability round-trip legyen, ha batch map elérhető.

- **Tenant switcher.** `getTenantSwitcherState` membership tenant id-kra `tenants.findByIds(ids)` (vagy `findMany` `id in`), a user-réteg `findManyByIds` mintájára. Superadmin ág marad a meglévő teljes `findMany`.

- **Skill preload.** `preloadSkillsByVersionIds` ne hívja újra skillenként a teljes `loadSkillForAgent` útvonalat assignment-index újratöltéssel. Az index egyszer töltődik; a skill version-ök batch `findVersionsByIds` (vagy ekvivalens); audit megmarad, de nem kötelező skillenként új index round-trip. Ahol a sorrend audit miatt kötött, a DB olvasás akkor is batch-elhető.

- **Web egress agent.** `resolveWebEgressAgent` ne agentenként 2× `findCapability`-t lőjön. Egy (vagy kevés) capability map query az aktív candidate agent id-kra a `web_search` / `web_fetch` toolnevekre; az early-return szemantika (első megfelelő aktív agent) megmarad.

- **Connector grant batch revoke.** A `revokeActiveGrantsForConnector` / `revokeGrantsForNonActiveConnectors` / service-szintű `revokeAllForUser` path ne N× teljes `revokeGrant` round-trip legyen, ha tömeges revoke a szándék. Preferált: státusz batch update + audit lefedettség megőrzése (batched vagy összesített audit esemény, ha a meglévő audit modell engedi; ha nem, minimalizált per-grant audit írás audit batch helper nélkül is jobb, mint teljes per-grant load+token+update lánc felesleges újratöltéssel). A repo `revokeAllForUser` `updateMany` prior art; audit nélküli csendes revoke nem elfogadható ott, ahol ma van audit.

- **Tenant / id scoping.** Minden batch reader megtartja a single-row helper tenant- és jogosultság-korlátait; az `IN` lista nem szélesíti a láthatóságot.

- **Nincs sémamigráció.** Ez olvasási/írási batching a meglévő táblákon; új Prisma modellek és migrációk nem kellenek, kivéve ha később index hiány derülne ki (akkor külön, mérhető indokkal).

- **Opcionális query-szám diagnosztika.** Prisma middleware vagy rövid request meter az előtte/utána méréshez **opcionális** és nem feltétele az elfogadásnak; a kötelező bizonyíték a seam call-count assert + meglévő acceptance.

- **Érintett modulok (fogalmi).** Playbook v2 service + assignment repository; process definition UI + suitable-agents action/API; process-definition activation gate + role-permission olvasás; tenant actions + tenant repository; skill service + skill repository; tool-broker delegation (web egress) + tool capability repository; connector-grant service (+ grant/audit repository batch helpers ahol kell).

## Testing Decisions

- **Mi a jó teszt.** Csak külső viselkedés: ugyanaz a funkcionális kimenet (startable lista, suitable map, gate violations, tenant lista, preloaded skills, egress agent választás, revoke eredmény), plusz a repository fake **hívásszáma** ne nőjön lineárisan a bemenet méretével. Nem assertálunk belső private helper neveket vagy SQL szövegét.

- **Tesztelt seam.** Domain service / server action publikus API + injektált repository fake-ek (call-count). Idealiban egy mintázat minden hotspoton.

- **Prior art.**
  - Playbook v2 startable acceptance a registry tesztekben (fake `findDefaultAssignment` — batch után fake `findDefaultAssignments`).
  - Process definition `runActivationGate` acceptance (permission stub — batch/map után ugyanaz a violation szemantika).
  - Skill catalog / slash preload kapcsolódó script tesztek.
  - Korábbi perf batchok kommentjei és acceptance: memory `listByRun` statuses, KB `findDocumentsForConnectors`.

- **Kötelező regresszió-háló.** Playbook / process / skill acceptance suite-ok zöldek maradnak. Új vagy kiegészített tesztek: N bemenetre (pl. több process type / több role / több tenant id / több skill version) a batch reader **egyszer** (vagy fix kis konstansszor) hívódik.

- **Nem kötelező.** Prod Prisma query-count middleware; e2e böngészős latency assert; Cloud Run / Neon terheléses mérés (hasznos manuális ellenőrzés, nem CI kapu ebben a specben).

## Out of Scope

- Dispatcher / UI Cloud Run szétválasztás.
- `findByIdWithDetails` runtime vs display szétbontás.
- Unbounded listák paginálása.
- Control-plane layout SSR / `unstable_cache` / Route Handler HTTP cache (optimization-plan P2).
- Új DB séma vagy általános „DataLoader” keretrendszer bevezetése az egész appra.
- Audit modell újratervezése (csak annyi audit-batching, amennyi a grant revoke helyes lefedettségéhez kell).
- Kötelező prod query-count middleware bevezetése.

## Further Notes

- Becsült méret: **M / 1–3 nap**.
- Kapcsolódó háttér: `docs/perf/optimization-plan.md`, draft `docs/perf/github-issues/004-fix-n-plus-one-queries.md`.
- A P0 Prisma kliens-szivárgás már javítva; ez a munka a **maradék N+1 / szekvenciális hurkok** medium batchja, nem a kliens életciklus.
- Elfogadási kritériumok (összefoglalva):
  1. Startable playbook lista és process-definition suitable-agent path nem N× DB round-trip.
  2. Tenant `findByIds` (vagy ekvivalens) a map-os `findById` helyett.
  3. Nincs funkcionális regresszió a playbook / process / skill acceptance teszteken.
  4. Service/action seam call-count assert(ek) rögzítik, hogy a hotspotok nem nőnek lineárisan a bemenettel.

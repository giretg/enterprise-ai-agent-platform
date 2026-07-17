# Enterprise code review log

## 2026-07-18 - Write-gate token: egyszer-használatos fogyasztás atomizálása

- Áttekintett modulok:
  - `app/src/domain/writegate/write-gate-service.ts` (a governance write-gate primitív: `issue` / `consume`, horgony-invariáns, TTL, státusz-életciklus)
  - `app/src/lib/crypto/hash-chain.ts` write-gate kripto (`computeDiffHash`, `generateTokenPair`, `signWriteGateToken`/`verifyWriteGateSignature`, konstans idejű HMAC-összevetés) és `app/src/lib/crypto/secret-resolver.ts` (`WRITE_GATE_SECRET` fail-closed prod alatt)
  - A két valódi fogyasztó: `app/src/domain/training/training-service.ts` (tanítási memória-írás) és `app/src/domain/memory/memory-approval-service.ts` (inline memória-jelölt jóváhagyás)
  - `app/prisma/schema.prisma` `WriteGateToken` modell + `WriteGateTokenStatus` enum
- Eredmény:
  - Egy éles, latens biztonsági hibát találtam a primitívben. A `consume` read-check-then-update mintát követett: kiolvasta a sort, ellenőrizte `status === 'issued'`, majd FELTÉTEL NÉLKÜL `update`-tel `consumed`-ra állította. Ez klasszikus TOCTOU-ablak: két, a státusz-olvasáson egyszerre átjutó fogyasztó MINDKETTEN továbbmehetett az írásig, így EGY jóváhagyás KÉT írást hitelesíthetett — épp az az egyszer-használatos (single-use, nem visszajátszható) invariáns sérült, ami a governance-kapu értelme. A jelenlegi két hívó `issue`→`consume`-ot szinkron, egy kérésen belül végez, ezért ma nem triggerelt, de a `WriteGateService` exportált, újrafelhasználható primitív, amelynek dokumentált szerződése (§9.4: egy token = egy jóváhagyott diff, egyszer fogyasztva) csak a hívók gondosságára támaszkodott, nem a kapun magán. A kódbázis MÁS single-use/verseny-pontjai (`scheduled-task-repository.ts` revoke, `iam-repository.ts` meghívó-beváltás) már compare-and-set-tel védettek — ez a hely eltért ettől a saját konvenciótól.
  - NEM találtam titok-kezelési rést: a `WRITE_GATE_SECRET` a közös `resolveSecret`-en át prod alatt fail-closed, az aláírás-ellenőrzés konstans idejű, a diff-hash egyszerű származtatott érték (nem titok), a „pontosan egy horgony" invariáns az `issue`-ban helyesen kikényszerül.
- Javítás:
  - A `consume` státusz-átmenete atomikus compare-and-set lett: `updateMany({ where: { id, status: 'issued' }, data: { status: 'consumed', … } })`; `count === 0` esetén a versenyben vesztett fogyasztó fail-closed elutasításba fut. Ugyanez a CAS-őr került a lejárat-átmenetre is, így az nem írhatja felül egy párhuzamosan már consumed sor állapotát. A visszaadott sort a győztes tranzakció ismert állapotából állítjuk elő (nincs fölösleges kör-út).
  - A Prisma kliens konstruktor-injektálható lett (alapértelmezés a singleton), a codebase DI-mintája szerint — így az atomikus viselkedés injektált, in-memory klienssel determinisztikusan tesztelhető.
  - Új `write-gate-single-use.test.ts` regresszió (8 eset): happy path, szekvenciális visszajátszás, a TOCTOU-verseny determinisztikus szimulációja (két `issued`-ot látó fogyasztóból csak egy nyer), hash-eltérés/aláírás-hamisítás/lejárat fail-closed, és a horgony-invariáns.
- Üzleti hatás:
  - A write-gate a memória- és tanítási írások emberi jóváhagyásának kriptográfiai bizonyítéka: egy jóváhagyás pontosan egy módosítást engedélyez, auditálhatóan és nem visszajátszhatóan. Ha ugyanaz a jóváhagyó token két írást hitelesíthet (verseny/újrapróbálkozás alatt), az megbontja az „egy jóváhagyás = egy változás" audit-invariánst, és egy jövőbeli out-of-band jóváhagyási folyamatnál duplázott vagy jogosulatlan memória-módosítást engedhet. A javítás a kapu saját szintjén garantálja az egyszer-használatot, összhangban a platform többi compare-and-set védelmével.
- Ellenőrzés:
  - `npm run test:write-gate-single-use` (8/8 zöld), `npm run test:memory-approval` (regresszió zöld)
  - `npx tsc --noEmit` (app), célzott `npx eslint` (tiszta)
  - `/code-review` skill (Standards + Spec, két párhuzamos ügynök): a Standards-tengely nem talált hard violationt (a CAS-, DI- és teszt-minták a repo konvencióit követik); a Spec-tengely megerősítette, hogy a mag-fix helyes.
- Nyitott döntés (nem automatikusan javítva):
  - D1 — A `consume` csak `tokenId`-vel hitelesít, nincs tenant/agent-scope kapu rajta (a jelenlegi hívók upstream kötik a scope-ot, pl. `memory-approval-service.ts` a cél-chunkot tenant/agent/projekt szerint; ezért ma nem IDOR). Egy explicit tenant-őr a `consume`-on mélységi védelem lenne egy jövőbeli out-of-band fogyasztóhoz.
  - D2 — A `WriteGateTokenStatus` enumban ott a `revoked`, de egyetlen kód-út sem állít tokent `revoked`-ra (nincs revoke-metódus a service-en). A CAS-őr defenzíven ezt is elutasítaná; a tényleges visszavonhatóság külön, kis follow-up.
  - D3 — A `consume` a token consumed-ra állítását a hívó memória-írása ELŐTT végzi, és a kettő nincs egy tranzakcióban; egy consume utáni összeomlás „elégeti" a jóváhagyást nulla írással. Ez a fail-safe irány (soha nem két írás), de a teljes atomicitáshoz a fogyasztó-oldali írást is egy tranzakcióba lehetne vonni a consume-mal.

## 2026-07-18 - Scheduled task: tenant-határ és atomi ticket-materializálás

- Áttekintett modulok:
  - `app/src/domain/scheduled-task/scheduled-task-service.ts` (scheduled agent-task létrehozás, run-as payload, recurrence és materializálás)
  - `app/src/repositories/postgres/scheduled-task-repository.ts` és `app/src/repositories/interfaces/index.ts` (due-claim, revoke-verseny, ticket + task perzisztencia)
  - `app/src/app/actions/platform.ts` scheduled-task Server Action belépők, `app/src/domain/dispatcher/run-dispatch-cycle.ts` worker-ciklus, `app/prisma/schema.prisma` ScheduledTask/Ticket állapot- és relációmodell
  - `app/src/domain/agent/general-task-runtime.ts`, `app/src/domain/conversation/conversation-service.ts`, `app/src/lib/tenant-reachability.ts` (futáskori tenant-kapu és a csatolt kontextus útja)
  - `docs/specs/AI-Agent-Platform-Feature-Spec-ToolBroker-done.md` §3.4 és `AI-Agent-Platform-Feature-Spec-PerUser-Connector-DONE.md` (autonóm run-as és tenant-scope követelmények)
- Eredmény:
  - Két éles, magas kockázatú hibát találtam. A scheduled task létrehozó domain-szolgáltatás csak a felület operator szerepére támaszkodott: nem ellenőrizte, hogy a megadott agent az aktív tenantból elérhető-e és aktív-e. Így ismert idegen agent UUID-val tenant A-ben olyan task jöhetett létre, amely tenant B agentjéhez és annak modell-/connector-környezetéhez kötődött.
  - A due taskból ticketet létrehozó és a ScheduledTaskot `materialized`/következő futás állapotba író lépés két önálló adatbázis-művelet volt. Worker-leállás a kettő között tartós ready ticketet, de `materializing` taskot hagyott; a stale-reclaim ezt ismét aktiválta és új ticketet hozott létre. Ez egy feladat többszöri autonóm végrehajtását, duplázott költséget vagy ismételt külső hatást okozhatott.
  - A záró spec-review egy harmadik P1-hiányt mutatott: materializálás után a ticket saját payloadjában tovább élt a run-as adat, miközben a taskot már nem lehetett visszavonni. Így a visszavont autonóm felhatalmazásból létrejött, még nem indult ticket további tool-hívásai megőrizhették az acting-user kontextust.
- Javítás:
  - `ScheduledTaskService` agent repositoryt kapott és create előtt fail-closed, opak `Agent not found` kapuval ellenőrzi: csak aktív, saját tenantbeli vagy platform-szintű megosztott agent ütemezhető.
  - A ticket-létrehozás, task-állapotfrissítés és `pg_notify` egyetlen PostgreSQL tranzakcióba került. Visszagörgetéskor egyik írás sem marad meg; sikeres commit után a dispatcher csak konzisztens ticket–task párt láthat. A revoke compare-and-set lett, így a claimelt/materializált futást nem írhatja felül egy versenyző, korábban kiolvasott visszavonási kérés.
  - A run-as grantet a Broker minden scheduled tool-híváskor a ScheduledTask aktuális sorához köti (azonos task, tenant, materializált ticket, actor és authorization timestamp; csak `active`/`materialized` állapot érvényes). A revoke már a materializált taskra is használható, az agent `board_write` pedig nem írhatja felül/nullra a scheduler bizalmi mezőit.
  - Új determinisztikus `scheduled-task-enterprise.test.ts` regresszió fedi az idegen és inaktív agent elutasítását, saját/megosztott agent engedését, az egyetlen atomi materialize repository-hívást és a visszavont scheduled run-as deny-t.
- Üzleti hatás:
  - A scheduler a háttérben, emberi jelenlét nélkül indít agentet. A javítás garantálja, hogy egy ügyfél sem indíthatja el egy másik ügyfél agentjét vagy annak költség- és connector-környezetét, infrastruktúrahiba után sem ismétlődik meg egy már kiadott autonóm feladat, és a felhasználó a már kiadott tickethez kapcsolt run-as jogot is visszavonhatja, mielőtt további külső művelet történne. Ez csökkenti a cross-tenant adatkezelési, számlázási és jogosulatlan connector-használati kockázatot.
- Ellenőrzés:
  - `node --import tsx scripts/scheduled-task-enterprise.test.ts` (5/5 zöld; a `tsx` CLI a lokális sandbox IPC-korlátja miatt nem indul)
  - `npx tsc --noEmit`, célzott `npx eslint`, `git diff --check`
- Nyitott döntés (nem automatikusan javítva):
  - D1 — A `Document` modellnek nincs saját `tenantId` attribútuma. A task attachment ID-k futáskor globális dokumentum-lookupra támaszkodnak; a chat/task útvonalon ez szélesebb, már ismert adatmodell-adósság. A teljes megoldás explicit dokumentum-tenant attribúciót és migrációt igényel, nem egy csak scheduler-oldali szűrést.

## 2026-07-16 - Dispatcher / harness-callback: privilegizált belső végpontok titok-hitelesítése

- Reviewed modules:
  - `app/src/domain/dispatcher/dispatcher-service.ts` (dispatchReadyBatch / dispatchTicket / completeHarnessRun / reclaimStaleDispatches — lock-token kötés, budget-kapu, efemer kulcs életciklus, agent-status kapu)
  - `app/src/domain/dispatcher/run-dispatch-cycle.ts` (ciklus-orchestráció + `cycleInFlight` átfedés-védelem)
  - `app/src/app/api/v1/internal/dispatch-cycle/route.ts` (Cloud Scheduler trigger, `DISPATCHER_CONTROL_TOKEN`)
  - `app/src/app/api/v1/harness/tickets/[id]/complete/route.ts` és `.../process/route.ts` (harness visszahívó felület, `HARNESS_CALLBACK_TOKEN` + agent-API-kulcs)
  - `app/src/app/api/metrics/route.ts` (`METRICS_TOKEN` scrape-kapu)
  - `app/src/lib/validators/actions.ts` `harnessCompletionSchema`
- Result:
  - A dispatcher-mag enterprise-helyes: a completion a per-dispatch `lockToken`-hez kötött (kötelező UUID a sémában) a megosztott callback-titok MÖGÖTT (defense-in-depth), csak `active` agent dispatchelhető, a napi keret fail-closed (nincs keret nélküli állapot), az efemer agent-kulcs minden ágon visszavonásra kerül, a `process` route pedig agent-API-kulccsal + ticket→agent kötéssel véd. NEM találtam tenant-határ- vagy lock-megkerülési rést ezen a felületen.
  - Találtam viszont egy keményítési hiányt: a HÁROM privilegizált belső végpont (dispatch-cycle trigger, harness completion callback, metrics scrape) mindegyike egyetlen megosztott titkot JavaScript `!==`-vel hasonlított — ez byte-onként, korai kilépéssel fut, tehát elvi timing-oracle (a válaszidőből a titok byte-onként kikövetkeztethető). Ezek a végpontok NEM a Clerk-felhasználói auth mögött ülnek, a megosztott titok az egyetlen kapu; a dispatch-cycle trigger a teljes agent-flotta munka-indítását, a completion callback a ticketek lezárását/hibára állítását vezérli. A kódbázis MÁS pontjai (`oauth-state.ts`, `preview-token.ts`) már konstans idejű `timingSafeEqual`-t használnak — ez a három hely eltért ettől a saját konvenciótól. (Ez a 2026-07-14 review D1 pontjának kiterjesztett, javított változata.)
- Fix applied:
  - Új megosztott primitív: `app/src/lib/crypto/timing-safe.ts` — `safeSecretEquals(provided, expected)` fail-closed (hiányzó/üres oldal → false), utf8-buffer + hossz-őr + `timingSafeEqual`, pontosan a meglévő `oauth-state.ts`/`preview-token.ts` minta szerint.
  - Mindhárom route erre vált; a fail-closed rövidzár-logika (`!expectedToken`, `if (expected)`) változatlan, az elfogadott/elutasított bemenet-halmaz azonos a régi `!==`-ével (a spec-axis review megerősítette: nincs viselkedésbeli regresszió).
  - Új determinisztikus, DB-mentes teszt: `scripts/timing-safe-token.test.ts` (9 eset: pontos egyezés, azonos hosszú eltérés, rövidebb/hosszabb bemenet, üres/null/undefined fail-closed, hiányzó titok, unicode), `test:timing-safe-token`.
- Business impact:
  - A dispatcher-trigger és a harness-callback a platform önvezérlő gerince: az egyik elindítja az autonóm agent-munkát, a másik lezárja azt. Ha a védő titok kiszivárogtatható (akár timing-csatornán), az illetéktelen munka-indítást vagy ticket-státusz-hamisítást tesz lehetővé. A javítás konstans idejűvé teszi mindhárom kapu titok-ellenőrzését, és egyetlen auditált primitívbe vonja össze őket, a fail-closed viselkedés csökkentése nélkül.
- Verification:
  - `npm run test:timing-safe-token` (9/9 zöld)
  - `npx tsc --noEmit` from `app/`
  - `npx eslint` a módosított route-okra + helperre + tesztre (tiszta)
  - `/code-review` skill (Standards + Spec axis, párhuzamos): egyik axis sem talált blokkoló hibát; nincs viselkedésbeli regresszió.
- Decisions raised (not auto-fixed):
  - D1 — Két MEGLÉVŐ inline timing-safe hely (`oauth-state.ts`, `preview-token.ts`) nem lett a közös helperre migrálva; a `preview-token.ts` előre dekódolt Buffert hasonlít, tehát Buffer-elfogadó overload kellene. Külön, scope-tartó follow-up (érinti az OAuth- és sandbox-preview aláírás-ellenőrzést).
  - D2 — A teszt a helper szintjén fedez; a route-bekötést (negálás, rövidzár) nem gyakorolja end-to-end. Egy jövőbeli route-szintű integrációs teszt szorosabbra húzná.

## 2026-07-16 - Önfrissítő connector: capability-verzió jóváhagyás Separation of Duties

- Reviewed modules:
  - `app/src/domain/connector-self-update/self-update-service.ts` (a domain-seam: create / approveUrl / markTrusted / updatePolicy / sync / approveVersion / rejectVersion / rollback, tenant-, SoD-, trust-, diff- és auto-approve kapuk)
  - `app/src/domain/connector-self-update/spec-sync.ts` (letöltő + OpenAPI-parse; A4 egress-guard host-pinning, redirect-pinning, méret/időkorlát, content-type szűrő, fail-closed)
  - `app/src/domain/connector-self-update/spec-diff.ts` (kategorizált capability-diff + `isAutoApprovable` auto-jóváhagyási kapu)
  - `app/src/domain/connector-self-update/pinned-runtime-config.ts` + `capability-set.ts` (A3: futásidőben csak az AKTÍV, sémával validált snapshot hívható; `restrictToEndpoints` mindig true; fail-closed null)
  - `app/src/repositories/postgres/self-updating-connector-repository.ts` (atomi állapotváltások, tranzakción belüli audit, auto-approve dupla-ellenőrzés)
  - `app/src/app/actions/self-updating-connectors.ts` (belépő server actionök: `requireTenantRole`, https-only zod, superadmin `sodExempt`)
  - `app/src/repositories/postgres/tool-broker-repository.ts` + `app/src/domain/connector/http-api-client.ts` (runtime endpoint-allowlist és pinned egress-újraellenőrzés)
- Result:
  - A feature enterprise-helyes formájú: az SSRF-védelem valódi DNS-resolverrel van bekötve (`domain/index.ts`), a `sync` KIZÁRÓLAG emberi operátor server-actionből hívható (nincs agent/prompt-injektálható út), a YAML-parse a js-yaml biztonságos `load`-ja (nincs RCE), a runtime csak az aktív snapshot endpointjait engedi (`endpoint_not_allowed`) és pinned connectornál hívásidőben újraellenőrzi a hostot + tiltja a redirectet, az auth/base_url/egress-host változás mindig magas kockázatú emberi kapu, az auto-approve háromszorosan kapuzott (tenant opt-in + forrás-policy + tisztán read-only additív diff), a `access` mező metódus-alapú (POST/PUT/PATCH/DELETE → write), így új írási végpont sosem auto-jóváhagyható.
  - Találtam egy Separation-of-Duties (T2) rést a capability-verzió jóváhagyásban. Az `approveVersion` a "más kolléga hagyja jóvá, mint aki a linket beállította" kaput CSAK az ELSŐ verziónál kényszerítette ki (`if (!ctx.activeVersion)`). Minden KÉSŐBBI verziót a beállító (aki a spec-URL-t választotta ÉS az API-kulcsot birtokolja) egyedül élesíthetett — épp azokat a kockázatos változásokat (pl. új írási végpont), amelyeket a rendszer szándékosan visszatart az automatikus átvételtől, hogy emberi kapun menjenek át. A kettős kontroll így pont a legkockázatosabb inkrementális bővítéseknél lyukadt ki.
- Fix applied:
  - Az `approveVersion` a `requireDifferentActor(source.createdById, actor)` kaput MINDEN verzióra kikényszeríti (nem csak az elsőre); a hibaüzenet verzió-állapottól függ, a logika egységes. A superadmin (`sodExempt`) kivétel változatlanul megmarad, auditált `sod_bypass` metaadattal.
  - Új regressziós teszt (`self-updating-connector-lifecycle.test.ts`): v1-et másik kolléga hagyja jóvá; egy új `POST /customers` írási végpontot hozó v2-t a beállító NEM élesíthet (`SEPARATION_OF_DUTIES`), superadmin beállító viszont igen.
- Business impact:
  - Az önfrissítő connector lényege, hogy egy partner API-képességei emberi felügyelet mellett, biztonságosan követhessék a partner változásait. Ha a connectort beállító személy egyedül élesíthet minden későbbi képesség-bővítést, akkor egyetlen belső szereplő — miután egy kolléga egyszer megbízhatónak minősítette a partnert — önállóan kiterjesztheti a connector írási hatókörét (adatmódosítás, kifizetés-jellegű hívások) egy második jóváhagyó nélkül. A javítás a négy-szem-elvet a teljes életciklusra kiterjeszti, összhangban a platform többi SoD-invariánsával (approver ≠ requester), a superadmin vészkijárat auditált megtartásával.
- Verification:
  - `npm run test:self-updating-connector-lifecycle` (új SoD-regresszióval) és `npm run test:self-updating-connector` from `app/`
  - `npx tsc --noEmit` from `app/`
  - `npx eslint src/domain/connector-self-update/self-update-service.ts scripts/self-updating-connector-lifecycle.test.ts` from `app/`
  - `/code-review` skill (Standards + Spec, két párhuzamos ügynök): mindkét tengely tiszta; nincs hard violation, nincs spec-defektus.
- Decisions raised (not auto-fixed):
  - D1 — A `rollback` egy KORÁBBAN jóváhagyott (már vetett) verziót állít vissza, és jelenleg nincs rajta SoD-kapu. Alacsony kockázatú (nincs új capability), de a teljes szimmetriához megfontolható ugyanaz a `requireDifferentActor`.
  - D2 — Az untrusted, partner-hoszttolt OpenAPI-spec YAML-parse-a méret-cap (5 MiB) alatt is ki van téve a "billion-laughs" alias-expanziós memória/CPU-terhelésnek (js-yaml nem korlátozza az alias-mélységet). Emberi triggerű, megbízhatónak minősített URL-en, ezért alacsony súlyú, de egy alias/anchor-számláló előszűrő olcsó keményítés lenne a megosztott `openapi-config-extractor`-ban.
  - D3 — Az auto-approve út (tenant opt-in + read-only additív diff) szándékosan a beállító egyedüli, `approvedById: null` élesítését is megengedi — ez a feature dokumentált tervezése; a kockázatos (write/breaking/auth) változások továbbra is az emberi SoD-kapun mennek át.

## 2026-07-15 - Clerk meghívó-onboarding / tenant-membership provisioning

- Reviewed modules:
  - `app/src/app/actions/platform.ts` Clerk- és helyi meghívó-kibocsátás/visszavonás
  - `app/src/app/api/webhooks/clerk/route.ts`, `app/src/auth/clerk-provider.ts`, `app/src/auth/clerk-user-sync.ts` hitelesített provider-életciklus és identitásszinkron
  - `app/src/domain/iam/iam-service.ts`, `app/src/repositories/postgres/iam-repository.ts`, `tenant-repository.ts`, valamint az `Invitation` / `TenantMembership` adatmodell
  - `docs/specs/AI-Agent-Platform-Feature-Spec-IAM-RBAC-done.md` (§0, §3.2, §5, §7, §8, §9)
- Result:
  - Találtam három éles, P1-szintű kockázatot. A Clerk `publicMetadata.role` közvetlenül aktív belső szereppé vált, így egy provider-oldali hiba vagy rosszul kötött meghívó megkerülhette a Control Plane meghívó- és auditkapuját. A Clerk-meghívó elfogadása nem hozott létre `TenantMembership`-et, ezért a felhasználó nem kapott aktív tenant-kontektsust. Végül a webhook azonos e-mailhez tartozó ÖSSZES pending meghívót beváltottra jelölte, lejárat-, tenant- és konkrét meghívó-kötés nélkül: ez más tenant onboardingját tehette használhatatlanná.
  - Melléklelet: a tokenes meghívó-beváltás read-check-write sorrendje párhuzamos kéréseknél két beváltást/auditot is megengedhetett.
- Fix applied:
  - A Clerk többé nem dönt szerepkörről. Csak igazolt elsődleges e-mailt szinkronizál; az új identitás `pending` és szerep nélküli, amíg a helyi, pontos meghívó nem jogosítja fel.
  - A helyi meghívó előbb jön létre, és az UUID-ja a Clerk szerveroldali metadatajába kerül. A hitelesített webhook kizárólag ezt az egy, e-mailben egyező, nem lejárt, `pending` meghívót fogadhatja el; e-mail-alapú tömeges beváltás nincs. A helyi `Invitation` tárolja a Clerk invitation ID-t is, a normál visszavonás mindkét oldalt megpróbálja visszavonni.
  - Sikeres beváltás idempotens `TenantMembership.upsert`-tel létrehozza/aktiválja a tenant-tagságot és a tenant-attribútumú auditot. A `claimPendingRedemption` és a `revokePending` compare-and-set csak egy párhuzamos beváltást vagy visszavonást enged nyerni; retry esetén nem készül második jogosultság vagy auditesemény.
  - Új `clerk-invitation-membership.test.ts` fedi a pontos tenant-kötést, e-mail-eltérést, lejáratot és webhook-újraküldést.
- Business impact:
  - A meghívás most valóban azt az egy ügyfél-teret és szerepet adja, amelyet az admin kijelölt — sem a külső identitásszolgáltató metadataja, sem egy azonos e-mailes másik tenant-meghívó nem adhat hozzáférést. Ez megakadályozza az onboarding során történő jogosultság-emelést és a másik ügyfél beléptetési folyamatának megrongálását, miközben az új munkatárs azonnal a helyes tenantban kezdhet dolgozni.
- Verification:
  - `npm run test:clerk-invitation-membership`, `npm run test:iam-policy`, `npm run test:iam-tenant-boundary`, `npm run test:tenant-management`, `npm run test:tenant-isolation` from `app/`
  - `npx tsc --noEmit`; célzott `npx eslint`; `DIRECT_URL=... npx prisma validate`; `git diff --check`
- Decisions raised (not auto-fixed):
  - D1 — Ha a helyi visszavonás után a Clerk API átmenetileg hibázik, a helyi kapu fail-closed marad és hiba-napló készül, de automatikus provider-oldali retry/outbox még nincs. Szabályozott telepítéshez érdemes erre rövid retry- és reconcile-jobot bevezetni.

## 2026-07-14 - Agent API-kulcs hitelesítés skálázhatósága és O(n) bcrypt-DoS

- Reviewed modules:
  - `app/src/auth/agent-api-key.ts` a gép-gép (service-account) Bearer-token belépőpont és scope-őr
  - `app/src/repositories/postgres/agent-repository.ts` `authenticateApiKey` kulcs-ellenőrzés, valamint a kulcs-kiadó utak (`create`, `rotateApiKey`, `issueEphemeralKey`)
  - `app/src/app/api/v1/agent/tools/route.ts`, `app/src/app/api/v1/agent/tickets/route.ts` és a többi agent-facing API-route, amely erre a hitelesítésre épül
  - `app/prisma/schema.prisma` `AgentApiKey` modell
- Result:
  - A tenant- és scope-modell rendben van: a kulcs egy agent-identitáshoz és egy fix scope-listához kötött, a route-ok fail-closed módon `requireAgentScope`-ot kérnek, a titok bcrypt-tel van tárolva. NEM találtam tenant-határ- vagy jogosultság-rést ezen a felületen.
  - Találtam viszont egy éles használatot blokkoló skálázhatósági (és ezzel DoS-) hibát. A `authenticateApiKey` MINDEN aktív API-kulcsot betöltött az ÖSSZES agentről/tenantről, majd sorban `bcrypt.compare`-t futtatott rájuk, amíg egyezést nem talált. A bcrypt (cost 10) szándékosan lassú (~50-100 ms/hívás), így minden egyes agent-API-hívás költsége az aktív kulcsok számával lineárisan nőtt: pár száz agentnél már másodperces hitelesítési késleltetés, ezresnél gyakorlatilag használhatatlan — és egy támadó érvénytelen tokenekkel szándékosan a teljes O(n) bcrypt-szkennt kényszerítheti ki (CPU-kimerítés). Ez a demóban (kevés kulcs) nem látszik, de pontosan az enterprise-skálán válik éles-blokkolóvá.
- Fix applied:
  - Új közös primitív: `app/src/lib/agent-api-key-hash.ts` — `isAgentApiKeyFormat` (előtag-őr) és `deriveAgentApiKeyLookupHash` (szerveroldali sóval képzett determinisztikus HKDF-SHA-256 kereső-lenyomat). A nyugalmi titok TOVÁBBRA is bcrypt; a HKDF kizárólag gyors, egyedi-indexelt megkeresésre szolgál, és az adatbázis-szivárgás nem ad offline ellenőrzőt a nyers kulcshoz.
  - Séma + `0006_agent_api_key_lookup_hash` migráció: nullable `lookup_hash` oszlop egyedi indexszel. A hitelesítés így O(1) `findUnique`-kal megtalálja a pontos kulcssort, majd EGYETLEN bcrypt-ellenőrzést végez mélységi védelemként.
  - Minden kulcs-kiadó út (`create`, `rotateApiKey`, `issueEphemeralKey`) feltölti a kereső-hash-t. A migráció ELŐTT kiadott kulcsok visszafelé kompatibilisek: egy szűkített legacy-szkenn (csak a `lookup_hash IS NULL` sorokon) hitelesíti őket, és első sikeres használatkor feltölti a kereső-hash-üket, így a következő hitelesítés már a gyors úton fut. A legacy-halmaz monoton nullára csökken.
- Business impact:
  - A gép-gép API a platform végrehajtási felülete (tool-hívás, ticket-létrehozás): ha a hitelesítés lelassul vagy CPU-kimerítéssel megbénítható, az az egész agent-flotta leállását jelentheti. A javítás konstans idejűvé teszi a hitelesítést a kulcsok számától függetlenül, ezzel eltávolít egy éles-blokkoló skálázhatósági falat és egy olcsó DoS-felületet — a biztonsági tulajdonságok (bcrypt nyugalmi titok, scope-kötés, lejárat/visszavonás tisztelete) csökkentése nélkül.
- Verification:
  - `npm run test:agent-api-key-hash` (új determinisztikus, DB-mentes teszt: determinizmus, tárolás=keresés invariáns, ütközés-mentesség, formátum-őr)
  - `npx tsc --noEmit` from `app/`
  - `npx eslint src/lib/agent-api-key-hash.ts src/repositories/postgres/agent-repository.ts scripts/agent-api-key-hash.test.ts` from `app/`
  - `npx prisma validate` (séma érvényes; a `prisma generate` a `lookupHash` mezővel újragenerált)
  - `git diff --check`
- Decisions raised (not auto-fixed):
  - D1 — A `/api/v1/internal/dispatch-cycle` route a `DISPATCHER_CONTROL_TOKEN` statikus titkot sima `!==`-vel hasonlítja (nem konstans idejű). Hálózaton át a timing-oracle gyakorlatilag nem kihasználható, de egy `crypto.timingSafeEqual`-ra váltás olcsó keményítés lenne.
  - D2 — A migrációt éles/teszt Neon adatbázisra még alkalmazni kell (`prisma migrate deploy`); a PR csak a migrációs fájlt tartalmazza, adatbázis-változtatást nem futtattam.

## 2026-07-14 - Proactive monitor admin és background escalation tenant-határ

- Reviewed modules:
  - `app/src/app/actions/monitor.ts` monitor lista, részletek, szüneteltetés/folytatás/visszavonás, futásnapló, jelek és dry-run Server Action belépőpontjai
  - `app/src/domain/monitor/monitor-service.ts` tenant-scope érvényesítés, monitor sweep, ticket-eszkaláció és connector-count collector belépési sorrendje
  - `app/src/repositories/postgres/monitor-repository.ts`, `app/src/domain/monitor/collectors/*.ts`, `app/src/domain/dispatcher/dispatcher-service.ts`, `app/src/domain/playbook/process-definition-service.ts` és `app/prisma/schema.prisma` perzisztencia-, végrehajtás- és folyamat-trigger határai
  - `docs/specs/AI-Agent-Platform-Feature-Spec-Proactive-Monitor-done.md` (§4, §5, §9) és a Next.js Server Action biztonsági útmutatója
- Result:
  - Találtam cross-tenant IDOR-osztályt a monitor admin felületen. A `listMonitors` nem adott tenant-szűrőt a repositorynak, az egyedi monitorra épülő actionök pedig a hívó szerepét ellenőrizték, de a globális `monitorId`-t nem kötötték az aktív tenanthez. Egy tenant viewer/admin/operator ismert idegen UUID-val olvashatta a másik tenant monitor-konfigurációját, jel-payloadjait és futásnaplóját, illetve admin joggal szüneteltethette, folytathatta, módosíthatta vagy visszavonhatta azt. A dry-run ráadásul tenant-specifikus ticket- és connector-jeleket számolhatott ki.
  - Találtam egy background végrehajtási kockázatot is: létrehozáskor vagy módosításkor a `escalateAgentId` nem volt tenant-elérhetőséghez kötve. Egy másik tenant aktív agentjének ismert UUID-ja így egy saját tenant monitor ticketjét külső agenthez rendelhette; a dispatcher az agent tényleges tenantja szerinti model-budgetet és futtatási kontextust használja. Ez költség- és adatkezelési határátlépés lehetett.
- Fix applied:
  - A `MonitorService` minden emberi, azonosító-alapú művelete explicit `tenantId`-t kér, és a célmonitort fail-closed, opak `Monitor not found` választ adó domain-kapuval ellenőrzi. A listázás a repositoryig tenant-szűrt.
  - A monitor actionök az aktív tenantot továbbítják minden olvasásnál és életciklus-változtatásnál. Létrehozás és eszkalációs-agent módosítás előtt kizárólag a saját vagy platform-szintű megosztott agent fogadható el.
  - A workerben futó sweep is újraellenőrzi az eszkalációs agent elérhetőségét, ezért egy régi vagy közvetlenül betöltött hibás konfiguráció sem indíthat cross-tenant background agent-futást. A jel ettől még nem vész el: érvénytelen agentnél emberi backlog ticketként jön létre.
  - A `monitor-engine.test.ts` új regressziós tesztje ellenőrzi, hogy idegen monitorhoz nem jut el update/revoke/run/signal/dry-run repository-hívás, míg azonos tenantnál az update működik; továbbá hibás agent-kapcsolatnál backlog fallbacket és csendes sweepnél felesleges agent-lookup hiányát is lefedi.
- Business impact:
  - A proaktív monitorok SLA-küszöböket, határidőket, ticket-állapotokat, connector-mennyiségeket és operációs értesítési konfigurációt tartalmazhatnak. A változtatás megakadályozza, hogy egy ügyfél betekintsen egy másik ügyfél ilyen üzemi adataiba vagy leállítsa a felügyeletét.
  - Az eszkalációk csak az adott ügyfél által elérhető agentre futhatnak, így a feladatok, model-költségek és agent-képességek az arra jogosult szervezet határán maradnak — beleértve a régi hibás konfigurációk biztonságos kezelését is.
- Verification:
  - `npm run test:monitor` from `app/`
  - `npx eslint src/domain/monitor/monitor-service.ts src/app/actions/monitor.ts src/domain/index.ts scripts/monitor-engine.test.ts` from `app/`
  - `npx tsc --noEmit` from `app/`
  - `git diff --check`

## 2026-07-13 - Persistent agent memory: tenant boundary / approval / rollback surface

- Reviewed modules:
  - `app/src/domain/memory/memory-approval-service.ts` candidate approval, ticket routing, T2 write-gate writes, and chunk-target mutation path
  - `app/src/app/actions/platform.ts` memory candidate actions, memory overview/project-key reads, maintenance trigger, and manifest rollback action
  - `app/src/domain/memory/memory-proposal-service.ts`, `memory-maintenance-service.ts`, `memory-retrieval-service.ts`, and `memory-runtime-helper.ts` capture/retrieval scope propagation
  - `app/src/repositories/postgres/memory-repository.ts`, `app/src/lib/tenant-reachability.ts`, `app/src/lib/agent-detail-page-data.ts`, and `app/prisma/schema.prisma` persistence and tenant-scope contracts
  - `docs/specs/agent-memory-persistent-cross-conversation-spec.md` (§2.1, §6, §8, §9.3, NF2, S1, S6)
- Result:
  - Found a cross-tenant IDOR class across the memory administration surface. The project-key list, memory overview, maintenance trigger, and rollback action authenticated an active tenant user but fetched the target agent by global ID without checking that it was reachable from the active tenant. A tenant operator who knew another tenant's agent ID could read its memory project keys and curated chunks, initiate maintenance proposals, or roll back its memory manifest.
  - Found the same boundary flaw in candidate lifecycle actions. The approval service derived tenant authority from legacy `User.tenantId`, rather than the request's active tenant membership / superadmin-assume context; reject, modify, and ticket creation lacked a candidate tenant check. The ticket path also created training tickets without `tenantId`, weakening later ticket-scope enforcement.
  - Found an authorization-adjacent arbitrary-target write. A memory proposal's `supersedes` chunk ID is model-controlled input, but approval mutated the target by global ID without confirming it belonged to the candidate's memory, agent, tenant, project, and workstream. A known foreign chunk UUID could therefore be archived, deleted, demoted, or superseded through an otherwise authorized approval.
- Fix applied:
  - Memory actions now assert the target agent is reachable from the active tenant before reading its memory or invoking maintenance/rollback.
  - `MemoryApprovalService` now accepts the active tenant id and role explicitly, uses them for authorization, and fail-closes candidate lifecycle operations unless both the candidate and its agent are in scope. It no longer treats the stale single-tenant user profile as authority.
  - Memory-candidate training tickets are explicitly tenant-attributed; ticket approval verifies both ticket and candidate tenant scope.
  - Before a write-gate token is issued, candidate target chunks are validated against the full memory/agent/tenant/project/workstream scope. Out-of-scope targets are rejected before any mutation or token consumption.
  - Extended `memory-approval-service.test.ts` with tenant-attributed ticket and cross-scope target regression coverage.
- Business impact:
  - Persistent memory stores project decisions, constraints, and operational context that may re-enter future agent prompts. The fix stops one customer from viewing, changing, or rolling back another customer's retained agent knowledge, and prevents a prompt-influenced agent from using a foreign chunk ID to alter another customer's context.
  - Approval records and training tickets now retain the tenant that authorized them, providing a trustworthy audit trail for regulated or multi-tenant deployments.
- Verification:
  - `npm run test:memory-approval` from `app/`
  - `npx tsc --noEmit` from `app/`
  - `npx eslint src/domain/memory/memory-approval-service.ts src/app/actions/platform.ts scripts/memory-approval-service.test.ts` from `app/`
  - `git diff --check`

## 2026-07-11 - Ticket board / workspace file tenant boundary

- Reviewed modules:
  - `app/src/app/actions/platform.ts` ticket board actions (`listTickets`, `listBoardAssignees`, `createBoardTicket`, `dispatchBoardTicket`, `listBoardTickets`, `getTicket`, `getTicketTransitions`)
  - `app/src/app/api/v1/tickets/[id]/workspace/files/route.ts` ticket workspace list/download/signed-url/upload route
  - `app/src/app/api/v1/conversations/[id]/workspace/files/route.ts` conversation workspace list/download/signed-url/upload route
  - `app/src/domain/file-editor/workspace-storage.ts` storage key and quota behavior
  - `app/src/domain/agent/general-task-runtime.ts` and `app/src/domain/agent/agent-chat-runtime.ts` runtime workspace tenant-key usage
- Result:
  - Found a cross-tenant IDOR class in the ticket/workspace surface. The workspace file routes only required a logged-in user, loaded tickets/conversations by global ID, and derived the storage prefix from legacy `user.tenantId` instead of the active tenant context. A user who knew another tenant's ticket or conversation ID could list, download, request signed URLs for, or upload files against that workspace route.
  - Found related board-ticket tenant gaps. `listTickets`, `listBoardTickets`, `getTicket`, `getTicketTransitions`, and `dispatchBoardTicket` authenticated the caller but did not consistently scope the target ticket to the active tenant. `listBoardAssignees` listed globally active users, and human ticket creation accepted any active user ID, allowing cross-tenant user discovery and assignment.
- Fix applied:
  - Added `resolveWorkspaceTenantKey` as a small fail-closed workspace resource guard. HTTP workspace access now requires active tenant auth: `viewer` for list/download/signed-url and `operator` for upload. The route returns an opaque 404 for cross-tenant or tenantless legacy resources and uses the active tenant key only after the resource tenant matches.
  - Ticket lists and board lists now pass `tenantId: activeTenantId`; single-ticket read/transition lookup and dispatch now assert `ticket.tenantId === activeTenantId` before returning data or triggering work.
  - Board human assignees now come from active `TenantMembership` rows in the selected tenant, not global users. Human ticket creation requires an active membership in the active tenant.
  - Added `scripts/workspace-resource-access.test.ts` and `test:workspace-resource-access` for the storage-key tenant invariant, including cross-tenant and tenantless legacy denial.
- Business impact:
  - Protects customer work artifacts: ticket and conversation workspaces may contain uploaded documents, generated files, tool outputs, and deliverables. These are tenant-owned business records and must not be accessible by knowing an ID from another tenant.
  - Prevents support/operations users in one tenant from seeing another tenant's tickets, transitions, assignee population, or accidentally dispatching another tenant's agent work.
  - Aligns the board and workspace APIs with the platform's enterprise tenant model: the active tenant membership is the authority boundary, not legacy single-tenant user metadata.
- Verification:
  - `npm run test:workspace-resource-access --prefix app`
  - `npm run test:conversation-session --prefix app`
  - `npm run test:tenant-isolation --prefix app`
  - `npx eslint 'src/app/api/v1/tickets/[id]/workspace/files/route.ts' 'src/app/api/v1/conversations/[id]/workspace/files/route.ts' src/app/actions/platform.ts src/lib/workspace-resource-access.ts scripts/workspace-resource-access.test.ts` from `app/`
  - `npx tsc --noEmit` from `app/`
- Decisions raised (not auto-fixed):
  - D1 — Tenantless legacy ticket/conversation workspaces are now denied through these HTTP routes. If the product needs migration access for old `tenantId = null` workspaces, build an explicit admin migration/export flow rather than letting tenant users reach null-tenant storage implicitly.

## 2026-07-10 - Sandbox App Registry / preview-token isolation / archive tenant boundary

- Reviewed modules:
  - `app/src/domain/sandbox/sandbox-app-service.ts` (create/version/activate/list/get/export/preview/archive, tenant gate, preview token serve path)
  - `app/src/domain/sandbox/preview-token.ts` (HMAC-signed preview payload and expiry)
  - `app/src/app/api/sandbox-apps/preview/route.ts` and `app/src/app/api/sandbox-apps/[appId]/export/route.ts` (cookieless preview/export serving headers)
  - `app/src/repositories/postgres/sandbox-app-repository.ts` (tenant-scoped listing/metrics, version persistence)
  - `app/src/app/actions/platform.ts` sandbox app server actions
  - `app/scripts/sandbox-app-registry.test.ts` and `app/src/lib/sandbox-csp.ts` coverage surface
- Result:
  - The registry core has a production-appropriate shape for A0 single-file apps: immutable versions, deterministic content hashes, HTML linting before persistence, short-lived signed preview URLs, cookieless preview serving, CSP sandboxing without `allow-same-origin`, and tenant checks inside the domain service before read/export/preview/archive operations.
  - Found one enterprise tenant-boundary gap in the human archive action. `create`, `version`, `activate`, `list`, `get`, `metrics`, and `previewUrl` all pass `requireTenantRole(...).activeTenantId` into the sandbox service, but `archiveSandboxApp` reloaded `getCurrentUser()` and passed the legacy `user.tenantId`. In a migrated multi-tenant account, a user operating in tenant B could be authorized by tenant B membership while the archive service checked tenant A from the legacy profile. That can either wrongly deny the active tenant's own archive operation or archive a different tenant's app if the caller knows its id.
- Fix applied:
  - `archiveSandboxApp` now uses the same active tenant context as the rest of the sandbox app actions: `requireTenantRole('operator')` returns both `user.user.id` and `user.activeTenantId`, and those values are passed directly into the domain service.
  - Added a deterministic archive tenant-boundary regression in `sandbox-app-registry.test.ts`: cross-tenant archive is denied with `APP_NOT_FOUND_OR_FORBIDDEN` and `sandbox_app.access_denied`, while same-tenant archive succeeds and emits `sandbox_app.archive`.
- Business impact:
  - Aligns sandbox app lifecycle control with the selected customer tenant, which is critical because mini-apps are executable customer artifacts. Operators can no longer accidentally apply lifecycle changes based on stale legacy tenant metadata instead of the tenant they are administering.
  - Preserves the audit story for enterprise customers: denied cross-tenant archive attempts and successful archives remain explicit governance events.
- Verification:
  - `SANDBOX_APP_STUB=true node --import tsx scripts/sandbox-app-registry.test.ts` from `app/`
  - `node --import tsx scripts/sandbox-csp.test.ts` from `app/`
  - `npx eslint src/app/actions/platform.ts scripts/sandbox-app-registry.test.ts src/domain/sandbox/sandbox-app-service.ts src/domain/sandbox/preview-token.ts src/app/api/sandbox-apps/preview/route.ts 'src/app/api/sandbox-apps/[appId]/export/route.ts'` from `app/`
  - Note: the package-script form `npm run test:sandbox-app --prefix app` and `npm run test:sandbox-csp --prefix app` hit the local sandbox's `tsx` IPC pipe restriction (`listen EPERM`); the same tests pass via `node --import tsx`.
- Decisions raised (not auto-fixed):
  - D1 — Preview tokens are not currently single-use. They are short-lived and bound to `tenantId + appId + version + contentHash`, which is acceptable for preview links, but stricter regulated deployments may want replay tracking or a nonce table.
  - D2 — Sandbox audit attribution is mostly derived from target references today. If enterprise reporting needs direct tenant filtering for every sandbox event, the service should pass `tenantId` explicitly on every `audit.append` call rather than relying on derived attribution.
## 2026-07-09 - Conversation Session / Agent Chat tenant-határ + workspace fájl API

- Áttekintett modulok:
  - `app/src/domain/conversation/conversation-service.ts` (conversation lookup, append,
    promoteToTicket, audit)
  - `app/src/domain/agent/agent-chat-runtime.ts` és `app/src/domain/agent/wiki-runtime.ts`
    (chat/wiki conversation indítás, stream, task ticket, report/wiki ticket)
  - `app/src/app/actions/platform.ts` conversation/wiki server actionök
  - `app/src/app/api/v1/conversations/[id]/workspace/files/route.ts` és
    `app/src/app/api/v1/tickets/[id]/workspace/files/route.ts`
  - `app/src/repositories/postgres/conversation-repository.ts`, `app/prisma/schema.prisma`
    Conversation/Message tenant- és retention-mezők
- Eredmény:
  - A ConversationService alapvető tenant-scope mintája jó irányú: ha a hívó tenantot ad,
    a beszélgetés olvasása/archiválása/törlése opak `Conversation not found` hibával
    fail-closed, és cross-tenant olvasási kísérlet auditot ír.
  - Találtam egy AgentChat/Wiki runtime tenant-rést: a chat és wiki belépők az agentet
    globális `findByIdWithDetails(agentId)` hívással töltötték, miközben a tenantot csak a
    conversationre adták át. Multi-tenant éles környezetben egy tenant operátora idegen
    tenant agent ID-ját célba vehette volna, ami prompt-, modelConfig-, memory-/recipe- és
    capability-kitettséget, illetve téves ticket/delegációs mellékhatásokat okozhat.
  - Találtam egy workspace fájl API tenant-rést is: a conversation/ticket workspace fájl
    route-ok csak `getCurrentUser()`-t használtak, globálisan oldották fel a conversationt /
    ticketet, és a storage tenant-kulcsot a legacy `user.tenantId` mezőből képezték az aktív
    tenant-kontextus helyett. Ez nem elégséges enterprise izoláció fájl-listázás,
    letöltés/signed URL és feltöltés útvonalon.
  - A `promoteToTicket` action az első olvasást tenant-szűrten végezte, de a domain
    promóciós hívásba nem vitte tovább a tenantId-t. Ez TOCTOU/IDOR jellegű defense-in-depth
    rés volt a conversationből ticketet nyitó útvonalon.
- Javítás:
  - AgentChatRuntime és WikiAgentRuntime a közös `isAgentReachableFromTenant` szabályt
    alkalmazza minden human-facing chat/wiki/task/report belépőn: megosztott agent elérhető,
    saját tenant agent elérhető, cross-tenant agent opak `Agent not found`.
  - A chat/wiki message append hívások ugyanazt a tenantId-t viszik tovább a ConversationService
    felé, így nem csak az előzetes lookup, hanem maga az append is tenant-scope-olt.
  - A conversation és ticket workspace fájl API-k `requireTenantRole('viewer')`-t kérnek
    olvasásra/listázásra, `requireTenantRole('operator')`-t feltöltésre, és `findFirst({ id,
    tenantId: activeTenantId })` alapján oldják fel a cél objektumot. A storage kulcs az
    objektum tenantjához / aktív tenantjához kötött, nem legacy user mezőhöz.
  - A `ConversationService.promoteToTicket` tenantId-ja kötelező lett; a production action az
    aktív tenantot adja át, a demó/acceptance globális agent útvonal explicit `null`-t.
  - Új determinisztikus teszt: `scripts/agent-chat-tenant-boundary.test.ts` (sendMessage,
    sendMessageStream, createTaskTicket cross-tenant deny mellékhatás előtt), valamint új
    ConversationSession regresszió a cross-tenant promote tiltásra.
- Üzleti hatás:
  - Megakadályozza, hogy egy ügyfél operátora egy másik ügyfél agentjével vagy annak
    workspace fájljaival dolgozzon pusztán ID ismeretében. Ez különösen fontos, mert a
    chat runtime a platform legérzékenyebb prompt-kontekstusát állítja össze (memory,
    knowledge, tool history, attachment workspace), és a workspace fájl API közvetlen
    dokumentum-hozzáférést ad.
  - Az aktív tenant-kontextus lesz az egységes auditálható határ a chat, wiki, ticket és
    fájlműveletek között, ami ügyfél-tenant izoláció és compliance review szempontból
    védhetőbb kontroll.
- Verifikáció:
  - `npm run test:agent-chat-tenant-boundary --prefix app`
  - `npm run test:conversation-session --prefix app`
  - `npm run test:chat-tool-history --prefix app`
  - `npx eslint src/domain/agent/agent-chat-runtime.ts src/domain/agent/wiki-runtime.ts
    src/domain/conversation/conversation-service.ts src/app/actions/platform.ts
    src/app/api/v1/conversations/[id]/workspace/files/route.ts
    src/app/api/v1/tickets/[id]/workspace/files/route.ts
    scripts/agent-chat-tenant-boundary.test.ts scripts/conversation-session.test.ts`
  - `git diff --check`
  - Megjegyzés: a teljes `npx tsc --noEmit` jelenleg nem zöld a repo meglévő
    provisioning/connector-template típushibái miatt (`TemplateDescriptor.connectorType`,
    provisioning panel template metadata, `ProvisioningErrorCode`); ezek nem a most
    módosított conversation/chat/workspace fájlokból erednek.
- Nyitott döntések (nem auto-javítva):
  - D1 — A workspace fájl API jelenleg tenant-szintű viewer/operator jogosultságot használ,
    nem conversation/ticket tulajdonosi vagy assignee-szintű ACL-t. Ha egy tenanton belül is
    szigorúbb adatmegosztás kell, külön per-resource access policy szükséges.
  - D2 — A `Document` modellnek továbbra sincs saját `tenantId` mezője; a chat-csatolmányok
    documentId alapján töltődnek. Ez kapcsolódik a 2026-07-07 KB review D1 döntéséhez, és
    séma-szintű tenant-attribúcióval lenne zárható teljesen.

## 2026-07-07 - Knowledge Base tenant-határ (dokumentum-gate + megosztás + review)

- Áttekintett modulok:
  - `app/src/domain/knowledge-base/knowledge-base-service.ts` (requestDocument /
    approveDocument / rejectDocument / listPendingDocuments / listPendingArtifacts /
    getArtifactReview / publishArtifact + draft-artifact flow)
  - `app/src/app/actions/platform.ts` KB server actionök (requestKbDocument,
    approveKbDocument, rejectKbDocument, listKbDocumentRequests, getKbArtifactReview,
    processDocumentForWiki, listDocumentsForAgent, shareKnowledgeBaseWithAgent,
    unshareKnowledgeBaseFromAgent, getKnowledgeBaseSharing, deleteKbDocument)
  - `app/src/repositories/postgres/knowledge-repository.ts` (searchChunks / listIndex /
    getPageChunks retrieval scope), `app/src/domain/tool-broker/tool-broker-service.ts`
    `resolveKbConnectorScope` + kb_search/kb_list_index/kb_get_page
  - `app/src/auth/tenant-context.ts` (`requireTenantRole`), `app/prisma/schema.prisma`
    Document / KnowledgeArtifact / KnowledgeChunk / Agent tenant-mezők
- Eredmény:
  - A KB retrieval-út (kb_search és a navigáció) helyesen a Tool Broker fail-closed
    capability-kapuján és a connector-scope-on át fut, PUBLISHED-only chunkokra.
  - Talált egy cross-tenant IDOR-osztályt a KB admin-felületen. A KB actionök a hívó
    aktív tenant-szerepét hitelesítették (`requireTenantRole`), de a cél `agentId` /
    `documentId` / `ticketId` / `targetAgentId` feloldása globális `findById` volt,
    tenant-szűrő NÉLKÜL. Multi-tenant telepítésen ez egy tenant operátorának/approverének
    engedte, hogy (a) egy MÁSIK tenant agentjének tudásbázis-review tartalmát (extracted
    text, OKF file-tree) olvassa (`getKbArtifactReview`, `listKbDocumentRequests`),
    (b) idegen dokumentumot csatoljon idegen agent KB-jéhez a jóváhagyási kapu megkerülésével
    (`processDocumentForWiki`) vagy azon át (`requestKbDocument`), (c) idegen KB-jóváhagyást
    hagyjon jóvá/utasítson el (`approve/rejectKbDocument`), (d) cross-tenant KB-t osszon meg
    vagy szüntessen meg (`share/unshare/deleteKbDocument`). A demóban minden agent globális
    (tenantId null), ezért ma nem éles — de pontosan a multi-tenant enterprise használatban
    válik kihasználhatóvá (ugyanaz a mintázat, mint a 2026-07-07 Tool Broker és IAM review).
- Javítás:
  - Új közös primitív: a `isAgentReachableFromTenant` / `filterAgentsByTenant` a Tool
    Brokerből egy megosztott `app/src/lib/tenant-reachability.ts` modulba került (a Tool
    Broker re-exportál, a meglévő teszt változatlan) — így a KB ÉS a Tool Broker EGY
    tenant-invariánst használ (megosztott/null agent bárhonnan elérhető, cross-tenant SOHA).
  - A KB domain-service minden agent-/ticket-belépője `actorTenantId`-t kap és fail-closed
    módon ellenőrzi az elérhetőséget (`assertAgentReachable` / `assertTicketAgentReachable`);
    a cross-tenant hozzáférés opak `Agent not found` / `KB ticket not found` (nincs
    létezés-oracle).
  - A prisma-direkt KB actionök (`processDocumentForWiki`, `listDocumentsForAgent`,
    `share/unshareKnowledgeBaseWithAgent`, `getKnowledgeBaseSharing`, `deleteKbDocument`)
    `assertAgentTenantReachable` őrt kaptak a forrás- ÉS cél-agentre.
  - Új determinisztikus teszt: `scripts/kb-tenant-boundary.test.ts` (10 eset:
    tiszta szabály + request/approve/reject/getReview/listPending cross-tenant deny +
    saját-tenant/megosztott allow), `test:kb-tenant-boundary`. A `knowledge-base-gate.test.ts`
    happy-path suite frissítve (actorTenantId) és zöld; tool-broker-tenant zöld; a módosított
    fájlok tsc/eslint tiszták.
- Üzleti hatás:
  - Megakadályozza, hogy egy ügyfél-tenant KB-adminisztrátora belásson vagy beleírjon egy
    másik ügyfél-tenant tudásbázisába — a tudásbázis a platform legérzékenyebb, ügyfél-tulajdonú
    tartalma. A tenant-határ a domain-rétegbe kerül, ahol a runtime és az audit ugyanazt az
    invariánst látja.
- Nyitott döntések (nem auto-javítva):
  - D1 — `Document`-nek nincs saját `tenantId` oszlopa; a tenant a connectoron / feltöltőn át
    származtatott. A `requestDocument` jelenleg tetszőleges CSATLAKOZATLAN documentId-t elfogad,
    ha a cél-agent elérhető; egy szigorúbb modell a dokumentum feltöltőjének tenantját is
    ellenőrizné (schema-bővítés kellhet).
  - D2 — `shareKnowledgeBaseWithAgent` megengedi, hogy egy tenant-saját KB-t egy MEGOSZTOTT
    (null) cél-agenthez kössenek, ami platform-szintűvé tehet ügyfél-tartalmat. A reachability
    ezt (a demó globális agentjei miatt) nem tiltja; termék/biztonsági döntést igényel, hogy a
    megosztott agent lehet-e tenant-saját KB célpontja.

## 2026-07-07 - IAM/RBAC tenant-context boundary (permission matrix + access audit)

- Reviewed modules:
  - `app/src/domain/iam/iam-service.ts` (invite/redeem/approve/role-change/suspend/reactivate, tenant-scoped target loading, last-admin lock, permission matrix update)
  - `app/src/auth/tenant-context.ts` (tenant membership / superadmin assume resolution, `requireTenantPermission`)
  - `app/src/auth/permission.ts` (legacy user-role based `requirePermission`)
  - `app/src/app/actions/platform.ts` IAM server actions (`listUsers`, invitation/user lifecycle, permission matrix, access audit)
  - `app/src/repositories/postgres/iam-repository.ts` and `app/src/repositories/postgres/audit-repository.ts`
  - `app/src/lib/iam-policy.ts`, `app/src/auth/context.ts`, `app/prisma/schema.prisma` IAM/tenant models
- Result:
  - The IAM domain service already enforces the important enterprise invariants for user lifecycle operations: tenant-scoped target lookup, self-modification denial, last active admin lockout, one-time invitation redemption, and append-only audit events.
  - Found a tenant-boundary gap in the IAM admin surface. The permission matrix and access-audit actions still used legacy `requirePermission`, which decides from the global `User.role`, not the active `TenantMembership` / superadmin-assume tenant context. In a migrated multi-tenant deployment this can deny a valid tenant admin whose membership is correct but legacy `User.role` is stale/null, and it can also apply/read IAM governance outside the selected tenant context. `getAccessAuditLog` also listed all access audit rows matching the action names, with no `tenantId` filter.
- Fix applied:
  - `getPermissionMatrix`, `updateRolePermission`, and `getAccessAuditLog` now use `requireTenantPermission`, so the active tenant membership or explicit superadmin assume context is the authorization boundary.
  - Access audit list construction moved to `buildTenantAccessAuditFilter`, which always includes the active tenant id and the fixed access-audit action allowlist.
  - `IamService.updatePermission` now writes explicit `tenantId` attribution and includes the tenant id in metadata for `user.permission.update`.
  - Added `scripts/iam-tenant-boundary.test.ts` and `test:iam-tenant-boundary` to cover tenant-scoped access-audit filters and permission-update audit attribution.
- Business impact:
  - Prevents IAM administration and access audit review from accidentally crossing customer tenant boundaries.
  - Aligns the admin UI with the platform's current multi-tenant model: tenant membership and superadmin assume mode are the source of authority, not legacy single-tenant user-role fields.
  - Improves audit evidence for enterprise customers because permission-matrix changes are attributable to a specific tenant context.
- Verification:
  - `npm run test:iam-tenant-boundary --prefix app`
  - `npm run test:iam-policy --prefix app`
  - `npm run test:tenant-management --prefix app`
  - `npx eslint src/domain/iam/iam-service.ts src/domain/iam/access-audit.ts src/app/actions/platform.ts scripts/iam-tenant-boundary.test.ts` from `app/`
- Decisions raised (not auto-fixed):
  - D1 — `RolePermission` is still a global table. The current fix scopes the action boundary and audit visibility by active tenant, but the matrix value itself remains platform-wide. If customers need tenant-specific IAM policies, the schema should add `tenantId` to `RolePermission` with a platform-default fallback.

## 2026-07-07 - Tool Broker: agent-oldali tenant-izoláció (delegálás + felderítés)

- Reviewed modules:
  - `app/src/domain/tool-broker/tool-broker-service.ts` (a governance-chokepoint:
    `AllowlistAuthorizer.authorize`, `ToolBrokerService.invoke`/`executeTool`,
    gmail-send jóváhagyás, http_api/file/sandbox/repo végrehajtók, acting-user/tenant
    feloldás, `agentResolve`/`agentCatalog`/`agentAsk`/`ticketCreate`/`userDirectory`)
  - `app/src/lib/agent-catalog.ts` (`buildAgentCatalogEntry` — teljes capability/connector belépő)
  - `app/prisma/schema.prisma` `Agent.tenantId` (nullable → megosztott vs tenant-saját agent)
  - `app/prisma/seed.ts` (a demo agentek mind globálisak, tenantId null)
- Result:
  - A Tool Broker törzse enterprise-helyes: fail-closed capability/role-template kapu,
    connector lifecycle- és tenant-izoláció a connectorokon, delegált OAuth-token
    injekció client_secret-szivárgás nélkül, append-only tool-call audit.
  - Talált tenant-izolációs rést az AGENT-irányú toolokban. A `user_directory` és a
    `ticket_create` HUMÁN-felelős ága kifejezetten tenant-szűrt ("cross-tenant user
    SOHA nem szivárog ki"), de az `agent_resolve`, `agent_catalog`, `agent_ask`, és a
    `ticket_create` AGENT-felelős ága a teljes agent-táblán dolgozott (`agents.findMany()` /
    `findById()` tenant-szűrő nélkül). Multi-tenant telepítésen ez egy tenant agentjének
    engedte, hogy (a) felderítse egy másik tenant agentjeinek nevét, szerepét és TELJES
    capability-/connector-katalógusát, és (b) cross-tenant agentnek delegáljon feladatot
    (confused deputy — a célagent a saját connectorai/tudásbázisa felett dolgozna egy idegen
    tenant kérdésén). A demóban minden agent globális (tenantId null), ezért ma nem éles,
    de pontosan a multi-tenant enterprise használatban válik kihasználhatóvá.
- Fix applied:
  - Új tiszta szabály: `isAgentReachableFromTenant(agentTenantId, effectiveTenantId)` —
    megosztott (null) agent bárhonnan elérhető, egyébként csak azonos tenant; plusz a
    `filterAgentsByTenant` lista-szűrő. Ez a `user_directory` tenant-izolációjának
    agent-oldali párja (defense-in-depth, sosem fail-open).
  - `agent_resolve` és `agent_catalog` (lista- ÉS `agentId`-direktlookup-ág is) a hívó
    effektív tenantjára szűr (`resolveCallerTenantId` = acting-user tenant, különben a
    hívó agent tenantja — a `user_directory` mintája). `agent_ask` és a `ticket_create`
    agent-felelős ága elutasítja a cross-tenant célagentet (a delegálás-ticket tenantja,
    különben a cselekvő felhasználó tenantja a referencia).
  - Új determinisztikus teszt: `scripts/tool-broker-tenant-isolation.test.ts` (8 eset:
    pure szabály + agent_resolve szűrés + agent_catalog direkt-lookup + agent_ask/
    ticket_create cross-tenant deny), `test:tool-broker-tenant`. A kapcsolódó suite-ok
    (tool-broker-bridge, user-directory, repo-pr, tool-loop) zöldek; a módosított fájlok
    tsc/eslint tiszták.
- Business impact:
  - Megakadályozza, hogy egy tenant agentje (vagy egy prompt-injektált agent) felderítse
    vagy elérje egy másik ügyfél-tenant agentjeit — se adat-, se capability-, se
    delegációs úton. A tenant-határ a domain-rétegbe kerül, ahol a runtime és az audit
    ugyanazt az invariánst látja.
- Decisions raised (not auto-fixed):
  - D1 — `checkGmailSendApproval` a jóváhagyó ticketet ID alapján, tenant/agent-kötés és
    egyszer-használatosság (replay-védelem) nélkül fogadja el; a tényleges küldést a
    per-user grant korlátozza ugyan a saját postafiókra, de a per-küldés emberi jóváhagyás
    újrafelhasználható. Termék/biztonsági döntést igényel (kötés a konkrét draft-hoz + consume).
  - D2 — `argsMeta` a `ticket_create`-nél `Object.keys(input.args.payload)`-t hív; ma a séma
    kötelezővé teszi a payloadot (`?? {}`), de egy hiányzó payload a hiba-ági auditban
    TypeError-t dobna. Robusztusság-nit, külön javítható.

## 2026-07-06 - Governed Flow Builder: Playbook v2 compile + runtime path

- Reviewed modules:
  - `app/src/lib/playbook-v2/runtime.ts` (deterministic transition + advance engine)
  - `app/src/lib/playbook-v2/process-step-payload.ts` (step outcome + output contract)
  - `app/src/lib/playbook-v2/step-output-inference.ts`
  - `app/src/domain/playbook/playbook-compiler.ts`
  - `app/src/domain/playbook/playbook-validator.ts`
  - `app/src/domain/playbook/process-service.ts` (advance / concurrency hardening)
  - `app/src/domain/agent/general-task-runtime.ts` (step outcome enforcement path)
- Result:
  - The governed orchestration core has the right enterprise shape: gate-bypass is
    fail-closed (agent/system can never cross a blocking human gate), the cascade
    protection routes `blocked`/`failed` step outcomes away from the happy path, and the
    recent concurrency hardening (idempotency guard + conditional status writes) targets a
    real "stuck running" race.
  - Found a correctness gap in output-contract inference. `inferStepOutputFields` only
    walked `step.onComplete`, but Decision Steps (WP-8) route via `decision.branches` /
    `fallback` (desugared to onComplete at compile time). A decision branch leading to a
    step with a required `step`-source input slot never had that field inferred into the
    decision step's output contract, so neither the validator warned nor the runtime
    enforced it — the decision step closed silently as `ok` and the process only blocked
    later at the next step's creation (`output_contract_unmet` class).
- Fix applied:
  - `inferStepOutputFields` now collects next-step targets from both `onComplete` and
    `decision.branches` / `decision.fallback` via a local `happyPathNextStepIds` helper,
    consistent with the compiler's `desugarDecision` and the validator's `buildAdjacency`
    (traversal inlined to avoid a circular import).
  - Added 2 regression tests in `playbook-process-lifecycle.test.ts` (branch + fallback
    field inference and compiler `outputRequiredFields` pass-through). Full playbook-v2
    core/runtime/process/governed/lifecycle/process-def suites green; eslint clean.
- Decisions raised (not auto-fixed; see `docs/code-review/2026-07-06-playbook-runtime-decisions.md`):
  - D1 — `StepOutcomeSignals.toolDenied` is unreachable code: the tool loop never surfaces
    a mid-loop broker denial, so a step can close `ok` despite a governance-denied tool
    call. Needs a product/security decision on whether denial should hard-fail the step.
  - D2 — the `await_gate` / `await_human` advance branches lack the terminal-status guard
    that `next_step` / `complete` use; unreachable today under the single-active-step
    invariant, but a defense-in-depth inconsistency.

## 2026-07-06 - Model Gateway governed routing / request model override

- Reviewed modules:
  - `app/src/domain/gateway/model-gateway.ts`
  - `app/src/domain/gateway/routing-engine.ts`
  - `app/src/domain/gateway/sensitivity-router.ts`
  - `app/src/domain/gateway/budget-engine.ts`
  - `app/src/app/api/v1/gateway/v1/chat/completions/route.ts`
  - `app/src/lib/harness-model-config.ts`
  - `app/scripts/model-gateway-negative.test.ts`
- Result:
  - The Model Gateway already centralizes provider calls, sensitivity classification, budget guardrails, model-call audit records, and provider abstraction in a shape that is appropriate for enterprise control-plane enforcement.
  - Found a governance bypass in the OpenAI-compatible gateway API path. A caller-provided `model` value was merged into `modelConfig` before entering the gateway, so the routing engine treated it as the agent's registry model. Without an explicit routing policy this let a request choose another model identifier, which can bypass central cost, vendor, residency, and approval expectations.
  - Found that the routing engine's `overrideHint` contract was documented as low trust but, if used, would have accepted the override before policy evaluation. That is the wrong default for an enterprise AI gateway because request-level preferences must be opt-in governance decisions, not caller authority.
- Fix applied:
  - Request-selected models now travel as `modelOverrideHint` instead of overwriting the agent registry `modelConfig`.
  - `RoutingEngine` ignores request model overrides by default and honors them only when the matched routing policy explicitly sets `allowRequestOverride: true`; optional provider/model allowlists further constrain which override can be used.
  - The `/api/v1/gateway/v1/chat/completions` response now reports the actual model used by the gateway, so clients and audit evidence do not claim that a denied override was honored.
  - Added MG-N7 negative tests covering default-deny override behavior, explicitly allowlisted override behavior, and denied unallowlisted override behavior.
- Business impact:
  - Prevents API clients, harnesses, or compromised agents from silently switching to unapproved, more expensive, or non-compliant model backends.
  - Keeps model routing, vendor selection, and data-governance decisions in the platform control plane where administrators can review and audit them.
  - Improves customer-facing transparency by returning the actual model that processed the request.

## 2026-07-01 - Per-user connector grant / OAuth token vault

- Reviewed modules:
  - `app/src/domain/connector-grant/connector-grant-service.ts`
  - `app/src/domain/connector-grant/grant-token-vault.ts`
  - `app/src/domain/connector-grant/gmail-scopes.ts`
  - `app/src/domain/connector-grant/gmail-api-client.ts`
  - `app/src/domain/tool-broker/tool-broker-service.ts` delegated Gmail/token integration
  - `app/src/app/actions/connector-grants.ts`
  - `app/src/app/api/connectors/oauth/callback/route.ts`
  - `app/src/repositories/postgres/connector-grant-repository.ts`
  - `app/prisma/schema.prisma` `ConnectorGrant` model
  - `app/scripts/per-user-connector.test.ts`, `app/scripts/s7-live-smoke.ts`, `app/scripts/acceptance-e2e.ts`
- Result:
  - Found that token issuance and grant status changes relied too much on callers passing a previously authorized `grantId`. The domain service did not independently re-check that the grant belonged to the acting user, tenant, connector, and token reference before loading the token vault. In an enterprise environment this is a defense-in-depth gap: a future integration bug could turn a valid grant id into cross-user delegated mailbox access.
  - Found that initial OAuth token exchange accepted missing `refresh_token` and did not reject provider-returned scopes that were wider than the scopes requested through state. For long-lived delegated access, both should fail closed.
- Fix applied:
  - `ConnectorGrantService` now reloads and verifies grant ownership before token resolution, revoke, and expiry marking.
  - OAuth exchange now requires `access_token` and `refresh_token`, and rejects unrequested provider scopes.
  - OAuth refresh now requires a returned `access_token`.
  - Tool broker and connector-grant action/smoke callers now pass explicit tenant/user expectations.
  - Added deterministic per-user connector tests for the token ownership invariant.
- Business impact:
  - Reduces the risk that one user's delegated Gmail/Workspace token can be used by another user or tenant because of a caller-side bug.
  - Keeps delegated grants least-privilege even if an OAuth provider response is malformed or unexpectedly broad.
  - Moves critical access-control rules into the domain layer, where enterprise audit and runtime paths share the same invariant.

## 2026-07-04 - Web fetch / egress guard SSRF boundary

- Reviewed modules:
  - `app/src/domain/net/egress-guard.ts`
  - `app/src/domain/web-fetch/web-fetch-service.ts`
  - `app/src/domain/web-fetch/content-sanitize.ts`
  - `app/src/domain/web-fetch/web-fetch-types.ts`
  - `app/src/domain/index.ts` production `WebFetchService` DNS resolver wiring
  - `app/scripts/egress-guard.test.ts`
  - `app/scripts/web-fetch.test.ts`
- Result:
  - The web fetch path already had the right enterprise shape: deny-by-default source URL checks, HTTPS-only fetches, manual redirect handling, content-type and size caps, hash-only audit metadata, and production DNS resolution before fetch.
  - Found a defense-in-depth gap in the resolved-IP classifier. It blocked common private ranges but did not cover several reserved IPv4 ranges, IPv6 documentation/transition/multicast prefixes, or compressed IPv4-mapped IPv6 forms such as `::ffff:a9fe:a9fe`. In production, that could let an allowlisted hostname that resolves unexpectedly to a special-use address get further than intended before the network layer fails or behaves inconsistently.
- Fix applied:
  - IP literal host detection now uses Node's IP parser, so bracketed IPv6 literals are rejected as raw IP hosts as well as IPv4 literals.
  - DNS rebinding checks now classify broader IPv4 reserved ranges and IPv6 loopback, ULA, link-local, multicast, documentation, transition, IPv4-mapped, IPv4-compatible, and NAT64 metadata/private forms.
  - Added egress guard and web fetch tests for IPv6-mapped metadata resolution and additional reserved ranges.
- Business impact:
  - Reduces the chance that AI-driven web discovery can be abused to reach cloud metadata services, internal networks, or special-use network ranges through DNS tricks.
  - Makes the documented "reserved IP re-check" behavior match the actual runtime behavior more closely, which is important for enterprise security review and audit evidence.
  - Keeps the mitigation in the shared server-side egress guard, so callers cannot accidentally bypass it by constructing a different web fetch flow.

# Production Audit napló

Napi éles-környezeti biztonsági és megbízhatósági audit. Minden bejegyzés egy
vizsgált scope-ot, a coverage-t, a bizonyított findingokat, a javításokat, az
ellenőrzéseket és a residual riskeket rögzíti. Cél: bizonyítható kockázatcsökkenés
és növekvő audit-coverage.

---

## 2026-09-07 — Agent-chat stream API: kliens forduló-bemenet méret-kapui (DoS/OOM)

**Scope:** `POST /api/v1/agent-chat/stream` kliens-vezérelt bemenetei — `content`,
`taskBriefing.*`, `attachmentDocumentIds` — végig a downstream fogyasztásig
(`agent-chat-runtime` / `general-task-runtime` / `scheduled-task-service`).
Kockázati alapon: a 09-05 kör három residual pontját célozta (attachment IDOR,
content/briefing méret, non-web ingress), és közvetlenül kapcsolódik a nyitott
Cloud Run **OOM-incidenshez** (`ops/cloud-run-oom-concurrency`).

**Coverage:**
- **Attachment tenant-határ (IDOR) — VERIFIKÁLTAN ZÁRT (nem finding).** Mindkét
  futási út (`agent-chat-runtime.loadDocuments` 1202/2125, `general-task-runtime`
  1208) a `assertDocumentsReachableFromTenant`-en megy át; a `findByIds` teljes
  `Document` sort ad (metadata/uploadedById/connectorId a guardnak megvan). A view-
  építő út (2463) már kötött, historikus ID-kkel dolgozik (tenant-scope-olt
  `getConversation`), nem fresh IDOR. A scheduled-task tárolt attachment-listája is
  csak futáskor, a `loadDocuments`-en át materializálódik → fail-closed.
- **Input méret-kapu — FINDING (lásd lent).**
- `processInputPayload` méret-kapu: **nem** része ennek a körnek (residual).

### Finding (CONFIRMED) — validálatlan `content` / `taskBriefing` / `attachmentDocumentIds`

A stream-route a kliens `content`, `taskBriefing.*` és `attachmentDocumentIds`
mezőit **méret-/formátum-ellenőrzés nélkül** adta tovább az agent-fordulónak
(prompt-összeállítás, DB-írás, modellhívás). A szentesített szerver-action utak
(`createAgentTaskTicketSchema`, `addTicketCommentSchema`, `taskBriefingSchema`) már
kapuzzák ugyanezeket; ez a route volt az **egyetlen** határok nélküli ingress —
ugyanaz a minta, mint a 09-05 `projectKey` finding.

- **Hatás:** egy hitelesített kliens tetszőlegesen nagy üzenetet/briefinget és
  tetszőlegesen hosszú (nem UUID) csatolmány-listát küldhetett → memória-kimerülés
  (OOM-irány), fölösleges modellköltség, lassulás; a nem-UUID azonosítók közvetlenül
  a prisma `in`-lekérdezésbe kerültek.
- **Súlyosság:** közepes (hitelesített DoS / erőforrás-kimerítés / költség; nincs
  cross-tenant szivárgás).

### Javítás

`agentChatStreamTurnInputSchema` (Zod) a `validators/actions.ts`-ben, a route a
határon `safeParse`-el → `400 invalid_turn_input` (a chat-felület olvasható hibaként
jeleníti meg, nincs beragadt „dolgozik"). Kapuk: `content` ≤ 16 KiB (komment-törzs
precedens), `taskBriefing` a meglévő `taskBriefingSchema.partial().nullish()` újra-
használatával (nincs kapu-drift), `attachmentDocumentIds` max 8 valódi UUID. A kapu
a folytatás-elágazás fölött, feltétel nélkül fut (folytatáskor is véd). Root-cause
szintű: minden `content`/csatolmány ingress ugyanazon a kapun megy át.

### Ellenőrzések

- `scripts/agent-chat-stream-input.test.ts` (új, 10 assert): séma-határok (content
  exact-max/+1, exact-8 és >8 csatolmány, non-UUID, briefing 2000/approval 500) +
  route-wiring forrás-assert. Zöld. `package.json` `test:agent-chat-stream-input`.
- `eslint` tiszta a módosított fájlokra; a módosított fájlok `tsc`-tiszták (a
  `scheduled-task-enterprise.test.ts` tsc-hiba a `main`-en is fennáll, nem ide tartozik).
- Független `/code-review` (Standards + Spec): _lásd lentebb_.

### PR

- **#438** — `fix(chat): bound client turn input at the agent-chat stream boundary`
  (branch `fix/chat-stream-input-limits`, `origin/main`-ről).

### /code-review eredmény (Matt Pocock skill, 2 párhuzamos axis)

- **Standards:** nincs sértés; a séma a többi validátor mellett, a route a
  `resolveChatStreamProjectKey`-jel azonos `safeParse→400` mintát követi. Egyetlen
  actionable smell (Duplicated Code/Data Clumps: briefing-mezők újradeklarálása)
  **átvezetve** → `taskBriefingSchema.partial().nullish()` újrahasználat.
- **Spec:** helyes és hű; a kapu **mindkét** ágon (normál + folytatás) fut, a
  16 KiB defenzálható (chat = szabad szöveg ≈ komment-törzs), a `400` tiszta UI-
  állapot. Nincs scope-creep (a séma kimenete eldobva, viselkedés nem változik).
  Két teszt-rés (exact-8, approval-500) **átvezetve**.

### Residual risk / következő audithoz

- **`processInputPayload` (folyamat-indító payload) méret-kapu nélkül** megy tovább
  a stream-route-on (route.ts). Nem volt e finding hatóköre — **prioritált követő**.
- **Chat-composer nincs kliens-oldali csatolmány-számkapu:** >8 csatolmánynál most
  `400` (a platform-standard 8-hoz igazodva) — érdemes a composerben graceful 8-as
  kapu (UX, nem biztonság).
- **Content 16 KiB:** ha valós chat-használat rendszeresen efölött paste-el, a kapu
  látható lesz — akkor emelni/streamelni kell (l. `workspace/files` streamelés follow-up).
- Nem-web ingress-ek (agent API-kulcs, csatorna-integrációk, monitor-eszkaláció)
  `content`/méret-kezelése változatlanul ellenőrizendő (fogadnak-e ilyen mezőt).

---

## 2026-09-05 — Agent-chat stream API: work-project kulcs validáció

**Scope:** `POST /api/v1/agent-chat/stream` (`app/src/app/api/v1/agent-chat/stream/route.ts`)
— a webes chat-felület egyetlen kliens-vezérelt fordulóindító végpontja. Kockázati
alapon választva: ez a legnagyobb támadási felületű, autentikált, kliens-adatot
(`projectKey`, `content`, `taskBriefing`, `attachmentDocumentIds`) az agent-runtime-ba
továbbító ingress, és a `projectKey` a **memória + audit hatóköre**.

**Coverage:** a `projectKey` teljes ingress-felülete végignézve (API-route + a
`app/src/app/actions/` server-action írási útvonalak), valamint a downstream memória-
és audit-felhasználás (`memory-runtime-helper`, `memory-*-service`, `inputRef: project:<key>`).
A route egyéb bemenetei (consequence-approval folytatás, connector-grant folytatás,
task-only kapu, aktív-forduló 409, SSE keep-alive/`after` életciklus) áttekintve —
ezeken nem találtam új bizonyítható findingot ebben a körben.

### Finding (CONFIRMED) — validálatlan `projectKey` → árva memória/audit névtér

A stream-route a kliens `projectKey`-jét **validáció nélkül** adta tovább az agent-
fordulónak. A `projectKey` a munkatárs-memória lekérés/írás szűrője és az audit
`inputRef` (`project:<key>`) hatóköre. A ticket- és server-action útvonalak már a
`workProjects.assignableKey(tenantId, key)` kapun mennek át; ez a route volt az
**egyetlen** API-ingress, amely megkerülte azt.

- **Hatás:** egy ismeretlen vagy archivált kulccsal a chat-felületről új,
  nyomon követhetetlen memória-szeletet lehetett nyitni a tenanten belül (adat-
  integritás / auditálhatóság sérül). Tenant-határ nem sérült: az `assignableKey`
  a `findByKey(tenantId, key)`-t használja, így másik tenant kulcsa „nem található".
- **Súlyosság:** közepes (adat-integritás / audit-scope, nem cross-tenant szivárgás).

### Javítás

`app/src/app/api/v1/agent-chat/stream/route.ts`: nem-folytatás fordulónál a route
mostantól a `services.workProjects.assignableKey`-t hívja:
- ismeretlen / archivált / érvénytelen kulcs → `400 invalid_work_project` (forduló nem indul),
- foglalt/üres kulcs → `Általános` gyűjtőre normalizál,
- a tovább adott érték a validált, normalizált kulcs (`assignedProjectKey`).

Root-cause szintű: minden `projectKey` ingress most ugyanazon a kapun megy át.

### Ellenőrzések

- `scripts/work-project.test.ts` — kiegészítve a stream-route validáció regressziós
  assertjével (assignableKey-hívás, `invalid_work_project` hiba, `assignedProjectKey`
  továbbadása). Teljes fájl zöld.
- `tsc --noEmit` tiszta; `eslint` tiszta a módosított fájlokra.
- Független `/code-review` (Standards + Spec): _lásd lentebb_.

### PR

- **#430** — `fix(chat): validate work project keys at API boundary`
  (branch `fix/chat-work-project-validation`, commit `d13484223`).

### /code-review eredmény (Matt Pocock skill, 2 párhuzamos axis)

- **Standards:** nincs hard violation; a változás **javítja** a konformitást
  (`AGENTS.md` „mindkét úton működjön" elv — a chat-út most ugyanazt a kaput
  használja, mint a ticket/server-action út). Csak triviális judgement-call
  smell-ek (a régi inline feltétel felemelése egy helyre = szándékos cleanup;
  a teszt forrás-string regex asszertjei a fájl meglévő stílusa).
- **Spec:** követelmények teljesülve, root cause a határon javítva, nincs scope
  creep. A route az **egyetlen** app-szintű `sendMessageStream` hívó — nincs
  ungated testvér-ingress. A `assigned.key` (nem a nyers input) továbbadása
  tiszteletben tartja a foglalt-kulcs normalizálást (agent-memory §2.1
  `__general__` szentinel, nincs null-kulcs).

### Residual risk / következő audithoz

- **Defense-in-depth (opcionális, YAGNI-ból most kihagyva):** az
  `agent-chat-runtime.ts` `setProjectKey` sink továbbra is közvetlenül veszi a
  `params.projectKey`-t, `assignableKey` nélkül. Gyakorlatban zárt (az egyetlen
  nem-megbízható hívó most kapuzott), de egy jövőbeli hívó újranyithatná — érdemes
  runtime-szintű kapuval megerősíteni, ha újabb ingress kerül be.
- **Continuation-on-archived él (scope-on kívül):** ha egy beszélgetés projektjét a
  létrehozás UTÁN archiválják, a folytatás továbbra is a már-archivált névtérbe ír
  (a névtér már létezett; a folytatás nem küld `projectKey`-t).
- A `content` és `taskBriefing.*` mezők tartalom-validációja/hossz-plafonja külön
  vizsgálandó (DoS / prompt-méret) — nem része ennek a körnek.
- `attachmentDocumentIds` és `processInputPayload` bizalmi-határa (IDOR/tenant-scope
  a downstream `sendMessageStream`-ben) — jövőbeli scope.
- Nem-web ingress-ek (agent API-kulcs, csatorna-integrációk, monitor-eszkaláció)
  `projectKey`/scope kezelése — jelen körben nem érintett, ellenőrizendő, hogy ezek
  egyáltalán fogadnak-e projektkulcsot.

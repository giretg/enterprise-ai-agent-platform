# Production Audit napló

Napi éles-környezeti biztonsági és megbízhatósági audit. Minden bejegyzés egy
vizsgált scope-ot, a coverage-t, a bizonyított findingokat, a javításokat, az
ellenőrzéseket és a residual riskeket rögzíti. Cél: bizonyítható kockázatcsökkenés
és növekvő audit-coverage.

---

## 2026-09-09 — Nyers JSON kérés-törzs méret-kapu MINDEN ingressen (DoS/OOM)

**Scope-választás (kockázati alapon):** a 09-08 kör lezárt residualja explicit ezt jelölte
„a legfontosabb követő"-nek: a mező-szintű kapuk (#438/#443) UTÁN is nyitva maradt a
**nyers kérés-törzs** — `request.json()` / `readJson` egyik route-on sem volt globálisan
méret-kapuzva, így egy több MB-os *body* már a `JSON.parse`-nál OOM-olhatott, a mező-kapu
ELŐTT. Ez közvetlenül a **nyitott Cloud Run OOM-incidens** (`healthcheck-cloud-run-oom-concurrency`)
vektora → a legmagasabb *gyakorlati* kockázat.

**Coverage (a teljes JSON-ingress-felület felmérve):**
- Minden `app/src/app/api/**` body-olvasó felderítve: 7 nyers `request.json()`, 4 `readJson`,
  1 nyers `request.text()` (dispatch-cycle), 2 `formData()` (fájlfeltöltés).
- A `formData()` multipart-utak (`tickets|conversations/.../workspace/files`) szándékosan
  **kívül** vannak a JSON-scope-on (feltöltés-méret ≠ JSON-parse OOM) — residual.

### Finding (CONFIRMED) — határ nélküli kérés-törzs → OOM a `JSON.parse` előtt

A control-plane JSON-végpontjai a teljes kérés-törzset a memóriába pufferelték `JSON.parse`
elé, felső korlát nélkül. Hitelesített kliens (a Telegram-webhooknál külső fél) több MB-os
törzzsel a memória-szűkös konténerben OOM-ot válthatott ki — a mező-szintű kapuk ez ELŐTT
hatástalanok. **Súlyosság:** közepes (hitelesített DoS/OOM), de a nyitott OOM-incidens miatt
a gyakorlati kockázat magasabb. Nincs cross-tenant szivárgás.

### Javítás (root cause a megosztott határon)

`readJson` (`lib/api-response.ts`) mostantól a bájt-plafonig olvas a törzsből, **mielőtt**
memóriába pufferelné: Content-Length gyors-elutasítás + stream-darabolós számláló, ami
`reader.cancel()`-lel megszakít a plafon átlépésekor (chunked / Content-Length nélküli
törzsnél is). Egy hely, minden JSON-ingress rajta megy át:
- 4 process-route (`readJson`-t már használ) → ingyen véd;
- 7 nyers `request.json()` hívó átállítva (`agent-chat/stream`, `gateway/chat/completions`,
  `agent/tickets`, `agent/tools`, `harness .../complete` + `.../process`, `telegram/webhook`);
- `internal/dispatch-cycle` nyers `request.text()`-je a közös `readBoundedText`-en (a handler
  meglévő catch-e 400-at ad túl nagy törzsre).
- Alap plafon **1 MiB**; a nagy modell-kontextust hordozó **gateway explicit 4 MiB**.

### Ellenőrzések

- `scripts/read-json-body-limit.test.ts` (új, 10 assert, zöld): plafon-határ (exact-max/+1),
  Content-Length gyors út, **chunked stream-számláló** (a fő bypass-teszt), `readBoundedText`
  viselkedés, érvénytelen-JSON elkülönítése a méret-hibától, route-wiring forrás-assertek
  (nincs maradék nyers `request.json()` / `request.text()`). `test:read-json-body-limit`.
- `tsc --noEmit` + `eslint` tiszta a módosított fájlokra.
- Független `/code-review` (Matt Pocock, 2 párhuzamos axis):
  - **Standards:** hard violation nincs; a „közös kapu, nincs drift" standardot **erősíti**.
    Judgement-callok: Shotgun Surgery (a közös kapu elkerülhetetlen ára), a try/catch-duplikáció
    **nem e diff terméke**, a forrás-szkennelő teszt-assert törékeny (de a repo bevett mintája).
  - **Spec:** mag-követelmény teljesül, **nincs bypass** (a stream-út a chunked törzset a parse
    előtt megszakítja). Két pont **átvezetve ugyanebben a PR-ben:** (a) dispatch-cycle nyers
    törzs kapuzása; (b) a `RequestBodyTooLargeError` félrevezető 413-ígéretének törlése
    (a típus valódi haszna: méret- vs. JSON-hiba megkülönböztetés a teszteknek).

### PR

- **#445** — `fix(api): bound JSON request bodies at every ingress (DoS/OOM)`
  (branch `fix/bounded-json-body-oom`, `main`-ről; izolált worktree — a `main` munkafa 29
  idegen, commit-olatlan változást tartalmazott, ezek NEM kerültek a PR-be).

### Residual risk / következő audithoz

- **Státuszkód-finomítás:** a process-route-ok generikus catch-e a túl nagy törzsre 500-at ad
  (a többi ingress 400/null-t); rejection mindkét esetben (nincs OOM). A `413`-ra képezés
  opcionális UX-nicety, nem biztonsági kérdés.
- **Fájlfeltöltés (`formData()`):** a `workspace/files` multipart útjai külön feltöltés-méret-
  kapu (GCS-kvóta) tárgya — nem JSON-scope, follow-up.
- **Gateway 4 MiB:** tapasztalati plafon; ha valós nagy-kontextusú agent-forgalom efölé nő,
  emelni kell (l. `workspace/files` streamelés follow-up).
- A teljes JSON-ingress-felület mostantól egyetlen kapuzott helyen (`readJson`/`readBoundedText`)
  fut — új route csak ezeken át olvasson törzset (regressziós forrás-assert őrzi a meglévőket).

---

## 2026-09-08 — Folyamat-indító bemenet méret-kapu + ingress/authz-felület átvizsgálás

**Scope-választás (kockázati alapon):** a 09-07 kör lezárása után a legnagyobb
nyitott, klienstartalmú, határok nélküli ingress a **folyamat-indító `inputPayload`**
volt — a ledger `processInputPayload` residual-ját célozza, és közvetlenül a nyitott
**Cloud Run OOM-incidenshez** (`healthcheck-cloud-run-oom-concurrency`) kapcsolódik.
A kiválasztás előtt széles authz/ingress-átvizsgálás futott (lásd Coverage), amelyből
kockázati sorrendben ez a bizonyítható finding emelkedett ki.

**Coverage (átvizsgálva, VERIFIKÁLTAN ZÁRT — nem finding):**
- **Folyamat-definíció életciklus** (`process-definitions/*` route-család:
  create/patch/activate/archive/runs/triggers): minden mutátor `requireDef(tenantId,id)`
  → `defs.findById` `where:{id,tenantId}`. Tenant-scoped, szerepkör-kapuval. Tiszta.
- **`startProcess` / `startFromDefinition`**: def+verzió+playbook mind `input.tenantId`-re
  szűrve; `rootTicketId` a belépő ticketre felülíródik; `conversationId` nincs cross-tenant
  olvasva. Tiszta.
- **Workspace fájl-letöltés** (conversations + tickets párhuzamos route): szimmetrikus,
  `resolveWorkspaceTenantKey` + közös `resolveDownloadableWorkspacePath` letöltés-kapu. Tiszta.
- **Agent-turn cancel + reconnect-stream**: `findById` után `isAgentTurnAccessible`
  (tenant ÉS létrehozó egyezés). Tiszta.
- **Telegram jóváhagyás-callback** (untrusted external ingress): titkos fejléc (konstans idő),
  aláírás a kötött mezőkre, címzett-identitás kötés, aktív+tenant egyezés, allowedActions,
  ÉLŐ szerep-újraellenőrzés, saját-kérés kapu, atomikus egyszer-használat CAS. Tiszta.
- **OAuth connector-callback**: AES-256-GCM state (nem hamisítható), `state.userId===actorId`
  + connector-tenant egyezés + PKCE → nincs OAuth-CSRF/token-injekció. Tiszta.
- **Dispatcher HTTP-szerződés** (`handleDispatchCycleRequest`): fail-closed token (üres titok→401),
  timing-safe, body csak auth után. Tiszta.
- **Harness route-ok**: `/process` agent-kulcs + scope + `ticket.agentId===auth.agentId`;
  `/complete` platform-szintű shared token (infra-auth). Tiszta a tenant-határon.
- **Write-gate token consume**: státusz/lejárat/diff-hash/subject/aláírás + egyszer-használat CAS. Tiszta.
- **Tool-broker `document_read` / `tulajdoni_lap_parse`**: `canAccessDocument` +
  `isDocumentReachableFromTenant` (fail-closed, bélyeg-pontos tenant-egyezés); a
  `conversationId`/`ticketId` szerver-injektált futáskontextus, nem agent-arg. Tiszta.

### Finding (CONFIRMED) — validálatlan `inputPayload` / `processInputPayload` (DoS/OOM/költség)

A folyamat-indító bemenet (`Record<string, unknown>`) **méret-kapu nélkül** jutott el a
runtime-ba, a DB-be (`Prisma.InputJsonValue`) és az agent promptjába, KÉT klienstartalmú
ingressen:
1. **Chat-stream** (`POST /api/v1/agent-chat/stream`) — a `processInputPayload` mezőt a
   09-07 (#438) `agentChatStreamTurnInputSchema` **nem** fedte (explicit residual).
2. **REST futás-indító** (`POST /api/v1/process-definitions/[id]/runs`) — a
   `startProcessSchema.inputPayload` szabad `z.record(...)` volt, korlát nélkül.

- **Hatás:** hitelesített kliens tetszőlegesen nagy/mély JSON-objektumot küldhetett →
  erőforrás-kimerítés (OOM-irány a memória-szűkös Cloud Run konténerben), DB-hízás,
  fölös modellköltség. Nincs cross-tenant szivárgás.
- **Súlyosság:** közepes (hitelesített DoS / OOM / költség), de a **nyitott OOM-incidens**
  miatt gyakorlati kockázata a szokásosnál magasabb.

### Javítás (root cause a határon)

Közös `processInputPayloadSchema` (`validators/actions.ts`): `z.record` + szerializált
méret ≤ **64 KiB** (`PROCESS_INPUT_PAYLOAD_MAX_BYTES`). Egy helyen definiálva, **mindkét**
ingressen alkalmazva (nincs kapu-drift): `agentChatStreamTurnInputSchema.processInputPayload`
és `startProcessSchema.inputPayload`. A chat-route a határon `safeParse`-el →
`400 invalid_turn_input`, és a lefelé küldött érték a **validált** `turnInput.data.processInputPayload`
(a nyers body-mező csak kapu-input). A közös séma a `startProcessSchema` révén a
`app/actions/process.ts` server-action utat is fedi → mindkét úton (chat + ticket/action) véd.

### Ellenőrzések

- `scripts/agent-chat-stream-input.test.ts` (15 assert, zöld): folyamat-bemenet exact-max
  átmegy, +1 bájt bukik a chat-stream ÉS a REST `startProcessSchema` sémán, normál payload
  átmegy, route-wiring forrás-assert (`safeParse`-ben + validált érték downstream).
- `tsc --noEmit` + `eslint`: a módosított fájlokra tiszta.
- Független `/code-review` (Matt Pocock, 2 párhuzamos axis):
  - **Standards:** nincs hard violation; magyar kommentek/üzenetek, „mindkét úton" elv
    teljesül, a közös séma az anti-smell (Duplicated Code/Shotgun Surgery megszűnik).
    Két triviális judgement-call (a refine-üzenet „bájt" szava belső Zod-üzenet;
    a route egyetlen mezője megy `turnInput.data`-ból — okát komment fedi).
  - **Spec:** követelmények teljesülve, nincs scope-creep, nem bypassable (a `safeParse`
    feltétel nélkül fut a route tetején, folytatáskor is). Egyetlen ismert plafon: a
    nyers body a payload-kapu ELŐTT parse-olódik (l. residual).

### PR

- **#443** — `fix(process): bound process-start input payload at both ingresses (DoS/OOM)`
  (branch `fix/process-input-payload-size-limit`, commit `0c71c5a8b`, `main`-ről).

### Residual risk / következő audithoz

- **Nyers kérés-törzs plafon (a legfontosabb követő):** `request.json()` / `readJson`
  egyik érintett route-on sincs globálisan méret-kapuzva, így egy több MB-os *body* már a
  `JSON.parse`-nál OOM-olhat, a mező-szintű kapu ELŐTT. A #438 mintát követve most a
  parse-olt mezőt kapuztuk; a raw-body plafon szélesebb, minden route-ot érintő follow-up
  (közös `readJsonBounded` a `readJson`/`request.json()` helyére).
- **Mélység-kapu:** a 64 KiB-os szerializált méret közvetve korlátozza a beágyazást; külön
  depth-limit nem szükséges (a `JSON.parse` rekurziós plafonja alatt maradunk), de ha a
  raw-body kapu bejön, érdemes együtt nézni.
- A fent felsorolt VERIFIKÁLTAN ZÁRT scope-ok újra-auditja nem szükséges, hacsak új hívó/
  ingress nem kerül be (különösen: `agent-chat-runtime.setProjectKey` sink, ha új hívót kap).

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

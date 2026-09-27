# Production Audit napló

Napi éles-környezeti biztonsági és megbízhatósági audit. Minden bejegyzés egy
vizsgált scope-ot, a coverage-t, a bizonyított findingokat, a javításokat, az
ellenőrzéseket és a residual riskeket rögzíti. Cél: bizonyítható kockázatcsökkenés
és növekvő audit-coverage.

---

## 2026-09-26 — KB-keresés/-olvasás MCP-n (#678, `9be5b023`): nyers FTS-SQL, tenant-határ, HTML-ingest

**Scope-választás (kockázati alapon):** `gh pr list` + ledger után a legmagasabb **nem-auditált**
felület a **tudásbázis-lekérdezés MCP-n** (`kb_search`/`kb_get_document`/`kb_get_page`/`kb_ingest`/
`kb_list_index`) — külső, OAuth-hitelesített, **adat-kiszivárgás-osztályú** olvasó felület, amely a
napi ledgerben eddig **nem szerepelt** (csak a 09-24 MCP-írás-kör érintette a read-oldali méret-kapukat).
Egyúttal ez a felület kapta a legfrissebb, **legnagyobb** kódváltozást (#678 / `9be5b023`, +334 sor):
új nyers Postgres FTS-SQL (`hungarian` regconfig, `regexp_split_to_table` szakasz-vágás, IDF-rangsor),
szakasz-szintű raw-keresés és HTML-ingest. Friss + komplex + adat-felület = a legnagyobb új kockázat.

**Coverage (teljes bizalmi-határ + adatfolyam-trace, kézi end-to-end + kötelező scoped security scan):**
`executeKnowledgeBaseTool` (handlers/knowledge-base.ts — a `connectorId`/`tenantId` **szerver-feloldott**
`ctx`-ből, SOHA a tool-argsból; csak `documentId`/`path`/`section`/`query`/ingest-tartalom
támadó-vezérelt) → `KnowledgeBaseService.search`/`getDocument`/`getPage`/`listIndex`/`ingest` →
`PostgresDocumentRepository.searchRaw` + `PostgresKnowledgeChunkRepository.searchChunks` (nyers
`$queryRaw`), `assembleKbHits`/`rankKbHits`/`outlineSections`, `extractHtml`/`htmlToText`, 0011 migráció
+ apply-kb-fts index-script.

### Biztonsági megállapítás — NINCS finding (≥8 konfidencia); a felület helytáll

A kötelező scoped security scan (`/security-review`, dedikált felderítő + false-positive szűrő
sub-agent) **és** a független kézi end-to-end trace **egyaránt 0 bizonyítható, ≥8-konfidenciájú
kihasználható hibát** talált. Tételesen verifikálva (nem feltételezve):

- **SQL-injekció — nincs.** Minden támadó-befolyásolt érték **bound paraméterként** vagy **futásidejű
  függvény-argumentumként** jut a Postgresbe, sosem SQL-szövegbe fűzve. `KB_FTS_CONFIG =
  Prisma.sql`'hungarian'::regconfig`` konstans (nincs benne interpoláció). `tsquery` (`toKbTsQuery`)
  és a `terms` (`kbQueryTerms`) **csak `\p{L}\p{N}` tokeneket** enged (`token:*`/`unnest($n::text[])`),
  Prisma `$n`-ként köti — a `to_tsquery`/`regexp_split_to_table`/`unnest` mind adatként kapja.
  `KB_SECTION_SPLIT_SQL` modul-konstans, kötve. `connectorId`/`connectorIds` `::uuid`, kötve + trusted.
  Nincs malformed-tsquery hibaút sem (a token sosem üres). Az egyetlen `$executeRawUnsafe`
  (apply-kb-fts) hardcode-olt, dev/ops-only.
- **Cross-tenant / cross-connector — nincs.** `searchRaw`: `WHERE d.connector_id = ${connectorId}::uuid`;
  `searchChunks`: `c.connector_id IN (...)`; `getDocument`: `document.connectorId !== input.connectorId
  → found:false`; `getPage`/`listIndex`: `[connectorId]`-scope. Mindegyik `connectorId` a szerver-feloldott
  `ctx.connectorId`-ból (agent KB-connectora, tenant-kötött), nem argsból → hamisított `documentId`/`path`
  nem lép ki a connector-határból.
- **Adat-kiszivárgás a SELECT-ben — nincs.** Az újonnan lekért `d.extracted_text` **csak szerveroldalon**
  fogy (a szakasz-cím `kbSectionForSegment` számításához), nem kerül a visszaadott `KnowledgeRawHit`-be.
  A `matched` a hívó **saját** kérdésszavaiból származik; a `section` ugyanazon connector heading-útvonala.
- **HTML-ingest (XXE/SSRF/RCE/stored-XSS) — nincs.** `extractHtml` tisztán regex-`String.replace`
  (nincs XML/DOM-parser → nincs XXE; nincs hálózat → nincs SSRF; nincs `eval` → nincs RCE). A kimenet
  **minden tag-et eltávolít** (`htmlToText` záró `<[^>]+>`→''), és **szövegként** tárolódik/adódik vissza,
  nem renderelt HTML-ként → nincs stored-XSS a KB-tartalmon keresztül.

### Reliability / correctness — átvizsgálva, nincs adatvesztés/hibás-működés finding

- **SQL↔JS szakasz-vágás paritás.** A raw-találat `section`-je a SQL `regexp_split_to_table(...,
  KB_SECTION_SPLIT_SQL) WITH ORDINALITY` `ord`-ját a JS `splitKbSegments`-be indexeli (`ord-1`).
  Verifikálva: a Postgres ARE **támogatja** a `(?=…)` lookaheadet (a delimiter egyetlen `\n`,
  zero-width constraint-tel), így a vágás element-for-element egyezik a JS `String.split`-tel
  (vezető/köztes üres-szegmens szemantika is), beleértve a `\r\n` és a headingnélküli/vezető-heading
  eseteket. A round-trip (`kbSectionForSegment` → `kb_get_document({section})` → `findSection` exact/leaf/
  partial + `(n)` dedup) zárt.
- **IDF-rangsor pozíciós illesztés.** A service `k: okfChunkHits.length`-szel hívja az `assembleKbHits`-et,
  üres `memoryContent`/`docs` mellett → a visszaadott `okfHits` **hossza és sorrendje azonos** az
  `okfChunkHits`-szel, így a `okfHits[i] ↔ okfChunkHits[i]` (matched/rank) illesztés helytáll; a
  `rankKbHits` DF-je minden `matched` termre tartalmaz kulcsot (`df.get(term)!` biztonságos).
- **Migráció-drift-ellenállás (kapcsolódik a visszatérő 🔴 „deploy nem migrál" incidenshez).** A 0011
  GIN-index **csak teljesítmény** — a keresés **korrektsége index nélkül is helyes** (seq scan), a migráció
  explicit így dokumentálja. Az index-kifejezés `to_tsvector('hungarian'::regconfig, …)` **IMMUTABLE**
  (2-argumentumú, explicit regconfig) → az index-építés nem bukik. A `hungarian` snowball beépített (Neon).

### Ellenőrzések
- `npm run test:kb-retrieval` — **zöld** (21 assert; köztük `kbSectionForSegment` SQL↔JS mapping,
  `rankKbHits` IDF, egyedi útvonal-címek + jelöltlista, superseded raw-elrejtés).
- Kötelező scoped security scan (`/security-review`): dedikált felderítő sub-agent + FP-szűrés →
  **0 finding ≥8 konfidencián**, a fenti SAFE-kontrollok tételes (soronkénti) verifikációjával.
- **Nettó kód-változás e körből: 0** — nincs bizonyítható finding, ezért a szabály szerint (`csak
  bizonyítható finding alapján módosíts`) nincs kód-módosítás, nincs fix-PR és nincs `/code-review`
  (az a *létrehozott változtatásra* való). Precedens: 09-16 sandbox 0-finding kör. Az érték a **coverage**:
  a KB-lekérdezés/-ingest felület első dokumentált biztonsági + reliability-verifikációja, és a friss,
  magas kockázatú #678 változás igazolása.

### Residual risk / következő audithoz
- **🟡 SQL↔JS vágás-paritás csak JS-oldalon tesztelt.** A `test:kb-retrieval` a JS `splitKbSegments`-et
  futtatja, a **valódi** `regexp_split_to_table` viselkedést nem (stub-DB). A paritás elemzéssel igazolt
  (Postgres ARE lookahead-támogatás), de egy jövőbeli Postgres-verzióváltás vagy a regex/`KB_SECTION_SPLIT_SQL`
  konstans szétdriftelése **néma szakasz-félrecímkézést** okozhatna. Olcsó follow-up: egy `test:kb-gate`
  (valódi Neon-kompat. Postgres) paritás-assert (`regexp_split_to_table` ↔ `splitKbSegments`). Nem e-kör-
  finding (nem bizonyított hiba), de a legérdemesebb megerősítés.
- **🟡 `rankKbHits` pozíciós illesztés törékeny.** Ma helyes, de az `assembleKbHits` belső viselkedésére
  (üres memory/docs, okf-first, nincs átrendezés) épül; ha az `assembleKbHits` valaha szűr/átrendez, a
  matched/rank metaadat elcsúszhat. Defenzív alternatíva: a matched/rank a `hit` objektumon utazzon
  (nem külön párhuzamos tömbben). Nem bizonyított hiba → nincs e-kör-módosítás (ponytail: nincs spekulatív
  hardening).
- **Raw-keresés seq scan + szakaszonkénti `to_tsvector`** (ponytail-komment jelzi): korrekt, de a raw-korpusz
  növekedésével lassul; GIN/tárolt szakaszok az upgrade-út. DoS-osztály, scope-on kívül.
- **`kb_ingest` fájltípus-hamisítás/tartalom-vizsgálat** (magic-bytes/AV) változatlanul nyitva — l. idea #447;
  önálló, tágabb scope.

---

## 2026-09-24 — MCP resource-server írási felület (Gmail send/reply/draft/label/trash, #637): bizalmi határ + jóváhagyás-kötés + fejléc-injekció

**Scope-választás (kockázati alapon):** `gh pr list` + ledger után az utolsó bejegyzés
(09-17) óta egy **nagy MCP-hullám** ment main-re: **#637 teljes Gmail-írás az MCP-n**
(küldés/válasz/piszkozat/címke/kuka), #631 http_api path-illesztés, #635/#634/#632
projektmemória, #627 KB raw_text. Az egész **MCP resource-server** (`/api/mcp/[tenantSlug]`)
— külső, OAuth-hitelesített, most **író képességű** támadási felület — **nem szerepelt a
ledgerben**, és a #637 a legmagasabb új blast-radiusú változás (agent által vezérelt,
emberi jóváhagyás mögötti valós e-mail-küldés/kuka). Ez volt a legnagyobb nem-auditált kockázat.

**Coverage (teljes bizalmi-határ trace, kézi end-to-end):**
`route.ts` → `handleMcpRequest` (`withMcpAuth`, Clerk OAuth verify) →
`resolveMcpPrincipal` (token-verify → **foreign `aud`/`resource`-origin elutasítás** →
aktív user → **URL-slug szerinti tenant** → tenant-státusz → **aktív tenant-membership**
kötelező, különben `not_a_member`; superadmin → `assumed`; `userId`/`tenantId` SOHA a
tool-JSON-ból) → `tools/call` (allowlist-kapu `MCP_ALLOWED_TOOLS`) →
`invokeEnterpriseTool` (definitionId-kapu, `isDispatchable`, definition-pin/`agent_stale`,
`args.agentId` egyeztetés, `canOperateAgent` grant-kapu) → írónál `enqueueWrite`
(`enqueueGatewayOperation` → `loadAuthorizedWrite`: séma + `authorizeToolCall` connector/scope-
kapu + kötelező `idempotencyKey`) → jóváhagyás (`approveGatewayOperation`
`withLockedOperation` egyszer-használat, `pendingDecisionError` státusz+döntés-kapu) →
`executeApprovedOperation` (**újra-authorizál a kérő élő szerepével**, tenant-kötött,
token a kérő grantjából) → `executeGmailTool`/`GmailApiClient`. Melléksávok: write-confirm
MRTR-űrlap (#618, `argsHash`+`operationId`+principal-kötés a `requestState`-ben),
`gmail-api-client` MIME-építés, http_api path-allowlist (#631), read-oldali méret-kapuk.

### Biztonsági megállapítás — a bizalmi határ helytáll (nincs ≥ high-confidence finding)

Minden vizsgált kontroll explicit verifikálva (nem feltételezve):
- **Cross-tenant izoláció.** A tenant kizárólag az URL-slugból + kötelező aktív
  membershipből oldódik; idegen tenant URL-jére hitelesített nem-tag `not_a_member`-t kap.
  Token-`aud`/`resource` idegen originre elutasítva.
- **Jóváhagyás egyszer-használat + confused-deputy.** A gateway-operation zárolt
  státuszátmenettel egyszer fut; `canDecideGatewayOperation` csak a kérő vagy admin/approver;
  idegen tenant/operáció `operation_not_found` (nem szivárog). Végrehajtáskor **újra-authorizál**
  a kérő élő szerepével és grantjával — az approver jogai nem emelik a műveletet.
- **Fejléc-injekció (SMTP/MIME).** `headerValue` minden `To/Cc/Bcc/In-Reply-To/References`
  értékből kiszűri a CR/LF-et; a `Subject` RFC 2047 encoded-word (a nyers érték előbb CRLF-mentes).
  A válasz `In-Reply-To`/`References` az eredeti (támadó-vezérelt) levél fejléceiből jön, de
  ugyanazon a CRLF-szűrőn megy át. A MIME-boundary szerver-generált, nem input.
- **Scope-kapu.** Readonly Gmail-grant `gmail_scope_not_granted`-tal **már az enqueue-nál**
  elutasítva (teszttel igazolva).
- **http_api path-allowlist (#631).** A sablon adminvezérelt; a `{param}` szegmensen belüli
  regex `[^/]+` (nem lép szegmenshatárt), a szegmensszám egyeznie kell, a literál részek
  escape-eltek és `^…$`-horgonyzottak → a modellvezérelt `path` nem illeszt nem szándékolt
  endpointra. Traverzál (`..`) a szegmensszám-kapu miatt nem szökik ki a baseUrl-ből.
- **Read-oldali amplifikáció.** `gmail_search maxResults` ≤ 50, `list_drafts` ≤ 25 — az N+1
  metadata-lehívás korlátos.

### Residual risk / következő audithoz
- **🟠 Következmény-kapu láthatósági rés a Gmail-válasznál és piszkozat-küldésnél
  (transzparencia).** A write-confirm űrlap (#618) és a control-plane kártya a tárolt
  args-ból épül. **Válasznál** (`replyToMessageId`, nincs explicit `to`) a jóváhagyó csak
  „címzett: az eredeti feladó" / „(mindenkinek)" szöveget lát, a **konkrét címzett(ek)et
  nem** — az `resolveCompose` a valós címzettet csak *végrehajtáskor* oldja fel a Gmailből.
  **`gmail_send({draftId})`** esetén a kártyán csak az átlátszatlan draftId látszik, tartalom
  nélkül. Egy (akár prompt-injektált) modell így olyan levelet küldethet jóvá, amelynek
  címzettjét/tartalmát az ember nem látja — az „auditálható, ember által kontrollált AI-írás"
  ígéret réselődik. Azonos osztály, mint a korábban jegyzett `code-review-consequence-card-
  outbound-content`. **Nem lett kódmódosítás:** a rés bezárása a jóváhagyási úton élő
  Gmail-olvasást (token-feloldás az enqueue/confirm ágon) igényel — nem „lazy", viselkedést
  változtató fix, amit felügyelet nélküli futásban szándékosan nem erőltettem; felhasználói
  döntést kér (címzett/tárgy felbontása enqueue-kor vs. külön előnézeti hívás).
- **Válasz compose-only scope-pal fail-closed.** Ha egy grant csak `gmail.compose`, a válasz
  `getReplyContext` (messages.get) végrehajtáskor 403-mal bukik → `gmail_auth_failed`,
  művelet `failed`. Biztonságos hibamód, de rossz UX; érdemes az enqueue-scope-kapuban a
  `replyToMessageId` jelenlétekor olvasó scope-ot is megkövetelni (fail-fast).
- **`security-review` diff-eszköz nem futott** — a #637 már merged, a jelenlegi ág
  (feat/signal-design) nem tartalmazza; a felderítés a kézi end-to-end trace + a `gmail-mcp-tools`
  tesztfuttatás volt (precedens: 09-17 üres-diff eset).

### Ellenőrzések
- `npm run test:gmail-mcp-tools` — **zöld** (küldés jóváhagyás után pontosan egyszer;
  readonly grant enqueue-nál elutasítva; multipart body/cc/attachment olvasás).

---

## 2026-09-17 — Külső gateway (`POST /v1/chat/completions`): agent-API bizalmi határ + `x-agent-version` NaN költség-/audit-rés

**Scope-választás (kockázati alapon):** `gh pr list` + ledger után az előző körök az
OOM-ingress, a tool-diszpécser és a kódfuttató sandbox felületét fedték. A **külső,
hitelesített OpenAI-kompatibilis gateway** (`/api/v1/gateway/v1/chat/completions`) — a
platform egyik legmagasabb értékű külső támadási felülete (agent API-kulcs auth, tenant-
feloldás, költség/keret-kikényszerítés) — **nem szerepelt a napi ledgerben**, ezért ez volt
a legnagyobb nem-auditált kockázat. Az ág épp itt dolgozott (ticket confused-deputy), ami a
felület fontosságát is jelzi.

**Coverage (teljes bizalmi-határ trace):** `authenticateAgentRequest` → `authenticateApiKey`
(formátum-kapu → HKDF egyedi lookup-hash → `bcrypt.compare` + usability; legacy-út csak a
hash nélküli sorokat bcrypteli, backfillel) → `requireAgentScope` → `openAiChatCompletionSchema`
→ tenant-gate (`assertAgentWorkTenantOperable`, `ticket.tenantId ?? agent.tenantId`) →
`resolveGatewayRequestModel` + `RoutingEngine.resolve` (kliens `overrideHint` CSAK explicit
policy-engedéllyel; nincs policy → agent-config, az override eldobva). Melléksáv: **minden**
agent-API ingress cross-tenant kontextus-kapuja — `agent/tools`, `agent/tickets/[id]`,
`harness/tickets/[id]/process`, `agent/tickets` create — mind kikényszeríti a
`ticket.agentId === auth.agentId` / tenant-tulajdont; a `board_write` args-ticketId külön a
`referencedTicketIds`-be kerül; a connector a broker `authorizer`-én az agent grantjából
oldódik (nincs args-vezérelt `connectorId` IDOR); `resolveWorkspaceStorageTenantId` csak a
felső-szintű (kapuzott) `ticketId`/`conversationId`-ből választ tenantot.

### Biztonsági megállapítás — a bizalmi határ helytáll (nincs auth/IDOR finding)

Az auth, a scope, a cross-tenant kontextus-tulajdon, a connector-authz és a modell-override-
routing mind megfelelően kapuzott. A gateway `x-ticket-id` confused-deputy (idegen ticket
call-capjének fogyasztása) volt az utolsó rés, és azt a **felhasználó egyidejűleg javította**
(`386f4d548 fix(gateway): bind ticket usage to authenticated agent`, `isAgentApiToolContext­OwnedByAgent`
kapu a tenant-gate elé). A kötelező diff-alapú `/security-review` a **committálatlan** ág-állapoton
üres diffet kapott (az ág 0 branch-commit volt a munka idején), ezért a finding-felderítés a
kézi end-to-end trace volt.

### Bizonyított finding (correctness / cost-integrity, ≥9) — javítva

**`x-agent-version` NaN → néma költség- és audit-rés.** A gateway a fejlécet nyers
`Number.parseInt`-tel olvasta; nem-numerikus értékre (`x-agent-version: abc`) ez `NaN`, és a
`NaN ?? agent.currentVersion` **nem** esik vissza (a `NaN` nem nullish). A `NaN` továbbfolyt a
`services.gateway.call({ agentVersion })` → `modelCalls.create({ agentVersion })`-ba, ahol a
`ModelCall.agentVersion` **`Int?`**. A Prisma a `NaN`-t elutasítja — de a **fizetős
`provider.chat()` EKKOR MÁR lefutott** (`model-gateway.ts:2253` a hívás, `:2279` a rögzítés).
Következmény: valós provider-költség keletkezik, de a hívás **soha nem könyvelődik** a per-ticket
modellhívás-plafon, a keret-aggregátum és az auditnapló felé; a hívó 502-t kap. Egy hibás
verzió-fejlécet küldő kliens minden hívásnál láthatatlanul megkerülné a platform két
alapígéretét (**költség-kontroll + auditálhatóság**, AGENTS.md).

**Root-cause javítás a bizalmi határon** (PR **#512**, ág `fix/gateway-agent-version-header-validation`,
main-re bázisolva; a felhasználó WIP-je érintetlen — külön git worktree-ben készült):
- `app/src/lib/agent-version-header.ts` — `parseAgentVersionHeader`: csak nemnegatív egész, minden
  más `undefined` → a hívó `?? agent.currentVersion` fallbackje lép; `NaN` sosem keletkezik.
- `route.ts` — a nyers `parseInt` cseréje a határ-parserre (mind a 4 downstream site — normál és
  stub út — a közös `??` fallbackre esik).
- `app/scripts/agent-version-header.test.ts` — 12 eset + invariáns-loop: a visszaadott érték sosem NaN.

### Ellenőrzések
- `npm run test:agent-version-header` — **12 passed, 0 failed**.
- Matt Pocock `/code-review` (Standards + Spec, párhuzamos sub-agentek): **mindkét tengely „ship"**.
  Standards: 0 dokumentált-standard sértés; egy judgement-call (sibling `readPositiveInt` — nem
  használható, mert fallbackot ad és a `0`-t eldobja) → JSDoc-jegyzet hozzáadva. Spec: a fix a
  helyes egyetlen choke-pointon oldja meg, NaN egyik downstream siten sem jut át; a `3abc → 3`
  csonkolás szándékos és spec-konform (jegyzetelve).

### Residual risk / következő audithoz
- **`agentVersion` a chat-úton is `??`-ozódik** — ott `agent.currentVersion`-ból jön (nem fejléc),
  így a NaN-rés kizárólag a gateway-fejléc volt; más ingress nem olvas `x-agent-version`-t (grep-elve).
- **`3abc → 3` parseInt-csonkolás szándékos** (a cél a NaN kizárása). Ha később szigorú
  verzió-egyeztetés kell (a fejléc ↔ létező AgentVersion), az külön kapu — ma az agentVersion csak
  attribúció, nem authz.
- **Egyéb ingress-méret-kapuk (OOM) továbbra is nyitottak** (PR #445/#448/#443 merge-re vár) — az a
  külön, már ledgerezett munka.
- **A felhasználó ticket-ownership javítása (`386f4d548`) még az ágon van, nincs main-en** — a két
  változtatás logikailag független (más sorok), de a `package.json` scripts-blokk és a `route.ts`
  szomszédos hunkjai a two-branch merge-nél kézi egyeztetést kérhetnek; nem PR-blokkoló.

---

## 2026-09-16 — Kódfuttató sandbox (`sandbox_exec` / #485): agent-vezérelt tetszőleges kódfuttatás izolációja

**Scope-választás (kockázati alapon):** `gh pr list` + ledger után az összes eddigi kör
az OOM/ingress/tool-diszpécser felületet fedte. A `feat/485-code-sandbox` ágon egy **teljesen
új, még commitálatlan** (29 munkafa-fájl, 0 branch-commit) **kódfuttató sandbox** él: az agent
`sandbox_exec` toolon keresztül **tetszőleges parancsot/scriptet** futtat hívásonként új,
izolált sandboxban, workspace-fájlokat mountolva be/ki. Ez a platform **legmagasabb blast-radiusú
felülete** (RCE-osztály), és eddig **auditálatlan** volt → egyértelműen a legnagyobb kockázat.

**Coverage (a teljes végrehajtási lánc bejárva):** `sandbox-exec.handler.ts` → `CodeSandboxService`
(input/output méret-, fájlszám-, path-kapuk, atomikus visszaírás) → `HttpSandboxProvider`
(HTTP-protokoll, Cloud Run metadata identity token) → `code-sandbox-server.ts` →
`executeCloudRunSandbox` (`spawn` a `sandbox` CLI-re, mount-ok, output-begyűjtés) → `sandbox` CLI.
Melléksávok: consequence-gate (`sandbox_egress`), per-scope hívás/idő-keret
(`tool-broker-service.ts:432`), audit-surrogate (`tool-broker-support.ts:747`, kód SOHA nem
naplózódik, csak hash), connector-követelmény (`code_sandbox`+write), tenant-feloldás
(`resolveWorkspaceStorageTenantId`), admin-only server-action (`actions/code-sandbox.ts`),
deploy/Docker config.

### Biztonsági megállapítás — NINCS finding (≥8 konfidencia); az izolációs kontrollok helytállnak

A kötelező scoped security scan (`/security-review`, dedikált felderítő sub-agent) **és** a
független end-to-end kézi trace **egyaránt 0 bizonyítható, ≥8-konfidenciájú kihasználható
hibát** talált. Ellenőrzötten **SAFE** (mind explicit verifikálva, nem feltételezve):

- **Command injection — nincs.** `spawn(binary, argv)` shell nélkül; az agent `command[]`-je a
  `--` terminátor MÖGÖTT megy (nem injektálhat sandbox-flaget); provision fix `/bin/sleep 1000`;
  `env` az agent számára elérhetetlen (a service sosem ad át env-et).
- **Path traversal — nincs.** `normalizeSandboxWorkspacePath` (kontrollkarakter/backslash/abszolút/
  drive-betű/`..`/nem-kanonikus tiltás, `normalized===value` követelmény) app- ÉS szerveroldalon;
  `safeMountedPath` `resolve`+`startsWith(root+sep)`; a `file-editor` `resolveSafePath` rétege alatta.
- **Sandbox-escape output-linkkel — nincs.** `collectSandboxOutputs` `lstat`-tal **symlinket,
  nem-reguláris fájlt és hardlinket (`nlink!==1`) eldob** → a sandbox nem szivárogtathat ki
  host-fájlt `/work/out`-ba; csak az explicit kért (normalizált) output-ok kerülnek vissza.
- **Egress-kontroll — nincs split-brain.** A consequence-gate és a végrehajtás **ugyanazt a
  mappelt `invokeInput.args`-ot** olvassa; `boolArg` csak szigorú `true`-ra ad egresst; a runner
  `--allow-egress`-t csak `request.allowEgress===true`-ra fűz. `allowEgress:true` → **emberi
  jóváhagyás** (`sandbox_egress`). A hálózat-tiltás alapértelmezés a GCP Sandbox Launcher opt-in
  `--allow-egress` szemantikáján áll (megbízható infra, nem kód-defektus).
- **Szerver-authz — SAFE a deploy-konfiggal.** `authorizeSandboxRequest` token hiányában `true`-t
  ad (Cloud Run IAM a határ); a deploy `--no-allow-unauthenticated` (privát), token esetén
  hossz-ellenőrzés + `timingSafeEqual`.
- **Cross-tenant — nincs.** `scopeKey=ticketId??conversationId` runtime-kontextusból (nem agent-arg);
  tenant a közös `resolveWorkspaceStorageTenantId`-vel, a fájl-toolokkal azonos mintán; a
  server-action mind `requireTenantRole('admin')` + tenant-scoped `findFirst` (nincs IDOR).

### Reliability / correctness — átvizsgálva, nincs adatvesztés/hibás-működés finding

- **Atomikus output-visszaírás:** `writeOutputsAtomically` a régi tartalmat elmenti és hibára
  visszagörgeti (üres puffer is truthy → helyes restore; null=nem létezett → delete). Nincs
  adatvesztési ág normál futásban.
- **Failure-mode:** minden ág `finally`-ben `provider.destroy` + a runner saját `finally`-je
  `sandbox delete --force` → nincs árva sandbox; hiba esetén nincs parciális visszaírás.
- **Kill-switch:** `CODE_SANDBOX_ENABLED=false` globálisan, connectoronként lifecycle-tiltás.

### Ellenőrzések

- `npm run test:code-sandbox` — **zöld** (path-normalizálás elutasítások, egress consequence-gate
  `required` állapotok, EU-régió kényszerítés, symlink/hardlink output-elutasítás, provider
  teardown sikeren ÉS hibán, egress-default-false).
- Kötelező scoped security scan (`/security-review`): dedikált felderítő sub-agent + false-positive
  szűrés → **0 finding ≥8 konfidencián**, a fenti SAFE-kontrollok tételes verifikációjával.
- **Nettó kód-változás e körből: 0** — nincs bizonyítható finding, ezért a szabály szerint (`csak
  bizonyítható finding alapján módosíts`) nincs kód-módosítás, nincs PR és nincs `/code-review`
  (az a *létrehozott változtatásra* való; nincs ilyen). Az érték a coverage: a platform
  legmagasabb kockázatú (RCE-osztály) felületének első, dokumentált izoláció-verifikációja.

### Residual risk / következő audithoz

- **`authorizeSandboxRequest` fail-open token nélkül:** Cloud Runon IAM+privát ingress fedi, de
  **nem-Cloud-Run** deployon (a doc explicit említi ezt az utat) token-felejtés esetén az RCE-végpont
  auth nélkül nyitva. Hardening-javaslat (nem e-kör-finding, mert env/config admin-felelősség):
  fail-closed default nem-Cloud-Run providernél, vagy kötelező token, ha a provider nem `cloud_run`.
- **`baseUrl` ↔ `region` eltérés:** a Zod EU-régió-kényszer csak metaadat; a tényleges futtató a
  `baseUrl` (admin-állítja, nem validált a régióhoz). Adat-honosság (GDPR) szempontból a `baseUrl`
  a valódi döntő — admin-felelősség, de érdemes a mentéskor egyeztetni/figyelmeztetni. (Kapcsolódik:
  idea #413 adat-honosság.)
- **Egress-default a `sandbox` CLI-n múlik:** ha a GCP launcher valaha network-ON default-ra váltana,
  a jóvá-nem-hagyott (non-egress) futások hálózatot kapnának. Egy soros infra-verifikáció a launcher
  doksijával ajánlott; a kód opt-in, helyes.
- **Output-fájlszám/-méret kapu ALL `/work/out`-ra:** a runner az összes out/ fájlra számol
  (`maxFiles-files.length`), nem csak a kért output-okra → egy sok scratch-fájlt író script az
  egész futást „output_file_count_exceeded"-del bukhatja, hiába csak 1 output-ot kért. UX/megbízhatóság
  foot-gun a limiten belül, nem adatvesztés — opcionális follow-up (csak a kért output-okra számolni).
- **Precheck-race a per-scope keretnél:** ponytail-komment jelzi; Cloud Run `concurrency=1` ma szűkíti.
- **A feature még commitálatlan (0 branch-commit):** amíg nincs main-en/PR-ben, a fenti verifikáció
  a *jelenlegi munkafa-állapotra* érvényes; a merge előtti végső állapotot újra kell nézni, ha változik.

---

## 2026-09-15 — Halasztott tool-betöltés (#468 `tool_describe` + tool-index): describe-láthatóság ↔ hívhatóság

**Scope-választás (kockázati alapon):** `gh pr list` + ledger után az előző 5 kör
mind az OOM/törzs-méret-kapu felületet fedte (több nyitott OOM-PR merge-re vár —
azok átvezetése PR-menedzsment, nem új finding). A legnagyobb **nem-auditált** felület
a friss (09-14 main-re került) **#468 halasztott tool-betöltés**: a `tool_describe`
meta-tool + tool-index a **minden agent-fordulóra ható tool-diszpécser** kritikus úton
van, és eddig auditálatlan volt. Egy diszpécser-hiba blast-radiusa platform-szintű.

**Coverage:** `chat-tool-loop.ts` teljes `tool_describe`-ág + `activatedTools`
(preload ∪ skill ∪ prior ∪ checkpoint) + a D5 közvetlen-hívás-ág + a http_api
connector describe-blokk + a hívás-idejű kapuk (allow-list 2697, skill-hatókör 2714,
következmény-kapu) átnézve. `tool-registry.ts` `preload`/`toolIndexSummary`/drift-teszt
átnézve.

### Biztonsági megállapítás (NINCS finding) — a láthatóság authz-semleges

A jogosultság **invoke-időben** dől el, a láthatóságtól függetlenül: grant-allow-list
(2697), skill-hatókör (2714), broker/következmény-kapu — mind a describe/aktiválás
UTÁN, attól függetlenül fut. Ellenőrizve: (a) `tool_describe` **nem** ad ki nem-grantolt
tool sémát (`allowedTools.includes` kapu); (b) a connector-katalógus **agent-scoped**
(`findConnectorsForAgent(agentId)` → `describeBlocks` map, ismeretlen connectorId →
„nem elérhető"), nincs cross-tenant szivárgás; (c) D5 (le-nem-írt grantolt tool
közvetlen hívása) a skill-hatókör-kapu UTÁN aktivál, nem kerüli meg. **Nincs
cross-tenant / OOM / séma-szivárgás finding.**

### Finding 1 (CONFIRMED, low) — describe-láthatóság ≠ hívhatóság betöltött skill alatt

A `tool_describe` csak `allowedTools` (teljes grant) alapján kapuzott, a betöltött
skill hatókörét (`skillToolScope`) **figyelmen kívül hagyva**. Skill-szűkített futásban
a modell lekérhette a skill által kizárt (bár grantolt) tool sémáját — amit a hívás-kapu
(2714) utána úgyis elutasít. Describe és invoke **eltérő választ** adott → felesleges
modell-kör + pont a skill-hatókör-kapu által tiltott „kézi kerülőút" csábítása.
**Súlyosság:** alacsony (nincs titok-szivárgás: a séma nem érzékeny; nem cross-tenant;
a tool továbbra sem hívható). Megbízhatóság/UX + a skill-kontraktus konzisztenciája.

### Finding 2 (CONFIRMED, teszt) — stale `http_api` grant-kártya teszt = csendes hamis-zöld

A provider-független grant-kapu teszt közös `{ query:'x' }` inputot adott mindkét ágnak.
`gmail_search`-re érvényes (query=string), `http_api_get`-re **nem** (a séma `query`-t
`record`-ként várja) → a Zod-validáció a `buildToolInvokeInput`-ban a **broker ELŐTT**
dobott, így a http_api grant-kártya ág **sosem futott le** (a teszt nem azt mérte, amit
állított). Nem termék-bug (a grant-kártya éles úton helyes), hanem valódi **coverage-rés**.

### Javítás

- **Forrás (már main-en, `41f40d3d5`, PR #475 auto-merge):** a `tool_describe`-ág is
  `skillToolScope`-ra kapuz → hatókörön kívüli tool sémája „nem elérhető".
- **Drift-mentesítés (#477, review-driven):** egy `toolInSkillScope` predikátum a
  három hely helyett (tools[]-szűrés, describe-láthatóság, hívás-kapu 2714) — az
  invariáns nem drift-elhet szét inverz feltételekkel. Viselkedés változatlan.
- **Teszt (#477):** eszközönként érvényes args → a http_api grant-ág valódi lefutása,
  + új regresszió a hatókörön kívüli describe elrejtésére.

### Ellenőrzések

- `scripts/agent-tool-loop.test.ts` — teljes fájl **zöld** (új skill-hatókör describe
  assert + a javított http_api grant-ág). `tool-registry-drift.test.ts` zöld.
- `tsc --noEmit` + `eslint` tiszta az érintett fájlokra (a 2 megmaradt tsc-hiba —
  `scheduled-task-enterprise.test.ts`, `.next-local-auth` generált — **pre-existing**
  main-baseline, nem ebből a körből).
- Független `/code-review` (Matt Pocock, 2 párhuzamos axis):
  - **Standards:** nincs hard violation; a describe-predikátum a hívás-kapu pontos
    inverze („közös kapu / nincs drift" standardot erősíti). Egyetlen judgement-call
    (a hármas ismétlés drift-kockázata) **átvezetve** a `toolInSkillScope` predikátummal.
  - **Spec:** _defensible alignment, nem violation_ — a spec §1.3 „nem-leírt ≠
    jogosultsági állapot" a *fail-open* irányt (D5) védi; a nem-hívható séma elrejtése a
    *szigorúbb* irány, és a §1.3+D10 maga is a skill-hatókört hívhatóság-döntőnek nevezi.
    Nincs hibás implementáció.

### PR

- **#477** — `fix(tools): tool_describe kövesse a skill-hatókört — regresszió +
  drift-mentesítés` (branch `test/tool-describe-skill-scope-coverage`, `main`-ről).
- A forrás-fix (`41f40d3d5`) **már main-en** (a környezet automatizációja PR #475-öt e
  kör közben auto-merge-elte; a #468 forrás-fix ezért main-en, #477 a tesztet+refaktort viszi).

### Residual risk / következő audithoz

- **D2 index (stabil prefix) skill-hatókörön kívüli grantolt toolt is felsorol:**
  az index-blokk `allowedTools`-ból épül (D8: prior-független stabil prefix), így betöltött
  skill alatt olyan toolt is mutat, amit a modell most már **sem describe-olni, sem hívni**
  nem tud. Nem szivárgás (a név nem érzékeny), de UX/konzisztencia-rés — a skill-hatókör-jegyzet
  jelzi a valóban használhatókat. Follow-up: index is szűkíthető skill-hatókörre (a stabil-prefix
  cache-előny mérlegelésével).
- **Describe üzenet-paritás:** a hatókörön kívüli describe ugyanazt a terse „nem elérhető"-t
  adja, mint a nem-grantolt eset, míg a hívás-kapu (2714) gazdagabb „nincs a skill listájában"
  üzenetet ad. A modell így nem különbözteti meg a két okot — apró, spec-néma, opcionális UX-nicety.
- **`priorToolNames` wire↔belső név:** a `ToolCall.toolName` (belső név) egyezik az
  `allowedTools`-szal; ha valaha wire-néven tárolódna, csak +1 describe-kör az ára (nem authz).
- **Nyitott OOM-PR stack (#443/#445/#448) továbbra is merge-re vár** — a tartós OOM-kockázat
  csökkentése ezek átvezetése; a következő kör prioritása lehet.

---

## 2026-09-11 — Fájlfeltöltés (`formData()`) OOM: a scope MÁR javítva (#448) — duplikátum visszavonva + coverage-rés rögzítve

**Scope-választás (kockázati alapon):** a 09-09 kör lezárt residualja explicit ezt
jelölte a „legfontosabb követő"-nek: a multipart **fájlfeltöltés** — a két
`.../workspace/files` POST route (`tickets` + `conversations`) a `request.formData()`-tal
a teljes törzset memóriába pufferelte, és csak UTÁNA nézte az 50 MB-os kaput
(OOM ellen hatástalan). Ez közvetlenül a **nyitott Cloud Run OOM-incidens**
(`healthcheck-cloud-run-oom-concurrency`) vektora → a legmagasabb *gyakorlati* kockázat.

### Finding A (CONFIRMED, de MÁR JAVÍTVA) — méret-kapu a teljes törzs pufferelése UTÁN → OOM

Mindkét feltöltő route a `await request.formData()`-tal a teljes multipart törzset
memóriába pufferelte, MIELŐTT a `file.size > 50 MB` kapu lefutott volna → hitelesített
operátor tetszőlegesen nagy törzzsel OOM-kill-t válthatott ki. A finding valós; **de a
kódbázisban már nyitva van rá a kanonikus fix:** **PR #448**
(`fix/bounded-upload-formData-oom`, 09-10) — `lib/bounded-form-data.ts` /
`readBoundedFormData`. Ez a helyes, **erős** megoldás: Content-Length gyors-elutasítás
MELLETT egy streamelő `TransformStream` bájt-számláló megszakítja a parse-t a teljes
pufferelés BEFEJEZÉSE előtt — így a chunked / hiányzó / hazudott Content-Length
támadói utat is zárja. Mindkét route-on helyesen bekötve, `RequestBodyTooLargeError` →
413, a pontos per-fájl `file.size` kapu megtartva.

### Finding B (PROCESS/COVERAGE) — a 09-10 audit-kör terméke (#448) nem került a naplóba

A napló utolsó bejegyzése 09-09 volt; a 09-10 kör létrehozta #448-at, de sem a
`production_audit.md`-ben, sem a memóriában nem jelölte. Emiatt **ez a kör kockázati
alapon ugyanazt a (már megoldott) scope-ot választotta** és egy gyengébb, csak
Content-Length-alapú duplikátumot (#450) kezdett. **Tanulság / következő audithoz:** a
scope-választás ELŐTT a nyitott PR-eket (`gh pr list`) is nézni kell, nemcsak a ledgert —
több nyitott OOM-keményítő PR halmozódik (#443 process-input, #445 nyers-JSON,
#448 multipart), egyik sincs main-en.

### Tevékenység ebben a körben

- **#448 független verifikáció:** átnéztem a `readBoundedFormData`-t és a két route
  bekötését — korrekt, a streaming bájt-számláló a `Content-Length`-only megközelítésnél
  erősebb (zárja az attacker-path residualt). **Javaslat: #448 a kanonikus fix, mergelni.**
- **#450 (saját duplikátum) LEZÁRVA + branch törölve:** gyengébb (csak Content-Length),
  felesleges a #448 mellett. A zárás-komment rögzíti az okot.
- Nettó kód-változás e körből: **0** (a napló-bejegyzésen kívül) — a kockázatot #448 fedi.

### Residual risk / következő audithoz

- **#448 MERGE-re vár:** amíg nincs main-en, az OOM-vektor élesben nyitva marad. A
  három nyitott OOM-PR (#443/#445/#448) merge-sorrendje és CI-státusza a következő
  kör prioritása — új scope helyett ezek átvezetése csökkenti ténylegesen a kockázatot.
- **Tartós OOM-fix:** platform/ingress-szintű törzs-méret plafon (apphosting/Cloud Run)
  + a #114 runtime-szétválasztás; a nyitott OOM-incidenst NE jelöljük lezártnak #448
  merge-ével sem (csak a feltöltés-vektort zárja, nem a teljes párhuzamos-chat OOM-ot).
- **Malware / content-type hamisítás (idea #447):** változatlanul nyitva; külön, tágabb
  biztonsági kapu (magic-bytes + AV + makró-vizsgálat, karantén) — önálló scope, e kör
  NEM érintette.

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

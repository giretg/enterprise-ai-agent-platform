# AI Privacy Gateway — jegybontás

Forrás: **issue [#272](https://github.com/giretg/enterprise-ai-agent-platform/issues/272)** ·
spec: [`ai-privacy-gateway-spec.md`](./ai-privacy-gateway-spec.md) (v0.2, 2026-08-19, D1–D6 lezárva)

Beolvad: **#189** (érzékeny-adat maszkoló kapu) — ld. D6.

A bontás a spec §19 vertikális szeleteit követi: **M1** demózható végponttól végpontig,
minden további mérföldkő önmagában is szállítható. A jegyek a spec eldöntött kérdéseire
(D1–D6) és a review-tételekre (R1–R23) hivatkoznak, nem nyitják újra őket.

**Sorszám-előtag:** `[AI Privacy Gateway] APG-NN — …` · **mérföldkő:** `AI Privacy Gateway`

---

## Előfeltétel

## APG-00 — Spec a main-re + #189 lezárása

**Mérföldkő:** M0 · **Prioritás:** Magas · **Függés:** —

**Probléma:** a v0.2 spec ma csak a `claude/specification-review-refinement-gqrix9`
branch-en él (`09a3ea25`); a `docs/specs/ai-privacy-gateway-spec.md` a main-en nem
létezik, így minden alábbi jegy egy nem létező fájlra hivatkozna.

**Feladat:**
- A spec merge-e a main-re (a két commit: `7fe03b4b`, `09a3ea25`).
- #189 lezárása „beolvadt a #272-be" indoklással, hivatkozással a spec §6 / D6-ra.
- A mérföldkő és a címkék létrehozása (ld. `create-ai-privacy-gateway-issues.sh`).

**DoD:** a spec elérhető a main-en; #189 CLOSED, kereszthivatkozással.

---

# M1 — vertikális MVP (saját CRM + `company`)

Cél: **egy** agenten, **egy** tenanton, **egy** entitástípuson végigmegy a teljes lánc —
strukturált tool-output → surrogate → LLM → tool-arg feloldás → UI feloldás — OBSERVE módban.

## APG-01 — `surrogate_map` séma + 0030 migráció

**Mérföldkő:** M1 · **Prioritás:** Magas · **Függés:** APG-00

**Feladat:**
- Új Prisma modell `SurrogateMap` (tábla: `surrogate_map`) az alábbi kulcsokkal:
  `tenantId`, `scopeType` (`conversation` | `trace`), `scopeId`, `entityType`,
  `surrogate` (`[[COMPANY_1]]`), `class` (`ref` | `val`), `connectorId?`, `sourceId?`,
  `encryptedValue?`, `hmac`, `createdAt`.
- **Bijektivitás DB-szinten:** `@@unique([tenantId, scopeType, scopeId, surrogate])` és
  `@@unique([tenantId, scopeType, scopeId, entityType, connectorId, sourceId])` — a
  leképezés nem válhat kétértelművé párhuzamos fordulóknál sem.
- Index a retention-járathoz (`scopeType, scopeId`).
- Migráció: `app/prisma/migrations/0030_privacy_surrogate_map` (a legutolsó ma `0029_ticket_attachments`).

**Döntés (spec §6, D2):** a `ref` osztály **nem tárol nyers értéket**, csak
`(tenantId, connectorId, entityType, sourceId)` referenciát. A `val` osztály mezői
ebben a jegyben létrejönnek, de csak az APG-19 tölti őket.

**DoD:** `prisma migrate status` tiszta; valós-Postgres teszt bizonyítja, hogy két
párhuzamos allokáció ugyanarra az entitásra **ugyanazt** a surrogate-ot adja
(unique ütközés → újraolvasás, nem duplikátum).

> **Figyelem (repo-szokás):** a migrációt le is kell futtatni a dev DB-n
> (`prisma migrate deploy`) — több korábbi feature azon bukott, hogy a migráció
> a repóban készen állt, de sosem futott le.

---

## APG-02 — `domain/privacy/` mag: Surrogate Engine + vault-repository

**Mérföldkő:** M1 · **Prioritás:** Magas · **Függés:** APG-01

**Feladat:**
- Új modul `app/src/domain/privacy/`:
  - `surrogate-format.ts` — `[[COMPANY_1]]` képzés/parszolás, típus-névtér (D1).
  - `surrogate-engine.ts` — allokálás `(tenantId, scope, entityRef) → surrogate`,
    beszélgetésen belüli sorszámozás, konzisztencia.
  - `surrogate-vault.ts` — repository-interface + Postgres implementáció,
    HMAC-hitelesítés tenant-kulccsal (a HMAC **nem** kerül a surrogate szövegébe).
- **Terminológia (R16):** a kódban `surrogate`, a UI-ban „álnév". A `token` szót
  tilos használni (a kódbázisban már 4 jelentése van: LLM-token, `WriteGateToken`,
  `ChannelLinkToken`, OAuth-token).
- Feloldás **kizárólag vault-találaton**: a modell által kitalált `[[COMPANY_99]]`
  definíció szerint feloldhatatlan → `privacy.surrogate.unknown` audit (§5).

**DoD:** egységtesztek a bijektivitásra, a sorszámozásra, a HMAC-ellenőrzésre és a
kitalált álnév elutasítására. A modul még nincs behuzalozva sehova.

---

## APG-03 — Connector privacy metadata + capability-deklaráció

**Mérföldkő:** M1 · **Prioritás:** Magas · **Függés:** APG-00

**Forrásrendszer-oldali szerződés** (CRM/ERP fejlesztőnek, UI-ajánlással):
[`ai-privacy-source-system-contract.md`](./ai-privacy-source-system-contract.md).

**Feladat:**
- A connector `config` mezőséma bővítése (spec §7):
  `{"company_name": {"privacy": "tokenize", "entity_type": "company", "source_id": "crm/company/4821"}}`.
- Capability-deklaráció a `ConnectorSpecVersion` capabilitySet-jébe (spec §11):
  `structured_field_privacy`, `stable_entity_ids`, `entity_resolution`, `free_text_hints`.
  A deklaráció verziózott, változása auditált.
- Zod-validáció: `privacy: tokenize` **csak string mezőre** (numerikus/dátum sosem — R6).
- A saját CRM connector felcímkézése `company` entitástípusra (D5).
- Privacy-interface **nélküli** connector továbbra is működik, de a platform alacsonyabb
  privacy capability-t jelez (UI + audit).

**DoD:** validációs teszt: numerikus mezőre tett `tokenize` mentéskor elbukik, érthető
hibaüzenettel; a CRM connector capabilitySet-je tartalmazza a deklarációt.

---

## APG-04 — Strukturált tool-output pszeudonimizáció a broker `modelText` csatornáján

**Mérföldkő:** M1 · **Prioritás:** Magas · **Függés:** APG-02, APG-03

**Ez a feature determinisztikus magja** — ha valami elkészül, ez.

**Probléma/anchor:** a Tool Broker már ma két csatornát ad
(`app/src/domain/tool-broker/tool-broker-service.ts:336` — `modelText` / `machineData`,
ld. `tool-result-envelope.ts` doc-comment). A pszeudonimizáció **kizárólag** a
`modelText` ágon fut; a `machineData` (munkaterület, downstream tool, export) **nyers marad**.

**Feladat:**
- A privacy transform beékelése a `resolveToolOutputContract` / kimeneti szerződés
  validációja **UTÁN** (`tool-broker-service.ts:311` környéke) — enélkül egy `email`
  formátumú mezőbe tett `[[EMAIL_3]]` elbukna a séma-validáción (R6).
- Tömbök / ismétlődő rekordok: a mezőnkénti leképezés a válaszon belül stabil.
- A `machineData` érintetlenségét teszt rögzíti (red-line).

**DoD:** ENFORCE-szimulációban a jelölt mező nyers értéke **nem** jelenik meg a
`modelText`-ben; a `machineData` bitre azonos a nyerssel; a contract-validáció zöld marad.

---

## APG-05 — Tool-argumentum feloldás a brokerben (§10.1)

**Mérföldkő:** M1 · **Prioritás:** Magas · **Függés:** APG-04

**Enélkül a feature nem működik:** ha az LLM `get_revenue(company="[[COMPANY_1]]")`-et
hív, minden pszeudonimizált entitáson elhasal a tool-hívás.

**Feladat:**
- Feloldás a `ToolBrokerService.invoke()`-ban, az **authorizer után**
  (`tool-broker-service.ts:224`), a connector-hívás **előtt**.
- A feloldott nyers érték **csak** a tool-argumentumba kerül, a modell contextjébe **soha**.
- `ToolCall.argsMeta` a **surrogate-alakot** naplózza, nem a nyers értéket.
- Ismeretlen álnév → kontrollált tool-hiba a modellnek (javíthat) + `privacy.surrogate.unknown` audit.

**DoD:** teszt: surrogate-tal hívott tool a valódi source ID-val éri el a connectort;
`argsMeta`-ban a surrogate szerepel; ismeretlen álnév nem hív ki, hanem hibát ad vissza.

---

## APG-06 — Megjelenítési feloldás a web UI-ban, streaming-biztosan (§10.2, §10.4)

**Mérföldkő:** M1 · **Prioritás:** Magas · **Függés:** APG-02

**Probléma:** a válasz SSE-deltákban érkezik, az álnév karakterei **több delta között
szétszakadhatnak** (`[[COMP` | `ANY_1]]`). Töredék álnév soha nem jelenhet meg.

**Feladat:**
- `StreamingSurrogateResolver` a `StreamingSensitiveTextRedactor` pufferelési mintájára
  (`app/src/domain/gateway/sensitivity-router.ts:546` — soft flush / overlap / hard buffer /
  `finish()` ürítés). **Ne másold** a kódot: emeld ki a közös pufferelést.
- Behuzalozás a chat-stream fogyasztóknál
  (`app/src/domain/agent/chat-tool-loop.ts:1522`, `agent-chat-runtime.ts:1713` mintájára).
- Alapértelmezés a web UI-ra: **teljes feloldás** (bejelentkezett, tenant-scope, jogosult résztvevő).

**DoD:** teszt karakterenkénti deltákkal: a felhasználó sosem lát `[[COMP`-ot;
a forduló végén nem marad benn puffer.

---

## APG-07 — Renderelési biztonság: feloldás csak szöveg-node-ban (§10.3) — **red-line**

**Mérföldkő:** M1 · **Prioritás:** Magas (biztonsági) · **Függés:** APG-06

**Probléma:** a pszeudonimizáció **új exfiltrációs utat nyit**. Ha a modell az álnevet
URL-be ágyazza (`https://evil.example/?c=[[COMPANY_1]]`), a naiv „cseréld vissza a végén"
logika a **nyers értéket teszi egy aktív linkbe** — a kattintás vagy egy auto-betöltő kép kiviszi.

**Feladat:**
- Feloldás **csak szöveg-node-ban**. URL-ben, markdown-link célban, HTML-attribútumban és
  kódblokkban az álnév **marad**, és a UI jelzi, hogy ott feloldatlan érték van.
- A markdown-renderelő sanitizálása (külső kép- és link-célok) — **előfeltétel**, nem opció.
- Kapcsolódó nyitott tétel: a workspace inline-HTML egress ügye (`img-src https:` kép-beacon,
  PR #205) ugyanezt a felületet érinti.

**DoD:** regressziós teszt-szett (red-line): link-cél, kép-`src`, HTML-attribútum,
inline kód és kódblokk — mind **feloldatlanul** marad; sima szöveg feloldódik.

---

## APG-08 — Feloldási scope-invariáns: tenant + conversation + résztvevő (§10.5)

**Mérföldkő:** M1 · **Prioritás:** Magas (biztonsági) · **Függés:** APG-02

**Feladat:** a vault-lookup nem lehet globálisan címezhető. Feloldás csak akkor, ha
**mindhárom** teljesül: (1) azonos tenant, (2) azonos conversation/trace scope,
(3) a kérő a beszélgetés jogosult résztvevője (a meglévő conversation-hozzáférés szerint).
Bukás → `privacy.resolve.denied` audit, nem néma üres válasz.

**DoD:** **valós-Postgres invariáns-teszt** (nem mock): idegen tenant surrogate-ja nem
oldható fel; azonos tenant, másik beszélgetés surrogate-ja sem; nem-résztvevő user sem.
Mindhárom auditot ír.

---

## APG-09 — OBSERVE mód, kill-switch hierarchia és privacy-audit

**Mérföldkő:** M1 · **Prioritás:** Magas · **Függés:** APG-04

**Feladat:**
- Üzemmód: `OFF` | `OBSERVE` | `ENFORCE` (§13), hierarchia **platform → tenant → agent**
  a meglévő `PlatformSetting` kill-switch mintára. Ebben a jegyben OFF és OBSERVE él;
  az ENFORCE az APG-14.
- OBSERVE: a rendszer megállapítja és logolja, mit pszeudonimizálna, de az LLM-bound
  adatot **nem módosítja**.
- Audit-események a hash-láncolt auditba: `privacy.transform.applied`,
  `privacy.transform.observed`, `privacy.resolve.applied`, `privacy.resolve.denied`,
  `privacy.surrogate.unknown`. Tartalom: kategória, akció, **érintett spanek száma**, scope —
  **soha a nyers érték**.

**DoD:** OBSERVE módban egy CRM-fordulón mérhető a fedettség; teszt bizonyítja, hogy az
audit-payload semmilyen ágon nem tartalmaz nyers entitásértéket.

---

## APG-10 — Latency-budget: entitástérkép-cache + batchelt vault-írás

**Mérföldkő:** M1 · **Prioritás:** Közepes · **Függés:** APG-04

**Probléma:** a transzformáció a **kritikus úton** van; egy több ezer soros CRM-lista
válaszidőben érzékelhető.

**Feladat (§15):**
- Célérték: **p95 ≤ 50 ms / 100 KB szöveg**, teljes forduló-overhead **p95 ≤ 80 ms**.
- Vault-írás fordulónként **batchelve, egy tranzakcióban** (ne rekordonként).
- Beszélgetés-szintű entitástérkép-cache: a history append-only, a már feldolgozott
  prefix eredménye újrahasznosítható.
- Metrika a meglévő observability-rétegbe (`privacy_transform_duration_ms`).

**DoD:** benchmark-teszt 100 KB-os szintetikus tool-válaszon, a p95 rögzítve;
N+1 DB-írás kizárva (lekérdezés-számláló teszttel).

---

# M2 — policy és összevonás a sensitivity-routerrel

## APG-11 — Kategória-policy: `allow | tokenize | local_only | block` + a mai kapcsoló migrációja

**Mérföldkő:** M2 · **Prioritás:** Magas · **Függés:** APG-09

**Feladat (§2, R1):**
- Kategóriánkénti akció minden entitás-/mintakategóriára (`company`, `person`, `email`,
  `phone`, `account`, `taj`, `adoszam`, `pan`, `iban`, `secret_key`, tenant-egyedi minták).
- Feloldási hierarchia platform → tenant → agent.
- **Kemény invariánsok:** `secret_key` soha nem `tokenize` (marad `block`);
  a `pan` / `iban` `allow` értéke superadmin-jog + külön megerősítés mögött
  (a mai `forbidden` invariáns nem gyengülhet).
- A mai mindent-vagy-semmit kapcsoló (`agents.allow_sensitive_external_model`,
  olvasó: `app/src/domain/index.ts:528`) **migrációval** kategória-policyvé képződik le;
  a régi mező deprecated, az olvasók átállnak.

**Nyitott, itt eldöntendő (spec §21):** a policy tárolási helye — `PlatformSetting` kulcs
vs. dedikált tábla (a redesign-spec D1-e ugyanez). A mintakészlet verziózása auditálandó.

**DoD:** migrációs teszt: a ma `allowSensitiveExternalModel=true` agentek viselkedése
nem változik; `secret_key: tokenize` mentése elbukik; `pan: allow` superadmin nélkül elbukik.

---

## APG-12 — Végrehajtási sorrend: privacy transform **előbb**, osztályozó a maradékon

**Mérföldkő:** M2 · **Prioritás:** Magas · **Függés:** APG-11

**Anchor:** `app/src/domain/gateway/model-gateway.ts:1410` — `prepareModelCall` ma
`classifyPrompt(params.messages)`-szel indul. A transzformáció **elé** kerül:

```
messages → 1. privacy transform (ÚJ) → 2. classifyPrompt (MA) → 3. guardrail + routing (MA)
```

**Miért:** (a) így nem lesz két versengő privacy-döntéspont; (b) megszűnik a
redesign-spec P5 UX-csapdája — ma **egyetlen e-mail-cím véglegesen `sensitive`-be
billenti** az egész beszélgetést, pszeudonimizálva viszont már nem.

**DoD:** regressziós szett a meglévő sensitivity-viselkedésre (blokk, helyi-kényszer,
override) — mind zöld; új teszt: pszeudonimizált e-mail-cím után a beszélgetés `clean`
marad és külső modellen fut.

---

## APG-13 — ENFORCE mód + fail-closed / fail-open mátrix

**Mérföldkő:** M2 · **Prioritás:** Magas · **Függés:** APG-12

**Feladat (§15) — rétegenként eltérő hibapolicy:**

| Réteg | Hibánál |
|---|---|
| Strukturált, explicit jelölt mező (§7) | **fail-closed** — a modellhívás megáll, audit + emberi visszajelzés |
| Known-value substitution (§8/2) | fail-closed, ha a forrásérték strukturált mezőből jön; egyébként fail-open |
| Best-effort scanner / user-input resolver (§8/3, §9) | **fail-open** + audit — a workflow nem áll meg |
| Vault elérhetetlen | **fail-closed** minden pszeudonimizált útra (a feloldás sem működne) |

**DoD:** hibainjektálásos teszt mind a négy sorra; a fail-closed ág érthető, magyar
hibaüzenetet ad a felhasználónak (nem stack trace-t).

---

## APG-14 — Admin UI: kategória-policy szerkesztő + dry-run teszter

**Mérföldkő:** M2 · **Prioritás:** Közepes · **Függés:** APG-11

**Feladat:**
- Kategória-policy szerkesztő (platform / tenant / agent szint, öröklés láthatóan jelölve).
  Kiindulás: `app/src/components/agents/sensitivity-policy-form.tsx`.
- **Dry-run teszter:** beillesztett szövegre megmutatja, mit pszeudonimizálna a rendszer,
  élő modellhívás nélkül.
- Üres állapot: ha nincs privacy-metadata-val bíró connector, a felület mondja meg
  **közérthetően**, mit kell előbb beállítani — ne üres táblázat fogadja.
- Minden technikai fogalomhoz egymondatos magyarázat („álnév", „OBSERVE", „ref/val").

**DoD:** a felület magyarul, zsargon nélkül elmagyarázza, mi történik; a dry-run
egyetlen külső hívást sem indít.

---

## APG-15 — Prompt-cache invariáns: surrogate sosem megosztott prefixben

**Mérföldkő:** M2 · **Prioritás:** Közepes-Magas · **Függés:** APG-12

**Probléma (R7):** conversation-scoped álnév megosztott, cache-elt prefixbe (skill-szöveg,
közös rendszerinstrukció) kerülve **cache-szennyezést és rossz feloldást** okoz — az egyik
beszélgetés `[[COMPANY_1]]`-e a másikéra oldódna.

**Feladat:** a pszeudonimizált tartalom mindig a cache-határ **utáni**, nem megosztott
szegmensben van (`app/src/domain/gateway/prompt-cache.ts:95` — `resolveCacheBreakpoints`).
Kapcsolódik a nyitott prompt-cache prefix-sorrend spechez.

**DoD:** teszt: a cache-breakpointok elé kerülő szegmens **soha** nem tartalmaz
`[[…]]` mintát — akkor sem, ha a skill-szöveg maga tartalmazna hasonlót.

---

# M3 — szabad szöveg és user input

## APG-16 — Known-value substitution magyar toldalék-tűrő illesztéssel

**Mérföldkő:** M3 · **Prioritás:** Közepes · **Függés:** APG-13

**Probléma (R11):** magyarul az entitásnév ragozódik — *SPAR-nak, SPAR-ral, Sparnál,
a Sparban*. Exact match itt semmit nem ér.

**Feladat (§8/2):**
- Normalizálás (kisbetűsítés, ékezet-tűrés, elválasztójel-normalizálás).
- Toldalék-tolerancia: szótő + magyar ragmorféma-lista, kötőjeles toldalékolással.
- Szótár-illesztés **Aho–Corasick** automatával a tenant entitásnevein (több ezer névre skálázik).
- Szóhatár-ellenőrzés a hamis pozitívok ellen.
- **ML-alapú NER nélkül** (§17) — determinisztikus, nulla LLM-token, auditálható.

**Nyitott, itt eldöntendő:** a toldalék-lista pontos terjedelme és a szótár-frissítés
(connector-oldali entitásnév-szinkron) ütemezése.

**DoD:** címkézett magyar mintán mért **recall ≥ 80%**, **false positive ≤ 5%** (§20);
a mérés reprodukálható teszt-fixture-ből.

---

## APG-17 — User-input resolver + connector `resolve()` contract

**Mérföldkő:** M3 · **Prioritás:** Közepes · **Függés:** APG-16

**Feladat (§9, §11):**
- Platform-oldali **candidate extraction**; a tényleges feloldást a connector
  `resolve(text, entity_type?)` interfésze adja (találat / több találat / nincs találat).
- A platform **nem** tart fenn globális alias-adatbázist minden connector minden entitásához.
- **Második védelmi vonal:** ha a prompt előtti felismerés nem sikerült, de az LLM később
  strukturált tool callban használja a nevet (`get_revenue(company="SPAR")`), a platform
  a tool boundary-n újra megkísérli a forrásoldali feloldást.
- Sikertelen felismerés → a nyers név továbbmehet: **elfogadott, dokumentált
  maradékkockázat** (§16), nem hiba.

**Nyitott, itt eldöntendő:** confidence threshold a `resolve()` találatoknál, és a
többértelmű entity resolution UX-e (kérdezzen vissza vagy hagyja nyersen?).

**DoD:** teszt mindhárom `resolve()` kimenetre; a tool-boundary-s második kísérlet
bizonyítottan lefut, ha az első nem talált.

---

## APG-18 — val-surrogate + per-conversation adatkulcs + crypto-shredding

**Mérföldkő:** M3 · **Prioritás:** Magas (adatvédelmi) · **Függés:** APG-16

**Probléma (R2/D2):** a naiv „vault = értékmásolat" modell **második PII-példányt** hozna
létre. A val-surrogate ezért csak ott keletkezik, ahol nincs stabil source ID
(szabad szöveges találat, user-input).

**Feladat (§6, R15):**
- Titkosított értékmásolat: tenant-kulcs + **per-conversation adatkulcs**.
- Retention a **meglévő** sémára kötve, új retention-fogalom nélkül:
  `RetentionPolicy` (`app/prisma/schema.prisma:2360`), `Conversation.retainUntil` (`:1932`),
  `Conversation.legalHold` (`:1933`), `Message.contentDeletedAt` (`:2014`).
- Beszélgetés törlésekor a **per-conversation adatkulcs törlődik** → a val-surrogate-ok
  kriptográfiailag visszafejthetetlenné válnak (crypto-shredding).
- Legal hold alatt a kulcs megmarad.
- A ref-surrogate eleve nem tárol értéket → ott a **forrásoldali törlés automatikusan átüt**
  (GDPR törlési jog).
- Garbage collection járat a lejárt mappingekre.

> **Figyelem:** a repóban van már egy „implementálva, de sosem fut" mintájú retention-tétel
> (`retentionSweep`, #117). A GC-járatnak **éles hívója** is kell, ne csak függvénye.

**Nyitott, itt eldöntendő:** a vault fizikai technológiája (külön tábla + KMS-envelope vs.
dedikált secret store) és a GC-járat ütemezése.

**DoD:** teszt: beszélgetés törlése után a val-surrogate **nem** oldható fel;
legal hold alatt igen; a GC-járatnak van bizonyítottan futó éles hívója.

---

# M4 — kiterjesztés

## APG-19 — Egress-mátrix a csatornákra (§10.2)

**Mérföldkő:** M4 · **Prioritás:** Magas (adatvédelmi) · **Függés:** APG-13

**Probléma (R4):** a „trusted UI" **nem** az egyetlen kimenet. A platform Telegramon,
platform e-mailben, ticket-kommentben, export/riport fájlban és debug-log exportban is
kiad szöveget — ezek egy része a bizalmi határon **kívülre** megy.

**Alapértelmezett mátrix (tenant-szinten szigorítható):**

| Egress | Feloldás |
|---|---|
| Web UI (bejelentkezett, tenant-scope, jogosult résztvevő) | teljes |
| Telegram / külső csatorna (`app/src/domain/channel/`) | entitástípusonként (D3): `company` engedhető, `person` / `email` / `account` alapból **nem** |
| Platform e-mail-értesítés | alapból **nem** |
| Export / riport fájl | policy szerint, auditált eseménnyel |
| Debug-log export (`app/src/domain/debug-log/debug-log-export.ts:181`), audit log, `model_calls` napló | **soha** |

**Nyitott, itt eldöntendő:** az egress-mátrix felületi konfigurálhatósága
(tenant admin vs. superadmin).

**DoD:** csatornánkénti teszt; **egyetlen** közös feloldó-nyelő az összes egress-úton
(ne szóródjon szét — a repóban ez a hibaminta már többször visszatért).

---

## APG-20 — Memória-chunkok lefedése (D4)

**Mérföldkő:** M4 · **Prioritás:** Közepes-Magas · **Függés:** APG-12

**Probléma (§12, D4):** a memória-chunkok ma `system` üzenetként injektálódnak
(`app/src/domain/memory/memory-runtime-helper.ts`, `memory-retrieval-service.ts`), és
így megkerülik az osztályozást — ez a sensitivity-router redesign-spec **P4 rése**.

**Feladat:** a memória-chunkok is áthaladnak a privacy transzformáción, ugyanazon a
közös úton, mint a `user` / `assistant` / `tool` üzenetek. Vigyázni kell az APG-15
prompt-cache invariánsra: a memória-blokk a cache-határ **után** van.

**DoD:** teszt: memória-chunkban lévő védett entitás pszeudonimizálva megy a modellhez;
a P4 rés lezárva.

---

## APG-21 — Debug-trace pszeudonimizált projection

**Mérföldkő:** M4 · **Prioritás:** Közepes · **Függés:** APG-19

**Feladat (§12):** a platform a trusted zónában **nyers** logot tarthat, de ha egy
debugging AI elemzi őket, a `get_debug_trace()`-szerű API **pszeudonimizált projectiont**
ad. Nincs szükség külön privacy-log adatbázisra. Egy trace-en belül ugyanaz az entitás
konzisztensen ugyanazt az álnevet kapja (trace-scope), hogy a modell követni tudja az
eseményláncot.

**DoD:** teszt: a debug-trace tool kimenetében nincs nyers entitásérték; a trace-en belüli
konzisztencia bizonyított.

---

## APG-22 — Privacy observability UI (§14)

**Mérföldkő:** M4 · **Prioritás:** Közepes · **Függés:** APG-09

**Feladat:**
- A user a **valódi** értéket látja („SPAR Magyarország"); szín/kiemelés jelzi a védett
  entitást; hover/debug panel mutatja az entitástípust és a transzformáció státuszát.
  Normál usernek a technikai álnév **nem** jelenik meg.
- Admin/debug nézet lánca:
  `Original input → Privacy transformation → Actual LLM input → LLM output → Feloldott user output`.
- OBSERVE módban ez a felület a **false positive / false negative** gyors felderítésére szolgál.
  Építhető a meglévő `inspectPromptSensitivity` maszkolt snippet + pozíció kimenetére.

**DoD:** OBSERVE-ban egy valós CRM-fordulón végigkövethető a lánc; a felület magyar,
zsargon nélküli, és van üres állapota.

---

## APG-23 — Eval-metrikák és red-line szett

**Mérföldkő:** M4 (mérés M1-től folyamatosan) · **Prioritás:** Magas · **Függés:** APG-09

**Feladat (§20, R22):** a meglévő `Eval` / `EvalRun` modellekre és a
`app/src/lib/prompt-eval-red-lines.ts` keretre építve.

| Metrika | Cél v1-ben |
|---|---|
| Strukturált, jelölt mező recall | 100% (definíció szerinti, teszttel bizonyítva) |
| Szabad szöveges recall (címkézett magyar mintán) | ≥ 80% |
| False positive ráta | ≤ 5% |
| Latency overhead (p95, teljes forduló) | ≤ 80 ms |
| Workflow failure rate változása OBSERVE → ENFORCE | ≤ +1% |
| **Válaszminőség-romlás pszeudonimizált prompton** | **≤ 5%** |
| Ismeretlen/érvénytelen álnév aránya a modell outputjában | ≤ 1% |

**A kiemelt sor a lényeg:** a pszeudonimizáció **ronthatja a modell válaszminőségét** —
ezt **mérni kell, nem feltételezni**. Ez dönti el a §5 kontextus-hint
(`COMPANY_1 = kiskereskedelmi lánc, HU`) bekapcsolását is, ami tudatos csere:
kevés kontextus-szivárgás jobb válaszminőségért.

**DoD:** a szett futtatható, a hét metrika riportolt; a válaszminőség-mérésnek van
pszeudonimizált **és** nyers ága, hogy a különbség számszerű legyen.

---

## Függőségi térkép

```
APG-00 ─┬─ APG-01 ── APG-02 ─┬─ APG-04 ─┬─ APG-05
        │             │      │          ├─ APG-09 ─┬─ APG-11 ── APG-12 ─┬─ APG-13 ─┬─ APG-16 ── APG-17
        │             │      │          │          │                    │          │      └─ APG-18
        │             │      │          └─ APG-10  │                    │          └─ APG-19 ── APG-21
        │             │      │                     │                    ├─ APG-15
        │             ├─ APG-06 ── APG-07          │                    └─ APG-20
        │             └─ APG-08                    ├─ APG-14
        └─ APG-03 ────────────┘                    └─ APG-22, APG-23
```

**A kritikus út M1-ben:** APG-01 → APG-02 → APG-04 → APG-05. A többi M1-es jegy
párhuzamosítható.

## GitHub issue-k (létrehozva 2026-08-19)

A mérföldkő: [`AI Privacy Gateway`](https://github.com/giretg/enterprise-ai-agent-platform/milestone/1).

| Jegy | Issue |
|---|---|
| APG-00 | #274 |
| APG-01 | #275 |
| APG-02 | #276 |
| APG-03 | #277 |
| APG-04 | #278 |
| APG-05 | #279 |
| APG-06 | #280 |
| APG-07 | #281 |
| APG-08 | #282 |
| APG-09 | #283 |
| APG-10 | #284 |
| APG-11 | #285 |
| APG-12 | #286 |
| APG-13 | #287 |
| APG-14 | #288 |
| APG-15 | #289 |
| APG-16 | #290 |
| APG-17 | #291 |
| APG-18 | #292 |
| APG-19 | #293 |
| APG-20 | #294 |
| APG-21 | #295 |
| APG-22 | #296 |
| APG-23 | #297 |

## Nem cél (a jegyekben se kerüljön be)

- Teljes, visszafejthetetlen anonimizálás.
- A forrásrendszerek access-control modelljének lemásolása.
- Garancia arra, hogy semmilyen adat soha nem jut LLM-hez.
- **Csatolmányok (PDF, kép) tartalmának pszeudonimizálása** (R17/D5) — v1-ben rájuk a
  meglévő sensitivity-policy (blokk / emberi jóváhagyás) marad. OCR-kiterjesztés külön fázis.
- ML-alapú NER a v1-ben.

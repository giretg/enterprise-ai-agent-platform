---
name: tulajdoni-lap-crm-frissites
title: Tulajdoni lap → Ostoros Föld frissítés
description: Tulajdoni lap összevetése az Ostoros Föld nyilvántartással, majd a különbségek közvetlen végrehajtása a Föld API-n (ownership létrehozás/módosítás/törlés). Használd, ha tulajdoni lap alapján kell frissíteni az Ostoros Föld rendszert, ha „írd át a tulajdonosokat a rendszerben", vagy ha hrsz-re kérnek Föld-szinkront — nem Excel egyeztető táblát.
max-wall-clock-ms: 900000
max-tool-calls: 60
preferred-mode: task
attachment-description: Csatolj egy tulajdoni lapot!
allowed-tools: tulajdoni_lap_egyeztetes, http_api_get_all, http_api_get, http_api_request, file_write, reconcile_records, tulajdoni_lap_parse
---

# Mi a feladat

Kiolvasni a tulajdoni lapból a valós tulajdonosi összetételt, összevetni az
Ostoros Föld nyilvántartással, majd a különbségeket **a Föld API-n végrehajtani**
(ownership létrehozás / módosítás / törlés). Egy futás = egy tulajdoni lap =
egy parcel tulajdonosi állapota az Ostoros Föld-ben = **egy proposal-csomag**.

Ez **nem** az Excel-egyeztető skill. **Ne készíts és ne ígérj Excel-táblát** —
a deliverable az Ostoros Föld API-n indított módosítás (draft) és annak szöveges
összefoglalója. Ha a felhasználó csak Excel-táblát kér, mondd el, hogy ez a
Föld-frissítő skill, és javasold a `tulajdoni-lap-egyeztetes` skillt.

# Két kemény szabály

**Írj a Föld-be — egyeztetés után, az összes eltérésre.** A
`http_api_request` (POST/PUT/PATCH/DELETE) ebben a skillben **engedett és
kötelező a célhoz**. A platform író hívásai emberi jóváhagyásra (HITL /
consequence gate) mehetnek: készítsd elő a hívásokat, ne kerülgesd a kaput.

**A Föld draft ugyanaz a szerep, mint az Excel-tábla.** Az Ostoros Föld
ownership POST/PATCH/DELETE ebben a környezetben **csak draft / proposal
állapotot** hoz létre vagy módosít — a tényleges nyilvántartás-változás előtt
a Föld-en belül **emberi ellenőrzés és jóváhagyás** történik. Nincs külön
„előszűrés emberi döntésre” a tervben: minden eltérést vidd be draftként, a
Föld-beli jóváhagyás dönt.

**Csomagolni kell — Föld proposal-szerződés.** A Föld API elvárása egyértelmű:

- *„Egy föld korrekciója = egy csomag”*
- *„proposalId nélkül minden hívás új egytételes csomagot nyithat”*
- `X-Proposal-Id` / `body.proposalId` **kötelező** összefüggő Ownership-írásoknál
- A `proposalId` **CSAK** a Föld által visszaadott azonosító (cuid, pl. `cmsei…`)
- **TILOS** kliensoldali UUID / placeholder (pl. `11111111-1111-4111-8111-…`) —
  a Föld 404-et ad: *„Javaslatcsomag nem található”*

Tehát egy parcel összes ownership POST/PATCH/DELETE tétele **ugyanabba** a
proposal-csomagba tartozik. A csomagot **előbb** nyisd meg (`POST /proposals`),
a válasz `body.id`-jét tedd a checkpointba, és **minden** Ownership-írásnál
add át (`headers["X-Proposal-Id"]` **és** `body.proposalId`). `proposalId`
nélkül minden hívás külön egytételes csomagot nyithat — ez a szerződés
megszegése, ne csináld.

Emiatt:

- **ne** állj meg „túl kockázatos / nincs biztonságosan végrehajtható művelet"
  indokkal, ha van eltérés (bizonytalan párosítás / joggyakorló-gyanú / széljegy
  sem ok a megállásra);
- **ne** tedd meg a kockázatkerülést az Excel-egyeztető tábla javára;
- ha a connector írási joga megvan, hívd az `http_api_request`-et a terv
  **minden** tételeire; a Föld draft-jóváhagyás az emberi kapu.

**A kimeneti formátumot ne kérdezd meg** — ez a skill Föld-írás. Csak akkor állj
meg kérdezni, ha a lap ellenőrzése bukott, ha a nyilvántartás lekérdezése
kétséges, vagy ha a Föld body-sémája nem egyértelmű a katalógusból / meglévő
rekordból. Bizonytalan párosítás **nem** megállási ok: draftold, és a válaszban
jelezd.

**Ne gyűjts a kontextusba. Ne párosíts a modellben.** Nagy API-válasz / parse-
eredmény SOHA ne kerüljön teljes egészében a promptba, és 10+ soros listát NE
olvass össze `file_read` chunkokkal. Mentés / kivonat → **egyeztető eszköz** →
a modell csak a metaadatot, az összegzést és az eltérő sorokat látja — ezekből
épül a Föld műveleti terv.

# Tiltott anti-minta (budget-gyilkos)

NE csináld:
- `tulajdoni_lap_parse` tulajdonos-nézet lapozása a kontextusba
- `http_api_get` az `/ownerships` (vagy partner/névsor) path-ra — **mindig** `http_api_get_all`
- `http_api_get` page=1,2,3… sorozat (helyette `http_api_get_all`)
- első get-oldal `tool_result_extract` → `nyilvantartas.json` (csonka lista)
- ugyanazt a JSON fájlt sokszor `file_read`-del offset/limit-tel
- kézi párosítás / `xlsx_create` + `xlsx_append_rows` cellázás
- `kimenet: "….xlsx"` megadása az egyeztetőnek, vagy Excel átadása deliverable-ként
- Föld-írás megtagadása „kockázat" / „bizonytalan párosítás" / „emberi ellenőrzés kell"
  / „nincs extract a skillben" miatt — a `tool_result_read` / `tool_result_extract`
  infrastruktúra, és az `elteroPath` a teljes ownership-id lista
- Föld-írás egyeztetés nélkül, vagy „Rendben" sorokra
- Ownership-írások `proposalId` / `X-Proposal-Id` nélkül (minden hívás külön
  egytételes csomagot nyithat) — egy parcel korrekciója = **egy** csomag
- kliens generált / kitalált `proposalId` (UUID, placeholder) — csak a Föld
  `POST /proposals` válasz `id`-je érvényes
- `POST /proposals` + Ownership-írások **ugyanabban** a kapu-batchben előre
  kitalált ID-vel — előbb nyisd a csomagot, kapd meg az `id`-t, **azután**
  sorold az Ownership tételeket
- mezőnevek kitalálása 400/422 után találgatással — előbb katalógus / meglévő rekord

# A menet: gyűjtés → egyeztetés → műveleti terv → Föld írás

## 0. Checkpoint

Minden lényeges lépés után frissítsd (vagy hozd létre) a
`fold_frissites_progress.json` fájlt a munkaterületen:

```json
{
  "hrsz": "043/15",
  "parcelId": "…",
  "proposalId": null,
  "nyilvantartasPath": "nyilvantartas.json",
  "pagesFetched": "all",
  "muveletekPath": "fold_muveletek.json",
  "status": "nyilvantartas_ready"
}
```

A `proposalId` a `POST /proposals` sikeres válasza után kitöltendő (a Föld
`body.id`-je) — a folytatás és az összes Ownership-hívás ebből dolgozik.
Kliens UUID / placeholder ide **nem** kerülhet.

Ha a futás megszakad, a következő forduló EBBŐL indul — ne kezdd elölről.

## 1. A nyilvántartás — EGY `http_api_get_all` hívás

A tulajdonosi rekordokat az Ostoros Föld API-n keresztül éred el.

1. Találd meg a parcel-t (ha kell: `http_api_get_all` `/parcels`, vagy egy
   konkrét hrsz-szűrés). Jegyezd meg a `parcelId`-t — a Föld írás ehhez kötött.
2. Ownership / partner névsorhoz **KÖTELEZŐ** az **`http_api_get_all`**
   (`/parcels/{id}/ownerships` vagy ekvivalens). **TILOS** sima
   `http_api_get` erre a path-ra — az gyakran csak az első oldalt adja
   (pl. 50 sort), és az egyeztetés százas hamis „Új rekord" sort gyárt.
3. Ha a válasz archívumba / `tool-outputs/…http_api_get_all…` fájlba került:
   az **eredeti, változatlan** tool-kimenetet add át közvetlenül
   `nyilvantartasPath`-ként az egyeztetőnek. A `partnerNev` / `id` / `jogcim`
   mezőaliasokat az egyeztető normalizálja.
   `tool_result_extract` csak akkor kell, ha a válasz más alakú.
4. Frissítsd a checkpointot (`parcelId`, `nyilvantartasPath`).
5. A teljes listát NE olvasd vissza `file_read` / `tool_result_read`-del.

Ha a lekérdezés üres listát ad, az nem azt jelenti, hogy minden tulajdonos új.
Előbb győződj meg róla, hogy a helyrajzi számot a végpont elvárt formátumában
adtad át. Ha nem tudod eldönteni, kérdezz — ne tippelj, és **ne írj**.

Ha az egyeztető `ok: false` + csonka-lista figyelmeztetést ad: **ne** írj a
Föld-be — hívd újra `http_api_get_all`-lal, majd az egyeztetést.
`confirmNyilvantartasComplete=true` csak akkor, ha get_all után is ennyi a sor.

## 2. Az egyeztetés — EGY hívás

```
tulajdoni_lap_egyeztetes({
  documentId: "…",                  // vagy path: "043_15 2026.07.16.pdf"
  nyilvantartasPath: "tool-outputs/15-http_api_get_all-….json"
})
```

Ez a hívás elvégzi a lap kiolvasását és a párosítást. **Ne bontsd szét.**
**Ne add meg a `kimenet` paramétert** — nélküle a tool **nem** ír Excel-t.
A Föld műveleti terv forrása:
- `elteroPath` (tipikusan `egyeztetes-eltero.json`) — a **teljes** kompakt
  eltérő lista `azonosito` (ownership id) + hányad mezőkkel;
- a válaszbeli `eltero` csak rövid minta; `elteroDb` a teljes darabszám.

Ha `elteroPath` megvan: **EGY** `tool_result_read` az `elteroPath`-ra (infra-
eszköz; workspace JSON-t is olvas, nem csak tool-archívumot), abból építsd a
`fold_muveletek.json`-t, majd hívd az `http_api_request`-eket.
Az író hívások a ticket felületén jóváhagyásra várnak — ez rendben van, ne állj
meg „nincs eszköz" indokkal. Tipikusan **két kapu-kör** kell: (1) csak
`POST /proposals`, (2) az összes Ownership írás a visszaadott `id`-vel.
A „Mind jóváhagyom" az adott kör tételeit engedi; a feladat utána MAGÁTÓL
folytatódik — ne kérd meg, hogy indítsa újra a ticketet, és ne kérj szöveges
„ok"-t.
Excel csak a `tulajdoni-lap-egyeztetes` skillben kell (`kimenet` megadásával).

A `tulajdoni_lap_parse`-ot csak akkor hívd, ha az egyeztetésen túl kell
magyaráznod valamit (törölt bejegyzések, terhek).

Frissítsd a checkpointot: `"status": "egyeztetes_done"`, `"elteroPath": "…"`.

Ha az egyeztető `partial` / „emberi ellenőrzést igényel" figyelmeztetést ad:
ez **nem** tiltja a Föld-írást. Draftold az eltéréseket; a Föld-beli jóváhagyás
az emberi ellenőrzés. A válaszban sorold fel a bizonytalan / figyelmet igénylő
tételeket.

## 3. Műveleti terv — `fold_muveletek.json`

Az eltérő sorokból állíts össze egy rövid, végrehajtható tervet, és írd fájlba
(`file_write`). Egy sor = egy tervezett Föld hívás:

| Egyeztető státusz | Föld művelet | Tipikus path |
| --- | --- | --- |
| Új rekord | POST (create ownership) | `/parcels/{parcelId}/ownerships` |
| Módosítás szükséges | PATCH | `/parcels/{parcelId}/ownerships/{ownershipId}` |
| Törlés szükséges | DELETE | `/parcels/{parcelId}/ownerships/{ownershipId}` |
| Rendben | semmi | — |

Szabályok a tervhez:

1. **Minden eltérés a tervbe.** Bizonytalan párosítás, joggyakorló-gyanú, széljegy
   miatti vitás tétel is — draftold; a megjegyzésben / válaszban jelezd a
   bizonytalanságot, hogy a Föld-beli jóváhagyó közérthetően lássa.
2. **Ownership id** az `eltero[].azonosito` mezőből jön (PATCH/DELETE path).
   Új rekordnál null — ott nincs ownership id. Ha Módosítás/Törlés sornál hiányzik:
   állj meg és jelezd (ne tippelj id-t).
3. **Partner.** Új ownershiphoz kell `partnerId`. Először keresd
   `http_api_get_all` `/partners` (search / szűrés) a név (+ születési adat)
   alapján. Ha nincs partner: hozd létre `POST /partners`-szel a connector
   katalógus body-sémája szerint — de csak ha a név/születési adatok a
   tulajdoni lapból egyértelműek. Tippelni tilos.
4. **Body mezők.** Ne találj ki mezőneveket. Forrás sorrendben: (a) connector
   endpoint-katalógus / OpenAPI body, (b) egy meglévő ownership rekord alakja
   a get_all válaszból, (c) ha még mindig kétséges → kérdezz. Tipikus mezők a
   Föld API-n: `partnerId`, `hanyad` (tört string), esetleg `jogcim`.
5. **Hányadösszeg.** A Föld 422-t adhat, ha a parcel ownership hányadai nem
   adnak 1-et. Tervezd meg a sorrendet: először a PATCH-ek (aránymódosítás),
   aztán a POST-ok, végül a DELETE-ek — vagy ha egyértelmű átruházás, preferáld
   a `/parcels/{id}/ownership-transfer` végpontot, ha a katalógusban elérhető.
6. **Egy csomag / proposalId.** A terv tetején legyen `proposalId` (kezdetben
   `null`). Egy föld korrekciója = egy csomag: az összes Ownership-írás
   ugyanarra a **Föld által kiadott** `proposalId`-re megy. Partner-keresés /
   `POST /partners` nem Ownership-írás — azok a csomagon kívül történhetnek;
   a létrehozott `partnerId`-t az Ownership POST body-ba tedd. A `proposalId`-t
   **ne** generáld előre.
7. **Idempotency-Key vs. X-Proposal-Id.** Az `Idempotency-Key`-t a platform
   automatikusan küldi — azt **ne** töltsd a `headers`-be. Az
   `X-Proposal-Id`-t viszont **igen**: összefüggő Ownership-írásoknál kötelező
   (`headers["X-Proposal-Id"]` **és** `body.proposalId` = a Föld `id`-je).

Példa terv (kivonat):

```json
{
  "parcelId": "seed-parcel-…",
  "proposalId": null,
  "items": [
    {
      "action": "patch",
      "statusFromEgyeztetes": "Módosítás szükséges",
      "nev": "Kovács János",
      "path": "/parcels/seed-parcel-…/ownerships/own-…",
      "method": "PATCH",
      "body": { "hanyad": "1/2" },
      "megjegyzes": null
    }
  ]
}
```

Checkpoint: `"status": "muveletek_ready"`, `"muveletekPath": "fold_muveletek.json"`.

## 4. Végrehajtás — `http_api_request` (egy csomagban)

A terv **minden** Ownership elemére hívd az `http_api_request`-et, sorban (vagy
a tervben rögzített biztonságos sorrendben), **ugyanazzal a `proposalId`-vel**.
Író connector kell (olvasás + írás); ha a connector read-only, állj meg és
jelezd — de **ne** helyettesítsd Excel-táblával a Föld-írást.

**Csomagolási menet (kötelező — `POST /proposals` előbb, nem kliens-UUID):**

1. Ha a checkpoint / terv már tartalmaz **érvényes, Föld által kiadott**
   `proposalId`-t (folytatás): használd azt az **összes** Ownership-írásnál.
   (Ha a korábbi ID UUID / placeholder / 404-et kapott: dobd el, nyiss új
   csomagot a 2. pont szerint.)
2. **Kötelező út — `POST /proposals` előbb (külön kapu-kör):**
   - Csak ezt az egy írást állítsd sorba: `POST /proposals`
     body pl. `{ "cim": "<hrsz> tulajdoni lap frissítés" }`.
   - Jóváhagyás után a válaszból vedd ki a `body.id`-t (cuid) — ez a
     `proposalId`. Írd a checkpointba és a `fold_muveletek.json`-be.
   - **Csak ezután** sorold az összes Ownership PATCH/POST/DELETE-et ugyanezzel
     az `id`-vel. TILOS ugyanabban a kapu-batchben összerakni a
     `POST /proposals`-t és az Ownership írásokat előre kitalált ID-vel.
3. Ismert (Föld-kiadott) `proposalId` mellett minden Ownership-írásnál küldd:
   - `headers: { "X-Proposal-Id": "<proposalId>" }`
   - `body.proposalId: "<proposalId>"`
   (mindkettőbe ugyanazt az értéket).
4. **TILOS** Ownership-írást `proposalId` nélkül indítani — minden ilyen hívás
   új egytételes csomagot nyithat. **TILOS** kliens UUID / placeholder
   `proposalId`. A Föld 404 *„Javaslatcsomag nem található”* = rossz/nem
   létező ID — ne tippelj újat; hívd újra a `POST /proposals`-t.
5. Használd a kitöltött **Ostoros Föld API** connectort (ne üres Autfresh /
   hiányos katalógust) — a `POST /proposals`, `GET /proposals`,
   `GET /proposals/{id}` és az Ownership író végpontok a katalógusban legyenek.

**EGY korrekció = egy csomag, a teljes terv.** Ha a Föld-kiadott `proposalId`
már megvan, a fennmaradó Ownership tételeket **ne** hagyd későbbre
összefoglaló miatt: állítsd sorba ugyanazzal az ID-vel. A kapuzott hívás nem
hiba. A tételenkénti megállás összefoglalóval, vagy a csomagolás elmaradása
széttöredezett egytételes proposalokat szül — ez a szerződés megszegése.

Emlékeztető: ezek a hívások **draftot** indítanak a Föld-ben (egy proposal-
csomagban); a véglegesítés Föld-beli emberi jóváhagyáshoz kötött. Ne torzítsd
le a futást „kockázatos írás" / „részleges egyeztetés" indokkal, és ne kérj
külön Excel-ellenőrzést a draft helyett.

Minden hívás után frissítsd a tervet / checkpointot (`proposalId`, `applied` /
`failed` / `awaiting_approval`). Ha HITL jóváhagyásra vár: ne indíts
párhuzamosan ellentmondó törlést ugyanarra a rekordra — de a következő
tételeket ugyanabba a csomagba sorold.

Ha 400/422: **ne tippelj új body-t vakon**. Olvasd el a hibát, egyeztesd a
katalógussal / meglévő rekorddal; ha nem egyértelmű, kérdezz. Ha részben már
írva van, a válaszban mondd el, mi ment át és mi nem — ne kezdd elölről a
teljes parcel állapotot.

Ha Ownership írás `404` + *„Javaslatcsomag nem található”* / `outcome=empty`:
ez **sikertelen** futás — mondd ki számszerűen (pl. `0/89 ownership draft`),
javítsd a `proposalId`-t a 2. pont szerint, és **ne** állíts
`"status": "fold_done"`-t, amíg a terv tételei nem mentek át.

Sikeres kör után opcionálisan ellenőrizhetsz egy új
`http_api_get_all` `/parcels/{id}/ownerships` hívással (ne parse-old a teljes
listát a kontextusba — elég a darabszám / rövid kivonat).

Checkpoint: `"status": "fold_done"` — **csak** ha az Ownership tételek
ténylegesen lefutottak (nem 404 / nem empty).

## 5. A válasz

Fogalmazd meg:

- hány rekord volt rendben, hány Föld művelet (draft) készült / platform
  jóváhagyásra vár / elutasítva / sikertelen,
- a **proposalId** (egy Föld-kiadott csomag) és a végrehajtott
  POST/PATCH/DELETE tételek névvel és hányaddal,
- hogy a Föld oldalon a draft-csomag még emberi jóváhagyásra vár a véglegesítés
  előtt,
- a bizonytalan / figyelmet igénylő tételek (bizonytalan párosítás, joggyakorló-
  gyanú, széljegy) — ezek is draftban vannak, de a jóváhagyónak külön figyelni
  kell rájuk,
- a lap kelte (`meta.kelt`) — a szinkron csak ehhez képest érvényes.

Ha a kapu utáni Ownership írások elbuktak (pl. rossz `proposalId` → 404):
**ne** kerüld meg „nem tudom igazolni a csomagolást” szófordulattal — mondd ki,
hogy sikertelen volt, mi volt a hiba, és mi a következő lépés.

A hányadokat emberi szövegben százalékkal add meg, a törtet legfeljebb
zárójelben. Ne ígérj „kész / végleges Föld állapotot", ha HITL vagy Föld draft-
jóváhagyás még függőben van, vagy részleges / sikertelen volt a futás. **Ne**
zárd Excel-fájl átadásával a választ.

# Ha az ellenőrzés bukik

Ha a hatályos hányadok összege nem 1, az egyeztető `ok: false` — **ne írj a
Föld-be**. Mondd el az összeget, és kérdezd meg, hogyan folytassuk. Szemle
másolatnál teljes másolat kell a földhivataltól.

# Domain tudás (ugyanaz, mint az egyeztetőnél)

- **Hatályos vs. törölt.** A lap történeti napló; csak a hatályos sorok számítanak.
- **Egy személy = sok bejegyzés.** Az egyeztető összegez — a Föld-ben általában
  egy ownership rekord / partner a cél; ne hozz létre annyi ownership sort,
  ahány II. rész sorszám van, ha a nyilvántartás összevont alakot vár.
- **Joggyakorló ≠ tulajdonos.** „Tulajdonosi joggyakorló" (NFK, MNV, stb.)
  a nyilvántartásban külön rekordként gyakran „Törlés szükséges"-ként jön ki —
  draftold a törlést, és a válaszban / megjegyzésben jelezd, hogy joggyakorló
  lehet; a Föld-beli jóváhagyó dönt.
- **A terhek nem tulajdonosok.** Haszonélvezet / jelzálog nem ownership
  POST/PATCH cél, hacsak a felhasználó kifejezetten terhet kér (akkor a
  `/encumbrances` végpontok, külön döntéssel).

# Folytatás megszakadás után

Ha a futás időkorlát vagy eszközkeret miatt leállt, **ne kezdd elölről**: nyisd
meg a `fold_frissites_progress.json`-t és a munkaterület fájljait.

- Ha a nyilvántartás megvan: NE kérdezd le újra; hívd az egyeztetőt (ha még
  nem kész).
- Ha a `fold_muveletek.json` megvan: NE egyeztess újra — folytasd a még nem
  alkalmazott / nem jóváhagyott műveletekkel, a meglévő `proposalId`-vel
  (ne nyiss új csomagot).
- Ha egy írás már sikeres volt: ne ismételd ugyanazzal a body-val vakon; nézd
  meg a checkpoint `applied` listáját és a `proposalId`-t.
- TILOS újra: parse a teljes lapra, felesleges `http_api_get_all` ugyanarra a
  pathra, chunkolt `file_read` a már meglévő JSON-okon.

---
name: tulajdoni-lap-fold-frissites
title: Feldolgozott tulajdoni lap → Ostoros Föld frissítés
description: A PDF-feldolgozó agent verziózott tulajdoni-lap JSON handoffjának összevetése az Ostoros Föld nyilvántartással, majd minden eltérés draftolása, validálása és beküldése a Föld API-n. Használd egy Folyamat második lépéseként, amikor `feldolgozottLapPath` áll rendelkezésre; ez a skill nem olvassa és nem parse-olja újra a PDF-et.
max-wall-clock-ms: 900000
max-tool-calls: 150
preferred-mode: task
allow-attachments: false
allowed-tools: tulajdoni_lap_egyeztetes, http_api_get_all, http_api_get, http_api_request, file_read, file_write
---

# Feladat

Vedd át az előző agent `feldolgozottLapPath` eredményét, vesd össze a benne lévő
hatályos tulajdonosi állapotot az Ostoros Föld nyilvántartásával, majd az összes
eltérést hajtsd végre egyetlen Föld proposal-csomag draftjaként.

Ez a skill **nem PDF-feldolgozó**. Ne használj `documentId`-t, PDF `path`-ot vagy
`tulajdoni_lap_parse`-ot. Ha csak PDF érkezett, állj meg, és kérd az első
folyamatlépés (`tulajdoni-lap-pdf-feldolgozas`) `ready` eredményét.

# Kötelező bemeneti szerződés

A bemenet tartalmazza:

- `status: ready`
- `feldolgozottLapPath`: workspace JSON path
- az ingatlan megnevezését vagy helyrajzi számát

A fájl elvárt sémája `kind: "tulajdoni_lap_feldolgozas"`, `schemaVersion: 1`.
Az egyeztető fail-closed módon ellenőrzi. `blocked` előző lépés vagy hibás séma
esetén ne hívd a Föld API-t.

Ha a hrsz nincs külön átadva, a `file_read` eszközzel csak a handoff elejét
olvasd be a `parsed.meta.ingatlanMegnevezes` és `parsed.osszesites.valid`
ellenőrzéséhez. A tulajdonoslistát ne lapozd a kontextusba.

# Kemény szabályok

**Írj a Föld-be** egyeztetés után, minden eltérésre. Az `http_api_request`
engedett és kötelező. A platform HITL / consequence gate jóváhagyása elvárt;
ne kerülgesd.

**A Föld draft az emberi ellenőrzési felület.** Ownership POST/PATCH/DELETE csak
draftot hoz létre; a véglegesítés a Föld UI-ban emberi jóváhagyás. Draftold az
összes eltérést, de approve/reject műveletet ne végezz.

**Egy föld = egy proposal-csomag.** Előbb `POST /proposals`, és kizárólag a
válasz `body.id` értékét használd `proposalId`-ként. Minden Ownership-írásnál
kötelező ugyanaz az `X-Proposal-Id` fejléc és `body.proposalId`. Kliens UUID,
placeholder vagy külön egytételes csomag tilos.

**Záró menet:** Ownership írások → platform coverage →
`POST /proposals/{id}/validate` → javítás és újravalidálás → csak `valid:true`
után `POST /proposals/{id}/submit`. Validate nélkül vagy `valid:false` mellett
submit tilos.

Nagy listát ne olvass a kontextusba, és ne párosíts a modellben. A handoff fájl,
az eredeti `http_api_get_all` tool-output és a determinisztikus
`fold_muveletek.json` maradjon a workspace-ben.

# Menet

## 0. Checkpoint

Tartsd naprakészen a `fold_frissites_progress.json` fájlt:

```json
{
  "feldolgozottLapPath": "feldolgozott-tulajdoni-lap-043-15.json",
  "hrsz": "043/15",
  "parcelId": "…",
  "proposalId": null,
  "nyilvantartasPath": "tool-outputs/…http_api_get_all….json",
  "pagesFetched": "all",
  "muveletekPath": "fold_muveletek.json",
  "status": "nyilvantartas_ready"
}
```

`proposalId` kizárólag a Föld válaszából jöhet. Megszakadás után a checkpointból
folytasd, ne kezdd elölről.

## 1. Parcel és teljes nyilvántartás

1. A handoff metaadatából azonosítsd a hrsz-t, majd keresd meg a parcel-t.
2. Jegyezd fel a `parcelId`-t.
3. Az `/parcels/{id}/ownerships` listát egyetlen `http_api_get_all` hívással
   kérd le. Sima `http_api_get` és kézi page=1,2,3… lapozás tilos.
4. Az eredeti tool-output path legyen a `nyilvantartasPath`; ne extracteld és ne
   olvasd vissza a teljes listát.

Üres lista nem jelenti automatikusan, hogy minden tulajdonos új. Előbb ellenőrizd
a hrsz formátumát. `confirmNyilvantartasComplete=true` csak akkor használható,
ha a `get_all` után is ténylegesen ennyi rekord van.

## 2. Egyeztetés a handoffból

Pontosan egy hívással dolgozd fel a két workspace-forrást:

```json
{
  "feldolgozottLapPath": "feldolgozott-tulajdoni-lap-043-15.json",
  "nyilvantartasPath": "tool-outputs/…http_api_get_all….json",
  "parcelId": "…"
}
```

Ne adj `documentId`-t, PDF `path`-ot vagy `kimenet` Excel-pathot. Az eszköz a
handoffot használja, ezért nem parse-olja újra a PDF-et. Kimenete:

- `egyeztetes-eltero.json`
- `fold_muveletek.json`, teljes `items[]` listával, DELETE → PATCH → POST sorrendben

A terv az egyetlen végrehajtási forrás. Ne építsd újra, ne írd felül az `items`
listát, és ne találj ki ownership id-t. `partial` vagy emberi ellenőrzési jelzés
nem tiltja a draftot; a válaszban jelzendő.

Ha az egyeztető a handoff ellenőrzése vagy a hányadösszeg miatt `ok:false`
eredményt ad, ne írj a Föld-be.

## 3. A terv végrehajtásának előkészítése

| action | method | teendő |
| --- | --- | --- |
| `delete` | DELETE | a terv ownership id-jának törlése |
| `patch` | PATCH | a terv ownership id-jának módosítása |
| `post` | POST | új ownership létrehozása |

Minden `items` elem kötelező. Összevonásnál a sibling DELETE kihagyása hányad
> 1 hibát okozhat. Új sornál keresd meg a `partnerId`-t a `/partners` listában;
név és személyes adatok alapján azonosíts, tippelni tilos. A request body mezőit
a connector katalógusából, meglévő rekordból és a terv `body.hanyad` értékéből
vedd.

## 4. Írás egy csomagban

1. Ha nincs érvényes Föld `proposalId`, külön kapukörben hívd a
   `POST /proposals` végpontot `{ "cim": "<hrsz> …" }` body-val.
2. Mentsd a válasz `body.id` értékét a checkpointba.
3. Hajtsd végre az összes terv-elemet a fájl sorrendjében, ugyanazzal a
   `proposalId`-vel.
4. Minden Ownership kérésben legyen `X-Proposal-Id` és `body.proposalId`.

Az `Idempotency-Key`-t a platform küldi. 400/422 után ne tippeld a body mezőit.
404 proposal hibánál rossz a proposalId; 404 ownership hibánál ne ismételj
hallucinált id-val.

## 5. Coverage

Az Ownership írások után kérd le vagy készítsd el a proposal tételeinek
workspace-kivonatát, majd hívd:

```json
{
  "coverageAppliedPath": "proposal_items_extract.json",
  "coverageMuveletekPath": "fold_muveletek.json"
}
```

`coverage.ok !== true` esetén ne validálj, ne submitolj és ne jelöld késznek a
feladatot. Pótold a hiányzó terv-elemeket; extra id-ket ne törölj találomra.

## 6. Föld validate és submit

Hívd a kész csomagra a `POST /proposals/{proposalId}/validate` végpontot üres
body-val. `valid:false` esetén javíts az `issues` alapján, majd validálj újra.

| code | teendő |
| --- | --- |
| `sum_exceeds_one` | pótold a terv sibling DELETE elemeit |
| `draft_reference` | biztosítsd a hivatkozott Partner/LandParcel draftot vagy élő sort |
| `proposal_base_conflict` | kérd le újra az ownerships listát, és készíts friss tervet |
| `invalid_format` | javítsd a hányad vagy patch formátumát |
| `not_found` | ellenőrizd a hibás vagy törölt entityId-t |

Csak `valid:true` után hívd a `POST /proposals/{proposalId}/submit` végpontot.
Az agent approve/reject műveletet nem végez; a beküldött draftot ember bírálja
el a Föld UI-ban.

## 7. Válasz

Add meg:

- az ingatlant és a lap keltét,
- a rendben és az eltérő rekordok darabszámát,
- a draftolt DELETE/PATCH/POST darabszámokat és fő tételeket,
- a `proposalId`-t,
- a coverage és validate eredményét,
- a bizonytalan tételeket,
- hogy a Föld UI-ban emberi jóváhagyás szükséges.

A hányadokat százalékban írd. Függő draftnál ne ígérj végleges Föld állapotot.

# Tiltott anti-minták

- a PDF újbóli olvasása vagy parse-olása
- a handoff teljes tulajdonoslistájának kontextusba lapozása
- `http_api_get` használata ownerships listára
- csonka nyilvántartásból egyeztetés
- Excel deliverable vagy `kimenet: "….xlsx"`
- Föld-írás egyeztetés nélkül vagy „Rendben” sorokra
- terv-elemek kihagyása bizonytalanságra hivatkozva
- ownership írás `proposalId` nélkül vagy kitalált proposalId-val
- proposals és Ownership írások egy kapukörben előre generált id-val
- submit validate nélkül vagy `valid:false` mellett
- approve/reject végrehajtása az agent által

# Folytatás

Használd a meglévő handoffot, nyilvántartás tool-outputot,
`fold_muveletek.json`-t és `proposalId`-t. Ne parse-old újra a PDF-et, ne kérd le
feleslegesen újra a teljes nyilvántartást, és ne építs új tervet, ha a checkpoint
szerinti források még érvényesek.

---
name: tulajdoni-lap-pdf-feldolgozas
title: Tulajdoni lap PDF-feldolgozás
description: Magyar e-hiteles tulajdoni lap PDF determinisztikus kiolvasása, ellenőrzése és teljes, verziózott JSON handoff fájlba mentése a következő agent számára. Használd egy Folyamat első lépéseként, amikor a csatolt tulajdoni lapból strukturált tulajdonosi adatot kell készíteni; ez a skill nem kérdezi le és nem módosítja az Ostoros Föld rendszert.
max-wall-clock-ms: 300000
max-tool-calls: 5
preferred-mode: task
attachment-description: Csatolj egy teljes tulajdoni lap PDF-et!
allowed-tools: tulajdoni_lap_parse
---

# Feladat

Olvasd ki a magyar e-hiteles tulajdoni lapot, ellenőrizd a hatályos tulajdoni
hányadokat, és mentsd a **teljes strukturált eredményt** egy verziózott JSON
handoff fájlba. A fájl a következő agent bemenete lesz.

Ez a skill kizárólag a PDF feldolgozásáért felel. Ne kérdezd le a Föld API-t, ne
végezz egyeztetést nyilvántartással, ne hozz létre proposal-csomagot, és ne írj
Excel-riportot.

# Bemenet és kimenet

A PDF forrása:

- chat/csatolmány esetén `documentId` (UUID), vagy
- ticket/workspace esetén `path` (a pontos PDF- vagy materializált `.pdf.txt` fájlnév).

A kötelező kimenet: `feldolgozott-tulajdoni-lap.json`. Ha ugyanabban a
workspace-ben több lap fut, használj helyrajzi számmal egyértelműsített nevet,
például `feldolgozott-tulajdoni-lap-043-15.json`.

A handoff szerződés fő mezői:

- `kind: "tulajdoni_lap_feldolgozas"`
- `schemaVersion: 1`
- `source`: a dokumentum azonosítója vagy path-ja és fájlneve
- `parsed.meta`: lap kelte, típusa, ingatlan megnevezése
- `parsed.osszesites`: darabszámok és a hányadellenőrzés eredménye
- `parsed.tulajdonosok`: az összes hatályos tulajdonos, összevont hányadokkal
- `parsed.szeljegyek`, `parsed.ingatlan`, valamint az ellenőrizhető bejegyzések

# Menet

## 1. Feldolgozás egyetlen hívással

Hívd a `tulajdoni_lap_parse` eszközt a forrással és a `kimenet` paraméterrel:

```json
{
  "documentId": "…",
  "nezet": "osszefoglalo",
  "kimenet": "feldolgozott-tulajdoni-lap.json"
}
```

Workspace fájlnál `documentId` helyett `path` legyen. A fájlnevet soha ne add
`documentId`-ként. Ne lapozd ki a `tulajdonosok` nézetet, és ne gyűjtsd a teljes
listát a modell kontextusába: a teljes eredményt maga az eszköz írja a handoff
fájlba.

## 2. Ellenőrzési kapu

Csak akkor adj `ready` státuszt, ha:

- a tool sikeresen létrehozta a `kimenet` fájlt,
- `osszesites.valid === true`,
- a lap típusa támogatott teljes másolat,
- a strukturált tulajdonosi lista nem üres.

Ha `osszesites.valid === false`, ne próbáld kézzel javítani vagy értelmezni a
listát. Adj `blocked` státuszt, idézd röviden a `figyelmeztetes` okát, és kérj
teljes másolatot, ha szemle vagy ismeretlen típus érkezett. A létrejött fájlt ne
add tovább Föld-frissítésre kész adatként.

## 3. Átadás

A végső válasz legyen rövid és gépileg is könnyen továbbadható:

- `status`: `ready` vagy `blocked`
- `feldolgozottLapPath`: a létrehozott JSON path-ja
- `ingatlan`: `meta.ingatlanMegnevezes`
- `kelt`: `meta.kelt`
- `tulajdonosDb`: `osszesites.egyediTulajdonos`
- `hanyadEllenorzes`: az összeg és az érvényesség
- `szeljegyDb`: `osszesites.szeljegyDb`

Ne sorold fel a teljes tulajdonosi listát a válaszban. A következő agentnek a
`feldolgozottLapPath` értéket add át, ne a PDF teljes szövegét.

# Tiltott anti-minták

- `document_read` / általános PDF-olvasás használata tulajdoni lapra
- a tulajdonosnézet oldalankénti beolvasása és kézi összefűzése
- Föld API vagy bármely külső nyilvántartás lekérdezése
- ownership, partner vagy proposal módosítása
- kézi javítás érvénytelen hányadösszeg mellett
- a teljes tulajdonosi lista bemásolása az agent válaszába

# Folytatás

Ha a handoff fájl már sikeresen elkészült és a korábbi eredményben `ready`
státusz szerepel, ne parse-old újra a PDF-et. Add át a meglévő
`feldolgozottLapPath` értéket a következő folyamatlépésnek.

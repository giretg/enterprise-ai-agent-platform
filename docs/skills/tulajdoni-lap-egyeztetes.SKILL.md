---
name: tulajdoni-lap-egyeztetes
description: Tulajdoni lap összevetése a saját tulajdonosi nyilvántartásunkkal, és a különbségek átadása Excel egyeztető táblában emberi ellenőrzésre. Használd, ha tulajdoni lapot kell a nyilvántartással egyeztetni, ha „mi változott a tulajdonosoknál", vagy ha egy hrsz-re kérnek egyeztetést.
max-wall-clock-ms: 900000
max-tool-calls: 60
preferred-mode: task
allowed-tools: tulajdoni_lap_egyeztetes, tulajdoni_lap_parse, http_api_get, file_write, file_read
---

# Mi a feladat

Kiolvasni a tulajdoni lapból a valós tulajdonosi összetételt, összevetni a
nyilvántartásunkkal, és a különbségeket áttekinthető Excel-táblában átadni emberi
ellenőrzésre. Egy egyeztetés = egy tulajdoni lap = egy Excel fájl.

# Két kemény szabály

**Ne írj vissza az adatbázisba.** Ez a skill kizárólag javaslatot állít elő. Az
`http_api_request` (POST/PUT/PATCH/DELETE) eszközt ebben a feladatban ne
használd, akkor sem, ha a felhasználó kéri — a javítást ember hagyja jóvá és
hajtja végre. Ha közvetlen módosítást kérnek, mondd el, hogy a kimenet az
egyeztető tábla, és kérdezd meg, továbbítsuk-e jóváhagyásra.

**A kimeneti formátumot ne kérdezd meg** — ezt a skill megadja. Csak akkor állj
meg kérdezni, ha a lap ellenőrzése bukott, ha a nyilvántartás lekérdezése
kétséges, vagy ha egy párosítás emberi döntést igényel.

# A menet: három lépés, nem több

## 1. A nyilvántartás oldala

A tulajdonosi rekordokat az Ostoros Föld API-n keresztül éred el
(`http_api_get`). A választ **mentsd le** a munkaterületre `file_write`-tal (pl.
`nyilvantartas.json`) — így a következő lépés fájlból olvassa, és a több száz sor
nem megy át fölöslegesen a szövegen.

Ha a lekérdezés üres listát ad, az nem azt jelenti, hogy minden tulajdonos új.
Előbb győződj meg róla, hogy a helyrajzi számot a végpont elvárt formátumában
adtad át (pl. „43/15" vs „043/15" vs külön település és hrsz). Ha nem tudod
eldönteni, kérdezz — ne tippelj: a rossz lekérdezésből az jönne ki, hogy az egész
nyilvántartást újra kell rögzíteni.

## 2. Az egyeztetés — EGY hívás

```
tulajdoni_lap_egyeztetes({
  documentId: "…",                  // vagy path: "043_15 2026.07.16.pdf"
  nyilvantartasPath: "nyilvantartas.json",
  kimenet: "egyeztetes-043-15.xlsx"
})
```

Ez a hívás elvégzi a lap kiolvasását, a párosítást és a kész munkafüzet
megírását. **Ne bontsd szét**: ne lapozd végig a `tulajdoni_lap_parse`
tulajdonos-nézetét, ne készíts köztes JSON-t a párosításról, és ne írj cellánként
Excelt — az sokszoros költség, és rendszeresen kifut a forduló keretéből.

A nyilvántartás sorainak mezői: `nev` (kötelező), `szuletesiEv`, `anyjaNeve`,
`hanyad` (**tört**, pl. `3/4`), `cim`, `azonosito`, `megjegyzes`. Ha az API más
néven adja ezeket, a `file_write` előtt képezd át erre az alakra.

A `tulajdoni_lap_parse`-ot csak akkor hívd, ha az egyeztetésen túl kell
magyaráznod valamit: pl. egy eltérés eredetét keresed a törölt bejegyzésekben
(`csakHatalyos: false`, az `utalas` mezők adják a láncot), vagy a terhek
részletét kérik.

## 3. A válasz

Az eszköz összegzést és az **eltérő** sorokat adja vissza — a teljes tábla az
Excelben van. Ebből fogalmazd meg a választ:

- hány rekord van rendben, és hány igényel beavatkozást, státuszonként bontva,
- a „Törlés szükséges" és „Új rekord" tételek névvel felsorolva — ezek a valódi
  eltérések,
- minden bizonytalan párosítás, amit embernek kell eldöntenie,
- ha van széljegy: hogy a lap már elavulóban van.

A hányadokat emberi szövegben százalékkal add meg, a törtet legfeljebb
zárójelben. Mindig mondd meg, mikori a lap (`meta.kelt`) — egy egyeztetés csak a
lap keltéhez képest érvényes.

# Ha az ellenőrzés bukik

Ha a hatályos hányadok összege nem 1, az eszköz `ok: false`-szal tér vissza és
**nem készít táblát**. Ez szándékos: hibás alapon egyeztetni rosszabb, mint nem
egyeztetni — a tábla hitelesnek látszana, és emberi jóváhagyással menne tovább.

Ilyenkor mondd el, mennyi az összeg, hogy nem 1, és hogy emiatt az egyeztetés nem
megbízható; utána kérdezd meg, hogyan folytassuk. A leggyakoribb okok: tényleg
rendezetlen a tulajdoni helyzet; szokatlan jogállás-címke; vagy hibás/sérült,
nem szöveges PDF. Ha a lap szemle másolat, teljes másolatot kell kérni a
földhivataltól — a szemle mezőcímkéi eltérnek, és a kézi olvasás pont azokat a
hibákat hozná vissza, amiket az eszköz kizár.

# Amit a táblában látni fogsz

Az `Egyeztetés` munkalap a két oldal **uniója** — ezért jelenik meg a „Törlés
szükséges" eset is, ami rendszerint a legértékesebb találat. A `K` oszlop
(Ellenőrzési státusz) legördülő, a `L` (Megjegyzés) mondja meg, mi és miért tér
el. Az `Ingatlan` munkalapon van a lap metaadata, a terület/AK (a tábla képletei
ide hivatkoznak), a széljegyek és a hatályos terhek.

Amit tudnod érdemes az eredményről:

- **Hatályos vs. törölt.** A lap történeti napló: egy eladott hányad bejegyzése
  nem tűnik el, csak „Törlő határozat" mezőt kap. A tábla már csak a hatályos
  sorokból számol.
- **Egy személy = sok bejegyzés.** Aki évek alatt több részarányt vásárolt fel,
  annyi hatályos bejegyzéssel szerepel, ahány ügylete volt; a tábla ezeket
  összegzi, és a Megjegyzés oszlopban megadja a sorszámokat (pl. „II/3 + II/7
  összege"), hogy az ellenőrző vissza tudja keresni.
- **Joggyakorló ≠ tulajdonos.** A „Tulajdonosi joggyakorló" bejegyzés (NFK,
  Agrárminisztérium, MNV Zrt.) egy meglévő Magyar Állam tulajdoni sorhoz
  tartozik, nem külön tulajdon. Ha a nyilvántartásban külön rekordként szerepel,
  „Törlés szükséges"-ként fog megjelenni — a válaszodban jelezd, hogy joggyakorló
  lehet, és emberi döntés, hogyan tartjuk nyilván.
- **A terhek nem tulajdonosok.** A haszonélvezet, özvegyi jog, jelzálog nem
  tulajdoni hányad, ezért nincs a fő táblában; az Ingatlan munkalapon találod.

# Folytatás megszakadás után

Ha a futás időkorlát vagy eszközkeret miatt leállt, **ne kezdd elölről**: nézd
meg a munkaterület fájljait. Ha a `nyilvantartas.json` megvan, ne kérdezd le
újra az API-t; ha az egyeztető Excel elkészült, ne futtasd újra az egyeztetést —
csak a hiányzó lépést csináld meg (jellemzően a szöveges összefoglalót).

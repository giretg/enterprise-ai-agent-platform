---
name: tulajdoni-lap-egyeztetes
description: Tulajdoni lap összevetése a saját tulajdonosi nyilvántartásunkkal, és a különbségek átadása Excel egyeztető táblában emberi ellenőrzésre. Használd, ha tulajdoni lapot kell a nyilvántartással egyeztetni, ha „mi változott a tulajdonosoknál", vagy ha egy hrsz-re kérnek egyeztetést.
max-wall-clock-ms: 900000
max-tool-calls: 40
preferred-mode: task
allowed-tools: tulajdoni_lap_egyeztetes, http_api_get_all, http_api_get, file_write, reconcile_records, tulajdoni_lap_parse
---

# Mi a feladat

Kiolvasni a tulajdoni lapból a valós tulajdonosi összetételt, összevetni a
nyilvántartásunkkal, és a különbségeket áttekinthető Excel-táblában átadni emberi
ellenőrzésre. Egy egyeztetés = egy tulajdoni lap = egy Excel fájl.

# Két kemény szabály

**Ne írj vissza az adatbázisba.** Ez a skill kizárólag javaslatot állít elő. Az
`http_api_request` (POST/PUT/PATCH/DELETE) eszközt ebben a feladatban ne
használj, akkor sem, ha a felhasználó kéri — a javítást ember hagyja jóvá és
hajtja végre. Ha közvetlen módosítást kérnek, mondd el, hogy a kimenet az
egyeztető tábla, és kérdezd meg, továbbítsuk-e jóváhagyásra.

**A kimeneti formátumot ne kérdezd meg** — ezt a skill megadja. Csak akkor állj
meg kérdezni, ha a lap ellenőrzése bukott, ha a nyilvántartás lekérdezése
kétséges, vagy ha egy párosítás emberi döntést igényel.

**Ne gyűjts a kontextusba. Ne párosíts a modellben.** Nagy API-válasz / parse-
eredmény SOHA ne kerüljön teljes egészében a promptba, és 10+ soros listát NE
olvass össze `file_read` chunkokkal. Mentés / kivonat → **egyeztető eszköz** →
a modell csak a metaadatot és az összegzést látja.

# Tiltott anti-minta (budget-gyilkos)

NE csináld:
- `tulajdoni_lap_parse` tulajdonos-nézet lapozása a kontextusba
- `http_api_get` page=1,2,3… sorozat (helyette `http_api_get_all`)
- ugyanazt a JSON fájlt sokszor `file_read`-del offset/limit-tel
- kézi párosítás / `xlsx_create` + `xlsx_append_rows` cellázás
- `file_search` a teljes listán matchinghez

# A menet: gyűjtés → EGY egyeztető hívás

## 0. Checkpoint

Minden lényeges lépés után frissítsd (vagy hozd létre) az
`egyeztetes_progress.json` fájlt a munkaterületen:

```json
{
  "hrsz": "043/15",
  "nyilvantartasPath": "nyilvantartas.json",
  "pagesFetched": "all",
  "kimenet": "egyeztetes-043-15.xlsx",
  "status": "nyilvantartas_ready"
}
```

Ha a futás megszakad, a következő forduló EBBŐL indul — ne kezdd elölről.

## 1. A nyilvántartás — lehetőleg EGY lapozó hívás

A tulajdonosi rekordokat az Ostoros Föld API-n keresztül éred el.

1. Találd meg a parcel / coverage / ownership végpontot (ha kell, egy
   `http_api_get` a konkrét hrsz-re).
2. Nagy listához hívd az **`http_api_get_all`**-t (page/pageSize szerveroldalon
   végigmegy). Egy oldal / egyedi rekord → elég a sima `http_api_get`.
3. Ha a válasz archívumba / `tool-outputs/…` fájlba került: **közvetlenül**
   add át `nyilvantartasPath`-ként az egyeztetőnek — az elfogadja az
   `{ items: [...] }` / `http_api_get_all` kimenetet, és a `partnerNev` /
   `id` / `jogcim` mezőaliasokat kanonikus `nev` / `azonosito` / `megjegyzes`
   mezőkre normalizálja. `tool_result_extract` csak akkor kell, ha a válasz
   más alakú, és a forrásmezőneveket (pl. `partnerNev`, `hanyad`, `id`)
   kéred ki — **ne** próbálj modellben `nev`-re átnevezni.
4. Frissítsd az `egyeztetes_progress.json`-t.
5. A teljes listát NE olvasd vissza `file_read` / `tool_result_read`-del.

Ha a lekérdezés üres listát ad, az nem azt jelenti, hogy minden tulajdonos új.
Előbb győződj meg róla, hogy a helyrajzi számot a végpont elvárt formátumában
adtad át (pl. „43/15" vs „043/15" vs külön település és hrsz). Ha nem tudod
eldönteni, kérdezz — ne tippelj.

## 2. Az egyeztetés — EGY hívás

Ha a nyilvántartás fájl kész (akár a nyers `tool-outputs/…http_api_get_all…`,
akár kivonat):

```
tulajdoni_lap_egyeztetes({
  documentId: "…",                  // vagy path: "043_15 2026.07.16.pdf"
  nyilvantartasPath: "tool-outputs/15-http_api_get_all-….json",
  kimenet: "egyeztetes-043-15.xlsx"
})
```

Ez a hívás elvégzi a lap kiolvasását, a párosítást és a kész munkafüzet
megírását. **Ne bontsd szét.** A párosítás determinisztikus munka: a kód végzi.

Általános (nem tulajdoni-lap) listák egyeztetéséhez a platform
`reconcile_records` eszközét használd: két workspace JSON + `keyFields` →
státuszos unió fájlba.

A `tulajdoni_lap_parse`-ot csak akkor hívd, ha az egyeztetésen túl kell
magyaráznod valamit: pl. egy eltérés eredetét keresed a törölt bejegyzésekben
(`csakHatalyos: false`), vagy a terhek részletét kérik.

Frissítsd a checkpointot: `"status": "egyeztetes_done"`, `"kimenet": "…"`.

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

Ha a futás időkorlát vagy eszközkeret miatt leállt, **ne kezdd elölről**: nyisd
meg az `egyeztetes_progress.json`-t és a munkaterület fájljait.

- Ha a `nyilvantartas.json` (vagy kivonat) megvan: NE kérdezd le újra az API-t;
  hívd azonnal a `tulajdoni_lap_egyeztetes`-t.
- Ha az egyeztető Excel elkészült: ne futtasd újra — csak a szöveges összefoglalót
  add.
- TILOS újra: parse a teljes lapra, `http_api_get_all` ugyanarra a pathra,
  chunkolt `file_read` a már meglévő JSON-okon.

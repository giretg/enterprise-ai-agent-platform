---
name: tulajdoni-lap
description: Magyar e-hiteles tulajdoni lap (földhivatali TULLAP/INYER PDF) feldolgozása és adatkinyerése — hatályos tulajdonosok, tulajdoni hányadok, terhek, széljegyek strukturált kinyerése validálva. Használd ezt a skillt, valahányszor tulajdoni lap, tulajdonilap-másolat, földhivatali kivonat, helyrajzi szám/hrsz szerinti ingatlan-nyilvántartási dokumentum kerül elő — akkor is, ha a felhasználó csak annyit mond, hogy "nézd meg ki a tulajdonos", "mekkora részt birtokol X", "mi van ezen a földön", vagy egyszerűen csak becsatol egy földhivatali PDF-et. Akkor is ezt használd, ha a végső cél valami más (Excel, adatbázis-betöltés, riport, összehasonlítás) — a lap helyes értelmezése minden ilyen feladat előfeltétele.
compatibility: Requires Python 3 and pypdf (pip install pypdf)
---

# Magyar e-hiteles tulajdoni lap feldolgozása

Ez a skill a **lap beolvasásáról és értelmezéséről** szól. A kimenet formátumát
(Excel, JSON, adatbázis-seed, riport, összefoglaló) **a felhasználó határozza meg** —
ha nem mondta meg, kérdezd meg, mielőtt bármit generálnál.

A parser kódja a skill része (`scripts/parse_tulajdoni_lap.py`). Futtasd a
kliens oldalon — ne lapozd a PDF-et a modell kontextusába.

## Miért kell ehhez külön tudás

A tulajdoni lap **nem pillanatfelvétel, hanem teljes történeti napló**. Amikor valaki
elad egy hányadot, a régi bejegyzés nem tűnik el és nem íródik felül — ott marad,
és csak egy „Törlő határozat" mezőt kap. Egy 200+ oldalas lapon a bejegyzések
70-80%-a már **nem hatályos**. Aki naivan olvassa, súlyosan téves képet kap.

Ráadásul a dokumentum belsejében **kétféle sablon keveredik**: a ~2025 őszétől
iktatott (INYER-es) bejegyzések más mezőcímkéket és csupa nagybetűs neveket
használnak. Ezek épp a legfrissebbek, tehát a jelen állapot szempontjából a
legfontosabbak — egy csak a régi formátumra írt feldolgozás némán elhagyja őket.

## Munkamenet

### 1. Ne olvasd be a PDF-et lapozva

Egy tulajdoni lap 100-300 oldal, aminek a nagy része ismétlődő fejléc és már
törölt bejegyzés. Ha a Read tool-lal lapozod végig, elégeted a kontextust olyan
adatra, amit utána úgyis programmatikusan nyersz ki. Helyette:

```bash
python3 scripts/parse_tulajdoni_lap.py <lap.pdf> -o lap.json
```

(Függőség: `pypdf`. Ha hiányzik: `pip install pypdf`.)

A szkript kimenete a konzolon rögtön megmutatja, sikerült-e:

```
  II. RÉSZ: 536 bejegyzés (276 hatályos / 260 törölt)
  III. RÉSZ: 81 bejegyzés (28 hatályos)
  Széljegy: 4
  Egyedi tulajdonos: 182
  Hányadösszeg: 1/1 (100.0%)
  ✓ VALIDÁLT — a hatályos hányadok összege pontosan 1
```

### 2. Nézd meg a validációt, mielőtt bármit építesz rá

A hatályos tulajdoni hányadok összegének **pontosan 1-nek** kell lennie. Ez egy
ingyenes és nagyon erős helyességi próba: ha kijön, a hatályos/törölt szétválasztás
és a törtek kiolvasása szinte biztosan jó. Ha nem jön ki, a szkript hibakóddal áll
le — **ilyenkor ne dolgozz tovább az adattal**, hanem derítsd ki, mi tér el
(ld. lentebb a hibakeresést).

### 3. Dolgozz a JSON-ból

```
meta                    ügyazonosító, kelt, ingatlan megnevezése, oldalszám
szeljegyek[]            folyamatban lévő, MÉG NEM hatályos ügyek
ingatlan                I. RÉSZ — terület, AK, művelési ág
tulajdoni_bejegyzesek[] II. RÉSZ — MINDEN bejegyzés, `hatalyos: true/false` jelöléssel
terhek[]                III. RÉSZ — ugyanígy jelölve
tulajdonosok[]          összesítve: ki mennyit birtokol MOST (%-kal, hányaddal)
osszesites              darabszámok + a validáció eredménye
```

A `tulajdonosok[]` tömb a legtöbb kérdésre közvetlenül válaszol („ki a legnagyobb
tulajdonos", „mekkora X részesedése") — ehhez nem kell a nyers bejegyzéseket bogarászni.

## Értelmezési szabályok

Ezek adják a skill lényegét; a szkript ezeket már alkalmazza, de neked is
ismerned kell őket, hogy helyesen tudj válaszolni és kimenetet építeni.

**Hatályos vs. törölt.** Ha a bejegyzésen van „Törlő határozat", az már nem él.
A mai állapot = a törlő határozat nélküli bejegyzések. A törölt sorok viszont nem
szemét: belőlük olvasható ki a proveniencia (kitől, mikor, milyen jogcímen került
a hányad a mai tulajdonoshoz) — ha a feladat ezt kérdezi, ott a `hatalyos: false`
sorok és az „Utalás" mezők adják a láncot.

**Egy személy = sok bejegyzés.** Aki évek alatt több részarányt vásárolt fel,
annyi külön hatályos bejegyzéssel szerepel, ahány ügylete volt. Az aktuális
tulajdonrésze csak ezek **összege**. Egyetlen bejegyzésre nézve drasztikusan
alábecsülnéd.

**Azonos név ≠ azonos személy.** Ugyanazon a lapon simán előfordul apa és fia
alig eltérő névvel (pl. „Soltész Gábor Gergő" és „Soltész Gábor György"), vagy két
teljesen független névrokon. A megkülönböztetés alapja **név + születési év +
anyja neve**. Régi bejegyzéseknél ezek hiányozhatnak — ilyenkor a cím segít, de
ha bizonytalan, inkább hagyd külön és jelezd, mint hogy tévesen összevond két embert.

**Joggyakorló ≠ tulajdonos.** A „Tulajdonosi jogokat gyakorló szervezet" /
„Tulajdonosi joggyakorló" bejegyzés (Nemzeti Földügyi Központ, Agrárminisztérium,
MNV Zrt., Maradványvagyon-hasznosító Zrt.) mindig egy meglévő **Magyar Állam**
tulajdoni sorhoz tartozik, ugyanazzal a hányaddal — nem külön tulajdon. Ha
tulajdonosként is beszámítanád, duplán számolnál, és az összeg túllépné az 1-et.

**Széljegy = még nem hatályos.** A lap elején álló széljegyek olyan beadványokat
jelölnek, amiket a földhivatal megkapott, de még nem jegyzett be. A mai tulajdoni
állapotot **nem** módosítják, viszont előrevetítik a következő változást — egy
folyamatban lévő adásvétel, öröklés, gondnokság alá helyezés. Ha valakit az
„aktuális helyzet" érdekel, ezeket külön, „folyamatban" címkével mutasd meg,
soha ne olvaszd bele a hatályos állapotba.

**Többféle nevező.** Egy lapon több közös nevező is előfordulhat (pl.
`/23773489488` és `/5943372372`, ahol az egyik a másik egész számú többszöröse) —
korábbi újraosztások maradványa. Összeadás előtt közös nevezőre kell hozni; a
szkript `Fraction`-nel dolgozik, ezért ez automatikus.

**Terhek külön kérdés.** A III. RÉSZ (özvegyi jog, haszonélvezet, jelzálog,
végrehajtási jog, zárlat, gondnokság, kiskorúság) nem azt mondja meg, *ki mennyit*
birtokol, hanem hogy *milyen jog vagy korlátozás tapad* egy-egy hányadhoz. Ha a
feladat célrendszerében ezekre nincs megfelelő kategória, **ne erőltesd bele** egy
közelítő típusba — sorold fel külön, hogy mi nem fért el, és miért.

## Ha a validáció bukik

A leggyakoribb okok, prioritási sorrendben:

1. **Új sablonú bejegyzések kimaradtak** — nézd meg a legmagasabb sorszámú
   bejegyzéseket a JSON-ban, hogy kiolvasódott-e a hányaduk. Ha ott `szamlalo`
   hiányzik, mezőcímke-variánst kell pótolni (ld. `references/mezoreferencia.md`).
2. **Haszonélvezet vagy joggyakorló beszámítva** — ezek nem tulajdoni hányadok.
3. **Oldalhatáron csonkolt bejegyzés** — ha a fejléc/lábléc-eltávolítás félrement.
   Ellenőrizd a nyers szöveget egy-két gyanús bejegyzés körül.
4. **Tényleg különleges a lap** — pl. a tulajdoni hányadok összege ténylegesen
   nem teljes (ritka, de előfordul rendezetlen jogi helyzetnél). Ilyenkor
   dokumentáld, ne „javítsd el".

Mielőtt kézzel nekiállnál javítani a parse-t, nézd meg a nyers szöveget:

```python
from pypdf import PdfReader
r = PdfReader("lap.pdf")
print(r.pages[220].extract_text())   # a gyanús bejegyzés környéke
```

## Fontos: őrizd meg a köztes JSON-t

Egy tulajdoni lap feldolgozása drága. Ha a JSON-t eldobod, a következő feladat
(összehasonlítás, riport, más kimeneti formátum) mindent elölről kezd. Mentsd el
egy stabil helyre, és a további munkát abból építsd — a PDF-hez csak akkor nyúlj
vissza, ha valami tényleg hiányzik belőle.

## Részletes mezőreferencia

A két sablon pontos mezőcímkéi, a bejegyzéstípusok listája és a
szövegkinyerési buktatók: `references/mezoreferencia.md`. Akkor olvasd el, ha
a parse-t bővítened vagy hibáznod kell — a szokásos feldolgozáshoz nem szükséges.

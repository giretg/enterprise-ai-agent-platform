# A HTML összeállítása

Nincs futtatható script: a `assets/report-sablon.html` másolatában te cseréled ki a `{{...}}`
helyőrzőket. A mátrix-számok a `/reports/product-group-monthly` válasz `data` mezőjéből jönnek;
a partner-számok a `/reports/query` (`preset: partner-turnover`) válaszából, ha a `SKILL.md` szerint
használhatók. Semmit ne találj ki: ha egy szám nincs a JSON-ban és a lenti képlet sem állítja elő,
nem kerül a reportba.

Jelölés: `M` = a tárgyhónap sorszáma (pl. augusztus → 8), `E` = a tárgyév,
`years` = a JSON évlistája növekvő sorrendben (pl. `[2024, 2025, 2026]`).

---

## 1. Formázási szabályok (mindenhol ezek)

| Mi | Szabály | Példa |
|---|---|---|
| Mennyiség | egészre kerekítve, ezres nemtörő szóköz (`&nbsp;`) | `12345` → `12&nbsp;345` |
| Nulla / nincs adat | gondolatjel | `—` |
| Arány → százalék | `vsLy * 100`, egy tizedes, tizedesvessző, előjellel | `0.184` → `+18,4%` |
| Nulla bázis (`vsLy: null`) | gondolatjel | `—` |
| Növekedés / csökkenés | `class="up"` / `class="down"`, nulla vagy `—` esetén `class="flat"` | |
| Hónapnév | magyar, kisbetűvel a fejlécben | `augusztus` |

**A `vsLy` arány, nem százalék.** `0.184` = +18,4%, nem 0,18%. Ez a leggyakoribb hiba.

A szövegbe másolt partnernévben a `&` → `&amp;`, a `<` → `&lt;`.

---

## 2. YTD-tábla — egyszer, aztán mindenhol ez

Ha `data.ytd` létezik **és** `ytd.throughMonth === M`: a `ytd.years` a kész tábla
(`year`, `total`, `vsLy`, `byGroup`). Másold.

Különben évenként összegezd a `months[0..M-1]` celláit:

- `total` = Σ `total`
- `byGroup[id]` = Σ `byGroup[id]` (hiányzó kulcs = 0)
- `vsLy` = `(total_E − total_{E−1}) / total_{E−1}` ha van előző év a `years`-ben és a bázis ≠ 0, különben `null`

Ezt használd a 2. KPI-hoz, a 3–4. csempéhez, a 2. ábrához és a „Totál (1-M)” sorokhoz.

---

## 3. KPI-csempék — `{{KPI_CSEMPEK}}`

Kettő kötelező, kettő feltételes. Csempénként ez a minta:

```html
<div class="kpi">
  <div class="label">augusztus (db)</div>
  <div class="value">12&nbsp;345</div>
  <div class="delta"><span class="up">+18,4% vs. előző év</span></div>
</div>
```

1. **Tárgyhó** — `months[M-1].years[…year === E].total`, delta ugyanannak a cellának a `vsLy`-ja.
2. **YTD 1–M. hó** — a YTD-tábla `E` évének `total`-ja; delta az ugyanazon sor `vsLy`-ja.
3. **Legnagyobb növekedés (YTD)** — a szűrt csoportok közül a legnagyobb *pozitív* arány:
   címke (`columns[].label`) + százalék. Nincs pozitív → nincs csempe.
4. **Legnagyobb visszaesés (YTD)** — ugyanaz, a legnegatívabb (negatív) aránnyal.
   Nincs negatív → nincs csempe.

Szűrés a 3–4. ponthoz, csoportonként (`columns[].id`): vedd a YTD-tábla `byGroup` értékeit `E`-re
és `E−1`-re. **Hagyd ki**, ahol az előző évi YTD 0, és ahol a két év együttes YTD-je a két év
YTD-totáljának 1%-át sem éri el. Arány: `(most − tavaly) / tavaly`.

---

## 4. Ábrák — `{{ABRA1_*}}`, `{{ABRA2_*}}`, `{{JELMAGYARAZAT}}`

Nincs képfájl és nincs SVG-koordináta: egy oszlop egy `<b>`, a magassága százalék.

**Számolás:** keresd meg az adott ábra legnagyobb értékét (`csúcs`), majd minden oszlopra
`height = kerekít(érték / csúcs * 100)%`. A nullát hagyd `height:0%`-on.
A `csúcs` értékét formázva írd a `{{ABRA1_CSUCS}}` / `{{ABRA2_CSUCS}}` helyére (ez a felső skálacímke).

**Ábra 1 — havi mennyiség:** 12 kategória (Jan…Dec), kategóriánként annyi oszlop, ahány év, a
`years` sorrendjében. Érték: `months[m-1].years[i].total`. A tárgyév jövőbeli hónapjai `0%`.

**Ábra 2 — termékcsoport YTD 1–M:** kategória minden `columns[]` elem (OSTOROS, SAJÁTMÁRKA, …),
oszlop minden év; érték a YTD-tábla `byGroup[id]`-ja.

Egy kategória markupja (a `y1`/`y2`/`y3` a legrégebbi → legfrissebb évet jelöli *három év esetén*):

```html
<div class="grp"><b class="y1" style="height:31%"></b><b class="y2" style="height:62%"></b><b class="y3" style="height:100%"></b><span>Jan</span></div>
```

A `y`-osztályt a *végéről* oszd: 3 év → `y1 y2 y3`; 2 év → `y2 y3`; 1 év → `y3`.
A legfrissebb év mindig `y3` (bordó).

Jelmagyarázat (mindkét ábrához ugyanaz, a `years` sorrendjében; az `i` osztálya egyezzen az oszlopéval):

```html
<span><i class="y1"></i>2024</span><span><i class="y2"></i>2025</span><span><i class="y3"></i>2026</span>
```

---

## 5. A mátrix — `{{TABLA_FEJLEC}}`, `{{TABLA_SOROK}}`

Ugyanaz a tábla, mint az Analitika → Havi termékcsoport fülön.

**Fejléc:** `Hónap`, `Év`, `Totál`, `Totál vs. LY`, majd minden `columns[].label` a JSON sorrendjében.
A `byGroup` kulcsa a `columns[].id` (pl. `SAJATMARKA`), a fejléc a `label` (pl. `SAJÁTMÁRKA`).

```html
<th class="left">Hónap</th><th>Év</th><th>Totál</th><th>Totál vs. LY</th><th>OSTOROS</th><th>SAJÁTMÁRKA</th><!-- … -->
```

**Törzs:** mind a 12 hónap, hónaponként annyi sor, ahány év. A hónap neve csak az első sorban,
`rowspan`-nal (`months[].label`). Az első sor `class="first"` (ez húzza a hónapok közti elválasztó vonalat).

```html
<tr class="first">
  <td class="left" rowspan="3">Január</td><td>2024</td><td>12&nbsp;345</td><td class="flat">—</td><td>7&nbsp;400</td><!-- … csoportoszlopok --></tr>
<tr><td>2025</td><td>13&nbsp;001</td><td class="up">+5,3%</td><td>7&nbsp;900</td><!-- … --></tr>
<tr><td>2026</td><td>11&nbsp;800</td><td class="down">-9,2%</td><td>7&nbsp;100</td><!-- … --></tr>
```

- A csoportoszlop értéke `years[i].byGroup[<oszlop id>]`; hiányzó kulcs vagy 0 → `—`.
- **Ha a totál 0 (nincs adat), a vs. LY is `—` (`class="flat"`), *nem* `-100,0%`.**
  Ez a tárgyhónap utáni hónapok tárgyévi sorára mindig igaz; az előző évek sorai ezekben a
  hónapokban is valós adatot mutatnak, ha van.

**Összegzősorok** — `class="sum"` minden sorukon:

1. A tárgyhónap sorai *után*: `Totál (1-M)` — a YTD-tábla, csoportonként a `byGroup`, vs. LY a `vsLy`.
2. A tábla végén: a JSON `grandTotal` mezője változatlanul — `label`, `years[].total`, `vsLy`,
   `byGroup`. **Ezt ne számold újra**, másold.

```html
<tr class="sum"><td class="left" rowspan="3">Totál (1-8)</td><td>2024</td><td>836</td><td class="flat">—</td><!-- … --></tr>
```

---

## 6. A szöveg — `{{SZOVEG}}`

Három szakasz, összesen legfeljebb 250 szó, egyszerű HTML-lé fordítva:

```html
<h2>Vezetői összegzés</h2>
<p>…</p>
<h2>Beavatkozást igényel</h2>
<ul><li>…</li></ul>
<h2>Pozitív fejlemények</h2>
<ul><li>…</li></ul>
```

- **Vezetői összegzés** — 3–5 mondat, minden mondatban szám (mátrix darab vagy partner forint).
- **Beavatkozást igényel** — max. 3 `<li>`: probléma + szám + javasolt lépés. Nincs tétel → egy
  `<li>Nincs beavatkozást igénylő tétel.</li>`.
- **Pozitív fejlemények** — max. 3 `<li>`: mi történt + szám.

Kiemelés `<strong>`-gal, mértékkel. Egyéb tag ne kerüljön bele (a sablon CSS-e csak ezekre van beállítva).

---

## 7. Fejléc-helyőrzők

| Helyőrző | Érték |
|---|---|
| `{{EV}}` / `{{HONAP_NEVE}}` / `{{HONAP_SZAMA}}` | `2026` / `augusztus` / `8` |
| `{{IDOSZAK_TOL}}` / `{{IDOSZAK_IG}}` | `meta.filterFrom` / `meta.filterTo` első 10 karaktere |
| `{{KESZULT}}` | a report készítésének napja, `YYYY-MM-DD` |

---
name: havi-vezetoi-report
description: Havi vezetői értékesítési report készítése az Ostorosbor CRM Connector API-jából — a „Havi termékcsoport" (Kimutatás / Összesítés) mátrix az elmúlt 3 év azonos hónapjaival, plusz max. fél oldal szöveges összefoglaló a vezérigazgatónak, egyetlen nyomtatható HTML fájlban. Használd, ha havi report, havi vezetői összefoglaló, havi termékcsoport riport, CEO-report vagy hónapzáró értékesítési jelentés a kérés — akkor is, ha a felhasználó csak egy hónapot nevez meg („készítsd el az augusztusi reportot").
allowed-tools: http_api_get, http_api_get_all, create_html
---
# Havi vezetői report

Készíts egyetlen, nyomtatható HTML riportot: KPI-sáv, két ábra, legfeljebb 250 szó vezetői szöveg és a havi termékcsoport-mátrix. A számokat kizárólag a CRM-válaszokból és a `references/report-osszeallitas.md` képleteiből vedd; becslés tilos.

Platform-szabályok:
- Az **Ostoros CRM Autorefresh** connectort használd. A connectorId-t a rendszerüzenet hozzárendelt connector-listájából vedd.
- A mátrixhoz `http_api_get`, a teljes partner-eredményhez `http_api_get_all` kell. Ne kérj base URL-t, API-kulcsot vagy agent ID-t: a platform injektálja a hitelesítést és a kötelező fejléceket.
- A két mellékletet legfeljebb egyszer olvasd be: `assets/report-sablon.html` és `references/report-osszeallitas.md`. Folytatáskor ne olvasd újra őket és ne ismételd meg a már sikeres API-hívásokat; használd a `tool-outputs/` alatt megőrzött eredményt.
- Ne kérd le a datasets, metadata vagy presets katalógust: a szükséges, jóváhagyott pathok itt szerepelnek.
- A kész fájlt a `create_html` eszközzel hozd létre; ne add vissza több tízezer karakteres kódblokkban.

## Bemenet és dátumok

A tárgyhónap a felhasználó által megadott `YYYY-MM`; ha hiányzik, az előző lezárt naptári hónap. Számítsd ki:
- `monthFrom`: a tárgyhónap első napja;
- `monthTo`: a tárgyhónap valódi utolsó napja;
- `ytdFrom`: a tárgyév január 1.;
- `matrixFrom`: a tárgyévet megelőző második év január 1.

Minden dátum `YYYY-MM-DD`, a határok inkluzívak.

## Adatlekérés — 3 kötelező lekérdezés

1. Mátrix: `http_api_get`, path `/reports/product-group-monthly`, query `{ from: matrixFrom, to: monthTo }`.
2. Partner YoY, tárgyhó: `http_api_get_all`, path `/reports/query`, query `{ preset: "partner-turnover", from: monthFrom, to: monthTo, compare: "yoy" }`.
3. Partner YoY, YTD: ugyanaz, query `{ preset: "partner-turnover", from: ytdFrom, to: monthTo, compare: "yoy" }`.

A partner-lekérdezések a connector által deklarált lapozást követik. Csak akkor használj partnerállítást, ha a `http_api_get_all` eredménye `paginationComplete: true`; így a pozitív, negatív és új partnerek a teljes lekért sokaságból származnak. Hiányos vagy hibás partnereredménynél a partnerállításokat hagyd ki, de a teljes mátrixriportot készítsd el.

Minden válaszburok payloadja a `data` mező alatt van. A mátrix mennyisége **darab**, a partner-turnover `netValue` értéke **forint** — ne keverd őket egy mondatban.

### Mátrix-válasz (`/reports/product-group-monthly`)

```jsonc
{
  "period": { "from": "2024-01-01", "to": "2026-08-31" },
  "years": [2024, 2025, 2026],
  "columns": [{ "id": "OSTOROS", "label": "OSTOROS" }, …],
  "months": [
    { "month": 1, "label": "Január",
      "years": [{ "year": 2024, "total": 12345, "vsLy": null, "byGroup": { "OSTOROS": 800, … } }, …] }
  ],
  "ytd": { "throughMonth": 8, "label": "Totál (1-8)", "years": [ … ] },
  "grandTotal": { "throughMonth": 12, "label": "TOTÁL", "years": [ … ] },
  "meta": { "filterFrom": "…", "filterTo": "…", "measure": "quantity", … }
}
```

- `vsLy` **arány**, nem százalék (`0.184` = +18,4%). `null`, ha az előző év azonos hónapja 0 volt.
- A **TOTÁL nem az oszlopok összege** — az oszlopok átfedő metszetek.
- `EXPORT` a VEVŐ-csoport; `3L` / `1,5L` kiszerelés-metszet; `SAJÁTMÁRKA` a Kategorizálás zászlója.
- `ytd.throughMonth` = az utolsó hónap, amelyben a legfrissebb évnek van adata. `ytd` `null`, ha ez 12.
- `grandTotal` és `ytd` mezőket a HTML-ben **másold**, ne számold újra.

### Partner-válasz (`/reports/query`, `preset: partner-turnover`)

Csak `paginationComplete: true` esetén használd a szöveghez. Sor-alak:

```jsonc
{ "dimensions": { "account.name": "…" },
  "current": { "netValue": 1234567 },
  "previous": { "netValue": 1000000 },
  "varPct": { "netValue": 0.2346 },
  "share": { "netValue": 0.081 } }
```

`varPct.netValue` is arány. A preset top 20 + „egyéb" sort ad; a totál a sorok összege.

Ha a dedikált mátrix-pathot a platform `endpoint not allowed` hibával elutasítja, egyetlen fallback engedett: `GET /reports/query` query `{ preset: "product-group-monthly", from: matrixFrom, to: monthTo }`. A generikus válasz alakját ellenőrizd, és csak akkor folytasd, ha ugyanazok a hónap/év/csoport totálok egyértelműen kinyerhetők; ne kezeld automatikusan a dedikált GET `data.months` alakjaként. Más hiba vagy nem ekvivalens payload esetén állj meg, és jelezd a connector-spec eltérést.

Ne hívd a `/sales-alerts`, `/activities` vagy `/insights` végpontot ehhez az alapriporthoz: nagy vagy pillanatnyi válaszuk nem szükséges a kért havi összevetéshez.

## Összeállítás és átadás

1. A mátrix után egyszer olvasd be a két mellékletet.
2. A `report-osszeallitas.md` szerint számold ki a KPI-kat, YTD-t, oszlopmagasságokat és táblasorokat.
3. A vezetői szöveg három része (részletek: `references/report-osszeallitas.md` §6):
   - **Vezetői összegzés** — 3–5 mondat: mi történt a hónapban, hogyan áll az év.
   - **Beavatkozást igényel** — max. 3 pont: probléma + szám + javasolt lépés, egy mondatban.
   - **Pozitív fejlemények** — max. 3 pont: mi történt + szám.
   Összesen legfeljebb **250 szó**. Minden állításhoz szám tartozik; „erős hónap" tilos, „+18,4% a tavalyi augusztushoz" jó. A mátrix darab, a partner-turnover forint — ne keverd. A partnerneveket használd. Ne ismételd a táblázatot: a szöveg azt mondja el, amit a táblából nem lehet leolvasni. Egy zajos hónapnál nézd meg a YTD-t is. Ha nincs beavatkozást igénylő tétel: „Nincs beavatkozást igénylő tétel." — ne találj ki hármat.
4. Cseréld ki a sablon összes `{{...}}` helyőrzőjét, majd `create_html`-lal mentsd `havi-report-YYYY-MM.html` néven.

## Ellenőrzés átadás előtt

- [ ] Nem maradt `{{` a fájlban.
- [ ] JavaScript nélkül is látható a KPI-sáv, mindkét ábra, a szöveg és a teljes mátrix.
- [ ] Nincs `<script>`, kliensoldali adatbetöltés vagy üres adatkonténer.
- [ ] A táblában `1 + 14 × évszám` darab `<tr>` van (fejléc + 12 hónap + Totál (1-M) + TOTÁL).
- [ ] A tábla `TOTÁL` sora betűre egyezik a JSON `grandTotal` mezőjével.
- [ ] Ahol a totál 0, ott `—` áll, nem `-100,0%`.
- [ ] Minden `vsLy` egy tizedessel, vesszővel, előjellel: `+18,4%`.
- [ ] A szöveg 250 szó alatt; a fejlécben a helyes tárgyhónap.
- [ ] Nyomtatási előnézetben 2 oldal (a mátrix új oldalon kezdődik).

Ha a partner-lekérdezés nem teljes vagy hibázik, a mátrixriportot akkor is készítsd el, és a partnerállításokat hagyd ki. Ha a mátrix nem áll rendelkezésre, ne készíts félkész vagy becsült reportot.

## Statikus HTML-megjelenítés — kötelező

A leadott fájl teljes értékű, önálló statikus HTML legyen: az API-ból származó vagy abból kiszámolt minden érték már tényleges HTML-szövegként és markupként szerepeljen benne. A KPI-k, mindkét ábra, a szöveg és a teljes mátrix JavaScript nélkül, fájl-előnézetben és nyomtatási nézetben is látható legyen. A sablon statikus HTML/CSS markupját töltsd ki, és a kész fájlt csak a tényleges értékek behelyettesítése után add át.

Átadás előtt külön ellenőrizd, hogy nincs script, kliensoldali adatbetöltés, üres később kitöltendő adatkonténer vagy olyan HTML-rész, amely csak JavaScript futásakor jelenik meg.

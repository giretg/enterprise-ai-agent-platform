# LLM Wiki kézi smoke (#947): lelet-wiki Claude Code-ban és Codexben

Az automatizált `npm run test:kb-wiki-e2e` modell nélkül fut. Ez a kézi próba azt nézi meg, hogy egy valódi kliensmodell a briefing és a `llm-wiki-maintainer` skill alapján tényleg így dolgozik-e.

## Előkészítés

1. Készítsd el a szintetikus leleteket: `cd app && npm run fixtures:health-wiki` (a fájlok a `scripts/fixtures/health-wiki/out/` mappába kerülnek; valódi személyes adatot nem tartalmaznak).
2. Control Plane → Tudásbázis → **Új tudásbázis**: privát, sablon „Egészség-napló”.
3. Agent-beállítás → Tudásbázis: az új wiki hozzáférése **ír**, a módja **közvetlenül**. Ezután publikáld az agentet.
4. A tudásbázis Tálca fülén töltsd fel az első 6 fájlt (közöttük legyen legalább egy `scan_*.pdf`).

## Lépések (Claude Code, majd ugyanez Codexben)

1. Első munkamenet: „Dolgozd fel a tálcát, de legfeljebb 3 leletet.” Elvárt: az agent foglal, a `scan_*` oldalakat képként kéri, minden lelet után azonnal ír, majd beszámol, hány tétel kész és hány maradt.
2. Új munkamenet: „Folytasd a tálcát.” Elvárt: ott folytatja, ahol abbamaradt, és semmit nem dolgoz fel kétszer.
3. Kérdés: „Hogyan alakult az LDL 2022 óta?” Elvárt: az `index.md`-ből indul, majd a `labs/ldl-koleszterin.md` oldalt olvassa; a válasz a wiki-oldalra és az eredeti leletre (documentId + oldal) hivatkozik.
4. Kérdés: „Mire figyeljek a következő kontrollon?” Elvárt: a válasz külön kezeli a leletből származó tényt és a saját értelmezést, nem állít fel diagnózist, és riasztó eltérésnél orvost javasol.
5. Ellenőrzés a Control Plane-en: a wiki-nézetben látszanak a `sources/`, `labs/` és `timeline.md` oldalak, a tálca üres, a napló teljes.

## Jegyzőkönyv (ezt kell bemásolni a PR-ba)

| Kliens / modell | Lépés | Eredmény (OK / hiba) | Megjegyzés (hivatkozás, képolvasás, kettős feldolgozás) |
|---|---|---|---|
| Claude Code / … | 1–5 | | |
| Codex / … | 1–5 | | |

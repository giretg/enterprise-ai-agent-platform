Az Enterprise AI platform egy kis- és közepes vállalkozásoknak készült AI management platform, amely lehetővé teszi, hogy egy kis vagy közepes vállalkozás a munkatársainak megfelelő AI eszközöket adhasson a kezébe úgy, hogy közben 
- az AI munkatársak az általa végzett munkát auditálhatóvá teszi.
- pontosan meghatározhatja, hogy milyen hozzáférési jogokat ad a valódi és AI munkatársak számára. Korlátozhatja, hogy mit végezhetnek, vagy mit nem végezhetnek az AI segítségével. 
- Leegyszerűsíti az AI feladatok végzését a munkatársak részére. 
- a költségeket kontrollálhatja
- széles skálán paraméterezhetővé teszi, hogy egy AI agent mennyire végezhet önálló munkát, és hogy milyen adatokhoz és eszközökhöz férhet hozzá. A platformnak támogatnia kell azt, hogy egy ilyen agent akár nagyon nagy szabadsággal dolgozzon, akár nagyon szigorúan le legyen korlátozva a működése.

Az alkalmazás az operátorok részére egyszerűnek, áttekinthetőnek kell lennie, hasonlóan a Codex, Claude Cowork vagy Grok Bot alkalmazásokhoz. Az UI elemek a felhasználó számára legyenek magától értetődőek, letisztultak és érthető, egyszerű nyelven magyarázzák el saját funkciójukat (pl. hover vagy ? gomb segítségével), ha ez szükséges.
Az adminisztrátorok számára előírás, hogy részleteiben tudják paraméterezni az adott tenant vagy az adott agent munkáját.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Egyéb szabályok
- Csak akkor alkalmazz sub-agent-et, ha a feladat tényleg komplex
- magyarul kommunikálj
- a problémákat úgy fogalmazd meg, hogy azok üzleti (UX)hatása legyen világos, a kódot a felhasználó nem ismeri!
- A felhasználó chat ablakban vagy feladat ticketben tud feladatot adni agentnek. Minden funkciónak műkdöni kell mindkét úton adott feladatok esetén
- Specifikációt mindig GitHub issue-ként készíts (lásd `docs/agents/issue-tracker.md`), ne külön fájlként
- Új feature-höz külön git worktree-t nyiss, hogy a párhuzamos fejlesztések ne zavarják egymást; a munkát PR-okba rendezve szállítsd
- UI-szöveget üzleti felhasználónak írj: közérthetően, zsargon nélkül; bonyolult funkciónál adj magyarázatot (`?` ikon hover/kattintás szöveggel, vagy ha muszáj, közvetlenül a felületen)

# PR készítés
- A PR elkészítése előtt teszteld a kódot, és ha szükséges, a teszt alapján tegyél javaslatot arra is, hogyan lehetne javítani a tesztelés hatékonyságát (módszer, eszközök).
- A PR leírásához használd a `pr` skillt. Ha nem érhető el, a szerkezet: `## Summary`, `## Evidence`, `## Merge Danger` (`**Door:**` és `**Blast Radius:**`).
- A Merge Danger blokkba írd be: `**Kockázat:** <zöld|sárga|piros> – <kiváltó ok>`. A szín szabálya: `docs/agents/pr-risk.md`.
- Merge: a zöld és a sárga PR-t zöld CI után az agent is mergelheti, a piros PR-t ember hagyja jóvá.
- A piros PR-t lehetőség szerint feature flag mögött szállítsd, hogy tenantonként bevezethető és kikapcsolható legyen. A rendszer speceje: #1126. Amíg az alap nem készült el, a PR-ban jelezd, ha emiatt nincs flag.
- Hibajavítás és biztonsági javítás ne kerüljön flag mögé, mert kikapcsolva a hiba élne tovább. A belépés, a tenant-elkülönítés és az audit se legyen flaggel kikapcsolható.
- A migrációt a flag nem vonja vissza. Sorrend: bővítő migráció, flag mögötti kód, teljes bevezetés, végül külön PR-ban a régi út törlése.
- A bekapcsolva írt adatot a régi kódnak is tudnia kell olvasni, és a flag mindkét állapotára legyen teszt.

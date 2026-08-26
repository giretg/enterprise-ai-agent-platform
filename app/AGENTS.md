<!-- BEGIN:nextjs-agent-rules -->


Az Enterprise AI platform egy kis- és közepes vállalkozásoknak készült AI management platform, amely lehetővé teszi, hogy egy kis vagy közepes vállalkozás a munkatársainak megfelelő AI eszközöket adhasson a kezébe úgy, hogy közben 
- az AI munkatársak az általa végzett munkát auditálhatóvá teszi.
- pontosan meghatározhatja, hogy milyen hozzáférési jogokat ad a valódi és AI munkatársak számára. Korlátozhatja, hogy mit végezhetnek, vagy mit nem végezhetnek az AI segítségével. 
- Leegyszerűsíti az AI feladatok végzését a munkatársak részére. 
- a költségeket kontrollálhatja
- széles skálán paraméterezhetővé teszi, hogy egy AI agent mennyire végezhet önálló munkát, és hogy milyen adatokhoz és eszközökhöz férhet hozzá. A platformnak támogatnia kell azt, hogy egy ilyen agent akár nagyon nagy szabadsággal dolgozzon, akár nagyon szigorúan le legyen korlátozva a működése.

Az alkalmazás az operátorok részére egyszerűnek, áttekinthetőnek kell lennie, hasonlóan a Codex, Claude Cowork vagy Grok Bot alkalmazásokhoz. Az UI elemek a felhasználó számára legyenek magától értetődőek, letisztultak és érthető, egyszerű nyelven magyarázzák el saját funkciójukat (pl. hover vagy ? gomb segítségével), ha ez szükséges.
Az adminisztrátorok számára előírás, hogy részleteiben tudják paraméterezni az adott tenant vagy az adott agent munkáját.


# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
# Egyéb szabályok
- Csak akkor alkalmazz sub-agent-et, ha a feladat tényleg komplex
- magyarul kommunikálj
- a problémákat úgy fogalmazd meg, hogy azok üzleti (UX)hatása legyen világos, a kódot a felhasználó nem ismeri!
- A felhasználó chat ablakban vagy feladat ticketben tud feladatot adni agentnek. Minden funkciónak műkdöni kell mindkét úton adott feladatok esetén


<!-- END:nextjs-agent-rules -->

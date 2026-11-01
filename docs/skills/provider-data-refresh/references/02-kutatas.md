# 2. Kutatás és adatgyűjtés

A kutatást **a Playbook szerint** végzed. A lenti 2.2–2.4 a módszertan, ha a Playbook lépései
rövidek vagy üresek; ha a Playbook részletes, a `hunt_steps` a sorrend, ez a fejezet a
minőségi minimum.

## 2.1. Exportált adatok áttekintése

Olvasd el a JSON-t és az MD-t. Jegyezd fel:

- termékek / mainservice-ek
- árazási modell, feeset/fee struktúra
- szerződéses feltételek
- speciális funkciók / akciók

## 2.2. Weboldal áttekintése és lenyomat-kontextus

### 2.2.0. Előző lenyomat + előző run (ha létezik)

- `platform.work_file.list` `prefix: "provider-data-refresh/{slug}/snapshots/"`; ha van, olvasd el
  (`work_file.read`) a **legutolsó** `YYYY-MM-DD.md` fájlt.
- Ha a Playbook source-on van `content_hash`, hasonlítsd az újonnan letöltött dokumentum
  hash-éhez — ha egyezik, az a forrás nem változott.
- Olvasd a briefing `last_run.summary`-ját és a `lessons.accepted` listát.
- **Cél:** látszódjon, mi változott az előző frissítés óta.

### 2.2.1. Weboldal és Playbook sources

Nyisd meg a Playbook `sources` URL-jeit típus szerint (`pricing_page`, `fee_pdf`, `social`,
`press`, `other`), plusz a szolgáltató hivatalos, magyarországi kereskedői oldalát, ha az
nincs a listán.

Ellenőrizd:

- Termékportfólió (új vagy eltűnt termékek?)
- Aktuális árazás
- Szerződési feltételek
- Akciók, promóciók (**lejárt dátumú akciót élőként hirdető oldalt jelezz külön**)
- Hírek, bejelentések

Minden ténylegesen megnyitott abszolút http(s) URL-t gyűjts — a run `visited_urls`
mezőjébe kerül (legfeljebb 100).

**Eszköz:** a kliens saját webes eszköze (böngésző / fetch / keresés). A POSnavigator connector
csak a research API-t éri el, külső oldalt nem. Ha a kliensnek nincs webes eszköze, a kutatás
nem végezhető el: a run `blocked`, a `summary` mondja meg, mi hiányzik.

**Gyakorlati megjegyzések** (korábbi körök tapasztalata):

- JS-renderelt vagy túl nagy oldalnál a sima lekérés üres vázat/menüt ad; ilyenkor böngésző
  (valódi renderelés) vagy célzott keresés + elsődleges PDF a megoldás. Ha a kliensen nincs
  renderelő böngésző, ezt írd a `summary`-ba, és ne pótold kitalált adattal. Másodlagos forrásra
  (viszonteladó, hírportál) támaszkodást jelöld meg, és kérj élő megerősítést.
- Ha a szolgáltató nem magyar entitás (pl. EU-passporting alapján működik), vagy az oldal
  kizárólag online terméket kínál fizikai POS nélkül, ezt rögzítsd kulcs-eltérésként a profil
  kategorizálásához.
- Jogutódlás/márkanév-változás (felvásárlás, fúzió, átnevezés) gyakori elavulási ok:
  üzemeltető neve, jogi forma, vezetőség, tulajdonosi struktúra.
- Ha egy korábbi körben "megszűnt/nem létezik" megállapítást tettél, de új jel mást mutat,
  közvetlenül kérdezd le, és **helyesbítsd** a korábbi megállapítást a jelentésben.

## 2.3. Árazási URL-ek, díjhirdetmények, Playbook PDF map

- Keresd meg az árazási oldalt / kondíciós listát / PDF-et.
- Kövesd a Playbook `notes` és `hunt_steps` utasításait (oldalszekció, PDF, összevetési logika).
- Ha jobb / aktuálisabb URL-t találsz, **ne** a legacy freshness PATCH-csel vidd át. A kör
  végén a Playbook `sources` tömbjét frissíted (lásd `05-utomunka-api.md`, 7.3; ha a PATCH nem
  hívható, Lesson `playbook_patch` javaslattal). Egy Playbook PATCH atomikusan tükrözi a
  nem-social source-okat a Bank `data_verification_urls` mezőjébe.
- Ellenőrizd a dokumentumok **hatálydátumát** (pl. "HATÁLYOS: 2023.06.16" egy 2026-os
  üzletszabályzat mellett = elavult terméktájékoztató).

### 2.3.1. PDF kondíciós lista strukturált feldolgozása

Ha a díjak PDF-ben vannak (különösen nagy bankoknál), ne csak átfutva olvasd: a Playbook
`pdf_maps` szerint vedd ki a mezőket, és vesd össze az előző körrel.

**Kanonikus mapping a Playbook `pdf_maps`.** Nincs helyi YAML-tár: a mappinget a briefingből
olvasod, és ha a PDF struktúra változik, a kör végén a **teljes** új listát javasolod vissza
(7.3 PATCH, vagy 7.4 Lesson `playbook_patch`-csel — a tömb **cserél**, nem append).

**A script futtatása a kliens gépén történik** (nem a platform sandboxában, az nem kap bemeneti
fájlt és hálózatot). Lépések:

1. Mentsd a briefing `playbook.pdf_maps` tömbjét a kliens gépére `pdf_maps.json` néven.
2. Töltsd le a PDF-et a kliens gépére (a kliens webes eszközével vagy a Drive-ról).
3. Futtasd:

       python3 -m pip install -r scripts/requirements-pdf-parser.txt
       python3 scripts/parse_pdf_conditions.py --bank Raiffeisen --pdf kondiciok.pdf \
         --mapping pdf_maps.json --previous raiffeisen_kondiciok_parsed_ELOZO-DATUM.json

   A `--previous` az előző kör `…_parsed_….json` fájlja (a work file-ban őrzöd, lásd lent).
4. Kimenetek (a PDF mellé, vagy `--output-dir`): `{bank}_kondiciok_extracted_YYYY-MM-DD.md` és
   `{bank}_kondiciok_parsed_YYYY-MM-DD.json` (`changes` / `change_table_rows` = a
   változástáblázat kiindulópontja).
5. A parsed JSON-t mentsd work file-ba (`provider-data-refresh/{slug}/…_parsed_….json`, ha
   ≤ 200 000 karakter), hogy a következő kör `--previous`-ként használhassa. A
   `documents_found`-hoz a script a PDF `sha256`-ját is megadja (`metadata.source_pdf_sha256`).

A parser nem váltja ki a szakmai ellenőrzést. Eltérésnél a kinyert sort vesd össze a PDF
szövegével, és ha a map rossz: Lesson `kind: bad_field_mapping`.

**Ha a kliensen nincs Python vagy a PDF nem tölthető le helyben — szövegből:**

1. PDF Drive-ban: `google_drive_search` (`mimeTypes: "application/pdf"`, `nameContains`) →
   `google_drive_read_file` — a PDF kinyert markdown-szövegét kapod, táblázatokkal. Ha a
   válasz `truncated` vagy üres szöveg (szkennelt PDF), azt jelezd, ne tölts ki adatot.
2. Webes PDF: a kliens webes eszköze olvassa. A `documents_found`-ban az URL és a
   hatálydátum elég; hash csak akkor, ha tényleg kiszámoltad.
3. Alkalmazd a `pdf_maps` elemeit a szövegen: `regex` / `regex_findall` (1-alapú `page`, `group`
   0-alapú), `table_rows` (`table_index`, `row_match_values`), `text_block` (`start` → `end`).
   Egy elem sem illeszkedik → ne találj ki értéket: jelezd, hogy a map elavult (Lesson
   `bad_field_mapping`).
4. Az eredményt írd a snapshotba mezőnként (id, érték, oldal), az előző kör értékeihez
   hasonlítva készítsd a változástáblázatot (`04-jelentes.md` 3.2.1).

> A parsed JSON-ban nincs `bank_data_freshness_patch_suggestion`: az a legacy freshness API
> blokkja volt. A tartós receptet a Playbookba írd.

## 2.4. Social media

A Playbook `type: social` source-ai az elsődleges lista. Ezeken túl nézd a LinkedIn /
Facebook / Instagram / YouTube / TikTok jelenlétet, ha a kutatáshoz kell. Min. 2 social
csatornát nézz meg.

Figyelj: posztok a legutolsó run óta, bejelentések, kampányok, visszajelzések, iparági
trendek.

## 2.4.5. Strukturált weboldal-lenyomat (kötelező)

A webes kutatás végén (proposal összeállítása **előtt**) készíts kivonatot.

- Work file: `provider-data-refresh/{slug}/snapshots/YYYY-MM-DD.md` (a vizsgálat napja, ISO),
  `platform.work_file.write`.
- Nem teljes archívum, hanem kulcs szekciók: árazás, terméknevek, funkciók, GYIK / feltételek.
- Minden nagyobb blokk előtt forrás URL (`## Árazás — https://...`).
- Eszköz: a kliens böngészője vagy más megbízható módszer a tényleges szövegre. Csak szöveg
  mehet bele (a work file nem tárol bináris PDF-et).

A következő kör **2.2.0** kiindulópontja. Sablon: `templates/snapshot-sablon.md`.

## 2.4.6. Kereskedői kérdések (kötelező)

A kutatás és a jelentés során rögzítsd, amit egy **kereskedő is megkérdezne**.

- Gyűjtő work file: `provider-data-refresh/_gyujto/kereskedo-kerdesek.md`, a sort
  `platform.work_file.append`-del add hozzá (sablon: `templates/kereskedo-kerdesek-sor.md`)
- Konkrét kérdésmondatok, nem belső jegyzet.
- Legkésőbb a proposal és a jelentés véglegesítése előtt. Ha nem volt új:
  `- **YYYY-MM-DD · [Szolgáltató]:** (nincs új kereskedői kérdés e körben)`

# 3–4. Helyi jelentés és szűrési teszt

Work file: `provider-data-refresh/{slug}/{Szolgáltató_neve}_elemzés_{YYYY-MM-DD}.md`
(`platform.work_file.write`; a 200 000 karakteres limit fölött bontsd két fájlra). Nyelv:
magyar, professzionális, actionable, forrásolt, vizuális kiemelésekkel. Váz:
`templates/riport-sablon.md`.

**Átadás:** a kész riportot egyszer töltsd fel a Drive `Adatkarbantartó` mappájába
(`google_drive_search` a mappára → `google_drive_upload_file`, `textContent`, `mimeType:
"text/markdown"`, `parentFolderId`, `idempotencyKey`). Ez jóváhagyást kér; ha nincs ilyen
mappa vagy a felhasználó nem hagyja jóvá, a work file az elsődleges példány, és ezt írd a
jelentés végére.

**Struktúra:** tartalomjegyzék, Executive Summary, három fő rész, következtetések + API
utómunka státusz (proposal/run/playbook/lesson id-k).

## Kötelező meta a jelentés elején

```
- bank_id:
- export revision (base):
- playbook version / ETag:
- proposal_id: (vagy „nincs — unchanged”)
- tervezett run outcome:
```

A POSnavigator a termékeket egységes szerkezetben tárolja
(mainservice → income sáv → basket sáv → MCC).

---

## ELSŐ RÉSZ: Adatfrissesség és pontosság ellenőrzése

**Cím:** "POS Navigator Adatok vs. Aktuális Online Információk"

### 3.1. Termékek és szolgáltatások
Megfelelés, új/megszűnt szolgáltatások, konkrét eltérések.

### 3.2. Árazási információk
Árak pontossága, új csomagok, promóciók, árazási URL.

### 3.2.1. VÁLTOZÁSTÁBLÁZAT (KÖTELEZŐ)

| Mező / Tétel | Irány | Jelenlegi érték (POSnavigator) | Javasolt új érték | Forrás | Indoklás |
|---|---|---|---|---|---|
| Havi alapdíj (Alap csomag) | ↑ | 2.990 Ft | 3.490 Ft | https://szolgaltato.hu/arak | Árazási oldal frissült, új listaár |
| Árazási URL | — | https://regi-url.hu/arak | https://uj-url.hu/kondiciok | — | Régi URL 404, új aloldal |

**Irány:** **↑** költség nőtt · **↓** csökkent · **↔** megváltozott, de nem egyértelműen
fel/le · **—** nem díjjellegű.

> Minden mező, amit a proposal payloadban megváltoztattál, szerepeljen itt. Az Indoklás = a
> `justifications` szöveg emberi változata. A proposal justification és a változástáblázat
> Indoklás oszlopa **ugyanazt** mondja.

### 3.2.2. TOVÁBBI DÍJAK (nem a költségszámítás része)
Bankszámlavezetés, SMS, nyomtatás stb. — név, összeg, mire vonatkozik, forrás. Cél: a
szolgáltató leírásában szövegesen is ott legyenek, linkkel a teljes díjjegyzékhez.

### 3.2.3. Díjváltozás-napló (kötelező, ha van díjmódosítás)

Ha a 3.2.1-ben legalább egy **↑↓↔** sor van:

- Work file: `provider-data-refresh/_gyujto/dij-valtozasok-YYYY-Qn.md` (Q a frissítés dátuma szerint)
- Bejegyzés a fájl **végére** (`platform.work_file.append`; a legújabb alul, mert az append
  nem szúr be elölre): dátum, szolgáltató, irány, tétel, régi → új, hivatkozás az elemzés
  fájlra **és** a `proposal_id`-re, ha van. Előtte olvasd el a fájlt, hogy ne duplázz.
  Sablon: `templates/dij-valtozasok-sor.md`.
- Ha nem volt díjváltozás: ne zajongj a naplóban; a checklistben jelezd.

### 3.3. Szerződéses feltételek
Feltételek, minimális forgalom, hűségidő, jogi változások.

### 3.4. Speciális funkciók
Új / eltávolított képességek, integrációk, szoftver/hardver.

### 3.5. Összefoglaló javaslatok — "Mit kell frissíteni a POS Navigatoron?"

Prioritás: kritikus / fontos / opcionális. A kritikus/fontos tételek **a proposalban**
legyenek, ne csak a jelentésben. Amit a modell nem tud tárolni, az maradhat manuális teendő +
**3.5.1**.

```
KRITIKUS:
- [ ] Alapdíj 2.990 → 3.490 Ft  → proposal mező: feeset X / fee Y cost_fixed
- [ ] Új termék: "SoftPOS" → placeholder id `new-softpos-1`

FONTOS:
- [ ] SZÉP kártya feltételek

OPCIONÁLIS:
- [ ] Logó (nem proposal — admin teendő)
```

### 3.5.1. Strukturális javaslatok az adatmodellhez
Ha a kutatás olyan díjat/adatot talál, amire nincs mező: új mező javaslat, félrevezető
mezők, szolgáltató-specifikus lyukak. Ez platformfejlesztési input, nem proposal.

---

## MÁSODIK RÉSZ: Marketing események elemzése

**Cím:** "Ajánlott Marketing Aktivitások és Repost Lehetőségek"

- **3.6. Releváns marketing események:** bejelentések, kampányok, konferenciák/webinárok, díjak.
- **3.7. Social media tartalom:** népszerű posztok, engagement, trendek.
- **3.8. POS Navigator megjelenítési javaslatok** — minden javaslatnál: platform, időpont,
  tartalom, miért releváns, célközönség, javasolt bevezető szöveg.

```
JAVASLAT #1
Platform: LinkedIn
Időpont: 2026.08.20.
Tartalom: …
Miért releváns: …
Célközönség: …
Javasolt bevezetés: "…"
```

---

## HARMADIK RÉSZ: Tartalmi javaslatok

**Cím:** "POS Navigator Tartalomstratégiai Javaslatok"

- **3.9. Social media poszt** — 1 rövid ötlet (típus/hook, üzenet, CTA + hashtag).
- **3.10. Blog cikk ötlet** — cím, téma + célközönség, 2–3 SEO kulcsszó.
- **3.11. Egyéb tartalom** — 1 kreatív ötlet (videó, infografika, FAQ, newsletter stb.).

> Landing SEO/FAQ tartalmi módosítást csak explicit kérésre javasolj mezőszinten, és az
> átadásban külön emeld ki (marketing felelős).

---

## ADATMINŐSÉG — Filters & Offers API szűrési teszt (kötelező)

A proposal **élő adatot nem változtat**. Ez a teszt a **jelenlegi élő** POSnavigator vs. a
kutatásban látott valóság. Ha a szűrés elromlott, az a proposal / 3.5 indoka. Az approve
után egy későbbi run ellenőrizheti újra.

**1. Szűrőopciók:** `http_api_get` `/filters` — szerepel-e a bank, konzisztensek-e a szűrők.

**2. Tesztszcenáriók** (min. 3, max. 5), `/offers` (a platform minden POST-ot írásként kezel,
ezért szcenáriónként **egy jóváhagyás** kell — a hívás nem ír adatot, de a kapu nem tudja).
Kezdés előtt mondd meg a felhasználónak, hány jóváhagyást kérsz, és csak akkor futtasd, ha
belemegy. Ha nem, a táblázat sorai: "kihagyva — nincs jóváhagyás", és a `/filters` vizsgálat
marad:

| # | Szcenárió | Forgalom (havi) | Kosárméret | MCC | Típus |
|---|---|---|---|---|---|
| 1 | Kis vendéglátó | 500.000 Ft | 3.000 Ft | 5812 | Fizikai terminál |
| 2 | Közepes bolt | 2.000.000 Ft | 8.000 Ft | 5411 | Fizikai terminál |
| 3 | Webáruház | 1.500.000 Ft | 12.000 Ft | 5999 | Online fizetés |
| 4 | Nagy forgalmú üzlet | 5.000.000 Ft | 15.000 Ft | 5411 | Fizikai terminál |
| 5 | Szolgáltató (pl. szépségápolás) | 800.000 Ft | 5.000 Ft | 7230 | Fizikai terminál |

Csak a szolgáltató célpiacára releváns szcenáriókat futtasd. (A `/offers` pontos body-ját és a szűrő-azonosítókat a connectorod `get_definition`
endpoint-leírásából oldd fel. Ha a POSnavigator connector nem listázza az `/offers`-t, a
tesztet hagyd ki, és jelezd az adminnak, hogy a Filters & Offers szerződés nincs bekötve.)

**3. Szempontok:** megjelenik-e; kalkulált díj reális-e (nem 0, nem abszurd); jó
mainservice/sáv; funkciók (NFC, SZÉP, borravaló) egyeznek-e. Megjegyzés: a `prices.sumprice` egy
**48 hónapos TCO összeg**, nem havi díj — a havi értékhez számold át.

**4. Táblázat a jelentésben** a 3.5 után:

```
### Szűrési teszt eredmények (Filters & Offers API — élő adat)

| Szcenárió | Megjelenik? | Kalkulált havi díj | Weboldalon talált díj | Egyezik? | Megjegyzés |
|---|---|---|---|---|---|
```

**5. Eltérés:** KRITIKUS, ha nem jelenik meg releváns szűrésnél (a 3.5-ben és a proposalban,
ha modellezhető). FONTOS, ha a díj >10%-kal eltér. OPCIONÁLIS, ha helyesen nem jelenik meg /
apró eltérés (megjegyzés).

## Content entities (ha releváns)

- Új payment scheme → `http_api_get` `/paymentschemes`
- Új feature → `/features`
- Új device → `/devices`
- Tipp/tudástár → `/tipps`

(Csak azokat hívhatod, amelyeket a `get_definition` engedélyez.)

Hiányzó entitást a jelentésben jelezd; a proposal csak a Bank hierarchiát viszi.

---

## Tippek

- Minél konkrétabb a jelentés és a justification, annál könnyebb a jóváhagyónak approve-olni.
- Nem igazolt tételnél írd ki: "nem tudtam megerősíteni", és add meg, mi kellene hozzá.
- Dátumhoz kötött tételeknél (akció vége, díjváltozás hatálya) számold ki a hátralévő időt,
  és jelezd az időérzékeny tételeket.

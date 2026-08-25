# Munka-nyomonkövethetőség: hol lesz az eredménye annak, amit kértem?

**Issue:** #375
**Státusz:** grill-lezárt — kód nincs
**Dátum:** 2026-08-25 (a 2026-08-24-i „munkatárs-szál" spec grill utáni átirata)
**Kapcsolódik:** #355 (agent-sáv shell), `ticket-thread-conversation-spec.md`,
`AI-Agent-Platform-Feature-Spec-Prompt-Cache-Stable-History.md` (a grill másik fele)

---

## 1. A probléma

Ma három, egyenrangúnak látszó hely van ugyanarra a munkára, és egyik sem mondja meg,
hol lesz az eredmény:

| Hely | Mit mutat | Mikor hazudik |
|---|---|---|
| Agent-chat (`/agents/:id/chat`) | egy beszélgetés üzenetei | ha a munka ticketben fut tovább, itt nincs vége |
| Feladat-tábla (`/board`) | ticketek kanbanon | nem mondja meg, melyik beszélgetésből jött |
| Múltbéli beszélgetések (`chat-session-sidebar.tsx`) | beszélgetések listája | a felhasználó nem tudja, melyikben mit mondott |

A kérdés, amit nem tudunk megválaszolni:

> *„Adtam egy feladatot, közben beszélgetek is vele — melyiknek hol lesz az eredménye?"*

Ezt tovább bonyolítja, hogy a chatből indított folyamat végeredménye **ticketben** landol,
és a ticket semmilyen látható módon nem mutat vissza oda, ahonnan indult.

## 2. Amit a grill eldöntött — és mit vetett el

Az eredeti spec erre egy **folytonos munkatárs-szálat** javasolt: minden beszélgetés egy
végtelen idővonalra kerül, a `Conversation` téma-szakasszá fokozódik le, és a téma-határon
összefoglaló készül. **Ezt elvetettük.** Az okok:

- **A fájdalom nem a beszélgetések száma.** A jegy problémafelvetése a chat, a tábla és a
  ticket közti hiányzó hivatkozásról szól. Ez a szál megépítése nélkül is megoldható,
  töredék költséggel.
- **A szál olyan folytonosságot ígér, amit a prompt nem tud tartani.** A ChatGPT-nél a
  felhasználó **tudja**, hogy új chat = tiszta lap, mert ő nyitotta. A szálban ez a döntés
  eltűnik, tehát a rendszernek kellene automatikusan vágnia — és minden automatikus vágás
  egy „az imént még tudta" élményt termel. Ez rosszabb, mint a mai állapot.
- **A költség-érv nem állt meg.** Az eredeti spec szerint a téma-határ token-megtakarítás.
  Valójában a prompt elejének stabilan tartása a megtakarítás forrása, és azt a szál
  nélkül, önmagában is meg lehet csinálni — l. a párhuzamos cache-specet.

**Amit megtartunk:** a beszélgetések maradnak külön, ahogy ma. A jegy tárgya innentől
kizárólag az, hogy **a munka útja láthatóvá és követhetővé váljon**.

## 3. UI-modell

### 3.1 Élő feladat-kártya a beszélgetésben

Amikor a chatből feladat indul, ott, abban a beszélgetésben megjelenik egy **helyben
frissülő kártya** — nem egy szövegmondat arról, hogy „létrehoztam a #217-es ticketet":

```
   Te     Töltsd fel a feldolgozott lapokat az Ostoros Föld API-ra.
   ┌─ FELADAT #217 ─────────────────────── ● Fut ─┐
   │ Adatok értelmezése és feltöltése             │
   │ 3/5 lépés · 19 perce · Ági                   │
   └──────────────────────────────────────────────┘
```

A kártya **ugyanaz az objektum**, mint a táblán. A kötés ma is létezik: a
`Message.ticketRefId` be van írva, csak a felület egy egyszerű linkként jeleníti meg.

### 3.2 Kétirányú hivatkozás

- A tábla minden kártyáján: `Eredet: Ági · „Ostoros feltöltés" · aug. 22. 14:03 →`
  (odaugrik a beszélgetésben, arra az üzenetre)
- A beszélgetés üzenetén: `Ebből lett: #217 ● Fut →`

Egy mondatos szabály, és csak ez az egy:

> **Minden feladat megmondja, melyik beszélgetésből jött; minden beszélgetés megmondja,
> milyen feladat lett belőle.**

### 3.3 Emlékezet-csík

Állandó, közérthető sor a beviteli mező alatt:

> 🧠 *Ági most erre emlékszik: ez a beszélgetés (14 üzenet) · projekt-memória · 2 nyitott feladat.*
> **[Mit tud pontosan?]**

A „Mit tud pontosan?" panel **tételesen** felsorolja, mi kerül a promptba: a beszélgetés
üzenetei, a visszakeresett projekt-memória, a nyitott feladatok, a munkaterület fájljai.

**Függőség:** amíg a párhuzamos cache-jegy WP-B csomagja nem szállít, a csík azt is
megvallja, ha üzenetek estek ki a 16-os ablak miatt (ma ez néma, csak egy
`context.truncated` audit-sor van). A WP-B után ez a sor tárgytalanná válik — a panel
akkor egyszerűen a teljes beszélgetést sorolja fel.

### 3.4 Feladat-eligazítás

Amikor chatből feladat indul, az agent összeállít egy **eligazítást**, amit a felhasználó
lát és szerkeszthet, **mielőtt** a munka elindul:

```
┌─ Ezt viszem magammal a feladatba ─────────────────────┐
│ Cél:        a 12 feldolgozott tulajdoni lap feltöltése│
│ Forrás:     /workspace/feldolgozott/*.json            │
│ Megkötés:   hiányzó hrsz-nél ne írj, jelezz           │
│ Jóváhagyás: írás előtt kell                           │
│                          [Szerkesztem]  [Mehet]       │
└───────────────────────────────────────────────────────┘
```

Három problémát old meg: (a) a futás tiszta, szűk kontextussal indul; (b) a felhasználó
**érti és javíthatja**, mit fog csinálni az agent, mielőtt elszalad; (c) auditálható nyoma
van, mi alapján indult a munka.

Az eligazítás a folyó forduló **mellékterméke**, strukturált kimenettel — nem külön
modellhívás.

### 3.5 A tábla megtisztítása

A táblát ma gépi című sorok szennyezik („Emberi felülvizsgálat: A(z) «feldolgozottLapPath…»").
A folyamat-lépés ticketek **beolvadnak a szülő futás kártyájába**: a táblán egy kártya áll,
a lépések azon belül látszanak.

## 4. Adatmodell-hatás

**Nincs.** A `Message.ticketRefId` és a `Ticket.conversationId` ma is megvan; a jegy
kizárólag felület és lekérdezés. Ha a tábla „Eredet" oszlopa lassúnak bizonyul, egy index
bővítése lehet szükséges — ez a WP-2 mérésekor derül ki.

## 5. Nem cél

- **A folytonos munkatárs-szál, a téma-szakaszok, az átvitel-blokk, az auto-plafon.**
  Elvetve, l. §2. Ha a jegy leszállítása után is megmarad a panasz, hogy a felhasználók
  elvesznek a beszélgetések közt, akkor ez újranyitható — de akkor már mérésre, nem
  feltételezésre alapozva.
- **A kontextus-összeállítás bármely része.** Átkerült a
  `AI-Agent-Platform-Feature-Spec-Prompt-Cache-Stable-History.md` specbe.
- **A ticket-kommentfolyam megszüntetése** (`ticket-thread-conversation-spec.md`).
  Szabály: **a beszélgetés a döntési felület, a ticket a mélység.**

## 6. Munkacsomagok

- [ ] **WP-1** Élő feladat-kártya a chatben (`Message.ticketRefId` → kártya-komponens,
      helyben frissülő állapottal)
- [ ] **WP-2** Kétirányú hivatkozás: `Eredet →` a táblakártyán, `Ebből lett: #217 →` az
      üzeneten; ugrás a beszélgetésben az adott üzenetre
- [ ] **WP-3** Emlékezet-csík + „Mit tud pontosan?" panel
- [ ] **WP-4** Feladat-eligazítás: összeállítás a forduló melléktermékeként,
      szerkeszthetőség, audit, ticket-kötés
- [ ] **WP-5** Folyamat-lépés ticketek beolvasztása a szülő futás kártyájába

Javasolt sorrend: **WP-1 → 2 → 5 → 3 → 4**. Az első három adja a jegy értékének nagy
részét, és egyik sem nyúl a modellhívásokhoz.

## 7. Kockázatok

| Kockázat | Ellenszer |
|---|---|
| A kártya és a tábla állapota szétcsúszik | a kártya ugyanabból a `Ticket` sorból renderel, nem másolt állapotból |
| Az „Eredet →" ugrás lassú hosszú beszélgetésnél | üzenet-szintű horgony + lapozott betöltés az adott üzenet köré |
| Az eligazítás félrevisz | a felhasználó **szerkesztheti** indítás előtt; a végleges szöveg auditba kerül |
| Az emlékezet-csík túl technikai | hétköznapi szöveg, a részletek csak a panelben |

## 8. Grill-napló (2026-08-25)

A döntések és az indoklásuk, hogy ne kelljen újra végigvitatni:

| # | Döntés | Indok |
|---|---|---|
| Q1 | Egy munkatárs = egy hely; nincs projekt-tengely a felületen | a `projectKey` a webes chatben soha nem íródik, tehát nincs mit szétosztani; egy második tengely visszahozná a „melyikben van?" kérdést |
| Q2 | Nincs második emlékezet-nyilvántartás | a nyitott feladatok, döntések, megkötések már a projekt-memóriában vannak; két tároló két igazságot ad |
| Q3 | A cache-érv fordítva állt; a téma-határ nem költség-eszköz | az előzmény ma egyik providernél sincs cache-elve — a megtakarítás forrása a stabil prefix, nem az összefoglaló |
| Q4 | A törlés-felkészítés kikerül (a szállal együtt) | ma egyetlen megőrzési szabály sem hozható létre felületről, tehát semmi nem törlődik; a `Conversation.title` titkosítatlansága külön jegyet érdemel, ha ez élesedik |
| Q5 | — (a szál elvetésével tárgytalan) | |
| Q6 | — (a szál elvetésével tárgytalan) | |
| Q7 | **(A)**: csak nyomonkövethetőség; a szál elvetve | a jegy fájdalma a hivatkozások hiánya, nem a beszélgetések száma |
| Q8 | — (a szál elvetésével tárgytalan) | |
| Q9 | Két jegy: ez + a prompt-cache jegy | nincs közös kódjuk; a cache-jegy azonnal, felület nélkül szállítható |

A Q10–Q13 döntések (hosszú beszélgetés kezelése, álnév-invariáns, cache-kezelés
provider-függése, a változó blokkok helye) a párhuzamos cache-spec „Implementation
Decisions" szakaszában vannak rögzítve.

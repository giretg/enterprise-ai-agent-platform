# Munkatárs-szál: folytonos beszélgetés téma-szakaszokkal

**Issue:** #375
**Státusz:** nyitott — kód nincs, grillre vár
**Dátum:** 2026-08-24
**Kapcsolódik:** #355 (agent-sáv shell), `agent-memory-persistent-cross-conversation-spec.md`,
`AI-Agent-Platform-Feature-Spec-Prompt-Cache-Prefix-Ordering.md`, `ticket-thread-conversation-spec.md`
**Kiváltó ok:** a felhasználó nem tudja megmondani, hol keresse egy munka eredményét,
ha chatben kérte, de ticketben készül el — és a „beszélgetés" fogalom maga is
szétesik múltbéli sessionökre.

---

## 1. A probléma két rétege

### 1.1 Amit a felhasználó lát

Ma három, egyenrangúnak látszó hely van ugyanarra a munkára:

| Hely | Mit mutat | Mikor hazudik |
|---|---|---|
| Agent-chat (`/agents/:id/chat`) | egy session üzenetei | ha a munka ticketben fut tovább, itt nincs vége |
| Feladat-tábla (`/board`) | ticketek kanbanon | nem mondja meg, melyik beszélgetésből jött |
| Múltbéli beszélgetések (`chat-session-sidebar.tsx`) | sessionök listája | a user nem tudja, melyikben mit mondott |

A kérdés, amit nem tudunk megválaszolni: *„adtam egy feladatot, közben beszélgetek is
vele — melyiknek hol lesz az eredménye?"*

### 1.2 Amit a kód valójában csinál — és ez fordítja meg a képet

A „minden új beszélgetés új session, ezért nem nő a kontextus" indoklás **ma nagyrészt
tárgytalan**. A `context-assembly.ts` már így dolgozik:

```
DEFAULT_CONTEXT_RECENCY_MESSAGES = 16     // csak az utolsó 16 érvényes üzenet
DEFAULT_CONTEXT_BUDGET_TOKENS   = 10000   // majd erre is rávágunk, hátulról előre
```

Vagyis egy **300 üzenetes beszélgetés promptja ugyanakkora, mint egy 16 üzenetesé**.
A session-váltás token-megtakarítása a 16. üzenet után nulla. Amit a session-váltás
tényleg ad, az három másik dolog — és ezeket **külön kell kezelni**, mert nem
ugyanaz a megoldásuk:

1. **fókusz** — a régi téma utasításai nem szennyezik az újat;
2. **megőrzési egység** — a `Conversation`-höz retention policy, `legalHold` és
   per-beszélgetés titkosítókulcs (`ConversationPrivacyKey`, crypto-shredding) tartozik;
3. **párhuzamosság** — a `0009_agent_turn` részleges egyedi index szerint egy
   `conversationId`-hez egyszerre **egy** aktív forduló lehet.

És amit a mai megoldás **elront**: a 16-os ablakon kicsúszó üzeneteket **némán,
összefoglaló nélkül** dobja el (`droppedSeqs`, csak `context.truncated` audit).
A felhasználó tehát **már ma is** átéli, hogy „de feljebb megírtam!" — csak nincs a
képernyőn semmi, ami megmagyarázná. Ez a spec ezt is orvosolja.

---

## 2. Alapállítás

> **A napló nem azonos a prompttal.**
> Amit a felhasználó görget, az egy folytonos idővonal. Amit a modell kap, az egy
> számított ablak. A kettőnek nem kell egy objektumnak lennie — és ma sem az.

Ebből következik a teljes design:

> **A `Conversation` marad a tárolási, megőrzési és futtatási egység — de megszűnik
> önálló *helynek* lenni. Egy téma-szakasz lesz az egyetlen, folytonos
> munkatárs-szálon belül.**

Ez azért fontos, mert így **nincs adatmodell-forradalom**: a retention, a legal hold,
a crypto-shredding granularitása és a párhuzamos futó fordulók lehetősége
változatlanul megmarad. A „folytonos beszélgetés" egy megjelenítési és
kontextus-összeállítási réteg fölöttük.

---

## 3. Névtár (a UI-ban ezek a szavak jelennek meg)

| Fogalom | UI-szó | Adatmodell |
|---|---|---|
| munkatárs-szál | **Szál** | `(tenantId, agentId, createdById, projectKey)` sorrendezve `lastMessageAt` szerint |
| téma-szakasz | **Téma** | egy `Conversation` sor |
| téma-váltás | **Új téma** | új `Conversation` a szálon belül |
| feladat | **Feladat** | `Ticket`, `Message.ticketRefId`-vel a szálba horgonyozva |
| projekt-hatókör | **Projekt** | `Conversation.projectKey` (már létezik) |

A „session", „beszélgetés indítása", „conversation" szavak **eltűnnek a felületről**.

---

## 4. UI-modell

### 4.1 A szál

Egy munkatárshoz egy görgethető idővonal tartozik. Nincs „Új beszélgetés" gomb.
A téma-szakaszok határa **látható elem**, nem navigáció:

```
      ── augusztus 20., szerda ──
   Te     Mit tudsz a novaji parcelláról?
   Ákos   …

      ═══ ÚJ TÉMA · „Ostoros feltöltés" · aug. 22. 14:03 ═══
      Innentől tiszta lappal dolgozik. A korábbi témákra
      összefoglalóban emlékszik, és vissza tud keresni.        [Miért?]

   Te     Töltsd fel a feldolgozott lapokat az Ostoros Föld API-ra.
   ┌─ FELADAT #217 ─────────────────────── ● Fut ─┐
   │ Adatok értelmezése és feltöltése             │   ← élő kártya, helyben frissül
   │ 3/5 lépés · 19 perce · Ági                   │
   │ [Megnyitom]  [Leállítom]                     │
   └──────────────────────────────────────────────┘
   Ákos   Közben megnéztem: 12 lapból 2-nél hiányzik a hrsz.
```

A ticket-kártya a szálban **ugyanaz az objektum**, mint a táblán — nem másolat.
A `Message.ticketRefId` mező ehhez ma is megvan; a szál-nézet ezt rendereli kártyaként.

### 4.2 A tábla mint lencse

A Feladat-tábla nem szűnik meg, de lefokozódik: a szálakban élő kártyák
keresztmetszete. Minden kártyán kötelező elem:

- `Eredet: Ákos-szál · „Ostoros feltöltés" · aug. 22. 14:03 →` (odaugrik a szálban)
- a szálban lévő üzeneten a visszamutató: `Ebből lett: #217 ● Fut →`

Egy mondatos szabály, amit a felhasználónak meg kell tanulnia — és csak ezt az egyet:

> **Az eredmény mindig a szálban van. A tábla megmondja, melyik szálban keresd.**

### 4.3 A „múltbéli beszélgetések" gomb helyett: tartalomjegyzék

A mai `chat-session-sidebar.tsx` külön dokumentumok fiókja. Helyette **ugyanannak a
szálnak a tartalomjegyzéke**: téma-címek dátummal és egy soros összefoglalóval,
kattintásra a görgetésben ugrik oda (nem tölt be másik oldalt). Kereső ugyanitt.

### 4.4 Emlékezet-csík

Állandó, közérthető sor a beviteli mező alatt:

> 🧠 *Ákos most erre emlékszik: ez a téma (14 üzenet) · 3 korábbi téma összefoglalója ·
> 2 nyitott feladat.* **[Mit tud pontosan?]**

A „Mit tud pontosan?" megnyit egy panelt, ami **tételesen** felsorolja a promptba
kerülő rétegeket (§5) — beleértve azt is, ha a 16-os ablak miatt üzenetek estek ki.
Ez a mai néma `context.truncated` láthatóvá tétele.

### 4.5 Feladat-átadás: a látható eligazítás

Amikor chatből feladat indul, a session-határ **hasznossá válik**: az agent
összeállít egy eligazítást, amit a felhasználó lát és szerkeszthet, mielőtt elindul.

```
┌─ Ezt viszem magammal a feladatba ───────────────────┐
│ Cél:        a 12 feldolgozott tulajdoni lap feltöltése │
│ Forrás:     /workspace/feldolgozott/*.json            │
│ Megkötés:   hiányzó hrsz-nél ne írj, jelezz           │
│ Jóváhagyás: írás előtt kell                           │
│                          [Szerkesztem]  [Mehet]       │
└───────────────────────────────────────────────────────┘
```

Három problémát old meg egyszerre: (a) a futás tiszta, szűk kontextussal indul;
(b) a felhasználó **érti és javíthatja**, mit fog csinálni az agent, mielőtt elszalad;
(c) auditálható nyoma van, mi alapján indult a munka.

A feladat **átívelhet témákon**: a kártya ott jelenik meg, ahol indult, a lezárás
viszont a szál aktuális végére kerül új bejegyzésként, visszalinkelve
(`↑ #217 · innen indult, aug. 22.`). Ez szándékos — pontosan így viselkedik egy
emberi kolléga is.

---

## 5. Kontextus-összeállítás

### 5.1 Rétegek

Egy fordulóban ez megy a modellhez (fentről lefelé = prompt-sorrend):

| # | Réteg | Stabilitás | Forrás |
|---|---|---|---|
| 1 | rendszer + persona + skill-kötés | agent-szinten állandó | `prompt-assembler.stablePreamble` |
| 2 | tartós projekt-memória (retrieval) | témán belül állandó | `memory-retrieval-service` (létezik) |
| 3 | **átvitel-blokk**: korábbi témák összefoglalói | témán belül **bájtra állandó** | ÚJ, §5.2 |
| 4 | **nyitott ügyek**: futó/rád váró feladatok | fordulónként változhat | ÚJ, §5.3 |
| 5 | aktuális téma üzenetei | append-only | `context-assembly.ts` (létezik) |
| 6 | tool-farok | változó | `chat-tool-loop.ts` |

### 5.2 Az összefoglaló a HATÁRON készül, nem folyamatosan

Ez nem stílus, hanem költség. Ha az összefoglalót minden fordulóban újraírnánk, a
prompt eleje minden körben változna, és **eldobnánk a prefix-cache-t** — pont az a
hiba, amit a `Prompt-Cache-Prefix-Ordering` spec ír le. Ezért:

- **téma-szakaszon belül a prompt szigorúan append-only** (3. réteg bájtra azonos,
  a `cacheBoundary` a 3. réteg végére kerülhet);
- **összefoglaló csak témazáráskor** generálódik, egyszer, és a lezárt
  `Conversation`-höz tapad;
- a témaváltás egyetlen, tudatos újrahorgonyzás — egy cache-miss témánként, nem
  fordulónként.

A 4. réteg (nyitott ügyek) rövid és változó, ezért **a cache-határ után** áll.

### 5.3 Mi megy át a téma-határon

| Átmegy | Nem megy át |
|---|---|
| korábbi témák 1–2 mondatos összefoglalója (utolsó N, ld. D2) | a korábbi témák nyers üzenetei |
| nyitott feladatok rövid listája (`#217 fut`, `#221 rád vár`) | lezárt feladatok részletei |
| tartós projekt-memória (már ma is) | tool-eredmények |
| kitűzött mellékletek / munkafájlok, ha a user kitűzte | automatikusan semmi melléklet |

A **nyitott ügyek mindig átmennek** — ez a legfontosabb szabály. Enélkül a
felhasználó témát vált, és az agent nem tud a saját futó munkájáról.

### 5.4 Visszakeresés kérésre

Új tool: `beszelgetes_kereses` (`conversation_search`) — a szál korábbi témáiban
keres, és a találatot **abba a fordulóba** húzza be, nem a tartós kontextusba.

- Hatókör kötelezően: `tenantId` + `agentId` + `createdById` — más felhasználó szálát
  nem láthatja (ld. D3).
- Ez a mentőöv arra, amikor a user azt mondja: *„de feljebb megírtam!"* — az agent
  meg tudja nézni és korrigálni tud.

---

## 6. Téma-határ: ki dönt?

Hibrid, de **soha nem némán**:

1. **Explicit** — „Új téma" gomb a szerzőmezőnél (a mai „Új beszélgetés" helyén).
2. **Javasolt** — ha az agent témaváltást érzékel:
   *„Ez új ügynek tűnik. Kezdjem tiszta lappal? Így gyorsabb és pontosabb lesz.
   [Igen] [Nem, ez ide tartozik]"*
3. **Kényszerített** — ha az aktuális téma átlép egy plafont (üzenetszám vagy
   eltelt idő), automatikus vágás — **de látható elválasztóval és indoklással**.

A felhasználónak szóló magyarázat sosem token-technikai, hanem ez:
*„tiszta lappal, hogy ne keverje a korábbi ügyekkel."*

---

## 7. Adatmodell-hatás (minimális)

`Conversation` kiegészítése — nincs új tábla, nincs migrációs kockázat a
meglévő sorokra:

| Mező | Típus | Miért |
|---|---|---|
| `summaryRef` | `String?` | a témazáró összefoglaló tartalom-referenciája (a `Message.contentRef` mintájára, hogy a törlés/retention ugyanúgy hasson rá) |
| `summarizedAt` | `DateTime?` | mikor készült |
| `boundaryReason` | enum: `explicit \| suggested \| auto_limit \| first` | miért nyílt ez a téma — a UI ezt magyarázza el |
| `closedAt` | `DateTime?` | mikor zárult le (új téma nyílt utána) |

A szál-azonosság **számított**, nem tárolt: `(tenantId, agentId, createdById, projectKey)`.
A meglévő `@@index([tenantId, agentId, lastMessageAt])` majdnem elég hozzá; a
`createdById`-vel bővített index kellhet (ld. WP-2).

**Megőrzés változatlan:** a retention policy, `retainUntil`, `legalHold` és a
`ConversationPrivacyKey` továbbra is téma-szakasz szinten él. Egy szál részlegesen is
öregedhet: a régi témák eltűnhetnek, a szál megmarad. A UI ilyenkor a helyükön
tombstone-t mutat (*„Ez a téma megőrzési idő miatt törlődött — aug. 3."*), nem néma lyukat.
**Az összefoglaló is törlődik a témával** — különben a crypto-shredding kilyukad.

---

## 8. Nem cél

- Nem cél a `Conversation` összeolvasztása egyetlen sorrá. (Elveszne a retention-
  granularitás, a crypto-shredding és a párhuzamos futó forduló lehetősége.)
- Nem cél a ticket-kommentfolyam (`ticket-thread-conversation-spec.md`) megszüntetése.
  Szabály: **a szál a döntési felület, a ticket a mélység.** Ami emberi döntést
  igényel, felbukik a szálba; a lépés-szintű munkanapló a kártyán belül marad.
- Nem cél a folyamat-lépés ticketek takarítása — de **látni kell**, hogy a mai táblán
  a 23-ból jó pár tétel gépi című, lépés-szintű „Emberi felülvizsgálat: A(z)
  «feldolgozottLapPath…»" sor. Ezek szülő-futásba vonása külön jegy (§10, WP-9).

---

## 9. Nyitott döntések (a grill anyaga)

| # | Kérdés | Javasolt kiindulás |
|---|---|---|
| **D1** | Ki javasol témahatárt, és miből? Heurisztika (idő, üzenetszám, első üzenet hossza) vagy külön olcsó modellhívás? | heurisztika + olcsó modell csak akkor, ha a heurisztika bizonytalan; a hívás költsége ne terhelje a fordulót |
| **D2** | Hány korábbi téma-összefoglaló megy át, és milyen kereten? Fix N vagy token-plafon? | utolsó 3 téma, összesen ≤600 token; a 10 000-es `DEFAULT_CONTEXT_BUDGET_TOKENS`-ből vonva |
| **D3** | A `beszelgetes_kereses` hatóköre. Csak a saját szál? Vagy ugyanazon agent más felhasználóinak szálai is (megosztott tudás)? | **csak a saját szál** — a bővítés külön authz-döntés, alapból tilt |
| **D4** | A téma nevét ki adja? Automatikus cím + átírható, vagy a user nevezi el? | automatikus az első üzenetből, egy kattintással átírható |
| **D5** | Migráció: ma több párhuzamos, félbehagyott beszélgetés van ugyanazzal az agenttel. Ezek időrendben egymás után kerülnek a szálra — vagy `projectKey` szerint külön szálakra? | `projectKey` szerint külön szál, azon belül időrend; a `__general__` egy szál |
| **D6** | Mi történik, ha a user egy régi témába ír vissza (a tartalomjegyzékből odaugorva)? Újranyílik a téma, vagy új témát nyit „folytatás" hivatkozással? | **újranyílik** (`closedAt` törlődik), és a szál végére kerül — különben szétesik az idővonal |
| **D7** | Az auto-plafon (D6 3. eset) mekkora legyen, és üzenetszámban vagy tokenben mérjük? | a mai 16-os ablak kétszerese üzenetben; token-alapon nehéz megmagyarázni a usernek |
| **D8** | A ticket-eligazítást (§4.5) ki állítja össze — külön modellhívás, vagy a folyó forduló melléktermékeként? | a folyó forduló melléktermékeként, strukturált kimenettel |
| **D9** | Kell-e szál-szintű keresés a globális keresőbe (minden munkatárs minden témája)? | igen, de külön WP; nem blokkolja a többit |

---

## 10. Munkacsomagok

| WP | Tartalom | Függ |
|---|---|---|
| **WP-0** | **Alapvonal mérése.** Beszélgetés/agent/user eloszlás, átlagos üzenetszám, `context.truncated` gyakorisága, hány beszélgetés hal el 3 üzenet alatt. Enélkül a D2/D7 találgatás. | — |
| **WP-1** | Adatmodell: `Conversation.summaryRef / summarizedAt / boundaryReason / closedAt` + migráció + retention-hatás tesztje (a summary is shreddelődik). | — |
| **WP-2** | Szál-lekérdezés: több `Conversation` egy idővonalként, lapozva, tombstone-okkal; index-bővítés. | WP-1 |
| **WP-3** | Szál-nézet UI: folytonos görgetés, téma-elválasztók, tartalomjegyzék a mai sidebar helyén, „Új téma" gomb. | WP-2 |
| **WP-4** | Témazárás + összefoglaló-generálás a határon; `boundaryReason` kitöltése; auto-plafon. | WP-1 |
| **WP-5** | Átvitel-blokk + nyitott ügyek blokk a prompt-assemblerbe, cache-határ helyes elhelyezésével; regressziós teszt a prefix-stabilitásra. | WP-4 |
| **WP-6** | `beszelgetes_kereses` tool + capability + tenant/user hatókör-teszt. | WP-2 |
| **WP-7** | Emlékezet-csík + „Mit tud pontosan?" panel; a néma `context.truncated` láthatóvá tétele. | WP-5 |
| **WP-8** | Feladat-eligazítás (§4.5): összeállítás, szerkeszthetőség, audit, ticket-hez kötés; lezáráskor visszacsatolás a szál végére. | WP-3 |
| **WP-9** | *(külön jegy)* Folyamat-lépés ticketek beolvasztása a szülő futás kártyájába — a tábla zajának megszüntetése. | — |

Javasolt sorrend a legkisebb kockázatért: **WP-0 → WP-1 → WP-2 → WP-3** (itt már
látszik az érték, kontextus-változtatás nélkül), utána **WP-4 → WP-5 → WP-7**
(a kontextus-réteg), végül **WP-6, WP-8**.

---

## 11. Kockázatok

| Kockázat | Hatás | Ellenszer |
|---|---|---|
| Az „egy folytonos szál" illúziója törik, ha az agent láthatóan elfelejt valamit, ami a képernyőn van | bizalomvesztés, a legrosszabb fajta | a téma-elválasztó **a képernyőn van** (vizuális magyarázat) + `beszelgetes_kereses` a korrekcióhoz + emlékezet-csík |
| A hosszú szál lassú betöltése | UX-romlás pont a fő nézeten | lapozott szál-lekérdezés, téma-szakaszonként; a tartalomjegyzék az „ugrás" útja |
| Az összefoglaló félrevisz (hallucinál vagy kihagy) | rossz döntés régi ügyben | az összefoglaló **megnyitható és a nyers téma elérhető**; a user javíthatja |
| A cache-határ rossz helyre kerül, és minden forduló újrafizet | költségrobbanás, csendben | WP-5 regressziós teszt: adott szálon a 2. és 3. forduló prefixe bájtra azonos |
| A retention lyukat üt a szál közepén | zavaros idővonal | tombstone + a summary együtt törlődik a témával |

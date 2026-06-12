# Kontrollált Enterprise AI Agent Platform — MVP fejlesztési terv

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 0.1 — MVP prototípus terv
**Dátum:** 2026-06-12
**Kapcsolódó anyag:** `AI-Agent-Platform-Koncepcio.md` (v0.1)
**Státusz:** M2 fázis kész — M3 következik (2026-06-12)
**Kapcsolódó anyag:** `AI-Agent-Platform-Koncepcio.md` (v0.1)

---

## Implementációs állapot (frissítve: 2026-06-12)

**GitHub:** [giretg/enterprise-ai-agent-platform](https://github.com/giretg/enterprise-ai-agent-platform)  
**Helyi futtatás:** `cd app && npm install && npm run dev` → http://localhost:5173

### Összefoglaló

| Terület | Állapot | Megjegyzés |
|---|---|---|
| Repo + git | ✅ Kész | GitHub repo, README, .gitignore |
| Projekt scaffold (React + Vite + Tailwind) | ✅ Kész | `app/` mappa |
| Mock adat réteg + DemoContext | ✅ Kész | Agentek, ticketek, audit, számla-javaslat |
| Control Plane ↔ Sandbox szétválasztás | ✅ Kész | Külön modulok, routing |
| Demó-forgatókönyv (M1, 1–5. lépés) | ✅ Kész | Számla → jóváhagyás végigkattintható |
| Prototype banner | ✅ Kész | „mock data” jelzés a felületen |
| **M1 fázis** | ✅ **Kész** | C1, C2, C3, S1, S2 |
| **M2 fázis** | ✅ **Kész** | C4, C5, C7, C8 + tanítási ciklus rollback |
| **M3 fázis** | ⬜ Hátra | C6, C9, C10, C11 |

### Képernyő-katalógus — állapot

| # | Képernyő | Prio | Állapot |
|---|---|---|---|
| C1 | Áttekintő dashboard | P1 | ✅ Kész |
| C2 | Kanban board | P1 | ✅ Kész |
| C3 | Ticket részlet | P1 | ✅ Kész |
| C4 | Agent Registry (lista) | P1 | ✅ Kész |
| C5 | Agent részlet / anatómia | P1 | ✅ Kész |
| C6 | Agent létrehozó wizard | P2 | ⬜ M3 |
| C7 | Tanítási ticket + Rollback | P1 | ✅ Kész |
| C8 | Audit log (teljes nézet) | P1 | ✅ Kész |
| C9 | Erőforrás-katalógus | P2 | ⬜ M3 |
| C10 | Model Gateway / Observability | P2 | ⬜ M3 |
| C11 | Playbook nézet | P2 | ⬜ M3 |
| C12 | IAM / hozzáférés | P3 | ⬜ M3 |
| C13 | Admin paraméterezés | P3 | ⬜ M3 |
| S1 | Könyvelő munkatér | P1 | ✅ Kész |
| S2 | Javaslat-részlet | P1 | ✅ Kész |

### Demó-forgatókönyv lépései

| # | Lépés | Állapot |
|---|---|---|
| 1 | Belépés Control Plane dashboardra | ✅ |
| 2 | Sandbox: számla feltöltés | ✅ |
| 3 | Agent szimulált feldolgozás → ticket létrehozás | ✅ |
| 4 | Board: ticket megnyitás → jóváhagyás / visszadobás | ✅ |
| 5 | Jóváhagyás után Done + audit napló frissül | ✅ |
| 6 | Tanítási ciklus + Rollback | ✅ |

---

## 0. Mit dönt el ez a dokumentum

A koncepció (673 sor, 11 fejezet) leírja a teljes víziót. Ez a terv arra ad választ: **hogyan készítsünk belőle egy kattintható, vizuálisan végigvihető prototípust** — olyat, amin az ügyfél (és mi magunk) látjuk a gombokat, dobozokat, a folyamatokat, és átérezzük, hogyan működne a gyakorlatban.

**Három eldöntött alapparaméter (ezen a terv épül):**

| Paraméter | Döntés | Következmény |
|---|---|---|
| Mélység | **Kattintható UI mockup** | Nincs valódi backend; mock adatokkal, szimulált logikával dolgozunk. Minden látszik és klikkelhető, de a "munka" előre megírt. |
| Technológia | **Önálló web-app** | Független a posnavigatortól; böngészőben bárki megnyitja (te, ügyfél, befektető). |
| Most | **Csak ez a terv** | A prototípus a következő lépés, ennek alapján. |

> **Fontos elhatárolás:** a posnavigator repóban lévő `agent-platform` modul **nem ez** — az a "Agent-First POSnavigator" (hogy külső AI-asszisztensek megtalálják a fizetési összehasonlítót). A jelen termék egy önálló, új tanácsadói termék. Névütközés, nem közös kód.

---

## 1. Az MVP célja és határai

### 1.1 Mit bizonyít a prototípus

A kattintható mockup **egyetlen dolgot ad el: a kontrollált, auditálható autonómia élményét.** Nem azt mutatja meg, hogy "az AI okos", hanem hogy nálunk minden agent-művelet látható, jóváhagyható és visszakereshető. A demó végigvihető sztorija a koncepció sikerkritériuma (9. fejezet):

> **Feltöltött dokumentumtól → AI-javaslaton → emberi jóváhagyáson át → naplózott, visszakereshető eredményig**, plusz egy **tanítási ciklus jóváhagyással és visszagörgetéssel**.

### 1.2 Scope — mi VAN benne (in scope)

- A **Control Plane** (1. app) fő képernyői klikkelhető formában.
- A **Sandbox / Execution Plane** (2. app) egyetlen, reprezentatív képernyője: a könyvelő agent munkatere.
- Egy **end-to-end demó-forgatókönyv**, amit elejétől a végéig végig lehet kattintani.
- Reális **mock adat** (pár agent, néhány ticket, audit-bejegyzések, egy szabályzat, egy connector).

### 1.3 Scope — mi NINCS benne (out of scope, szándékosan)

- Valódi LLM-hívás, valódi modell, valódi tokenelszámolás.
- Valódi adatbázis, valódi auth (Clerk/Keycloak), valódi API-kulcsok.
- Valódi integráció bármilyen külső rendszerrel (ERP, könyvelő szoftver, e-mail).
- Multi-tenancy, on-prem deployment, biztonsági keménység.
- A write-gate token, prompt injection védelem stb. **valódi** megvalósítása — ezeket **vizuálisan ábrázoljuk** (jelvény, státusz, naplósor), de nem implementáljuk.

> A scope-határ a legfontosabb fegyelmező eszköz: a mockup feladata a **megértetés és validálás**, nem a működés. Ahol "valódinak" tűnik, ott pontosan kell kommunikálni, hogy szimuláció — különben az ügyfél kész terméket vár.

---

## 2. Miért kattintható mockup a helyes első lépés

| Szempont | Kattintható mockup | Valódi vékony szelet |
|---|---|---|
| Idő az első bemutatható verzióig | Napok–2 hét | Hetek–hónapok |
| Költség | Alacsony | Magas (backend, infra, modell) |
| Mit validál | Koncepció, UX, ügyfél-reakció, sales-sztori | Technikai megvalósíthatóság |
| Kockázat | Túlígérés ("kész termék" látszat) | Elsüllyedt fejlesztés rossz irányba |
| Módosíthatóság | Olcsó, gyors iteráció | Drága átírni |

A célszegmensünk (mid-market, fintech/PSP — koncepció 2. fejezet) **döntéshozóknak mutatandó vizuális sztorit** akar látni, nem architektúrát. A mockup pont ezt adja: pár nap alatt összerakható, ügyfélbeszélgetésen, workshopon, ajánlatban használható, és olcsón iterálható, amíg a sztori nem ül. A valódi fejlesztés csak **azután** indul, hogy a mockup validálta az irányt és az ügyfél elkötelezte magát.

---

## 3. Demó-forgatókönyv (a sztori, amit végigkattintunk)

Ez a prototípus gerince. Minden képernyő ezt a 6 lépést szolgálja ki. Példa: **könyvelő agent** (koncepció 5.2, 11.1).

1. **Belépés a Control Plane-be** → áttekintő dashboard: aktív agentek, nyitott ticketek, mai költség/token, guardrail-állapot.
2. **A Sandboxban** (2. app) a felhasználó **feltölt egy beszállítói számlát** → megjelenik egy "feldolgozás alatt" kártya.
3. A **könyvelő agent "dolgozik"** (szimulált): kinyeri a mezőket, könyvelési javaslatot készít, és **automatikusan tickettet hoz létre** a Control Plane boardján egy ember számára: "Nézd át és hagyd jóvá".
4. Az **ember a boardon** megnyitja a tickettet, látja a javaslatot + a forrásdokumentumot + az agent indoklását → **Jóváhagy** (vagy visszadob). A jóváhagyás emberi kapu (human-in-the-loop).
5. Jóváhagyás után a ticket `Done` állapotba lép, és minden lépés megjelenik az **append-only audit logban** (ki, mi, mikor, melyik agent-verzió, milyen modell).
6. **Tanítási ciklus bemutatása:** egy korrekció (pl. "ennél a szállítónál mindig X főkönyvi szám") → **tanítási ticket** → jóváhagyási lánc → memória új verzió → és egy **"Rollback" gomb**, ami visszagörget. Ez a "az AI nálunk nem driftel el észrevétlenül" sztori.

> Ez a hat lépés a teljes value proposition egyetlen, 3–4 perces végigkattintható élményben.

---

## 4. Képernyő-katalógus (mit kell megrajzolni)

A prototípus képernyői a koncepció fejezeteire képeznek. Prioritás: **P1** = a demó-sztorihoz kötelező, **P2** = a teljesség élményéhez kell, **P3** = ha belefér.

### 4.1 Control Plane (1. app)

| # | Képernyő | Mit mutat | Koncepció ref | Prio |
|---|---|---|---|---|
| C1 | **Áttekintő dashboard** | Aktív agentek, nyitott ticketek, költség/token ma, guardrail-státusz | 4.1, 8.6 | P1 |
| C2 | **Kanban board** | Ticketek oszlopokban: `Backlog → In Review → Approved → In Progress → Awaiting Human → Done` | 4.2 | P1 |
| C3 | **Ticket részlet** | Egy ticket: típus, felelős (ember/agent), javaslat, forrás, állapotgomb-ok, napló | 4.2–4.3 | P1 |
| C4 | **Agent Registry (lista)** | Agentek táblázata: név, szerep, modell, állapot, verzió | 4.5 | P1 |
| C5 | **Agent részlet / anatómia** | Identitás + prompt + memória(verzió) + erőforrások + eszközök + modell-konfig | 4.9 | P1 |
| C6 | **Agent létrehozó wizard** | Lépcsős űrlap: alapadat → prompt → erőforrások → modell → jogosultság | 4.5 | P2 |
| C7 | **Tanítási ticket + jóváhagyás** | Javasolt memória-diff, jóváhagyási lánc, eval-kapu jelvény, **Rollback** | 4.6 | P1 |
| C8 | **Audit log** | Append-only, szűrhető napló; hash-lánc jelvény; SIEM-export gomb (látvány) | 4.2, 8.5 | P1 |
| C9 | **Erőforrás-katalógus** | Secret / Policy / File / Dataset / Connector / Tool — típus, scope, verzió, kötött agentek | 4.9, 4.12 | P2 |
| C10 | **Model Gateway / Observability** | Modellválasztó agentenként, token/költség grafikon, guardrail-sértések | 4.7, 8.6 | P2 |
| C11 | **Playbook nézet** | Szándékolt folyamat (rajz) vs. tényleges (audit-logból) egymás mellett | 4.10 | P2 |
| C12 | **IAM / hozzáférés** | Emberek + agent service accountok, szerepek, jogosultságok | 4.4 | P3 |
| C13 | **Admin paraméterezés** | Tickettípusok, állapotátmenetek, jóváhagyási láncok konfigurálása | 4.3 | P3 |

### 4.2 Sandbox / Execution Plane (2. app)

| # | Képernyő | Mit mutat | Koncepció ref | Prio |
|---|---|---|---|---|
| S1 | **Könyvelő munkatér** | Számla feltöltés, feldolgozás-alatt kártyák, kész javaslatok testreszabott dashboardon | 5.2 | P1 |
| S2 | **Javaslat-részlet** | Kinyert mezők, eredeti dokumentum, agent indoklás, "Küldés jóváhagyásra" | 5.2 | P1 |

**Minimális demó-készlet (csak ami a sztorihoz kell):** C1, C2, C3, C4, C5, C7, C8, S1, S2 — kilenc Control Plane + két Sandbox képernyő. A többi (C6, C9–C13) a következő iterációkban növeli a teljesség élményét.

---

## 5. Technológia és felépítés

### 5.1 Választás: önálló web-app

| Réteg | Javaslat | Indok |
|---|---|---|
| Keret | **React + Vite** (vagy egyetlen önálló HTML/React fájl a leggyorsabb demóhoz) | Gyors, komponens-alapú, böngészőben fut, nincs szerver |
| Stílus | **Tailwind CSS** | Gyors, konzisztens, a posnavigator is ezt használja → később újrahasznosítható |
| Komponensek | Egyszerű saját UI-készlet (kártya, tábla, badge, modal, oszlop) | Mockuphoz nem kell nehéz design-system |
| Adat | **Statikus mock JSON** a kódban (agentek, ticketek, audit-sorok, szabályzat) | Nincs DB; minden előre megírt, determinisztikus a demó |
| "Logika" | Front-end állapot (pl. React state) — a gombok átmozgatják a tickettet, hozzáadnak audit-sort | A működés látszata valódi backend nélkül |
| Routing | Kliens oldali, oldalanként | Egyszerű navigáció a képernyők között |

### 5.2 Architekturális elv a mockupban is

Bár nincs backend, a **kód szervezése tükrözze a koncepció szétválasztását**: külön "control plane" és "sandbox" modul, közös mock-adat réteg. Így ha később valódi MVP-vé fejlesztjük, a UI-komponensek nagyrészt újrahasznosíthatók, csak a mock-adat réteget cseréljük valódi API-ra. (Ez a koncepció 8.7 platformfüggetlenség elvének mockup-szintű előképe.)

### 5.3 Design-nyelv

Komoly, enterprise, "irányítóközpont" hangulat: visszafogott színek, sok adat, táblázatok, jelvények (státusz, verzió, hash-lánc, "audited" pecsét). A vizuális üzenet maga a **kontroll és átláthatóság**. Kerülni a "játékos AI-chatbot" esztétikát — pont az ellenkezőjét akarjuk eladni.

---

## 6. Fázisokra bontás és becslés

A prototípust három, egyenként bemutatható mérföldkőre bontom. A becslés **AI-gyorsított fejlesztést** feltételez (a UI nagy része generálható), 1 fejlesztővel.

| Fázis | Tartalom | Képernyők | Kimenet | Becslés |
|---|---|---|---|---|
| **M1 — Váz + a fő sztori** | Navigáció, design-alap, mock-adat réteg; a 6 lépéses demó-forgatókönyv végigkattintható | C1, C2, C3, S1, S2 | "Számlától a jóváhagyásig" végigvihető | 3–5 nap |
| **M2 — Agent + governance mélység** | Agent registry és anatómia, tanítási ciklus rollbackkel, audit log | C4, C5, C7, C8 | A "kontroll és audit" sztori teljes | 3–5 nap |
| **M3 — Teljesség élménye** | Erőforrás-katalógus, Model Gateway/observability, Playbook nézet, agent-wizard | C6, C9, C10, C11 | Ügyfél-prezentációra kész, gazdag demó | 4–6 nap |

**Összesen: kb. 2–3 hét** egy demó-érett, gazdag prototípusig. **Az M1 önmagában is bemutatható** — ha gyorsan kell valami ügyfélhez, ott meg lehet állni.

> Megjegyzés: az M1 akár ebben a környezetben, részben generálva is elindítható — egy első kattintható verzió jóval hamarabb a kezedben lehet, mint a fenti naptári becslés.

---

## 7. Kapcsolat a koncepció pilot-tervével (9. fejezet)

A koncepció 3 fázisú **valódi** pilotot ír le (működő Control Plane mag → valódi use case Sandboxban → enterprise-readiness demó). Ez az MVP-mockup **az előtt** áll: ez a **0. fázis**.

```
0. KATTINTHATÓ MOCKUP (ez a terv)   →  validálja a koncepciót és a sales-sztorit, olcsón
        ↓ ha az ügyfél elköteleződik
1. Control Plane mag (valódi)        →  koncepció 9. Fázis 1 (4–6 hét)
2. Egy valódi use case a Sandboxban  →  koncepció 9. Fázis 2 (4–6 hét)
3. Enterprise-readiness demó         →  koncepció 9. Fázis 3 (3–4 hét)
```

A mockup UI-komponensei és képernyő-struktúrája **átvihetők** az 1. fázisba — a mockup nem eldobható, hanem a valódi termék UI-vázának első verziója.

---

## 8. Kockázatok és mire figyeljünk a prototípusnál

- **Túlígérés / "kész termék" látszat.** A mockup meggyőzően néz ki — pont ez a veszély. Minden bemutatón explicit mondjuk ki, mi szimuláció. Érdemes egy diszkrét "Prototype / mock data" jelzést a felületre tenni.
- **A demó-adat hitelessége.** A mock számla, agent, szabályzat legyen iparág-releváns (pl. az Ostoros-Novaj agrár use case vagy egy fintech reconciliation), különben nem üt.
- **Scope-csúszás.** Könnyű "még egy képernyőt" akarni. A P1-készlet a szent mag; a többi csak utána.
- **A governance-sztori vizuális kihangsúlyozása.** A jelvények (audited, verziózott, hash-lánc, human-in-the-loop kapu, rollback) hordozzák az üzenetet — ezekre menjen a vizuális hangsúly, mert ez a differenciátor, nem az agent "okossága".
- **Ne égjenek be rossz UX-döntések.** Mivel a mockup később a valódi UI alapja lehet, a navigáció és az információs architektúra legyen átgondolt, ne csak "elég jó a képhez".

---

## 9. Következő lépés és nyitott kérdések

**Azonnali következő lépés:** az **M3 fázis** — erőforrás-katalógus (C9), Model Gateway/observability (C10), Playbook nézet (C11), agent-wizard (C6).

**Pár döntés, ami a prototípust élesíti (nem blokkoló, menet közben is tisztázható):**

- **Melyik use case legyen a fő demó-sztori?** Könyvelő/számlafeldolgozás (leggyorsabban demózható, általános), vagy egy fizetés-specifikus (reconciliation/chargeback, a sales-fókuszhoz közelebb), vagy az agrár határidő-asszisztens (Ostoros-Novaj referencia)?
- **Egy nyelv vagy kétnyelvű** (HU/EN) a felület? Mockupnál elég egy, de ha nemzetközi befektető/ügyfél is célközönség, érdemes EN-t is.
- **Brand:** Excellence Pay arculat (logó, szín) rákerüljön-e már a mockupra, vagy semleges "platform" megjelenés?

---

*Ez a terv a kattintható prototípusra fókuszál. A valódi, működő rendszer architektúrája és pilot-terve a `AI-Agent-Platform-Koncepcio.md` 4., 9. és 10. fejezeteiben van.*

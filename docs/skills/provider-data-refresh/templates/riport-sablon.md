# {Szolgáltató} — adatfrissítési elemzés ({YYYY-MM-DD})

- bank_id:
- export revision (base):
- playbook version / ETag:
- proposal_id: (vagy „nincs — unchanged”; „függőben” ha a jóváhagyásra vár)
- tervezett run outcome: (unchanged | proposal_created | needs_human | failed | blocked)

## Tartalomjegyzék
1. Executive Summary
2. Első rész — POS Navigator Adatok vs. Aktuális Online Információk
3. Második rész — Ajánlott Marketing Aktivitások és Repost Lehetőségek
4. Harmadik rész — POS Navigator Tartalomstratégiai Javaslatok
5. Szűrési teszt eredmények
6. Következtetések + API utómunka státusz

## Executive Summary
(3–6 mondat: mit néztél, mi változott, mi a legsürgősebb, mit nem tudtál igazolni, időérzékeny tételek)

---
## ELSŐ RÉSZ — POS Navigator Adatok vs. Aktuális Online Információk
### 3.1 Termékek és szolgáltatások
### 3.2 Árazási információk
#### 3.2.1 Változástáblázat (kötelező)
| Mező / Tétel | Irány (↑↓↔—) | Jelenlegi érték (POSnavigator) | Javasolt új érték | Forrás | Indoklás |
|---|---|---|---|---|---|
#### 3.2.2 További díjak (nem a költségszámítás része)
#### 3.2.3 Díjváltozás-napló (hivatkozás: dij-valtozasok-YYYY-Qn.md, ha volt ↑↓↔)
### 3.3 Szerződéses feltételek
### 3.4 Speciális funkciók
### 3.5 Összefoglaló javaslatok — Mit kell frissíteni a POS Navigatoron?
KRITIKUS:
- [ ]
FONTOS:
- [ ]
OPCIONÁLIS:
- [ ]
### 3.5.1 Strukturális javaslatok az adatmodellhez
### Éles felületi hatás
(Aréna / iparági és versus landing / partner widget / Saját Ajánlatok / POS eszközvásárlás — érinti-e?)

---
## MÁSODIK RÉSZ — Ajánlott Marketing Aktivitások és Repost Lehetőségek
### 3.6 Releváns marketing események
### 3.7 Social media tartalom
### 3.8 POS Navigator megjelenítési javaslatok
JAVASLAT #1 — Platform / Időpont / Tartalom / Miért releváns / Célközönség / Javasolt bevezetés

---
## HARMADIK RÉSZ — POS Navigator Tartalomstratégiai Javaslatok
### 3.9 Social media poszt
### 3.10 Blog cikk ötlet
### 3.11 Egyéb tartalom

---
## Szűrési teszt eredmények (Filters & Offers API — élő adat)
| Szcenárió | Megjelenik? | Kalkulált havi díj | Weboldalon talált díj | Egyezik? | Megjegyzés |
|---|---|---|---|---|---|

## Következtetések + API utómunka státusz
- proposal_id:
- run_id / outcome:
- playbook PATCH / Lesson: (igen/nem — mi; ha PATCH nem volt hívható, a Lesson `playbook_patch`-e)
- lesson_id: (ha van)
- gateway műveletek: (proposal / run / lesson — jóváhagyva / függőben / elutasítva)
- riport: (work file útvonal; Drive link, ha feltöltve)
- wiki lap / log: (Drive hivatkozások)
- Csilla értesítve: (mikor, hogyan: handoff / AgentMail)
- nyitott kérdések emberi döntésre:

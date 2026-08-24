# AI Agent Platform — Feature Spec: Futás-elemző agent

> Spec-issue: [#343](https://github.com/giretg/enterprise-ai-agent-platform/issues/343) ·
> jegybontás: [`run-analyst-tickets.md`](./run-analyst-tickets.md) ·
> kapcsolódó: Hatékonysági tanácsadó [#304](https://github.com/giretg/enterprise-ai-agent-platform/issues/304).
>
> **Állapot:** **v1 implementálva és a mért eseten ellenőrizve (2026-08-22, RA-09 / #353).** A tenant-szintű elemző agent, a három `run_*` tool, a Futás-elemzés skill, az „Elemezd" belépési pontok és a záró-kapuk a mainen vannak. A #343 lezárása az RA-09 kereszthivatkozásával.

## Implementációs állapot (2026-08-22)

**Összefoglaló:** a v1 Futás-elemző szállítva. Az RA-09 ellenőrzés a 2026-07-29-i incidens **alakján** (fixture) és egy hibás átadású folyamat-fixture-en lefutott; a részletes számok és záró-kapuk a jegybontásban vannak.

| Szelet | Hol | Állapot |
| --- | --- | --- |
| RA-00…RA-02 — grant-kapu, materializáció, szerep-sablon | #344…#346 | ✅ a mainen |
| RA-03…RA-06 — `run_index`, `run_trace`, `run_stats` | #347…#350 | ✅ a mainen |
| RA-07…RA-08 — skill task-módban, Elemezd gombok | #351…#352 | ✅ a mainen |
| RA-09 — ellenőrzés a mért eseten + dokumentáció | #353 | ✅ lásd a jegybontás ellenőrzés-szakaszát |

## Problem Statement (rövid)

A platform naplói teljesek (`ModelCall`, `ToolCall`, `AgentTurn`, folyamat lépések és átadások), de ma senki nem tud válaszolni arra, hogy **„mi történt ebben a futásban, és mit kellene másképp csinálni?"** — különösen, ha a hiba nem illeszkedik a #304 hatékonysági kártya négy beégetett mintájához (pl. hibás playbook-átadás két agent között).

## Solution (rövid)

Tenant-szintű **beszélgethető elemző agent** (`systemRole: run_analyst`), admin-only hozzáféréssel, három kizárólagos futásolvasó tool-lal (`run_index` → `run_stats` → célzott `run_trace`), a tenant aktív API-jainak read-only diagnosztikai elérésével (`http_api_get`, `http_api_get_all`) és egy író/delegáló jogosultsággal (`ticket_create`). Az API-k kötés nélküli, tenant-szintű olvasása csak ennek a rendszer-szerepnek jár; HTTP-írás és más egress nem. **Javasol, nem alkalmaz** — a javaslatok a meglévő jóváhagyási utakra mennek:

| Javaslat | Út |
| --- | --- |
| Playbook / slot / átadás | Playbook Author draft-lánc |
| Skill | propose → review → approve |
| Memória / tanulás | Tanulási ticket |
| Hangolható kapcsoló | #304 EFF-12 „Alkalmazom" gomb |

## Testing Decisions — mért eset (kétirányú)

1. **2026-07-29-i incidens alakja** (149 eszközhívás, 132 újraolvasás, 40 kör): a `run_stats` megmutatja az ismétlődő forrás-kulcsokat, a `run_index` fejléce a kör- és eszközhívás-számot, a `run_trace` summary alátámasztja — az elemzőnek minden jel a kezében van.
2. **Hibás átadású folyamat:** a `run_trace` folyamat-nézete lépés- és slot-szinten megnevezi a hiányt (`slotGaps`).

Automatizált ellenőrzés: `npm run test:run-analyst-verification`.

## Kapcsolat a #304 Hatékonysági tanácsadóval

A #304 **determinista, négy mintát ismerő kártya** az agent adatlapon — gyors, olvasás-oldali összefoglaló és „Alkalmazom" gomb ahol van kapcsoló. A Futás-elemző **beszélgethető, nem előre ismert mintákat is megnevező** elemző; a két feature kiegészíti egymást. A hangolható kapcsolók javaslata mindkét úton a #304 EFF-12 „Alkalmazom" gombjára mutat.

Teljes spec szöveg: GitHub issue [#343](https://github.com/giretg/enterprise-ai-agent-platform/issues/343).

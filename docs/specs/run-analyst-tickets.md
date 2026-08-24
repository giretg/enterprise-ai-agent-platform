# Futás-elemző agent — jegybontás

Forrás: **spec-issue [#343](https://github.com/giretg/enterprise-ai-agent-platform/issues/343)** ·
kapcsolódó: **Hatékonysági tanácsadó [#304](https://github.com/giretg/enterprise-ai-agent-platform/issues/304)** ·
spec: [`AI-Agent-Platform-Feature-Spec-Run-Analyst.md`](./AI-Agent-Platform-Feature-Spec-Run-Analyst.md)

**Sorszám-előtag:** `[Run Analyst] RA-NN — …` · **mérföldkő:** `Run Analyst`

---

## RA-00 — Default user→agent grant: rendszer-szerepű agentek kizárása

**Mérföldkő:** M0 · **Prioritás:** Magas · **Függés:** — · **Állapot:** a mainen

**DoD:** `receivesDefaultUserAgentGrants({ systemRole: 'run_analyst' }) === false`; teszt: `npm run test:default-user-agent-grants`.

---

## RA-01 — `AgentSystemRole.run_analyst`: séma, migráció, materializáció

**Mérföldkő:** M1 · **Prioritás:** Magas · **Függés:** RA-00 · **Állapot:** a mainen

**DoD:** tenantonként pontosan egy `run_analyst` példány; teszt: `npm run test:run-analyst-materialization-db`.

---

## RA-02 — Szerep-sablon, capability-halmaz, `analysis.run`, privacy-alapérték

**Mérföldkő:** M1 · **Prioritás:** Magas · **Függés:** RA-01 · **Állapot:** a mainen

**DoD:** `run_index`, `run_trace`, `run_stats`, `ticket_create`, valamint a hibakereséshez szükséges tenant-szintű `http_api_get` / `http_api_get_all` capability. A tenant API-k kötés nélküli olvasása kizárólag a `run_analyst` rendszer-szerepé; HTTP-írás és minden más egress tiltott. Teszt: `npm run test:run-analyst-role`.

---

## RA-03 — `run_index`: szkóp-feloldás és futás-fejlécek

**Mérföldkő:** M2 · **Prioritás:** Magas · **Függés:** RA-01 · **Állapot:** a mainen

**DoD:** tenant-szűrés, önelemzés-kizárás, audit `analysis.run_index`; teszt: `npm run test:run-index`.

---

## RA-04 — `run_trace`: lapozott idővonal (chat / ticket ág)

**Mérföldkő:** M3 · **Prioritás:** Magas · **Függés:** RA-03 · **Állapot:** a mainen

**DoD:** summary alapból, detail lapozva; audit `analysis.run_trace`; teszt: `npm run test:run-trace`.

---

## RA-05 — `run_trace` folyamat-nézet: lépés be-/kimenet és átadási élek

**Mérföldkő:** M3 · **Prioritás:** Magas · **Függés:** RA-03 · **Állapot:** a mainen

**DoD:** `slotGaps` lépés- és slot-szinten; teszt: `npm run test:run-trace` (RA-05 DoD blokk).

---

## RA-06 — `run_stats`: eszköz × kimenetel mátrix és futás-aggregátumok

**Mérföldkő:** M4 · **Prioritás:** Magas · **Függés:** RA-03 · **Állapot:** a mainen

**DoD:** `repeatedSourceKeys`, `toolOutcomeMatrix`, audit `analysis.run_stats`; teszt: `npm run test:run-stats`.

---

## RA-07 — „Futás-elemzés" skill task-módban

**Mérföldkő:** M4 · **Prioritás:** Közepes · **Függés:** RA-02 · **Állapot:** a mainen

**DoD:** `preferredMode: 'task'`, loop-guard ≥150 hívás; teszt: `npm run test:run-analyst-skill`.

---

## RA-08 — Belépési pontok: `prefill` paraméter és „Elemezd" gombok

**Mérföldkő:** M4 · **Prioritás:** Közepes · **Függés:** RA-01, RA-07 · **Állapot:** a mainen

**DoD:** beszélgetés / ticket / folyamat felületen „Elemezd" gomb; `analysis.run` kapu; teszt: `npm run test:run-analysis-entry`.

---

# M5 — lezárás

## RA-09 — Ellenőrzés a mért eseten és hibás átadású folyamaton + dokumentáció

**Mérföldkő:** M5 · **Prioritás:** Magas · **Függés:** RA-05, RA-06, RA-08
**Állapot:** ellenőrizve 2026-08-22-én (`npm run test:run-analyst-verification` zöld).

**Feladat:**
- Ellenőrzés 1 — a 2026-07-29-i visszaolvasás-incidens alakján (149 hívás / 132 újraolvasás / 40 kör).
- Ellenőrzés 2 — hibás átadású folyamat-futás (step2 nem tölti step3 kötelező slotját).
- Záró-kapuk: tenant-izoláció, admin-only belépés, kizárólagos read-only diagnosztikai HTTP-hozzáférés, más egress tiltása, audit.
- Spec és `DOCS.md` frissítése; kereszthivatkozás a #304-re.

**DoD:** mindkét ellenőrzés eredménye dokumentálva; záró-kapuk zöldek; a spec jelzi, hogy v1 implementálva és mért eseten ellenőrizve.

### Ellenőrzés (2026-08-22)

Teszt: `npm run test:run-analyst-verification` · fixture: `scripts/run-analyst-verification.test.ts`

A modell szövegét nem teszteljük — a megfigyelt egység a **tool-kimenet** és a **kapuk**.

#### 1. Mért incidens alak (2026-07-29)

**Mit kérdeznénk az elemzőtől:** „Elemezd ezt a beszélgetést — miért nem készült el, mi pazarolta a tokent?"

**Mit adnak a toolok (helyes-e):**

| Tool | Mit mutat | Helyes? |
| --- | --- | --- |
| `run_index` | `turnCount: 40`, `toolCallCount: 149`, magas denial/stop jelek a fejlécben | ✅ |
| `run_stats` | `repeatedSourceKeys`: 132 ismétlés ugyanabból a forrásból (`tool_result_read` / archívum-path); összesen 149 hívás a trace-ben | ✅ |
| `run_trace` (summary) | `toolCallCount: 149`, `turnCount: 40`, `tool_result_read` dominancia; token-görbe 21k→154k+ | ✅ |

Az elemző ezekből meg tudja nevezni az ismétlődő visszaolvasást és a kör-számot, majd célzott `run_trace` detail-lefúrással alátámaszthat — ugyanaz a mérce, mint a #304 EFF-13-nál, de **beszélgethető agenttel** és tetszőleges mintával.

#### 2. Hibás átadású folyamat

**Mit kérdeznénk:** „Miért állt meg a folyamat a harmadik lépésnél?"

**Mit ad a `run_trace` process-nézet (helyes-e):**

| Mező | Érték | Helyes? |
| --- | --- | --- |
| `slotGaps[step-3].missingRequiredSlots` | `['summary']` | ✅ |
| step-2 `resultPayload` | nincs `summary` kulcs | ✅ |
| delegation edge step-2→step-3 | `agent-b` → `agent-c`, `metadata.missingSlots` | ✅ |

**Javaslat-szöveg minta (Playbook Author útra):** a step-2 kimeneti mappingjében szerepeljen a `summary` mező — lásd `formatPlaybookSlotGapRecommendation` a tesztben.

#### 3. Javaslat-továbbadás útjai

| Javaslat típusa | Út | Hol van leírva |
| --- | --- | --- |
| Playbook / slot / átadás | Playbook Author: draft → validál → ember jóváhagy → publish | `docs/skills/futas-elemzes.SKILL.md`, szerep-instrukció |
| Skill | propose → review → approve | ugyanott |
| Memória / tanulás | Tanulási ticket | ugyanott |
| Loop-guard / ingest kapcsolók | Hatékonysági tanácsadó **Alkalmazom** gomb ([#304](https://github.com/giretg/enterprise-ai-agent-platform/issues/304) EFF-12) | ugyanott |

#### 4. Záró-kapuk

| Kapu | Eredmény |
| --- | --- |
| Idegen tenant `conversationId` / `ticketId` / `processInstanceId` | mindhárom tool: `run_not_found` |
| Operator / viewer | `analysis.run` tiltva; „Elemezd" gomb nem renderelődik |
| `run_analyst` agent | `hiddenFromOperators`, `inboundRestricted`; nincs default grant |
| Kimenő egress | csak `http_api_get` / `http_api_get_all`, kizárólag tenanton belüli hibakereséshez; `http_api_request`, `web_search`, `gmail_*`, `repo_open_pull_request` tiltott |
| Speciális toolok kizárólagossága | `run_index`, `run_stats`, `run_trace` csak `systemRole: run_analyst` mellett engedélyezhető és jeleníthető meg |
| Audit | minden `run_*` hívás: `analysis.run_index` / `analysis.run_stats` / `analysis.run_trace` |

---

## Létrehozott jegyek

| Jegy | Issue | Mérföldkő | Állapot |
| --- | --- | --- | --- |
| RA-00 — Default grant deny-by-default | #344 | M0 | a mainen |
| RA-01 — run_analyst materializáció | #345 | M1 | a mainen |
| RA-02 — Szerep-sablon + analysis.run | #346 | M1 | a mainen |
| RA-03 — run_index | #347 | M2 | a mainen |
| RA-04 — run_trace chat/ticket | #348 | M3 | a mainen |
| RA-05 — run_trace folyamat-nézet | #349 | M3 | a mainen |
| RA-06 — run_stats | #350 | M4 | a mainen |
| RA-07 — Futás-elemzés skill | #351 | M4 | a mainen |
| RA-08 — Elemezd gombok + prefill | #352 | M4 | a mainen |
| RA-09 — Ellenőrzés + dokumentáció | #353 | M5 | ellenőrizve 2026-08-22 |

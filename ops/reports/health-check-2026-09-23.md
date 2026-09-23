# Napi health-check — 2026-09-23

Időablak: 2026-09-22 04:42 UTC – 2026-09-23 04:42 UTC (24h), viszonyítási alap: megelőző 7 nap.
Projekt: `enterprise-ai-demo`, szolgáltatás: `enterprise-ai-agent-platform` (Cloud Run / App Hosting).

## 0. Előzmények
- 09-22: D ág, #549 (`agent_turns` séma-eltérés) tárgytalanná vált, PR azóta **CLOSED** (09-22 08:16).
- Nyitott, nem újrajavasolt tételek: #515 (ticket-poll), #449, #426 (Clerk dev-instance).
- A 09-18-i döntési jegyzet a *konkrét* migráció kézi lefuttatását kérte, a **strukturális okot**
  (a deploy nem migrál) senki nem kezelte → ma ismét előjött. **REGRESSZIÓ / visszatérő osztály.**

## 1. Adatgyűjtés (CLI-only)

| Forrás | Eredmény | Parancs |
|---|---|---|
| Cloud Run `severity>=ERROR` 24h | **24** (mind `POST /api/mcp/*` → 500) | `gcloud logging read 'resource.type="cloud_run_revision" severity>=ERROR timestamp>="2026-09-22T04:42:50Z"'` |
| ugyanez, előző 7 nap napi bontás | 09-17: 51, 09-18: 209, 09-19: 26, többi 0 (286 / 7 nap ≈ 41/nap) | ugyanez `timestamp` ablakkal, `cut -c1-10 \| uniq -c` |
| HTTP státuszok 24h (2 807 kérés) | 2304×200, 97×202, 6×304, 190×307, 178×401, 8×404, **24×500** | `… httpRequest:* --format="value(httpRequest.status)" \| sort \| uniq -c` |
| Prisma „PostgreSQL connection Closed" | 185/24h vs. 856/7 nap (122/nap, +51%) — egyikhez sem tartozik 5xx | `textPayload:"Error in PostgreSQL connection"` |
| Revíziók | 020 (18:54 UTC) él; 018 14:42, 019 15:33 | `gcloud run revisions list` |

Nem vizsgált terület: Firestore / Cloud Functions (nincs ilyen komponens), Neon slow query log
(nincs éles DB-hozzáférés erről a hosztról, és nem is szabad), billing export (a health-check SA nem
lát billing accountot), Cloud Run instance-óra/cold-start metrika (nem kérdeztem le), Clerk
(0 Clerk-mintázatú log-sor).

## 2. Aggregálás — a 24 db 500

| Hibaminta | Revízió | Ablak (UTC) | 500 | Prisma hibasor | Érintett tenant |
|---|---|---|---|---|---|
| `skills.produces_skills` does not exist (`0008_conversation_skill`) | 018 | 14:58–15:03 | 15 | 21 | 2 |
| `agents.memory_write_mode` does not exist (`0010_project_work`) | 020 | 19:24–20:52 | 9 | 42 | 2 |
| `operator does not exist: uuid = text` (KB raw query) | 006–014 | 09:04–14:10 | 0 (nem 5xx) | 10 | — |

- A `uuid = text` hibát a PR #613 (`1233f7f5`, 16:15 UTC) javította, 14:10 óta 0 → lezárt.
- A két séma-eltérés magától (kézi `migrate deploy`-jal) megszűnt: 20:52 után 7 sikeres
  `enterprise.tool.ok` (agent/definíció-feloldással), 0×500.
- A build-020 18:54-kor, a #621 merge-e (20:50) **előtt** ment ki — nem-main kódról futó rollout.

## 3. Top 5

| # | Találat | Hatás | Gyak. | Kock. | Pont |
|---|---|---|---|---|---|
| 1 | Élesítés migráció nélkül → 24×500 MCP (4. előfordulás) | 3 | 4 | 2 | **6** |
| 2 | Prisma idle-kapcsolat bezárás +51% (nincs 5xx) | 1 | 3 | 2 | 1,5 |
| 3 | 178×401 `/api/mcp/*` (ismert, 09-21 vizsgálva) | 1 | 3 | 2 | 1,5 |
| 4 | KB `uuid = text` (már javítva, #613) | 2 | 1 | 1 | 2 → lezárt |
| 5 | — | | | | |

## 4. Döntés — B ág

Draft PR: **#625** — `PRISMA_MIGRATE_ON_BUILD=1` esetén az `app` build a `next build` előtt
`prisma migrate deploy`-t futtat; hibás migráció → bukó build, régi revízió marad.
Visszaállítás: a kapcsoló `"0"`. Fő negatívum: a branch-ről indított rollout is migrál élesben;
romboló migrációhoz expand/contract kell. Részletek a PR-ben.

## 5. Hogyan mérjük 7 nap múlva

```
gcloud logging read 'resource.type="cloud_run_revision" timestamp>="2026-09-24T00:00:00Z" textPayload:"does not exist in the current database"' --project=enterprise-ai-demo --format="value(timestamp)" | wc -l
```
Elvárt: 0 (ha #625 mergelve). Ha nem mergelve és >0: az osztály ötödször jött elő.

# Napi health-check — 2026-09-22

Időablak: 2026-09-21 06:19 UTC – 2026-09-22 06:19 UTC (24h), viszonyítási alap: megelőző 7 nap.

## 0. Előzmények áttekintése

`ops/health-check-log.md` + a kapcsolódó memória-jegyzet szerint a legutóbbi nyitott tétel a
2026-09-18-i **éles DB séma-eltérés** (`agent_turns.launch_id`/`launch_attempt_count`/
`launch_reserved_at` oszlopok mergelve, de éles Neon DB-n nem alkalmazva → `P2022`, 55×500/24h a
`rail-state`/`active-runs`/`agent-chat/turns` végpontokon), döntési jegyzet **PR #549 (OPEN)**.
09-21-i futás regresszió-ellenőrzése: 2 napja 0 új 500, de a végpontokra 0 a forgalom is → a
javítás akkor nem volt bizonyítható.

**Mai eredmény: #549 tárgytalanná vált — nem regresszió, hanem a mögötte lévő alrendszer
megszűnt.** Lásd 2. pont.

## 1. Adatgyűjtés (CLI-only)

- **Cloud Run logok** (`gcloud logging read`, projekt: `enterprise-ai-demo`):
  - `severity>=ERROR`, utolsó 24h: **0 db** (megelőző 7 nap: 286 db, ~41/nap átlag — de ez a
    szám torz, ld. 2. pont: a 09-16–09-20 közötti burst a Phase A-F átállás alatti átmeneti
    séma-eltérésekből jött, nem folyamatos alapzaj).
  - `httpRequest.status>=500`, utolsó 24h: **0 db**.
  - Összes kérés utolsó 24h: **1027**, státusz-eloszlás: 790×200, 82×202, 58×307, 93×401 (mind
    `/api/mcp/ostorosbor` — ismert, 09-21-én már vizsgált, lokális takarító-szkript hiányára
    vezethető vissza, nem új), 3×304, 1×404.
  - Latencia (1027 minta): p50 103 ms, p95 2,26 s, p99 5,47 s. A 6 db 300 s-os kérés mind
    `/api/mcp/posnavigator` 200-as válasszal — hosszú-életű MCP streaming kapcsolat
    újracsatlakozása, nem hiba.
- **Firestore / Cloud Functions**: nincs `firebase functions:log` célpont — a szolgáltatás
  Cloud Run / Firebase App Hosting, nem Cloud Functions. Nem vizsgált terület (nincs
  Firestore-collection ebben a projektben, Postgres/Neon az adattár).
- **Neon DB slow query log**: nem vizsgált terület — nincs erről a hosztról elérhető
  credential/kapcsolat (élesbe írni/olvasni ad-hoc módon a szabályok szerint sem szabadna).
- **Billing export**: nem vizsgált terület — a health-check service account
  (`eai-healthcheck-runner@`) nem lát billing accountot (`gcloud billing accounts list` → 0 tétel).
- **Clerk / auth hibaráta**: 0 Clerk-mintázatú log-sor az utolsó 24h-ban. `#426` (prod Clerk =
  dev instance) állapota változatlan, ma nincs új jel.

## 2. Fő megfigyelés — architektúra-váltás történt, és egy nyitott tétel emiatt tárgytalanná vált

A `git log` szerint 2026-09-18 13:21 UTC-től (`e99c2282`, PR #550, "Phase B: target Prisma
schema + immutable Agent Definition") 2026-09-20 06:58-ig egy tervezett, több PR-ből álló
architektúra-átállás futott (#539–#557 közötti issue/PR sáv, "Phase A–F"): a Prisma
migrációs history **teljesen lecserélődött** (`app/prisma/migrations` most `0001_init`-től
`0007_agent_description`-ig megy, a korábbi `0050_agent_turn_launch`/`0051_agent_turn_capacity`
migrációk és az `AgentTurn` modell **már nincsenek a kódbázisban**), a `rail-state`,
`active-runs`, `agent-chat/turns` route-ok **törölve lettek**, helyükre egy MCP-alapú vezérlősík
került (connector manager wizard, knowledge-base MCP, Drive read/write MCP — ez látszik is az
ehhez a sessionhöz kötött `mcp__…__platform_*`/`kb_*`/`google_drive_*` eszközökön).

Ez alatt az átállás alatt (09-16–09-20) a **pontosan ugyanabba a hibaosztályba** tartozó,
átmeneti séma-eltérési hibák jelentkeztek MÁS táblákon/oszlopokon, mint a #549-ben rögzített:

- `The column \`connectors.connector_mode\` does not exist in the current database.` — 14×,
  2026-09-19 07:02–07:12 UTC.
- `invalid input value for enum "ConnectorType": "knowledge_base"` — 8×, 2026-09-20 04:19–04:39 UTC.
- (a `ConnectorType` enum egyéb előfordulásai: 4× 09-16, 15× 09-18.)

Ezek is a "mergelt kód, éles DB-n alkalmazatlan migráció" mintát követik — de a Phase A-F
rollout velejárói, nem egy önálló új találat. **Utolsó előfordulás 2026-09-20 04:39 UTC, azóta
(46+ óra, ebből a mai 24h ablak is) nulla.** Fontos különbség a #549-es tételhez képest: MA
**volt is forgalom** az érintett kódúton — `GET /api/connectors/oauth/callback` 2× sikeres
(307) 09-21 13:57 és 14:14 UTC-kor, DB-írással járó connector-OAuth-flow —, tehát ez nem a
"nincs forgalom, ezért nincs hiba" csapda, hanem ténylegesen igazolt működés.

**Következtetés:** a #549-ben rögzített `agent_turns` séma-eltérés tárgya (a `rail-state`/
`active-runs`/`agent-chat/turns` végpontok és az `AgentTurn` tábla) a Phase A-F átállással
**megszűnt létezni** — nincs mit migrálni élesben, mert a kód, ami használta, törölve lett.
A `connectors` táblát érintő, hasonló osztályú átmeneti hiba magától megoldódott (feltehetően
a Phase A-F PR-ek egyikének deploy-menetében lefutott a szükséges `prisma migrate deploy`) és
ma forgalommal is igazolt.

**Javaslat (nem PR, csak jegyzet):** PR #549-et lezárni "tárgytalan — a mögötte lévő alrendszer
törölve lett" megjegyzéssel; a jövőbeli futásoknak nem kell tovább követnie. Erről kommentet
hagytam a PR-en, zárást az emberi döntéshozóra bízva (a rutin szabálya szerint PR-t/döntést nem
zárok le magamtól).

## 3. Rangsorolás

| # | Találat | Üzleti hatás | Gyakoriság | Kockázat | Pontszám |
|---|---------|-------------|-----------|----------|----------|
| 1 | #549 tárgytalanná vált (architektúra-váltás) | 2 (adminisztratív tisztázás, nem éles hiba) | 1 (egyszeri) | 1 (megjegyzés) | 2 |
| — | Minden más log-forrás tiszta | — | — | — | — |

Nincs olyan tétel, ami elérné a B/C ág küszöbét (nincs 24h-ban mérhető, jelenleg is fennálló
hibás viselkedés). A #1 tétel is adminisztratív (elavult nyomkövetés lezárása), nem
alkalmazáskód-hiba.

## 4. Döntés

**D ág — nincs érdemi ÚJ, javítandó találat.** Amit ellenőriztem: Cloud Run error/5xx logok
(0/0), kérésszám és státusz-eloszlás, latencia-sáv, Clerk-minták, a #549 regresszió-ellenőrzés
(most már architekturálisan lezárható), a Phase A-F átállás alatti átmeneti séma-hibák
(magától megoldódtak, forgalommal igazolva). Amit NEM vizsgáltam: Firestore (nincs ilyen
adattár), Neon slow query log, billing export, Cloud Run instance-óra/cold-start (nem volt
hozzáférhető metrika-forrás ehhez ma).

Nem nyitok PR-t kód-változtatáshoz — nincs mit javítani.

## 5. Hogyan mérjük 7 nap múlva

```
gcloud logging read 'resource.type="cloud_run_revision" severity>=ERROR timestamp>="<7 nappal későbbi dátum>T00:00:00Z"' --project=enterprise-ai-demo --format="value(timestamp)" | wc -l
```
Elvárt: 0, vagy ha nem, akkor konkrét, ÚJ hibaosztály (nem `connector_mode`/`ConnectorType`/
`agent_turns` — azok lezártnak tekinthetők).

Ha PR #549 még mindig OPEN 7 nap múlva: emberi döntés hiányzik, emlékeztetni kell rá.

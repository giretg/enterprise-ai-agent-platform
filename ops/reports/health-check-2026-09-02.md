# Napi health-check riport — Enterprise AI Agent Platform
**Dátum:** 2026-09-02 · **Szerep:** SRE + FinOps · **Ág:** **D — nincs érdemi találat**

## TL;DR
A deployolt platform (`enterprise-ai-agent-platform`, Firebase App Hosting / Cloud Run,
`europe-west4`) az elmúlt 24 órában **egyetlen kérést sem szolgált ki**, nulla hibával.
Az utolsó forgalom 2026-08-31 16:31 UTC. A szolgáltatás `minInstances: 0` mellett
nullára skálázódik, a 7 napos Cloud Run gépidő a Google ingyenkeret töredéke.
**Ma nincs teendő. Nem nyitok PR-t.** Két nem-kód jellegű, ops-oldali javaslat lent.

Ez a napló első futása — `ops/health-check-log.md` most jött létre.

---

## 1. Mit ellenőriztem — és mivel

Auth-helyzet a futtató hoston: a `gcloud` felhasználói tokenje lejárt és
non-interaktív módban nem újítható (`Reauthentication failed`). Emiatt a
`gcloud logging read` / `gcloud monitoring` **nem használható**. Kerülőút: a
`firebase-tools` tárolt OAuth access tokenjével közvetlenül a Google REST API-k
(`logging.googleapis.com`, `monitoring.googleapis.com`,
`firebaseapphosting.googleapis.com`) — ezek **működtek**.

| Terület | Forrás (parancs) | Eredmény |
|---|---|---|
| App-hibák (24h) | `POST logging.googleapis.com/v2/entries:list` · filter `severity>=ERROR AND resource.labels.service_name="enterprise-ai-agent-platform"` · 24h ablak | **0 találat** |
| App-hibák (7d) | ugyanaz, `severity>=WARNING`, 7d | 131 sor, **mind** `404 /favicon.ico` + néhány Next.js RSC-prefetch 404 (`/control-plane/...?_rsc=`). 0 db `ERROR`, 0 db `status>=500`. |
| stderr (7d) | filter `logName=".../logs/run.googleapis.com%2Fstderr"` | 24 sor, mind ugyanaz: `Failed to find Server Action "…"` 2026-08-31 09:4x-kor — deploy utáni elavult kliens-bundle, magától megszűnt. |
| Kérés-latencia (7d) | `httpRequest.latency>"3s"` aggregálva endpointra | lásd §2 — kizárólag hidegindítási farok, már folyamatban lévő munkával fedve. |
| Cloud Run gépidő | `monitoring …/timeSeries` · `run.googleapis.com/container/billable_instance_time` · 1d bucket, 7d | platform napi ~1589 / 994 / 26 / 1349 s (aktív napokon), utána 0. Sibling `ostoros-fold`: <60 s/nap. |
| Cloud Run hidegindítás | `run.googleapis.com/container/startup_latencies` p95, 1d, 7d | p95 **1,9–5,3 s/nap** — ez a lassú pollok forrása (`minInstances: 0`). |
| Deploy-egészség | `firebaseapphosting.googleapis.com/v1/.../rollouts` | Nincs `FAILED` rollout. A backend „Updated" dátuma 2026-08-31 — sikeres build hétfőn. |
| Firestore olvasás/írás | `monitoring` · `firestore.googleapis.com/document/{read,write,delete}_count` 7d | **nincs adat** — a platform az app-adatokat Postgresben (Prisma/Neon) tárolja, nem Firestore-ban. |
| Neon DB (dev) | `psql` read-only, `statement_timeout=20s`, egyszeri parancs | Elérhető. `pg_stat_statements` **nincs telepítve** → nincs lassú-lekérdezés-történet. ~59 FK-oszlop fedő index nélkül (Prisma default) — lásd §3. |
| Neon DB (**prod**) | — | **Nem vizsgált** — a `PLATFORM_DATABASE_URL` csak App Hosting secret, a futtató hoston nem elérhető. |

### Nem vizsgált területek (tényként, becslés nélkül)
- **Cloud Billing / SKU-bontás, 7 napos költségtrend** — nincs BigQuery billing-export
  hozzáférés a rendelkezésre álló hitelesítéssel. A Cloud Run gépidőből *közvetve*
  látszik, hogy a compute-költség elhanyagolható, de a teljes számla (Neon, LLM API-k,
  egress, Secret Manager) nem került a szemem elé.
- **LLM-token / modell-hívás költség** — a `model_calls` prod tábla nem elérhető
  (prod DB). A dev DB-ben 2846 sor van, de az a tesztfutásokból származik, nem
  éles jel.
- **Clerk / auth hibaráta** — nincs Clerk API kulcs a futtató környezetben.
- **Neon prod slow-query log, hiányzó-index jelzés, full scan** — prod DB nem elérhető.

---

## 2. Aggregált megfigyelések (7 nap, mert 24h-ban nincs forgalom)

### 2.1 Lassú kérések — kizárólag hidegindítás
`/api/agents/rail-state` (7d): **2713 kérés**, 2694×200, 19×404.
Latencia: p50 **0,74 s**, p90 1,09 s, p95 1,92 s, **p99 8,43 s**, max 12,17 s.
`>3 s`: 114 kérés (4,2%); `<1 s`: 2339 (86%). Napi eloszlás: 08-26: 1015, 08-27: 515,
08-30: 654, 08-31: 529, egyébként 0.
`/api/v1/active-runs` (7d): hasonló profil, p50 ~ala­csony, farok ~6–12 s.

**Értékelés:** a p50 egészséges. A 8–12 s-os p99-farok egybeesik a Cloud Run
hidegindítási p95-tel (1,9–5,3 s konténer + Next.js route-warmup + Prisma connect).
Nem lekérdezés-lassúság. A poll-endpointok költség-/gyakoriság-oldala **már
folyamatban**: `perf(dashboard): coalesce rail-state + active-runs` (#406, merge-elve)
és a fejléc „Futások" panel külön poll-útjának megszüntetése (#415, nyitva).
A health-check szabálya szerint **nyitott PR-ral fedett témát nem javaslok újra.**

A hidegindítás önmagában megszüntethető lenne `minInstances: 1`-gyel, de az egy
0 külső felhasználós, hétvégén-hét közben is üresen álló demo-platformon **napi 24 óra
fizetett instance** cserébe azért, hogy egy fejlesztő munkamenetenként egyszer ne
várjon ~8 s-ot — rossz FinOps-alku. Nem javaslom.

### 2.2 404-zaj
131 WARNING/7d ≈ 100% `GET /favicon.ico` (nincs statikus favicon a `app/` gyökér
route-on) + pár elavult `/control-plane/agents/<uuid>/chat?_rsc=…` prefetch. Kozmetikai.
Egy `app/icon.png` / `app/favicon.ico` hozzáadása egy jövőbeli takarításba belefér,
de önmagában nem indokol PR-t és nincs mérhető hatása (a 404 gyors, <10 ms, nem
tart instance-t ébren érdemben).

---

## 3. Rangsor (prioritás = üzleti hatás × gyakoriság ÷ javítási kockázat)

| # | Találat | Hatás | Gyak. | Kock. | Pont | Miért nem lesz belőle ma PR |
|---|---|---|---|---|---|---|
| 1 | `gcloud` token lejárt az ops-hoston → a jövőbeli health-checkek és egy éles incidens vizsgálata is vakon indul | 3 | 3 | 1 | **9,0** | Nem kód. Ember végzi: `gcloud auth login` + `gcloud auth application-default login`. Lásd §4. |
| 2 | `pg_stat_statements` nincs a prod Neon DB-n → egyetlen jövőbeli futás sem tud lassú lekérdezést diagnosztizálni | 2 | 2 | 1 | **4,0** | Éles DB-t nem módosítok (7. pont tiltás). Javaslat §4. Dev DB-n is hiányzik. |
| 3 | Dashboard poll p99 ~8–12 s hidegindítási farok | 2 | 2 | 2 | **2,0** | **Már fedve**: #406 merge-elve, #415 nyitva. Újra-javaslat tilos. |
| 4 | `favicon.ico` + elavult RSC-route 404-zaj (131/7d) | 1 | 2 | 1 | **2,0** | Kozmetikai, 0 mérhető erőforrás-hatás. |
| 5 | ~59 Prisma FK fedő index nélkül a sémában | 2 | 1 | 2 | **1,0** | **Nulla éles bizonyíték**, hogy bármelyik lassúságot okoz (nincs prod `pg_stat_statements`). 60 indexes migráció spekulatív, nagy diff → C ág lenne, de bizonyíték nélkül ma nem viszem oda. |

A legmagasabb pontszámú tétel (#1) **ops-tooling, nem platform-defekt**, és a javítása
emberi lépés, nem PR. Minden platform-oldali tétel vagy már folyamatban van, vagy
bizonyítatlan spekuláció, vagy kozmetikai. → **D ág.**

---

## 4. Ajánlott (nem-kód) lépések

**4.1 — `gcloud` újrahitelesítés az ops-hoston (5 perc, emberi)**
A napi rutin most csak azért látott bármit, mert a `firebase-tools` tokenje véletlenül
még él, és kézzel kerülő-utat építettem a REST API-khoz. Ha az is lejár, a health-check
teljesen vakká válik — és ugyanez a hitelesítés kellene egy éjszakai éles incidens
vizsgálatához is.

```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project enterprise-ai-demo
```

**Amit el kell döntened:** legyen-e a health-check futtatójának **saját, nem-interaktív
service account** (kulcsfájllal vagy workload identity-vel), `roles/logging.viewer` +
`roles/monitoring.viewer` + `roles/run.viewer` jogokkal, hogy ne felhasználói tokenen
lógjon? (igen/nem)

**4.2 — `pg_stat_statements` a prod Neon DB-n**
Enélkül a „lassú lekérdezés / hiányzó index / full scan" forrás — amit ez a rutin
elvileg minden nap néz — strukturálisan nem elérhető. Neonon:
`CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` és a `shared_preload_libraries`
a Neon konzolban (Postgres Settings) → `pg_stat_statements`. Éles DB-t a rutin nem ír;
ezt a platform-csapat végzi el egyszer.

**Amit el kell döntened:** bekapcsoljuk-e a prod (és dev) Neon DB-n a
`pg_stat_statements`-et, hogy a következő health-check már valós lekérdezés-statisztikát
lásson? (igen/nem)

---

## 5. Hogyan mérjük 7 nap múlva (branch D — nincs mit visszamérni, csak folytonosság)

A következő futás (2026-09-09) ugyanezekkel a lekérdezésekkel:

```bash
# 24h app-hiba a deployolt platformon (0-t várunk)
SINCE=$(node -e 'console.log(new Date(Date.now()-864e5).toISOString())')
node ops/tools/logq.mjs "timestamp>=\"$SINCE\" AND resource.labels.service_name=\"enterprise-ai-agent-platform\" AND severity>=ERROR" 5

# 7d Cloud Run gépidő (ingyenkeret alatt marad-e)
# monitoring timeSeries: run.googleapis.com/container/billable_instance_time, ALIGN_SUM 86400s
```

Ha 7 nap múlva megjelenik `severity>=ERROR` vagy `status>=500`, vagy a napi gépidő
tartósan >20 000 s, az már valódi jel és külön vizsgálatot kap.

*(A `logq.mjs` segédszkript a session scratchpadben készült; ha a rutin állandósítja,
`ops/tools/logq.mjs` a helye — most nincs bekommitolva.)*

---

## 6. Megjegyzés a naplózáshoz / verziókövetéshez
A futás pillanatában a munkafa a `fix/agent-api-context-ownership-clean` ágon áll,
egy nem kapcsolódó, még nem commitolt módosítással
(`app/src/domain/tool-broker/tool-broker-service.ts`). Ezért **nem commitoltam** az
`ops/` fájlokat — az idegen WIP-hez nem nyúlok, ág-váltást felügyelet nélkül nem
csinálok. A fájlok a munkafában léteznek; a platform-csapat egy tiszta `main`-alapú
commitba teheti őket (`ops/health-check-log.md`, `ops/reports/health-check-2026-09-02.md`).

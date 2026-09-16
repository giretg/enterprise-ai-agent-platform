# Napi health-check — 2026-09-16

Időablak: utolsó 24 óra (2026-09-15 ~05:10 UTC – 2026-09-16 ~05:10 UTC), viszonyítási alap: megelőző napok/7 nap.

## 0. Amit már tudunk (nem javasoltam újra)
- #426 (Clerk dev-instance prod-on) — nyitva, gyökér-ok emberi döntésre vár.
- #415 (active-runs dupla-poll) — nyitva 14 napja, **CONFLICTING**, CI FAILURE.
- #443/#445/#448 (OOM/DoS body-size gate stack) — mind nyitva 6-8 napja, CI FAILURE, review nélkül.
- Növekvő nyitott PR-szám (34→49→51) és `cursor/*` draft-felhalmozódás — korábban 2x jelezve, ma sem log-alapú találat önmagában.
- gcloud/bq CLI auth lejárt (`gcloud auth login` szükséges) — ismételten fennáll 2026-09-02 óta, billing- és néhány Cloud Run admin-lekérdezés emiatt nem elérhető erről a hosztról. A `firebase-tools` saját tokenje (`ops/tools/logq.mjs`) továbbra is működik, ezen keresztül a Cloud Logging elérhető volt.

## 1. Adatgyűjtés

**Cloud Run / alkalmazás-log (`ops/tools/logq.mjs`, `enterprise-ai-demo` projekt):**
- 24h alatt **0 db `severity>=ERROR`** log a teljes projektben.
- 24h alatt **8046 HTTP kérés** (`cloud_run_revision`): 200→7981, 307→53, 308→2, 304→5, 404→3, 202→1, 403→1. Nincs `5xx`.
- Top 3 endpoint: `/api/v1/active-runs` 3162 (39,3%), `/api/agents/rail-state` 1490 (18,5%), `/control-plane/agents/:id/chat` (SSE) összesen ~2100. Ez összhangban van a már nyitott #415-tel (a duplikált active-runs poll változatlanul a legnagyobb forgalmi tétel, mert a fix még nem mergelt).
- p95 latencia (nyers, minden végpontra összevonva): ~509 ms — nem összevethető közvetlenül a 09-15-i 6,4 s-mal, mert azt korábban vegyes (SSE + poll) mintán mérték; nem vontam le ebből trendkövetkeztetést.
- 7 napra visszamenőleg **37 db ERROR** log összesen, ebből 20 db egyetlen 9 perces ablakban (2026-09-14 12:10–12:19 UTC): mind Secret Manager `AddSecretVersion` "not found" — **megvizsgálva, ÁLTALVETLEN**: minden esetben a következő hívás (`CreateSecret` majd sikeres `AddSecretVersion`) is megjelenik ugyanarra a titokra — ez a connector-API-kulcs mentés szándékos, önjavító "404 → hozz létre → próbáld újra" folyamata (20 különböző connector első mentése, valószínűleg egy seed-művelet), nem hiba és nem regresszió.

**Neon DB (`DATABASE_URL`, `pg_stat_statements`):**
- Az extension mostanra **be van kapcsolva** (a 2026-09-02-i javaslat megvalósult, bár nem tudom, ki/mikor tette).
- Stats óta (2026-09-16 05:06 UTC) eltelt ~9 óra alatt a legdrágább lekérdezés összesen 135 ms (25 hívás, átlag 5,4 ms) — nincs lassú vagy hiányzó indexre utaló minta. A kérésszámok (max 98 hívás/9h egy query-re) megerősítik, hogy a valódi DB-terhelés ma is alacsony.

**GitHub CI/PR állapot:**
- Lásd 3. pont — ez lett a mai top találat.
- Nyitott PR: **51** (09-15: 49), `cursor/*` draft: **22** (09-15: 21), 7 napnál régebbi nyitott PR: **37**.

**Nem vizsgált terület (forrás nem elérhető erről a hosztról):**
- Billing export / SKU-bontás (gcloud/bq auth lejárt).
- Cloud Run instance-óra, cold start szám, memória/CPU kihasználtság (`gcloud run` parancsok auth nélkül nem futnak; a log-alapú metrikán túl nincs másik forrás).
- Firestore olvasás/írás darabszám és legterheltebb collection (nincs bekötve/nem található hozzáférés).
- Clerk hibaráta közvetlen API-ból (csak a log-alapú, közvetett jelek álltak rendelkezésre — ott nem volt új esemény).

## 2. Top 5 (pontszám = üzleti hatás × gyakoriság ÷ javítási kockázat)

| # | Találat | Hatás | Gyakoriság | Kockázat | Pontszám |
|---|---------|-------|-----------|----------|----------|
| 1 | **`main` CI 100/100 utolsó futás piros** — egy rosszul elhelyezett DB-teszt miatt a teljes stub-teszt lista leáll, senki sem lát megbízható zöld pipát | 5 | 5 | 1 | **25** |
| 2 | Active-runs dupla-poll (#415) továbbra is a Cloud Run-forgalom 39%-a, fix 14 napja nyitva, CI-vel együtt most már konfliktusos is | 3 | 5 | 2 | 7,5 |
| 3 | OOM/DoS body-size gate stack (#443/#445/#448) 6-8 napja review nélkül, ugyanaz a CI-akadály | 4 | 2 | 2 | 4 |
| 4 | Nyitott PR-szám és `cursor/*` draft-felhalmozódás folyamatosan nő (34→49→51) | 2 | 3 | 3 | 2 |
| 5 | gcloud/bq CLI-auth lejárt — billing és Cloud Run admin-adat 2 hete nem vizsgálható erről a hosztról | 2 | 5 | 1 | 10 (de nem kód-javítás, hanem emberi lépés — lásd alább) |

A #5 pontszáma magas, de nem PR-esíthető: `gcloud auth login` egy embernek kell, interaktív böngésző-bejelentkezéssel jár. Ezt korábban (09-02) már jeleztem, nem ismétlem PR-ként, csak megerősítem, hogy még mindig fennáll.

## 3. Mélyebb vizsgálat — a #1 találat

**Tünet:** a `main` ág CI-ja ("CI" workflow) az utolsó **100 egymást követő futásból 100-ban failure** (2026-08-21 – 2026-09-15, 2 "cancelled" kivétellel), a jelenleg nyitott 51 PR nagy részén is FAILURE látszik.

**Gyökér-ok:** a `.github/workflows/ci.yml` `verify` job-ja ("Lint · tsc · prisma · stub-tesztek") egy **kitalált, nem létező** `DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub` mellett fut, adatbázis-szolgáltatás (service container) nélkül. A teszt-listában viszont ott szerepel `npm run test:val-surrogate-crypto-shred`, aminek a saját fájlfeje is leírja: "Valódi Postgres kell — futtatás migrált DB ellen". Mivel a job lépése `bash -e` alatt fut, az első hibánál (ez a teszt) **azonnal leáll** — a mögötte listázott ~20 további teszt soha nem fut le, és a job pirosan bukik.

A fájlban már létezik egy másik job ("Prisma migrate deploy (ephemeral Postgres)"), aminek VAN valódi, ideiglenes Postgres szolgáltatása, és pontosan ide vannak felvéve a hozonló, "csak valódi DB ellen bizonyítható" tesztek (`test:agent-turn`, `test:surrogate-map`, `test:privacy-resolve-scope` stb.) — ez az egy teszt egyszerűen rossz helyre került, valószínűleg amikor felvették (2026-08-20, #292).

**Ellenőrzés:** a tesztet helyben, egy valódi, frissen migrált Neon teszt-ágon (`DATABASE_URL_TEST`) lefuttatva mind az 5 belső ellenőrzés **hibátlanul lefutott** — a funkció maga jó, tisztán CI-vezetékezési hiba.

**Döntés (5. pont szabálya szerint):** ~9 soros diff, kockázat minimális, egy lépésben visszaállítható → **B ág, draft PR**.

→ **[PR #498](https://github.com/giretg/enterprise-ai-agent-platform/pull/498)** (draft): a teszt áthelyezése a `verify` jobból a `migrations` jobba. Nincs alkalmazáskód-változás. Mérési parancs a PR leírásában.

## 4. Zárás

| Dátum | Top találat | Ág | PR | Státusz |
|-------|-------------|----|----|---------|
| 2026-09-16 | `main` CI 100/100 futás pirosan bukik egy rosszul elhelyezett DB-teszt miatt — ez az elmúlt hetek PR-torlódásának (#415, #443/445/448 review nélkül) is valószínű oka | B | [#498](https://github.com/giretg/enterprise-ai-agent-platform/pull/498) (draft) | Nyitva — review és merge emberi döntésre vár. |

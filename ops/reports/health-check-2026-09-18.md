# Napi health-check — 2026-09-18

Időablak: utolsó ~25 óra (2026-09-17 ~08:00 UTC – 2026-09-18 ~09:10 UTC), viszonyítási alap: megelőző 7 nap.

## 0. Amit már tudunk (nem javasoltam újra)

- #426 (Clerk dev-instance prod-on) — nyitva, gyökér-ok emberi döntésre vár, ma nincs új jel.
- #437, #449, #498, #512, #515 — mind **MERGED** (az elmúlt napok health-check PR-jai), regresszió-ellenőrzés lent.
- Nyitott PR-szám tovább nő: 51 (09-16) → 52 (ma). `cursor/*` draft-torlódás továbbra is fennáll, nem ismétlem log-alapú találatként.
- gcloud auth ma **aktív** (`eai-healthcheck-runner@enterprise-ai-demo.iam.gserviceaccount.com`) — a korábbi "lejárt token" korlátozás ma nem állt fenn.

## 1. Adatgyűjtés

**Cloud Run / alkalmazás-log (`gcloud logging read`, `enterprise-ai-demo` projekt, `europe-west4`):**
- 24h alatt **3085 HTTP kérés**: 2576×200, 325×307, 119×308, 4×304, 1×202, 1×401, **55×500**.
- p95 latencia (nyers, minden végpontra összevonva, n=3019): **541 ms**, p50 143 ms, p99 5,97 s (hosszú élettartamú SSE-kapcsolatok, nem anomália).
- A 24h alatti **mind az 55 db 500-as válasz egyetlen, azonos gyökér-okra vezethető vissza** — lásd 3. pont.
- 7 napra visszamenőleg ez a hibaminta **0-ról indult**: az első előfordulás 2026-09-17T10:46:50Z, pontosan egybeesik két aznapi migrációs commit deployjával (lásd lent). Azelőtt egyetlen ilyen log-sor sincs.
- Firestore: a kódbázisban nincs `firebase-admin/firestore` / `getFirestore` hivatkozás — a platform Postgres (Neon) + Prisma-alapú, Firestore nem releváns forrás.

**Neon DB / Prisma:**
- Nem csatlakoztam közvetlenül az éles DB-hez (írás/kapcsolódás kockázat elkerülése miatt) — a gyökér-ok a Cloud Run alkalmazás-logokból (Prisma hibaüzenetek + `git log`) egyértelműen rekonstruálható, közvetlen DB-introspekció nélkül is. Lásd 3. pont.

**Billing export:** nincs bekötve ebbe a projektbe (`bq ls --project_id=enterprise-ai-demo` üres eredmény) — nem vizsgált terület, changetlen a korábbi futásokhoz képest.

**Clerk auth hibaráta:** 1×401 a 24h alatt, elszigetelt, nincs minta — nem vizsgálom mélyebben.

**Nem vizsgált terület:**
- Firestore (nem releváns — lásd fent).
- Billing/SKU-bontás (nincs export bekötve).
- Cloud Run instance-óra / cold start szám (a `describe` parancs nem adott használható revíziónkénti forgalommegoszlást erről a hosztról ésszerű időn belül; a log-alapú kép elegendő volt a mai találathoz).

## 2. Top 5 (pontszám = üzleti hatás × gyakoriság ÷ javítási kockázat)

| # | Találat | Hatás | Gyakoriság | Kockázat | Pontszám |
|---|---------|-------|-----------|----------|----------|
| 1 | **Séma-eltérés éles DB-n**: a #517/#518 (2026-09-17) migrációi (`launch_id`, `launch_attempt_count`, `launch_reserved_at` oszlopok az `agent_turns` táblán) a kódba be lettek deployolva, de **az éles Neon adatbázisra nincsenek alkalmazva** — **REGRESSZIÓ** (ugyanez történt élesben 2026-07-27-én, akkor a következmény-kapu néma halálát okozta) | 4 | 4 | 1 | **16** |
| 2 | Nyitott PR-szám folyamatos növekedés (34→49→51→**52**), 09-16 CI-fix óta sem állt meg a torlódás | 2 | 3 | 3 | 2 |
| 3 | #426 Clerk dev-instance élesben — 12 napja nyitva, emberi döntésre vár | 3 | 1 | 2 | 1,5 |
| 4 | Billing export nincs bekötve — 3. hete nem vizsgálható terület | 2 | 5 | 1 | 10 (de nem kód-javítás, korábban már jelezve, nem ismétlem PR-ként) |
| 5 | p99 latencia 5,97 s (hosszú SSE-kapcsolatok) — anomália-jel nélkül, csak megfigyelés | 1 | 2 | 2 | 1 |

## 3. Mélyebb vizsgálat — a #1 találat

**Tünet:** 2026-09-17 10:46:44 UTC-től kezdve (majd szórványosan folytatódva 09-18 08:03 UTC-ig, azaz **jelenleg is fennáll**) a `/api/agents/rail-state`, `/api/v1/active-runs` és `/api/v1/agent-chat/turns` végpontok időnként `500`-at adnak vissza. 24 óra alatt **55 darab 500-as válasz, mindegyik ugyanarra a hibára vezethető vissza** (legalább 3 különböző beszélgetés/agent érintett a mintában).

**Gyökér-ok (alkalmazás-log, `prisma:error`):**
```
Invalid `prisma.agentTurn.findMany()` invocation:
The column `agent_turns.launch_id` does not exist in the current database.
code: 'P2022'
```
és később (09-18 reggel is):
```
Invalid `prisma.agentTurn.findFirst()` invocation:
The column `agent_turns.launch_reserved_at` does not exist in the current database.
code: 'P2022'
```

Ez pontosan egybeesik két 2026-09-17-i migrációval:
- `app/prisma/migrations/0050_agent_turn_launch` (#517, commit `6ec9bb437`) — hozzáadja: `launch_id`, `launch_attempt_count`, `launch_next_retry_at`, `launch_provider_ref`.
- `app/prisma/migrations/0051_agent_turn_capacity` (#518, commit `fad056d8c`) — hozzáadja: `launch_reserved_at`.

A `.github/workflows/ci.yml` CI-pipeline-ban van egy `prisma migrate deploy` lépés, de az **egy eldobható, ideiglenes tesztadatbázis ellen fut** (lásd a 2026-09-16-i találatot is, ahol ugyanez a job szerepelt) — **semmi sem futtatja automatikusan a migrációt az éles Neon adatbázison** deploy után. A migrációs fájlok rendben, commitolva vannak, a kód helyesen hivatkozik rájuk — kizárólag az éles DB maradt le a séma-frissítéstől.

**REGRESSZIÓ:** 2026-07-27-én ugyanez a hibaosztály már okozott éles problémát (5 alkalmazatlan migráció, a következmény-kapu némán nem működött, a `consequence_approvals` tábla hiányzott). Az akkori tanulság — "kész és mergelt funkció némán nem működik → először `prisma migrate status`, ne a kódban keress" — nem vezetett folyamatváltozáshoz: nincs automatizált védőháló, ami egy következő migrációnál is megelőzné ugyanezt. Ezúttal a hiba nem néma (500-as hibák láthatók), de a mechanizmus azonos.

**Miért nem 100%-os a hibaarány:** a `rail-state`/`active-runs` végpontok jóval többször hívódnak, mint ahányszor hibáznak — a `launch_*` oszlopokat érintő lekérdezési ág csak akkor fut le, amikor egy forduló indítás/egyeztetés (kapacitás-foglalás, elveszett indítás helyreállítása) történik, nem minden egyszerű lekérdezésen. Ez azt jelenti, hogy **minden agent-forduló indítási/helyreállítási kísérlet, ami ebbe az ágba fut, jelenleg 500-at kap** — ez pontosan a #517/#518 által megcélzott megbízhatósági mechanizmust töri el, amit be akartak vezetni.

**Döntés (5. pont szabálya szerint):** a kód maga helyes és már mergelve van — **nincs mit PR-ba tenni**. A hiányzó lépés egy privilegizált, egyszeri művelet (`npx prisma migrate deploy` az éles `DATABASE_URL`-lel), amit ez a rutin a szabályai szerint **nem futtathat** ("éles adatbázisba nem írsz, semmilyen körülmények között"). Ez nem is architekturális nagy munka — **C ág: döntési jegyzet**, mert a szükséges lépés kívül esik azon, amit ez a folyamat autonóm módon elvégezhet, és emberi jóváhagyást/végrehajtást igényel.

### Döntési jegyzet — éles migráció alkalmazása

**Probléma:** két 2026-09-17-i migráció (0050, 0051) a kódban van, az éles DB-n nincs. Azóta (≥22 órája) szórványos 500-as hiba az agent-forduló indítási/kapacitás-egyeztetési mechanizmuson.

**Opciók:**
1. **Azonnali kézi lépés** (perceken belül elvégezhető): valaki, akinek van éles `DATABASE_URL`-je, futtassa `cd app && npx prisma migrate deploy`-t. Ez pontosan a `migrate status`/`migrate deploy` pár, amit a 2026-07-27-i incidens tanulsága is javasolt.
2. **Folyamatvédelem** (megelőzi a következő ismétlődést): a deploy-pipeline-ba (apphosting build lépés vagy külön GitHub Actions job, éles `DATABASE_URL` secret-tel) épített, forgalom-átállás előtti `prisma migrate deploy` + `migrate status` ellenőrzés. Ez már kódváltoztatás, ~50-100 soros CI/CD-diff — de csak azután van értelme megírni, hogy az 1. lépés lezajlott, és külön döntés kell hozzá (éles DB-secret CI-ba adása biztonsági kérdés, ami emberi jóváhagyást igényel).

**Becsült ráfordítás:** 1. lépés: 5-10 perc egy emberi művelettel. 2. lépés: kb. fél nap, ha úgy döntenek, hogy megéri.

**Ha nem csinálunk semmit:** minden további `launch_id`/`launch_reserved_at`-et érintő agent-forduló indítási/helyreállítási kísérlet továbbra is 500-at kap — ez pontosan a megbízhatósági mechanizmust töri el, amit a #517/#518 be akart vezetni, és ugyanez a csapda bármelyik jövőbeli migrációnál megismétlődhet.

**Eldöntendő:** fusson-e le most valaki által kézzel a `prisma migrate deploy` az éles DB-n — igen/nem?

## 4. Zárás

| Dátum | Top találat | Ág | PR | Státusz |
|-------|-------------|----|----|---------|
| 2026-09-18 | Séma-eltérés éles DB-n: #517/#518 (09-17) migrációi a kódban vannak, az éles Neon DB-n nincsenek — 55×500 hiba/24h a forduló-indítási/kapacitás-mechanizmuson, **REGRESSZIÓ** a 2026-07-27-i incidenshez képest | C | nincs | Nyitva — döntési jegyzet emberi jóváhagyásra vár: fusson-e a `prisma migrate deploy` az éles DB-n. |

# Napi health-check — 2026-09-05

Időablak: 2026-09-04 02:00 UTC → 2026-09-05 02:24 UTC (24 óra), gcloud logging (`eai-healthcheck-runner` SA, csak olvasás).

## 0. Előzmény-ellenőrzés

- `ops/health-check-log.md` utolsó bejegyzése 2026-09-02: „nincs érdemi találat", 0 forgalom.
- Memóriában / korábbi ad-hoc futásokból ismert nyitott tételek 2026-09-03–04-ből:
  - **#426 (Urgent, OPEN)** — prod Clerk *development* instance, Googlebot session-replay a control-plane-en.
  - **PR #420 (MERGED, main-en)** — `robots.txt: Disallow /` a #426/#421 mitigációjaként.
  - **PR #425 (MERGED)** — folyamat review-döntés single-use fix, nem health-check tárgyköre.
  - **PR #422 (MERGED)** — recept-katalógus bérlő-kapu, nem health-check tárgyköre.
- Ezekre a szabály szerint **nem javaslok új PR-t/issue-t** — de a rutin explicit kéri a regresszió-ellenőrzést, ezért #426-ot **mai adatokkal újra megnéztem** (lásd lent). Ez nem új találat, hanem az Urgent tétel állapotfrissítése.

## 1. Adatgyűjtés — mit sikerült, mit nem

| Forrás | Eredmény |
|---|---|
| Cloud Run request/error log (`enterprise-ai-agent-platform`, europe-west4) | ✅ sikerült, `gcloud logging read` |
| Cloud Run szolgáltatás-lista, deploy-időbélyeg | ✅ sikerült |
| Firebase App Hosting backend + publikus URL | ✅ sikerült (`firebase apphosting:backends:list`) |
| `robots.txt` élő ellenőrzése a publikus domainen | ✅ sikerült (curl) |
| Clerk kulcs-mód (`pk_test_` vs `pk_live_`) élő ellenőrzése | ✅ sikerült (curl a főoldalra) |
| Cloud Functions / Firestore | **nem alkalmazható** — az API nincs bekapcsolva a projektben, a rendszer nem használ Cloud Functions-t/Firestore-t (Postgres/Prisma-alapú, lásd `DEPLOY.md`) |
| Neon DB lassú lekérdezés / index-hiány | **nem vizsgált** — az `eai-healthcheck-runner` SA-nak nincs Neon-hozzáférése (ismert, nyitva hagyott tétel 09-02 óta: `pg_stat_statements` + ADC-átállás) |
| Billing export SKU-nkénti költség | **nem vizsgált** — a projekten nincs billing-fiók hozzárendelve az SA-hoz, és nincs BigQuery billing-export dataset |
| Clerk auth hibaráta (4xx/5xx a `/api/auth` vagy Clerk webhookon) | ✅ részben — a log-alapú metrikából (lásd lent), külön Clerk dashboard nem elérhető |

## 2. Aggregált megfigyelések (24h, 153 HTTP-kérés összesen)

**Forgalom szinte teljes egészében Google crawler.** UA szerint: 150/153 `Google`, 3/153 `curl/8.7.1` (ez az én saját ellenőrző lekérdezésem). Emberi/valós felhasználói forgalom **nem** azonosítható ebben az ablakban.

Végpontok (deploy előtti, 07:33–14:50 UTC közötti szakaszból, ez a bot-forgalom 149/153-a):
| Végpont | Előfordulás | Megjegyzés |
|---|---|---|
| `POST /control-plane/agents/<agent-id>/chat` | 57 | mind HTTP 200 — a crawler ténylegesen chat-üzeneteket indított |
| `GET /api/agents/rail-state` | 41 | HTTP 200 |
| `GET /api/v1/active-runs` | 41 | HTTP 200 |
| `GET /control-plane/agents` | 10 | HTTP 200 |
| egyéb (`/`, `/robots.txt`) | 4 | vegyes |

**Hibaráta:** 0 db `severity>=ERROR` alkalmazáslog 24 óra alatt. p95 válaszidő 7,04 s (a `chat` végpont streamelése miatt várható, nem anomália), medián 0,40 s.

## 3. Regresszió-ellenőrzés: #426 (Clerk dev-instance session-replay)

Ez a legdrágább/legfájóbb tétel volt tegnap, ezért ma priorítást ez kapott a mélyebb vizsgálatból — de mivel **már van rá nyitott Urgent issue és merge-elt mitigációs PR**, itt nem új találatot jelentek, hanem ennek **mai állapotát**.

**Jó hír — a mitigáció (PR #420, `robots.txt: Disallow /`) működik:**
- A live deploy 2026-09-04 14:50:43 UTC-kor történt (Firebase App Hosting build log alapján).
- **Deploy előtt** (07:33–14:50 UTC, ~7 óra): 149 crawler-kérés, ebből 57× `POST .../chat` **HTTP 200**-zal — vagyis a Googlebot ez idő alatt még ténylegesen futtatta a control-plane-t.
- **Deploy után** (14:50 UTC → ma 02:24 UTC, ~11,5 óra): mindössze 4 kérés összesen, ebből a Googlebot saját kérése a gyökér URL-re már **HTTP 404**-et kapott (nem 200-at), és **egyetlen `/control-plane/...` találat sem volt** ebben az ablakban.
- Élőben ellenőriztem: `https://enterprise-ai-agent-platform--enterprise-ai-demo.europe-west4.hosted.app/robots.txt` → HTTP 200, tartalma `User-Agent: *` / `Disallow: /`.

**Rossz hír — a gyökérok nincs javítva, ahogy a #426 leírja:**
- A főoldal HTML-jében élőben most is `pk_test_...` publishable key szerepel → **a Clerk-instance ma is development-mód**, élesben.
- 24 óra alatt 24 db Clerk-telemetria logsor („Attention: Clerk collects telemetry data... development instances") — ugyanaz a jelenség, ami a #426-ot kiváltotta.
- Ha bármilyen jövőbeli linkelés/crawl (nem csak Google, bármi ami nem respektálja a robots.txt-t, vagy egy már korábban indexelt/megosztott URL a `__clerk_handshake`/`__clerk_db_jwt` paraméterrel) újra előkerül, a kitettség **azonnal visszatér**, mert maga a session-az-URL-ben tervezési hiba nem szűnt meg, csak a bejárás lett letiltva.

**Összegzés:** nem regresszió (a helyzet jobb, mint tegnap), de a #426 „AZONNALI" címkéje **jogos marad** — a robots.txt csak a tünetet fedi le (crawler ne induljon el), a valódi fix (prod Clerk instance + `sk_live_`/`pk_live_` kulcsok, dev-instance nyugdíjazása) a #426-ban leírtak szerint továbbra is hátravan. Nem nyitok új issue-t/PR-t, mert ez már a #426 alatt fut.

## 4. Top 5 (pontszám = üzleti hatás × gyakoriság ÷ javítási kockázat)

| # | Találat | Hatás | Gyakoriság | Kockázat | Pontszám | Megjegyzés |
|---|---|---|---|---|---|---|
| 1 | #426 gyökéroka (Clerk dev-instance élesben) | 5 | 3 (tegnap még aktív, ma nyugvó) | 2 | 7,5 | **Már nyitott Urgent issue, nincs új teendő ma** |
| 2 | Neon `pg_stat_statements` + SA-hozzáférés hiánya | 2 | — | 1 | n/a | Ismert, 09-02 óta nyitva, nem health-check-generált teendő |
| 3 | Billing export hiánya (nincs SKU-szintű költséglátás) | 2 | — | 1 | n/a | Ismert, nem vizsgálható enélkül |
| 4–5 | — | — | — | — | — | Nincs további érdemi jelölt: 0 hiba, elhanyagolható valós forgalom |

Az 1. helyezett már kezelés alatt van (nyitott issue), a 2–3. tétel infrastrukturális előfeltétel-hiány, nem ma felmerült probléma, és önmagában egyik sem éri el egy önálló PR/döntési jegyzet szintjét (nincs mit kódban javítani, hozzáférést kellene nyitni előbb).

## 5. Döntés

**Ág D — nincs új, önálló teendő mára.**

Amit ellenőriztem: Cloud Run hibalog (0 hiba), kérés-mintázat és válaszidő, a #426 mitigáció élő hatása, a #426 gyökéroka él-e még, Clerk telemetria-log, billing/Neon hozzáférhetőség.

Amit nem vizsgáltam (forráshiány, nem becsültem): Neon lassú lekérdezések, SKU-szintű felhő-költség, Cloud Run instance-óra/cold-start (monitoring API-hozzáférés nélkül a jelenlegi SA-val nem lekérdezhető).

Egyetlen javaslat, ami nem éri el az önálló PR szintet, de érdemes lenne feljegyezni döntésként: **mikor tekintjük a #426-ot ténylegesen lezártnak** — jelenleg a mitigáció (robots.txt) fut, de a gyökérok (dev Clerk kulcs) nyitva marad napok óta; érdemes lenne a #426-ba egy konkrét határidőt/döntést tenni, hogy ez ne süllyedjen el „mitigálva, ezért felejtve" állapotban.

## Hogyan mérjük 7 nap múlva

```
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="enterprise-ai-agent-platform" AND httpRequest.requestUrl:"/control-plane/"' --freshness=7d --format=json --project=enterprise-ai-demo | jq '[.[] | select(.httpRequest.userAgent=="Google")] | length'
```
Elvárt eredmény: 0 (ha a robots.txt-mitigáció tartja magát). Ha nem 0, az vagy regresszió, vagy azt jelzi, hogy más crawler/kliens nem respektálja a `Disallow: /`-t, és a gyökérokot (dev Clerk kulcs) tovább nem lehet halogatni.

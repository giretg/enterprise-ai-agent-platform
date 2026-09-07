# Napi health-check riport — Enterprise AI Agent Platform
**Dátum:** 2026-09-06 · **Szerep:** SRE + FinOps · **Ág:** **A — biztonsági kitettség / adatszivárgás gyanúja** · **REGRESSZIÓ**

## 🔴 AZONNALI — egymondatos összefoglaló
A Google renderelő-/crawler-flottája **hitelesített munkamenettel** olvassa **és írja**
(`POST`) a deployolt control-plane-t; ez a már ismert **#426** kitettség, és a
2026-09-03-i `robots.txt` enyhítés (**#420**) ellenére **09-05-én a 7 napos ablak
legmagasabb napi forgalmát** produkálta (6 467 kérés) → az enyhítés nem fogja meg a
gyökérokot.

Ez **nem** új probléma: a nyitott **#426** (`Urgent`, `security`, 2026-09-04) pontosan
ez. Ezért **nem nyitok új issue-t** — a mai regressziós bizonyítékot **kommentként**
fűzöm a #426-hoz. Új PR-t sem nyitok (A ág).

---

## 1. Mi a kitettség

- A prod a Clerk **development** instance-ét használja → a munkamenet az URL-ben
  utazik (`__clerk_handshake`), a Google beindexelte, és a renderelő-flotta
  **authentikáltan visszajátssza** a control-plane oldalakat.
- A renderelt oldal beindítja a kliensoldali SPA-t, ami **15 másodperces poll-hurokban**
  hívja az `/api/v1/active-runs` és `/api/agents/rail-state` végpontokat — minden
  renderelt oldal önfenntartó „bejelentkezett böngészőfül"-ként viselkedik.
- **Írási műveletek is történnek** (Next.js server action `POST`-ok, mind `200`):
  - `POST /control-plane/agents/<agent-id>/chat` — **1 796×** / 7 nap
  - `POST /control-plane/agents/<agent-id>/profile` — **317×** / 7 nap
  - `POST /control-plane/agents/<agent-id>/task` — 15× · `.../board` — 21× ·
    `POST /control-plane/tickets/<ticket-id>` — 15×
  Ez az enterprise control-plane **integritási** kitettsége, nem csak olvasási.

## 2. Mióta áll fenn / regresszió

| Nap | Kérés (deployolt platform) | Megjegyzés |
|---|---:|---|
| 2026-08-30 | 1 755 | |
| 2026-08-31 | 3 911 | |
| 2026-09-02 | 2 223 | |
| 2026-09-03 | 485 | `robots.txt` (#420) fix commit-olva; Googlebot `/robots.txt` → **404** |
| 2026-09-04 | 149 | enyhítés hat — mélypont |
| **2026-09-05** | **6 467** | Googlebot `/robots.txt` → **200** (03:23, 04:08, 04:09) **mégis** ez a csúcsnap |
| 2026-09-06 | 3 (05:33-ig) | részleges nap |

- **7 napos összes forgalom: 14 981 kérés, ebből ~14 981 `Google` user-agent.**
  Valódi végfelhasználói forgalom: **0** (7 `curl` = saját teszt, 7 azonosított
  `Googlebot`). Forrás: `httpRequest.userAgent` aggregálás 7d, `severity` szűrő nélkül.
- 09-05 óránkénti: 0 éjszaka → 06:00 = 150 → **09:00 = 1 627** → 300–800/óra
  folyamatosan 09:00–18:00 CET (munkaidő: fejlesztői belépés → session az URL-be →
  Google visszajátssza).

**Miért nem elég a `robots.txt`:** a `Disallow: /` a *crawl-for-indexing*-et tiltja.
Nem törli a már indexelt URL-eket, nem állítja meg a Google renderelőjét az ismert
URL-ek újralátogatásában, nem állítja meg a renderelés után futó kliensoldali
poll-hurkot, és **nem érvényteleníti a szivárgott munkamenetet**. A 09-05-i adat ezt
empirikusan igazolja: a bot beolvasta a `200`-as `robots.txt`-t, és aznap crawlolt a
legtöbbet.

## 3. Mit kell most tenni (#426 gyökérok-javítás — emberi, nem PR)

1. **Prod Clerk → production instance** (`pk_live` / `sk_live`), a development instance
   nyugdíjazása. Ez szünteti meg az URL-ben utazó munkamenetet.
2. **Meglévő munkamenetek érvénytelenítése** (Clerk: revoke all sessions) a
   cser-váltás után — a szivárgott session-öket a bot addig használja, amíg élnek.
3. **Index-eltávolítás**: Google Search Console → Removals a
   `enterprise-ai-agent-platform-346824017066.europe-west4.run.app` és a
   `…-j7drz42rma-ez.a.run.app` hostokra (a `robots.txt` önmagában nem deindexel).
4. **Ellenőrzés**: az App Hosting utolsó *rollout*-ja `SUCCEEDED 2026-08-21` —
   erősítsük meg, hogy a #420 `robots.txt` route ténylegesen a futó revízióban van
   (a 09-05-i `200`-as fetch alapján igen, de a rollout-lista ezt nem tükrözi).
5. **Opcionális, gyors védőréteg**: Cloud Run / App Hosting elé Cloud Armor
   bot-szabály vagy a `/control-plane` alá `X-Robots-Tag: noindex` + a
   `__clerk_handshake` query-param szűrése edge-en.

## 4. Rangsor (prioritás = üzleti hatás × gyakoriság ÷ javítási kockázat)

| # | Találat | Hatás | Gyak. | Kock. | Pont | Státusz |
|---|---|---|---|---|---|---|
| 1 | **#426 Clerk dev-instance session-leak — Google-flotta hitelesített olvasás+`POST` a control-plane-en; 09-05 regresszió (6 467, csúcsnap, az enyhítés után)** | 5 | 5 | 3 | **8,3** | **A ág.** #426 nyitva (`Urgent`). Ma: regressziós komment a #426-ra. |
| 2 | `favicon.ico` 404 (96 / 7 nap) | 1 | 2 | 1 | 2,0 | Kozmetikai. `app/icon.png` egy jövőbeli takarításba. |
| 3 | 2× tranziens `500` a `/embed/control-plane/agent.new`-n (09-03 06:08) | 2 | 1 | 1 | 2,0 | Deploy-ablak, magától megszűnt. Nem ismétlődik. |
| 4 | ~9 Cloud Run hidegindítás/nap (09-05, `npm run start`) | 1 | 2 | 2 | 1,0 | A #1 crawler-terhelés mellékhatása; a #1-gyel megszűnik. |
| 5 | `pg_stat_statements` továbbra sincs a prod Neon DB-n (09-02 átvitel) | 2 | 1 | 2 | 1,0 | Nem viszem újra; 09-02 riport §4.2 áll. |

Egyetlen érdemi találat a #1. Minden más kozmetikai, tranziens, vagy a #1 mellékhatása.

## 5. Amit ellenőriztem — és mivel

Auth: dedikált `eai-healthcheck-runner@…` service account (kulcsfájl a
`~/.config/eai-healthcheck/`-ban), `gcloud logging read` + `monitoring` REST **működött**.

| Terület | Forrás | Eredmény |
|---|---|---|
| App-hiba `severity>=ERROR` 24h | `gcloud logging read 'severity>=ERROR' --freshness=1d` | **0** |
| `severity>=ERROR` 7d (projekt) | ugyanaz `--freshness=7d` | 2× `500` (09-03 06:08 `/embed/...agent.new`) + 1 build-sor (08-30) |
| `status>=500` 7d | `httpRequest.status>=500` | ugyanaz a 2 sor |
| Kérés-volumen 24h / 7d | `httpRequest.requestMethod!=""` aggregálás | 24h ~5 000+, 7d **14 981**, ~100% `Google` UA |
| URL-bontás 7d | normalizált `requestUrl` + method uniq-c | §1/§2 táblák; top: `GET active-runs` 4 124, `POST .../chat` 1 796 |
| `robots.txt` fetch-ek 7d | `requestUrl:"robots.txt"` | 09-03 → `404`, 09-05 → `200` (Google), közben mégis csúcs-crawl |
| Cloud Run billable instance-idő 7d | `monitoring timeSeries` `billable_instance_time` ALIGN_SUM 86400s | napi ~130–1 700 s; **compute-költség elhanyagolható** (Cloud Run ingyenkeret 180 000 vCPU-s/hó) |
| Konténer-újraindítás | `textPayload:"npm run start"` | 09-05: ~9 hidegindítás munkaidőben |
| Deploy / rollout | `firebaseapphosting…/rollouts` | nincs `FAILED`; utolsó `SUCCEEDED 2026-08-21` (lásd §3/4) |
| Sibling `ostoros-fold` | `severity>=ERROR` 24h | tiszta |

### Nem vizsgált (tényként, becslés nélkül)
- **Cloud Billing / SKU-bontás, LLM-token-költség** — nincs BigQuery billing-export
  hozzáférés; a `model_calls` prod tábla nem elérhető (prod DB). Ezért **nem
  becsülhető megbízhatóan**, hogy a `POST .../chat` visszajátszások indítanak-e
  tényleges agent-diszpécselést és Anthropic API-költséget. A Cloud Run compute-ból
  *közvetve* látszik, hogy a gépidő-költség elhanyagolható, de az LLM-oldal vak folt.
- **Clerk auth-hibaráta** — nincs Clerk API-kulcs a futtató környezetben.
- **Prod Neon slow-query / hiányzó index / full scan** — prod DB nem elérhető,
  `pg_stat_statements` nincs telepítve.
- **A deployolt `robots.txt` törzse** — a futtató host IP-je `403`-at kap a Google
  edge-től (`curl` bármely UA-val); csak a Googlebot 09-05-i `200`-as fetch-jéből
  tudjuk, hogy `robots.txt` létezik és kiszolgálódik.

## 6. Hogyan mérjük 7 nap múlva

A Clerk production-instance váltás + session-revoke + index-removal után a
**deployolt platform `Google` UA-forgalmának el kell tűnnie**:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/eai-healthcheck/gcp-runner-key.json"
SVC='resource.labels.service_name="enterprise-ai-agent-platform"'

# 7 nap múlva: napi kérésszám a deployolt platformon (várt: ~0, vagy csak valódi UA)
gcloud logging read "$SVC AND httpRequest.requestMethod!=\"\"" --freshness=7d \
  --format="value(timestamp)" --project=enterprise-ai-demo --limit=50000 \
  | cut -dT -f1 | sort | uniq -c

# user-agent bontás (várt: NINCS csupasz "Google", vagy erősen lecsökkent)
gcloud logging read "$SVC AND httpRequest.requestMethod!=\"\"" --freshness=7d \
  --format="value(httpRequest.userAgent)" --project=enterprise-ai-demo --limit=50000 \
  | sort | uniq -c | sort -rn

# hitelesített POST-ok külső UA-tól (várt: 0)
gcloud logging read "$SVC AND httpRequest.requestMethod=\"POST\" AND httpRequest.status=200" \
  --freshness=7d --format="value(timestamp,httpRequest.userAgent,httpRequest.requestUrl)" \
  --project=enterprise-ai-demo --limit=100
```

**Sikerkritérium:** a `Google` (csupasz UA) sorok eltűnnek vagy <1%-ra esnek, és
`POST … 200` külső/bot UA-tól nincs. Ha a `Google`-forgalom 7 nap múlva is >1 000/nap,
az azt jelenti, hogy a Clerk-instance váltás nem történt meg vagy az index nem lett
tisztítva — eszkaláció.

---

*A `logq.mjs` / SKILL ADC-átállítása továbbra is nyitott ops-tétel (lásd
`healthcheck-gcp-service-account` memória). A mai futás a service account
kulcsfájljával ment, ami működött.*

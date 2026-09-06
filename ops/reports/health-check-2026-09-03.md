# Napi health-check riport — Enterprise AI Agent Platform
**Dátum:** 2026-09-03 · **Szerep:** SRE + FinOps · **Ág:** **B — draft PR** ([#420](https://github.com/giretg/enterprise-ai-agent-platform/pull/420))

## TL;DR
A deployolt platform (`enterprise-ai-agent-platform`, `enterprise-ai-demo` projekt,
`europe-west4`) forgalmának **100%-a a Google kereső-/renderelő-flottája** — az elmúlt
24 órában **2462 kérésből 2462** a `Google` user-agent, a Googlebot IP-tartományaiból
(66.249.81.x / 74.125.208.x). Ebből **1496 (61%)** egyetlen végpontra: az
`/api/v1/active-runs` 5 másodperces poll-frissítőre. Valódi végfelhasználói forgalom a
mintában nem azonosítható. Nincs `robots.txt` (404), így a bot a 404-et „szabad a
pálya"-ként érti, és nemcsak beolvassa az oldalakat, hanem lefuttatja a kliens-JS-t is
(a poll-hurkokat, sőt chat-server-action POST-okat).

**Adatszivárgás nincs** — bejelentkezés nélkül a védett végpontok 404/500-at adnak,
adat nélkül; a Clerk-kapu a helyén van. A kár nem kitettség, hanem: (1) a monitoring
vakká válik a robot-zajtól, (2) a `#406`/`#415` teljesítmény-munka mérőszámait a bot
5 mp-es pollja felfújja, (3) egy belső enterprise control-plane-t folyamatosan
végigjár a Google.

**Ág: B.** Draft PR nyitva (49 sor, 3 fájl): `robots.txt` = `Disallow: /` alapból,
`ALLOW_SEARCH_INDEXING=true`-val visszakapcsolható.

---

## 1. Mit ellenőriztem — és mivel

Hitelesítés: a dedikált csak-olvasó service account
(`eai-healthcheck-runner@enterprise-ai-demo.iam.gserviceaccount.com`, kulcs a
`~/.config/eai-healthcheck/`-ben) **működik** — a tegnapi riport #1 találata (lejárt
`gcloud` user-token) azóta megoldva, a wizard (`ops/tools/setup-healthcheck-access.sh`)
lefutott. A `logging.read` / `run.*.list` / `monitoring` mind elérhető ezzel az
identitással.

| Terület | Forrás (parancs) | Eredmény |
|---|---|---|
| App-hibák 24h | `gcloud logging read 'severity>=ERROR AND resource.labels.service_name="enterprise-ai-agent-platform" AND timestamp>="2026-09-02T06:00:00Z"'` | **0 találat** |
| WARNING+ 7d | `severity>=WARNING`, 7d | 150 sor, ~mind `404` (`/api/v1/active-runs`, `/control-plane/agents/<id>/chat?panel=agent.new`, `/favicon.ico`) — lásd §2 |
| stderr 7d | `logName:"run.googleapis.com%2Fstderr"` | csak `Failed to find Server Action "<hash>"` sorok — elavult kliens-bundle a 09-02 18:42-es deploy után; **kizárólag a `Google` UA-tól** |
| Összes kérés 24h | `httpRequest.requestMethod!="" AND timestamp>="2026-09-02T06:00:00Z"` → `value(userAgent,remoteIp,requestMethod,requestUrl)` | **2462 kérés, 100% `Google` UA**, 66.249.81.x + 74.125.208.x |
| Poll-ütem | `httpRequest.requestUrl:"/api/v1/active-runs"` timestamp-lista, 05:55–06:03 UTC | **pontosan 5,00 mp-enként, megszakítás nélkül** (automata kliens, nem ember) |
| Napi kérésszám 8d | `value(timestamp)` \| `cut -c1-10 \| uniq -c` | 1736 / 2145 / 978 / 1755 / 3911 / (09-01: 0) / 2223 / 254 — hetek óta ugyanez a robot az egyetlen forgalom |
| Cloud Run gépidő | `monitoring timeSeries` `run.googleapis.com/container/billable_instance_time`, 1d bucket, 8d | aktív napokon ~900–1700 mp/nap összegezve; üres napokon 0 (scale-to-zero) |
| Cloud Run ingress / IAM | `gcloud run services describe` | `ingress=all`, `maxScale=20`; IAM-policy üres (`etag: ACAB`) |
| Uptime-check | `gcloud monitoring uptime list-configs` | **0 db** — a poll nem hivatalos szonda |
| Deploy-történet | `gcloud run revisions list` | utolsó sikeres build 2026-09-02 18:41; nincs bukott rollout |
| Bejelentkezés nélküli hozzáférés | `curl -A Googlebot https://…hosted.app/{api/v1/active-runs, api/agents/rail-state, embed/control-plane/agent.new}` | `404` / `404` / `500` — **adat nélkül**; a `<meta name="robots" content="noindex">` is ott van az 500-as oldalon |
| Auth-kód | `middleware.ts`, `api-tenant-auth.ts`, `tenant-context.ts`, `clerk-config.ts` | a `/api/…` végpontok `requireTenantApiUser` mögött; a middleware `/embed/control-plane/*`-ot rewrite-olja `auth.protect()` ELŐTT, de a cél-oldal szerveroldalon így is elhasal auth nélkül → nincs rés |

### Nem vizsgált területek (tényként, becslés nélkül)
- **Teljes GCP-számla SKU-bontással** — nincs BigQuery billing-export a rutin
  hitelesítésével. A compute/egress számok a Monitoring/Logging nyers adatból jönnek.
- **LLM-token / modell-hívás költség** — a prod `model_calls` tábla nem elérhető
  (prod DB a rutin elől el van zárva).
- **Neon prod slow-query / hiányzó index / full scan** — prod DB nem elérhető. A
  `pg_stat_statements` a tegnapi wizard óta elvileg bekapcsolható, de a prod DB-t a
  rutin nem éri el, hogy ellenőrizze.
- **Clerk / auth hibaráta** — nincs Clerk API-kulcs a futtató környezetben (a
  kódból és a 404/500 viselkedésből annyi látszik, hogy a kapu zár).
- **Firestore** — a platform Postgresben tárol, Firestore-metrika nincs (mint tegnap).

---

## 2. Aggregált megfigyelések (24h, útvonal / minta szerint)

### 2.1 A forgalom teljes egésze: Google-crawler
`2462 kérés / 24h`, mind `Google` UA, 66.249.81.x (Googlebot) + 74.125.208.x (Google
infra) tartományból. Útvonalra bontva:

| Kérések | Metódus/kód | Útvonal | Átl. válaszméret |
|--:|---|---|--:|
| 1496 | GET 200 | `/api/v1/active-runs` | 30 335 B |
| 507  | POST 200 | `/control-plane/agents/<id>/chat` (`panel=agent.new`) | 600 B |
| 382  | GET 200 | `/api/agents/rail-state` | 77 322 B |
| 28   | POST 404 | `/control-plane/agents/<id>/chat` | — (Server Action mismatch) |
| 16   | GET 404 | `/api/v1/active-runs` | — |
| 10   | GET 404 | `/favicon.ico` | — |
| ~7   | egyéb | `/embed/control-plane/agent.new`, `/control-plane/agents/new`, … | — |

A `referer` a kéréseknél `https://enterprise-ai-agent-platform--enterprise-ai-demo.europe-west4.hosted.app/control-plane/agents/<id>/chat?panel=agent.new`
— tehát a Google renderelője ténylegesen **rendereli és „nyitva tartja" a chat-oldalt**,
és közben a kliens 5 mp-es `active-runs` pollja + a `rail-state` frissítő lefut. A
sikeres (200) válaszok arra utalnak, hogy a renderelő valamilyen munkamenet-kontextussal
fut; bejelentkezés nélküli próbám ugyanezekre 404/500-at kapott, adat nélkül.

**Erőforrás-hatás (a számítás):**
`1496 × 30 335 B + 382 × 77 322 B ≈ 45,4 MB + 29,5 MB ≈ 75 MB kimenő adat / 24h`,
teljes egészében egy botnak. Cloud Run gépidő aktív napokon ~1700 mp ≈
`1700 s × ~0,0000265 EUR/s ≈ 0,045 EUR/nap ≈ ~1,4 EUR/hó` (1 vCPU + 1 GiB,
europe-west4 lista-ár). Egress néhány cent/hó. **Közvetlen pénzügyi tét ~1–2 EUR/hó —
kicsi.** A valódi kár a §TL;DR (1)-(3).

### 2.2 „Failed to find Server Action" — 28 db / 24h (baseline 8 / 7 nap)
A 2026-09-02 18:42-es deploy után a **robot** még a régi kód-csomag akció-hash-ével
(`40a63c74…`) próbál űrlapot beküldeni → 404. `severity` üres (ezért nem látszik az
`ERROR`-szűrőn). **Emberi felhasználót nem érint** (a 28 POST mind a `Google` UA-tól).
A crawl leállásával magától elmúlik; külön javítást most nem indokol. Ha valaha
emberi session-öknél is előjön, önálló jegy: Next.js verzió-eltérés (`version skew`)
kezelése a kliensen.

### 2.3 404-zaj
`/favicon.ico` (10/24h) + elavult RSC-prefetch — kozmetikai, mint tegnap. A
`robots.txt` bevezetése után a `favicon` külön `app/icon` fájllal egy jövőbeli
takarításban rendezhető, önálló PR-t nem ér.

---

## 3. Rangsor (prioritás = üzleti hatás × gyakoriság ÷ javítási kockázat)

| # | Találat | Hatás | Gyak. | Kock. | Pont | Megjegyzés |
|---|---|---|---|---|---|---|
| 1 | **Nincs `robots.txt` → a Google a teljes forgalmat adja, vak a monitoring, felfújt perf-metrika** | 3 | 5 | 1 | **15,0** | → **B ág, PR #420** |
| 2 | Robot 5 mp-es `active-runs` pollja melegen tartja a Cloud Run konténert (defeat scale-to-zero aktív ablakokban) | 2 | 4 | 2 | 4,0 | Az #1 javítása ezt is megszünteti (nincs, aki pollozzon). Kliensoldalon részben `#415` (nyitva). |
| 3 | „Failed to find Server Action" 28/24h a robottól | 1 | 3 | 2 | 1,5 | §2.2 — a crawl leállásával elmúlik; nem emberi. |
| 4 | `/embed/control-plane/*` a middleware-ben `auth.protect()` ELŐTT rewrite-olódik | 2 | 1 | 3 | 0,7 | Ma nincs rés (a cél-oldal auth nélkül 500-at ad). Törékeny minta — ha valaha lesz „publikus embed" mód, könnyen 200+adat lehet belőle. Figyelendő, nem sürgős. |
| 5 | `favicon.ico` 404-zaj | 1 | 2 | 1 | 2,0 | Kozmetikai. |

A legmagasabb tétel (#1) valós, folyamatos, és <50 soros, kapcsoló mögé tett,
egy lépésben visszaállítható diffel megoldható → **B ág.**

---

## 4. A PR (#420) — összefoglaló

- `app/src/app/robots.ts` (új): alapból `Disallow: /`; `ALLOW_SEARCH_INDEXING=true`
  env → `Allow: /` (runtime-ban kiértékelt dinamikus route, build nélkül hat).
- `app/src/lib/auth/public-routes.ts`: `/robots.txt` + `/sitemap.xml` a Clerk-kaput
  megkerülő listára (különben `auth.protect()` 404 → a Google „szabad a pálya").
- `app/scripts/public-routes.test.ts`: a két új publikus minta + szűkösség-ellenőrzés.
  **Teszt: 8/8 zöld** (`npx tsx scripts/public-routes.test.ts`). ESLint + `tsc --noEmit`
  a három fájlra: tiszta.

**Repro a robots.txt-tartalomra** (dev szerver, mert a `robots.ts` kimenete
egységteszttel nem fedhető közvetlenül):
```bash
cd app && npm run dev            # :3001
curl -s localhost:3001/robots.txt
#   Elvárt:  User-Agent: *\nDisallow: /
ALLOW_SEARCH_INDEXING=true npm run dev
curl -s localhost:3001/robots.txt
#   Elvárt:  User-Agent: *\nAllow: /
```

**Visszaállítás:** env `ALLOW_SEARCH_INDEXING=true`, vagy a PR revert / `robots.ts`
törlés → a jelenlegi „nincs robots.txt" állapot.

**⚠️ Negatív következmény:** a platform kikerül a Google-indexből (szándékos, belső
eszköz). A „Failed to find Server Action" 404-eket **nem** ez javítja (§2.2).

---

## 5. Hogyan mérjük 7 nap múlva

```bash
SA="eai-healthcheck-runner@enterprise-ai-demo.iam.gserviceaccount.com"
B="https://enterprise-ai-agent-platform--enterprise-ai-demo.europe-west4.hosted.app"

# 1. robots.txt él és tilt
curl -s "$B/robots.txt"          # Elvárt: User-Agent: *  Disallow: /

# 2. a "Google" UA forgalom lecsökkent (24h)
SINCE=$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)
gcloud logging read 'resource.labels.service_name="enterprise-ai-agent-platform"
  AND httpRequest.userAgent="Google" AND timestamp>="'"$SINCE"'"' \
  --account "$SA" --project enterprise-ai-demo --freshness=2d --format='value(timestamp)' | wc -l
# Most: ~1500-2500 / 24h.  Elvárt 2026-09-10-re: < 100.

# 3. az active-runs poll abszolút hívásszáma 24h alatt
gcloud logging read 'resource.labels.service_name="enterprise-ai-agent-platform"
  AND httpRequest.requestUrl:"/api/v1/active-runs" AND timestamp>="'"$SINCE"'"' \
  --account "$SA" --project enterprise-ai-demo --freshness=2d --format='value(timestamp)' | wc -l
# Most: ~1500 / 24h.  Elvárt: nagyságrendekkel kevesebb.
```

Ha a „Google" forgalom 7 nap múlva **nem** < 100/24h: vagy nem szabálykövető bot
(→ Cloud Armor / IP-blokk kell), vagy a `robots.txt` nem szolgálódik ki (1. csekk).

---

## 6. Megjegyzés a verziókövetéshez
A futás pillanatában a fő munkafa egy **másik, párhuzamosan dolgozó session** alatt állt
(`fix/recipe-tenant-scope` ág, ~7 módosított + 3 új fájl, nem kapcsolódik ehhez). A
PR-t ezért **`origin/main`-ből nyitott izolált worktree-ben** készítettem
(`ops/robots-crawler-block`), így #420 diffje tisztán a 3 saját fájl. Ez a riport és a
napló-sor ugyanígy `origin/main`-alapú ágon megy (`ops/health-check-2026-09-03`).

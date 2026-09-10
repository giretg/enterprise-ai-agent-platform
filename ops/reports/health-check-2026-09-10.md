# Napi health-check riport — 2026-09-10

**Ág: B** — valós, ~200 sornál kisebb diffben megoldható probléma → **draft PR [#449](https://github.com/giretg/enterprise-ai-agent-platform/pull/449)**.

Futtató: `eai-healthcheck-runner@` SA (csak olvasó). Projekt: `enterprise-ai-demo`.
Időablak: utolsó 24 óra (2026-09-09 ~12:00 UTC → 2026-09-10 ~12:00 UTC). Alap: előző 7 nap.

---

## 0. Amit már tudunk (napló utolsó sorai)

| Dátum | Top | Ág | Státusz |
|-------|-----|----|---------|
| 09-02 | Nincs érdemi találat (0 kérés) | D | lezárva |
| 09-05 | #426 regresszió-ellenőrzés | D | nyitva #426 alatt |
| 09-06 | #426 „Googlebot-flotta" — 6467–28932 kérés/nap | A | nyitva |
| 09-07 | Cloud Run OOM párhuzamos agent-chat alatt | B | PR #437 **MERGED** 09-07 |

Nem javaslom újra: #437 (OOM, mergelve), PR #415 (active-runs dupla-poll, **nyitva**), #426 (Clerk dev-instance, **nyitva, Urgent**).

---

## 1. Adatgyűjtés (kizárólag `gcloud logging read`, olvasás)

### 1.1 Hibák

```
gcloud logging read 'severity>=ERROR AND timestamp>="2026-09-09T00:00:00Z"' \
  --project=enterprise-ai-demo --freshness=25h --limit=200
```
→ **0 találat.** 24 órában egyetlen `ERROR`+ szintű logsor sincs.

### 1.2 HTTP-státuszok (Cloud Run origin, utolsó 24h)

```
gcloud logging read 'resource.type="cloud_run_revision" AND httpRequest.requestMethod!="" AND timestamp>="2026-09-09T12:00:00Z"' \
  --project=enterprise-ai-demo --freshness=25h --limit=5000 --format='value(httpRequest.status)'
```

| Státusz | Darab |
|---------|-------|
| 200 | ~2740 |
| 404 | 13 |
| 307 | 6 |
| 401 | 2 |
| **Összes kérés** | **2782** |

**0 db 5xx.** A 2 db 401 a `/api/v1/agent-chat/turns?...&active=1` végponton, ugyanabból a beszélgetésből — átmeneti token-lejárat, nem hibaminta.

### 1.3 Forgalom végpont szerint (utolsó 24h)

```
... --format='value(httpRequest.requestUrl)' | sed -E 's/\?.*//' | sort | uniq -c | sort -rn
```

| Végpont-minta | Kérés / 24h | Arány |
|---------------|-------------|-------|
| `/api/v1/agent-chat/turns` | **1304** | **47%** |
| `/control-plane/agents/:id/chat` | 460 | 17% |
| `/api/v1/active-runs` | 435 | 16% |
| `/api/agents/rail-state` | 276 | 10% |
| minden más | ~307 | 11% |

### 1.4 Ki generálja a forgalmat — CDN-él napló (a valódi UA itt látszik)

```
gcloud logging read 'resource.type="firebaseapphosting.googleapis.com/Backend" AND httpRequest.requestMethod!="" AND timestamp>="2026-09-09T12:00:00Z"' \
  --project=enterprise-ai-demo --freshness=25h --limit=20000 --format='value(httpRequest.remoteIp,httpRequest.userAgent)'
```

| Kliens IP | Kérés / 24h | User-Agent |
|-----------|-------------|------------|
| `188.142.148.49` | 1698 | Chrome 152 / macOS (+ Android mobil) |
| `81.183.203.131` | 1085 | Chrome 151 / Windows |

**Két valódi böngésző-kliens. Nulla bot-UA a CDN-élen.** Magyar lakossági IP-tartományok — jelen incidensben ez az operátor(ok) tényleges platform-használata.

### 1.5 Cloud Run instance-viselkedés

`Starting new instance. Reason: AUTOSCALING` — 09-09-én több hullámban (14:03, 14:26, 15:07, 15:42, 18:35 UTC), hullámonként 2–5 instance. A scale-to-zero backendet a `/api/v1/agent-chat/turns` poll-hullámok ébresztik és skálázzák.

### 1.6 Nem vizsgált területek (forrás nem elérhető)

- **Billing / SKU-költség:** nincs BigQuery billing-export (`bq ls` üres). Forint-hatás nem számolható.
- **Neon slow-query log / hiányzó index:** a `pg_stat_statements` a 09-02-i riport szerint sem volt bekapcsolva; a health-check SA-nak nincs DB-hozzáférése. Nem vizsgált.
- **Clerk auth hibaráta:** külön Clerk-dashboard/API nélkül csak a 2 db `401` a jel — elhanyagolható.
- `firebase functions:log`: a platform App Hosting (Cloud Run), nincsenek külön Cloud Functions.

---

## 2. Aggregált csoportok

| Csoport | 24h | Eltérés a 7 napos képhez | Érintett | Erőforrás-hatás |
|---------|-----|--------------------------|----------|-----------------|
| `GET /api/v1/agent-chat/turns` kliens-poll | 1304 | a forgalom domináns tétele, konzisztens | 2 user | kérésenként Clerk-auth + 2 Neon-query; ~750 ms közökkel egy aktív forduló teljes hosszában |
| `active-runs` dupla-poll | 435 | változatlan — **PR #415 nyitva fedi** | 2 user | rail-state-tel átfedő |
| Hibák (`5xx`, `ERROR`-log) | 0 | 0 (↔ 09-06/09-07: akkor OOM volt) | — | — |
| „Googlebot-flotta" | **0** | **eltűnt / soha nem is bot volt** (l. 4. pont) | — | — |

### Poll-ütem bizonyíték (egy forduló, 09-09 18:40:36 → 18:41:19)

```
18:40:36.4  /api/v1/agent-chat/turns
18:40:37.1  /api/v1/agent-chat/turns
18:40:38.1  /api/v1/agent-chat/turns
...  (43 mp alatt ~57 kérés, ~750 ms közökkel)
18:41:11.0  /api/v1/agent-chat/turns/<id>/stream   ← az élő SSE-stream EKKOR IS nyitva
18:41:19.1  /api/v1/agent-chat/turns
```

---

## 3. Rangsor (prioritás = üzleti hatás × gyakoriság ÷ javítási kockázat)

| # | Találat | ÜH | Gyak | Kock | Pont |
|---|---------|----|----|------|------|
| 1 | **`/api/v1/agent-chat/turns` kliens életjel-poll 750 ms-enként** — az origin-forgalom 47%-a, redundáns az élő streammel; fölös Cloud Run + Neon terhelés, autoscaling-ébresztés | 3 | 5 | 1 | **15** |
| 2 | `active-runs` dupla-poll (16%) — **már van rá PR #415, nyitva** | 3 | 4 | 1 | (kihagyva: tracked) |
| 3 | #426 Clerk = development instance — a munkamenet az URL-ben utazik (`__clerk_handshake`); valós misconfiguráció, de a „Googlebot visszajátssza" súlyosbítás ma **nem igazolható** (l. 4.) | 4 | 2 | — emberi | (kihagyva: #426 Urgent nyitva) |
| 4 | `rail-state` poll (10%) — PR #406 mergelve, szándék szerint működik | 2 | 3 | 1 | 6 |
| 5 | 404-ek (13/24h) — szórvány, nincs minta | 1 | 1 | 1 | 1 |

**Mélységben csak az #1-gyel foglalkozom.**

---

## 4. ⚠️ Fontos korrekció a korábbi riportokhoz — a „Googlebot-flotta" félrediagnózis volt

A 09-05 / 09-06 / 09-07 riportok „~100% `Google` UA, 0 valódi user, 14 981–28 932 kérés Googlebottól" következtetése a **Cloud Run origin-naplóból** származott, ahol az UA **minden** kérésnél egységesen `Google` — ez a **Firebase App Hosting CDN / Google-frontend origin-lekérésének** UA-ja, nem a Googleboté. Ezt a csapdát a kódban a `src/lib/security/crawler-block.ts` #436-os kommentje szó szerint dokumentálja („a csupasz `Google` UA NEM a Googlebot… MINDEN valódi felhasználói kérésnél is ezt látja az origin").

A mai kereszt-ellenőrzés a **CDN-él naplójából** (ahol a valódi kliens-UA látszik):

- Utolsó 24h: **2 valódi böngésző** (Chrome/macOS `188.142.148.49`, Chrome/Windows `81.183.203.131`), 0 bot-UA.
- A `__clerk_handshake`-et tartalmazó URL-eket az utolsó 36h-ban **ugyanaz a valódi user-IP** kérte (`188.142.148.49`, Chrome macOS + Android), mind `307` átirányítás — ez a Clerk dev-instance normál, bejelentkezett emberi cross-subdomain handshake-folyamata, **nem** bot-visszajátszás.

**Mit jelent ez #426-ra:**
- A gyökér-ok (**prod Clerk = development instance**, `pk_test_`) **valós misconfiguráció marad** — a munkamenet-token URL-ben utazása önmagában kockázat (referer-szivárgás, napló, váll fölötti betekintés), és a prod instance + `sk_live` átállás továbbra is indokolt emberi teendő.
- DE: a #426 „🔴 AZONNALI" súlyosságát adó állítás — „a Googlebot beindexelte és **visszajátssza**, authentikáltan bejárja a control-plane-t, **`POST`-ol** agent-futásokat indítva" — **ebben a 24–36 órás ablakban nem áll**: a control-plane-forgalom (a `POST`-okat is beleértve) a 2 valódi operátor-böngészőé.
- **Javaslat #426-hoz:** a súlyosság vizsgálandó felül (az él, hogy prod = dev instance, önmagában `security`, de nem feltétlenül `Urgent` / „adatszivárgás folyamatban"). A crawl-alapú bizonyítékokat a CDN-él naplójából kell újraellenőrizni, nem az origin-UA-ból. A napi riport a 09-05 óta tévesen erősítette a botnarratívát.

Ezt a riport **nem** viszi külön issue-ba (a #426 nyitva van); a korrekció kommentként a #426-ra való.

---

## 5. Választott kimenet — Ág B, PR [#449](https://github.com/giretg/enterprise-ai-agent-platform/pull/449) (draft)

**Probléma:** a `useAgentChatTurnLiveness` hook (`app/src/components/agents/use-agent-chat-turn-liveness.ts`) a **szerver-oldali DB-figyelés** 750 ms-es konstansát (`AGENT_TURN_RECONNECT_POLL_DEFAULT_MS`) használta a **böngészőből** indított HTTP-poll `setInterval`-jének. Így minden aktív fordulónál, annak teljes hosszában, ~1,3 kérés/mp megy a `GET /api/v1/agent-chat/turns` végpontra — az élő SSE-stream **mellett**, ugyanazt a részszöveget/lépéslistát lekérve.

**Fix (3 fájl, +42 / −5):**
- Új, dokumentált konstans: `AGENT_TURN_LIVENESS_POLL_DEFAULT_MS = 5000` + `resolveLivenessPollMs()` a `agent-turn-reconnect.ts`-ben (a poll-konfig már ott lakik).
- A hook ezt használja a `setInterval`-hez.
- Build-időben beégő env-felülírás: `NEXT_PUBLIC_AGENT_TURN_LIVENESS_POLL_MS`.
- Teszt: `scripts/agent-turn-reconnect.test.ts` +2 eset (alapérték 5 s és ≠ DB-kadencia; env-parse). `npm run test:agent-turn-reconnect` zöld. `eslint` + `tsc` tiszta a 3 fájlra (a `tsc` egy előzetes, nem-hozzám tartozó hibát jelez a `scheduled-task-enterprise.test.ts`-ben — piszkos working tree, nem része a PR-nek).

**Visszaállítás:** commit-revert, vagy `NEXT_PUBLIC_AGENT_TURN_LIVENESS_POLL_MS=750` + újra-deploy.

**Negatív hatás:** stream-szakadás utáni helyreállás és az „elakadt" jelzés max. ~4 s-mal későbbi (750 ms → 5 s mintavétel). Adat-/pontosságvesztés nincs: a végleges válasz forrása a perzisztált forduló-rekord + a stream.

**Hogyan mérjük 7 nap múlva:**
```
gcloud logging read 'resource.type="cloud_run_revision" AND httpRequest.requestMethod!="" AND timestamp>="<-24h>"' \
  --project=enterprise-ai-demo --freshness=25h --limit=5000 \
  --format='value(httpRequest.requestUrl)' | sed -E 's/\?.*//' | sort | uniq -c | sort -rn | head -10
```
Elvárás: `/api/v1/agent-chat/turns` a forgalom ~47%-áról a ~10% tartományba esik változatlan használat mellett (6,7× ritkább poll). Kiegészítő: egy futó forduló poll-közei ~5 s-ra nyílnak (ne ~750 ms).

**Amit el kell döntened:** jó-e a kliens életjel-poll 5 másodperces alapértéke (az élő stream mellett, csak backstop szerepre), tudva hogy stream-szakadás után a helyreállás max. ~4 s-mal lassabb? — **igen / nem**

---

## 6. Egyéb megfigyelések (nem igényelnek teendőt ma)

- **0 hiba, 0 `5xx`** 24h-ban — a 09-06/09-07-i OOM (PR #437) óta nem tért vissza. A `apphosting.yaml` `concurrency 40→10` / `memoryMiB 1024→2048` hatásosnak tűnik, de alacsony a terhelés — a valódi teszt egy párhuzamos több-user session lesz.
- Napi kérésszám (CDN-él): 09-04: 149 · 09-05: 6464 · 09-06: 6852 · 09-07: 11 209 · 09-08: **28 932** · 09-09: 6648. A 09-08-i csúcs 2 valódi user intenzív használata (nem bot); a `/api/v1/agent-chat/turns` poll a szorzó — a PR #449 ezt a csúcsot is ~6,7×-esére lapítja.

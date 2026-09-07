# Napi health-check riport — Enterprise AI Agent Platform
**Dátum:** 2026-09-07 · **Szerep:** SRE + FinOps · **Ág:** **B — valós probléma, <200 soros diff** · **REGRESSZIÓ**

## Egy mondatban
Amikor a platformot 2026-09-06 délelőtt először használták valódi, párhuzamos
agent-chat terheléssel (mobil böngésző-session + inline HTML-riport előnézetek), a
Cloud Run instance ~20 perc alatt **47×** túllépte az 1 GiB memórialimitet és
OOM-killelődött, a kliens **42 kérésre `500`/`503` hibát** kapott — és ez **ugyanaz
a hiba, amit a `e1a92700` commit már „megjavított"** (512→1024 MiB, concurrency
80→40), csak most a magasabb küszöbön tért vissza.

## 1. Mi történik most (kódra hivatkozás nélkül)

A deployolt alkalmazás egyetlen konténerpéldánya egyszerre **40 beérkező kérést**
próbál kiszolgálni **1 processzormagon és 1 GiB memórián**. Az agent-chat kérések
hosszú életűek (a válasz folyamatosan „csordogál" a böngészőbe, amíg a modell
gépel), és amíg élnek, memóriát tartanak. Emellé jött 09-06-án több **inline
HTML-riport előnézet**: ezeknél a szerver a teljes fájlt beolvassa a memóriába,
majd szövegként még 2–3 példányban átalakítja, mielőtt visszaküldi.

Néhány párhuzamos chat-stream + néhány riport-előnézet együtt átvitte a memóriát
1 GiB fölé. A Cloud Run ilyenkor **kilövi az egész konténert** — a benne éppen
futó összes többi kérés is megszakad, „malformed response" hibával. Új konténer
indul (hidegindítás), és ha a terhelés kitart, néhány másodperc múlva újra
kilövődik. 09-06 10:06–10:25 UTC között ez a ciklus **47×** ismétlődött.

Extra tényező: a kilövés pillanatában **csak 1 instance** futott (a felső korlát
10), tehát a `maxInstances` tartaléka kihasználatlan maradt — mert a `concurrency:
40` mellett az autoscaler egy gépre pakolta a terhelést, ahelyett hogy szétterítette
volna.

### Bizonyíték (anonimizált, forrással)

Auth: dedikált `eai-healthcheck-runner@…` service account
(`~/.config/eai-healthcheck/gcp-runner-key.json`).

| Tény | Érték | Forrás |
|---|---|---|
| `severity>=ERROR` 24h | **48** (mind 09-06) | `gcloud logging read 'severity>=ERROR' --freshness=1d` |
| `severity>=ERROR` 7d | 52 (48× 09-06 + 4× 09-03 régi tranziens) | `--freshness=7d` |
| Kliens-oldali `5xx` 7d | **42× 09-06** (+ 4× 09-03) | `httpRequest.status>=500 --freshness=7d` |
| Hibaüzenet-minták 24h | 21× „container instance … using too much memory … terminated", 17× „HTTP response was malformed", 5× „Memory limit of 1024 MiB exceeded with 1026–1037 MiB used" | `value(textPayload)` első 80 karakter szerint csoportosítva |
| Hiba-időablak | 09-06 **10:06:33 → 10:25:26 UTC** (+1 magányos 06:05) | összes 52 timestamp rendezve |
| Percenkénti eloszlás | 10:06→15, 10:07→10, 10:10→10, 10:11→3, 10:25→9 | timestamp perc-hisztogram |
| Az ablakban kiszolgált kérések | `POST …/agents/<id>/chat`, `POST …/agent-chat/stream`, `GET …/workspace/files?path=…COMPANY_S15_1.html&disposition=inline` (ismétlődő), `GET /api/agents/rail-state`, `GET /api/v1/active-runs` | `httpRequest` szűrés 09-06 09:50–10:30 |
| Kliens user-agent | valódi **Android Chrome Mobile** a `…hosted.app` hoszton (nem „Google" bot) | ugyanaz a lekérdezés; l. 09-06 „Mobil jav és párhuzamos chat" commit |
| Instance-szám az incidens alatt | **~1** (max 10) | `monitoring … container/instance_count` ALIGN_MEAN 300s |
| 09-06 óránkénti kérésszám | 06h→2332, 07h→4908, 08h→3566, 09h→1032, **10h→1588**, 14h→50, 15h→221 | `httpRequest` timestamp óra-hisztogram |
| Előző javítási kísérlet | `e1a92700` — „double memory to 1 GiB with lower concurrency so agent chat no longer OOM-kills instances": `memoryMiB 512→1024`, `concurrency 80→40` | `git show e1a927006 -- apphosting.yaml` |

**Miért regresszió:** a `e1a92700` explicit célja az volt, hogy „az agent-chat ne
öljön OOM-mal instance-t". 09-06-án pontosan ez történt újra, csak az 1 GiB-es
küszöbön. A hiba nem 07h/08h csúcsán jött (7000+ kérés, 0 hiba), hanem a
párhuzamos chat + HTML-előnézet mixnél 10h-kor — tehát nem nyers kérésszám,
hanem **egyidejű, memória-nehéz kérés/instance** a kiváltó.

## 2. Mi változik a javítás után

- `concurrency: 40 → 10` — egy instance legfeljebb 10 kérést tart egyszerre; a
  Cloud Run autoscaler a többit **új instance-ekre teríti** (max 10 instance →
  platform-szintű plafon 100 egyidejű kérés, a jelenlegi ~0 valós forgalomhoz
  bőven elég, és a #436 crawler-blokk után a bot-forgalom is elesik).
- `memoryMiB: 1024 → 2048` — a maradék, kevésbé párhuzamos csúcsokra ~2–4×
  fejtér a 09-06-i kilövési ponthoz képest.
- Csak a két `apphosting.yaml` (repo-gyök + `app/`) `runConfig` blokkja változik.
  Kód nem.

## 3. Számszerű hatás

- **Jelenleg:** 1 rossz 20 perces ablak → 42 kliens-hiba, 47 OOM-kill, ~9
  fölösleges hidegindítás. Forrás: §1 táblázat.
- **Várható:** a párhuzamos chat + előnézet mix elfér 10 kérés/instance × 2 GiB
  mellett; az OOM-kill és a hozzá tartozó `5xx` **0-ra** megy a normál használati
  mintán.
- **Költség:** `minInstances: 0` marad → tétlen költség **0 Ft** (nem változik).
  Aktív kiszolgálás alatt a memória-GiB-másodperc kb. 2×, de csak amíg ténylegesen
  forgalom van; a jelenlegi napi instance-idő (előző riportok: napi ~130–1700 s,
  Cloud Run ingyenkeret 180 000 vCPU-s/hó + 360 000 GiB-s/hó) mellett a
  növekmény **elhanyagolható, gyakorlatilag 0 Ft/hó**. Pontos SKU-bontás nincs
  (nincs BigQuery billing-export), de a nagyságrend a monitoring instance-időből
  levezethető.
- **Nem becsülhető megbízhatóan:** hogy a párhuzamos chat-replay indított-e valós
  Anthropic/OpenRouter modell-költséget (a prod `model_calls` tábla nem elérhető).

## 4. Felhasználói hatás

Erős vagy párhuzamos használatnál (több chat egyszerre, nagy riport megnyitása)
a felhasználó eddig „a szerver megszakította a választ" / féloldalasan betöltött
oldalt látott. A javítás után a rendszer több kis konténerre osztja a terhelést,
és a válaszok végigfutnak. Lassabb hidegindítás előfordulhat több instance-nél,
de ez másodperces nagyságrend, nem hibás válasz.

## ⚠️ Negatív következmények / funkcióvesztés

- **Egyidejű kérés-plafon 100-ra csökken** (10 instance × 10). A jelenlegi
  forgalom (valós user ~0, csúcs ~40 egyidejű a bot-viharban) alatt marad; ha a
  platform valaha 100 fölé megy egyidejűleg, a `maxInstances`-t kell emelni.
- **Több hidegindítás:** kisebb `concurrency` → az autoscaler hamarabb indít új,
  hideg instance-t. Néhány kérés lassabb lehet (nem hibás).
- **Nem oldja meg a gyökérokot:** a `workspace/files` route továbbra is teljes
  fájlt bufferel memóriába, és az agent-runtime még mindig az UI Cloud Run
  szolgáltatáson osztozik. Ez a **harmadik** hangolás ugyanezen a tüneten
  (512/80 → 1024/40 → 2048/10). A tartós javítás architekturális: az
  agent-runtime/diszpécser leválasztása az UI-ról (l. lezárt #114). Ezt **nem**
  ebben a PR-ban — külön döntést igényel (becslés: 1–3 fejlesztői nap).

## 5. Kockázat és visszaállítás

- **Kockázat:** minimális — csak deploy-idejű Cloud Run paraméter. Ha valamiért
  rosszabb lesz (pl. túl sok hidegindítás), egy lépésben visszaáll.
- **Visszaállítás:** a két `apphosting.yaml`-ban `memoryMiB: 1024` és
  `concurrency: 40`, majd deploy (vagy a commit revertje). Effektíve az előző
  App Hosting rollout.
- **Teszt:** infrastruktúra-config, nincs unit-teszt. Reprodukció: a deployolt
  appon 3–4 agent-chatet párhuzamosan indítva + egy nagy (`>1 MB`) HTML
  workspace-fájlt `?disposition=inline`-nal többször megnyitva a régi
  beállításon `503` + OOM-log jött (09-06 10:06–10:25). A javítás után ugyanez
  a minta ne adjon `5xx`-et.

## 6. Hogyan mérjük 7 nap múlva

```bash
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/eai-healthcheck/gcp-runner-key.json"
P="--project=enterprise-ai-demo"

# (a) OOM / memória-kill logsorok az elmúlt 7 napban — VÁRT: 0
gcloud logging read 'severity>=ERROR AND (textPayload:"Memory limit" OR textPayload:"using too much memory")' \
  --freshness=7d $P --format="value(timestamp,textPayload)" --limit=200 | wc -l

# (b) kliens-oldali 5xx az elmúlt 7 napban, napi bontás — VÁRT: ~0
gcloud logging read 'httpRequest.status>=500' --freshness=7d $P \
  --format="value(timestamp)" --limit=5000 | cut -dT -f1 | sort | uniq -c

# (c) egyidejű instance-szám csúcs (terítődik-e a terhelés?) — VÁRT: >1 forgalom alatt
ACCESS=$(gcloud auth print-access-token)
curl -s -H "Authorization: Bearer $ACCESS" \
 "https://monitoring.googleapis.com/v3/projects/enterprise-ai-demo/timeSeries?filter=metric.type%3D%22run.googleapis.com%2Fcontainer%2Finstance_count%22&interval.startTime=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)&interval.endTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)&aggregation.alignmentPeriod=3600s&aggregation.perSeriesAligner=ALIGN_MAX&aggregation.crossSeriesReducer=REDUCE_SUM" \
 | python3 -c "import sys,json;d=json.load(sys.stdin);print(max((p['value'].get('doubleValue',0) for ts in d.get('timeSeries',[]) for p in ts['points']), default=0))"
```

**Sikerkritérium:** (a) = 0 és (b) minden napon ~0. Ha 7 nap múlva is van
OOM-kill valós használat mellett, az architekturális szétválasztás (#114) nem
halasztható tovább — eszkaláció.

## 7. Amit ellenőriztem — és mivel

| Terület | Forrás | Eredmény |
|---|---|---|
| App-hiba `severity>=ERROR` 24h / 7d | `gcloud logging read` | 48 / 52 — **mind 09-06 OOM**, 1 magányos 06:05 |
| Kliens `5xx` 7d | `httpRequest.status>=500` | 42× 09-06, 4× 09-03 (régi) |
| Hiba-minta csoportosítás | `value(textPayload)` uniq -c | OOM-kill / malformed-response / memory-limit — mind ugyanaz az esemény |
| Kérés-korreláció | `httpRequest` 09-06 09:50–10:30 | párhuzamos chat-stream + ismétlődő inline HTML-előnézet |
| Instance-szám | `monitoring container/instance_count` | ~1 az incidens alatt (max 10) |
| Memória-utilizáció napi | `monitoring container/memory/utilizations` P99/86400s | napi „mean" ~0,43–0,59 — a napi aggregáció **elfedi** a 20 perces csúcsot; a logsor a közvetlen bizonyíték |
| Óránkénti kérésvolumen 09-06 | `httpRequest` timestamp óra-hiszt. | 06–08h csúcs 0 hibával; hiba csak 10h-kor |
| Előző config-változás | `git show e1a927006` | 512/80 → 1024/40, ugyanezen tünetre |
| Nyitott PR/issue ütközés | `gh pr list`, `gh issue list --search "memory OR OOM OR 503 OR concurrency"` | nincs — #436 (crawler-blokk, #426) más réteg |
| Sibling `ostorosbor-crm` / `ostoros-fold` | korábbi riportok | nem érintett |

### Nem vizsgált terület (tényként, becslés nélkül)
- **Cloud Billing SKU-bontás / LLM-token-költség** — nincs BigQuery billing-export
  hozzáférés; prod `model_calls` tábla nem elérhető. A párhuzamos chat-replay
  modell-költsége **nem becsülhető megbízhatóan**.
- **Prod Neon slow-query / hiányzó index** — prod DB nem elérhető,
  `pg_stat_statements` továbbra sincs telepítve (09-02 óta nyitott javaslat).
- **Clerk auth-hibaráta** — nincs Clerk API-kulcs a futtató környezetben.
- **A `workspace/files` route tényleges memória-profilja terhelés alatt** — csak
  a forráskódból (teljes-fájl buffer + 2–3 string-másolat) és a korrelált
  `503`-akból következtetve; nincs heap-profil a prod konténerről.

## 8. Rangsor (prioritás = üzleti hatás × gyakoriság ÷ javítási kockázat)

| # | Találat | Hatás | Gyak. | Kock. | Pont | Ág |
|---|---|---|---|---|---|---|
| 1 | **Cloud Run OOM-kill párhuzamos agent-chat alatt (1024/40) — REGRESSZIÓ a `e1a92700` javítás után; 42 kliens-`5xx`, 47 kill / 20 perc** | 4 | 3 | 1 | **12,0** | **B** — ez a PR |
| 2 | `workspace/files` teljes-fájl bufferelés (a #1 egyik kiváltója) | 3 | 2 | 2 | 3,0 | Follow-up; a #1 config-fix elfedi rövid távon |
| 3 | Agent-runtime az UI Cloud Run szolgálaton osztozik (#114, lezárva) | 4 | 2 | 3 | 2,7 | **C** — külön döntési jegyzet, 1–3 nap |
| 4 | `pg_stat_statements` továbbra sincs a prod Neon-on | 2 | 1 | 2 | 1,0 | 09-02 óta nyitott; nem viszem újra |
| 5 | #426 Clerk dev-instance (crawler) | 5 | 5 | 3 | 8,3 | Külön kezelt: #426 + #436 merge |

A #1 az egyetlen érdemi, kód-közeli, ma javítható tétel. A #426 magasabb pontszámú,
de már saját pályán fut (#436 crawler-blokk merge-elve 09-06).

---

*A `logq.mjs` / SKILL ADC-átállítása továbbra is nyitott ops-tétel. A mai futás a
service account kulcsfájljával ment, működött.*

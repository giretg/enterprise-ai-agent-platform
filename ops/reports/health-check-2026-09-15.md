# Napi health-check riport — Enterprise AI Agent Platform
**Dátum:** 2026-09-15 · **Szerep:** SRE + FinOps · **Ág:** **D — nincs érdemi találat**

## TL;DR
Az elmúlt 24 órában (2026-09-13 23:31 UTC → 2026-09-14 23:31 UTC) a
`enterprise-ai-agent-platform` Cloud Run szolgáltatás (`europe-west4`) **0
hibát** (`severity>=ERROR`, projekt-szinten) és **0 db 5xx választ** szolgált
ki (11 307 kérésből 11 240×2xx, 31×3xx, 36×4xx — mind ártalmatlan). A
**#437 OOM-fix (2026-09-07) óta 8. napja nulla memória-túllépés** — ez a
regresszió-figyelés lezárható, tartósnak tekinthető. **Ma nincs teendő, nem
nyitok PR-t.**

---

## 1. Mit ellenőriztem — és mivel

| Terület | Forrás (parancs) | Eredmény |
|---|---|---|
| App-hibák (24h, projekt-szinten) | `gcloud logging read 'severity>=ERROR AND timestamp>=...'` | **0 találat** |
| App-hibák (7 nap, trend) | ugyanaz, `freshness=7d` | **0 találat** minden napra |
| HTTP státusz-eloszlás (24h) | Monitoring API `run.googleapis.com/request_count`, `groupBy response_code_class` | 11 240×2xx / 31×3xx / 36×4xx / **0×5xx** |
| Nem-200 részletezése (mintavétel, 500 sor) | `gcloud logging read httpRequest.status!=200` | Kizárólag auth-redirect (307), `favicon.ico`/RSC-prefetch 404, és egy 304 cache-hit — mind várt viselkedés |
| Napi kérésszám, 7 nap (trend) | Monitoring API, napi `ALIGN_SUM` | 28 932 / 6 647 / 1 656 / 494 / 132 / 1 473 / **11 307** (ma). Nagy szórás — dev/demo-forgalom session-számmal korrelál, nem regresszió |
| Cloud Run instance-szám (24h) | Monitoring API `container/instance_count` | csúcs **3 aktív** instance a 10-es plafonhoz képest — nincs skálázási nyomás |
| OOM / memória-túllépés (7 nap) | `textPayload:"OOM" OR "memory limit" OR "Consider increasing"` | 3 találat, mind **2026-09-10 09:47 UTC**, de vizsgálat után **hamis pozitív**: Prisma interaktív tranzakció 5000 ms timeout túllépés (5900 ms), nem memória-esemény. Valódi OOM: **0 a 09-07-i fix óta** |
| p95 kérés-latencia (24h) | Monitoring API `request_latencies`, `ALIGN_PERCENTILE_95` | 6 365 ms — a 7 napos sáv (5 307–7 101 ms) belül, nincs kiugrás. (A hosszú farkat az `agent-chat` SSE-stream kérések adják, várt.) |
| Cloud Run aktuális config | `gcloud run services describe` | `memoryMiB=2048`, `concurrency=10`, `maxScale=10` — megerősíti, hogy a #437 fix élesben fut |
| Clerk-hiba jel | `gcloud logging read` `"clerk"` string 24h | **0 találat** a szerver-oldali logban — de ez nem erős jel, a Clerk SDK kliens-oldali, szerver logban alapból sem jelenik meg minden hiba |
| Billing / SKU-bontás | `gcloud billing accounts list` | **0 tétel** — a health-check SA-nak nincs billing-viewer szerepköre, BigQuery billing-export sincs bekötve |
| Prod Neon DB (slow query, index) | — | **Nem vizsgálva** — a prod `DATABASE_URL` csak Cloud Run build-időben elérhető, erről a hosztról nem (ugyanaz a helyzet 09-02 óta) |

### Nem vizsgált területek (tényként, becslés nélkül)
- **Cloud Billing / 7 napos költségtrend** — nincs billing-viewer szerepkör.
- **LLM-token / modell-hívás költség** — prod DB nem elérhető erről a hosztról.
- **Neon prod slow-query log, hiányzó-index jelzés, full scan** — ugyanaz.
- **Clerk explicit hibaráta** — nincs Clerk API-kulcs a futtató környezetben; a szerver-log 0 találata gyenge proxy-jel, nem erős bizonyíték.

---

## 2. Kontextus, amit nem viszek tovább ma (nem log-alapú találat)

- **PR-hátralék tovább nő:** `gh pr list --state open` ma **49 nyitott PR-t**
  mutat (09-11-én 34 volt), ebből **21 db `cursor/*` bot-draft** (09-11-én
  ~15). A trend romlik, de ez folyamat-kérdés, nem 24 órás platform-defekt —
  nem nyitok hozzá se PR-t, se döntési jegyzetet ma sem, csak megismétlem a
  triage-javaslatot.
- **OAuth authorization code a Cloud Run kérés-URL-ekben:** a
  `/api/connectors/oauth/callback?...&code=...` visszahívás-URL-ek (Google
  OAuth) a teljes query-stringgel kerülnek a Cloud Run access logba — ez
  bárkinek látható, akinek `logging.viewer` szerepe van a projekten. Ez a
  szabványos OAuth 2.0 authorization-code-flow ismert mellékhatása (a kód
  egyszer használatos, percek alatt lejár), nem ma keletkezett és nem ennek a
  platformnak az egyedi hibája — de nem is volt eddig leírva. Nem emelem be a
  rangsorba (üzleti hatás alacsony, a kód rövid életű és egyszer-használatos),
  csak jelzem, hogy tudunk róla.

---

## 3. Rangsor

Nincs 24 órás ablakban keletkezett, korábban nem fedett találat, amihez
üzleti hatás × gyakoriság érdemben pontozható lenne.

→ **D ág: nincs érdemi találat.**

---

## 4. Hogyan mérjük tovább

**#437 (OOM-fix) — regresszió-figyelés lezárható, de tartsuk egy darabig
napirenden:**
```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="enterprise-ai-agent-platform" AND (textPayload:"OOM" OR textPayload:"memory limit")' \
  --project enterprise-ai-demo --account eai-healthcheck-runner@enterprise-ai-demo.iam.gserviceaccount.com \
  --freshness=7d
```
8 nap = 0 találat (09-07 → 09-15). Javaslat: a jövőben csak akkor fusson
külön soron, ha a `severity>=ERROR` napi ellenőrzés bármit talál.

**24h hiba-jel (napi ismétlésre):**
```bash
gcloud logging read 'resource.type="cloud_run_revision" AND severity>=ERROR' \
  --project enterprise-ai-demo --account eai-healthcheck-runner@enterprise-ai-demo.iam.gserviceaccount.com \
  --freshness=1d
```

**PR-hátralék mérése (ha egyszer triage alá kerül):**
```bash
gh pr list --state open --json number,headRefName | jq '[.[] | select(.headRefName | startswith("cursor/"))] | length'
```

---

## 5. Megjegyzés a munkafáról
A futás pillanatában a repo `git status` tiszta volt (`feat/deferred-tool-loading`
ágon, legutóbbi commit #468 — tool-index + `tool_describe`, nincs push). Ehhez
nem nyúltam. Csak az `ops/health-check-log.md` és ez a riport-fájl kerül
bekommitolásra.

# Napi health-check riport — Enterprise AI Agent Platform
**Dátum:** 2026-09-11 · **Szerep:** SRE + FinOps · **Ág:** **D — nincs érdemi találat**

## TL;DR
Az elmúlt 24 órában a `enterprise-ai-agent-platform` Cloud Run szolgáltatás
(`europe-west4`) **0 hibát** (`severity>=ERROR`, projekt-szinten is) és **0 db
5xx választ** szolgált ki. A legutóbbi valós regresszió (Cloud Run OOM,
[#437](https://github.com/giretg/enterprise-ai-agent-platform/pull/437), merge
2026-09-07) óta **egyetlen memória-túllépés sincs** — a `concurrency 40→10` /
`memoryMiB 1024→2048` fix 4 napja tartja magát. **Ma nincs teendő, nem nyitok
PR-t.**

---

## 1. Mit ellenőriztem — és mivel

| Terület | Forrás (parancs) | Eredmény |
|---|---|---|
| App-hibák (24h, service-szinten) | `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="enterprise-ai-agent-platform" AND severity>=ERROR'` | **0 találat** |
| App-hibák (24h, projekt-szinten, minden erőforrás) | `gcloud logging read 'severity>=ERROR'` | **0 találat** |
| HTTP státusz-eloszlás (24h) | `gcloud logging read` + `httpRequest.status` csoportosítva | 1639×200, 15×404, 1×307, **0×5xx** |
| 401/403 (24h) | ugyanaz, `httpRequest.status=401 OR 403` | **0** |
| OOM / memória-esemény (7d) | `textPayload:"OOM" OR "memory limit" OR severity>=CRITICAL` | 9 db, **mind 2026-09-06/07-i**, azóta (4 napja) **nulla** — #437 regresszió-mérése pozitív |
| Kérés-latencia (24h, top 20) | `httpRequest.latency` rendezve | A leghosszabbak (258–300 s) az `agent-chat/stream` SSE-kapcsolatok — várt viselkedés, nem lassúság. Nincs abnormális lassú, nem-stream endpoint. |
| 404-ek részletezése (24h) | `httpRequest.status=404` + URL lista | Túlnyomó rész `favicon.ico` (kozmetikai, ismert), 4× `active-runs` (ismert, #415 nyitva fedi), 2× `control-plane/agents/<uuid>/chat` — ugyanazon agentre percek múlva sikeres 200-ak is vannak, tranziens, elhanyagolható gyakoriság |
| Napi kérésszám, 7 nap (trend/kontextus) | napi `gcloud logging read` count | 04-09: 149→10000+ (limit-vágott)→1656→(mai nap, részleges). Nagy szórás, de ez egy 0 külső felhasználós demo-platform, ahol a forgalom ~fele a #449-ben már azonosított kliens-életjel-poll — a szórás munkamenet-számmal korrelál, nem regresszió. |
| Cloud Run szolgáltatás-lista | `gcloud run services list` | `enterprise-ai-agent-platform` fut, elérhető a health-check SA-val |
| Dev Neon DB — `pg_stat_statements` | `psql` (helyi `.env` `DATABASE_URL`, csak SELECT, `statement_timeout=5s`) | Extension **telepítve**, de a statisztika kizárólag DB-setup lekérdezéseket tartalmaz (1 hívás/lekérdezés) — **nincs valós forgalmi jel**, mert ez a dev DB, nem a prod. |
| Prod Neon DB | — | **Nem vizsgálva** — a deployolt szolgáltatás `PLATFORM_DATABASE_URL` secretet használ, ami csak Cloud Run build-időben elérhető, a health-check hosztról nem. (Ugyanez a helyzet 09-02 óta.) |

### Nem vizsgált területek (tényként, becslés nélkül)
- **Cloud Billing / SKU-bontás, 7 napos költségtrend** — a health-check SA-nak
  nincs billing-viewer szerepköre (`gcloud billing accounts list` → 0 tétel).
  Nincs BigQuery billing-export sem.
- **LLM-token / modell-hívás költség** — a `model_calls` prod tábla nem
  elérhető (l. fent, prod DB nem elérhető erről a hosztról).
- **Neon prod slow-query log, hiányzó-index jelzés, full scan** — ugyanaz az ok.
- **Clerk explicit hibaráta** — nincs Clerk API-kulcs a futtató környezetben;
  proxy-jelként a 401/403-as HTTP-válaszok 0-t mutatnak.

---

## 2. Kontextus, amit nem viszek tovább ma

A nyitott PR-lista (`gh pr list --state open`) **34 nyitott PR-t** mutat, ebből
~15 db `cursor/critical-bug-management-*` néven, jellemzően draft, egy részük
napok/hetek óta nyitva biztonsági/korrektségi javításokkal (pl. #397, #398,
#404, #408, #412, #418, #423, #429, #432, #440). Ez egy **felhalmozódó
átvezetési hátralék**, nem ma keletkezett, és nem tartozik egyetlen 24 órás
találathoz sem — ezért nem ez a mai top tétel, de érdemes emberi triage alá
venni, mielőtt a lista tovább nő. Nem nyitok hozzá se PR-t, se döntési
jegyzetet, mert ez folyamat-kérdés, nem ma mért platform-defekt.

---

## 3. Rangsor

Nincs 24 órás ablakban keletkezett, korábban nem fedett találat, amihez
üzleti hatás × gyakoriság érdemben pontozható lenne. A legközelebbi tétel
(PR-hátralék, §2) folyamat-jellegű, nem log-alapú mérés.

→ **D ág: nincs érdemi találat.**

---

## 4. Hogyan mérjük tovább

**#437 (OOM-fix) regresszió-ellenőrzés — folytatás:**
```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="enterprise-ai-agent-platform" AND (textPayload:"OOM" OR textPayload:"memory limit")' \
  --project enterprise-ai-demo --account eai-healthcheck-runner@enterprise-ai-demo.iam.gserviceaccount.com \
  --freshness=7d
```
Ha 0 találat marad a következő futásokban is, a fix tartósan zártnak
tekinthető (7 nap = 2026-09-14).

**24h hiba-jel (napi ismétlésre):**
```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="enterprise-ai-agent-platform" AND severity>=ERROR' \
  --project enterprise-ai-demo --account eai-healthcheck-runner@enterprise-ai-demo.iam.gserviceaccount.com \
  --freshness=1d
```

---

## 5. Megjegyzés a munkafáról
A futás pillanatában a `main` ágon 15 fájlon nem commitolt, feltehetően a
chat-forduló-ellenállóság témához tartozó WIP módosítás áll (pl.
`chat-tool-loop.ts`, `turn-continuation.ts`, `loop-stop-decision.ts`, egy új
`conversation-write-retry.test.ts`). Ehhez nem nyúltam. Csak az
`ops/health-check-log.md` és ez a riport-fájl kerül bekommitolásra, névvel
megcélzott `git add`-del.

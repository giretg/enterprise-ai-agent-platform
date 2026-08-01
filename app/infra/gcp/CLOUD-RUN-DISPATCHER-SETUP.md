# GCP Cloud Run dispatcher — LEGACY wiki-harness worker (§5.7, §15.3)

> ⚠️ **EZ NEM a dispatch-ciklus worker (#114).** Ez a jegyzet a régi, folyamatosan futó
> `wiki-dispatcher` LISTEN/NOTIFY service-ről szól (`Dockerfile.dispatcher`,
> `min-instances=1`, állandó Neon-kapcsolat), amit a `enterprise-ai-demo` projektből
> töröltünk. A **ma élő** biztonsági háló egy stateless HTTP-ciklus, amit a Cloud Scheduler
> hajt egy dedikált Cloud Run szolgáltatáson — annak a leírása:
> `CLOUD-RUN-DISPATCH-CYCLE-WORKER-SETUP.md` és `CLOUD-SCHEDULER-DISPATCH-CYCLE-SETUP.md`.
> Az itteni utat csak akkor élesztsd fel, ha tudatosan a LISTEN/NOTIFY üzemmódot hozod
> vissza (perzisztens kapcsolat + állandóan futó instance költséggel).

> Készült: session 13 (2026-06-18). A **production dispatcher** lépés (§15.3 / 1.)
> implementációja: a nem-LLM `dispatcher-worker` Cloud Run **service**-ként, folyamatos
> üzemben (`min-instances ≥ 1`), a runtime SA-jával indítja a `wiki-harness` Cloud Run Jobot.
> Kapcsolódó harness-jegyzet: `CLOUD-RUN-HARNESS-SETUP.md` (§5.2 ott írta elő ezt a lépést).

---

## 1. Mit deployolunk és miért service (nem Job)

A dispatcher egy **hosszan futó, eseményvezérelt** worker (Postgres `LISTEN/NOTIFY` +
alacsony frekvenciás cron safety net). A harness ezzel szemben **ticketenkénti Job**.

```
Cloud Run service: wiki-dispatcher (min-instances=1, always-on CPU)
   │  LISTEN dispatch_ready  +  setInterval(cron)
   │
   ├─ Ready ticket? ── igen ──▶ run.googleapis.com  jobs:run (containerOverrides)
   │                              → wiki-harness Cloud Run Job (egy execution / ticket)
   │
   └─ health: GET :8080  → 200 {status:"ok"}  (Cloud Run liveness/startup probe)
```

Miért **service** és nem Job:
- A Job egyszer lefut és kilép — a dispatchernek viszont **folyamatosan** kell hallgatnia a
  `LISTEN/NOTIFY`-t és pörgetnie a cron safety netet.
- A Cloud Run service `--min-instances=1` + `--no-cpu-throttling` adja a folyamatos üzemet
  (a CPU két kérés között is allokálva marad, így a háttér `setInterval` / `LISTEN` él).
- A service `$PORT`-ra figyel — ezért a `dispatcher-worker.ts` egy minimális health-szervert
  is futtat (`GET /` → 200, amíg a `LISTEN` kapcsolat áll). Bejövő üzleti forgalom nincs,
  ezért `--no-allow-unauthenticated`.

**Egyetlen instance (`max-instances=1`):** a `dispatchTicket` idempotens lockja
(`UPDATE … WHERE lock_token IS NULL`) több instance esetén is véd a duplázás ellen, de
egyetlen workerrel egyszerűbb és olcsóbb — a spec „egy ticket pontosan egyszer fut" kritériuma így triviálisan teljesül.

---

## 2. Előfeltételek

- A `wiki-harness` Cloud Run Job már deployolva (`npm run harness:cloud-run-deploy`).
- Artifact Registry repo: `ai-platform` (közös a harness-szel).
- Dedikált **runtime service account** a dispatchernek (least privilege).
- DB connection string Secret Managerben — **NEM-pooler / direct** endpoint
  (a Neon pooler nem támogatja a `LISTEN/NOTIFY`-t).

### 2.1 Runtime SA + IAM (a kulcslépés: `run.jobs.runWithOverrides`)

```bash
PROJECT=enterprise-ai-demo
REGION=europe-west4
SA=wiki-dispatcher@${PROJECT}.iam.gserviceaccount.com

# SA létrehozás
gcloud iam service-accounts create wiki-dispatcher \
  --project=$PROJECT --display-name="Wiki dispatcher worker"

# A Job indításához (run.jobs.runWithOverrides benne van a roles/run.developer-ben)
gcloud run jobs add-iam-policy-binding wiki-harness \
  --project=$PROJECT --region=$REGION \
  --member="serviceAccount:${SA}" --role="roles/run.developer"

# DB connection secret olvasás
gcloud secrets add-iam-policy-binding dispatcher-database-url \
  --project=$PROJECT \
  --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor"
```

> A launcher (`cloud-run-auth.ts`) a metadata-szerverről veszi az access tokent, ha nincs
> explicit bearer — GCP-n belül ez a runtime SA tokenje, ezért külön kulcs/JSON **nem kell**.

### 2.2 DB connection secret

```bash
# Neon direct (nem-pooler) connection string
printf '%s' "postgresql://USER:PASS@HOST/db?sslmode=require" | \
  gcloud secrets create dispatcher-database-url --replication-policy=automatic --data-file=-
# később új verzió:
printf '%s' "<új connection string>" | \
  gcloud secrets versions add dispatcher-database-url --data-file=-
```

> Az `enterprise-ai-demo`-ban a meglévő **`DIRECT_URL`** secretet használjuk újra (a Prisma
> konvenció szerint ez a nem-pooler endpoint) — nem hoztunk létre külön secretet.

### 2.3 Agent API key secret

A harness egy control-plane agent API kulccsal (`cp_sk_…`) hívja a platform
feldolgozó API-ját. A dispatcher normál futásnál efemer kulcsot ad át a
Job-override-ban; külön smoke-futtatáshoz használható a secretből feloldott kulcs.

```bash
# pl. a seed demo kulcsból (a közös Neon DB miatt élesben is érvényes):
tr -d '\n' < app/.seed-demo-api-key | \
  gcloud secrets create HARNESS_AGENT_API_KEY --replication-policy=automatic --data-file=-
gcloud secrets add-iam-policy-binding HARNESS_AGENT_API_KEY \
  --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor"
```

---

## 3. Deploy

```bash
cd app
cp infra/gcp/dispatcher-service.env.example infra/gcp/dispatcher-service.env
# töltsd ki (GCP_PROJECT_ID, SERVICE_ACCOUNT, PLATFORM_API_URL, DATABASE_URL_SECRET, …)
npm run dispatcher:cloud-run-deploy
```

A szkript:
1. Cloud Build-del **natív amd64** image-et épít (`Dockerfile.dispatcher`, Goose nélkül) — ugyanaz a buktató, mint a harnessnél (Apple Silicon → arm64).
2. `gcloud run deploy wiki-dispatcher … --min-instances=1 --no-cpu-throttling --no-allow-unauthenticated`.
3. Env-ben beállítja `HARNESS_LAUNCHER_MODE=cloud-run-job` + a `HARNESS_CLOUD_RUN_*` célt.
4. Secretként köti a DB connectiont (`DIRECT_URL` + `DATABASE_URL`) és opcionálisan a callback tokent.
5. Kiírja a futtatandó IAM-bindingeket (ld. 2.1), ha még nem futtattad.

---

## 4. Ellenőrzés

```bash
# Service állapot + revízió
gcloud run services describe wiki-dispatcher --region=europe-west4 --project=enterprise-ai-demo

# Worker boot-log: "LISTEN dispatch_ready" + "health server listening on :8080"
gcloud logging read 'resource.type="cloud_run_revision"
  AND resource.labels.service_name="wiki-dispatcher"' \
  --project=enterprise-ai-demo --order=desc --limit=30
```

**Kipróbálható, ha (§5.7):**
- üresben **nulla LLM-token** fogy (a dispatcher nem hív modellt — csak Jobot indít);
- egy `ready` ticket pontosan **egyszer** indít harness executiont (lock + single instance);
- állapotváltáskor (`→ ready`) a `LISTEN/NOTIFY` azonnal triggerel, cron nélkül is.

Végponti proof: hozz létre egy `ready` ticketet, és nézd a harness Job új executionjét
(`gcloud run jobs executions list --job=wiki-harness --region=europe-west4`).

---

## 5. Üzemeltetés / mire figyelj

- **Hálózati egress (S4):** ez a service a DB-t és a Google API-t éri el; a *harness* Job
  deny-by-default egress-e külön feladat (§15.3 / 2.). A dispatcheren a VPC connector opcionális
  (`VPC_CONNECTOR`), ha a DB privát.
- **Token rotáció:** a DB/callback secret új verziójánál a service-t újra kell deployolni
  vagy a revíziót újraindítani (`--set-secrets` `:latest`-et köt, de a meglévő instance nem
  olvas újra futás közben).
- **Admin kill-switch + intervallum (runtime):** a `/control-plane/system` ("Rendszer") oldalon
  admin le tudja állítani a dispatchert és állíthatja a cron-intervallumot (5–600 mp) **újra-deploy
  nélkül**. A beállítás a `platform_settings` táblában él (`dispatcher.controls`), a worker minden
  ciklusban újraolvassa; a kill-switch a `DispatcherService`-ben van betartatva (NOTIFY és cron úton is).
  Leállítva nulla LLM-token fogy, a ticketek `ready`-ben várnak (`dispatcher.paused` audit).
- **SIGTERM:** a worker kezeli a `SIGTERM`-et (Cloud Run skálázás/redeploy) → tiszta `client.end()`.
- **Megfigyelhetőség:** riassz a `cycle error` logokra és arra, ha a health 503-at ad
  (`listening=false` → megszakadt a `LISTEN` kapcsolat).

---

## 6. Tényleges éles deploy + igazolás (2026-06-18, session 13)

**Deploy kész és működik** az `enterprise-ai-demo` projektben.

| Dolog | Érték |
|---|---|
| Service | `wiki-dispatcher` (europe-west4), revízió `00002+` |
| Service URL | `https://wiki-dispatcher-346824017066.europe-west4.run.app` (no-allow-unauthenticated) |
| Skálázás | `minScale=1`, `maxScale=1`, `cpu-throttling=false` ✓ |
| Runtime SA | `wiki-dispatcher@enterprise-ai-demo.iam.gserviceaccount.com` |
| IAM | `roles/run.developer` a `wiki-harness` Jobon + `secretAccessor` a `DIRECT_URL`, `HARNESS_CALLBACK_TOKEN`, `HARNESS_AGENT_API_KEY` secreteken |

**Igazolt a teljes production lánc** (audit-nyomból, friss `ready` ticketre):
- `ready → in_progress` a NOTIFY-ra **0s-en belül** (LISTEN/NOTIFY él);
- `dispatch.start/started` — a harness Job indítása a runtime SA-val (`run.jobs.runWithOverrides` működik, nincs 403);
- a harness a platform provider-független wiki-runtime-ját hívja, amely a kormányzott Gateway-en át fut;
- **budget cap működik** (`dispatch.budget_blocked`, alap: 100 hívás / 100k token / agent / nap);
- bukáskor a ticket vissza `ready`-be, a lock felszabadul (`dispatch.complete/failed`).

**Provider-független runtime:** a konténer nem futtat saját agent-loopot vagy recipe-t.
`HARNESS_MODE=wiki` mellett a platform feldolgozó végpontját hívja, így a modell-, tool- és
guardrail-szabályok egy helyen, a platform runtime-ban maradnak. Végpontig tartó igazolás:
`npm run dispatcher:cloud-run-smoke`.

> **Üzemi figyelmeztetés:** mivel a service `min-instances=1`, élesben minden `ready` ticketet
> elindít, és valódi tokent fogyaszt. A `GATEWAY_MAX_CALLS_PER_TICKET` (per-ticket) és a napi
> budget cap (100 hívás / 100k token / agent / nap) együtt korlátozza a kárt; a beragadt
> ticketeket `done`-ra/`rejected`-re kell zárni.

## 7. Kapcsolódó fájlok
- `app/Dockerfile.dispatcher` — dispatcher image (Node, Goose nélkül)
- `app/infra/gcp/deploy-dispatcher-service.sh` — Cloud Build + Cloud Run service deploy
- `app/infra/gcp/dispatcher-service.env.example` → másold `dispatcher-service.env`-be (gitignore-olt)
- `app/scripts/dispatcher-worker.ts` — worker + health-szerver
- `app/scripts/dispatcher-cloud-run-smoke.ts` — end-to-end smoke (`npm run dispatcher:cloud-run-smoke`)
- `app/src/domain/dispatcher/cloud-run-job-launcher.ts`, `cloud-run-auth.ts` — Job indítás
- Spec: `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` §5.7, §15.3

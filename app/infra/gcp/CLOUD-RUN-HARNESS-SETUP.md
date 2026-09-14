# GCP Cloud Run harness — setup napló és üzemeltetési jegyzet

> Készült: 2026-06-16 (session 12). Ez a dokumentum összefoglalja, hogyan állt fel a
> **wiki-harness** Cloud Run Job és az éles smoke proof a `enterprise-ai-demo` projektben,
> milyen döntéseket hoztunk, milyen hibákba futottunk, és **mire kell figyelni a kezdeti v1 baseline után**.

---

## 1. Mit építettünk (összkép)

A harness (Goose agent runtime) egy **Cloud Run Job**-ként fut a felhőben. A futás láncolata:

```
Dispatcher (launcher)  ──run──▶  Cloud Run Job (wiki-harness, konténer)
                                      │
                                      ├─▶ Model Gateway   (PLATFORM_API_URL/api/v1/gateway/v1)   → model_calls
                                      ├─▶ Tool Broker      (MCP bridge → /api/v1/agent/tools)      → tool_calls
                                      └─▶ Completion callback (PLATFORM_API_URL/api/v1/harness/tickets/{id}/complete)
                                                                  → lock felszabadítás + válasz rögzítés
```

A platform maga **Firebase App Hosting**-on fut (Next.js), a Job pedig külön Cloud Run Job-ként,
ugyanabban a GCP projektben. A kettő a **megosztott Neon Postgres**-en keresztül látja ugyanazt a ticketet.

---

## 2. Környezet (a tényleges értékek)

| Dolog | Érték |
|---|---|
| GCP projekt | `enterprise-ai-demo` (projektszám 346824017066) |
| Régió | `europe-west4` (a platform App Hosting régiója — egy régióban tartjuk) |
| Platform (App Hosting backend) | `enterprise-ai-agent-platform` |
| Platform URL | `https://ai.excellencepay.com` (egyedi domain az App Hosting backenden) |
| App Hosting forrás | GitHub `giretg/enterprise-ai-agent-platform`, **`main` branch — push-ra auto-rollout** |
| Artifact Registry repo | `ai-platform` (docker, europe-west4) |
| Cloud Run Job | `wiki-harness` (europe-west4) |
| Harness image | `europe-west4-docker.pkg.dev/enterprise-ai-demo/ai-platform/wiki-harness:<tag>-amd64` |
| Adatbázis | Neon Postgres (eu-central-1), közös a lokális `.env` és az App Hosting között |

---

## 3. Lépésről lépésre, amit csináltunk

### 3.1 Előfeltételek (már megvolt / ellenőrizve)
- `gcloud` v572 telepítve, bejelentkezve `gergely.giret@excellencepay.com` (Owner).
- Engedélyezett API-k: `run`, `artifactregistry`, `secretmanager` (már aktív), később `cloudbuild` (aktív volt).
- `docker` jelen, de **`buildx` NINCS** telepítve (ez később számít — lásd 4.1).

### 3.2 Artifact Registry repo
```bash
gcloud artifacts repositories create ai-platform \
  --repository-format=docker --location=europe-west4 \
  --project=enterprise-ai-demo
```

### 3.3 Callback token → Secret Manager + App Hosting
A platform callback route 503-at ad, ha nincs `HARNESS_CALLBACK_TOKEN`; a Jobnak ugyanazt a tokent kell küldenie.

```bash
# titok generálás
openssl rand -hex 24
# Secret Manager + App Hosting IAM
printf '%s' "<token>" | npx firebase-tools@latest \
  apphosting:secrets:set HARNESS_CALLBACK_TOKEN --project enterprise-ai-demo --data-file - --force
npx firebase-tools@latest apphosting:secrets:grantaccess HARNESS_CALLBACK_TOKEN \
  --backend enterprise-ai-agent-platform --project enterprise-ai-demo
```
Majd **mindkét** `apphosting.yaml`-ba (repo root + `app/`) bekerült RUNTIME secretként:
```yaml
  - variable: HARNESS_CALLBACK_TOKEN
    secret: HARNESS_CALLBACK_TOKEN
    availability: [RUNTIME]
```

### 3.4 ChatGPT OAuth — beágyazott mediáció (S2 kész, 2026-06-18)

A korai plumbing-proof ideiglenesen `CHATGPT_OAUTH_STUB=true`-t használt. **Jelenlegi éles állapot:** beágyazott (in-process) mediáció Secret Manager tokenekkel — sidecar URL **nem** kell.

```yaml
  - variable: CHATGPT_OAUTH_EMBEDDED
    value: "true"
    availability: [RUNTIME]
  - variable: CHATGPT_OAUTH_TOKEN_SECRET
    value: "projects/346824017066/secrets/CHATGPT_OAUTH_TOKENS"
    availability: [RUNTIME]
  - variable: CHATGPT_OAUTH_MODEL
    value: "gpt-5.5"
    availability: [RUNTIME]
  - variable: GEMINI_API_KEY
    secret: GEMINI_API_KEY
```

Token feltöltés: `npm run s2:secret-setup` (`~/.codex/auth.json` → Secret Manager, runtime SA accessor + version-adder). A harness a platform Gateway-jén (`/api/v1/gateway/v1`) keresztül ugyanezt a beágyazott utat használja — külön stub a Jobon nem kell.

**Megjegyzés:** a korai proof naplója még stubot említ; az `apphosting.yaml` már nem tartalmaz `CHATGPT_OAUTH_STUB`-ot.

### 3.5 Konfig fájl + deploy
`app/infra/gcp/harness-job.env` (gitignore-olt, titok!) kitöltve a fenti értékekkel, `HARNESS_EGRESS_ENFORCE=false`-szal (app-szintű egress — lásd 5.1), majd:
```bash
npm run harness:cloud-run-deploy   # Cloud Build (amd64) → push → gcloud run jobs deploy
```

### 3.6 Éles smoke proof
```bash
HARNESS_CLOUD_RUN_PROJECT_ID=enterprise-ai-demo \
HARNESS_CLOUD_RUN_LOCATION=europe-west4 \
HARNESS_CLOUD_RUN_JOB_NAME=wiki-harness \
PLATFORM_API_URL=https://ai.excellencepay.com \
HARNESS_CALLBACK_URL=https://ai.excellencepay.com \
HARNESS_CALLBACK_TOKEN=<a tokenből> \
HARNESS_CLOUD_RUN_BEARER_TOKEN="$(gcloud auth print-access-token)" \
npm run harness:cloud-run-smoke
```
**Eredmény:** `execution succeeded · modelCalls>0 · toolCalls>0 · lock=null · answer OK`.

---

## 4. Hibák, amikbe futottunk (és a javítás)

### 4.1 Image architektúra (a legnagyobb)
**Tünet:** a Job indulásakor „Application failed to start", **nulla** konténer-log.
**Ok:** Apple Siliconon a `docker build` `linux/arm64` image-et gyárt; a Cloud Run `linux/amd64`-et futtat → a binárisok nem futnak.
**Fix:** a deploy szkript mostantól **Cloud Build**-del épít (natív amd64, nincs emuláció). A `buildx` itt nincs telepítve, ezért a `--platform` flag a klasszikus builderrel nem segített — a Cloud Build a tiszta megoldás.

### 4.2 Callback dupla útvonal → 404
**Tünet:** `Harness completion callback failed: 404`, miközben az endpoint kézzel 401-et ad.
**Ok:** a launcher (`buildHarnessContainerEnv`) már a **teljes** callback URL-t adta át, a konténer (`completionEndpoint`) pedig **újra** ráfűzte az útvonalat → `…/complete/api/v1/harness/…/complete`.
**Fix:** a launcher a **base** URL-t adja át, a konténer fűzi rá egyszer. A felesleges `resolveHarnessCallbackUrl` helper törölve.

### 4.3 Operation- vs execution-státusz
**Tünet:** `execution status=unknown detail=timeout`.
**Ok:** a `jobs:run` egy long-running **Operation** nevet ad vissza (`…/operations/…`), a kód ezt tévesen execution resource-ként pollozta.
**Fix:** `fetchCloudRunExecutionStatus` az operation `done`/`error` mezőit értelmezi.

### 4.4 Rollout-verseny (átmeneti)
Közvetlenül push után az App Hosting egy ideig még a régi revíziót szolgálta (a harness route 404, a régi build), majd átváltott. Ezért a proof előtt érdemes **megvárni**, hogy az új revízió tényleg éljen (mi a callback 401 / a gateway 200 jelre vártunk pollerrel).

---

## 5. Mire kell figyelni a kezdeti v1 baseline után (FONTOS)

### 5.1 Hálózati szintű egress (most NINCS)
Jelenleg **app-szintű** egress guard van (`egress-guard.ts` + N4 acceptance), a Jobon `HARNESS_EGRESS_ENFORCE=false`.
Production-höz **hálózati** deny-by-default kell:
- Serverless **VPC Access connector** (europe-west4) + `--vpc-egress=all-traffic`.
- **Cloud NAT** + **egress firewall**, ami csak a platform/Gateway/Broker hostokat engedi.
- Buktató: a platform egyedi domainen (`ai.excellencepay.com`) fut az App Hosting backend előtt — a hostname-alapú engedélyezésnél ezt a hostot kell kezelni (a régi `*.hosted.app` URL csak tartalék).
- Ha kész, a Jobon `HARNESS_EGRESS_ENFORCE=true` visszakapcsolható (az induló `assertEgressDenyByDefault` ekkor a hálózati zárást ellenőrzi az `example.com` próbával).

### 5.2 Production dispatcher launch-auth — **MEGOLDVA (kód+infra), lásd `CLOUD-RUN-DISPATCHER-SETUP.md`**
A smoke-ot **lokálisan** futtattuk, `gcloud auth print-access-token`-nel. Production-ben egy felhőben futó dispatcher indítja a Jobot:
- Dedikált Cloud Run **service** (`wiki-dispatcher`, `min-instances=1`, always-on CPU) a `dispatcher-worker`-ből — deploy: `npm run dispatcher:cloud-run-deploy`.
- A service **runtime SA-jának** `roles/run.developer` (azaz `run.jobs.runWithOverrides`) jog kell a `wiki-harness` Jobon — a binding parancsát a deploy szkript kiírja.
- A launcher metadata-token fallbackja (`cloud-run-auth.ts`) GCP-n belül a runtime SA tokenjét használja; off-GCP-hez explicit bearer token kell.

### 5.3 Titokkezelés a Jobon
A callback tokent **futásidőben** a launcher injektálja `containerOverrides`-szal — a Job definíciójában nincs plain env-ben (jó). Production-ben érdemes a Jobra is **Secret Manager** referenciát kötni (`--set-secrets`), ne csak override-on át jöjjön. A token **rotációját** is tervezni kell (App Hosting secret új verzió + Job újraindítás).

### 5.4 OAuth token rotáció (S2 kész)

A beágyazott provider a `CHATGPT_OAUTH_TOKENS` secretet olvassa; lejáratkor refresh + **write-back** (`SecretManagerTokenStore.addVersion`). Üzemeltetés:
- Refresh token lejárata / fiók visszavonása → újra `npm run s2:secret-setup` (`codex login` után).
- A runtime SA-nak `secretAccessor` **és** `secretVersionAdder` kell a secretre.
- A `CHATGPT_OAUTH_STUB` csak lokális acceptance/dev-hez maradt (`.env` / automatikus stub); élesben **ne** állítsd be.

**Gemini (D2 feletti cserepont):** a `GEMINI_API_KEY` App Hosting secretként be van kötve; agentenként `modelConfig.provider: "gemini"`. A Wiki Agent továbbra is `chatgpt-oauth`.

### 5.5 Image build pipeline
- A Cloud Build manuális (`npm run harness:cloud-run-deploy`). Production-höz érdemes CI-be (GitHub Actions / Cloud Build trigger) kötni, verziózott image tagekkel és **immutábilis** digest-deployjal.
- A jelenlegi tag a git short HEAD (`<sha>-amd64`). A korábbi **arm64 image** (`:7570459`) bent maradt az Artifact Registryben — takarítható, hogy ne lehessen véletlenül azt deployolni.

### 5.6 Least-privilege service account a Jobnak
Most a Job a **default compute SA**-val fut. Production-höz dedikált, minimális jogú SA ajánlott (`--service-account`), csak a ténylegesen szükséges jogokkal (a harness az átjárókon HTTPS-en megy, nem kell széles GCP IAM).

### 5.7 App Hosting rollout = minden main push
Bármilyen `main` push (akár doc-only) **újraépíti** a platformot. Ez most elfogadott workflow, de:
- Költség/idő szempontból pazarló doc-változásnál.
- Megfontolandó: külön deploy branch, vagy a rollout trigger szűkítése.

### 5.8 Régió- és adat-lokalitás
A platform + Job europe-west4, a **DB Neon eu-central-1** — más felhő, más régió. Latency és adatvédelmi (GDPR) szempontból production előtt át kell gondolni (managed Postgres GCP-n belül? régió-illesztés?).

### 5.9 Megfigyelhetőség
A Job logjai Cloud Loggingban vannak (`resource.type="cloud_run_job"`). Production-höz: log-alapú metrikák, riasztás a `failed` executionökre, és a `model_calls`/`tool_calls` költség-dashboard (Epik 8).

---

## 6. Hasznos parancsok

```bash
# Job állapot + utolsó executionök
gcloud run jobs describe wiki-harness --region=europe-west4
gcloud run jobs executions list --job=wiki-harness --region=europe-west4

# Egy execution logja
gcloud logging read 'resource.type="cloud_run_job"
  AND resource.labels.job_name="wiki-harness"
  AND labels."run.googleapis.com/execution_name"="<exec-név>"' \
  --project=enterprise-ai-demo --order=asc

# Callback endpoint él-e (401 = route+token kész; 404 = route hiányzik; 503 = nincs token)
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "<PLATFORM_URL>/api/v1/harness/tickets/00000000-0000-4000-8000-000000000000/complete" \
  -H "authorization: Bearer wrong"
```

---

## 7. Kapcsolódó fájlok
- `app/Dockerfile.harness` — harness image (Goose + Node entrypoint)
- `app/infra/gcp/deploy-harness-job.sh` — Cloud Build + Job deploy
- `app/infra/gcp/harness-job.env.example` → másold `harness-job.env`-be (gitignore-olt)
- `app/src/domain/dispatcher/cloud-run-job-launcher.ts`, `cloud-run-auth.ts`, `harness-run-env.ts`
- `app/src/harness/job-entrypoint.ts`, `egress-guard.ts`
- `app/scripts/harness-cloud-run-smoke.ts` — éles smoke proof
- Spec: `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` §15

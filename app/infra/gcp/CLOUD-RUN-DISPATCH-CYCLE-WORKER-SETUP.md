# GCP Cloud Run — dedikált dispatch-ciklus worker (#114)

> A Cloud Scheduler ezt a szolgáltatást hívja, **nem a control-plane UI-t**.
> Kapcsolódó jegyzetek: `CLOUD-SCHEDULER-DISPATCH-CYCLE-SETUP.md` (az időzítés),
> `CLOUD-RUN-DISPATCHER-SETUP.md` (a **legacy** LISTEN/NOTIFY worker — más felelősség).

---

## 1. Miért van külön szolgáltatás

Eddig ugyanabban az 1 GiB-os, `concurrency: 40` konténerben futott

- a control-plane UI (Next.js SSR),
- a percenkénti **dispatch-ciklus** (stale-reclaim, ütemezett task materializálás,
  monitor-söprés, workspace-purge, channel-turn drain, channel-retention takarítás,
  ready ticket dispatch — LLM-hívásokkal),
- és a hosszú életű agent-chat SSE.

Ennek két, közvetlenül érezhető következménye volt: egy nehéz ciklus **lassította vagy
OOM-olta az interaktív oldalakat** (a napi munka akadozott), és fordítva — egy UI-forgalmi
csúcs **eltolta a ticket-feldolgozást** (a Folyamat-ticketek később indultak). Ráadásul a UI
p95 és a worker terhelése egy metrikába keveredett, tehát nem lehetett megmondani, melyik
oldal viszi a költséget.

A ciklus ezért saját Cloud Run szolgáltatást kap. **A szerződés változatlan**:

```
Cloud Scheduler (cron, pl. */2 * * * *)
   │  POST /api/v1/internal/dispatch-cycle
   │  header: x-dispatcher-token: $DISPATCHER_CONTROL_TOKEN   (+ OIDC token)
   ▼
platform-dispatch-cycle (Cloud Run service, saját CPU/memória, min-instances=0)
   │  runDispatchCycle()  ← UGYANAZ a domain-mag, mint az UI-n és az admin kézi triggerén
   └─ válasz: DispatchCycleSummary + `dispatcher.last_cycle` a platform_settings-be
```

Az agent-chat SSE ebben a lépésben **marad az UI szolgáltatáson** — a külön chat-runtime
későbbi spec.

### Mi NEM ez

Nem a `wiki-dispatcher` (LISTEN/NOTIFY, `Dockerfile.dispatcher`, `min-instances=1`, állandó
Neon-kapcsolat) visszahozása. Ez a worker **stateless**: kérésre ébred, lefuttat egy kört,
és visszaskálázódhat nullára.

---

## 2. Előfeltételek

- Artifact Registry repo (ugyanaz, mint a harnessé: `ai-platform`).
- Runtime service account. Jogok:
  - `roles/secretmanager.secretAccessor` a lenti titkokhoz,
  - `roles/run.developer` a `wiki-harness` Jobon, ha a ciklus agent-futtatást indít
    (`HARNESS_LAUNCHER_MODE=cloud-run-job`).
- Hívó (Scheduler) service account `roles/run.invoker` joggal — a worker nem publikus.
- `DISPATCHER_CONTROL_TOKEN` Secret Managerben, **ugyanazzal az értékkel**, mint az UI
  `apphosting.yaml` RUNTIME secretje és a Scheduler job fejléce.

---

## 3. Deploy

```bash
cd app
cp infra/gcp/dispatch-cycle-service.env.example infra/gcp/dispatch-cycle-service.env
# töltsd ki (GCP_PROJECT_ID, SERVICE_ACCOUNT, *_SECRET nevek, erőforrás-profil …)
npm run dispatch-cycle:cloud-run-deploy
```

A szkript Cloud Buildben natív `linux/amd64` image-et épít (`Dockerfile.dispatch-cycle`),
deployolja a szolgáltatást `--no-allow-unauthenticated` mellett, és a végén kiírja a worker
URL-jét + a szükséges IAM-parancsokat.

### Erőforrás-profil

Az UI App Hosting profiljától **függetlenül** állítható (`dispatch-cycle-service.env`):

| Beállítás | Alap | Megjegyzés |
|---|---|---|
| `MIN_INSTANCES` | `0` | A ciklus rövid és időzített. Emeld 1-re, ha a hidegindítás a Scheduler attempt-deadline-jét feszegeti. |
| `MAX_INSTANCES` | `2` | A ciklus önmagában idempotens (lock véd a duplázás ellen). |
| `SERVICE_CPU` / `SERVICE_MEMORY` | `1` / `1Gi` | A ciklus LLM-hívásokat is indíthat. |
| `SERVICE_CONCURRENCY` | `1` | Egy ciklus fut egyszerre a processzben (in-flight kapu). |
| `REQUEST_TIMEOUT` | `300s` | Legyen **≥** a Scheduler `ATTEMPT_DEADLINE`-ja. |

---

## 4. Env- és secret-paritás

A worker ugyanazokat a futásidejű beállításokat igényli, mint amiket a ciklus alatti
szolgáltatások használnak (dispatcher, ütemezett taskok, monitor, channel-turn,
channel-retention, workspace purge).

### 4.1 Boot-kritikus titkok — enélkül a konténer el sem indul

Ez a worker **másképp viselkedik, mint az UI**. A Next.js route-onként, lustán tölti be a
modulokat, tehát ott egy hiányzó titok legfeljebb egy oldalt buktat. A worker viszont a
**teljes ciklus-gráfot** (`runDispatchCycle` → `@/domain` → …) importálja induláskor, a
`resolveSecret` (`src/lib/crypto/secret-resolver.ts`) pedig prod alatt **import-időben dob**,
ha a titok hiányzik. Következmény: a Cloud Run revízió `container failed to start`-tal bukik,
és **nincs ciklus egyáltalán** — nem egy lépés hibázik némán.

Ezért az alábbiak **kötelezők**, és a deploy-szkript a build **előtt** ellenőrzi őket
(egyszerre listázza az összes hiányzót, nem egy Cloud Run crash-loop mögé rejtve):

| Env | Secret Manager név (`dispatch-cycle-service.env`) |
|---|---|
| `WRITE_GATE_SECRET` | `WRITE_GATE_SECRET_NAME` |
| `OAUTH_STATE_SECRET` | `OAUTH_STATE_SECRET_NAME` |
| `SANDBOX_PREVIEW_SECRET` | `SANDBOX_PREVIEW_SECRET_NAME` |
| `CHANNEL_LINK_TOKEN_SECRET` | `CHANNEL_LINK_TOKEN_SECRET_NAME` |
| `CHANNEL_IDENTITY_SECRET` | `CHANNEL_IDENTITY_SECRET_NAME` |
| `CHANNEL_APPROVAL_TOKEN_SECRET` | `CHANNEL_APPROVAL_TOKEN_SECRET_NAME` |
| `AGENT_API_KEY_LOOKUP_SECRET` | `AGENT_API_KEY_LOOKUP_SECRET_NAME` |

Az **értéküknek egyeznie kell az UI-éval** — különben a két szolgáltatás egymás
audit-hash-láncát, csatorna-linkjeit és jóváhagyó tokenjeit nem tudja ellenőrizni. Amelyik
titok még nem létezik a Secret Managerben (az `apphosting.yaml` nem mindet köti be), hozd
létre az UI-n használt értékkel:

```bash
gcloud secrets create CHANNEL_LINK_TOKEN_SECRET --project=$GCP_PROJECT_ID --replication-policy=automatic
printf '%s' "<az UI-n használt érték>" | gcloud secrets versions add CHANNEL_LINK_TOKEN_SECRET --data-file=-
```

Deploy előtti lokális ellenőrzés (ugyanazt a hibát adja, mint a Cloud Run indulása):

```bash
NODE_ENV=production DISPATCHER_CONTROL_TOKEN=… DATABASE_URL=… npm run dispatch-cycle:server
# hiány esetén: "[secret-resolver] Kötelező titok hiányzik prod alatt: …"
```

### 4.2 A ciklus tartalmához kötődő beállítások (nem boot-kritikusak)

Ezek nélkül a worker **elindul**, de az érintett lépés hibára fut és a következő körre marad:

- `DISPATCHER_CONTROL_TOKEN` — a végpont kapuja (egyezzen a Scheduler fejlécével). Enélkül a
  worker felmegy, de minden hívásra 401-et ad — a log induláskor figyelmeztet rá.
- `DATABASE_URL` (+ `DIRECT_URL`) — **ugyanaz a Neon adatbázis**, amit az UI lát. A
  database-mode (éles/teszt) a `platform_settings`-ből jön, tehát a worker automatikusan
  követi az admin felületen beállított módot.
- Modell-kulcsok (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`), `HARNESS_CALLBACK_TOKEN`,
  `HARNESS_AGENT_API_KEY`, `WORKSPACE_BUCKET`.

---

## 5. A Scheduler átirányítása

```bash
# infra/gcp/dispatch-cycle-scheduler.env
DISPATCH_CYCLE_TARGET_URL=https://platform-dispatch-cycle-xxxxx-ew.a.run.app
SCHEDULER_OIDC_SERVICE_ACCOUNT=dispatch-cycle-scheduler@<projekt>.iam.gserviceaccount.com

npm run dispatcher:cloud-scheduler-deploy
```

Ellenőrzés:

```bash
gcloud scheduler jobs describe dispatch-cycle-sweep \
  --project=$GCP_PROJECT_ID --location=$GCP_REGION --format='value(httpTarget.uri)'
# → https://platform-dispatch-cycle-…/api/v1/internal/dispatch-cycle
```

---

## 6. Rollback (egy lépés)

Nincs feature-flag a domain-kódban — a „flag" maga a Scheduler target URI:

```bash
npm run dispatcher:cloud-scheduler-deploy -- --rollback
```

Ez a `PLATFORM_API_URL`-re (control-plane UI) állítja vissza a targetet. A ciklus onnantól
újra az UI konténerében fut, a worker érintetlen marad (leállítható, vagy hagyható
`min-instances=0`-n, ahol nem kerül pénzbe). Visszakapcsolás: ugyanez a parancs kapcsoló
nélkül.

---

## 7. Verifikáció

CI (DB nélkül):

```bash
npm run test:dispatch-cycle-endpoint   # a HTTP-szerződés: 200 / 401 / 400 / 500
npm run test:public-routes             # a végpont a Clerk-kapun kívül marad
```

Éles / staging:

```bash
# Végponti smoke: 401 token nélkül, 200 + summary tokennel, és a dispatcher.last_cycle frissül.
# A DISPATCH_CYCLE_EXPECT_WORKER=1 azt is megköveteli, hogy a választ a dedikált worker adja
# (`x-dispatch-cycle-service: worker`), ne az UI — ez a spec elfogadási kritériuma.
DISPATCH_CYCLE_TARGET_URL=https://platform-dispatch-cycle-… \
DISPATCH_CYCLE_EXPECT_WORKER=1 \
DISPATCH_CYCLE_AUTH_BEARER="$(gcloud auth print-identity-token --audiences=https://platform-dispatch-cycle-…)" \
npm run dispatch-cycle:smoke

# Kézi Scheduler-trigger, majd az admin panelen (control-plane/system → Worker-folyamatok)
# az „Dispatch-ciklus" sornak friss, sikeres futást kell mutatnia.
gcloud scheduler jobs run dispatch-cycle-sweep --project=$GCP_PROJECT_ID --location=$GCP_REGION
```

Mérés (a spec elfogadási kritériuma): a UI p95 latency a ciklus futása alatt — baseline
(szétválasztás előtt) vs. utána. A két szolgáltatás külön néven fut, tehát a Cloud Run
memória/CPU/latency metrikák és az 5xx-ek is külön látszanak: a worker hibái többé nem
rontják az UI hibametrikáit.

---

## 8. Kapcsolódó fájlok

- `app/scripts/dispatch-cycle-server.ts` — a worker belépője (a végpontot szolgálja ki)
- `app/src/domain/dispatcher/dispatch-cycle-request.ts` — a közös HTTP-szerződés (auth,
  body, válaszburok) az UI route és a worker mögött
- `app/src/domain/dispatcher/run-dispatch-cycle.ts` — a közös ciklus-mag
- `app/src/app/api/v1/internal/dispatch-cycle/route.ts` — az UI-oldali (rollback) belépő
- `app/Dockerfile.dispatch-cycle`, `app/infra/gcp/deploy-dispatch-cycle-service.sh`,
  `dispatch-cycle-service.env.example`
- `app/scripts/dispatch-cycle-smoke.ts` — végponti smoke

# GCP Cloud Scheduler — stateless dispatch-ciklus (§5.7 kiegészítés)

> Kiváltja a `wiki-dispatcher` Cloud Run service `min-instances=1` üzemmódját. Kapcsolódó
> jegyzet: `CLOUD-RUN-DISPATCHER-SETUP.md` (az eredeti, állandóan futó worker).

---

## 1. Miért nem kell hozzá állandó process

A `wiki-dispatcher` service korábban azért futott folyamatosan (`min-instances=1
--no-cpu-throttling`), mert a Postgres `LISTEN/NOTIFY` kapcsolatot állandóan nyitva
kellett tartania. Két változás miatt ez már nem szükséges:

1. **A ready ticketek zöme azonnal, a keletkezésük kérésén belül dispatchelődik** — a
   playbook step-ticketek és a board-ticketek a platform webapp saját request-jéből hívják
   a `dispatchTicket`-et, launcher-módtól függetlenül (`docker-local`/`cloud-run-job`
   esetén ez fire-and-forget: konténer/Job indul, az eredmény külön callbacken jön vissza).
2. **A maradék biztonsági háló (stale-reclaim, ütemezett task materializálás,
   monitor-söprés, workspace-purge) egy stateless HTTP-végponton fut**:
   `POST /api/v1/internal/dispatch-cycle`. Ezt hívja ez a Cloud Scheduler job — a platform
   webapp (App Hosting, `minInstances=0`) csak a hívás idejére ébred fel, lefuttatja a
   ciklust, aztán visszaskálázódhat.

```
Cloud Scheduler (cron, pl. */2 * * * *)
   │  POST /api/v1/internal/dispatch-cycle
   │  header: x-dispatcher-token: $DISPATCHER_CONTROL_TOKEN
   ▼
Platform webapp (App Hosting, minInstances=0 — csak a hívás idejére fut)
   │
   ├─ stale-reclaim, ütemezett task materializálás, monitor-söprés, workspace-purge
   └─ dispatchReadyBatch (ha bármi kimaradt volna az azonnali útból)
```

---

## 2. Előfeltételek

- A platform már deployolva (Firebase App Hosting).
- A `DISPATCHER_CONTROL_TOKEN` secret létrehozva és bekötve az `apphosting.yaml`-ba
  (RUNTIME) — enélkül a végpont mindig 401-et ad:

  ```bash
  npx -y firebase-tools@latest apphosting:secrets:set DISPATCHER_CONTROL_TOKEN
  npx -y firebase-tools@latest apphosting:secrets:grantaccess DISPATCHER_CONTROL_TOKEN
  ```

  Ugyanezt az értéket használd a `dispatch-cycle-scheduler.env`-ben is (lásd lent) — a
  két oldalnak egyeznie kell.

- Cloud Scheduler API engedélyezve:

  ```bash
  gcloud services enable cloudscheduler.googleapis.com --project=$GCP_PROJECT_ID
  ```

---

## 3. Deploy

```bash
cd app
cp infra/gcp/dispatch-cycle-scheduler.env.example infra/gcp/dispatch-cycle-scheduler.env
# töltsd ki (GCP_PROJECT_ID, PLATFORM_API_URL, DISPATCHER_CONTROL_TOKEN, …)
npm run dispatcher:cloud-scheduler-deploy
```

A szkript (`infra/gcp/deploy-dispatch-cycle-scheduler.sh`) idempotens: ha a job már
létezik, frissíti (`jobs update http`), egyébként létrehozza (`jobs create http`).

---

## 4. Ellenőrzés

```bash
# Job állapot
gcloud scheduler jobs describe dispatch-cycle-sweep --project=$GCP_PROJECT_ID --location=$GCP_REGION

# Azonnali kézi trigger (nem kell megvárni a cron-t)
gcloud scheduler jobs run dispatch-cycle-sweep --project=$GCP_PROJECT_ID --location=$GCP_REGION

# Utolsó néhány futás/hiba
gcloud scheduler jobs describe dispatch-cycle-sweep --project=$GCP_PROJECT_ID --location=$GCP_REGION \
  --format="value(status)"
```

Az admin UI-n (`control-plane/system` → „Worker-folyamatok” panel) az „Dispatch-ciklus”
sor mindig mutatja az utolsó lefutást — függetlenül attól, hogy a Cloud Scheduler, a
lokális worker, vagy a „Ciklus futtatása most” gomb indította.

---

## 5. Be/ki kapcsolás és intervallum-állítás az admin UI-ból

A `dispatch-cycle-sweep` job szüneteltethető/folytatható és az intervalluma (percben)
állítható a `control-plane/system` → „Worker-folyamatok” panel „Cloud Scheduler” sorából
is, nem csak `gcloud`-dal vagy a Console-ból. Ehhez az App Hosting futásidejű service
accountjának IAM-jogot kell adni a Cloud Scheduler API-hoz — a Cloud Scheduler nem támogat
job-szintű (resource-level) IAM-et (ellentétben a Cloud Run service-ekkel), ezért ez egy
**projekt-szintű** binding. Least-privilege okból egy egyedi szerepkört hozunk létre a
beépített (túl tág) `roles/cloudscheduler.admin` helyett — ez csak a get/pause/resume/update
műveleteket engedi, a job törlését/létrehozását nem:

```bash
PROJECT=enterprise-ai-demo

# Egyedi, szűk-jogú szerepkör — csak amit az admin UI ténylegesen használ
gcloud iam roles create dispatchSchedulerOperator \
  --project=$PROJECT \
  --title="Dispatch Scheduler Operator" \
  --description="Get/pause/resume/update a dispatch-cycle-sweep Cloud Scheduler jobon" \
  --permissions=cloudscheduler.jobs.get,cloudscheduler.jobs.pause,cloudscheduler.jobs.resume,cloudscheduler.jobs.update \
  --stage=GA

# Kötés az App Hosting futásidejű service accountjához
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com" \
  --role="projects/${PROJECT}/roles/dispatchSchedulerOperator"
```

Ha ez a binding hiányzik, a panel „Cloud Scheduler” sora „Nem elérhető: ...403...” hibát
mutat — ez várható és biztonságos alapállapot, amíg nem futtatod le a fenti két parancsot.

Env-oldalon nincs új kötelező beállítás a meglévő Cloud Run admin blokkon felül
(`DISPATCHER_ADMIN_PROJECT_ID`, `DISPATCHER_ADMIN_REGION` — ugyanaz a projekt/régió) —
csak a `DISPATCHER_SCHEDULER_JOB_NAME` (alap: `dispatch-cycle-sweep`) az új env var, ha a
jobot más néven hoztad létre.

---

## 6. A régi Cloud Run service leállítása

Ha eddig a `wiki-dispatcher` service csak a LISTEN/cron miatt futott folyamatosan, most
már nullára skálázható (a Scheduler átveszi a biztonsági háló szerepét):

```bash
gcloud run services update wiki-dispatcher \
  --project=$GCP_PROJECT_ID --region=$GCP_REGION --min-instances=0
```

Ugyanez elérhető az admin UI-ból is (Cloud Run sor → „Leállítás”). A service maga nem kell
törölni — ha valaha vissza akarsz állni a folyamatos LISTEN/NOTIFY módra, elég
`--min-instances=1`-re visszaállítani.

---

## 7. Kapcsolódó fájlok

- `app/src/app/api/v1/internal/dispatch-cycle/route.ts` — a stateless végpont
- `app/src/domain/dispatcher/run-dispatch-cycle.ts` — a megosztott ciklus-logika (worker +
  végpont + admin UI kézi gomb közös magja)
- `app/src/domain/dispatcher/cloud-scheduler-admin.ts` — Cloud Scheduler admin API wrapper
  (get/pause/resume/update)
- `app/infra/gcp/deploy-dispatch-cycle-scheduler.sh`, `dispatch-cycle-scheduler.env.example`
- `app/src/app/control-plane/system/worker-processes-panel.tsx` — admin UI állapot, kézi
  trigger, Scheduler be/ki + intervallum

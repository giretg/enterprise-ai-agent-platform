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

## 5. A régi Cloud Run service leállítása

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

## 6. Kapcsolódó fájlok

- `app/src/app/api/v1/internal/dispatch-cycle/route.ts` — a stateless végpont
- `app/src/domain/dispatcher/run-dispatch-cycle.ts` — a megosztott ciklus-logika (worker +
  végpont + admin UI kézi gomb közös magja)
- `app/infra/gcp/deploy-dispatch-cycle-scheduler.sh`, `dispatch-cycle-scheduler.env.example`
- `app/src/app/control-plane/system/worker-processes-panel.tsx` — admin UI állapot + kézi trigger

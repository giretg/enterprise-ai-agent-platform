# GCP Cloud Scheduler — stateless dispatch-ciklus (§5.7 kiegészítés)

> Kiváltja a `wiki-dispatcher` Cloud Run service `min-instances=1` üzemmódját. Kapcsolódó
> jegyzetek: `CLOUD-RUN-DISPATCH-CYCLE-WORKER-SETUP.md` (a **cél** worker szolgáltatás,
> #114), `CLOUD-RUN-DISPATCHER-SETUP.md` (az eredeti, legacy állandóan futó worker).

> **#114 óta a job a dedikált worker szolgáltatást hívja, nem a control-plane UI-t.** A
> végpont és a hitelesítés változatlan (`POST /api/v1/internal/dispatch-cycle` +
> `x-dispatcher-token`) — csak a cél-URL más. Üzleti ok: eddig a ciklus és az interaktív
> oldalak ugyanabban a konténerben futottak, így egy nehéz kör lassította/OOM-olta a
> felületet, egy UI-csúcs pedig eltolta a ticket-feldolgozást.

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
   │  header: x-dispatcher-token: $DISPATCHER_CONTROL_TOKEN   (+ OIDC token)
   ▼
platform-dispatch-cycle worker (Cloud Run, min-instances=0 — csak a hívás idejére fut)
   │
   ├─ stale-reclaim, ütemezett task materializálás, monitor-söprés, workspace-purge
   ├─ channel-turn drain + channel-retention takarítás
   └─ dispatchReadyBatch (ha bármi kimaradt volna az azonnali útból)
```

A control-plane UI ugyanezt a végpontot továbbra is kiszolgálja — az a **rollback-út** és
a belső/kézi hívók címe —, csak a Scheduler forgalma nem ott megy át.

---

## 2. Előfeltételek

- A dedikált worker deployolva:
  `npm run dispatch-cycle:cloud-run-deploy`
  (lásd `CLOUD-RUN-DISPATCH-CYCLE-WORKER-SETUP.md`). A deploy kiírja a worker URL-jét —
  ez megy a `DISPATCH_CYCLE_TARGET_URL`-be.
- A hívó service account (`SCHEDULER_OIDC_SERVICE_ACCOUNT`) `roles/run.invoker` joggal a
  worker szolgáltatáson — a worker `--no-allow-unauthenticated`, tehát enélkül minden futás
  403-mal hal el, még helyes tokennel is.
- A platform (UI) is deployolva (Firebase App Hosting) — ez a rollback célja.
- A `DISPATCHER_CONTROL_TOKEN` secret létrehozva és bekötve **mindkét oldalon**, azonos
  értékkel — enélkül a végpont 401-et ad:

  ```bash
  # UI (App Hosting)
  npx -y firebase-tools@latest apphosting:secrets:set DISPATCHER_CONTROL_TOKEN
  npx -y firebase-tools@latest apphosting:secrets:grantaccess DISPATCHER_CONTROL_TOKEN
  # Worker: ugyanaz a Secret Manager secret, a dispatch-cycle-service.env
  # DISPATCHER_CONTROL_TOKEN_SECRET mezőjében hivatkozva.
  ```

  Ugyanezt az értéket használd a `dispatch-cycle-scheduler.env`-ben is (lásd lent).

- Cloud Scheduler API engedélyezve:

  ```bash
  gcloud services enable cloudscheduler.googleapis.com --project=$GCP_PROJECT_ID
  ```

---

## 3. Deploy

```bash
cd app
cp infra/gcp/dispatch-cycle-scheduler.env.example infra/gcp/dispatch-cycle-scheduler.env
# töltsd ki (GCP_PROJECT_ID, DISPATCH_CYCLE_TARGET_URL, SCHEDULER_OIDC_SERVICE_ACCOUNT,
#            PLATFORM_API_URL [rollback cél], DISPATCHER_CONTROL_TOKEN, …)
npm run dispatcher:cloud-scheduler-deploy
```

A szkript (`infra/gcp/deploy-dispatch-cycle-scheduler.sh`) idempotens: ha a job már
létezik, frissíti (`jobs update http`), egyébként létrehozza (`jobs create http`). Futáskor
kiírja, melyik célra állította a jobot.

### Rollback (egy lépés)

```bash
npm run dispatcher:cloud-scheduler-deploy -- --rollback
```

A target visszaáll a `PLATFORM_API_URL`-re (control-plane UI); a ciklus onnantól újra az UI
konténerében fut, a worker érintetlen marad. Nincs feature-flag a domain-kódban — a „flag"
maga a Scheduler target URI. Visszakapcsolás: ugyanez a parancs kapcsoló nélkül.

---

## 4. Ellenőrzés

```bash
# Job állapot
gcloud scheduler jobs describe dispatch-cycle-sweep --project=$GCP_PROJECT_ID --location=$GCP_REGION

# A CÉL ellenőrzése — a workerre kell mutatnia, nem az UI-ra (#114)
gcloud scheduler jobs describe dispatch-cycle-sweep --project=$GCP_PROJECT_ID --location=$GCP_REGION \
  --format='value(httpTarget.uri)'

# Azonnali kézi trigger (nem kell megvárni a cron-t)
gcloud scheduler jobs run dispatch-cycle-sweep --project=$GCP_PROJECT_ID --location=$GCP_REGION

# Utolsó néhány futás/hiba
gcloud scheduler jobs describe dispatch-cycle-sweep --project=$GCP_PROJECT_ID --location=$GCP_REGION \
  --format="value(status)"
```

Végponti smoke (401 token nélkül, 200 + summary tokennel, és a `dispatcher.last_cycle`
frissül ugyanabban az adatbázisban):

```bash
DISPATCH_CYCLE_TARGET_URL=<worker URL> npm run dispatch-cycle:smoke
```

Az admin UI-n (`control-plane/system` → „Worker-folyamatok” panel) az „Dispatch-ciklus”
sor mindig mutatja az utolsó lefutást — függetlenül attól, hogy a Cloud Scheduler (akár az
UI-n, akár a dedikált workeren keresztül), a lokális worker, vagy a „Ciklus futtatása most”
gomb indította. A Schedulerről indított kör forrása mindkét szolgáltatásnál `scheduler`,
mert a futást ugyanaz az ütemezés hajtja — csak a kiszolgáló konténer költözött.

A Dispatcher kill-switch (`dispatcher.controls`) a workeren is érvényes: a kapcsoló a
`platform_settings` táblából jön, amit mindkét szolgáltatás ugyanabból az (éles) branchből
olvas — incidensnél az admin felületről kikapcsolva a következő kör már nem indít újat.

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

## 6. A régi Cloud Run service

A `wiki-dispatcher` service korábban csak a LISTEN/cron miatt futott folyamatosan. A Scheduler
átvette a biztonsági háló szerepét, ezért a service **törölve lett** az `enterprise-ai-demo`
projektből (2026-07 állapot — `gcloud run services list` nem mutatja).

Ennek két következménye van:

- Az admin UI-ból eltűnt a „Cloud Run service (wiki-dispatcher)” sor, és vele együtt a
  `setCloudRunDispatcherScale` action, a `cloud-run-service-admin.ts` modul, valamint a
  `DISPATCHER_ADMIN_SERVICE_NAME` env-változó. Egy nem létező erőforráshoz nem adunk vezérlőt.
- Visszaállni nem `--min-instances=1`-gyel lehet, hanem újradeployolással:
  `bash infra/gcp/deploy-dispatcher-service.sh`. Vedd figyelembe, hogy onnantól a service
  folyamatosan fut, és nyitva tartja a Neon-kapcsolatot. A scale-vezérlést ilyenkor `gcloud`-dal
  végezd, vagy állítsd vissza a fenti UI-sort.

Fontos, hogy ez a **service** külön dolog a `wiki-harness` **Cloud Run Jobtól**: utóbbi él, és
ő futtatja az agenteket `HARNESS_LAUNCHER_MODE=cloud-run-job` mellett, ticketenként egy-egy
konténerben (scale-to-zero, csak futás közben kerül pénzbe).

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

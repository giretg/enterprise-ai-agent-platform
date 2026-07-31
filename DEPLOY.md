# Production deploy — Firebase App Hosting

A Next.js app az `app/` mappában fut. Firebase projekt: `enterprise-ai-demo` (`.firebaserc`).

## Előfeltételek

1. **Blaze pricing plan** a Firebase projekten ([upgrade](https://console.firebase.google.com/project/enterprise-ai-demo/overview?purchaseBillingPlan=metered))
2. **Neon Postgres** — pooled + direct URL (már beállítva dev-ben)
3. **Clerk** production instance kulcsok
4. **Gemini API key**

## 1. Secrets beállítása

Minden titkos env változót Cloud Secret Manager-ben tárolunk:

```bash
# Neon
npx -y firebase-tools@latest apphosting:secrets:set DATABASE_URL
npx -y firebase-tools@latest apphosting:secrets:set DIRECT_URL
npx -y firebase-tools@latest apphosting:secrets:set DATABASE_URL_TEST
npx -y firebase-tools@latest apphosting:secrets:set DIRECT_URL_TEST

# Neon branch restore (gyors éles→teszt szinkron — opcionális)
npx -y firebase-tools@latest apphosting:secrets:set NEON_API_KEY
npx -y firebase-tools@latest apphosting:secrets:set NEON_PROJECT_ID
npx -y firebase-tools@latest apphosting:secrets:set NEON_PRODUCTION_BRANCH_ID
npx -y firebase-tools@latest apphosting:secrets:set NEON_TEST_BRANCH_ID

# Gemini
npx -y firebase-tools@latest apphosting:secrets:set GEMINI_API_KEY

# Clerk
npx -y firebase-tools@latest apphosting:secrets:set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
npx -y firebase-tools@latest apphosting:secrets:set CLERK_SECRET_KEY
npx -y firebase-tools@latest apphosting:secrets:set CLERK_WEBHOOK_SIGNING_SECRET

# Fázis 2 — write-gate
npx -y firebase-tools@latest apphosting:secrets:set WRITE_GATE_SECRET
```

A backend hozzáférést kap automatikusan az `apphosting.yaml`-ban felsorolt secret-ekhez.

**Agent workspace (file editor):** a `WORKSPACE_BUCKET` és `GCS_SERVICE_ACCOUNT_EMAIL` plain env-ként szerepelnek az `apphosting.yaml`-ban (nem secret). GCS bucket + IAM: `app/infra/gcp/WORKSPACE-GCS-SETUP.md`.

## 2. DB migráció (Neon)

A deploy **előtt** futtasd lokálisan a pending Prisma migrációkat a Neon direct URL-lel.
Ha a kód új oszlopokat/táblákat vár, de a migráció kimarad, a Control Plane listák
(pl. munkatársak) elhasalnak — üresnek tűnnek, pedig az adat megvan.

```bash
cd app
npm run db:migrate:status   # mi van még hátra?
npm run db:migrate:deploy   # éles: csak pending migrációk (pl. 0019_agent_access_graph)
# Opcionális, csak új/üres környezetben:
# npm run db:backfill-audit
# npm run db:seed
```

`db:push` csak ad-hoc/dev séma-szinkronra való — élesen **ne** ezt használd a
verziózott migrációk helyett.

### Teszt adatbázis (Neon branch)

Az éles és teszt adat elkülönítéséhez hozz létre egy **Neon branch**-et (Neon Console → Branches → Create branch). A branch saját pooled + direct connection stringjei kerülnek a `DATABASE_URL_TEST` / `DIRECT_URL_TEST` secret-ekbe.

Teszt branch séma + seed (lokálisan, `.env.local`-ban a teszt URL-ekkel):

```bash
cd app
npm run db:push:test
npm run db:seed:test
```

Runtime váltás: **Control Plane → Rendszer → Adatbázis környezet**. A beállítás az éles branch `platform_settings` táblájában tárolódik; az alkalmazás adatai (ticketek, agentek, audit) a kiválasztott branch-en futnak. A dispatcher worker és más instance-ok ~15 mp-en belül követik a váltást.

**Teszt frissítése élesből:** ugyanitt a „Teszt frissítése éles adatokkal” gomb. Ha be vannak állítva a Neon API env-ek (`NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_*_BRANCH_ID`), branch restore (~1 mp); különben PostgreSQL tábla-másolás (fallback).

## 3. Deploy

```bash
# Firebase bejelentkezés (első alkalommal)
npx -y firebase-tools@latest login

# Deploy App Hosting backend
npx -y firebase-tools@latest deploy --only apphosting
```

Vagy a repó gyökeréből: `npm run deploy`

## 3.1 Dispatch-ciklus worker (dedikált Cloud Run szolgáltatás)

A háttérciklus — stale-reclaim, ütemezett task materializálás, monitor-söprés,
workspace-purge, channel-turn drain, channel-retention takarítás, ready ticketek
biztonsági dispatch-e — **nem** az App Hosting UI konténerében fut, hanem egy külön Cloud
Run szolgáltatásban (#114). Enélkül egy nehéz kör lassítja/OOM-olja az interaktív oldalakat,
egy UI-forgalmi csúcs pedig eltolja a ticket-feldolgozást.

A HTTP-szerződés mindkét oldalon azonos (`POST /api/v1/internal/dispatch-cycle` +
`x-dispatcher-token`), csak a Cloud Scheduler célja más:

```bash
cd app

# 1) Worker szolgáltatás (Dockerfile.dispatch-cycle → Cloud Run, --no-allow-unauthenticated)
cp infra/gcp/dispatch-cycle-service.env.example infra/gcp/dispatch-cycle-service.env
npm run dispatch-cycle:cloud-run-deploy      # a végén kiírja a worker URL-jét

# 2) A Cloud Scheduler átirányítása a workerre
cp infra/gcp/dispatch-cycle-scheduler.env.example infra/gcp/dispatch-cycle-scheduler.env
#   DISPATCH_CYCLE_TARGET_URL=<a fenti worker URL>
#   SCHEDULER_OIDC_SERVICE_ACCOUNT=<hívó SA, run.invoker joggal a workeren>
#   PLATFORM_API_URL=<az App Hosting UI URL-je — ez a rollback célja>
npm run dispatcher:cloud-scheduler-deploy

# 3) Ellenőrzés
DISPATCH_CYCLE_TARGET_URL=<worker URL> npm run dispatch-cycle:smoke
```

**Env-paritás:** a workernek ugyanaz a `DISPATCHER_CONTROL_TOKEN` és ugyanaz a Neon
adatbázis kell, mint az UI-nak — különben 401, illetve a ciklus más tenant-adaton dolgozna.
Részletek: `app/infra/gcp/CLOUD-RUN-DISPATCH-CYCLE-WORKER-SETUP.md`.

**Rollback (egy lépés):** `npm run dispatcher:cloud-scheduler-deploy -- --rollback` — a
Scheduler újra az UI-t hívja, a worker érintetlen marad.

**Névzavar:** a `deploy-dispatcher-service.sh` / `Dockerfile.dispatcher` egy **másik**,
legacy szolgáltatás (wiki-harness LISTEN/NOTIFY worker, `min-instances=1`) — nem ez.

## 4. Clerk webhook regisztrálás

A deploy után a production URL ismert. A Clerk Dashboard-on:

1. **Webhooks** → **Add Endpoint**
2. URL: `https://<your-app-hosting-url>/api/webhooks/clerk`
3. Events: `user.created`, `user.updated`
4. Signing secret → másold be a `CLERK_WEBHOOK_SIGNING_SECRET` secret-be

## 5. Clerk RBAC

Clerk Dashboard → Users → Public metadata:

```json
{ "role": "admin" }
```

Szerepek: `admin` | `approver` | `operator` | `viewer`

## 6. Ellenőrzés

1. Nyisd meg a Control Plane dashboardot
2. Sandbox: számla feldolgozás → ticket `awaiting_human`
3. Approver jóváhagyás → `done`
4. Audit log ellenőrzés

## Ismert korlátok (Fázis 1–2)

- **Dokumentum feltöltés:** lokális FS (`app/uploads/`) — Cloud Run-on ephemeral. Production-ben a feltöltött fájlok nem maradnak meg újraindítás után. Objektumtár: Fázis 3.
- **Write-gate:** issue + consume egy requestben (v1 ceremony) — TOCTOU védelem Fázis 2 későbbi lépés.
- **Guardrail / PII:** Fázis 2 — még nem implementált.

# GCP Sandbox App artifact storage — bucket setup

> Mini-app HTML artefaktok (`platform-sandbox-apps-{env}` bucket).
> A `sandbox_app_versions` tábla csak `artifactRef`-et tárol; a HTML a GCS-ben él.

---

## 1. Bucket létrehozás

```bash
PROJECT=enterprise-ai-demo
ENV=prod   # vagy staging / dev
BUCKET=platform-sandbox-apps-${ENV}
REGION=europe-west4

gcloud storage buckets create gs://${BUCKET} \
  --project=${PROJECT} \
  --location=${REGION} \
  --uniform-bucket-level-access \
  --public-access-prevention
```

**Object path séma:** `sandbox-apps/{tenantId}/{appId}/versions/{version}/index.html`

---

## 2. Service account és IAM

Ugyanaz a minta, mint a workspace bucketnél (`WORKSPACE-GCS-SETUP.md`):

```bash
SA=platform-workspace@${PROJECT}.iam.gserviceaccount.com
HOSTING_SA=firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com

gcloud storage buckets add-iam-policy-binding gs://${BUCKET} \
  --member="serviceAccount:${SA}" \
  --role="roles/storage.objectAdmin"

gcloud storage buckets add-iam-policy-binding gs://${BUCKET} \
  --member="serviceAccount:${HOSTING_SA}" \
  --role="roles/storage.objectAdmin"
```

App Hosting env (`apphosting.yaml`):

```env
SANDBOX_APP_BUCKET=platform-sandbox-apps-prod
```

A `WORKSPACE_BUCKET` és `GCS_SERVICE_ACCOUNT_EMAIL` mellett szerepel mindkét `apphosting.yaml`-ban.

---

## 3. Dev / acceptance

Lokálisan:

```env
FILE_EDITOR_STUB=true
# vagy explicit:
SANDBOX_APP_STUB=true
```

→ in-memory artifact store, GCS nélkül.

---

## 4. Gyakori hiba

| Tünet | Ok |
|-------|-----|
| `GCS upload failed: bucket "platform-sandbox-apps-prod" not found` | A bucket nincs létrehozva GCP-ben |
| `Unique constraint failed on (tenant_id, app_id, content_hash)` | Agent ugyanazzal a HTML-lel próbálkozott újra (javítva: idempotens visszatérés) |
| DB-ben van verzió, preview 404 | Korábbi bug: DB sor GCS feltöltés előtt jött létre (javítva: rollback + repair script) |

Árva verziók törlése (ha a HTML elveszett, az agent újra generálhatja):

```bash
npx tsx scripts/repair-orphaned-sandbox-versions.ts --app-id <uuid> --apply
```

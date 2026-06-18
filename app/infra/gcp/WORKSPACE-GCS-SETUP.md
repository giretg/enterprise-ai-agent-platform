# GCP Workspace Storage — bucket setup és lifecycle

> Agent file editor workspace fájlok (`platform-workspace-{env}` bucket).
> A Tool Broker app-szintű kvótát érvényesít (50 MB/fájl, 500 MB/workspace); a bucket lifecycle rule
> a GCS szintű 500 MB korlátot és a retention purge-t támogatja (§4.2, §5.3).

---

## 1. Bucket létrehozás

```bash
PROJECT=enterprise-ai-demo
ENV=prod   # vagy staging / dev
BUCKET=platform-workspace-${ENV}
REGION=europe-west4

gcloud storage buckets create gs://${BUCKET} \
  --project=${PROJECT} \
  --location=${REGION} \
  --uniform-bucket-level-access \
  --public-access-prevention
```

**Prefix séma:** `{tenantId}/{ticketId}/` — pl. `global/abc123.../notes/report.csv`

---

## 2. Service account és IAM

A Cloud Run (App Hosting backend) és a harness service account kapjon írási/olvasási jogot:

```bash
SA=platform-workspace@${PROJECT}.iam.gserviceaccount.com

gcloud storage buckets add-iam-policy-binding gs://${BUCKET} \
  --member="serviceAccount:${SA}" \
  --role="roles/storage.objectAdmin"
```

**Pre-signed URL aláíráshoz** (§5.2) a service account-nak kell `iam.serviceAccounts.signBlob`:

```bash
gcloud iam service-accounts add-iam-policy-binding ${SA} \
  --member="serviceAccount:${SA}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project=${PROJECT}
```

App Hosting / Cloud Run env:

```env
WORKSPACE_BUCKET=platform-workspace-prod
GCS_SERVICE_ACCOUNT_EMAIL=platform-workspace@enterprise-ai-demo.iam.gserviceaccount.com
```

Mindkét érték szerepel az `apphosting.yaml`-ban (root + `app/`), RUNTIME availability.

**App Hosting runtime SA** (`firebase-app-hosting-compute@enterprise-ai-demo.iam.gserviceaccount.com`):
- `roles/storage.objectAdmin` a bucketen (GCS read/write/list)
- `roles/iam.serviceAccountTokenCreator` a `platform-workspace@…` SA-n (pre-signed URL signBlob)

A workspace connector `secretAlias`: `platform/gcs-service-account` (Secret Manager, ha külön credential kell).

---

## 3. Lifecycle rule — 500 MB workspace korlát (§4.2)

Az app-szintű kvóta (`WORKSPACE_MAX_BYTES`, default 500 MB) minden írásnál ellenőrzött.
A GCS lifecycle rule **biztonsági hálóként** törölheti a túlzottan nagy objektumokat vagy
a lejárt prefixeket — az MVP-ben a retention purge főleg app-szinten fut (dispatcher worker).

**Ajánlott lifecycle JSON** (`workspace-lifecycle.json`):

```json
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": { "age": 30 }
    }
  ]
}
```

> A `gcloud storage buckets update --lifecycle-file` a `rule` tömböt várja közvetlenül — ne csomagold `"lifecycle"` kulcs alá, és ne használj `description` mezőt (InvalidUrlError).

Alkalmazás:

```bash
gcloud storage buckets update gs://${BUCKET} --lifecycle-file=workspace-lifecycle.json
```

> **Megjegyzés:** A ticket lezárása utáni 30 napos retention főleg az app `purgeExpiredWorkspaces`
> ciklusában fut (`dispatcher-worker.ts`). A GCS lifecycle rule ugyanarra az időablakra igazodik,
> de nem ticket-státusz alapú — csak objektum-kor alapú. Production-ben mindkettő ajánlott.

---

## 4. CORS (opcionális — pre-signed letöltés)

Ha a böngésző közvetlenül nyitja meg a pre-signed URL-t, a bucket CORS-ja általában nem kell
(új lap / letöltés). Ha same-origin fetch kellene:

```json
[
  {
    "origin": ["https://enterprise-ai-agent-platform--enterprise-ai-demo.europe-west4.hosted.app"],
    "method": ["GET", "HEAD"],
    "responseHeader": ["Content-Type", "Content-Disposition"],
    "maxAgeSeconds": 3600
  }
]
```

```bash
gcloud storage buckets update gs://${BUCKET} --cors-file=workspace-cors.json
```

---

## 5. Tenant offboarding (§5.3)

GDPR / tenant törlés: Control Plane → IAM → **Tenant offboarding** panel, vagy API:

```typescript
await purgeTenantWorkspaces(tenantId) // server action, admin role
```

Azonnali törlés: `{tenantId}/` prefix alatti összes objektum.

---

## 6. Dev / acceptance

Lokálisan és acceptance tesztben:

```env
FILE_EDITOR_STUB=true
```

→ in-memory storage, GCS nélkül. Pre-signed URL stub URL-t ad vissza.

Acceptance: `npm run test:acceptance` — `scenarioFileEditor`
E2E UI: `npm run test:e2e` — Playwright W7 (feltöltés + lista)

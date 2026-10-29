#!/usr/bin/env bash
# #1004 platform-chat worker — egyszeri infra + deploy (Cloud Run, Cloud Tasks, GCS).
# Használat nélkül $0: min-instance 0, nincs Load Balancer, nincs Redis (D11, D12, §8).
#
# Előfeltételek (Secret Manager, a platformmal KÖZÖS titok):
#   platform-chat-token-secret   — ≥32 karakter; a platform PLATFORM_CHAT_TOKEN_SECRET env-je is ez
#   platform-chat-database-url   — a platform_chat_worker szerep URL-je (ops/platform-chat/db-role.sql)
# A séma migrációját a séma-tulajdonos futtatja ELŐTTE:
#   (cd clients/platform-chat && PLATFORM_CHAT_MIGRATE_URL="$OWNER_URL" npm run migrate)
#
# Futtatás: PLATFORM_ORIGIN=https://app.example.com ops/platform-chat/deploy.sh
set -euo pipefail

PROJECT="${GOOGLE_CLOUD_PROJECT:-enterprise-ai-demo}"
REGION="${REGION:-europe-west4}"
SERVICE="${SERVICE:-platform-chat}"
QUEUE="${QUEUE:-platform-chat-steps}"
BUCKET="${BUCKET:-${PROJECT}-platform-chat-attachments}"
RUN_SA="platform-chat-run@${PROJECT}.iam.gserviceaccount.com"
TASKS_SA="platform-chat-tasks@${PROJECT}.iam.gserviceaccount.com"
: "${PLATFORM_ORIGIN:?PLATFORM_ORIGIN kell (a platform publikus originje)}"

gcloud config set project "$PROJECT" >/dev/null
gcloud services enable run.googleapis.com cloudtasks.googleapis.com storage.googleapis.com secretmanager.googleapis.com

for sa in platform-chat-run platform-chat-tasks; do
  gcloud iam service-accounts describe "${sa}@${PROJECT}.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$sa" --display-name "Platform-chat (${sa#platform-chat-})"
done

# Lépés-sor: lépésenként legfeljebb 4 kézbesítés (a motor a 3. hibánál közérthetően lezárja a fordulót).
gcloud tasks queues describe "$QUEUE" --location "$REGION" >/dev/null 2>&1 ||
  gcloud tasks queues create "$QUEUE" --location "$REGION"
gcloud tasks queues update "$QUEUE" --location "$REGION" \
  --max-attempts 4 --min-backoff 2s --max-backoff 30s --max-concurrent-dispatches 50

# Csatolmányok: tenant/beszélgetés prefix; törléskor a worker törli, árva fájl 400 nap után.
gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1 ||
  gcloud storage buckets create "gs://${BUCKET}" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
cat > /tmp/platform-chat-lifecycle.json <<'JSON'
{ "rule": [{ "action": { "type": "Delete" }, "condition": { "age": 400 } }] }
JSON
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file /tmp/platform-chat-lifecycle.json
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member "serviceAccount:${RUN_SA}" --role roles/storage.objectUser

# A worker feladatot tehet a sorba a Tasks SA nevében; a Tasks SA hívhatja a workert (OIDC).
gcloud tasks queues add-iam-policy-binding "$QUEUE" --location "$REGION" --member "serviceAccount:${RUN_SA}" --role roles/cloudtasks.enqueuer
gcloud iam service-accounts add-iam-policy-binding "$TASKS_SA" --member "serviceAccount:${RUN_SA}" --role roles/iam.serviceAccountUser
for secret in platform-chat-token-secret platform-chat-database-url; do
  gcloud secrets add-iam-policy-binding "$secret" --member "serviceAccount:${RUN_SA}" --role roles/secretmanager.secretAccessor >/dev/null
done

# Request-based számlázás, min=0. A böngésző közvetlenül a run.app címre csatlakozik (D16), ezért
# a szolgáltatás publikus; a saját végpontjai tokennel védettek (chat-token / Google OIDC).
gcloud run deploy "$SERVICE" \
  --source clients/platform-chat \
  --region "$REGION" \
  --service-account "$RUN_SA" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 5 \
  --concurrency 40 --cpu 1 --memory 512Mi --timeout 900 \
  --set-secrets "PLATFORM_CHAT_TOKEN_SECRET=platform-chat-token-secret:latest,PLATFORM_CHAT_DATABASE_URL=platform-chat-database-url:latest" \
  --set-env-vars "PLATFORM_ORIGIN=${PLATFORM_ORIGIN},GOOGLE_CLOUD_PROJECT=${PROJECT},PLATFORM_CHAT_TASKS_LOCATION=${REGION},PLATFORM_CHAT_TASKS_QUEUE=${QUEUE},PLATFORM_CHAT_TASKS_SA=${TASKS_SA},PLATFORM_CHAT_ATTACHMENTS_BUCKET=${BUCKET},PLATFORM_CHAT_SELF_URL=pending"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "PLATFORM_CHAT_SELF_URL=${URL}"
gcloud run services add-iam-policy-binding "$SERVICE" --region "$REGION" --member "serviceAccount:${TASKS_SA}" --role roles/run.invoker

# Költség-őr (WP-10): riasztás, ha a worker napi aktív instance-ideje szokatlanul magas.
cat > /tmp/platform-chat-alert.json <<JSON
{
  "displayName": "platform-chat: magas aktív instance-idő",
  "combiner": "OR",
  "conditions": [{
    "displayName": "billable instance time > 2h / nap",
    "conditionThreshold": {
      "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND metric.type=\"run.googleapis.com/container/billable_instance_time\"",
      "aggregations": [{ "alignmentPeriod": "86400s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM" }],
      "comparison": "COMPARISON_GT",
      "thresholdValue": 7200,
      "duration": "0s"
    }
  }]
}
JSON
gcloud alpha monitoring policies create --policy-from-file /tmp/platform-chat-alert.json || echo "Riasztás: hozd létre kézzel (gcloud alpha szükséges)."

echo
echo "Kész. A platform env-jébe (apphosting / Secret Manager):"
echo "  PLATFORM_CHAT_WORKER_URL=${URL}"
echo "  PLATFORM_CHAT_TOKEN_SECRET=<platform-chat-token-secret>"

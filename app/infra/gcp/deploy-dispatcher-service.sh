#!/usr/bin/env bash
# GCP Cloud Run SERVICE deploy — production dispatcher worker (Epik 5 / §5.7, §15.3)
#
# A dispatcher egy nem-LLM, eseményvezérelt work-queue worker (LISTEN/NOTIFY + cron).
# Folyamatos üzemhez Cloud Run service-ként fut min-instances ≥ 1 + always-on CPU
# (--no-cpu-throttling) mellett, és a runtime service accountjával indítja a
# wiki-harness Cloud Run Jobot (run.jobs.runWithOverrides).
#
# Előfeltétel:
#   - gcloud auth login (Owner / elég jog a deployhoz)
#   - Artifact Registry repo (ugyanaz mint a harness: ai-platform)
#   - a wiki-harness Cloud Run Job már deployolva (npm run harness:cloud-run-deploy)
#   - dedikált runtime SA, amelyen run.jobs.runWithOverrides van a Jobon (lásd lent)
#
# Használat:
#   cp infra/gcp/dispatcher-service.env.example infra/gcp/dispatcher-service.env
#   # szerkeszd a dispatcher-service.env-t
#   npm run dispatcher:cloud-run-deploy
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${DISPATCHER_SERVICE_ENV:-$ROOT_DIR/infra/gcp/dispatcher-service.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — másold le dispatcher-service.env.example-ből." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID required}"
: "${GCP_REGION:?GCP_REGION required}"
: "${DISPATCHER_SERVICE_NAME:?DISPATCHER_SERVICE_NAME required}"
: "${ARTIFACT_REGISTRY_REPO:?ARTIFACT_REGISTRY_REPO required}"
: "${SERVICE_ACCOUNT:?SERVICE_ACCOUNT required (runtime SA a Job indításához)}"
: "${PLATFORM_API_URL:?PLATFORM_API_URL required}"
: "${HARNESS_CLOUD_RUN_JOB_NAME:?HARNESS_CLOUD_RUN_JOB_NAME required}"
: "${DATABASE_URL_SECRET:?DATABASE_URL_SECRET required (Secret Manager név DB connection stringhez)}"

IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)}"
IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${ARTIFACT_REGISTRY_REPO}/${DISPATCHER_SERVICE_NAME}:${IMAGE_TAG}"

echo "[deploy] building dispatcher image via Cloud Build (native linux/amd64): $IMAGE"
# Cloud Run linux/amd64-et futtat; Apple Siliconon a lokális docker build arm64-et
# gyártana (lásd a harness deploy jegyzetét), ezért natív amd64 Cloud Build-del építünk.
BUILD_CONFIG="$(mktemp)"
cat > "$BUILD_CONFIG" <<YAML
steps:
- name: gcr.io/cloud-builders/docker
  args: ['build','--platform=linux/amd64','-f','Dockerfile.dispatcher','-t','$IMAGE','.']
images: ['$IMAGE']
options:
  machineType: E2_HIGHCPU_8
timeout: 1200s
YAML
gcloud builds submit "$ROOT_DIR" --project="$GCP_PROJECT_ID" --config="$BUILD_CONFIG"
rm -f "$BUILD_CONFIG"

# Env-vars: a launcher cloud-run-job módban a metadata-token fallbackot használja,
# tehát a runtime SA tokenjével indít — explicit bearer NEM kell.
DEPLOY_ARGS=(
  run deploy "$DISPATCHER_SERVICE_NAME"
  --project="$GCP_PROJECT_ID"
  --region="$GCP_REGION"
  --image="$IMAGE"
  --service-account="$SERVICE_ACCOUNT"
  --min-instances=1
  --max-instances="${MAX_INSTANCES:-1}"
  --no-cpu-throttling
  --no-allow-unauthenticated
  --cpu="${SERVICE_CPU:-1}"
  --memory="${SERVICE_MEMORY:-512Mi}"
  --port=8080
  --set-env-vars="HARNESS_LAUNCHER_MODE=cloud-run-job"
  --set-env-vars="HARNESS_CLOUD_RUN_PROJECT_ID=${GCP_PROJECT_ID}"
  --set-env-vars="HARNESS_CLOUD_RUN_LOCATION=${GCP_REGION}"
  --set-env-vars="HARNESS_CLOUD_RUN_JOB_NAME=${HARNESS_CLOUD_RUN_JOB_NAME}"
  --set-env-vars="PLATFORM_API_URL=${PLATFORM_API_URL}"
  --set-env-vars="MODEL_GATEWAY_URL=${MODEL_API_URL:-${PLATFORM_API_URL}/api/v1/gateway/v1}"
  --set-env-vars="HARNESS_CALLBACK_URL=${HARNESS_CALLBACK_URL:-${PLATFORM_API_URL}}"
  --set-env-vars="HARNESS_MODE=${HARNESS_MODE:-goose}"
  --set-env-vars="HARNESS_RECIPE_PATH=${HARNESS_RECIPE_PATH:-/recipes/wiki-answer.yaml}"
  --set-env-vars="HARNESS_EGRESS_ENFORCE=${HARNESS_EGRESS_ENFORCE:-true}"
  --set-env-vars="DISPATCHER_POLL_INTERVAL_MS=${DISPATCHER_POLL_INTERVAL_MS:-30000}"
  --set-env-vars="DISPATCHER_BATCH_LIMIT=${DISPATCHER_BATCH_LIMIT:-10}"
)

# DB connection: LISTEN/NOTIFY-hoz NEM-pooler (direct) kapcsolat kell — Secret Managerből.
# A worker DIRECT_URL ?? DATABASE_URL sorrendben olvas.
SECRET_ARGS=("DIRECT_URL=${DATABASE_URL_SECRET}:latest" "DATABASE_URL=${DATABASE_URL_SECRET}:latest")

# Harness callback token (a Jobnak override-on át adjuk tovább) — Secret Managerből.
if [[ -n "${HARNESS_CALLBACK_TOKEN_SECRET:-}" ]]; then
  SECRET_ARGS+=("HARNESS_CALLBACK_TOKEN=${HARNESS_CALLBACK_TOKEN_SECRET}:latest")
fi

# Agent API key — a goose harness ezzel hív vissza a platformra (Tool Broker + Gateway).
# A launcher process.env.HARNESS_AGENT_API_KEY-t ad tovább a Job-override-ban.
if [[ -n "${HARNESS_AGENT_API_KEY_SECRET:-}" ]]; then
  SECRET_ARGS+=("HARNESS_AGENT_API_KEY=${HARNESS_AGENT_API_KEY_SECRET}:latest")
fi

DEPLOY_ARGS+=(--set-secrets="$(IFS=,; echo "${SECRET_ARGS[*]}")")

if [[ "${STUB_BROKER_FALLBACK:-}" == "1" ]]; then
  DEPLOY_ARGS+=(--set-env-vars="HARNESS_STUB_BROKER_FALLBACK=1")
fi

# VPC egress (opcionális — ha a DB / platform VPC-n belül érhető el).
if [[ -n "${VPC_CONNECTOR:-}" ]]; then
  DEPLOY_ARGS+=(--vpc-connector="$VPC_CONNECTOR")
  DEPLOY_ARGS+=(--vpc-egress="${VPC_EGRESS:-private-ranges-only}")
fi

echo "[deploy] gcloud ${DEPLOY_ARGS[*]}"
gcloud "${DEPLOY_ARGS[@]}"

echo ""
echo "[deploy] KÉSZ. A runtime SA-nak jogot kell adni a wiki-harness Job indításához:"
echo "  gcloud run jobs add-iam-policy-binding $HARNESS_CLOUD_RUN_JOB_NAME \\"
echo "    --project=$GCP_PROJECT_ID --region=$GCP_REGION \\"
echo "    --member=serviceAccount:$SERVICE_ACCOUNT --role=roles/run.developer"
echo ""
echo "[deploy] és a secretekhez:"
echo "  gcloud secrets add-iam-policy-binding $DATABASE_URL_SECRET \\"
echo "    --project=$GCP_PROJECT_ID \\"
echo "    --member=serviceAccount:$SERVICE_ACCOUNT --role=roles/secretmanager.secretAccessor"
echo ""
echo "[deploy] státusz:"
echo "  gcloud run services describe $DISPATCHER_SERVICE_NAME --region=$GCP_REGION --project=$GCP_PROJECT_ID"

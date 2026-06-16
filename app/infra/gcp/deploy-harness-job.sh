#!/usr/bin/env bash
# GCP Cloud Run Job deploy — wiki harness (Epik 5 / S1-S4)
#
# Előfeltétel: gcloud auth login, Artifact Registry repo, VPC connector (opcionális egress-hez)
# Használat:
#   cp infra/gcp/harness-job.env.example infra/gcp/harness-job.env
#   # szerkeszd a harness-job.env-t
#   npm run harness:cloud-run-deploy
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${HARNESS_JOB_ENV:-$ROOT_DIR/infra/gcp/harness-job.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — másold le harness-job.env.example-ből." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID required}"
: "${GCP_REGION:?GCP_REGION required}"
: "${HARNESS_JOB_NAME:?HARNESS_JOB_NAME required}"
: "${ARTIFACT_REGISTRY_REPO:?ARTIFACT_REGISTRY_REPO required}"
: "${PLATFORM_API_URL:?PLATFORM_API_URL required}"
: "${HARNESS_CALLBACK_TOKEN:?HARNESS_CALLBACK_TOKEN required}"

IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)}"
IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${ARTIFACT_REGISTRY_REPO}/${HARNESS_JOB_NAME}:${IMAGE_TAG}"

echo "[deploy] building harness image via Cloud Build (native linux/amd64): $IMAGE"
# Cloud Run linux/amd64-et futtat. Apple Siliconon a lokális `docker build` arm64-et
# gyártana (buildx nélkül a --platform sem segít), amitől a konténer kimenet nélkül
# elszáll ("Application failed to start"). Cloud Build natívan amd64-en épít.
BUILD_CONFIG="$(mktemp)"
cat > "$BUILD_CONFIG" <<YAML
steps:
- name: gcr.io/cloud-builders/docker
  args: ['build','--platform=linux/amd64','-f','Dockerfile.harness','-t','$IMAGE','.']
images: ['$IMAGE']
options:
  machineType: E2_HIGHCPU_8
timeout: 1200s
YAML
gcloud builds submit "$ROOT_DIR" --project="$GCP_PROJECT_ID" --config="$BUILD_CONFIG"
rm -f "$BUILD_CONFIG"

DEPLOY_ARGS=(
  run jobs deploy "$HARNESS_JOB_NAME"
  --project="$GCP_PROJECT_ID"
  --region="$GCP_REGION"
  --image="$IMAGE"
  --tasks=1
  --parallelism=1
  --max-retries=0
  --task-timeout="${TASK_TIMEOUT:-30m}"
  --cpu="${JOB_CPU:-1}"
  --memory="${JOB_MEMORY:-1Gi}"
  --set-env-vars="HARNESS_MODE=${HARNESS_MODE:-goose}"
  --set-env-vars="HARNESS_RECIPE_PATH=${HARNESS_RECIPE_PATH:-/recipes/wiki-answer.yaml}"
  --set-env-vars="PLATFORM_API_URL=${PLATFORM_API_URL}"
  --set-env-vars="MODEL_GATEWAY_URL=${MODEL_API_URL:-${PLATFORM_API_URL}/api/v1/gateway/v1}"
  --set-env-vars="HARNESS_CALLBACK_URL=${HARNESS_CALLBACK_URL:-${PLATFORM_API_URL}}"
  --set-env-vars="HARNESS_EGRESS_ENFORCE=${HARNESS_EGRESS_ENFORCE:-true}"
  --set-env-vars="HARNESS_EGRESS_PROBE_URL=${HARNESS_EGRESS_PROBE_URL:-https://example.com}"
)

if [[ -n "${HARNESS_STUB_BROKER_FALLBACK:-}" ]]; then
  DEPLOY_ARGS+=(--set-env-vars="HARNESS_STUB_BROKER_FALLBACK=${HARNESS_STUB_BROKER_FALLBACK}")
fi

if [[ -n "${VPC_CONNECTOR:-}" ]]; then
  DEPLOY_ARGS+=(--vpc-connector="$VPC_CONNECTOR")
  DEPLOY_ARGS+=(--vpc-egress="${VPC_EGRESS:-all-traffic}")
  echo "[deploy] VPC connector: $VPC_CONNECTOR (egress=${VPC_EGRESS:-all-traffic})"
  echo "[deploy] FONTOS: a VPC subnet firewall-ján csak a platform + Gateway/Broker hostok legyenek engedélyezve (deny-by-default)."
fi

if [[ -n "${SERVICE_ACCOUNT:-}" ]]; then
  DEPLOY_ARGS+=(--service-account="$SERVICE_ACCOUNT")
fi

echo "[deploy] gcloud ${DEPLOY_ARGS[*]}"
gcloud "${DEPLOY_ARGS[@]}"

echo "[deploy] Cloud Run Job secret (callback token) — Secret Manager-be tedd, ne plain env-be production-ben:"
echo "  gcloud secrets create harness-callback-token --replication-policy=automatic"
echo "  echo -n '$HARNESS_CALLBACK_TOKEN' | gcloud secrets versions add harness-callback-token --data-file=-"
echo ""
echo "[deploy] Dispatcher env (.env):"
echo "  HARNESS_LAUNCHER_MODE=cloud-run-job"
echo "  HARNESS_CLOUD_RUN_PROJECT_ID=$GCP_PROJECT_ID"
echo "  HARNESS_CLOUD_RUN_LOCATION=$GCP_REGION"
echo "  HARNESS_CLOUD_RUN_JOB_NAME=$HARNESS_JOB_NAME"
echo "  PLATFORM_API_URL=$PLATFORM_API_URL"
echo "  HARNESS_CALLBACK_URL=${HARNESS_CALLBACK_URL:-$PLATFORM_API_URL}"
echo "  HARNESS_CALLBACK_TOKEN=<ugyanaz mint a platformon>"

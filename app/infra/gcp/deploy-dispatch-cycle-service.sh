#!/usr/bin/env bash
# Deploy a dedicated Cloud Run service for the stateless dispatch cycle.
# The service runs the same Next.js application and exposes the existing
# POST /api/v1/internal/dispatch-cycle endpoint, but with an independent
# CPU/memory/scaling profile from the Firebase App Hosting UI.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${DISPATCH_CYCLE_SERVICE_ENV:-$ROOT_DIR/infra/gcp/dispatch-cycle-service.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE - copy dispatch-cycle-service.env.example and fill it in." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID required}"
: "${GCP_REGION:?GCP_REGION required}"
: "${DISPATCH_CYCLE_SERVICE_NAME:?DISPATCH_CYCLE_SERVICE_NAME required}"
: "${DISPATCHER_CONTROL_TOKEN_SECRET:?DISPATCHER_CONTROL_TOKEN_SECRET required}"
: "${DATABASE_URL_SECRET:?DATABASE_URL_SECRET required}"
: "${DIRECT_URL_SECRET:?DIRECT_URL_SECRET required}"

CPU="${CPU:-1}"
MEMORY="${MEMORY:-1Gi}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-3}"
TIMEOUT="${TIMEOUT:-300s}"
CONCURRENCY="${CONCURRENCY:-1}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"

ARGS=(
  run deploy "$DISPATCH_CYCLE_SERVICE_NAME"
  --project="$GCP_PROJECT_ID"
  --region="$GCP_REGION"
  --source="$ROOT_DIR"
  --no-allow-unauthenticated
  --cpu="$CPU"
  --memory="$MEMORY"
  --min-instances="$MIN_INSTANCES"
  --max-instances="$MAX_INSTANCES"
  --timeout="$TIMEOUT"
  --concurrency="$CONCURRENCY"
  --set-secrets="DISPATCHER_CONTROL_TOKEN=${DISPATCHER_CONTROL_TOKEN_SECRET}:latest,DATABASE_URL=${DATABASE_URL_SECRET}:latest,DIRECT_URL=${DIRECT_URL_SECRET}:latest"
  --set-env-vars="NODE_ENV=production"
)

if [[ -n "$SERVICE_ACCOUNT" ]]; then
  ARGS+=(--service-account="$SERVICE_ACCOUNT")
fi

if [[ -n "${EXTRA_SECRETS:-}" ]]; then
  ARGS+=(--update-secrets="$EXTRA_SECRETS")
fi

if [[ -n "${EXTRA_ENV_VARS:-}" ]]; then
  ARGS+=(--update-env-vars="$EXTRA_ENV_VARS")
fi

gcloud "${ARGS[@]}"

SERVICE_URL="$(gcloud run services describe "$DISPATCH_CYCLE_SERVICE_NAME" \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" \
  --format='value(status.url)')"

echo ""
echo "Dedicated dispatch-cycle service deployed: $SERVICE_URL"
echo "Set DISPATCH_CYCLE_TARGET_URL=$SERVICE_URL in dispatch-cycle-scheduler.env"
echo "Then redeploy the Scheduler job with deploy-dispatch-cycle-scheduler.sh"

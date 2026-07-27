#!/usr/bin/env bash
# GCP Cloud Scheduler deploy - stateless dispatch cycle.
# The scheduler targets the dedicated Cloud Run worker service by default.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${DISPATCH_CYCLE_SCHEDULER_ENV:-$ROOT_DIR/infra/gcp/dispatch-cycle-scheduler.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE - copy dispatch-cycle-scheduler.env.example and fill it in." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID required}"
: "${GCP_REGION:?GCP_REGION required}"
: "${SCHEDULER_JOB_NAME:?SCHEDULER_JOB_NAME required}"
: "${DISPATCH_CYCLE_TARGET_URL:?DISPATCH_CYCLE_TARGET_URL required}"
: "${DISPATCHER_CONTROL_TOKEN:?DISPATCHER_CONTROL_TOKEN required}"

SCHEDULE="${SCHEDULE:-*/2 * * * *}"
TIME_ZONE="${TIME_ZONE:-Etc/UTC}"
ATTEMPT_DEADLINE="${ATTEMPT_DEADLINE:-60s}"
TARGET_URI="${DISPATCH_CYCLE_TARGET_URL%/}/api/v1/internal/dispatch-cycle"

COMMON_ARGS=(
  --project="$GCP_PROJECT_ID"
  --location="$GCP_REGION"
  --schedule="$SCHEDULE"
  --time-zone="$TIME_ZONE"
  --uri="$TARGET_URI"
  --http-method=POST
  --headers="x-dispatcher-token=${DISPATCHER_CONTROL_TOKEN},Content-Type=application/json"
  --message-body="{}"
  --attempt-deadline="$ATTEMPT_DEADLINE"
)

if [[ -n "${OIDC_SERVICE_ACCOUNT_EMAIL:-}" ]]; then
  COMMON_ARGS+=(--oidc-service-account-email="$OIDC_SERVICE_ACCOUNT_EMAIL")
  COMMON_ARGS+=(--oidc-token-audience="${OIDC_TOKEN_AUDIENCE:-${DISPATCH_CYCLE_TARGET_URL%/}}")
fi

if gcloud scheduler jobs describe "$SCHEDULER_JOB_NAME" \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" >/dev/null 2>&1; then
  echo "[deploy] updating existing job: $SCHEDULER_JOB_NAME"
  gcloud scheduler jobs update http "$SCHEDULER_JOB_NAME" "${COMMON_ARGS[@]}"
else
  echo "[deploy] creating job: $SCHEDULER_JOB_NAME"
  gcloud scheduler jobs create http "$SCHEDULER_JOB_NAME" "${COMMON_ARGS[@]}"
fi

echo ""
echo "Scheduler target: $TARGET_URI"
echo "Run now: gcloud scheduler jobs run $SCHEDULER_JOB_NAME --project=$GCP_PROJECT_ID --location=$GCP_REGION"
echo "Rollback: set DISPATCH_CYCLE_TARGET_URL to the UI URL and rerun this script."

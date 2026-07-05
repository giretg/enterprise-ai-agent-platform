#!/usr/bin/env bash
# GCP Cloud Scheduler deploy — stateless dispatch-ciklus időzítés (§5.7 kiegészítés)
#
# A wiki-dispatcher Cloud Run service (min-instances=1, állandóan nyitva tartott Neon-
# kapcsolat) helyett ez a job percenként/N percenként meghívja a platform webapp
# POST /api/v1/internal/dispatch-cycle végpontját — a webapp (minInstances=0) csak a
# hívás idejére ébred fel, lefuttatja a ciklust (stale-reclaim, ütemezett task
# materializálás, monitor-söprés, workspace-purge, ready ticketek dispatchelése), és
# visszaskálázódhat. Nincs perzisztens kapcsolat, nincs örökké futó folyamat.
#
# Előfeltétel:
#   - gcloud auth login (a Cloud Scheduler Admin szerepkörrel)
#   - A platform már deployolva (App Hosting), és a DISPATCHER_CONTROL_TOKEN secret be van
#     kötve az apphosting.yaml-ba (RUNTIME) — enélkül a végpont mindig 401-et ad.
#   - Cloud Scheduler API engedélyezve a projektben:
#       gcloud services enable cloudscheduler.googleapis.com --project=$GCP_PROJECT_ID
#
# Használat:
#   cp infra/gcp/dispatch-cycle-scheduler.env.example infra/gcp/dispatch-cycle-scheduler.env
#   # szerkeszd a dispatch-cycle-scheduler.env-t
#   npm run dispatcher:cloud-scheduler-deploy
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${DISPATCH_CYCLE_SCHEDULER_ENV:-$ROOT_DIR/infra/gcp/dispatch-cycle-scheduler.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — másold le dispatch-cycle-scheduler.env.example-ből." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID required}"
: "${GCP_REGION:?GCP_REGION required}"
: "${SCHEDULER_JOB_NAME:?SCHEDULER_JOB_NAME required}"
: "${PLATFORM_API_URL:?PLATFORM_API_URL required}"
: "${DISPATCHER_CONTROL_TOKEN:?DISPATCHER_CONTROL_TOKEN required (egyezzen a platform secretjével)}"

SCHEDULE="${SCHEDULE:-*/2 * * * *}"
TIME_ZONE="${TIME_ZONE:-Etc/UTC}"
ATTEMPT_DEADLINE="${ATTEMPT_DEADLINE:-60s}"
TARGET_URI="${PLATFORM_API_URL%/}/api/v1/internal/dispatch-cycle"

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

if gcloud scheduler jobs describe "$SCHEDULER_JOB_NAME" \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" >/dev/null 2>&1; then
  echo "[deploy] meglévő job frissítése: $SCHEDULER_JOB_NAME"
  gcloud scheduler jobs update http "$SCHEDULER_JOB_NAME" "${COMMON_ARGS[@]}"
else
  echo "[deploy] új job létrehozása: $SCHEDULER_JOB_NAME"
  gcloud scheduler jobs create http "$SCHEDULER_JOB_NAME" "${COMMON_ARGS[@]}"
fi

echo ""
echo "[deploy] KÉSZ. Ellenőrzés:"
echo "  gcloud scheduler jobs describe $SCHEDULER_JOB_NAME --project=$GCP_PROJECT_ID --location=$GCP_REGION"
echo ""
echo "[deploy] Azonnali kipróbálás (a admin UI 'Ciklus futtatása most' gombja ugyanezt hívja, csak in-process):"
echo "  gcloud scheduler jobs run $SCHEDULER_JOB_NAME --project=$GCP_PROJECT_ID --location=$GCP_REGION"
echo ""
echo "[deploy] Ha eddig a wiki-dispatcher Cloud Run service (min-instances=1) futott csak"
echo "  emiatt, most már leállítható — a control-plane/system 'Worker-folyamatok' panelen a"
echo "  Cloud Run sor 'Leállítás' gombjával (minScale=0), vagy:"
echo "  gcloud run services update wiki-dispatcher --project=$GCP_PROJECT_ID --region=$GCP_REGION --min-instances=0"

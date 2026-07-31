#!/usr/bin/env bash
# GCP Cloud Scheduler deploy — stateless dispatch-ciklus időzítés (§5.7 kiegészítés, #114)
#
# A job percenként/N percenként meghívja a `POST /api/v1/internal/dispatch-cycle` végpontot,
# ami lefuttat egy ciklust (stale-reclaim, ütemezett task materializálás, monitor-söprés,
# workspace-purge, channel-turn drain, ready ticket dispatch), és visszatér. Nincs perzisztens
# kapcsolat, nincs örökké futó folyamat.
#
# #114 ÓTA: a job a DEDIKÁLT WORKER szolgáltatást célozza (`DISPATCH_CYCLE_TARGET_URL`), nem a
# control-plane UI-t. Üzleti ok: eddig a ciklus és az interaktív oldalak ugyanabban a
# konténerben futottak — egy nehéz kör lassította/OOM-olta a felületet, egy UI-csúcs pedig
# eltolta a ticket-feldolgozást. A végpont és a hitelesítés VÁLTOZATLAN, csak a cél-URL más.
#
# ROLLBACK (egy lépés): a target visszairányítása az UI-ra, a worker érintése nélkül —
#   npm run dispatcher:cloud-scheduler-deploy -- --rollback
# ilyenkor a `PLATFORM_API_URL` (App Hosting UI) lesz a cél. Nincs feature-flag a
# domain-kódban: a „flag" maga a Scheduler target URI.
#
# Előfeltétel:
#   - gcloud auth login (a Cloud Scheduler Admin szerepkörrel)
#   - A cél szolgáltatás deployolva, és a DISPATCHER_CONTROL_TOKEN ugyanazzal az értékkel
#     bekötve (worker: npm run dispatch-cycle:cloud-run-deploy; UI: apphosting.yaml RUNTIME)
#     — enélkül a végpont mindig 401-et ad.
#   - Cloud Scheduler API engedélyezve a projektben:
#       gcloud services enable cloudscheduler.googleapis.com --project=$GCP_PROJECT_ID
#   - Ha a worker `--no-allow-unauthenticated` (alapértelmezés): SCHEDULER_OIDC_SERVICE_ACCOUNT
#     beállítva, és annak `roles/run.invoker` joga van a worker szolgáltatáson.
#
# Használat:
#   cp infra/gcp/dispatch-cycle-scheduler.env.example infra/gcp/dispatch-cycle-scheduler.env
#   # szerkeszd a dispatch-cycle-scheduler.env-t
#   npm run dispatcher:cloud-scheduler-deploy
#
set -euo pipefail

ROLLBACK_TO_UI=0
for arg in "$@"; do
  case "$arg" in
    --rollback) ROLLBACK_TO_UI=1 ;;
    *) echo "Ismeretlen kapcsoló: $arg (támogatott: --rollback)" >&2; exit 2 ;;
  esac
done

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
: "${PLATFORM_API_URL:?PLATFORM_API_URL required (a control-plane UI URL-je — a rollback célja)}"
: "${DISPATCHER_CONTROL_TOKEN:?DISPATCHER_CONTROL_TOKEN required (egyezzen a cél szolgáltatás secretjével)}"

# A cél alapesetben a dedikált worker; rollbacknél (vagy ha nincs worker beállítva) az UI.
if [[ "$ROLLBACK_TO_UI" == "1" ]]; then
  TARGET_BASE_URL="$PLATFORM_API_URL"
  TARGET_LABEL="control-plane UI (ROLLBACK)"
elif [[ -n "${DISPATCH_CYCLE_TARGET_URL:-}" ]]; then
  TARGET_BASE_URL="$DISPATCH_CYCLE_TARGET_URL"
  TARGET_LABEL="dedikált dispatch-cycle worker"
else
  TARGET_BASE_URL="$PLATFORM_API_URL"
  TARGET_LABEL="control-plane UI (nincs DISPATCH_CYCLE_TARGET_URL beállítva)"
  echo "[deploy] FIGYELEM: DISPATCH_CYCLE_TARGET_URL nincs beállítva — a ciklus az UI"
  echo "         konténerében fut, tehát terheli az interaktív oldalakat (#114)."
fi

SCHEDULE="${SCHEDULE:-*/2 * * * *}"
TIME_ZONE="${TIME_ZONE:-Etc/UTC}"
ATTEMPT_DEADLINE="${ATTEMPT_DEADLINE:-60s}"
TARGET_URI="${TARGET_BASE_URL%/}/api/v1/internal/dispatch-cycle"

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

# A dedikált worker NEM publikus (--no-allow-unauthenticated), ezért a Schedulernek OIDC
# tokent is küldenie kell — a megosztott titok fejléc emellett marad (két független kapu:
# a Cloud Run IAM beengedi, a végpont pedig a tokent is megköveteli).
if [[ -n "${SCHEDULER_OIDC_SERVICE_ACCOUNT:-}" ]]; then
  COMMON_ARGS+=(
    --oidc-service-account-email="$SCHEDULER_OIDC_SERVICE_ACCOUNT"
    --oidc-token-audience="${SCHEDULER_OIDC_AUDIENCE:-$TARGET_BASE_URL}"
  )
elif [[ "$ROLLBACK_TO_UI" != "1" && -n "${DISPATCH_CYCLE_TARGET_URL:-}" ]]; then
  echo "[deploy] FIGYELEM: a worker célja OIDC nélkül van beállítva. Ha a szolgáltatás"
  echo "         --no-allow-unauthenticated (alapértelmezés), MINDEN futás 403-mal hal el."
  echo "         Állítsd be a SCHEDULER_OIDC_SERVICE_ACCOUNT-ot, és adj neki run.invoker jogot."
fi

echo "[deploy] cél: $TARGET_LABEL"
echo "[deploy] URI: $TARGET_URI"

if gcloud scheduler jobs describe "$SCHEDULER_JOB_NAME" \
  --project="$GCP_PROJECT_ID" --location="$GCP_REGION" >/dev/null 2>&1; then
  echo "[deploy] meglévő job frissítése: $SCHEDULER_JOB_NAME"
  gcloud scheduler jobs update http "$SCHEDULER_JOB_NAME" "${COMMON_ARGS[@]}"
else
  echo "[deploy] új job létrehozása: $SCHEDULER_JOB_NAME"
  gcloud scheduler jobs create http "$SCHEDULER_JOB_NAME" "${COMMON_ARGS[@]}"
fi

echo ""
echo "[deploy] KÉSZ. Ellenőrzés (a targetnek a fenti URI-t kell mutatnia):"
echo "  gcloud scheduler jobs describe $SCHEDULER_JOB_NAME --project=$GCP_PROJECT_ID --location=$GCP_REGION --format='value(httpTarget.uri)'"
echo ""
echo "[deploy] Azonnali kipróbálás (az admin UI 'Ciklus futtatása most' gombja ugyanezt a"
echo "  ciklust hívja, csak az UI processzében, in-process):"
echo "  gcloud scheduler jobs run $SCHEDULER_JOB_NAME --project=$GCP_PROJECT_ID --location=$GCP_REGION"
echo ""
echo "[deploy] Végponti smoke (tokennel POST a célra + dispatcher.last_cycle ellenőrzés):"
echo "  DISPATCH_CYCLE_TARGET_URL=$TARGET_BASE_URL npm run dispatch-cycle:smoke"
if [[ "$ROLLBACK_TO_UI" == "1" ]]; then
  echo ""
  echo "[deploy] ROLLBACK aktív: a ciklus újra az UI konténerében fut. Visszakapcsolás a"
  echo "  workerre: npm run dispatcher:cloud-scheduler-deploy (kapcsoló nélkül)."
fi

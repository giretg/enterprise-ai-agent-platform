#!/usr/bin/env bash
# GCP Cloud Run SERVICE deploy — dedikált dispatch-ciklus worker (#114)
#
# MIÉRT: eddig a Cloud Scheduler a control-plane UI publikus URL-jét hívta, tehát a ciklus
# (stale-reclaim, ütemezett task materializálás, monitor-söprés, workspace-purge,
# channel-turn drain, ready ticket dispatch — LLM-hívásokkal) ugyanabban a konténerben
# futott, mint az interaktív oldalak. Egy nehéz kör lassította/OOM-olta a felületet; egy
# UI-csúcs eltolta a ticket-feldolgozást. Ez a szolgáltatás ugyanazt a végpontot szolgálja
# ki külön néven, saját CPU/memória profillal és saját skálázással.
#
# SZERZŐDÉS (változatlan): POST /api/v1/internal/dispatch-cycle + x-dispatcher-token fejléc,
# válasz DispatchCycleSummary. A domain-mag (runDispatchCycle) ugyanaz, mint az UI-n.
#
# EZ NEM a legacy wiki-dispatcher! Az a `deploy-dispatcher-service.sh` + `Dockerfile.dispatcher`
# (LISTEN/NOTIFY, min-instances=1, állandó Neon-kapcsolat). Ez itt stateless, scale-to-zero
# képes worker.
#
# Előfeltétel:
#   - gcloud auth login (elég jog a Cloud Run deployhoz)
#   - Artifact Registry repo (ugyanaz mint a harness: ai-platform)
#   - DISPATCHER_CONTROL_TOKEN + DB URL Secret Managerben, a runtime SA-nak
#     secretAccessor joggal (a szkript a végén kiírja a parancsokat)
#
# Használat:
#   cp infra/gcp/dispatch-cycle-service.env.example infra/gcp/dispatch-cycle-service.env
#   # szerkeszd a dispatch-cycle-service.env-t
#   npm run dispatch-cycle:cloud-run-deploy
#
# A deploy UTÁN a Scheduler targetjét át kell állítani erre a szolgáltatásra:
#   DISPATCH_CYCLE_TARGET_URL=<a lent kiírt worker URL> az infra/gcp/dispatch-cycle-scheduler.env-ben
#   npm run dispatcher:cloud-scheduler-deploy
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${DISPATCH_CYCLE_SERVICE_ENV:-$ROOT_DIR/infra/gcp/dispatch-cycle-service.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — másold le dispatch-cycle-service.env.example-ből." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID required}"
: "${GCP_REGION:?GCP_REGION required}"
: "${DISPATCH_CYCLE_SERVICE_NAME:?DISPATCH_CYCLE_SERVICE_NAME required}"
: "${ARTIFACT_REGISTRY_REPO:?ARTIFACT_REGISTRY_REPO required}"
: "${SERVICE_ACCOUNT:?SERVICE_ACCOUNT required (runtime SA)}"
: "${DISPATCHER_CONTROL_TOKEN_SECRET:?DISPATCHER_CONTROL_TOKEN_SECRET required (Secret Manager név)}"
: "${DATABASE_URL_SECRET:?DATABASE_URL_SECRET required (Secret Manager név a DB connection stringhez)}"

IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)}"
IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${ARTIFACT_REGISTRY_REPO}/${DISPATCH_CYCLE_SERVICE_NAME}:${IMAGE_TAG}"

echo "[deploy] building dispatch-cycle image via Cloud Build (native linux/amd64): $IMAGE"
# Cloud Run linux/amd64-et futtat; Apple Siliconon a lokális docker build arm64-et gyártana.
BUILD_CONFIG="$(mktemp)"
cat > "$BUILD_CONFIG" <<YAML
steps:
- name: gcr.io/cloud-builders/docker
  args: ['build','--platform=linux/amd64','-f','Dockerfile.dispatch-cycle','-t','$IMAGE','.']
images: ['$IMAGE']
options:
  machineType: E2_HIGHCPU_8
timeout: 1200s
YAML
gcloud builds submit "$ROOT_DIR" --project="$GCP_PROJECT_ID" --config="$BUILD_CONFIG"
rm -f "$BUILD_CONFIG"

# Erőforrás-profil: a ciklus igényéhez szabva, az UI App Hosting profiljától FÜGGETLENÜL.
# min-instances=0 az alap: a ciklus percenkénti, rövid — nincs értelme állandóan égetni.
# Ha a hidegindítás a Scheduler attempt-deadline-jét feszegeti, emeld 1-re.
DEPLOY_ARGS=(
  run deploy "$DISPATCH_CYCLE_SERVICE_NAME"
  --project="$GCP_PROJECT_ID"
  --region="$GCP_REGION"
  --image="$IMAGE"
  --service-account="$SERVICE_ACCOUNT"
  --min-instances="${MIN_INSTANCES:-0}"
  --max-instances="${MAX_INSTANCES:-2}"
  --cpu="${SERVICE_CPU:-1}"
  --memory="${SERVICE_MEMORY:-1Gi}"
  # Egy ciklus egyszerre fut a processzben (a runDispatchCycle in-flight kapuja miatt) —
  # a párhuzamos kérések amúgy is csak üres summary-t kapnának.
  --concurrency="${SERVICE_CONCURRENCY:-1}"
  # A kérés-timeout legyen ≥ a Scheduler ATTEMPT_DEADLINE-ja, különben a Cloud Run vágja el
  # a ciklust, mielőtt a Scheduler feladná.
  --timeout="${REQUEST_TIMEOUT:-300s}"
  --port=8080
  # A worker NEM publikus: csak a Scheduler (OIDC) és a jogosult belső hívók érhetik el.
  --no-allow-unauthenticated
)

# A ciklus alatti szolgáltatások (dispatcher, ütemezett taskok, monitor, channel-turn,
# channel-retention, workspace purge) env-paritása az UI-jal. Ami itt nincs beállítva, az
# a workeren egyszerűen hiányzik — pl. HARNESS_* nélkül a ticket-indítás elbukik.
ENV_VARS=("NODE_ENV=production")

# `set -e` alatt a `[[ … ]] && arr+=(…)` forma egy hamis feltételnél KILÉPTETNÉ a szkriptet
# (az && lista 1-gyel tér vissza) — ezért függvény + if, nem egysoros rövidzár.
append_env_if_set() {
  local name="$1"
  local value="${!name:-}"
  if [[ -n "$value" ]]; then ENV_VARS+=("${2:-$name}=${value}"); fi
}

append_env_if_set DISPATCHER_BATCH_LIMIT
append_env_if_set PLATFORM_API_URL
append_env_if_set HARNESS_LAUNCHER_MODE
append_env_if_set HARNESS_CALLBACK_URL
append_env_if_set MODEL_GATEWAY_URL
append_env_if_set WORKSPACE_BUCKET
append_env_if_set GCS_SERVICE_ACCOUNT_EMAIL

if [[ -n "${HARNESS_CLOUD_RUN_JOB_NAME:-}" ]]; then
  ENV_VARS+=(
    "HARNESS_CLOUD_RUN_PROJECT_ID=${GCP_PROJECT_ID}"
    "HARNESS_CLOUD_RUN_LOCATION=${GCP_REGION}"
    "HARNESS_CLOUD_RUN_JOB_NAME=${HARNESS_CLOUD_RUN_JOB_NAME}"
  )
fi

if [[ -n "${EXTRA_ENV_VARS:-}" ]]; then ENV_VARS+=("${EXTRA_ENV_VARS}"); fi

DEPLOY_ARGS+=(--set-env-vars="$(IFS=,; echo "${ENV_VARS[*]}")")

# Titkok. A DISPATCHER_CONTROL_TOKEN-nek EGYEZNIE kell a Scheduler job fejlécével és az UI
# oldali secrettel — különben a célzott hívás 401-et kap.
# A DB ugyanaz a Neon adatbázis, mint az UI-é (ugyanaz a tenant-adat, ugyanaz a
# database-mode beállítás a platform_settings táblából).
SECRET_ARGS=(
  "DISPATCHER_CONTROL_TOKEN=${DISPATCHER_CONTROL_TOKEN_SECRET}:latest"
  "DATABASE_URL=${DATABASE_URL_SECRET}:latest"
  "DIRECT_URL=${DIRECT_URL_SECRET:-$DATABASE_URL_SECRET}:latest"
)

append_secret_if_set() {
  local env_name="$1"
  local var_name="$2"
  local secret="${!var_name:-}"
  if [[ -n "$secret" ]]; then SECRET_ARGS+=("${env_name}=${secret}:latest"); fi
}

append_secret_if_set DATABASE_URL_TEST DATABASE_URL_TEST_SECRET
append_secret_if_set DIRECT_URL_TEST DIRECT_URL_TEST_SECRET
append_secret_if_set GEMINI_API_KEY GEMINI_API_KEY_SECRET
append_secret_if_set OPENROUTER_API_KEY OPENROUTER_API_KEY_SECRET
append_secret_if_set HARNESS_CALLBACK_TOKEN HARNESS_CALLBACK_TOKEN_SECRET
append_secret_if_set HARNESS_AGENT_API_KEY HARNESS_AGENT_API_KEY_SECRET
append_secret_if_set WRITE_GATE_SECRET WRITE_GATE_SECRET_NAME
append_secret_if_set AGENT_API_KEY_LOOKUP_SECRET AGENT_API_KEY_LOOKUP_SECRET_NAME

DEPLOY_ARGS+=(--set-secrets="$(IFS=,; echo "${SECRET_ARGS[*]}")")

# VPC egress (opcionális — ha a DB / platform VPC-n belül érhető el).
if [[ -n "${VPC_CONNECTOR:-}" ]]; then
  DEPLOY_ARGS+=(--vpc-connector="$VPC_CONNECTOR")
  DEPLOY_ARGS+=(--vpc-egress="${VPC_EGRESS:-private-ranges-only}")
fi

echo "[deploy] gcloud ${DEPLOY_ARGS[*]}"
gcloud "${DEPLOY_ARGS[@]}"

SERVICE_URL="$(gcloud run services describe "$DISPATCH_CYCLE_SERVICE_NAME" \
  --project="$GCP_PROJECT_ID" --region="$GCP_REGION" --format='value(status.url)')"

echo ""
echo "[deploy] KÉSZ. Worker URL: $SERVICE_URL"
echo ""
echo "[deploy] 1) A runtime SA-nak secretAccessor jog kell a titkokhoz:"
for secret in "$DISPATCHER_CONTROL_TOKEN_SECRET" "$DATABASE_URL_SECRET"; do
  echo "  gcloud secrets add-iam-policy-binding $secret \\"
  echo "    --project=$GCP_PROJECT_ID \\"
  echo "    --member=serviceAccount:$SERVICE_ACCOUNT --role=roles/secretmanager.secretAccessor"
done
echo ""
echo "[deploy] 2) A Cloud Scheduler hívó SA-jának run.invoker jog kell (a worker nem publikus):"
echo "  gcloud run services add-iam-policy-binding $DISPATCH_CYCLE_SERVICE_NAME \\"
echo "    --project=$GCP_PROJECT_ID --region=$GCP_REGION \\"
echo "    --member=serviceAccount:\${SCHEDULER_OIDC_SERVICE_ACCOUNT} --role=roles/run.invoker"
echo ""
echo "[deploy] 3) A Scheduler átirányítása erre a szolgáltatásra:"
echo "  # infra/gcp/dispatch-cycle-scheduler.env:"
echo "  DISPATCH_CYCLE_TARGET_URL=$SERVICE_URL"
echo "  SCHEDULER_OIDC_SERVICE_ACCOUNT=<hívó SA>"
echo "  npm run dispatcher:cloud-scheduler-deploy"
echo ""
echo "[deploy] Rollback (a Scheduler visszamutat az UI-ra, a worker érintetlen marad):"
echo "  npm run dispatcher:cloud-scheduler-deploy -- --rollback"
echo ""
echo "[deploy] státusz:"
echo "  gcloud run services describe $DISPATCH_CYCLE_SERVICE_NAME --region=$GCP_REGION --project=$GCP_PROJECT_ID"

#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID kötelező}"
REGION="${CODE_SANDBOX_REGION:-europe-west1}"
SERVICE="${CODE_SANDBOX_SERVICE:-enterprise-code-sandbox}"
IMAGE="${CODE_SANDBOX_IMAGE:-${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/enterprise-ai/${SERVICE}:latest}"

gcloud builds submit --project "$GCP_PROJECT_ID" --config infra/gcp/cloudbuild-code-sandbox.yaml --substitutions "_IMAGE=$IMAGE" .
gcloud beta run deploy "$SERVICE" \
  --project "$GCP_PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE" \
  --sandbox-launcher \
  --no-allow-unauthenticated \
  --cpu-throttling \
  --min-instances 0 \
  --max-instances "${CODE_SANDBOX_MAX_INSTANCES:-3}" \
  --concurrency 1 \
  --timeout 900 \
  --cpu "${CODE_SANDBOX_CPU:-1}" \
  --memory "${CODE_SANDBOX_MEMORY:-512Mi}"

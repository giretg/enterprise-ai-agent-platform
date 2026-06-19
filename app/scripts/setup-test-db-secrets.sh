#!/usr/bin/env bash
# Firebase App Hosting teszt DB secret-ek — Cloud Secret Manager (gcloud).
# Forrás: app/.env.local → DATABASE_URL_TEST, DIRECT_URL_TEST
set -euo pipefail

PROJECT="${FIREBASE_PROJECT:-enterprise-ai-demo}"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Hiányzik: $ENV_FILE" >&2
  exit 1
fi

get_env() {
  local key=$1
  local line
  line=$(grep -E "^${key}=" "$ENV_FILE" | tail -1)
  line=${line#*=}
  line=${line#\"}
  line=${line%\"}
  printf '%s' "$line"
}

DATABASE_URL_TEST=$(get_env DATABASE_URL_TEST)
DIRECT_URL_TEST=$(get_env DIRECT_URL_TEST)

if [[ -z "$DATABASE_URL_TEST" || -z "$DIRECT_URL_TEST" ]]; then
  echo "DATABASE_URL_TEST és DIRECT_URL_TEST kötelező a .env.local-ban" >&2
  exit 1
fi

grant_apphosting_access() {
  local name=$1
  gcloud secrets add-iam-policy-binding "$name" --project="$PROJECT" \
    --member="serviceAccount:firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor" --quiet >/dev/null 2>&1 || true
  gcloud secrets add-iam-policy-binding "$name" --project="$PROJECT" \
    --member="serviceAccount:firebase-app-hosting-compute@${PROJECT}.iam.gserviceaccount.com" \
    --role="roles/secretmanager.viewer" --quiet >/dev/null 2>&1 || true
  gcloud secrets add-iam-policy-binding "$name" --project="$PROJECT" \
    --member="serviceAccount:service-346824017066@gcp-sa-firebaseapphosting.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretVersionManager" --quiet >/dev/null 2>&1 || true
}

upsert_secret() {
  local name=$1
  local value=$2
  if gcloud secrets describe "$name" --project="$PROJECT" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --project="$PROJECT" --data-file=-
    echo "✓ $name — új verzió"
  else
    printf '%s' "$value" | gcloud secrets create "$name" --project="$PROJECT" \
      --replication-policy=automatic --data-file=-
    grant_apphosting_access "$name"
    echo "✓ $name — létrehozva + App Hosting IAM"
  fi
}

echo "Projekt: $PROJECT"
upsert_secret DATABASE_URL_TEST "$DATABASE_URL_TEST"
upsert_secret DIRECT_URL_TEST "$DIRECT_URL_TEST"
echo "Kész."

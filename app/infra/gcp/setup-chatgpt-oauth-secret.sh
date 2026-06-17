#!/usr/bin/env bash
# S2 — ChatGPT OAuth tokenek feltöltése Secret Managerbe az éles, beágyazott
# mediációhoz. A secret payload = a lokális ~/.codex/auth.json tartalma
# ("Sign in with ChatGPT" tokenek). A beágyazott provider lejáratkor frissít és
# ÚJ verziót ír vissza (write-back) — ezért a runtime SA-nak accessor ÉS
# version-adder jog is kell.
#
# Használat:
#   GCP_PROJECT=enterprise-ai-demo \
#   APP_HOSTING_SA=<backend-runtime-sa-email> \
#   [CODEX_AUTH_FILE=~/.codex/auth.json] [SECRET_NAME=CHATGPT_OAUTH_TOKENS] \
#   npm run s2:secret-setup        # = bash infra/gcp/setup-chatgpt-oauth-secret.sh
#
# A runtime SA megkeresése (Firebase App Hosting backend):
#   gcloud iam service-accounts list --project "$GCP_PROJECT" | grep -i apphosting
set -euo pipefail

PROJECT="${GCP_PROJECT:?GCP_PROJECT kötelező (pl. enterprise-ai-demo)}"
SA="${APP_HOSTING_SA:?APP_HOSTING_SA kötelező — az App Hosting backend runtime service account email-je}"
SECRET_NAME="${SECRET_NAME:-CHATGPT_OAUTH_TOKENS}"
AUTH_FILE="${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"

if [[ ! -f "$AUTH_FILE" ]]; then
  echo "HIBA: nincs auth file: $AUTH_FILE — jelentkezz be: codex login (Sign in with ChatGPT)" >&2
  exit 1
fi

# Sanity: tartalmazza-e a kötelező mezőket
if ! grep -q '"access_token"' "$AUTH_FILE" || ! grep -q '"refresh_token"' "$AUTH_FILE"; then
  echo "HIBA: $AUTH_FILE nem tartalmaz access_token/refresh_token mezőt" >&2
  exit 1
fi

echo "Projekt:    $PROJECT"
echo "Secret:     $SECRET_NAME"
echo "Auth file:  $AUTH_FILE"
echo "Runtime SA: $SA"
echo

# 1) Secret létrehozása, ha még nincs
if ! gcloud secrets describe "$SECRET_NAME" --project "$PROJECT" >/dev/null 2>&1; then
  echo "Secret létrehozása…"
  gcloud secrets create "$SECRET_NAME" --project "$PROJECT" --replication-policy=automatic
fi

# 2) Új verzió a tokenekkel
echo "Token-verzió feltöltése…"
gcloud secrets versions add "$SECRET_NAME" --project "$PROJECT" --data-file="$AUTH_FILE"

# 3) IAM: accessor (olvasás) + version-adder (write-back a refresh-eléshez)
echo "IAM jogosultságok megadása a runtime SA-nak…"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" --project "$PROJECT" \
  --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" --project "$PROJECT" \
  --member="serviceAccount:${SA}" --role="roles/secretmanager.secretVersionAdder"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
echo
echo "KÉSZ. Állítsd be az apphosting.yaml-ban:"
echo "  CHATGPT_OAUTH_TOKEN_SECRET = projects/${PROJECT_NUMBER}/secrets/${SECRET_NAME}"
echo "  CHATGPT_OAUTH_EMBEDDED     = true   (és kommenteld ki a CHATGPT_OAUTH_STUB-ot)"

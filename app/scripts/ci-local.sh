#!/usr/bin/env bash
# A GitHub CI (.github/workflows/ci.yml) app-jobjainak helyi futtatása — push előtt,
# lokálisan vagy a Claude Code felhőkonténerben. A teszt-listát a ci.yml-ből olvassa,
# így nem csúszik el a CI-tól.
#
#   npm run ci:local            # verify + db
#   npm run ci:local -- verify  # lint, tsc, prisma validate, import-boundary, stub-DB tesztek
#   npm run ci:local -- db      # eldobható `ci` Postgres DB: migrate deploy + valódi-DB tesztek
#
# A `db` részhez futó Postgres kell (npm run dev:setup elindítja). A `ci` adatbázist
# minden futás elején eldobja és újra létrehozza — a dev adatbázishoz nem nyúl.
# CI_DATABASE_URL-lel felülírható (alap: postgresql://platform:platform@127.0.0.1:5432/ci).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI_YML="$APP_DIR/../.github/workflows/ci.yml"
cd "$APP_DIR"

MODE="${1:-all}"
case "$MODE" in all|verify|db) ;; *) echo "Használat: ci-local.sh [all|verify|db]" >&2; exit 2 ;; esac

log() { printf '\033[1;34m[ci-local]\033[0m %s\n' "$*"; }

# A ci.yml egy jobjának `npm run test:*` parancsai, sorrendben.
job_tests() {
  awk -v job="  $1:" '
    $0 == job { inside = 1; next }
    inside && /^  [a-zA-Z0-9_-]+:$/ { exit }
    inside { if (match($0, /npm run test:[a-zA-Z0-9:_-]+/)) print substr($0, RSTART + 8, RLENGTH - 8) }
  ' "$CI_YML"
}

FAILED=()
run_tests() {
  for script in "$@"; do
    if npm run -s "$script" >/tmp/ci-local-$$.log 2>&1; then
      printf '  \033[32mOK\033[0m   %s\n' "$script"
    else
      printf '  \033[31mFAIL\033[0m %s\n' "$script"
      tail -20 /tmp/ci-local-$$.log | sed 's/^/       /'
      FAILED+=("$script")
    fi
  done
  rm -f /tmp/ci-local-$$.log
}

if [ "$MODE" != db ]; then
  log "verify job (stub DB)"
  (
    export NODE_ENV=test
    export DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub
    export DIRECT_URL=$DATABASE_URL
    npx prisma validate >/dev/null
    npm run -s lint
    npx tsc --noEmit
    npm run -s test:import-boundary >/dev/null
  ) || FAILED+=("lint/tsc/prisma validate/import-boundary")
  mapfile -t VERIFY_TESTS < <(job_tests verify)
  log "${#VERIFY_TESTS[@]} stub-DB teszt"
  NODE_ENV=test DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub \
    DIRECT_URL=postgresql://stub:stub@127.0.0.1:5432/stub run_tests "${VERIFY_TESTS[@]}"
fi

if [ "$MODE" != verify ]; then
  CI_DATABASE_URL="${CI_DATABASE_URL:-postgresql://platform:platform@127.0.0.1:5432/ci}"
  ADMIN_URL="$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/postgres"; console.log(u.toString())' "$CI_DATABASE_URL")"
  CI_DB_NAME="$(node -e 'console.log(new URL(process.argv[1]).pathname.slice(1))' "$CI_DATABASE_URL")"
  log "eldobható DB újralétrehozása: $CI_DB_NAME"
  psql -q -v ON_ERROR_STOP=1 "$ADMIN_URL" -c "SET client_min_messages = warning" -c "DROP DATABASE IF EXISTS \"$CI_DB_NAME\" WITH (FORCE)" -c "CREATE DATABASE \"$CI_DB_NAME\""
  export NODE_ENV=test CI=true DATABASE_URL="$CI_DATABASE_URL" DIRECT_URL="$CI_DATABASE_URL"
  log "prisma migrate deploy"
  npx prisma migrate deploy >/dev/null
  mapfile -t DB_TESTS < <(job_tests migrations)
  log "${#DB_TESTS[@]} valódi-Postgres teszt"
  run_tests "${DB_TESTS[@]}"
fi

if [ "${#FAILED[@]}" -gt 0 ]; then
  log "Elbukott: ${FAILED[*]}"
  exit 1
fi
log "Minden zöld."

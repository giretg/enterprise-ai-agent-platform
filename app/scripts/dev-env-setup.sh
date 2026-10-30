#!/usr/bin/env bash
# Futtatható fejlesztői/teszt környezet egy paranccsal — Claude Code felhőkonténerben
# (claude.ai/code) és lokálisan is. Idempotens: többször futtatva csak a hiányzót pótolja.
#
#  1. Postgres: ha a DATABASE_URL (.env.local) nem lokális, nem nyúl hozzá; különben
#     elindítja a gépen lévő Postgres 16-ot (pg_ctlcluster), vagy Dockerben egy postgres:16-ot.
#  2. .env.local: ha nincs, lokális DB-vel, Clerk nélküli dev-belépéssel és stubokkal írja meg.
#  3. npm ci (ha nincs node_modules), prisma migrate deploy, seed, dev-belépés jogosultság.
#  4. --start: elindítja a dev szervert a háttérben (log: .data/dev-server.log) és megvárja.
#
# Használat (app/ könyvtárból):  npm run dev:setup            # csak előkészít
#                                npm run dev:setup -- --start # + dev szerver a 3000-es porton
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

START_SERVER=0
for arg in "$@"; do
  case "$arg" in
    --start) START_SERVER=1 ;;
    *) echo "Ismeretlen kapcsoló: $arg" >&2; exit 2 ;;
  esac
done

PORT="${PORT:-3000}"
LOCAL_DB_USER=platform
LOCAL_DB_PASSWORD=platform
LOCAL_DB_NAME=platform_dev
LOCAL_DB_URL="postgresql://${LOCAL_DB_USER}:${LOCAL_DB_PASSWORD}@127.0.0.1:5432/${LOCAL_DB_NAME}"

log() { printf '\033[1;34m[dev-setup]\033[0m %s\n' "$*"; }

# ── 1. .env.local ───────────────────────────────────────────────────────────────
if [ ! -f .env.local ]; then
  log ".env.local létrehozása (lokális Postgres, Clerk nélküli dev-belépés, stubok)"
  cat > .env.local <<EOF
# Generálta: scripts/dev-env-setup.sh — lokális/felhős fejlesztői környezet.
DATABASE_URL=${LOCAL_DB_URL}
DIRECT_URL=${LOCAL_DB_URL}

# Clerk nélkül: DevAuthProvider, belépés nélkül admin + superadmin (db:seed:dev-login).
AUTH_DISABLED=true
DEV_AUTH_USER_ID=dev-user-001
DEV_AUTH_EMAIL=dev@excellence.ai
DEV_AUTH_NAME="Dev Admin"
DEV_AUTH_ROLE=admin

# Külső szolgáltatások helyett stubok (nincs kimenő hívás, nincs kulcs).
FILE_EDITOR_STUB=true
GOOGLE_DRIVE_API_STUB=true
HTTP_API_STUB=true
CHATGPT_OAUTH_PROVIDER_URL=stub
CHATGPT_OAUTH_PROVIDER_KEY=stub
CLAUDE_CODE_OAUTH_STUB=true
GROK_CLI_OAUTH_STUB=true
GEMINI_STUB=true
HARNESS_LAUNCHER_MODE=local-wiki
NEXT_TELEMETRY_DISABLED=1
EOF
fi

# ── 2. Függőségek (a dotenv-olvasáshoz és a prismához is kell) ──────────────────
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  log "npm ci"
  npm ci --no-audit --no-fund
fi

# A prisma CLI csak a .env-et olvassa, ezért a DB-URL-eket a .env.local-ból exportáljuk
# (dotenv-vel, nem `source`-szal — a .env.local nem feltétlenül shell-szintaxisú).
read_env() {
  node -e "require('dotenv').config({ path: ['.env.local', '.env'], quiet: true }); process.stdout.write(process.env[process.argv[1]] ?? '')" "$1"
}
DATABASE_URL="$(read_env DATABASE_URL)"
DIRECT_URL="$(read_env DIRECT_URL)"
if [ -z "$DATABASE_URL" ]; then
  echo "A .env.local-ban nincs DATABASE_URL." >&2
  exit 1
fi
export DATABASE_URL
export DIRECT_URL="${DIRECT_URL:-$DATABASE_URL}"

db_host="$(node -e 'console.log(new URL(process.env.DATABASE_URL).hostname)')"

# ── 3. Postgres ─────────────────────────────────────────────────────────────────
pg_ready() { pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; }

if [ "$db_host" = "127.0.0.1" ] || [ "$db_host" = "localhost" ]; then
  if ! pg_ready; then
    if command -v pg_ctlcluster >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
      cluster="$(pg_lsclusters --no-header 2>/dev/null | awk 'NR==1 {print $1" "$2}')"
      if [ -n "$cluster" ]; then
        log "Postgres indítása (pg_ctlcluster $cluster)"
        # shellcheck disable=SC2086
        pg_ctlcluster $cluster start
      fi
    fi
  fi
  if ! pg_ready && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if docker ps -a --format '{{.Names}}' | grep -qx platform-postgres; then
      log "Postgres konténer indítása (platform-postgres)"
      docker start platform-postgres >/dev/null
    else
      log "Postgres 16 konténer létrehozása (platform-postgres, 5432)"
      docker run -d --name platform-postgres -p 5432:5432 \
        -e POSTGRES_USER="$LOCAL_DB_USER" -e POSTGRES_PASSWORD="$LOCAL_DB_PASSWORD" \
        -e POSTGRES_DB="$LOCAL_DB_NAME" postgres:16 >/dev/null
    fi
  fi
  for _ in $(seq 1 30); do pg_ready && break; sleep 1; done
  if ! pg_ready; then
    echo "Nem fut Postgres a 127.0.0.1:5432-n, és nem tudtam elindítani (nincs pg_ctlcluster/docker)." >&2
    echo "Indíts egyet (pl. brew services start postgresql@16), majd futtasd újra." >&2
    exit 1
  fi

  # Szerep + adatbázis a gépen futó (nem docker) clusterben; a docker-image ezt már létrehozta.
  if [ "$(id -u)" = 0 ] && id postgres >/dev/null 2>&1; then
    su postgres -c "psql -q -v ON_ERROR_STOP=1" <<SQL || true
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${LOCAL_DB_USER}') THEN
    CREATE ROLE ${LOCAL_DB_USER} LOGIN SUPERUSER PASSWORD '${LOCAL_DB_PASSWORD}';
  END IF;
END \$\$;
SQL
    if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname = '${LOCAL_DB_NAME}'\"" | grep -q 1; then
      log "Adatbázis létrehozása: ${LOCAL_DB_NAME}"
      su postgres -c "createdb -O ${LOCAL_DB_USER} ${LOCAL_DB_NAME}"
    fi
  fi
else
  log "Távoli adatbázis (${db_host}) — Postgres indítás kihagyva"
fi

# ── 4. Séma, seed ───────────────────────────────────────────────────────────────
log "prisma migrate deploy"
npx prisma migrate deploy

log "seed (demo tenant, agent, connector-sablonok)"
npx tsx prisma/seed.ts

log "dev-belépés jogosultság (admin + superadmin)"
npx tsx scripts/seed-dev-login.ts

# ── 5. Dev szerver (opcionális) ─────────────────────────────────────────────────
if [ "$START_SERVER" = 1 ]; then
  if curl -s -o /dev/null "http://localhost:${PORT}/api/healthz"; then
    log "Már fut egy szerver a ${PORT}-es porton"
  else
    mkdir -p .data
    log "Dev szerver indítása a háttérben (port ${PORT}, log: .data/dev-server.log)"
    nohup npx next dev --port "$PORT" > .data/dev-server.log 2>&1 &
    for _ in $(seq 1 90); do
      curl -s -o /dev/null "http://localhost:${PORT}/api/healthz" && break
      sleep 2
    done
  fi
  log "Kész: http://localhost:${PORT}/control-plane"
else
  log "Kész. Indítás: npm run dev  →  http://localhost:${PORT}/control-plane"
fi

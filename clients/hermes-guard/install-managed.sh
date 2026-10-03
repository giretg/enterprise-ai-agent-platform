#!/usr/bin/env bash
# Excellence gép-padló telepítő (#771, D9). Rootként, idempotensen.
#
#   sudo ./install-managed.sh floor.json
#   ./install-managed.sh --prefix /tmp/stage floor.json    # root nélkül, teszthez
#
# A floor.json a GET /api/client-policy/machine-floor válasza.
# Felteszi: /etc/hermes/{config.yaml,.env,excellence-install-id} (root, 0644),
# az exc-token (és ha megvan, az exc-guard) binárist a /opt/excellence/bin-be,
# a Guard plugint a Hermes profil plugin-könyvtáraiba (lásd README).
set -euo pipefail

PREFIX=""
if [ "${1:-}" = "--prefix" ]; then
  PREFIX="${2:?--prefix könyvtár kell}"
  shift 2
fi

PKG="${1:?Használat: install-managed.sh [--prefix DIR] floor.json}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "$PREFIX" ]; then
  MANAGED="$PREFIX/etc/hermes"
  BIN="$PREFIX/opt/excellence/bin"
  PLUGIN_ROOT="$PREFIX/opt/excellence/hermes-plugins"
  OWNER=""
else
  if [ "$(id -u)" -ne 0 ]; then
    echo "A telepítő rootként fut: sudo $0 $PKG" >&2
    exit 1
  fi
  MANAGED="/etc/hermes"
  BIN="/opt/excellence/bin"
  PLUGIN_ROOT="/opt/excellence/hermes-plugins"
  if [ "$(uname)" = "Darwin" ]; then OWNER="root:wheel"; else OWNER="root:root"; fi
fi

python3 - "$PKG" "$MANAGED" <<'PY'
import json, os, sys
pkg = json.load(open(sys.argv[1], encoding="utf-8"))
dest = sys.argv[2]
os.makedirs(dest, exist_ok=True)
os.chmod(dest, 0o755)
for name in ("config.yaml", ".env", "excellence-install-id"):
    data = pkg["files"][name]
    if not data.endswith("\n"):
        data += "\n"
    path = os.path.join(dest, name)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(data)
    os.chmod(path, 0o644)
print(pkg["installId"])
print(pkg["managedDirHash"])
PY

if [ -n "$OWNER" ]; then
  chown "$OWNER" "$MANAGED" "$MANAGED/config.yaml" "$MANAGED/.env" "$MANAGED/excellence-install-id"
fi

mkdir -p "$BIN"
install_bin() {
  local src="$1" dest="$2"
  cp "$src" "$dest"
  chmod 0755 "$dest"
  if [ -n "$OWNER" ]; then chown "$OWNER" "$dest"; fi
}

if [ -f "$SCRIPT_DIR/exc_token.py" ]; then
  install_bin "$SCRIPT_DIR/exc_token.py" "$BIN/exc-token"
else
  echo "Hiányzik az exc_token.py a telepítő mellől." >&2
  exit 1
fi

GUARD_SRC=""
if [ -f "$SCRIPT_DIR/exc-guard" ]; then GUARD_SRC="$SCRIPT_DIR/exc-guard"
elif [ -f "$SCRIPT_DIR/exc_guard.py" ]; then GUARD_SRC="$SCRIPT_DIR/exc_guard.py"
fi
if [ -n "$GUARD_SRC" ]; then
  install_bin "$GUARD_SRC" "$BIN/exc-guard"
else
  echo "FIGYELEM: az exc-guard (V1-6) nincs a csomagban. A config a /opt/excellence/bin/exc-guard-ra mutat, fail_closed módban — amíg a bináris hiányzik, a Hermes minden tool-hívást blokkol." >&2
fi

# Plugin-útvonal (Hermes main, 2026-10, forrásból mérve — a gépen nem volt Hermes):
# általános plugin: $HERMES_HOME/plugins/<név>/plugin.yaml
#   alap: ~/.hermes/plugins/excellence-guard/
#   Desktop-profil: ~/.hermes/profiles/<profil>/plugins/excellence-guard/
# A HERMES_BUNDLED_PLUGINS a beépített pluginkönyvtárat CSERÉLI, ezért nem használjuk.
PLUGIN_SRC=""
if [ -f "$SCRIPT_DIR/excellence-guard/plugin.yaml" ]; then PLUGIN_SRC="$SCRIPT_DIR/excellence-guard"
elif [ -f "$SCRIPT_DIR/plugin/excellence-guard/plugin.yaml" ]; then PLUGIN_SRC="$SCRIPT_DIR/plugin/excellence-guard"
fi

copy_plugin() {
  local dest="$1"
  mkdir -p "$dest"
  cp -R "$PLUGIN_SRC/." "$dest/"
  if [ -n "$OWNER" ]; then chown -R "$OWNER" "$dest"; fi
}

if [ -n "$PLUGIN_SRC" ]; then
  copy_plugin "$PLUGIN_ROOT/excellence-guard"
  TARGET_HOME=""
  if [ -n "${SUDO_USER:-}" ]; then
    TARGET_HOME=$(eval echo "~$SUDO_USER")
  elif [ -n "$PREFIX" ]; then
    TARGET_HOME="$PREFIX/home"
  fi
  if [ -n "$TARGET_HOME" ] && [ -d "$TARGET_HOME" ]; then
    if [ -d "$TARGET_HOME/.hermes" ] || [ -n "$PREFIX" ]; then
      mkdir -p "$TARGET_HOME/.hermes"
      copy_plugin "$TARGET_HOME/.hermes/plugins/excellence-guard"
      if [ -d "$TARGET_HOME/.hermes/profiles" ]; then
        for profile in "$TARGET_HOME/.hermes/profiles"/*; do
          [ -d "$profile" ] || continue
          copy_plugin "$profile/plugins/excellence-guard"
        done
      fi
    fi
  fi
else
  echo "FIGYELEM: a excellence-guard plugin (V1-6) nincs a csomagban. A plugins.enabled pin kész, a fájl a plugin megérkezése utáni újrafuttatáskor kerül fel." >&2
fi

echo "Gép-padló: $MANAGED"
echo "Binárisok: $BIN"
if command -v hermes >/dev/null 2>&1; then
  echo "--- hermes config ---"
  if [ -n "$PREFIX" ]; then
    HERMES_MANAGED_DIR="$MANAGED" hermes config || true
  else
    hermes config || true
  fi
else
  echo "A hermes nincs a PATH-on, az élő ellenőrzés (hermes config mutatja-e a managed kulcsokat) kimaradt."
fi

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

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PKG="${1:-$SCRIPT_DIR/floor.json}"
if [ ! -f "$PKG" ]; then
  echo "Használat: install-managed.sh [--prefix DIR] [floor.json]" >&2
  exit 1
fi

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

# A Guard és a token-helper a padló élesítése előtt legyen jelen.
for asset in exc_token.py exc-guard excellence-guard/plugin.yaml; do
  [ -f "$SCRIPT_DIR/$asset" ] || { echo "Hiányzó telepítőfájl: $asset" >&2; exit 1; }
done

python3 - "$PKG" "$MANAGED" <<'PYVALIDATE'
import hashlib, json, os, sys, tempfile
pkg = json.load(open(sys.argv[1], encoding="utf-8"))
names = ("config.yaml", ".env", "excellence-install-id")
files = pkg["files"]
if not isinstance(pkg["installId"], str) or not pkg["installId"] or files["excellence-install-id"] != pkg["installId"] + "\n":
    raise ValueError("Hibás installId")
if any(not isinstance(files[name], str) or not files[name].endswith("\n") for name in names):
    raise ValueError("Hiányzó vagy hibás managed fájl")
body = "".join(f"{name}\n{hashlib.sha256(files[name].encode()).hexdigest()}\n" for name in names)
expected = hashlib.sha256(("excellence-managed-dir-v1\n" + body).encode()).hexdigest()
if pkg["managedDirHash"] != expected:
    raise ValueError("A csomag hash-e nem egyezik a tartalommal")
dest = sys.argv[2]
if os.path.islink(dest):
    raise ValueError("A managed könyvtár nem lehet symlink")
os.makedirs(dest, exist_ok=True)
os.chmod(dest, 0o755)
# Előbb minden fájl elkészül; hibás bemenet nem módosítja a régi padlót.
with tempfile.TemporaryDirectory(dir=dest) as stage:
    for name in names:
        with open(os.path.join(stage, name), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(files[name])
        os.chmod(os.path.join(stage, name), 0o644)
    for name in names:
        os.replace(os.path.join(stage, name), os.path.join(dest, name))
print(pkg["installId"])
print(pkg["managedDirHash"])
PYVALIDATE

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

install_bin "$SCRIPT_DIR/exc_token.py" "$BIN/exc-token"
install_bin "$SCRIPT_DIR/exc-guard" "$BIN/exc-guard"

# Hermes: $HERMES_HOME/plugins/<név>/plugin.yaml, profiloknál külön HERMES_HOME.
PLUGIN_SRC="$SCRIPT_DIR/excellence-guard"

copy_plugin() {
  local dest="$1"
  python3 - "$PLUGIN_SRC" "$dest" "${2:-}" <<'PYCOPY'
import os, pathlib, pwd, shutil, sys
src, dest, user = sys.argv[1:]
# A user profiljába soha nem írunk root-joggal: átirányítás sem adhat root-írást.
if user:
    account = pwd.getpwnam(user)
    os.initgroups(user, account.pw_gid)
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
path = pathlib.Path(dest)
if path.is_symlink() or any(part.is_symlink() and part.lstat().st_uid != 0 for part in path.parents):
    raise ValueError("A plugin telepítési útvonala nem lehet symlink")
if path.exists() and any(part.is_symlink() for part in path.rglob("*")):
    raise ValueError("A plugin telepítési könyvtára nem tartalmazhat symlinket")
shutil.copytree(src, dest, dirs_exist_ok=True)
PYCOPY
}

copy_plugin "$PLUGIN_ROOT/excellence-guard"
TARGET_HOME=""
TARGET_USER=""
if [ -n "$PREFIX" ]; then
  TARGET_HOME="$PREFIX/home"
  mkdir -p "$TARGET_HOME"
elif [ -n "${SUDO_USER:-}" ]; then
  TARGET_HOME=$(python3 -c 'import pwd, sys; print(pwd.getpwnam(sys.argv[1]).pw_dir)' "$SUDO_USER")
  TARGET_USER="$SUDO_USER"
fi
if [ -n "$TARGET_HOME" ] && [ -d "$TARGET_HOME" ]; then
  copy_plugin "$TARGET_HOME/.hermes/plugins/excellence-guard" "$TARGET_USER"
  if [ -d "$TARGET_HOME/.hermes/profiles" ]; then
    for profile in "$TARGET_HOME/.hermes/profiles"/*; do
      [ -d "$profile" ] || continue
      copy_plugin "$profile/plugins/excellence-guard" "$TARGET_USER"
    done
  fi
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

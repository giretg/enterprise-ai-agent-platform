#!/usr/bin/env python3
"""install-managed.sh idempotens felmásolása egy prefixbe, root nélkül."""
import json
import hashlib
import os
import stat
import subprocess
import tempfile
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "install-managed.sh"

PKG = {
    "installId": "inst-test",
    "managedDirHash": "",
    "files": {
        "config.yaml": 'model:\n  provider: "excellence"\n',
        ".env": "OPENROUTER_API_KEY=\n",
        "excellence-install-id": "inst-test\n",
    },
}


PKG["managedDirHash"] = hashlib.sha256(("excellence-managed-dir-v1\n" + "".join(f"{name}\n{hashlib.sha256(PKG["files"][name].encode()).hexdigest()}\n" for name in ("config.yaml", ".env", "excellence-install-id"))).encode()).hexdigest()

def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        blob = Path(tmp) / "floor.json"
        blob.write_text(json.dumps(PKG), encoding="utf-8")
        prefix = Path(tmp) / "stage"
        profile = prefix / "home/.hermes/profiles/test-bot"
        profile.mkdir(parents=True)
        subprocess.run(["bash", str(SCRIPT), "--prefix", str(prefix), str(blob)], check=True)
        managed = prefix / "etc" / "hermes"
        assert (managed / "config.yaml").read_text(encoding="utf-8").startswith("model:")
        assert (managed / ".env").read_text(encoding="utf-8") == "OPENROUTER_API_KEY=\n"
        assert (managed / "excellence-install-id").read_text(encoding="utf-8") == "inst-test\n"
        assert (prefix / "home/.hermes").stat().st_uid == os.getuid()
        # Egy user által átirányított plugin-könyvtárat nem írhat felül a telepítő.
        outside = Path(tmp) / "outside"
        outside.mkdir()
        user_plugin = prefix / "home/.hermes/plugins/excellence-guard"
        shutil.rmtree(user_plugin)
        user_plugin.symlink_to(outside, target_is_directory=True)
        result = subprocess.run(["bash", str(SCRIPT), "--prefix", str(prefix), str(blob)], capture_output=True)
        assert result.returncode != 0
        assert not list(outside.iterdir())
        user_plugin.unlink()
        # A célon belüli fájlsymlink sem vezethet más fájl felülírásához.
        user_plugin.mkdir()
        protected = outside / "protected.py"
        protected.write_text("unchanged")
        (user_plugin / "policy.py").symlink_to(protected)
        result = subprocess.run(["bash", str(SCRIPT), "--prefix", str(prefix), str(blob)], capture_output=True)
        assert result.returncode != 0
        assert protected.read_text() == "unchanged"
        (user_plugin / "policy.py").unlink()
        mode = stat.S_IMODE((managed / "config.yaml").stat().st_mode)
        assert mode == 0o644, mode
        token = prefix / "opt" / "excellence" / "bin" / "exc-token"
        assert token.is_file()
        assert os.access(token, os.X_OK)
        guard = prefix / "opt/excellence/bin/exc-guard"
        assert os.access(guard, os.X_OK)
        plugin = prefix / "opt/excellence/hermes-plugins/excellence-guard"
        assert (plugin / "plugin.yaml").is_file()
        assert (profile / "plugins/excellence-guard/plugin.yaml").is_file()
        # A telepített (kiterjesztés nélküli) token-helper betölthető.
        subprocess.run(["python3", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import runtime; runtime.TOKEN_HELPER_PATH = sys.argv[2]; assert callable(runtime.load_exc_token().get_token)", str(plugin), str(token)], env=os.environ, check=True)
        # Hibás csomag nem írhatja felül a már működő padlót.
        bad = {**PKG, "files": {"config.yaml": "broken\n"}}
        blob.write_text(json.dumps(bad), encoding="utf-8")
        result = subprocess.run(["bash", str(SCRIPT), "--prefix", str(prefix), str(blob)], capture_output=True)
        assert result.returncode != 0
        assert (managed / "config.yaml").read_text() == PKG["files"]["config.yaml"]
        blob.write_text(json.dumps(PKG), encoding="utf-8")
        # Második futás felülír, nem halmoz.
        subprocess.run(["bash", str(SCRIPT), "--prefix", str(prefix), str(blob)], check=True)
        assert (managed / "excellence-install-id").read_text(encoding="utf-8") == "inst-test\n"
    print("ok")


if __name__ == "__main__":
    main()

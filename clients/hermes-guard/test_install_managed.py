#!/usr/bin/env python3
"""install-managed.sh idempotens felmásolása egy prefixbe, root nélkül."""
import json
import hashlib
import os
import stat
import subprocess
import sys
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
    "bots": [
        {
            "profile": "exc-kati",
            "agentId": "11111111-1111-4111-8111-111111111111",
            "files": {
                "SOUL.md": "# Kati\n\nThis Hermes Bot is a connector to Kati on Excellence AI.\n",
                "profile.yaml": "display_name: Kati\n",
                "config.yaml": "mcp_servers:\n  excellence:\n    url: https://app.example.com/api/mcp/acme\n",
                "distribution.yaml": "name: exc-kati\n",
            },
        },
        {
            "profile": "../evil",
            "agentId": "ignore",
            "files": {"SOUL.md": "nope\n"},
        },
    ],
}


PKG["managedDirHash"] = hashlib.sha256(("excellence-managed-dir-v1\n" + "".join(f"{name}\n{hashlib.sha256(PKG["files"][name].encode()).hexdigest()}\n" for name in ("config.yaml", ".env", "excellence-install-id"))).encode()).hexdigest()

def pycopy_source() -> str:
    text = SCRIPT.read_text(encoding="utf-8")
    marker = "<<'PYCOPY'\n"
    start = text.index(marker) + len(marker)
    end = text.index("\nPYCOPY\n", start)
    return text[start:end]


def assert_copy_survives_unreadable_source() -> None:
    """sudo mktemp a root tempjébe (0700) tesz. setuid után a user onnan nem tud olvasni."""
    import pwd

    user = pwd.getpwuid(os.getuid()).pw_name
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        src = root / "excellence-guard"
        src.mkdir()
        (src / "plugin.yaml").write_text("name: excellence-guard\n", encoding="utf-8")
        (src / "policy.py").write_text("x = 1\n", encoding="utf-8")
        dest = root / "plugins" / "excellence-guard"
        prelude = (
            "import os, sys\n"
            "def _lock(_uid):\n"
            "    os.chmod(sys.argv[1], 0)\n"
            "os.setuid = _lock\n"
            "os.setgid = lambda _gid: None\n"
            "os.initgroups = lambda _user, _gid: None\n"
        )
        try:
            result = subprocess.run(
                [sys.executable, "-c", prelude + pycopy_source(), str(src), str(dest), user],
                capture_output=True,
                text=True,
            )
            assert result.returncode == 0, result.stderr
            assert (dest / "plugin.yaml").read_text(encoding="utf-8") == "name: excellence-guard\n"
            assert (dest / "policy.py").read_text(encoding="utf-8") == "x = 1\n"
        finally:
            if src.exists():
                os.chmod(src, 0o755)


def main() -> None:
    assert_copy_survives_unreadable_source()
    with tempfile.TemporaryDirectory() as tmp:
        blob = Path(tmp) / "floor.json"
        blob.write_text(json.dumps(PKG), encoding="utf-8")
        prefix = Path(tmp) / "stage"
        profile = prefix / "home/.hermes/profiles/test-bot"
        profile.mkdir(parents=True)
        leftover = prefix / "home/.hermes/profiles/exc-kati/skills/excellence"
        leftover.mkdir(parents=True)
        (leftover / "SKILL.md").write_text("stale\n", encoding="utf-8")
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
        bot = prefix / "home/.hermes/profiles/exc-kati"
        assert (bot / "SOUL.md").read_text(encoding="utf-8").startswith("# Kati")
        assert "connector to Kati" in (bot / "SOUL.md").read_text(encoding="utf-8")
        assert (bot / "profile.yaml").read_text(encoding="utf-8") == "display_name: Kati\n"
        assert (bot / "plugins/excellence-guard/plugin.yaml").is_file()
        assert not (bot / "skills/excellence").exists()
        assert not (prefix / "home/.hermes/profiles/evil").exists()
        assert profile.is_dir()
        assert not (profile / "SOUL.md").exists()
        token = prefix / "opt" / "excellence" / "bin" / "exc-token"
        assert token.is_file()
        assert os.access(token, os.X_OK)
        paths = prefix / "opt/excellence/bin/excellence_paths.py"
        assert paths.read_bytes() == (ROOT / "excellence-guard/excellence_paths.py").read_bytes()
        isolated = subprocess.run([sys.executable, "-I", str(token)], capture_output=True, text=True)
        assert isolated.returncode != 0 and "ImportError" not in isolated.stderr and "excellence_paths" not in isolated.stderr, isolated.stderr
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

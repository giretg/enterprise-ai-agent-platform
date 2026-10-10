#!/usr/bin/env python3
"""install-managed.ps1 (#755) prefixbe, admin nélkül. pwsh nélkül kimarad."""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "install-managed.ps1"
NAMES = ("config.yaml", ".env", "excellence-install-id")


def package(platform="windows", config='model:\n  provider: "excellence"\n'):
    files = {"config.yaml": config, ".env": "OPENROUTER_API_KEY=\n", "excellence-install-id": "inst-win\n"}
    body = "".join(f"{n}\n{hashlib.sha256(files[n].encode()).hexdigest()}\n" for n in NAMES)
    digest = hashlib.sha256(("excellence-managed-dir-v1\n" + body).encode()).hexdigest()
    return {"installId": "inst-win", "platform": platform, "managedDirHash": digest, "files": files}


def install(pwsh, prefix, blob):
    return subprocess.run(
        [pwsh, "-NoProfile", "-File", str(SCRIPT), str(blob), "-Prefix", str(prefix), "-Python", sys.executable],
        capture_output=True, text=True,
    )


def main() -> None:
    pwsh = shutil.which("pwsh")
    if not pwsh:
        print("skip: nincs pwsh")
        return
    with tempfile.TemporaryDirectory() as tmp:
        blob = Path(tmp) / "floor.json"
        prefix = Path(tmp) / "stage"
        hermes_home = prefix / "home/AppData/Local/hermes"
        (hermes_home / "profiles/test-bot").mkdir(parents=True)
        blob.write_text(json.dumps(package()), encoding="utf-8")

        result = install(pwsh, prefix, blob)
        assert result.returncode == 0, result.stderr + result.stdout
        root = prefix / "ProgramData/Excellence"
        managed = root / "hermes"
        for name, text in package()["files"].items():
            assert (managed / name).read_bytes() == text.encode(), name
        assert not [p for p in managed.iterdir() if p.name.startswith(".stage-")]
        assert (root / "bin/exc-token").read_bytes() == (ROOT / "exc_token.py").read_bytes()
        assert (root / "bin/exc-guard").read_bytes() == (ROOT / "exc-guard").read_bytes()
        cmd = (root / "bin/exc-guard.cmd").read_bytes().decode()
        assert cmd == f'@"{sys.executable}" -I -X utf8 "%~dp0exc-guard" %*\r\n', cmd
        assert (root / "hermes-plugins/excellence-guard/policy.py").is_file()
        assert (hermes_home / "plugins/excellence-guard/plugin.yaml").is_file()
        assert (hermes_home / "profiles/test-bot/plugins/excellence-guard/plugin.yaml").is_file()

        # A user által átirányított plugin-könyvtárba nem ír.
        outside = Path(tmp) / "outside"
        outside.mkdir()
        user_plugin = hermes_home / "plugins/excellence-guard"
        shutil.rmtree(user_plugin)
        user_plugin.symlink_to(outside, target_is_directory=True)
        result = install(pwsh, prefix, blob)
        assert result.returncode != 0 and "symlink" in result.stderr, result.stderr
        assert not list(outside.iterdir())
        user_plugin.unlink()

        # Hibás hash és nem Windows-csomag: a meglévő padló marad.
        bad = package(config="broken\n")
        bad["managedDirHash"] = package()["managedDirHash"]
        for broken in (bad, package(platform="posix")):
            blob.write_text(json.dumps(broken), encoding="utf-8")
            result = install(pwsh, prefix, blob)
            assert result.returncode != 0, result.stdout
            assert "Hibás csomag" in result.stderr, result.stderr
            assert (managed / "config.yaml").read_text() == package()["files"]["config.yaml"]

        # Újrafuttatás felülír, nem halmoz.
        blob.write_text(json.dumps(package()), encoding="utf-8")
        result = install(pwsh, prefix, blob)
        assert result.returncode == 0, result.stderr
        assert sorted(p.name for p in managed.iterdir()) == sorted(NAMES)
    print("ok")


if __name__ == "__main__":
    main()

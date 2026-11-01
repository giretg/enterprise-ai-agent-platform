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
        tokens = hermes_home / "mcp-tokens"
        tokens.mkdir(parents=True)
        (tokens / "excellence.json").write_text('{"access_token":"oauth-parent"}\n', encoding="utf-8")
        pkg = package()
        pkg["bots"] = [{
            "profile": "exc-kati",
            "agentId": "11111111-1111-4111-8111-111111111111",
            "files": {
                "SOUL.md": "# Kati\n",
                "profile.yaml": "display_name: Kati\n",
                "config.yaml": "mcp_servers:\n  excellence:\n    url: https://app.example.com/api/mcp/acme\n",
                "distribution.yaml": "name: exc-kati\n",
            },
        }]
        blob.write_text(json.dumps(pkg), encoding="utf-8")

        result = install(pwsh, prefix, blob)
        assert result.returncode == 0, result.stderr + result.stdout
        root = prefix / "ProgramData/Excellence"
        managed = root / "hermes"
        for name, text in package()["files"].items():
            assert (managed / name).read_bytes() == text.encode(), name
        assert not [p for p in managed.iterdir() if p.name.startswith(".stage-")]
        assert (root / "bin/exc-token").read_bytes() == (ROOT / "exc_token.py").read_bytes()
        assert (root / "bin/exc-guard").read_bytes() == (ROOT / "exc-guard").read_bytes()
        assert (root / "bin/excellence_paths.py").read_bytes() == (ROOT / "excellence-guard/excellence_paths.py").read_bytes()
        assert "C:\\ProgramData\\Excellence" in (ROOT / "excellence-guard/excellence_paths.py").read_text()
        assert "$Root = 'C:\\ProgramData\\Excellence'" in SCRIPT.read_text()
        cmd = (root / "bin/exc-guard.cmd").read_bytes().decode()
        assert cmd == f'@"{sys.executable}" -I -X utf8 "%~dp0exc-guard" %*\r\n', cmd
        assert (root / "hermes-plugins/excellence-guard/policy.py").is_file()
        assert (hermes_home / "plugins/excellence-guard/plugin.yaml").is_file()
        assert (hermes_home / "profiles/test-bot/plugins/excellence-guard/plugin.yaml").is_file()
        assert (hermes_home / "profiles/exc-kati/mcp-tokens/excellence.json").read_text(encoding="utf-8") == '{"access_token":"oauth-parent"}\n'
        # #1043: a Bot MCP-hívásai a gép telepítés-azonosítójával mennek.
        assert (hermes_home / "profiles/exc-kati/config.yaml").read_text(encoding="utf-8") == (
            "mcp_servers:\n  excellence:\n    url: https://app.example.com/api/mcp/acme\n"
            "    headers:\n      X-Excellence-Install-Id: 'inst-win'\n"
        )

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

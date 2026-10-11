#!/usr/bin/env python3
"""install-managed.ps1 (#755) élesben, rendszergazdai Windows CI-futtatón. Máshol kimarad.

Gépet módosít (C:\\ProgramData\\Excellence, gépszintű HERMES_MANAGED_DIR): csak eldobható gépen fusson.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from test_install_managed_ps import package

ROOT = Path(__file__).resolve().parent
TARGET = Path(r"C:\ProgramData\Excellence")


def main() -> None:
    if os.name != "nt" or os.environ.get("CI") != "true":
        print("skip: csak Windows CI-n")
        return
    with tempfile.TemporaryDirectory() as tmp:
        blob = Path(tmp) / "floor.json"
        blob.write_text(json.dumps(package(config='model:\n  provider: "excellence"\n  base_url: "https://ai.example/api/model-gateway/v1"\n')), encoding="utf-8")
        result = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "install-managed.ps1"), str(blob), "-Python", sys.executable, "-User", os.environ["USERNAME"]],
            capture_output=True, text=True,
        )
        assert result.returncode == 0, result.stderr + result.stdout

    managed = TARGET / "hermes"
    assert (managed / "excellence-install-id").read_text() == "inst-win\n"
    acl = subprocess.run(["icacls", str(managed / "config.yaml")], capture_output=True, text=True).stdout
    users = [line for line in acl.splitlines() if "BUILTIN\\Users" in line]
    assert users and all("(RX)" in line and "(F)" not in line and "(M)" not in line for line in users), acl
    machine_env = subprocess.run(
        ["powershell", "-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('HERMES_MANAGED_DIR', 'Machine')"],
        capture_output=True, text=True,
    ).stdout.strip()
    assert machine_env == str(managed), machine_env
    plugin = Path(os.environ["LOCALAPPDATA"]) / "hermes/plugins/excellence-guard/plugin.yaml"
    assert plugin.is_file(), plugin

    # A Hermes ugyanígy hívja a hookot: .cmd, shell nélkül, JSON a stdinen. A CI-user rendszergazda,
    # így a managed konfigurációt írhatja; az exc-guard ezt nem fogadja el, és blokkol (fail-closed).
    hook = subprocess.run(
        [str(TARGET / "bin/exc-guard.cmd")],
        input=json.dumps({"hook_event_name": "pre_tool_call", "tool_name": "terminal", "tool_input": {"command": "dir"}}),
        capture_output=True, encoding="utf-8", env={**os.environ, "HERMES_HOME": tempfile.mkdtemp()},
    )
    assert hook.returncode == 0, hook.stderr
    assert json.loads(hook.stdout)["action"] == "block", hook.stdout

    # A key_cmd-et a Hermes shell-lel futtatja; profil nélkül hétköznapi hibaüzenet, nem nulla kód.
    token = subprocess.run(str(TARGET / "bin/exc-token.cmd") + " model", shell=True, capture_output=True, encoding="utf-8", env={**os.environ, "HERMES_HOME": tempfile.mkdtemp()})
    assert token.returncode == 1 and "Excellence" in token.stderr, token.stderr
    print("ok")


if __name__ == "__main__":
    main()

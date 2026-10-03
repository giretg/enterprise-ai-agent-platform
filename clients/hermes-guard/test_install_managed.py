#!/usr/bin/env python3
"""install-managed.sh idempotens felmásolása egy prefixbe, root nélkül."""
import json
import os
import stat
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "install-managed.sh"

PKG = {
    "installId": "inst-test",
    "managedDirHash": "abc",
    "files": {
        "config.yaml": 'model:\n  provider: "excellence"\n',
        ".env": "OPENROUTER_API_KEY=\n",
        "excellence-install-id": "inst-test\n",
    },
}


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        blob = Path(tmp) / "floor.json"
        blob.write_text(json.dumps(PKG), encoding="utf-8")
        prefix = Path(tmp) / "stage"
        subprocess.run(["bash", str(SCRIPT), "--prefix", str(prefix), str(blob)], check=True)
        managed = prefix / "etc" / "hermes"
        assert (managed / "config.yaml").read_text(encoding="utf-8").startswith("model:")
        assert (managed / ".env").read_text(encoding="utf-8") == "OPENROUTER_API_KEY=\n"
        assert (managed / "excellence-install-id").read_text(encoding="utf-8") == "inst-test\n"
        mode = stat.S_IMODE((managed / "config.yaml").stat().st_mode)
        assert mode == 0o644, mode
        token = prefix / "opt" / "excellence" / "bin" / "exc-token"
        assert token.is_file()
        assert os.access(token, os.X_OK)
        # Második futás felülír, nem halmoz.
        subprocess.run(["bash", str(SCRIPT), "--prefix", str(prefix), str(blob)], check=True)
        assert (managed / "excellence-install-id").read_text(encoding="utf-8") == "inst-test\n"
    print("ok")


if __name__ == "__main__":
    main()

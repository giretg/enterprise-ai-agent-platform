#!/usr/bin/env python3
"""exc-token — a Hermes `providers.excellence.key_cmd` helper (#746 V1-2, D1).

A kiszolgált Bot-profil MCP OAuth tokenjét 10 perces Model Gateway JWT-re cseréli, és
`exp - 60 s`-ig cache-eli a profil könyvtárában (a key_cmd kérésenként fut, K11).
Stdout = a token; hibánál nem nulla exit kód + hétköznapi nyelvű stderr. Csak stdlib.
"""
import calendar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlparse

LEEWAY = 60
SERVER = os.environ.get("EXCELLENCE_MCP_SERVER", "excellence")
CACHE_NAME = "excellence-gateway-token.json"


class Fail(Exception):
    pass


def server_block(config_text, name):
    """A `mcp_servers.<name>` blokk sorai (behúzás alapján; yaml-lib nélkül)."""
    lines, out, base, in_servers = config_text.splitlines(), [], None, False
    for ln in lines:
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        indent = len(ln) - len(ln.lstrip())
        if indent == 0:
            in_servers = ln.strip() == "mcp_servers:"
            base = None
        elif in_servers and base is None and ln.strip() == f"{name}:":
            base = indent
        elif base is not None:
            if indent <= base:
                break
            out.append(ln.strip())
    return out


def read_profile(home):
    try:
        cfg = open(os.path.join(home, "config.yaml"), encoding="utf-8").read()
        block = server_block(cfg, SERVER)
        url = next(m.group(1) for ln in block if (m := re.match(r"url:\s*['\"]?(\S+?)['\"]?$", ln)))
        agent = next(m.group(1) for ln in block if (m := re.match(r"['\"]?X-Excellence-Agent-Id['\"]?:\s*['\"]?([\w-]+)", ln, re.I)))
    except (OSError, StopIteration):
        raise Fail("Ennek a Hermes-profilnak nincs beállított Excellence-asszisztense. Kapcsold össze újra a Hermes Excellence-kapcsolatát.")
    u = urlparse(url)
    return f"{u.scheme}://{u.netloc}", u.path.rstrip("/").rsplit("/", 1)[-1], agent


def install_id(home):
    env = os.environ.get("EXC_INSTALL_ID", "").strip()
    if env:
        return env
    for path in ("/etc/hermes/excellence-install-id", os.path.join(home, "excellence-install-id")):
        try:
            v = open(path).read().strip()
            if v:
                return v
        except OSError:
            pass
    v = str(uuid.uuid4())  # v1: csak heartbeat-korreláció, nem eszközkötés
    try:
        open(os.path.join(home, "excellence-install-id"), "w").write(v)
    except OSError:
        pass
    return v


def mcp_access_token(home):
    try:
        tok = json.load(open(os.path.join(home, "mcp-tokens", f"{SERVER}.json"), encoding="utf-8"))["access_token"]
        if tok:
            return tok
    except (OSError, ValueError, KeyError):
        pass
    raise Fail("Jelentkezz be újra a Hermes Excellence-kapcsolatába.")


def fetch(origin, tenant, agent, inst, access):
    req = urllib.request.Request(
        f"{origin}/api/model-gateway/token",
        data=json.dumps({"tenantSlug": tenant, "agentId": agent, "installId": inst}).encode(),
        headers={"Authorization": f"Bearer {access}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            body = json.load(r)
        return body["token"], calendar.timegm(time.strptime(body["expiresAt"][:19], "%Y-%m-%dT%H:%M:%S"))
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise Fail("Jelentkezz be újra a Hermes Excellence-kapcsolatába.")
        if e.code == 403:
            raise Fail("Ehhez az Excellence-asszisztenshez már nincs hozzáférésed. Kérd a rendszergazdát.")
        raise Fail("Az Excellence modell-átjáró most nem elérhető. Próbáld újra egy perc múlva.")
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        raise Fail("Nem érem el az Excellence szervert. Ellenőrizd az internetkapcsolatot.")


def get_token(home, now=time.time, fetcher=fetch):
    origin, tenant, agent = read_profile(home)
    inst = install_id(home)
    cache = os.path.join(home, CACHE_NAME)
    key = {"tenant": tenant, "agentId": agent, "installId": inst, "origin": origin}
    try:
        c = json.load(open(cache))
        if c["exp"] - LEEWAY > now() and all(c[k] == v for k, v in key.items()):
            return c["token"]
    except (OSError, ValueError, KeyError):
        pass
    token, exp = fetcher(origin, tenant, agent, inst, mcp_access_token(home))
    tmp = f"{cache}.{os.getpid()}"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({**key, "token": token, "exp": exp}, f)
        os.replace(tmp, cache)
    except OSError:
        pass  # a cache csak gyorsítás
    return token


def main():
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    try:
        sys.stdout.write(get_token(home))
    except Fail as e:
        sys.stderr.write(f"{e}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

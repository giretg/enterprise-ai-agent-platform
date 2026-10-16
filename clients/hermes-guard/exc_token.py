#!/usr/bin/python3 -I
"""exc-token — a Hermes `providers.excellence.key_cmd` helper (#746 V1-2, D1).

A kiszolgált Bot-profil MCP OAuth tokenjét 10 perces Model Gateway JWT-re cseréli, és
`exp - 60 s`-ig cache-eli a profil könyvtárában (a key_cmd kérésenként fut, K11).
Stdout = JSON (access_token + expires_in); hibánál nem nulla exit kód + hétköznapi nyelvű stderr. Csak stdlib.
"""
import calendar
import importlib.util
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


def _load_paths():
    # A `-I` nem teszi a szkript mappáját a sys.path-ra, ezért fájlból töltjük.
    here = os.path.dirname(os.path.abspath(__file__))
    for folder in (here, os.path.join(here, "excellence-guard")):
        path = os.path.join(folder, "excellence_paths.py")
        if os.path.isfile(path):
            spec = importlib.util.spec_from_file_location("excellence_paths_token", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise ImportError("excellence_paths")


_paths = _load_paths()
MANAGED_DIR = _paths.default_managed_dir()


def default_home():
    return _paths.default_home()


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
        url = _server_url(cfg, SERVER)
        if not url:
            raise OSError
    except OSError:
        raise Fail("Ennek a Hermes-profilnak nincs beállított Excellence-kapcsolata. Kapcsold össze újra a Hermes Excellence-kapcsolatát.")
    # Az alap profilhoz nincs asszisztens kötve (#858): agent nélkül a szerver választ egyet az elérhetők közül.
    agent = next((m.group(1) for ln in block if (m := re.match(r"['\"]?X-Excellence-Agent-Id['\"]?:\s*['\"]?([\w-]+)", ln, re.I))), None)
    u = urlparse(url)
    return f"{u.scheme}://{u.netloc}", u.path.rstrip("/").rsplit("/", 1)[-1], agent


def install_id(home):
    env = os.environ.get("EXC_INSTALL_ID", "").strip()
    if env:
        return env
    for path in (os.path.join(MANAGED_DIR, "excellence-install-id"), os.path.join(home, "excellence-install-id")):
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


def parent_hermes_home(home):
    """A vékony Bot (`.../profiles/exc-…`) default Hermes-profilja. Más HERMES_HOME-ra None."""
    home = os.path.abspath(home)
    parent, name = os.path.split(home.rstrip(os.sep))
    grand, profiles = os.path.split(parent)
    if profiles == "profiles" and name.startswith("exc-"):
        return grand
    return None


def _server_url(config_text, name):
    return next((m.group(1) for ln in server_block(config_text, name) if (m := re.match(r"url:\s*['\"]?(\S+?)['\"]?$", ln))), None)


def _server_names(config_text):
    names, child, in_servers = [], None, False
    for ln in config_text.splitlines():
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        indent = len(ln) - len(ln.lstrip())
        if indent == 0:
            in_servers, child = ln.strip() == "mcp_servers:", None
        elif in_servers and (child is None or indent == child) and ln.strip().endswith(":"):
            child = indent
            names.append(ln.strip()[:-1].strip("'\""))
    return names


def parent_server_name(home, parent):
    """A default profil azon MCP-szervere, amely a Bot szerverével azonos URL-re mutat.

    A default profilban az `excellence` név más bérlőt is jelenthet (pl. saját tenant), a Bot
    tenantjára tett belépés pedig `excellence-<tenant>` néven áll. Más URL belépőjét nem vesszük át.
    """
    try:
        url = _server_url(open(os.path.join(home, "config.yaml"), encoding="utf-8").read(), SERVER)
    except OSError:
        url = None
    try:
        cfg = open(os.path.join(parent, "config.yaml"), encoding="utf-8").read()
    except OSError:
        return SERVER
    names = _server_names(cfg)
    matches = [n for n in names if url and _server_url(cfg, n) == url]
    if SERVER in matches:
        return SERVER
    if matches:
        return matches[0]
    return None if SERVER in names else SERVER


def _copy_login(src_dir, src_name, dest_dir, dest_name):
    """Token + client + meta együtt; symlinket nem követünk és nem írunk."""
    copied = False
    if os.path.islink(src_dir) or os.path.islink(dest_dir):
        return False
    for suffix in (".json", ".client.json", ".meta.json"):
        src, dest = os.path.join(src_dir, src_name + suffix), os.path.join(dest_dir, dest_name + suffix)
        if os.path.islink(src) or not os.path.isfile(src) or os.path.islink(dest):
            continue
        os.makedirs(dest_dir, exist_ok=True)
        data = open(src, "rb").read()
        tmp = f"{dest}.{os.getpid()}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, dest)
        copied = True
    return copied


def share_mcp_tokens(dest_home, source_home=None):
    """A default profil és a Bot Excellence MCP-belépőjét szinkronizálja: a később lejáró nyer.

    A Hermes MCP és a key_cmd a Bot saját `mcp-tokens/` könyvtárát olvassa. Kétirányú, mert
    az OAuth-szerver frissítéskor elforgatja a refresh tokent: ha a Bot frissített, a default
    profil (és rajta át a többi Bot) régi refresh tokenje már érvénytelen (400). True = a Bot kapott újat.
    """
    source_home = source_home or parent_hermes_home(dest_home)
    if not source_home:
        return False
    src_name = parent_server_name(dest_home, source_home)
    if not src_name:
        return False
    src_dir, dest_dir = os.path.join(source_home, "mcp-tokens"), os.path.join(dest_home, "mcp-tokens")
    src, dest = os.path.join(src_dir, f"{src_name}.json"), os.path.join(dest_dir, f"{SERVER}.json")
    if not os.path.isfile(src):
        return False
    if not os.path.exists(dest) or _expires_at(src) > _expires_at(dest):
        return _copy_login(src_dir, src_name, dest_dir, SERVER)
    # ponytail: a frissítés és a visszamásolás között egy másik Bot még a régi tokennel frissíthet (ritka verseny); akkor újra-belépés.
    if _expires_at(dest) > _expires_at(src):
        _copy_login(dest_dir, SERVER, src_dir, src_name)
    return False


def share_all_mcp_tokens(home):
    """`share_mcp_tokens` a Bot-profilra, vagy a default profilból indulva minden `exc-*` Botra.

    A Hermes asztali app egy folyamatban, `HERMES_HOME=~/.hermes`-szel szolgálja ki az összes
    profilt, így a Guard a default profilt látja; a telepítő is innen indul. Visszaad: kapott-e újat Bot.
    """
    if parent_hermes_home(home):
        return share_mcp_tokens(home)
    profiles = os.path.join(home, "profiles")
    try:
        names = sorted(os.listdir(profiles))
    except OSError:
        return False
    got = False
    for name in names:
        bot = os.path.join(profiles, name)
        if name.startswith("exc-") and os.path.isdir(bot) and not os.path.islink(bot):
            got = share_mcp_tokens(bot, home) or got
    return got


def _expires_at(path):
    try:
        return float(json.load(open(path, encoding="utf-8")).get("expires_at") or 0)
    except (OSError, ValueError, TypeError, AttributeError):
        return 0.0


def mcp_access_token(home):
    candidates = [os.path.join(home, "mcp-tokens", f"{SERVER}.json")]
    parent = parent_hermes_home(home)
    name = parent and parent_server_name(home, parent)
    if name:
        candidates.append(os.path.join(parent, "mcp-tokens", f"{name}.json"))
    best, best_exp = None, -1.0
    for path in candidates:
        try:
            tok = json.load(open(path, encoding="utf-8"))["access_token"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        # A Bot és a default profil közül a később lejáró belépő (a Bot Hermese maga is frissíthet).
        if tok and _expires_at(path) > best_exp:
            best, best_exp = tok, _expires_at(path)
    if best:
        return best
    raise Fail("Jelentkezz be újra a Hermes Excellence-kapcsolatába.")


def fetch(origin, tenant, agent, inst, access):
    req = urllib.request.Request(
        f"{origin}/api/model-gateway/token",
        data=json.dumps({"tenantSlug": tenant, **({"agentId": agent} if agent else {}), "installId": inst}).encode(),
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
    return get_token_exp(home, now, fetcher)[0]


def get_token_exp(home, now=time.time, fetcher=fetch):
    origin, tenant, agent = read_profile(home)
    inst = install_id(home)
    cache = os.path.join(home, CACHE_NAME)
    key = {"tenant": tenant, "agentId": agent, "installId": inst, "origin": origin}
    try:
        c = json.load(open(cache))
        if c["exp"] - LEEWAY > now() and all(c[k] == v for k, v in key.items()):
            return c["token"], c["exp"]
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
    return token, exp


def key_cmd_payload(token, exp, now=time.time):
    # JSON `expires_in`-nel: a Hermes bare tokenre 900 s-ot feltételez, a gateway-JWT 600 s → lejárt tokennel 401.
    return json.dumps({"access_token": token, "expires_in": max(1, int(exp - now()))})


def main():
    if sys.argv[1:2] == ["--share"]:
        # Telepítő: a frissen kirakott Bot-profilok az azonos URL-ű default belépőt kapják.
        share_all_mcp_tokens(sys.argv[2] if len(sys.argv) > 2 else default_home())
        return 0
    home = os.environ.get("HERMES_HOME") or default_home()
    try:
        sys.stdout.write(key_cmd_payload(*get_token_exp(home)))
    except Fail as e:
        sys.stderr.write(f"{e}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""A céges telepítés útvonalai (#755).

A `machine-floor.ts` `CLIENT_COMMANDS.windows` ugyanezt a `C:\\ProgramData\\Excellence`
gyökeret írja a kiadott padlóba. Az `exc-token` `-I` mellett fut, ezért fájlútvonalról
tölti be ezt a modult, nem a `sys.path`-ról.
"""
import os

WINDOWS_ROOT = r"C:\ProgramData\Excellence"


class ManagedDirRedirected(Exception):
    """Windowson a felhasználói HERMES_MANAGED_DIR felülírná a gépszintű padlót."""


def default_managed_dir():
    if os.name == "nt":
        return WINDOWS_ROOT + r"\hermes"
    return "/etc/hermes"


def token_helper_path():
    if os.name == "nt":
        return WINDOWS_ROOT + r"\bin\exc-token"
    return "/opt/excellence/bin/exc-token"


def plugin_dir():
    if os.name == "nt":
        return WINDOWS_ROOT + r"\hermes-plugins\excellence-guard"
    return "/opt/excellence/hermes-plugins/excellence-guard"


def default_home():
    """A Hermes alapértelmezett profilja: Windowson %LOCALAPPDATA%\\hermes, máshol ~/.hermes."""
    if os.name == "nt":
        return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser(r"~\AppData\Local"), "hermes")
    return os.path.expanduser("~/.hermes")


def resolve_managed_dir(env_value, windows):
    """A Hermes által látott könyvtár. Windowson csak a céges hely érvényes.

    A felhasználói környezeti változó a gépszintűt felülírja, natív managed hely
    pedig nincs (U3). Az eltérő értéket nem követjük: a hook és a hash ugyanazt
    a könyvtárat nézi, az átirányítás fail-closed.
    """
    default = (WINDOWS_ROOT + r"\hermes") if windows else "/etc/hermes"
    if not env_value:
        return default
    if windows:
        if env_value.rstrip("\\/").lower() == default.rstrip("\\/").lower():
            return default
        raise ManagedDirRedirected(env_value)
    return env_value

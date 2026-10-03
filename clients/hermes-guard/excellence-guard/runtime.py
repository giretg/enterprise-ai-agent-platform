"""Snapshot-cache, audit-sor, heartbeat, plugin-életciklus (#775). Csak stdlib.

A shell-hook (`exc-guard`) ugyanezt a cache-fájlt olvassa, hálózat nélkül.
A managed-dir hash kanonikus alakja megegyezik a V1-8 `managedDirHash`-ével
(`excellence-managed-dir-v1`), hogy a szerver el tudja dönteni az eltérést.
"""
import hashlib
import importlib.util
from importlib.machinery import SourceFileLoader
import json
import logging
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from types import SimpleNamespace

import policy

log = logging.getLogger("excellence_guard")

CACHE_FILE = ("excellence-guard", "snapshot.json")
QUEUE_FILE = ("excellence-guard", "audit-queue.jsonl")
MANAGED_FILES = ("config.yaml", ".env", "excellence-install-id")
HASH_VERSION = "excellence-managed-dir-v1"
MAX_CONTENT_CHARS = 200_000
TOKEN_HELPER_PATH = "/opt/excellence/bin/exc-token"
_lock = threading.Lock()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def managed_dir_hash(files):
    body = "".join(f"{name}\n{sha256_bytes(files.get(name, b''))}\n" for name in MANAGED_FILES)
    body_bytes = f"{HASH_VERSION}\n{body}".encode()
    return sha256_bytes(body_bytes)


def hash_managed_dir(path):
    files = {}
    for name in MANAGED_FILES:
        try:
            with open(os.path.join(path, name), "rb") as fh:
                files[name] = fh.read()
        except OSError:
            files[name] = b""
    return managed_dir_hash(files)


def config_hash(home):
    try:
        with open(os.path.join(home, "config.yaml"), "rb") as fh:
            data = fh.read()
    except OSError:
        data = b"missing"
    return sha256_bytes(data)


def managed_dir():
    return os.environ.get("HERMES_MANAGED_DIR") or "/etc/hermes"


def _under(home, parts):
    return os.path.join(home, *parts)


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    os.replace(tmp, path)


def load_exc_token():
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "..", "exc_token.py"),
        TOKEN_HELPER_PATH,
    ]
    for path in candidates:
        if not os.path.isfile(path):
            continue
        spec = importlib.util.spec_from_file_location("exc_token_guard", path, loader=SourceFileLoader("exc_token_guard", path))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    return None


def fetch_snapshot(home):
    """('ok', snapshot) | ('revoked', None) | ('down', None). A 401/403 visszavonás, nem D4."""
    if os.environ.get("EXC_GUARD_OFFLINE") == "1":
        return "down", None
    mod = load_exc_token()
    if mod is None:
        return "down", None
    try:
        token = mod.get_token(home)
        origin, _tenant, _agent = mod.read_profile(home)
    except mod.Fail as exc:
        text = str(exc)
        if "nincs hozzáférésed" in text or "Jelentkezz be" in text:
            return "revoked", None
        return "down", None
    req = urllib.request.Request(
        f"{origin}/api/client-policy/snapshot",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            body = json.load(response)
        if isinstance(body, dict) and isinstance(body.get("capabilities"), dict):
            return "ok", body
        return "down", None
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return "revoked", None
        return "down", None
    except (urllib.error.URLError, OSError, ValueError):
        return "down", None


class SnapshotClient:
    def __init__(self, home, fetcher=None, now=time.time, revalidate=policy.REVALIDATE_SECONDS, offline_ttl=policy.OFFLINE_TTL_SECONDS):
        self.home = home
        self.fetcher = fetcher or (lambda: fetch_snapshot(home))
        self.now = now
        self.revalidate = revalidate
        self.offline_ttl = offline_ttl

    def path(self):
        return _under(self.home, CACHE_FILE)

    def read(self):
        return read_json(self.path())

    def refresh(self, force=False):
        now = self.now()
        state = self.read()
        fresh = (
            not force
            and isinstance(state, dict)
            and isinstance(state.get("cachedAt"), (int, float))
            and now - state["cachedAt"] < self.revalidate
            and isinstance(state.get("snapshot"), dict)
            and not state.get("revoked")
        )
        if fresh:
            return policy.interpret_cache(state, now, self.offline_ttl)
        status, snap = self.fetcher()
        if status == "ok":
            write_json(self.path(), {"cachedAt": now, "revoked": False, "snapshot": snap, "agentId": snap.get("agentId")})
            return {"kind": "snapshot", "snapshot": snap}
        if status == "revoked":
            write_json(self.path(), {"cachedAt": now, "revoked": True, "snapshot": None})
            return {"kind": "revoked"}
        return policy.interpret_cache(state, now, self.offline_ttl)


def _clip(value):
    if value is None:
        return None
    if isinstance(value, str):
        raw = value.encode("utf-8")
        if len(raw) <= MAX_CONTENT_CHARS:
            return value
        return raw[:MAX_CONTENT_CHARS].decode("utf-8", errors="ignore") + "… [levágva]"
    text = json.dumps(value, ensure_ascii=False, default=str)
    if len(text.encode("utf-8")) <= MAX_CONTENT_CHARS:
        return value
    return text.encode("utf-8")[:MAX_CONTENT_CHARS].decode("utf-8", errors="ignore") + "… [levágva]"


def build_event(snapshot, session_id, turn_id, kind, content, meta):
    depth = ((snapshot or {}).get("capabilities") or {}).get("audit_depth") or "metadata"
    kept = policy.keep_content(depth, kind, content)
    event = {
        "id": str(uuid.uuid4()),
        "sessionId": (session_id or "unknown")[:200],
        "kind": kind,
        "meta": meta or {},
    }
    if turn_id:
        event["turnId"] = str(turn_id)[:200]
    if kept is not None:
        event["content"] = _clip(kept)
    return event


def enqueue(home, event):
    path = _under(home, QUEUE_FILE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    line = json.dumps(event, ensure_ascii=False)
    with _lock:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


def _read_queue(path):
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return []
    events = []
    for line in lines:
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    return events


def write_json_lines(path, events):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        for event in events:
            fh.write(json.dumps(event, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def flush_queue(home, post, limit=100):
    """post(events) → 'ok' | 'drop' | 'retry'. Az ok és a drop is kiveszi a feladott id-ket."""
    path = _under(home, QUEUE_FILE)
    with _lock:
        events = _read_queue(path)
    if not events:
        return 0
    batch = events[:limit]
    outcome = post(batch)
    if outcome == "retry":
        return 0
    sent = {event.get("id") for event in batch}
    with _lock:
        current = _read_queue(path)
        keep = [event for event in current if event.get("id") not in sent]
        if keep:
            write_json_lines(path, keep)
        elif os.path.exists(path):
            os.remove(path)
    return len(batch) if outcome == "ok" else 0


def post_json(url, token, payload, timeout=5):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        return exc.code, {}
    except (urllib.error.URLError, OSError, ValueError):
        return 0, {}


def hermes_version():
    env = os.environ.get("HERMES_VERSION", "").strip()
    if env:
        return env[:200]
    try:
        out = subprocess.check_output(["hermes", "--version"], timeout=2, stderr=subprocess.STDOUT, text=True)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    line = (out or "").strip().splitlines()
    return (line[-1] if line else "unknown")[:200] or "unknown"


def synthetic_refusal(text):
    """OpenAI ChatCompletion-szerű objektum: a Hermes `normalize_response` a `.choices[0].message`-t olvassa."""
    message = SimpleNamespace(content=text, tool_calls=None, reasoning=None, reasoning_details=None, refusal=None)
    choice = SimpleNamespace(message=message, finish_reason="stop")
    return SimpleNamespace(id="excellence-guard-block", choices=[choice], usage=None, model="excellence")


class Guard:
    def __init__(self, home, client=None, now=time.time):
        self.home = home
        self.client = client or SnapshotClient(home, now=now)
        self.now = now
        self.sessions = set()
        self.noticed = set()
        self.decisions = {}
        self.interval = 60
        self._version = None

    def current(self, force=False):
        try:
            return self.client.refresh(force=force)
        except Exception:
            log.exception("snapshot")
            return policy.interpret_cache(self.client.read(), self.now(), policy.OFFLINE_TTL_SECONDS)

    def _audit_snapshot(self):
        interpreted = self.current()
        if interpreted.get("kind") == "snapshot":
            return interpreted["snapshot"]
        if interpreted.get("kind") == "bound":
            return policy.bound_snapshot()
        return {"capabilities": {"audit_depth": "metadata"}, "policyVersion": "revoked"}

    def note_session(self, session_id):
        if session_id:
            self.sessions.add(str(session_id)[:200])

    def pre_tool_call(self, tool_name=None, args=None, **kwargs):
        try:
            if not isinstance(args, dict):
                args = kwargs.get("tool_input") if isinstance(kwargs.get("tool_input"), dict) else {}
            # P4/NFR: visszavonás a következő hívásnál. Ha a Control Plane down, D4 cache marad.
            decision = policy.decide_interpreted(self.current(force=True), tool_name, args)
            call_id = kwargs.get("tool_call_id")
            if call_id:
                self.decisions[str(call_id)] = decision.action
            self.note_session(kwargs.get("session_id"))
            body = policy.hook_body(decision)
            return None if decision.action == "allow" else body
        except Exception:
            log.exception("pre_tool_call")
            return {"action": "block", "message": f"A céges ellenőrzés hibázott, ezért ezt a műveletet nem engedem. {policy.ASK}"}

    def post_tool_call(self, tool_name=None, args=None, result=None, **kwargs):
        try:
            call_id = str(kwargs.get("tool_call_id") or "")
            decision = self.decisions.pop(call_id, None)
            event = build_event(
                self._audit_snapshot(),
                kwargs.get("session_id"),
                kwargs.get("turn_id"),
                "tool_call",
                {"args": args, "result": result},
                {
                    "tool": tool_name,
                    "origin": policy.tool_origin(tool_name),
                    "status": kwargs.get("status"),
                    "decision": decision,
                },
            )
            enqueue(self.home, event)
            self._flush_soon()
        except Exception:
            log.exception("post_tool_call")

    def pre_llm_call(self, session_id=None, user_message=None, turn_id=None, **kwargs):
        try:
            self.note_session(session_id)
            event = build_event(self._audit_snapshot(), session_id, turn_id, "user_prompt", user_message, {})
            enqueue(self.home, event)
            self._flush_soon()
        except Exception:
            log.exception("pre_llm_call")
        return None

    def post_llm_call(self, session_id=None, assistant_response=None, turn_id=None, **kwargs):
        try:
            event = build_event(self._audit_snapshot(), session_id, turn_id, "final", assistant_response, {})
            enqueue(self.home, event)
            self._flush_soon()
        except Exception:
            log.exception("post_llm_call")

    def on_session_start(self, session_id=None, **kwargs):
        try:
            self.note_session(session_id)
            self.current(force=True)
            self.beat()
            if session_id and session_id not in self.noticed:
                self.noticed.add(session_id)
                sys.stderr.write(policy.NOTICE + "\n")
        except Exception:
            log.exception("on_session_start")

    def on_session_end(self, session_id=None, **kwargs):
        self.sessions.discard(session_id)

    def llm_execution(self, request=None, next_call=None, provider=None, base_url=None, **kwargs):
        try:
            token_helper = load_exc_token()
            expected_url = token_helper.read_profile(self.home)[0] + "/api/model-gateway/v1" if token_helper else None
            allowed = policy.is_excellence_route(provider, base_url, expected_url)
        except Exception:
            log.exception("llm_execution")
            # A middleware fail-open: kivételre a Hermes továbbhívna. Inkább szintetikus elutasítás.
            return synthetic_refusal(policy.PROVIDER_BLOCK)
        if not allowed:
            return synthetic_refusal(policy.PROVIDER_BLOCK)
        if isinstance(request, dict):
            headers = dict(request.get("extra_headers") or {})
            for key, field in (("X-Excellence-Session", "session_id"), ("X-Excellence-Turn", "turn_id")):
                if kwargs.get(field):
                    headers = {name: value for name, value in headers.items() if name.lower() != key.lower()}
                    headers[key] = str(kwargs[field])[:200]
            request = {**request, "extra_headers": headers}
        # A provider hibája a Hermes újrapróbálási/tömörítési útjára tartozik.
        return next_call(request)

    def _origin_and_token(self):
        mod = load_exc_token()
        if mod is None:
            return None, None
        try:
            return mod.read_profile(self.home)[0], mod.get_token(self.home)
        except Exception:
            return None, None

    def _flush_soon(self):
        if os.environ.get("EXC_GUARD_OFFLINE") == "1":
            return
        try:
            self.flush_audit()
        except Exception:
            log.exception("audit flush")

    def flush_audit(self):
        origin, token = self._origin_and_token()
        if not origin or not token:
            return 0

        def post(events):
            status, _body = post_json(f"{origin}/api/ai-audit/events", token, {"events": events})
            if 200 <= status < 300:
                return "ok"
            if status in (400, 413):
                return "drop"
            return "retry"

        return flush_queue(self.home, post)

    def beat(self):
        if os.environ.get("EXC_GUARD_OFFLINE") == "1":
            return
        origin, token = self._origin_and_token()
        if not origin or not token:
            return
        interpreted = self.current()
        if interpreted.get("kind") == "snapshot":
            version = interpreted["snapshot"].get("policyVersion") or "unknown"
        elif interpreted.get("kind") == "revoked":
            version = "revoked"
        else:
            version = "offline-bound"
        if self._version is None:
            self._version = hermes_version()
        payload = {
            "configHash": config_hash(self.home),
            "managedDirHash": hash_managed_dir(managed_dir()),
            "policyVersion": str(version)[:200],
            "guardVersion": policy.GUARD_VERSION,
            "hermesVersion": self._version,
            "sessions": sorted(self.sessions)[:50],
        }
        status, body = post_json(f"{origin}/api/client-policy/heartbeat", token, payload)
        if status == 200 and isinstance(body, dict):
            interval = body.get("intervalSeconds")
            if isinstance(interval, int) and interval > 0:
                self.interval = interval

    def spawn(self):
        if os.environ.get("EXC_GUARD_DISABLE_BACKGROUND") == "1":
            return
        threading.Thread(target=self._loop, name="excellence-guard", daemon=True).start()

    def _loop(self):
        while True:
            time.sleep(max(self.interval, 15))
            try:
                self.current(force=True)
                self.beat()
                self.flush_audit()
            except Exception:
                log.exception("periodic")

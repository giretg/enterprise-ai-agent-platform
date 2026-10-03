"""Excellence Guard döntés (#775, spec §5.2, §9 R2/R4, D4).

Tiszta: nincs hálózat, nincs óra. A snapshot a V1-1 `GET /api/client-policy/snapshot`
alakja. Explicit tool-szabály (allow/approve/deny) előbb; ha nincs találat, a
képesség szintje dönt. Ismeretlen MCP-szerver company_only és plus_approved mellett
blokkol (U1). Hibás vagy hiányzó snapshot helyett a Kötött pálya preset.
"""
import os
import re

GUARD_VERSION = "0.1.0"
NOTICE = "Ez a munkatárs céges módban fut, a beszélgetéseid naplózásra kerülnek."
ASK = "Ha erre szükséged van, kérd a rendszergazdát."
OFFLINE_TTL_SECONDS = 3600
REVALIDATE_SECONDS = 15

# A V1-1 presetek képességszintjei (content_filter nélkül — az a gatewayé).
BOUND = {
    "code_execution": "denied",
    "local_files": "none",
    "browser": "denied",
    "web_search": "denied",
    "mcp_servers": "company_only",
    "skills": "approved_only",
    "local_memory": "excellence",
    "autonomous_run": "denied",
    "human_approval": "risky",
    "audit_depth": "plus_tool_results",
}
STANDARD = {
    **BOUND,
    "code_execution": "sandbox_only",
    "local_files": "read_only",
    "browser": "domain_allowlist",
    "web_search": "company_egress",
    "mcp_servers": "plus_approved",
    "autonomous_run": "audited",
    "audit_depth": "prompt_and_response",
}
FREE = {
    **BOUND,
    "code_execution": "local_free",
    "local_files": "project_write",
    "browser": "free",
    "web_search": "builtin",
    "mcp_servers": "plus_approved",
    "skills": "plus_own_audited",
    "local_memory": "local",
    "autonomous_run": "audited",
    "human_approval": "none",
    "audit_depth": "prompt_and_response",
}

_CODE = {"terminal", "process_manage", "execute_code", "close_terminal", "read_terminal"}
_FILE_READ = {"read_file", "search_files"}
_FILE_WRITE = {"write_file", "patch"}
_WEB = {"web_search", "web_extract", "x_search"}
_AUTO = {"delegate_task", "cronjob_manage"}
_SKILL_READ = {"skills_list", "skill_view"}
_SKILL_WRITE = {"skill_manage"}
_RULE_RANK = {"allow": 0, "approve": 1, "deny": 2}


class Decision:
    def __init__(self, action, message, capability=None, level=None):
        self.action = action  # allow | approve | block
        self.message = message
        self.capability = capability
        self.level = level

    def __repr__(self):
        return f"Decision({self.action!r}, {self.message!r})"


def bound_snapshot():
    return {
        "capabilities": dict(BOUND),
        "toolRules": [],
        "reasons": {key: {"source": "offline"} for key in BOUND},
        "policyVersion": "offline-bound",
    }


def snapshot_of(capabilities, tool_rules=(), version="test", source="user_preset"):
    return {
        "capabilities": dict(capabilities),
        "toolRules": list(tool_rules),
        "reasons": {key: {"source": source} for key in capabilities},
        "policyVersion": version,
    }


def sanitize_mcp_component(value):
    """Ugyanaz, mint a Hermes `sanitize_mcp_name_component`: nem [A-Za-z0-9_] → `_`."""
    return re.sub(r"[^A-Za-z0-9_]", "_", str(value or ""))


def mcp_server(tool_name):
    if not isinstance(tool_name, str) or not tool_name.startswith("mcp__"):
        return None
    server, sep, _tool = tool_name[5:].partition("__")
    return server if sep and server else None


def tool_origin(tool_name):
    return "mcp" if isinstance(tool_name, str) and tool_name.startswith("mcp__") else "local"


def company_servers():
    names = {"excellence"}
    primary = os.environ.get("EXCELLENCE_MCP_SERVER", "excellence").strip()
    if primary:
        names.add(primary)
    extra = os.environ.get("EXCELLENCE_COMPANY_MCP_SERVERS", "")
    names.update(part.strip() for part in extra.split(",") if part.strip())
    return {sanitize_mcp_component(name) for name in names}


def _classify(tool_name):
    if tool_name.startswith("mcp__"):
        return "mcp_servers", "mcp"
    if tool_name in _CODE:
        return "code_execution", "code"
    if tool_name in _FILE_READ:
        return "local_files", "file_read"
    if tool_name in _FILE_WRITE:
        return "local_files", "file_write"
    if tool_name.startswith("browser_") or tool_name == "computer_use":
        return "browser", "browser"
    if tool_name in _WEB:
        return "web_search", "web"
    if tool_name == "memory":
        return "local_memory", "memory"
    if tool_name in _AUTO:
        return "autonomous_run", "autonomous"
    if tool_name in _SKILL_READ:
        return "skills", "skill_read"
    if tool_name in _SKILL_WRITE:
        return "skills", "skill_write"
    return None, "other"


def _pattern(pattern):
    body = ".*".join(re.escape(part) for part in str(pattern).split("*"))
    return re.compile(f"^{body}$")


def matching_rule(rules, tool_name):
    """Az összes illeszkedő szabály közül a legszigorúbb (tiltás nyer)."""
    found = None
    for rule in rules or []:
        pattern = rule.get("pattern") if isinstance(rule, dict) else None
        action = rule.get("action") if isinstance(rule, dict) else None
        if not pattern or action not in _RULE_RANK:
            continue
        if _pattern(pattern).match(tool_name):
            found = action if found is None or _RULE_RANK[action] > _RULE_RANK[found] else found
    return found


def _why(source):
    if source == "offline":
        return "Az Excellence szerver most nem elérhető, ezért a szigorúbb, kötött pályás szabály érvényes."
    if source == "agent_ceiling":
        return "Ez az asszisztens nem erre való."
    if source in ("user_preset", "user_override"):
        return "A te céges beállításod ezt nem engedi."
    return "A céges szabály ezt nem engedi."


def _lead(kind, level, tool_name):
    server = mcp_server(tool_name)
    if kind == "mcp":
        shown = server or "ismeretlen"
        return f"A(z) „{shown}” külső eszköz nincs a céges listán, ezért a(z) „{tool_name}” hívás nem fut le."
    if kind == "code" and level == "sandbox_only":
        return "A kódot csak a céges homokozóban futtathatod, a saját gépeden nem."
    if kind == "code":
        return "Ezzel az asszisztenssel nem futtathatsz parancsot vagy kódot a gépeden."
    if kind == "file_read" or (kind == "file_write" and level == "none"):
        return "Ezzel az asszisztenssel nem nyithatsz helyi fájlt."
    if kind == "file_write":
        return "Fájlt olvashatsz, de írni vagy módosítani nem."
    if kind == "browser" and level == "company_cloud":
        return "A helyi böngésző nincs engedve. A céges böngésző ehhez az asszisztenshez még nem elérhető."
    if kind == "browser":
        return "A böngészőt ez a beállítás nem engedi."
    if kind == "web":
        return "A beépített webes keresés ki van kapcsolva."
    if kind == "memory":
        return "A helyi memória ki van kapcsolva."
    if kind == "autonomous":
        return "Önálló háttérfutást (másik asszisztens vagy időzített feladat) ez a beállítás nem enged."
    if kind == "skill_write":
        return "Új vagy módosított skillt ez a beállítás nem enged. Csak a jóváhagyott skillek használhatók."
    return f"A(z) „{tool_name}” művelet nincs engedve."


def _block(kind, level, tool_name, source, capability):
    text = f"{_lead(kind, level, tool_name)} {_why(source)} {ASK}"
    return Decision("block", text, capability, level)


def _approve(tool_name, capability, level, because):
    return Decision(
        "approve",
        f"A(z) „{tool_name}” csak a jóváhagyásoddal fut le. {because}",
        capability,
        level,
    )


def _is_risky(kind):
    return kind in {"code", "file_write", "browser", "autonomous", "skill_write", "mcp"}


def _capability_action(kind, level, tool_name):
    if kind == "code":
        if level in ("denied", "sandbox_only"):
            return "block"
        if level == "local_with_approval":
            return "approve"
        return "allow"
    if kind == "file_read":
        return "block" if level == "none" else "allow"
    if kind == "file_write":
        return "block" if level in ("none", "read_only") else "allow"
    if kind == "browser":
        if level in ("denied", "company_cloud"):
            return "block"
        if level == "domain_allowlist":
            return "approve"
        return "allow"
    if kind == "web":
        return "block" if level in ("denied", "company_egress") else "allow"
    if kind == "memory":
        return "block" if level == "denied" else "allow"
    if kind == "autonomous":
        return "block" if level == "denied" else "allow"
    if kind == "skill_write":
        return "block" if level == "approved_only" else "allow"
    if kind == "skill_read":
        return "allow"
    if kind == "mcp":
        if level == "free":
            return "allow"
        server = mcp_server(tool_name)
        if server and sanitize_mcp_component(server) in company_servers():
            return "allow"
        return "block"
    # R2: ami nincs a katalógusban, az nincs engedve (explicit toolRules előbb nyer).
    return "block"


def decide(snapshot, tool_name, args=None):
    """allow / approve / block. Az args a későbbi útvonal-policyhoz van fenntartva (#748)."""
    del args  # v0: a szint és a tool-szabály dönt, nem a parancs szövege
    if not isinstance(tool_name, str) or not tool_name:
        return Decision("block", f"Nem látom, milyen művelet indulna, ezért nem engedem. {ASK}")
    caps = (snapshot or {}).get("capabilities")
    if not isinstance(caps, dict):
        snapshot = bound_snapshot()
        caps = snapshot["capabilities"]
    capability, kind = _classify(tool_name)
    level = caps.get(capability) if capability else None
    if capability and not isinstance(level, str):
        level = BOUND.get(capability)
    source = ((snapshot.get("reasons") or {}).get(capability) or {}).get("source") or "tenant_default"

    rule = matching_rule((snapshot or {}).get("toolRules"), tool_name)
    if rule == "deny":
        return Decision(
            "block",
            f"A(z) „{tool_name}” műveletet a céges szabály tiltja. {_why(source)} {ASK}",
            capability,
            level,
        )
    if rule == "approve":
        return _approve(tool_name, capability, level, "A céges szabály jóváhagyáshoz köti.")
    if rule == "allow":
        return Decision("allow", "", capability, level)

    action = _capability_action(kind, level, tool_name)
    if action == "block":
        return _block(kind, level, tool_name, source, capability)
    if action == "approve":
        because = "A beállítás ezt csak jóváhagyással engedi."
        if kind == "browser" and level == "domain_allowlist":
            because = "A megengedett oldalak listája nélkül nem engedem szabadon a böngészőt."
        return _approve(tool_name, capability, level, because)

    approval = caps.get("human_approval") or "risky"
    if approval == "always" or (approval == "risky" and _is_risky(kind)):
        return _approve(tool_name, capability, level, "A céges szabály a kockázatos műveletet jóváhagyáshoz köti.")
    return Decision("allow", "", capability, level)


def decide_interpreted(interpreted, tool_name, args=None):
    """A cache-értelmezés eredménye: revoked / bound / snapshot."""
    kind = (interpreted or {}).get("kind")
    if kind == "revoked":
        return Decision(
            "block",
            "Ehhez az asszisztenshez már nincs hozzáférésed, ezért semmilyen műveletet nem engedek. Kérd a rendszergazdát.",
        )
    if kind == "bound":
        return decide(bound_snapshot(), tool_name, args)
    return decide((interpreted or {}).get("snapshot"), tool_name, args)


def interpret_cache(state, now, offline_ttl=OFFLINE_TTL_SECONDS):
    """A lemezen lévő snapshot. Érvényes 1 óráig (D4), utána Kötött pálya. Visszavonás azonnal blokkol."""
    if not isinstance(state, dict):
        return {"kind": "bound"}
    if state.get("revoked"):
        return {"kind": "revoked"}
    cached_at = state.get("cachedAt")
    snap = state.get("snapshot")
    if not isinstance(cached_at, (int, float)) or not isinstance(snap, dict) or not isinstance(snap.get("capabilities"), dict):
        return {"kind": "bound"}
    if now - cached_at >= offline_ttl:
        return {"kind": "bound"}
    return {"kind": "snapshot", "snapshot": snap}


def hook_body(decision):
    """Hermes pre_tool_call / shell-hook válasz. Az allow `{}`: a fail_closed a nem-JSON stdoutot blokkolná."""
    if decision.action == "allow":
        return {}
    if decision.action == "approve":
        return {"action": "approve", "message": decision.message, "rule_key": "excellence-guard"}
    return {"action": "block", "message": decision.message}


def keep_content(depth, kind, content):
    """A szerver is eldobja, ami a mélységen kívül esik; ide se küldjük a promptot, ha nem kell."""
    rank = {"metadata": 0, "prompt_and_response": 1, "plus_tool_results": 2}
    need = 2 if kind == "tool_call" else 1
    if rank.get(depth, 0) < need:
        return None
    return content


def is_excellence_route(provider, base_url):
    if str(provider or "").strip().lower() != "excellence":
        return False
    url = str(base_url or "").strip()
    return not url or "/api/model-gateway/" in url


PROVIDER_BLOCK = (
    "Ez a hívás nem a céges Excellence modellen menne, ezért megállítottam. "
    "Céges módban csak az Excellence modell használható, különben a beszélgetés kiesne a naplóból. "
    "Szólj a rendszergazdának, ha másik modell kell."
)

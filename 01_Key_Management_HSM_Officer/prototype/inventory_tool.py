#!/usr/bin/env python3
"""
Kulcs-leltár eszköz — Key Management / HSM Officer Asszisztens (prototípus v0.1)
Strukturált kulcs-leltár (inventory/model/key_inventory.json) kezelése.

Funkciók:
  --validate         Séma- és titok-ellenőrzés (key_inventory.schema.json).
  --report           Lejárat / kriptoperiódus (PCI 3.7.4) + integritás-riport.
  --tree             Kulcs-hierarchia kiírása (transport_key_ref alapján).
  --from-evidence F  Ceremónia-evidence JSON-ból leltár-frissítési JAVASLAT (nem ír felül).

Biztonság: a leltár SOHA nem tartalmazhat titkos kulcsanyagot. Az eszköz a sémán felül
mintázattal is kiszűri a kulcs-/PIN-szerű mezőket.
"""
import argparse, json, os, re, sys
from datetime import date, datetime

BASE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(BASE, "..", "inventory", "model")
INV = os.path.join(MODEL, "key_inventory.json")
SCHEMA = os.path.join(MODEL, "key_inventory.schema.json")
TODAY = date(2026, 6, 18)

FORBIDDEN_FIELDS = re.compile(r"key_value|component_value|secret|cleartext|\bpin\b|private_key_material", re.I)
FORBIDDEN_VALUE = re.compile(r"\b[0-9A-Fa-f]{16,}\b")  # 16+ hex = lehetséges teljes kulcs


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ---------- séma-validáció (jsonschema ha van, különben beépített ellenőrzés) ----------
def validate(inv, schema):
    errors = []
    used_lib = False
    try:
        import jsonschema
        Validator = getattr(jsonschema, "Draft202012Validator", None) or \
            getattr(jsonschema, "Draft7Validator", None)
        if Validator is not None:
            for e in Validator(schema).iter_errors(inv):
                errors.append(f"[schema] {'/'.join(map(str, e.path))}: {e.message}")
            used_lib = True
    except ImportError:
        pass
    if not used_lib:
        errors += _builtin_validate(inv, schema)
    # titok-ellenőrzés (mindig fut, a sémától függetlenül)
    for i, k in enumerate(inv.get("keys", [])):
        for field, val in k.items():
            if FORBIDDEN_FIELDS.search(field):
                errors.append(f"[titok] keys[{i}] tiltott mező: '{field}'")
            if isinstance(val, str) and FORBIDDEN_VALUE.search(val):
                errors.append(f"[titok] keys[{i}].{field}: lehetséges teljes kulcs/komponens (16+ hex)")
    return errors


def _builtin_validate(inv, schema):
    errs = []
    kdef = schema["$defs"]["key"]
    allowed = set(kdef["properties"].keys())
    req = kdef["required"]
    enums = {f: kdef["properties"][f]["enum"] for f in kdef["properties"] if "enum" in kdef["properties"][f]}
    for i, k in enumerate(inv.get("keys", [])):
        for r in req:
            if r not in k or k[r] in (None, ""):
                errs.append(f"[req] keys[{i}]: hiányzó kötelező mező '{r}'")
        for f in k:
            if f not in allowed:
                errs.append(f"[addl] keys[{i}]: ismeretlen mező '{f}' (additionalProperties:false)")
        for f, vals in enums.items():
            if f in k and k[f] not in vals:
                errs.append(f"[enum] keys[{i}].{f}='{k[f]}' nem érvényes ({vals})")
    return errs


# ---------- kriptoperiódus / lejárat ----------
def parse_duration(s):
    """ISO 8601 duration -> napok (durva: év=365, hó=30)."""
    if not s:
        return None
    m = re.fullmatch(r"P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?", s.strip())
    if not m:
        return None
    y, mo, d = (int(x) if x else 0 for x in m.groups())
    return y * 365 + mo * 30 + d


def parse_date(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s).date()
    except ValueError:
        return None


def report(inv):
    keys = inv["keys"]
    refs = {k["ref_num"] for k in keys}
    print(f"== Kulcs-leltár riport ({TODAY.isoformat()}) — {len(keys)} kulcs ==\n")

    overdue, soon = [], []
    for k in keys:
        due = parse_date(k.get("expiry_date"))
        if not due:
            base = parse_date((k.get("lifecycle") or {}).get("last_rotation_date")) or parse_date(k.get("creation_date"))
            days = parse_duration(k.get("cryptoperiod"))
            if base and days:
                due = date.fromordinal(base.toordinal() + days)
        if due:
            delta = (due - TODAY).days
            if delta < 0:
                overdue.append((k, due, delta))
            elif delta <= 30:
                soon.append((k, due, delta))

    print("--- 3.7.4/3.7.5 — Kriptoperiódus / lejárat ---")
    if overdue:
        print("  LEJÁRT (rotáció esedékes):")
        for k, due, d in overdue:
            print(f"    ! {k['ref_num']} {k['key_name']} — lejárt {due.isoformat()} ({-d} napja)")
    if soon:
        print("  30 napon belül esedékes:")
        for k, due, d in soon:
            print(f"    ~ {k['ref_num']} {k['key_name']} — {due.isoformat()} ({d} nap)")
    if not overdue and not soon:
        print("    Nincs közelgő lejárat.")

    print("\n--- Integritás-ellenőrzések ---")
    issues = []
    # orphan transport ref
    for k in keys:
        t = k.get("transport_key_ref")
        if t and t not in refs:
            issues.append(f"{k['ref_num']}: ismeretlen transport_key_ref '{t}'")
    # hiányzó KCV aktív kulcsnál
    for k in keys:
        if k.get("status") == "active" and not k.get("kcv"):
            issues.append(f"{k['ref_num']}: aktív kulcs, de nincs KCV (azonosíthatóság)")
    # PIN Req 19 — egy cél elv: ugyanaz a purpose több aktív kulcsnál csak figyelmeztetés
    seen = {}
    for k in keys:
        seen.setdefault(k.get("single_purpose", ""), []).append(k["ref_num"])
    for purpose, rs in seen.items():
        if len(rs) > 1 and purpose:
            issues.append(f"PIN Req 19 figyelmeztetés: '{purpose}' több kulcsnál: {', '.join(rs)}")
    if issues:
        for x in issues:
            print(f"    - {x}")
    else:
        print("    Nincs integritási eltérés.")
    return overdue, soon, issues


def tree(inv):
    keys = {k["ref_num"]: k for k in inv["keys"]}
    children = {}
    for k in inv["keys"]:
        children.setdefault(k.get("transport_key_ref"), []).append(k["ref_num"])

    def walk(ref, depth):
        k = keys[ref]
        print("  " * depth + f"{ref} ({k['key_type']}) — {k['key_name']}")
        for c in children.get(ref, []):
            walk(c, depth + 1)

    print("== Kulcs-hierarchia ==")
    for root in children.get(None, []):
        walk(root, 0)


def from_evidence(inv, evpath):
    ev = load(evpath)
    captured = {}
    for s in ev.get("steps", []):
        captured.update(s.get("captured", {}))
    ctype = ev.get("ceremony_type", "")
    print(f"== Leltár-frissítési JAVASLAT — forrás: {os.path.basename(evpath)} ({ctype}) ==")
    print("  (Ember hagyja jóvá; az eszköz NEM ír a leltárba.)\n")
    proposal = {
        "ref_num": captured.get("new_key_ref") or captured.get("lmk_id") or captured.get("key_ref") or "<TÖLTSD KI>",
        "key_name": ev.get("title", ""),
        "kcv": captured.get("new_key_kcv") or captured.get("lmk_kcv") or captured.get("component_kcv"),
        "creation_date": (ev.get("completed_at") or ev.get("started_at", ""))[:10],
        "lifecycle": {
            "created_by_ceremony": ctype if ctype in ("lmk_generation", "key_rotation") else None,
            "created_evidence_ref": os.path.basename(evpath),
        },
        "status": "decommissioned" if ctype == "key_decommission" else "active",
    }
    # titok-szűrés a javaslaton is
    for f, v in list(proposal.items()):
        if isinstance(v, str) and FORBIDDEN_VALUE.search(v):
            proposal[f] = "[VISSZAUTASÍTVA: tiltott titok]"
    print(json.dumps(proposal, ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--tree", action="store_true")
    ap.add_argument("--from-evidence")
    ap.add_argument("--inv", default=INV)
    a = ap.parse_args()
    inv = load(a.inv)

    if a.validate:
        errs = validate(inv, load(SCHEMA))
        if errs:
            print("VALIDÁCIÓ: HIBÁK\n" + "\n".join("  " + e for e in errs))
            sys.exit(1)
        print(f"VALIDÁCIÓ: OK — {len(inv['keys'])} kulcs, séma + titok-ellenőrzés rendben.")
    if a.tree:
        tree(inv)
    if a.report:
        report(inv)
    if a.from_evidence:
        from_evidence(inv, a.from_evidence)
    if not any([a.validate, a.report, a.tree, a.from_evidence]):
        ap.print_help()


if __name__ == "__main__":
    main()

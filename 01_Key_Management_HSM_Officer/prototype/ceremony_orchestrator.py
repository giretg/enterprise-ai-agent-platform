#!/usr/bin/env python3
"""
Key Management / HSM Officer Asszisztens — Ceremónia-orchestrátor (prototípus v0.1)
Ipoteka Bank · PCI DSS v4.0.1 (3.6.x / 3.7.x) · PCI PIN Req 18/28/29

MIT CSINÁL:
  - Betölti egy kulcsceremónia gépi config-ját (prototype/ceremonies/*.json).
  - Kikényszeríti a dual control / split knowledge / SoD szabályokat (pre-flight).
  - Lépésenként vezet: parancs -> EMBERI végrehajtás -> eredmény rögzítése.
  - Kiszűri a tiltott titkos anyagot (PIN / teljes kulcs / komponens) a nyomvonalból.
  - Auditálható evidence-jegyzőkönyvet generál (Markdown + JSON).

MIT NEM CSINÁL (tudatosan):
  - NEM csatlakozik a HSM-hez és NEM ad ki HSM-parancsot. Az ember hajtja végre,
    az orchestrátor csak vezérel és dokumentál (human-in-the-loop).

HASZNÁLAT:
  Interaktív:  python3 ceremony_orchestrator.py --ceremony lmk_generation
  Replay/teszt: python3 ceremony_orchestrator.py --ceremony lmk_generation --record session.example.json
"""
import argparse, json, os, re, sys
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
CEREMONY_DIR = os.path.join(BASE, "ceremonies")
OUTPUT_DIR = os.path.join(BASE, "output")

# A nyomvonalba SOHA nem kerülhet ilyen érték. Ezeket aktívan visszautasítjuk.
FORBIDDEN_PATTERNS = [
    (re.compile(r"\bPIN\b\s*[:=]", re.I), "PIN érték"),
    (re.compile(r"secret\s*value", re.I), "kulcs-komponens titok"),
    (re.compile(r"\b[0-9A-Fa-f]{16,}\b"), "lehetséges teljes kulcs/komponens (>=16 hex)"),
]


def load_ceremony(ctype):
    path = os.path.join(CEREMONY_DIR, ctype + ".json")
    if not os.path.exists(path):
        sys.exit(f"HIBA: nincs ilyen ceremónia-config: {path}")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def redact_check(value):
    """Igaz, ha az érték tiltott titkot tartalmazhat."""
    for pat, label in FORBIDDEN_PATTERNS:
        if pat.search(str(value)):
            return label
    return None


def validate_dual_control(cfg, participants):
    """Dual control / split knowledge / SoD kikényszerítése. (issues, ok)"""
    issues = []
    req = cfg.get("roles_required", {})
    # szerepkörönkénti egyedi személyek
    by_role = {}
    person_roles = {}
    for p in participants:
        by_role.setdefault(p["role"], set()).add(p["name"])
        person_roles.setdefault(p["name"], set()).add(p["role"])

    for role, count in req.items():
        have = len(by_role.get(role, set()))
        if have < count:
            issues.append(f"Hiányzó szerep: '{role}' — kell {count}, van {have}.")

    # split knowledge: a key custodianok legyenek különböző személyek
    kc = by_role.get("key_custodian", set())
    if "key_custodian" in req and len(kc) < req["key_custodian"]:
        issues.append("Split knowledge sérül: nincs elég KÜLÖNBÖZŐ key custodian.")

    # SoD: ütköző szerep-párok ugyanannál a személynél
    conflict_pairs = [
        ("key_custodian", "authorization_officer"),
        ("key_custodian", "witness"),
        ("authorization_officer", "witness"),
        ("handover_custodian", "takeover_custodian"),
    ]
    for person, roles in person_roles.items():
        for a, b in conflict_pairs:
            if a in roles and b in roles:
                issues.append(f"SoD sérül: '{person}' egyszerre '{a}' és '{b}'.")
    return issues, len(issues) == 0


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def get_input(prompt, recorded, key):
    if recorded is not None:
        val = recorded.get(key, "")
        print(f"{prompt} [replay] -> {val}")
        return str(val)
    return input(prompt).strip()


def run(cfg, record=None):
    session = {
        "ceremony_type": cfg["ceremony_type"],
        "title": cfg["title"],
        "started_at": now_iso(),
        "pci_references": cfg.get("pci_references", []),
        "participants": [],
        "preflight": [],
        "steps": [],
        "closeout": [],
        "warnings": [],
    }
    rec = record or {}

    # --- résztvevők ---
    if record:
        session["participants"] = rec.get("participants", [])
    else:
        print("\n== Résztvevők rögzítése (üres név = vége) ==")
        print("Szerepek: key_custodian | authorization_officer | security_officer")
        while True:
            name = input("  Név: ").strip()
            if not name:
                break
            role = input("  Szerep: ").strip()
            emp = input("  Employee ID: ").strip()
            session["participants"].append({"name": name, "role": role, "employee_id": emp})

    # --- dual control / SoD ---
    issues, ok = validate_dual_control(cfg, session["participants"])
    if not ok:
        print("\n*** PRE-FLIGHT ELUTASÍTVA — dual control / SoD nem teljesül: ***")
        for i in issues:
            print("   -", i)
        session["warnings"].extend(issues)
        session["aborted"] = True
        session["aborted_reason"] = "dual_control_failed"
        _write_evidence(cfg, session)
        print("\nA ceremónia NEM indítható. Jegyzőkönyv (elutasítás) elmentve.")
        return session
    print("\n[OK] Dual control / split knowledge / SoD teljesül.")

    # --- pre-flight checklist ---
    print("\n== Pre-flight checklist ==")
    for item in cfg.get("preflight", []):
        ans = get_input(f"  [megerősít? i/n] {item}\n   > ", rec.get("preflight_answers"), item) if record else input(f"  [i/n] {item}\n   > ").strip().lower()
        confirmed = str(ans).lower() in ("i", "y", "igen", "yes", "true")
        session["preflight"].append({"item": item, "confirmed": confirmed})
        if not confirmed:
            session["warnings"].append(f"Pre-flight nem megerősítve: {item}")

    if any(not p["confirmed"] for p in session["preflight"]):
        session["aborted"] = True
        session["aborted_reason"] = "preflight_unconfirmed"
        _write_evidence(cfg, session)
        print("\n*** Pre-flight tétel nincs megerősítve — a ceremónia NEM folytatható. ***")
        return session

    # --- lépések ---
    print("\n== Ceremónia lépések ==")
    recorded_steps = {str(s["n"]): s for s in rec.get("steps", [])} if record else {}
    for st in cfg["steps"]:
        rstep = recorded_steps.get(str(st["n"]))
        print(f"\nLÉPÉS {st['n']}/{len(cfg['steps'])} — {st['desc']}")
        print(f"  Parancs:       {st['command']}")
        print(f"  Várt eredmény: {st['expected']}")
        print("  >> Hajtsd végre a HSM-en, majd add meg az eredményt. <<")
        operator = get_input("  Végrehajtó neve: ", rstep, "operator")
        result = get_input("  Tényleges eredmény (KCV/check/üzenet; NE adj meg PIN-t vagy kulcsot!): ", rstep, "result")

        forbidden = redact_check(result)
        captured = {}
        if forbidden:
            result = "[VISSZAUTASÍTVA: tiltott titok került be — " + forbidden + "]"
            session["warnings"].append(f"{st['n']}. lépés: tiltott titok kiszűrve ({forbidden}).")
        else:
            for cap in st.get("capture", []):
                cval = get_input(f"    {cap}: ", rstep, cap) if (not record or (rstep and cap in rstep)) else ""
                if cval and not redact_check(cval):
                    captured[cap] = cval

        session["steps"].append({
            "n": st["n"], "desc": st["desc"], "command": st["command"],
            "operator": operator, "result": result, "captured": captured,
            "timestamp": now_iso(),
        })

    # --- closeout ---
    print("\n== Lezárás ==")
    for item in cfg.get("closeout", []):
        ans = get_input(f"  [i/n] {item}\n   > ", rec.get("closeout_answers"), item) if record else input(f"  [i/n] {item}\n   > ").strip().lower()
        session["closeout"].append({"item": item, "confirmed": str(ans).lower() in ("i", "y", "igen", "yes", "true")})

    session["completed_at"] = now_iso()
    session["aborted"] = False
    _write_evidence(cfg, session)
    return session


def _write_evidence(cfg, session):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = f"{stamp}_{session['ceremony_type']}_evidence"
    json_path = os.path.join(OUTPUT_DIR, base + ".json")
    md_path = os.path.join(OUTPUT_DIR, base + ".md")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(session, f, ensure_ascii=False, indent=2)

    L = []
    L.append(f"# Kulcsceremónia jegyzőkönyv — {session['title']}")
    L.append("")
    L.append(f"> Ipoteka Bank · {session['ceremony_type']} · generálva: {now_iso()}")
    L.append(f"> PCI hivatkozás: {', '.join(session['pci_references'])}")
    L.append("")
    status = "MEGSZAKÍTVA — " + session.get("aborted_reason", "") if session.get("aborted") else "BEFEJEZVE"
    L.append(f"**Státusz:** {status}")
    L.append("")
    L.append("## Résztvevők")
    L.append("| Név | Szerep | Employee ID |")
    L.append("|---|---|---|")
    for p in session["participants"]:
        L.append(f"| {p.get('name','')} | {p.get('role','')} | {p.get('employee_id','')} |")
    L.append("")
    L.append("## Pre-flight ellenőrzés")
    for p in session["preflight"]:
        L.append(f"- [{'x' if p['confirmed'] else ' '}] {p['item']}")
    if not session["preflight"]:
        L.append("- (nem futott — pre-flight előtt megszakítva)")
    L.append("")
    if session["steps"]:
        L.append("## Ceremónia lépések")
        L.append("| # | Leírás | Parancs | Végrehajtó | Eredmény | Rögzített | Időbélyeg |")
        L.append("|---|---|---|---|---|---|---|")
        for s in session["steps"]:
            cap = "; ".join(f"{k}={v}" for k, v in s["captured"].items())
            L.append(f"| {s['n']} | {s['desc']} | `{s['command']}` | {s['operator']} | {s['result']} | {cap} | {s['timestamp']} |")
        L.append("")
    if session["closeout"]:
        L.append("## Lezárás")
        for c in session["closeout"]:
            L.append(f"- [{'x' if c['confirmed'] else ' '}] {c['item']}")
        L.append("")
    if session["warnings"]:
        L.append("## ⚠️ Figyelmeztetések / eltérések")
        for w in session["warnings"]:
            L.append(f"- {w}")
        L.append("")
    L.append("## Aláírások")
    L.append("")
    for p in session["participants"]:
        L.append(f"- {p.get('role','')} — {p.get('name','')}: __________________________  dátum: __________")
    L.append("")
    L.append("---")
    L.append("*Megjegyzés: e jegyzőkönyv nem tartalmaz PIN-t, teljes kulcsértéket vagy "
             "komponens-titkot — kizárólag azonosítókat, KCV/check value-t és metaadatot "
             "(PCI DSS 3.6.x / 3.7.x, evidence-first elv).*")

    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    print(f"\n[evidence] {md_path}")
    print(f"[evidence] {json_path}")


def main():
    ap = argparse.ArgumentParser(description="Kulcsceremónia-orchestrátor (human-in-the-loop)")
    ap.add_argument("--ceremony", required=True, help="ceremónia típus (ceremonies/<típus>.json)")
    ap.add_argument("--record", help="előre rögzített session JSON (replay/teszt módhoz)")
    args = ap.parse_args()
    cfg = load_ceremony(args.ceremony)
    rec = None
    if args.record:
        with open(args.record, encoding="utf-8") as f:
            rec = json.load(f)
    run(cfg, record=rec)


if __name__ == "__main__":
    main()

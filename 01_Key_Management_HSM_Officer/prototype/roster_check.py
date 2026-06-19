#!/usr/bin/env python3
"""
Custodian roster SoD-ellenőrző — Key Management / HSM Officer Asszisztens.
Beolvassa az inventory/model/custodian_roster.json-t és kimutatja a feladatkör-
szétválasztási (separation of duties / dual control) konfliktusokat.

PCI alap: DSS 3.7.6 (split knowledge + dual control), PIN Req 18/28/29.
Elv: aki egy kulcs-komponenst birtokol (custodian), az ne authorizálja és ne is
hajtsa végre ugyanazt a műveletet — különben egy kézben túl sok kontroll összpontosul.

Használat: python3 roster_check.py
"""
import json, os

BASE = os.path.dirname(os.path.abspath(__file__))
ROSTER = os.path.join(BASE, "..", "inventory", "model", "custodian_roster.json")

CUSTODIAN_ROLES = {"key_custodian", "deputy_key_custodian"}

# (roleA, roleB): (súlyosság, indok)
CONFLICTS = {
    frozenset({"key_custodian", "authorization_officer"}):
        ("MAGAS", "Dual control sérül: az AO authorizálja azt a műveletet, amelyhez a custodian a komponenst birtokolja."),
    frozenset({"deputy_key_custodian", "authorization_officer"}):
        ("MAGAS", "Dual control sérül (deputy szinten): a komponenst birtokló deputy egyben authorizál."),
    frozenset({"key_custodian", "hsm_operator"}):
        ("KÖZEPES", "A HSM-operátor végzi a műveletet, a custodian birtokolja a komponenst — egy kézben túl sok kontroll."),
    frozenset({"deputy_key_custodian", "hsm_operator"}):
        ("KÖZEPES", "Deputy custodian egyben HSM-operátor — a végrehajtás és a komponens-birtoklás nem válik szét."),
    frozenset({"security_officer", "authorization_officer"}):
        ("FELÜLVIZSGÁLAT", "A Security Officer vezeti a ceremóniát ÉS authorizál is — ajánlott külön személyre bontani."),
}


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def main():
    roster = load(ROSTER)
    people = roster["people"]
    print(f"== Custodian roster SoD-ellenőrzés — {len(people)} fő ==\n")

    # 1) szerep-átfedés konfliktusok
    print("--- 1. Szerep-átfedés (egy személy több ütköző szerepben) ---")
    found = []
    for p in people:
        roles = set(p["roles"])
        for pair, (sev, why) in CONFLICTS.items():
            if pair <= roles:
                found.append((sev, p["name"], p.get("department", ""), sorted(pair), why))
    order = {"MAGAS": 0, "KÖZEPES": 1, "FELÜLVIZSGÁLAT": 2}
    for sev, name, dept, pair, why in sorted(found, key=lambda x: order[x[0]]):
        print(f"  [{sev}] {name} ({dept}): {' + '.join(pair)}")
        print(f"          → {why}")
    if not found:
        print("  Nincs szerep-átfedési konfliktus.")

    # 2) lefedettség / split knowledge
    print("\n--- 2. Lefedettség és split knowledge ---")
    def by_role(r):
        return [p for p in people if r in p["roles"]]
    kc = by_role("key_custodian")
    dkc = by_role("deputy_key_custodian")
    ao = by_role("authorization_officer")
    so = by_role("security_officer")
    op = by_role("hsm_operator")
    print(f"  Key custodian: {len(kc)} ({', '.join(p['name'] for p in kc)})")
    print(f"  Deputy KC:     {len(dkc)} ({', '.join(p['name'] for p in dkc)})")
    print(f"  Auth. officer: {len(ao)} ({', '.join(p['name'] for p in ao)})")
    print(f"  Security off.: {len(so)} ({', '.join(p['name'] for p in so)})")
    print(f"  HSM operator:  {len(op)} ({', '.join(p['name'] for p in op)})")
    cks = "OK" if len(kc) >= 3 else "FIGYELEM (<3)"
    print(f"  Split knowledge (≥3 különböző KC): {cks}")
    depts = {p.get("department") for p in kc}
    print(f"  KC részleg-diverzitás: {len(depts)} részleg ({', '.join(sorted(d for d in depts if d))})")

    # 3) javasolt konfliktusmentes LMK-felállás
    print("\n--- 3. Javasolt konfliktusmentes LMK-felállás ---")
    pure_kc = [p["name"] for p in kc if "authorization_officer" not in p["roles"]]
    pure_ao = [p["name"] for p in ao if not (CUSTODIAN_ROLES & set(p["roles"]))]
    print(f"  'Tiszta' key custodian (nem AO): {pure_kc or '— nincs elég!'}")
    print(f"  'Tiszta' authorization officer (nem custodian): {pure_ao or '— nincs!'}")
    if len(pure_kc) < 2 or not pure_ao:
        print("  ⚠️  A jelenlegi rosterből nem állítható ki konfliktusmentes ceremónia a")
        print("      MAGAS súlyosságú átfedések feloldása nélkül (lásd 1. pont).")

    print(f"\nÖsszesen: {sum(1 for f in found if f[0]=='MAGAS')} MAGAS, "
          f"{sum(1 for f in found if f[0]=='KÖZEPES')} KÖZEPES, "
          f"{sum(1 for f in found if f[0]=='FELÜLVIZSGÁLAT')} felülvizsgálandó konfliktus.")


if __name__ == "__main__":
    main()

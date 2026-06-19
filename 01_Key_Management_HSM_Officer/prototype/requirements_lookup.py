#!/usr/bin/env python3
"""
Forrásolt követelmény-lekérdező — Key Management / HSM Officer Asszisztens
A knowledge/standards/requirements_index.json alapján keres követelményeket
ID, kulcsszó vagy ceremónia szerint. Minden találat forrással (PDF + oldal) jön vissza,
így az agent SOHA nem ad ki forrás nélküli állítást.

Példák:
  python3 requirements_lookup.py --id "3.7.6"
  python3 requirements_lookup.py --keyword "dual control"
  python3 requirements_lookup.py --ceremony key_decommission
"""
import argparse, json, os

IDX = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "knowledge", "standards", "requirements_index.json")


def load():
    with open(IDX, encoding="utf-8") as f:
        return json.load(f)


def show(reqs, sources):
    if not reqs:
        print("Nincs találat. (Forrás nélkül nem adok ki állítást.)")
        return
    for r in reqs:
        src = sources.get(r["source"], r["source"])
        print(f"\n[{r['id']}] {r['title']}")
        print(f"  {r['text']}")
        print(f"  Forrás: {src}, p.{r['page']}  ·  ceremóniák: {', '.join(r['ceremonies']) or '—'}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id")
    ap.add_argument("--keyword")
    ap.add_argument("--ceremony")
    a = ap.parse_args()
    data = load()
    reqs = data["requirements"]
    sources = data["meta"]["sources"]
    if a.id:
        reqs = [r for r in reqs if a.id.lower() in r["id"].lower()]
    if a.keyword:
        k = a.keyword.lower()
        reqs = [r for r in reqs if k in (r["title"] + " " + r["text"]).lower()]
    if a.ceremony:
        reqs = [r for r in reqs if a.ceremony in r["ceremonies"]]
    show(reqs, sources)


if __name__ == "__main__":
    main()

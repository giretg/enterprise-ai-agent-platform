#!/usr/bin/env python3
"""
Magyar e-hiteles tulajdoni lap (TULLAP) PDF -> strukturált JSON.

Használat:
    python3 parse_tulajdoni_lap.py <lap.pdf> [-o kimenet.json] [--quiet]

A kimenet egy JSON, ami szétválasztja a HATÁLYOS és a TÖRÖLT bejegyzéseket, és
tulajdonosonként összesíti a hatályos hányadokat. A szkript magától validál:
a hatályos tulajdoni hányadok összegének pontosan 1-nek kell lennie. Ha nem az,
a parse hibás (vagy a lap különleges) -- a `valid: false` és a hangos figyelmeztetés
ezt jelzi, ne dolgozz tovább az adattal, amíg ez nem tisztázódik.

Függőség: pypdf  (pip install pypdf)
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from fractions import Fraction

try:
    from pypdf import PdfReader
except ImportError:
    sys.exit("Hiányzik a pypdf. Telepítsd:  pip install pypdf")


# --------------------------------------------------------------------------
# 1. Szöveg kinyerése + oldal-szemét eltávolítása
# --------------------------------------------------------------------------

FOOTER_PATTERNS = [
    "Folytatás a következő oldalon",
    "Folytatás az előző oldalról",
]


def extract_pages(pdf_path):
    reader = PdfReader(pdf_path)
    return [(page.extract_text() or "") for page in reader.pages]


def _common_prefix_lines(pages):
    """A minden oldalon ismétlődő fejléc megkeresése.

    A fejléc oldalanként azonos, kivéve az oldalszámot tartalmazó sort -- ezért
    soronként hasonlítunk, és az oldalszám-mintát tartalmazó sort jokerként
    kezeljük. Ez általánosabb, mint egy adott földhivatal fejlécére illeszteni.
    """
    if len(pages) < 2:
        return 0
    line_lists = [p.split("\n") for p in pages[1:]]  # 1. oldal fejléce eltérhet
    shortest = min(len(x) for x in line_lists)
    n = 0
    for i in range(shortest):
        vals = {ll[i].strip() for ll in line_lists}
        if len(vals) == 1:
            n += 1
            continue
        # Az oldalszámot tartalmazó sor oldalanként más -- ez is fejléc.
        if all(re.search(r"Oldal\s*\d+|/\d+\s*Oldal", v) for v in vals):
            n += 1
            continue
        break
    return n


def strip_furniture(pages):
    """Fejléc/lábléc eltávolítása, majd az oldalak egyetlen szöveggé fűzése.

    Az összefűzés azért fontos, mert a bejegyzések átlógnak oldalhatáron: ha
    oldalanként parse-olnál, a határon lévő bejegyzések csonkulnának.
    """
    header_len = _common_prefix_lines(pages)
    cleaned = []
    for idx, page in enumerate(pages):
        lines = page.split("\n")
        if idx == 0:
            # Az első oldal fejléce ugyanaz a blokk, csak a "Folytatás az előző
            # oldalról" sor hiányzik róla; ugyanannyi sort vágunk.
            lines = lines[header_len:]
        else:
            lines = lines[header_len:]
        keep = []
        for line in lines:
            s = line.strip()
            if any(s == pat or s.startswith(pat) for pat in FOOTER_PATTERNS):
                continue
            keep.append(line)
        cleaned.append("\n".join(keep))
    return "\n".join(cleaned)


# --------------------------------------------------------------------------
# 2. Szakaszokra bontás
# --------------------------------------------------------------------------

SECTION_MARKERS = [
    ("szeljegyzek", r"^SZÉLJEGYZÉK\s*$"),
    ("resz1", r"^I\.\s*RÉSZ\s*$"),
    ("resz2", r"^II\.\s*RÉSZ\s*$"),
    ("resz3", r"^III\.\s*RÉSZ\s*$"),
]


def split_sections(text):
    lines = text.split("\n")
    marks = []
    for i, line in enumerate(lines):
        s = line.strip()
        for name, pat in SECTION_MARKERS:
            if re.match(pat, s):
                marks.append((i, name))
                break
    sections = {}
    for j, (idx, name) in enumerate(marks):
        end = marks[j + 1][0] if j + 1 < len(marks) else len(lines)
        sections[name] = "\n".join(lines[idx + 1 : end])
    return sections


# --------------------------------------------------------------------------
# 3. Bejegyzések parse-olása
# --------------------------------------------------------------------------

ENTRY_DELIM = "Bejegyző határozat, érkezési idő:"

# Ugyanaz a fogalom kétféle címkével szerepel, mert a ~2025 őszétől iktatott
# (INYER-es) bejegyzések új sablont használnak. Mindkettőt ismernünk kell,
# különben a legfrissebb -- és a jelen állapot szempontjából legfontosabb --
# bejegyzések némán kimaradnának.
FIELD_ALIASES = {
    "jogcim": ["Jogváltozás jogcíme", "Jogcím"],
    "jogallas": ["Jogállás"],
    "hanyad": ["Tulajdoni hányad"],
    "nev": ["Név"],
    "cim": ["Jogosult címe"],
    "utalas": ["Utalás a törölt bejegyzésre", "Utalás az eredeti bejegyzésre", "Utalás"],
    "eredeti_hatarozat": ["Eredeti bejegyzés/szerzés iktatószáma", "Eredeti határozat"],
    "jog_terjedelme": ["Jog terjedelme"],
    "hatosag": ["A felhívást kiadó hatóság adatai", "Hatóság megnevezése"],
    "hatarozat_szama": ["Határozat száma"],
    "kovetelés_osszege": ["Követelés összege"],
}

HANYAD_RE = re.compile(r"(\d[\d\s]*)\s*/\s*(\d[\d\s]*)")
NEV_RE = re.compile(
    r"Név:\s*(?P<nev>[^,\n]+?)"
    r"(?:,\s*Születési név:\s*(?P<szuletesi_nev>[^,\n]+?))?"
    r"(?:,\s*Születési év:\s*(?P<szuletesi_ev>\d{4}))?"
    r"(?:,\s*Anyja neve:\s*(?P<anyja_neve>[^,\n]+?))?"
    r"\s*$",
    re.M,
)


def _find_field(block, key):
    """Egy mező értéke a bejegyzés szövegéből, az összes ismert címke-variánssal."""
    for label in FIELD_ALIASES[key]:
        m = re.search(rf"^{re.escape(label)}:\s*(.+)$", block, re.M)
        if m:
            return m.group(1).strip()
    return None


def parse_entries(section_text, section_name):
    """Bejegyzések listája egy szakaszból.

    A bejegyzés a "Bejegyző határozat, érkezési idő:" sorral kezdődik; a
    törlés ténye ("Törlő határozat") a sorszám ELŐTT, a fejléc-dobozban áll --
    ezért a törlés-vizsgálatot a sorszám előtti részen kell végezni, nem a
    bejegyzés törzsében.
    """
    chunks = section_text.split(ENTRY_DELIM)[1:]
    entries = []
    for chunk in chunks:
        # A sorszám ("17.") választja el a fejléc-dobozt a törzstől.
        m = re.search(r"^\s*(\d+)\.\s*$", chunk, re.M)
        if not m:
            continue
        head = chunk[: m.start()]
        body = chunk[m.end() :]
        sorszam = int(m.group(1))

        torlo = None
        tm = re.search(r"Törlő határozat\s*\n\s*(.+)", head)
        if tm:
            torlo = tm.group(1).strip()

        bejegyzo = head.split("Törlő határozat")[0].strip().split("\n")
        bejegyzo = next((b.strip() for b in bejegyzo if b.strip()), None)

        body_lines = [l for l in body.split("\n") if l.strip()]
        tipus = body_lines[0].strip() if body_lines else None

        entry = {
            "resz": section_name,
            "sorszam": sorszam,
            "tipus": tipus,
            "bejegyzo_hatarozat": bejegyzo,
            "torlo_hatarozat": torlo,
            "hatalyos": torlo is None,
        }

        for key in FIELD_ALIASES:
            val = _find_field(body, key)
            if val:
                entry[key] = val

        hm = HANYAD_RE.search(entry.get("hanyad", "") or "")
        if hm:
            entry["szamlalo"] = int(re.sub(r"\s", "", hm.group(1)))
            entry["nevezo"] = int(re.sub(r"\s", "", hm.group(2)))

        nm = NEV_RE.search(body)
        if nm:
            for k, v in nm.groupdict().items():
                if v:
                    entry[k if k != "nev" else "nev"] = v.strip()

        entry["raw"] = body.strip()
        entries.append(entry)
    return entries


def parse_szeljegyek(text):
    """Széljegyek: folyamatban lévő, MÉG NEM hatályos ügyek.

    Fontos, hogy ezek külön kerüljenek: a széljegy azt jelenti, hogy egy
    beadvány érkezett, de a földhivatal még nem jegyezte be -- tehát a mai
    tulajdoni állapotot NEM módosítja, viszont előrevetíti a következő változást.

    Egy széljegy jellemzően KÉT "Széljegy:" sorral kezdődik (azonosító, majd
    azonosító + időbélyeg), ezért azonosító szerint össze kell vonni, különben
    duplán számolnád őket.
    """
    if not text:
        return []
    blocks = re.split(r"\n(?=Széljegy:)", text)
    merged = {}
    order = []
    for b in blocks:
        b = b.strip()
        if not b:
            continue
        first = b.split("\n")[0].replace("Széljegy:", "").strip()
        base = first.split(" - ")[0].strip()
        if base not in merged:
            merged[base] = {"azonosito": base, "szoveg": b}
            order.append(base)
        else:
            merged[base]["szoveg"] += "\n" + b
    return [merged[k] for k in order]


# Az I. RÉSZ táblázatból a pypdf összekeveri az oszlopsorrendet (a
# "Földrészlet összesen" sorban pl. az AK és a terület összeragad), ezért a
# soronkénti adatsorokat olvassuk ki, nem az összesítő sort.
# `[^\S\n]` = vízszintes whitespace: a sima `\s` átlógna a sortörésen, és az
# előző sor végét is beszippantaná.
# A "ha" rész opcionális: 1 hektárnál kisebb tételnél csak a nm szerepel
# (pl. "6 osztály 7792 9,51" = 0,7792 ha).
_H = r"[^\S\n]"
OSZTALY_RE = re.compile(
    rf"^(\d+){_H}*osztály{_H}+(?:(\d+){_H}+)?(\d{{4}}){_H}+([\d,]+){_H}*$", re.M
)
ALRESZLET_RE = re.compile(
    rf"^([^\d\n]*?){_H}*([^\d\n]+?){_H}+(?:(\d+){_H}+)?(\d{{4}}){_H}+([\d,]+){_H}*$",
    re.M,
)


def _num(s):
    return s.replace(",", ".")


def _ha(ha_part, nm_part):
    """"82" + "8770" -> "82.8770";  None + "7792" -> "0.7792"."""
    return f"{ha_part or 0}.{nm_part}"


def parse_ingatlan(text):
    """I. RÉSZ -- az ingatlan fizikai adatai (terület, AK, művelési ág).

    A terület "<ha> <nm>" alakban áll (pl. "82 8770" = 82,8770 ha), az AK
    magyar tizedesvesszővel.
    """
    if not text:
        return {}
    out = {"raw": text.strip()}

    osztalyok = []
    for m in OSZTALY_RE.finditer(text):
        osztalyok.append(
            {
                "osztaly": m.group(1),
                "terulet_ha": _ha(m.group(2), m.group(3)),
                "ak": _num(m.group(4)),
            }
        )
    if osztalyok:
        out["minosegi_osztalyok"] = osztalyok

    alreszletek = []
    for m in ALRESZLET_RE.finditer(text):
        ag = m.group(2).strip(" .")
        if not ag or "osztály" in ag or "összesen" in ag.lower():
            continue
        alreszletek.append(
            {
                "jel": (m.group(1) or "").strip(" .") or None,
                "muvelesi_ag": ag,
                "terulet_ha": _ha(m.group(3), m.group(4)),
                "ak": _num(m.group(5)),
            }
        )
    if alreszletek:
        out["alreszletek"] = alreszletek
        out["muvelesi_agak"] = sorted({a["muvelesi_ag"] for a in alreszletek})
        # Egy alrészlet esetén az a földrészlet egésze; többnél összegzünk.
        out["terulet_ha_osszesen"] = (
            alreszletek[0]["terulet_ha"]
            if len(alreszletek) == 1
            else f"{sum(float(a['terulet_ha']) for a in alreszletek):.4f}"
        )
        out["ak_osszesen"] = (
            alreszletek[0]["ak"]
            if len(alreszletek) == 1
            else f"{sum(float(a['ak']) for a in alreszletek):.2f}"
        )
    return out


# --------------------------------------------------------------------------
# 4. Összesítés + validáció
# --------------------------------------------------------------------------

def _norm_name(s):
    """Névkulcs egységesítése.

    Az újabb (INYER-es) bejegyzések CSUPA NAGYBETŰVEL írják a nevet, a régiek
    Kezdőbetűsen -- ugyanaz a személy így két külön vödörbe esne, és a
    tulajdonrésze megosztva, alábecsülve jelenne meg. Ezért kisbetűsítve és
    normalizált szóközökkel kulcsolunk.
    """
    return re.sub(r"\s+", " ", (s or "").strip()).casefold()


def summarize_owners(resz2_entries):
    """Tulajdonosonkénti hatályos hányad.

    Egy személy jellemzően TÖBB bejegyzésben szerepel (pl. évek alatt felvásárolt
    részarányok), ezért az aktuális tulajdonrész csak a hatályos sorok összegéből
    jön ki -- egyetlen bejegyzés önmagában félrevezető.

    A kulcs név + születési év + anyja neve, mert azonos nevű, de különböző
    személyek is előfordulnak ugyanazon a lapon (pl. apa és fia).
    """
    buckets = defaultdict(
        lambda: {"hanyad": Fraction(0), "bejegyzesek": [], "nev_valtozatok": set()}
    )
    for e in resz2_entries:
        if not e.get("hatalyos"):
            continue
        if "szamlalo" not in e or not e.get("nev"):
            continue
        jogallas = (e.get("jogallas") or "").upper()
        # A joggyakorló szervezet nem önálló tulajdonos: ugyanahhoz a Magyar
        # Állam-hányadhoz tartozik, összeadva duplán számolna.
        if "JOGGYAKORL" in jogallas or "GYAKORLÓ" in jogallas:
            continue
        if "HASZONÉLVEZ" in jogallas:
            continue
        key = (
            _norm_name(e.get("nev")),
            e.get("szuletesi_ev", ""),
            _norm_name(e.get("anyja_neve")),
        )
        b = buckets[key]
        b["hanyad"] += Fraction(e["szamlalo"], e["nevezo"])
        b["bejegyzesek"].append(e["sorszam"])
        b["nev_valtozatok"].add(e["nev"].strip())
        b["cim"] = e.get("cim")
        b["anyja_display"] = e.get("anyja_neve")

    owners = []
    for (_, ev, _), v in buckets.items():
        # Megjelenítéshez a nem csupa-nagybetűs alak olvashatóbb, ha van ilyen.
        variants = sorted(v["nev_valtozatok"])
        display = next((n for n in variants if not n.isupper()), variants[0])
        owners.append(
            {
                "nev": display,
                "nev_valtozatok": variants if len(variants) > 1 else None,
                "szuletesi_ev": ev or None,
                "anyja_neve": v.get("anyja_display"),
                "cim": v.get("cim"),
                "hanyad": f"{v['hanyad'].numerator}/{v['hanyad'].denominator}",
                "szazalek": round(float(v["hanyad"]) * 100, 6),
                "bejegyzes_sorszamok": sorted(v["bejegyzesek"]),
            }
        )
    owners.sort(key=lambda o: -o["szazalek"])
    return owners


def validate(resz2_entries, owners):
    total = sum(
        Fraction(e["szamlalo"], e["nevezo"])
        for e in resz2_entries
        if e.get("hatalyos")
        and "szamlalo" in e
        and "JOGGYAKORL" not in (e.get("jogallas") or "").upper()
        and "GYAKORLÓ" not in (e.get("jogallas") or "").upper()
        and "HASZONÉLVEZ" not in (e.get("jogallas") or "").upper()
    )
    return {
        "hatalyos_hanyad_osszeg": f"{total.numerator}/{total.denominator}",
        "hatalyos_hanyad_osszeg_szazalek": round(float(total) * 100, 9),
        "valid": total == 1,
        "megjegyzes": (
            "A hatályos tulajdoni hányadok összege pontosan 1 -- a parse konzisztens."
            if total == 1
            else "FIGYELEM: az összeg nem 1. A parse hibás, vagy a lap különleges "
            "(pl. haszonélvezet/joggyakorló besorolás). Ne dolgozz tovább, amíg nem tisztázott."
        ),
    }


# --------------------------------------------------------------------------
# 5. Fő folyamat
# --------------------------------------------------------------------------

def parse(pdf_path):
    pages = extract_pages(pdf_path)
    raw_first = pages[0] if pages else ""
    text = strip_furniture(pages)
    sections = split_sections(text)

    resz2 = parse_entries(sections.get("resz2", ""), "II")
    resz3 = parse_entries(sections.get("resz3", ""), "III")
    owners = summarize_owners(resz2)

    meta = {"oldalak": len(pages)}
    for key, pat in [
        ("ugyazonosito", r"(INYER/TULLAP/\d+/\d+)"),
        ("kelt", r"\n(\d{4}\.\d{2}\.\d{2})\n"),
        ("ingatlan_megnevezes", r"\n([^\n]*helyrajzi szám)\n"),
    ]:
        m = re.search(pat, raw_first)
        if m:
            meta[key] = m.group(1).strip()

    return {
        "meta": meta,
        "szeljegyek": parse_szeljegyek(sections.get("szeljegyzek", "")),
        "ingatlan": parse_ingatlan(sections.get("resz1", "")),
        "tulajdoni_bejegyzesek": resz2,
        "terhek": resz3,
        "tulajdonosok": owners,
        "osszesites": {
            "resz2_osszes": len(resz2),
            "resz2_hatalyos": sum(1 for e in resz2 if e["hatalyos"]),
            "resz2_torolt": sum(1 for e in resz2 if not e["hatalyos"]),
            "resz3_osszes": len(resz3),
            "resz3_hatalyos": sum(1 for e in resz3 if e["hatalyos"]),
            "szeljegy_db": len(parse_szeljegyek(sections.get("szeljegyzek", ""))),
            "egyedi_tulajdonos": len(owners),
            **validate(resz2, owners),
        },
    }


def main():
    ap = argparse.ArgumentParser(description="Magyar e-hiteles tulajdoni lap -> JSON")
    ap.add_argument("pdf")
    ap.add_argument("-o", "--output", help="kimeneti JSON (alap: <pdf neve>.json)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    data = parse(args.pdf)
    out = args.output or re.sub(r"\.pdf$", "", args.pdf, flags=re.I) + ".json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    if not args.quiet:
        s = data["osszesites"]
        print(f"JSON: {out}")
        print(f"  II. RÉSZ: {s['resz2_osszes']} bejegyzés "
              f"({s['resz2_hatalyos']} hatályos / {s['resz2_torolt']} törölt)")
        print(f"  III. RÉSZ: {s['resz3_osszes']} bejegyzés ({s['resz3_hatalyos']} hatályos)")
        print(f"  Széljegy: {s['szeljegy_db']}")
        print(f"  Egyedi tulajdonos: {s['egyedi_tulajdonos']}")
        print(f"  Hányadösszeg: {s['hatalyos_hanyad_osszeg']} "
              f"({s['hatalyos_hanyad_osszeg_szazalek']}%)")
        if s["valid"]:
            print("  ✓ VALIDÁLT — a hatályos hányadok összege pontosan 1")
        else:
            print("  ✗ HIBA — " + s["megjegyzes"], file=sys.stderr)
            sys.exit(2)


if __name__ == "__main__":
    main()

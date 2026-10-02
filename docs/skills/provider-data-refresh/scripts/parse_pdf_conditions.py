#!/usr/bin/env python3
"""Extract mapped fee fields from bank condition-list PDFs.

Client-side helper (needs a local PDF file and Python; it does not run in the
platform sandbox, which gets no input files). The mapping is the Playbook
`pdf_maps` array saved as JSON (or a YAML mapping with a `fields` list).

The script has two outputs:
1. a markdown rendering of the PDF text and detected tables
2. a structured JSON file based on the mapping
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

try:
    import pdfplumber
except ImportError as exc:  # pragma: no cover - exercised by CLI users
    raise SystemExit("Missing dependency: pdfplumber. Install with: python3 -m pip install -r scripts/requirements-pdf-parser.txt") from exc

try:
    import yaml
except ImportError:  # PyYAML is only needed for .yaml/.yml mappings
    yaml = None


def load_mapping(path: Path) -> dict[str, Any]:
    """Load a mapping: Playbook pdf_maps (JSON list or {"pdf_maps": [...]}) or a YAML mapping."""
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in (".yaml", ".yml"):
        if yaml is None:
            raise SystemExit("Missing dependency: PyYAML. Install with: python3 -m pip install -r requirements-pdf-parser.txt")
        data = yaml.safe_load(text)
    else:
        data = json.loads(text)
    if isinstance(data, list):
        data = {"fields": data}
    elif isinstance(data, dict) and "pdf_maps" in data and "fields" not in data:
        data = {**data, "fields": data["pdf_maps"]}
    if not isinstance(data, dict) or not isinstance(data.get("fields"), list):
        raise SystemExit(f"Mapping must be a pdf_maps list or have a 'fields' list: {path}")
    return data


def normalize_bank_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clean_cell(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"[ \t]+", " ", str(value).replace("\n", " ")).strip()


def markdown_table(rows: list[list[Any]]) -> str:
    if not rows:
        return ""
    cleaned = [[clean_cell(cell) for cell in row] for row in rows]
    width = max(len(row) for row in cleaned)
    padded = [row + [""] * (width - len(row)) for row in cleaned]
    header = padded[0]
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    for row in padded[1:]:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def load_pdf(pdf_path: Path) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    with pdfplumber.open(pdf_path) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            tables = page.extract_tables() or []
            pages.append({"number": index, "text": text, "tables": tables})
    return pages


def write_markdown(pages: list[dict[str, Any]], pdf_path: Path, output_path: Path) -> None:
    lines = [
        f"# PDF kivonat: {pdf_path.name}",
        "",
        f"- Forrás PDF: `{pdf_path}`",
        f"- Oldalak száma: {len(pages)}",
        f"- Generálva: {dt.datetime.now().isoformat(timespec='seconds')}",
        "",
    ]
    for page in pages:
        lines.extend([f"## Oldal {page['number']}", "", "### Szöveg", "", page["text"].strip(), ""])
        if page["tables"]:
            lines.extend(["### Táblázatok", ""])
            for idx, table in enumerate(page["tables"]):
                lines.extend([f"#### Táblázat {idx}", "", markdown_table(table), ""])
    output_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def page_by_number(pages: list[dict[str, Any]], page_number: int) -> dict[str, Any]:
    if page_number < 1 or page_number > len(pages):
        raise ValueError(f"Page {page_number} is outside PDF page range 1..{len(pages)}")
    return pages[page_number - 1]


def row_to_dict(row: list[Any], header: list[Any]) -> dict[str, str]:
    width = max(len(header), len(row))
    header_values = [clean_cell(cell) or f"column_{idx + 1}" for idx, cell in enumerate(header + [""] * (width - len(header)))]
    row_values = [clean_cell(cell) for cell in row + [""] * (width - len(row))]
    return dict(zip(header_values, row_values))


def extract_regex(field: dict[str, Any], pages: list[dict[str, Any]]) -> dict[str, Any]:
    page = page_by_number(pages, int(field["page"]))
    flags = re.MULTILINE
    if field.get("dotall"):
        flags |= re.DOTALL
    match = re.search(field["pattern"], page["text"], flags)
    value = None
    raw = None
    if match:
        group = field.get("group", 1)
        value = clean_cell(match.group(group))
        raw = clean_cell(match.group(0))
    return {"value": value, "raw": raw, "source": {"page": page["number"], "type": "regex", "pattern": field["pattern"]}}


def extract_regex_findall(field: dict[str, Any], pages: list[dict[str, Any]]) -> dict[str, Any]:
    page = page_by_number(pages, int(field["page"]))
    flags = re.MULTILINE
    if field.get("dotall"):
        flags |= re.DOTALL
    matches = re.findall(field["pattern"], page["text"], flags)
    values: list[Any] = []
    for match in matches:
        if isinstance(match, tuple):
            values.append([clean_cell(part) for part in match])
        else:
            values.append(clean_cell(match))
    return {"value": values, "raw": values, "source": {"page": page["number"], "type": "regex_findall", "pattern": field["pattern"]}}


def extract_table_rows(field: dict[str, Any], pages: list[dict[str, Any]]) -> dict[str, Any]:
    page = page_by_number(pages, int(field["page"]))
    table_index = int(field.get("table_index", 0))
    tables = page["tables"]
    if table_index >= len(tables):
        raise ValueError(f"Page {page['number']} has {len(tables)} tables, table_index={table_index} is unavailable")
    table = tables[table_index]
    if not table:
        return {"value": [], "raw": [], "source": {"page": page["number"], "type": "table_rows", "table_index": table_index}}

    if field.get("header", True):
        header = [clean_cell(cell) for cell in table[0]]
        raw_rows = table[1:]
    else:
        configured_columns = field.get("columns")
        if configured_columns:
            header = [str(column) for column in configured_columns]
        else:
            width = max(len(row) for row in table)
            header = [f"column_{idx + 1}" for idx in range(width)]
        raw_rows = table
    rows = [row_to_dict(row, header) for row in raw_rows]
    contains = field.get("row_contains")
    equals = field.get("row_equals")
    values = field.get("row_match_values")
    selected = rows
    if contains:
        needle = str(contains).lower()
        selected = [row for row in rows if needle in " ".join(row.values()).lower()]
    if equals:
        selected = []
        for row in rows:
            if any(str(cell).strip() == str(equals).strip() for cell in row.values()):
                selected.append(row)
    if values:
        expected = {str(value).strip().lower() for value in values}
        selected = [
            row
            for row in rows
            if any(str(cell).strip().lower() in expected for cell in row.values())
        ]

    return {
        "value": selected,
        "raw": selected,
        "source": {"page": page["number"], "type": "table_rows", "table_index": table_index},
    }


def extract_text_block(field: dict[str, Any], pages: list[dict[str, Any]]) -> dict[str, Any]:
    page = page_by_number(pages, int(field["page"]))
    text = page["text"]
    start = field.get("start")
    end = field.get("end")
    if start:
        pos = text.find(start)
        text = text[pos:] if pos >= 0 else ""
    if end and text:
        pos = text.find(end, len(start or ""))
        if pos >= 0:
            text = text[:pos]
    value = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    return {"value": value, "raw": value, "source": {"page": page["number"], "type": "text_block", "start": start, "end": end}}


EXTRACTORS = {
    "regex": extract_regex,
    "regex_findall": extract_regex_findall,
    "table_rows": extract_table_rows,
    "text_block": extract_text_block,
}


def comparable(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def direction_for_change(old: Any, new: Any) -> str:
    old_number = first_number(old)
    new_number = first_number(new)
    if old_number is None or new_number is None:
        return "↔"
    if new_number > old_number:
        return "↑"
    if new_number < old_number:
        return "↓"
    return "↔"


def first_number(value: Any) -> float | None:
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    match = re.search(r"(?<!\d)(\d{1,3}(?:[ .]\d{3})*|\d+)(?:,\d+|\.\d+)?", text)
    if not match:
        return None
    number = match.group(0).replace(" ", "").replace(".", "").replace(",", ".")
    try:
        return float(number)
    except ValueError:
        return None


def previous_fields(previous_path: Path | None) -> dict[str, Any]:
    if not previous_path:
        return {}
    data = json.loads(previous_path.read_text(encoding="utf-8"))
    return {item["id"]: item.get("value") for item in data.get("fields", [])}


def build_result(
    mapping: dict[str, Any],
    pages: list[dict[str, Any]],
    pdf_path: Path,
    previous_path: Path | None,
    run_date: str,
) -> dict[str, Any]:
    previous = previous_fields(previous_path)
    fields = []
    changes = []
    for field in mapping.get("fields", []):
        kind = field["type"]
        if kind not in EXTRACTORS:
            raise ValueError(f"Unsupported field type: {kind}")
        extracted = EXTRACTORS[kind](field, pages)
        item = {
            "id": field["id"],
            "label": field.get("label", field["id"]),
            "type": kind,
            "value": extracted["value"],
            "source": extracted["source"],
            "notes": field.get("notes"),
        }
        if field["id"] in previous:
            old = previous[field["id"]]
            changed = comparable(old) != comparable(item["value"])
            item["previous_value"] = old
            item["changed"] = changed
            if changed:
                changes.append(
                    {
                        "field_id": item["id"],
                        "label": item["label"],
                        "direction": direction_for_change(old, item["value"]),
                        "previous_value": old,
                        "new_value": item["value"],
                        "source": item["source"],
                    }
                )
        fields.append(item)

    return {
        "metadata": {
            "bank": mapping.get("bank"),
            "bank_id": mapping.get("bank_id"),
            "source_pdf": str(pdf_path),
            "source_pdf_sha256": sha256_file(pdf_path),
            "pdf_pages": len(pages),
            "mapping_file": mapping.get("_mapping_file"),
            "mapping_version": mapping.get("mapping_version", 1),
            "run_date": run_date,
            "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
            "previous_parsed_json": str(previous_path) if previous_path else None,
        },
        "fields": fields,
        "changes": changes,
        "change_table_rows": [
            {
                "Mező / Tétel": change["label"],
                "Irány": change["direction"],
                "Jelenlegi érték": change["previous_value"],
                "Javasolt új érték": change["new_value"],
                "Forrás": f"PDF {change['source'].get('page')}. oldal",
                "Indoklás": "Automatikus eltérés az előző parsed JSON-hoz képest; Csilla review előtt ellenőrizendő.",
            }
            for change in changes
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract structured condition-list fields from a bank PDF.")
    parser.add_argument("--bank", required=True, help="Bank/provider name, used for output names.")
    parser.add_argument("--pdf", required=True, type=Path, help="Source condition-list PDF.")
    parser.add_argument("--mapping", required=True, type=Path, help="Mapping file: Playbook pdf_maps saved as JSON (list), or YAML with a 'fields' list.")
    parser.add_argument("--previous", type=Path, help="Previous parsed JSON for change detection.")
    parser.add_argument("--output-dir", type=Path, help="Output directory. Default: PDF parent directory.")
    parser.add_argument("--date", default=dt.date.today().isoformat(), help="Output date in YYYY-MM-DD format.")
    parser.add_argument("--no-markdown", action="store_true", help="Do not write the PDF markdown extraction.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pdf_path = args.pdf.resolve()
    if not pdf_path.exists():
        raise SystemExit(f"PDF not found: {pdf_path}")

    bank_slug = normalize_bank_name(args.bank)
    mapping_path = args.mapping
    if not mapping_path.exists():
        raise SystemExit(f"Mapping not found: {mapping_path}")

    mapping = load_mapping(mapping_path)
    mapping["_mapping_file"] = str(mapping_path)
    output_dir = (args.output_dir or pdf_path.parent).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    pages = load_pdf(pdf_path)
    stem = f"{bank_slug}_kondiciok_parsed_{args.date}"
    if not args.no_markdown:
        write_markdown(pages, pdf_path, output_dir / f"{bank_slug}_kondiciok_extracted_{args.date}.md")

    result = build_result(mapping, pages, pdf_path, args.previous.resolve() if args.previous else None, args.date)
    json_path = output_dir / f"{stem}.json"
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

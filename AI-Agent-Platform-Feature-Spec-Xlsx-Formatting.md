# Feature-spec — Professzionális Excel-kezelés (xlsx formázás)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-06-19
**Forrásdokumentumok:** `AI-Agent-Platform-Feature-Spec-FileEditor.md` (v1.0)
**Olvasó:** fejlesztő(k). Feltételezi a platform-mcp-bridge, Tool Broker, file-editor adapter és goose-config architektúra ismeretét.
**Státusz:** **Tervezett** — implementáció előtt.

---

## 0. Mit ad ez a dokumentum

A jelenlegi Excel-kezelés (`xlsx-adapter.ts` + 3 tool: `xlsx_read_sheet`, `xlsx_write_cells`,
`xlsx_append_rows`) **kizárólag adat-szintű**: cellába értéket ír, de **formázni nem tud** —
nincs betűtípus, szín, számformátum, cellaegyesítés, oszlopszélesség, képlet vagy rögzített
fejléc. Ez a spec az „A utat" határozza meg: a **meglévő `exceljs` adapter kibővítése**
formázási képességekkel, **új futási környezet nélkül**, a jelenlegi
WorkspaceStorage → Tool Broker → platform-mcp-bridge → goose láncon belül.

Cél: az agent üzleti minőségű Excel-táblát tudjon **előállítani és formázni** (riport,
ütemterv, pénzügyi kimutatás) — a formázási igények ~90%-át lefedve, kód-sandbox nélkül.

A „B út" (Python/openpyxl kód-sandbox a chart/pivot/újraszámolt képletérték igényekhez)
**most nem szkóp** — lásd §8.

---

## 1. Scope

### 1.1 In scope

- Az `exceljs`-alapú `xlsx-adapter.ts` kibővítése cella-stílus, számformátum és képlet
  támogatással. Az `exceljs` ezeket **natívan tudja** — új függőség nincs.
- **4 tool** a Tool Brokerben + bridge-ben + goose tool-listán:
  - `xlsx_write_cells` — **kibővítve**: a `value` mellé opcionális `style`, `numFmt`, `formula`
    cellánként (visszafelé kompatibilis a jelenlegi `{ cell, value }` alakkal).
  - `xlsx_format_range` — **új**: egy A1-tartományra (`A1:D1`) köteg-stílust alkalmaz.
  - `xlsx_layout` — **új**: strukturális műveletek (cellaegyesítés, oszlopszélesség,
    sormagasság, rögzített ablaktábla, autofilter).
  - `xlsx_create` — **új**: üres munkafüzet létrehozása megnevezett munkalap(ok)kal és
    opcionális 2D adatblokkal (a „nulláról riport" use-case-hez).
- A meglévő stílus **megőrzése** íráskor (a jelenlegi `write_cells` felülírja a cellát stílus
  nélkül — ez javítandó, lásd §4.1).

### 1.2 Out of scope (most)

- Diagram (chart) generálás — az `exceljs` írásra gyakorlatilag nem tudja.
- Pivot tábla — az `exceljs` egyáltalán nem tudja.
- Képletek **kiszámolt értéke** (recalc) — sem az `exceljs`, sem az `openpyxl` nem számol;
  Excel megnyitáskor számol újra. Lásd §7 (ismert korlát) és §8 (B út).
- Bármilyen kód-sandbox / Python runtime.

---

## 2. Közös típus: `CellStyle`

Minden formázó tool ugyanazt a stílus-objektumot használja. Közvetlenül leképezhető az
`exceljs` `cell.font` / `cell.fill` / `cell.alignment` / `cell.border` / `cell.numFmt`
mezőire.

```ts
export type CellStyle = {
  font?: {
    bold?: boolean
    italic?: boolean
    size?: number
    color?: string          // ARGB hex, pl. "FF1F4E78" (alpha + RGB)
    name?: string           // pl. "Calibri"
  }
  fill?: {
    color?: string          // solid fgColor, ARGB hex, pl. "FFDDEBF7"
  }
  alignment?: {
    horizontal?: 'left' | 'center' | 'right'
    vertical?: 'top' | 'middle' | 'bottom'
    wrapText?: boolean
  }
  border?: {
    top?: BorderStyle
    bottom?: BorderStyle
    left?: BorderStyle
    right?: BorderStyle
  }
  numFmt?: string           // pl. "#,##0.00", "0.0%", "yyyy-mm-dd", "# ##0 Ft"
}

export type BorderStyle = 'thin' | 'medium' | 'thick'
```

**Megjegyzés a színekről:** az `exceljs` ARGB hexet vár (8 karakter, pl. `FF1F4E78`). Az
adapter normalizáljon: ha 6 karakteres RGB jön (`1F4E78`), prefixeld `FF`-fel.

---

## 3. Tool-definíciók

### 3.1 `xlsx_write_cells` (kibővítve)

Cellánkénti pontos írás értékkel és/vagy formázással és/vagy képlettel.

```ts
export type XlsxCellChange = {
  cell: string                                   // A1 jelölés, pl. "B3"
  value?: string | number | boolean | null       // konkrét érték
  formula?: string                                // pl. "SUM(B2:B10)" — kölcsönösen kizáró a value-val
  style?: CellStyle                               // opcionális formázás
  numFmt?: string                                 // rövidítés style.numFmt-hez
}

export type XlsxWriteCellsArgs = {
  path: string
  sheet?: string
  changes: XlsxCellChange[]
}
```

**Szemantika:**
- `value` és `formula` közül legfeljebb az egyik adható meg. Ha `formula`, az adapter
  `cell.value = { formula }`-t állít.
- A `style` **merge**, nem felülírás: a meglévő cellastílus megmarad, csak a megadott mezők
  módosulnak (§4.1).
- Visszafelé kompatibilis: a jelenlegi `{ cell, value }` hívások változatlanul működnek.

### 3.2 `xlsx_format_range` (új)

Stílus alkalmazása egy téglalap-tartomány minden cellájára (pl. fejléc-sor kiemelése).

```ts
export type XlsxFormatRangeArgs = {
  path: string
  sheet?: string
  range: string             // A1 tartomány, pl. "A1:E1" vagy "A1:A100"
  style: CellStyle
}
```

### 3.3 `xlsx_layout` (új)

Strukturális (nem-cella-érték) műveletek köteg. Minden mező opcionális, egy hívásban
többféle művelet kombinálható.

```ts
export type XlsxLayoutArgs = {
  path: string
  sheet?: string
  mergeCells?: string[]                         // pl. ["A1:D1", "A2:A5"]
  columnWidths?: Array<{ column: string; width: number }>   // pl. [{ column: "A", width: 24 }]
  rowHeights?: Array<{ row: number; height: number }>
  freeze?: { rows?: number; columns?: number }  // pl. { rows: 1 } → fejléc rögzítése
  autoFilter?: string                           // pl. "A1:E1" — szűrőfej a tartományra
}
```

### 3.4 `xlsx_create` (új)

Üres munkafüzet létrehozása a workspace-ben, opcionális kezdő adatblokkal.

```ts
export type XlsxCreateArgs = {
  path: string                                  // pl. "riportok/q2.xlsx"
  sheets: Array<{
    name: string
    rows?: Array<Array<string | number | boolean | null>>   // opcionális 2D adat (fejléc + sorok)
  }>
}
```

**Szemantika:** ha a `path` már létezik → `FILE_ALREADY_EXISTS` hiba (ne írjon felül némán).

---

## 4. Adapter-szint (`xlsx-adapter.ts`)

### 4.1 Stílus-megőrzés (kritikus javítás)

A jelenlegi `xlsxWriteCells` a `cell.value = ...`-t állítja, ami **nem törli** a stílust —
de a `value` újraírása képlet/típus szempontból nyúlhat hozzá. A `style` alkalmazásánál
**merge** szemantika kell:

```ts
const c = worksheet.getCell(change.cell)
if (change.formula !== undefined) c.value = { formula: change.formula }
else if (change.value !== undefined) c.value = change.value as CellValue
if (change.style) applyStyle(c, change.style)   // merge a meglévő c.style-ra
if (change.numFmt) c.numFmt = change.numFmt
```

Ez egyúttal lezárja a FileEditor-spec **D-FE-4** nyitott kérdését („íráskor maradjon-e meg a
formázás?") — válasz: **igen, merge-eljük**.

### 4.2 Új adapter-függvények

- `xlsxFormatRange(buffer, range, style, sheetName?) → Buffer`
- `xlsxApplyLayout(buffer, layout, sheetName?) → Buffer`
- `xlsxCreate(sheets) → Buffer`
- belső `applyStyle(cell, style)` helper (a 4 tool közös magja).

Mindegyik a meglévő `loadWorkbook()` + `workbook.xlsx.load/writeBuffer` mintát követi
(lásd a jelenlegi `xlsxWriteCells`/`xlsxAppendRows`).

---

## 5. Érintett fájlok (wiring checklist)

A meglévő `xlsx_*` toolok pontosan ezeken a pontokon vannak bekötve — minden új tool
ugyanitt követendő:

| # | Fájl | Mit kell tenni |
|---|---|---|
| 1 | `app/src/domain/file-editor/adapters/xlsx-adapter.ts` | `CellStyle` típus, `applyStyle`, `xlsxFormatRange`, `xlsxApplyLayout`, `xlsxCreate`; `xlsxWriteCells` kibővítése style/formula/numFmt-tel |
| 2 | `app/src/domain/file-editor/file-editor-service.ts` | új service-metódusok (`xlsxFormatRange`, `xlsxLayout`, `xlsxCreate`); a meglévő `xlsxWriteCells` típus bővítése; result típusok |
| 3 | `app/src/domain/tool-broker/tool-broker-service.ts` | `XlsxCellChange`/`XlsxWriteCellsArgs` bővítés; új `XlsxFormatRangeArgs`/`XlsxLayoutArgs`/`XlsxCreateArgs`; `ToolBrokerInvokeInput` union (~219); capability map `connectorType:'workspace'` (~287); audit meta builder (~435); dispatch switch (~826); a `startsWith('xlsx_')`/audit-osztály lista (~787) |
| 4 | `app/src/harness/platform-mcp-bridge.ts` | MCP tool-séma (`name` + `description` + `inputSchema`) mind a 3 új toolhoz + a `write_cells` séma bővítése; a tool-név lista (~28) |
| 5 | `app/src/harness/goose-config.ts` | `available_tools` lista **és** a `gooseConfigPreview` `platformBrokerTools` lista — mindkettő 2 helyen |
| 6 | `app/prisma/seed.ts` | a capability upsert-lista (~261) kiegészítése az új tool-nevekkel |

**Audit megjegyzés:** a Tool Broker audit a `value`/cella-tartalmat **nem** logolja (W4),
csak path + meta (cellaszám, range, sheet). Az új toolok kövessék ugyanezt — a `style`
objektum sem kerül auditba, csak a művelet-számláló.

---

## 6. Példa — tipikus „formázott riport" folyamat

```jsonc
// 1. Üres munkafüzet fejléccel + adattal
{ "tool": "xlsx_create", "args": {
  "path": "riportok/q2.xlsx",
  "sheets": [{ "name": "Bevétel", "rows": [
    ["Hónap", "Terv", "Tény"],
    ["Április", 1200000, 1310000],
    ["Május", 1250000, 1180000]
  ]}]
}}

// 2. Fejléc-sor formázása
{ "tool": "xlsx_format_range", "args": {
  "path": "riportok/q2.xlsx", "range": "A1:C1",
  "style": { "font": { "bold": true, "color": "FFFFFFFF" },
             "fill": { "color": "FF1F4E78" },
             "alignment": { "horizontal": "center" } }
}}

// 3. Pénznem-formátum az értékoszlopokra + összegző képlet
{ "tool": "xlsx_write_cells", "args": {
  "path": "riportok/q2.xlsx",
  "changes": [
    { "cell": "B4", "formula": "SUM(B2:B3)", "style": { "font": { "bold": true } }, "numFmt": "# ##0 Ft" },
    { "cell": "C4", "formula": "SUM(C2:C3)", "style": { "font": { "bold": true } }, "numFmt": "# ##0 Ft" }
  ]
}}

// 4. Layout: oszlopszélesség, fejléc rögzítés, autofilter
{ "tool": "xlsx_layout", "args": {
  "path": "riportok/q2.xlsx",
  "columnWidths": [{ "column": "A", "width": 14 }, { "column": "B", "width": 16 }, { "column": "C", "width": 16 }],
  "freeze": { "rows": 1 },
  "autoFilter": "A1:C1"
}}
```

---

## 7. Ismert korlátok (dokumentálandó az agent-prompt felé)

- **Képlet-érték nincs kiszámolva.** A `formula` cellába a képlet **stringként** kerül; az
  értékét Excel/LibreOffice számolja ki **megnyitáskor**. Más olvasók — és a platform
  `kb_search` szövegkivonata (`xlsxExtractText`) — a képlet eredményét **nem** látják, amíg
  egy alkalmazás újra nem számolja. (A recalc a B út része, §8.)
- **Chart / pivot nincs** — ezeket az `exceljs` írásra nem támogatja.
- **Feltételes formázás (conditional formatting):** az `exceljs` támogatja
  (`worksheet.addConditionalFormatting`), de ez **A-fázis 2** opció, nem az első körben.

---

## 8. B út — kód-sandbox (most NEM szkóp, később lehet)

**Lényeg:** a Claude Cowork / Codex „profi Excel" élménye valójában **nem** tool-felület,
hanem **kódfuttató sandbox**: a modell Python `openpyxl`/`pandas` (chartokhoz `xlsxwriter`)
kódot ír, és tetszőleges formázást/diagramot/pivotot/számítást végez. Ez az egyetlen út a
**chart**, **pivot** és **kiszámolt képletérték** igényekhez.

### 8.1 A sandbox nem Excel-feature — általános képesség

Fontos döntési szempont: a sandbox **nem** az xlsx kedvéért épül, az Excel csak az egyik
fogyasztója. Architekturálisan a fix tool-felület (MCP toolok) **véges** — minden képességhez
külön toolt kell írni és karbantartani; a kód-sandbox ezzel szemben **nyílt végű escape
hatch**: amit nem vezettél ki toolként, azt a modell egyszerűen megírja. A Cowork (és a
kódfuttatós Claude) ugyanezt az egy sandboxot használja az alábbiakra:

- **A többi Office-formátum, írásra is.** Nálunk most `docx_read` / `pdf_read` **csak olvas**,
  `pptx` egyáltalán nincs. Sandboxszal jön a *generálás*: `python-docx` (Word — TOC, táblázat,
  fejléc), `python-pptx` (prezentáció nulláról), `reportlab`/`pypdf` (PDF készítés, merge,
  űrlap-kitöltés). Egy egész formátum-osztály, nem csak az xlsx.
- **Adatelemzés** — `pandas`/`numpy` nagy CSV/Excel fölött: join, aggregálás, pivot,
  statisztika; ad-hoc logika, amit tool-felületen nem lehet értelmesen leképezni.
- **Vizualizáció** — `matplotlib` → PNG diagram (riportba, levélbe, prezentációba ágyazva).
- **Formátum-konverzió** — csv↔xlsx, html→pdf, képfeldolgozás (`Pillow`), OCR.
- **Tetszőleges számítás / parsing** — pénzügyi modell, regex-transzformáció, parszolás a már
  lekért adat fölött.
- **Recalc** — a headless LibreOffice (képletérték-számítás) ugyanennek a sandboxnak a
  mellékterméke.

### 8.2 Kompromisszum — miért nem triviális a döntés

A nyílt végű képességnek ára van, pont azon a tengelyen, ami egy banki ügyfeleket kiszolgáló,
egress-zárt platformon a legtöbbet nyomja:

- **Auditálhatóság:** egy `xlsx_write_cells` pontosan naplózható (mit, hova). Egy „futtatott
  egy Python scriptet" sokkal nehezebben — mit nyúlt meg, mit ért el.
- **Jogosultság-kapuzás:** a Tool Broker tooltonként engedélyez (capability map); a sandbox
  egyetlen durva felbontású jog.
- **Determinizmus:** a fix tool kiszámítható; a generált kód nem mindig.

→ A B út megnyitásakor ezt a feszültséget (nyílt képesség ↔ auditálhatóság/kapuzás) **explicit
döntésként** kell kezelni, nem mellékesen.

### 8.3 Miért nem most

A backend Firebase App Hosting (Cloud Run, 1 CPU / 512 MiB, **nincs
Python**); a harness külön Cloud Run Job, **egress-guard** mögött. Egy untrusted kódot futtató
sandbox **önálló platform-alrendszer**, nem feature:

- saját, hálózat nélküli konténer-image (Python + openpyxl/pandas/xlsxwriter + headless
  LibreOffice a recalc-hoz), read-only rootfs, nem-root user, CPU/RAM/timeout limit;
- GCS-workspace „mount" (fájl → tmpfile → futtatás → vissza GCS-be);
- a kód **ne** lássa a platform secret-jeit / más ticket fájljait; az `egress-guard.ts`
  mintát ki kell terjeszteni a futtatott kódra;
- **nem** a goose `developer` (teljes shell) extension bekapcsolásával, és **nem** külső
  menedzselt sandbox-szolgáltatással (egress/compliance).

**Trigger a B út megnyitására:** amikor a chart / pivot / kiszámolt képletérték **kemény
ügyfélkövetelmény** lesz. Addig az A út fedi a formázási igények nagy részét, nulla új
futási környezettel.

---

## 9. Elfogadási kritériumok

| ID | Kritérium |
|---|---|
| X1 | `xlsx_create` → érvényes, megnyitható `.xlsx`; létező path → `FILE_ALREADY_EXISTS` |
| X2 | `xlsx_write_cells` `style`-lal: a megadott formázás megjelenik, a többi cellastílus megmarad (merge) |
| X3 | `xlsx_write_cells` `formula`-val: a cella képletet tartalmaz (`cell.value.formula`) |
| X4 | `xlsx_format_range` `A1:C1`-re: mindhárom cella megkapja a stílust |
| X5 | `xlsx_layout`: merge + oszlopszélesség + freeze + autofilter egy hívásban érvényesül |
| X6 | `numFmt` (pl. `"0.0%"`, `# ##0 Ft`) helyesen jelenik meg Excelben |
| X7 | RGB (6 jegy) és ARGB (8 jegy) szín egyaránt elfogadott (normalizálás) |
| X8 | Audit: csak path + művelet-számláló/range/sheet — cellatartalom és `style` nélkül (W4 konzisztens) |
| X9 | Path traversal (`../`) az új toolokon is `PATH_TRAVERSAL` |
| X10 | A jelenlegi `{ cell, value }` `write_cells` hívások változatlanul működnek (visszafelé kompatibilitás) |

/**
 * #947 LLM Wiki 6/6 — 30 SZINTETIKUS lelet-PDF a lelet-forgatókönyvhöz (nincs valódi személyes adat).
 *
 * - 20 laborlelet (15–30 paraméter referenciatartománnyal), 8 vizit-összefoglaló diagnózissal,
 *   1 kétoldalas zárójelentés; 2022–2025 közötti dátumok.
 * - Vegyesen szöveges és beszkennelt (csak kép) PDF-ek, egy vegyes (2. oldala szken).
 * - A feltöltési sorrend szándékosan összekevert; egy fájl kétszer szerepel (más néven).
 * - Determinisztikus: rögzített PRNG-mag, pdf-lib metaadat-frissítés nélkül.
 * - A PDF-szöveg WinAnsi (Helvetica): ő/ű nem írható bele, ezért ilyen betű a leletekben nincs.
 *
 * A `spec` a lelet „igazsága": a szimulált agent csak a beszkennelt oldalaknál használja,
 * és csak miután a `kb_get_document pageImages` ténylegesen visszaadta az oldal képét
 * (a multimodális modell olvasását helyettesíti, szerveroldali OCR/AI nincs — D3).
 *
 * Kézi smoke-hoz fájlba írás: npm run fixtures:health-wiki [-- <kimeneti mappa>] (write.ts)
 */
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib'
import { renderPdfPages } from '../../../src/lib/kb-pdf-images'

export type LabParam = { name: string; slug: string; unit: string; ref: string; low: number; high: number; decimals: number }
export type LabValue = { param: LabParam; value: number; flag: '' | 'H' | 'L' }
export type ReportKind = 'labor' | 'vizit' | 'zarojelentes'
export type ReportSpec = {
  key: string
  kind: ReportKind
  date: string
  provider: string
  providerSlug: string
  clinician: string
  /** Oldalanként: a laborértékek (labor) vagy szöveges sorok (vizit / zárójelentés). */
  pages: Array<{ labs: LabValue[]; lines: string[] }>
  diagnosis?: { name: string; slug: string; code: string }
  medication?: { name: string; slug: string; dose: string }
  /** Oldalszám (1-től) → csak kép (szken) az oldal. */
  scannedPages: number[]
  filename: string
}

export const LAB_PARAMS: LabParam[] = [
  ['LDL-koleszterin', 'ldl-koleszterin', 'mmol/L', 0, 3.0, 2],
  ['HDL-koleszterin', 'hdl-koleszterin', 'mmol/L', 1.0, 2.5, 2],
  ['Összkoleszterin', 'osszkoleszterin', 'mmol/L', 0, 5.2, 2],
  ['Triglicerid', 'triglicerid', 'mmol/L', 0, 1.7, 2],
  ['Glükóz (éhgyomri)', 'glukoz', 'mmol/L', 3.9, 6.0, 1],
  ['HbA1c', 'hba1c', '%', 4.0, 5.7, 1],
  ['Kreatinin', 'kreatinin', 'umol/L', 62, 106, 0],
  ['eGFR', 'egfr', 'mL/min/1.73m2', 90, 200, 0],
  ['Karbamid', 'karbamid', 'mmol/L', 2.8, 7.2, 1],
  ['Húgysav', 'hugysav', 'umol/L', 200, 420, 0],
  ['ALT (GPT)', 'alt-gpt', 'U/L', 0, 41, 0],
  ['AST (GOT)', 'ast-got', 'U/L', 0, 40, 0],
  ['GGT', 'ggt', 'U/L', 0, 60, 0],
  ['ALP', 'alp', 'U/L', 40, 130, 0],
  ['Bilirubin (összes)', 'bilirubin-osszes', 'umol/L', 0, 21, 1],
  ['Nátrium', 'natrium', 'mmol/L', 136, 145, 0],
  ['Kálium', 'kalium', 'mmol/L', 3.5, 5.1, 1],
  ['Kalcium', 'kalcium', 'mmol/L', 2.15, 2.55, 2],
  ['Vas', 'vas', 'umol/L', 10, 30, 1],
  ['Ferritin', 'ferritin', 'ug/L', 30, 400, 0],
  ['TSH', 'tsh', 'mU/L', 0.4, 4.0, 2],
  ['FT4', 'ft4', 'pmol/L', 12, 22, 1],
  ['CRP', 'crp', 'mg/L', 0, 5, 1],
  ['Fehérvérsejt (WBC)', 'feherversejt-wbc', 'G/L', 4.0, 10.0, 1],
  ['Vörösvérsejt (RBC)', 'vorosversejt-rbc', 'T/L', 4.5, 5.9, 2],
  ['Hemoglobin', 'hemoglobin', 'g/L', 135, 175, 0],
  ['Hematokrit', 'hematokrit', 'L/L', 0.4, 0.52, 2],
  ['Trombocita', 'trombocita', 'G/L', 150, 400, 0],
  ['MCV', 'mcv', 'fL', 80, 100, 0],
  ['D-vitamin (25-OH)', 'd-vitamin', 'nmol/L', 75, 250, 0],
  ['B12-vitamin', 'b12-vitamin', 'pmol/L', 145, 570, 0],
].map(([name, slug, unit, low, high, decimals]) => ({
  name: name as string,
  slug: slug as string,
  unit: unit as string,
  low: low as number,
  high: high as number,
  decimals: decimals as number,
  ref: `${(low as number).toFixed(decimals as number)}-${(high as number).toFixed(decimals as number)}`,
}))

/** Minden laborleletben szereplő 15 paraméter (a többi leletenként változó). */
const CORE = ['ldl-koleszterin', 'hdl-koleszterin', 'osszkoleszterin', 'triglicerid', 'glukoz', 'kreatinin', 'egfr', 'alt-gpt', 'ast-got', 'ggt', 'natrium', 'kalium', 'crp', 'hemoglobin', 'feherversejt-wbc']

const LAB_DATES = [
  '2022-02-14', '2022-05-09', '2022-08-22', '2022-11-28', '2023-02-20', '2023-05-15', '2023-08-07',
  '2023-10-30', '2024-01-22', '2024-04-15', '2024-06-03', '2024-07-29', '2024-09-16', '2024-11-11',
  '2025-01-13', '2025-03-10', '2025-05-05', '2025-06-30', '2025-08-11', '2025-09-22',
]

const DX = {
  htn: { name: 'Magas vérnyomás', slug: 'magas-vernyomas', code: 'I10' },
  lipid: { name: 'Hiperlipidémia', slug: 'hiperlipidemia', code: 'E78.0' },
  prediab: { name: 'Prediabétesz', slug: 'prediabetesz', code: 'R73.0' },
  pneumonia: { name: 'Pneumonia', slug: 'pneumonia', code: 'J18.9' },
}
const RX = {
  ramipril: { name: 'Ramipril', slug: 'ramipril', dose: '5 mg naponta 1x' },
  atorva10: { name: 'Atorvastatin', slug: 'atorvastatin', dose: '10 mg este 1x' },
  atorva20: { name: 'Atorvastatin', slug: 'atorvastatin', dose: '20 mg este 1x' },
  amoxi: { name: 'Amoxicillin-klavulánsav', slug: 'amoxicillin-klavulansav', dose: '875/125 mg naponta 2x, 7 napig' },
}

const VISITS: Array<{ date: string; dx: keyof typeof DX; rx?: keyof typeof RX; note: string }> = [
  { date: '2022-03-01', dx: 'htn', rx: 'ramipril', note: 'Vérnyomás 152/94 Hgmm. Életmód-tanácsadás, ramipril indítása.' },
  { date: '2022-12-12', dx: 'htn', note: 'Vérnyomás 134/84 Hgmm. A kezelés hatásos, változatlan folytatás.' },
  { date: '2023-06-05', dx: 'lipid', note: 'Emelkedett LDL-koleszterin. Diéta és mozgás, 6 hónap múlva kontroll.' },
  { date: '2024-02-05', dx: 'lipid', rx: 'atorva10', note: 'Az LDL a diéta mellett is magas. Atorvastatin indítása.' },
  { date: '2024-05-06', dx: 'lipid', note: 'Statin jól tolerált, az LDL csökken. Májenzimek rendben.' },
  { date: '2024-10-07', dx: 'prediab', note: 'Határérték körüli HbA1c. Diétás tanácsadás, testsúlycsökkentés.' },
  { date: '2025-04-14', dx: 'lipid', rx: 'atorva20', note: 'Az LDL-célérték nincs elérve. Atorvastatin dózisemelés.' },
  { date: '2025-09-29', dx: 'lipid', note: 'Az LDL a célértéken. Évente kontroll.' },
]

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Évek 2022-01-01 óta (trendekhez). */
function yearsSince2022(date: string) {
  return (Date.parse(`${date}T00:00:00Z`) - Date.parse('2022-01-01T00:00:00Z')) / (365.25 * 86_400_000)
}

function labValue(param: LabParam, date: string, rand: () => number): LabValue {
  const t = yearsSince2022(date)
  const span = param.high - param.low
  let value: number
  if (param.slug === 'ldl-koleszterin') {
    // Emelkedik 2024 elejéig, a statin (2024-02) után csökken, dózisemelés (2025-04) után célértéken.
    value = t < 2.1 ? 3.3 + 0.45 * t : t < 3.3 ? 4.25 - 1.2 * (t - 2.1) : 2.5 - 0.4 * (t - 3.3)
    value += (rand() - 0.5) * 0.2
  } else if (param.slug === 'osszkoleszterin') {
    value = t < 2.1 ? 5.4 + 0.4 * t : 6.2 - 0.9 * (t - 2.1)
    value += (rand() - 0.5) * 0.3
  } else if (param.slug === 'hba1c') {
    value = 5.5 + 0.12 * t + (rand() - 0.5) * 0.2
  } else if (param.slug === 'crp' && date === '2024-09-16') {
    value = 18.4 // a tüdőgyulladás utáni kontroll
  } else {
    value = param.low + span * (0.2 + rand() * 0.6)
    if (rand() < 0.06) value = param.high + span * 0.1 * (1 + rand())
  }
  const rounded = Number(Math.max(0, value).toFixed(param.decimals))
  const flag = rounded > param.high ? 'H' : rounded < param.low ? 'L' : ''
  return { param, value: rounded, flag }
}

export function formatLabRow(lab: LabValue) {
  return `${lab.param.name} | ${lab.value.toFixed(lab.param.decimals)} | ${lab.param.unit} | ${lab.param.ref} | ${lab.flag || '-'}`
}

/** A 29 egyedi lelet leírása (dátum szerint rendezve). */
export function healthReportSpecs(): ReportSpec[] {
  const rand = mulberry32(947)
  const specs: ReportSpec[] = []
  LAB_DATES.forEach((date, i) => {
    const extras = LAB_PARAMS.filter((p) => !CORE.includes(p.slug)).filter(() => rand() < 0.5)
    const count = 15 + Math.min(extras.length, i % 4 === 0 ? 15 : 2 + (i % 9))
    const params = [...LAB_PARAMS.filter((p) => CORE.includes(p.slug)), ...extras].slice(0, count)
    const labs = params.map((param) => labValue(param, date, rand))
    const pages = labs.length > 16 ? [labs.slice(0, 14), labs.slice(14)] : [labs]
    const lab = i % 2 === 0
    specs.push({
      key: `labor-${date}`,
      kind: 'labor',
      date,
      provider: lab ? 'Teszt Labor Kft.' : 'Példa Klinika Laboratórium',
      providerSlug: lab ? 'teszt-labor' : 'pelda-klinika',
      clinician: lab ? 'Dr. Minta Anna' : 'Dr. Próba Péter',
      pages: pages.map((rows) => ({ labs: rows, lines: [] })),
      scannedPages: [],
      filename: '',
    })
  })
  for (const visit of VISITS) {
    const dx = DX[visit.dx]
    const rx = visit.rx ? RX[visit.rx] : undefined
    specs.push({
      key: `vizit-${visit.date}`,
      kind: 'vizit',
      date: visit.date,
      provider: 'Példa Háziorvosi Praxis',
      providerSlug: 'pelda-haziorvos',
      clinician: 'Dr. Teszt Tamás',
      diagnosis: dx,
      medication: rx,
      pages: [{
        labs: [],
        lines: [
          `Diagnózis: ${dx.name} (${dx.code})`,
          rx ? `Gyógyszer: ${rx.name} ${rx.dose}` : 'Gyógyszer: változatlan',
          `Vélemény: ${visit.note}`,
        ],
      }],
      scannedPages: [],
      filename: '',
    })
  }
  specs.push({
    key: 'zarojelentes-2024-08-23',
    kind: 'zarojelentes',
    date: '2024-08-23',
    provider: 'Minta Városi Kórház Belgyógyászat',
    providerSlug: 'minta-korhaz',
    clinician: 'Dr. Példa Judit',
    diagnosis: DX.pneumonia,
    medication: RX.amoxi,
    pages: [
      {
        labs: [],
        lines: [
          'Felvétel: 2024-08-19, távozás: 2024-08-23',
          `Diagnózis: ${DX.pneumonia.name} (${DX.pneumonia.code})`,
          'Panaszok: láz, köhögés, nehézlégzés 3 napja.',
          'Mellkasröntgen: jobb alsó lebenyi infiltrátum.',
        ],
      },
      {
        labs: [],
        lines: [
          `Gyógyszer: ${RX.amoxi.name} ${RX.amoxi.dose}`,
          'Javaslat: 3 hét múlva kontroll-labor (CRP, vérkép), háziorvosi kontroll.',
          'Állapot távozáskor: láztalan, panaszmentes.',
        ],
      },
    ],
    scannedPages: [],
    filename: '',
  })
  specs.sort((a, b) => a.date.localeCompare(b.date))
  specs.forEach((spec, i) => {
    // Minden harmadik lelet beszkennelt (minden oldala kép); egy kétoldalas laborlelet vegyes.
    if (i % 3 === 1) spec.scannedPages = spec.pages.map((_, p) => p + 1)
    const [y, m, d] = spec.date.split('-')
    spec.filename = spec.scannedPages.length
      ? `scan_${String(i + 1).padStart(4, '0')}.pdf`
      : `${spec.providerSlug.replace(/-/g, '_')}_${spec.kind}_${y}${m}${d}.pdf`
  })
  const mixed = specs.find((spec) => spec.kind === 'labor' && spec.pages.length === 2 && !spec.scannedPages.length)!
  mixed.scannedPages = [2]
  return specs
}

export function reportHeader(spec: ReportSpec) {
  const kind = spec.kind === 'labor' ? 'Laboratóriumi lelet' : spec.kind === 'vizit' ? 'Ambuláns vizit-összefoglaló' : 'Zárójelentés'
  return [
    `${kind} - SZINTETIKUS TESZTADAT`,
    `Intézmény: ${spec.provider}`,
    `Orvos: ${spec.clinician}`,
    `Beteg: Minta Beteg (szintetikus)`,
    `Lelet kelte: ${spec.date}`,
  ]
}

/** Az oldal teljes szövege, ahogy a PDF-re kerül (a szken-oldal „olvasata" is ez). */
export function pageLines(spec: ReportSpec, pageIndex: number) {
  const page = spec.pages[pageIndex]
  return [
    ...(pageIndex === 0 ? reportHeader(spec) : [`${spec.provider} - ${spec.date} - folytatás`]),
    `Oldal: ${pageIndex + 1}/${spec.pages.length}`,
    '',
    ...(page.labs.length ? ['Paraméter | Érték | Egység | Referencia | Jelzés', ...page.labs.map(formatLabRow)] : []),
    ...page.lines,
  ]
}

function drawLines(page: ReturnType<PDFDocument['addPage']>, font: PDFFont, lines: string[]) {
  let y = 750
  for (const line of lines) {
    if (line) page.drawText(line, { x: 48, y, size: 10, font })
    y -= 16
  }
}

async function textPdf(spec: ReportSpec): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  spec.pages.forEach((_, i) => drawLines(doc.addPage([612, 792]), font, pageLines(spec, i)))
  return doc
}

/** Valódi PDF-bájtok; a szken-oldal a szöveges oldal renderelt képe (szövegréteg nélkül). */
export async function buildReportPdf(spec: ReportSpec): Promise<Buffer> {
  const source = await textPdf(spec)
  if (!spec.scannedPages.length) return Buffer.from(await source.save())
  const sourceBytes = Buffer.from(await source.save())
  const out = await PDFDocument.create({ updateMetadata: false })
  for (let i = 0; i < spec.pages.length; i++) {
    if (spec.scannedPages.includes(i + 1)) {
      const rendered = await renderPdfPages(sourceBytes, String(i + 1))
      const png = await out.embedPng(Buffer.from(rendered.images[0].data, 'base64'))
      out.addPage([612, 792]).drawImage(png, { x: 0, y: 0, width: 612, height: 792 })
    } else {
      const [copied] = await out.copyPages(source, [i])
      out.addPage(copied)
    }
  }
  return Buffer.from(await out.save())
}

export type HealthWikiUpload = { filename: string; bytes: Buffer; spec: ReportSpec; duplicate: boolean }

/** 30 feltöltés összekevert sorrendben; a duplikátum ugyanaz a bájtsor más néven. */
export async function healthWikiUploads(): Promise<HealthWikiUpload[]> {
  const specs = healthReportSpecs()
  const files = await Promise.all(specs.map(async (spec) => ({ filename: spec.filename, bytes: await buildReportPdf(spec), spec, duplicate: false })))
  const rand = mulberry32(2026)
  const shuffled = [...files]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const original = files.find((file) => file.spec.kind === 'labor' && !file.spec.scannedPages.length)!
  const copy = { ...original, filename: original.filename.replace(/\.pdf$/, ' (1).pdf'), duplicate: true }
  shuffled.splice(Math.floor(shuffled.length * 0.7), 0, copy)
  return shuffled
}

/** Kézi smoke-hoz: a 30 feltöltés fájlba, feltöltési sorrendben számozva. */
export async function writeHealthWikiFixtures(outDir: string) {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  await mkdir(outDir, { recursive: true })
  const uploads = await healthWikiUploads()
  for (const [i, upload] of uploads.entries()) {
    await writeFile(join(outDir, `${String(i + 1).padStart(2, '0')}_${upload.filename}`), upload.bytes)
  }
  return uploads.length
}

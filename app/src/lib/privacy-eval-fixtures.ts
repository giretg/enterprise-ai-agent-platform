/**
 * APG-23 eval-fixture-ök — címkézett magyar minták és golden-set esetek.
 *
 * A minták függetlenek a kódtól: a recall/false-positive számítás ezekre épül,
 * nem a transzformáció belső logikájára.
 */
import type { GoldenSetAssertion } from '@/domain/eval/eval-service'
import type { ConnectorFieldsPrivacy } from '@/domain/privacy/connector-privacy'
import { OSTOROSBOR_CRM_PRIVACY_FIELDS } from '@/domain/privacy/connector-privacy'
import type { SurrogateEntityType } from '@/domain/privacy/surrogate-format'

export type LabeledSpan = {
  start: number
  end: number
  entityType: SurrogateEntityType | 'adoszam' | 'taj'
  value: string
}

/** Strukturált tool-output fixture: mely mezők tokenize-álandók. */
export type StructuredEvalCase = {
  id: string
  description: string
  fields: ConnectorFieldsPrivacy
  output: unknown
  /** Mező-útvonalak (pl. `body.0.company_name`), amiknek álnevet kell kapniuk. */
  expectTokenized: string[]
  /** Mező-útvonalak, amiknek nyersen kell maradniuk. */
  expectRaw: string[]
}

/** Szabad szöveges magyar minta címkézett entitásspanokkal. */
export type FreeTextEvalCase = {
  id: string
  description: string
  text: string
  spans: LabeledSpan[]
  /**
   * `pattern` — sensitivity-router + prompt transform (e-mail, adószám).
   * `known_value` — strukturált mezőből ismert érték cseréje (§8/2).
   */
  source: 'pattern' | 'known_value'
  /** known_value forrásnál: a cserék listája. */
  replacements?: Array<{ needle: string; surrogate: string; fromStructuredField: boolean }>
}

/** Nem-védendő szöveg — false positive detekcióhoz. */
export type FalsePositiveEvalCase = {
  id: string
  description: string
  text: string
}

/** Válaszminőség: nyers és pszeudo ág ugyanazzal a golden-settel. */
export type QualityEvalCase = {
  id: string
  description: string
  /** Nyers kontextus (valódi entitásnevekkel). */
  rawContext: string
  /** Pszeudonimizált kontextus (álnevekkel). */
  pseudoContext: string
  /** Stub modell-válasz a nyers ághoz. */
  rawResponse: string
  /** Stub modell-válasz a pszeudo ághoz. */
  pseudoResponse: string
  assertions: GoldenSetAssertion[]
}

/** Workflow: ugyanaz a forgatókönyv OBSERVE és ENFORCE alatt. */
export type WorkflowEvalCase = {
  id: string
  description: string
  /** ENFORCE alatt is sikeresnek kell lennie. */
  expectSuccess: boolean
}

/** Modell-output: ismeretlen/érvénytelen álnév detekció. */
export type SurrogateOutputCase = {
  id: string
  description: string
  output: string
  /** Vaultban létező álnevek (ha vannak). */
  knownSurrogates: string[]
  expectInvalid: boolean
}

export const STRUCTURED_EVAL_CASES: StructuredEvalCase[] = [
  {
    id: 'st-1',
    description: 'CRM egyedi rekord — company_name és email tokenize',
    fields: {
      ...OSTOROSBOR_CRM_PRIVACY_FIELDS,
      email: {
        type: 'string',
        privacy: 'tokenize',
        entity_type: 'email',
        source_id: 'crm/email/{id}',
      },
    },
    output: {
      ok: true,
      body: {
        id: 4821,
        company_name: 'SPAR Magyarország Kereskedelmi Kft.',
        email: 'ada.lovelace@spar.hu',
        revenue: 1_200_000_000,
      },
    },
    expectTokenized: ['body.company_name', 'body.email'],
    expectRaw: ['body.revenue', 'body.id'],
  },
  {
    id: 'st-2',
    description: 'CRM tömb — stabil álnevek, revenue nyers',
    fields: {
      ...OSTOROSBOR_CRM_PRIVACY_FIELDS,
      email: {
        type: 'string',
        privacy: 'tokenize',
        entity_type: 'email',
        source_id: 'crm/email/{id}',
      },
    },
    output: {
      ok: true,
      body: [
        { id: 1, company_name: 'Alfa Kft.', email: 'a@x.hu', revenue: 10 },
        { id: 2, company_name: 'Béta Zrt.', email: 'b@x.hu', revenue: 20 },
        { id: 1, company_name: 'Alfa Kft.', email: 'a@x.hu', revenue: 10 },
      ],
    },
    expectTokenized: ['body.0.company_name', 'body.0.email', 'body.1.company_name', 'body.1.email'],
    expectRaw: ['body.0.revenue', 'body.1.revenue'],
  },
  {
    id: 'st-3',
    description: 'Numerikus mező pass — nem tokenize',
    fields: OSTOROSBOR_CRM_PRIVACY_FIELDS,
    output: { ok: true, body: { id: 99, company_name: 'Gamma Bt.', revenue: 42 } },
    expectTokenized: ['body.company_name'],
    expectRaw: ['body.revenue'],
  },
]

export const FREE_TEXT_EVAL_CASES: FreeTextEvalCase[] = [
  {
    id: 'ft-kv-1',
    description: 'Known-value: strukturált cégnév a szabad szövegben',
    text: 'Kérem küldje el a SPAR Magyarország Kft. adatait a beszerzéshez.',
    spans: [
      { start: 18, end: 48, entityType: 'company', value: 'SPAR Magyarország Kft.' },
    ],
    source: 'known_value',
    replacements: [
      { needle: 'SPAR Magyarország Kft.', surrogate: '[[COMPANY_1]]', fromStructuredField: true },
    ],
  },
  {
    id: 'ft-kv-2',
    description: 'Known-value: két cég ugyanabban a szövegben',
    text: 'A Tesco Globál Áruházak Zrt. és a Lidl Magyarország Bt. versenyez.',
    spans: [
      { start: 2, end: 30, entityType: 'company', value: 'Tesco Globál Áruházak Zrt.' },
      { start: 36, end: 57, entityType: 'company', value: 'Lidl Magyarország Bt.' },
    ],
    source: 'known_value',
    replacements: [
      { needle: 'Tesco Globál Áruházak Zrt.', surrogate: '[[COMPANY_1]]', fromStructuredField: true },
      { needle: 'Lidl Magyarország Bt.', surrogate: '[[COMPANY_2]]', fromStructuredField: true },
    ],
  },
  {
    id: 'ft-kv-3',
    description: 'Known-value: személynév strukturált forrásból',
    text: 'Kiss János ügyvezető aláírta a szerződést.',
    spans: [{ start: 0, end: 11, entityType: 'person', value: 'Kiss János' }],
    source: 'known_value',
    replacements: [{ needle: 'Kiss János', surrogate: '[[PERSON_1]]', fromStructuredField: true }],
  },
  {
    id: 'ft-kv-4',
    description: 'Known-value: ismétlődő cégnév stabil álnévvel',
    text: 'A SPAR Magyarország Kft. és a SPAR Magyarország Kft. adatai.',
    spans: [
      { start: 2, end: 32, entityType: 'company', value: 'SPAR Magyarország Kft.' },
      { start: 37, end: 67, entityType: 'company', value: 'SPAR Magyarország Kft.' },
    ],
    source: 'known_value',
    replacements: [
      { needle: 'SPAR Magyarország Kft.', surrogate: '[[COMPANY_1]]', fromStructuredField: true },
    ],
  },
  {
    id: 'ft-pat-1',
    description: 'Pattern: e-mail cím (sensitivity-router)',
    text: 'Írjon a kovacs.janos@tesco.hu címre a részletekért.',
    spans: [{ start: 9, end: 29, entityType: 'email', value: 'kovacs.janos@tesco.hu' }],
    source: 'pattern',
  },
  {
    id: 'ft-pat-2',
    description: 'Pattern: magyar adószám',
    text: 'Az adószám: 12345678-1-23, kérem ellenőrizze.',
    spans: [{ start: 12, end: 25, entityType: 'adoszam', value: '12345678-1-23' }],
    source: 'pattern',
  },
]

export const FALSE_POSITIVE_EVAL_CASES: FalsePositiveEvalCase[] = [
  {
    id: 'fp-1',
    description: 'Általános üzleti kifejezés — nem entitás',
    text: 'A bevétel növekedése pozitív trendet mutat.',
  },
  {
    id: 'fp-2',
    description: 'Szám és mértékegység — nem PII',
    text: 'Az átlagos rendelés értéke 12 500 forint volt.',
  },
  {
    id: 'fp-3',
    description: 'Dátum — nem tokenize',
    text: 'A jelentés 2026. augusztus 20-án készült.',
  },
  {
    id: 'fp-4',
    description: 'Iparági általános kifejezés',
    text: 'A kiskereskedelmi lánc forgalma szezonális.',
  },
  {
    id: 'fp-5',
    description: 'Technikai azonosító, nem entitás',
    text: 'A kérés azonosítója: REQ-2026-0819.',
  },
  {
    id: 'fp-6',
    description: 'Magyar városnév önmagában',
    text: 'A raktár Budapesten található.',
  },
  {
    id: 'fp-7',
    description: 'Százalék és statisztika',
    text: 'A növekedés 15,3%-ot ért el az előző negyedévhez képest.',
  },
  {
    id: 'fp-8',
    description: 'Általános felszólítás',
    text: 'Kérem ellenőrizze a csatolt dokumentumot.',
  },
  {
    id: 'fp-9',
    description: 'Termék kategória',
    text: 'A tejtermékek ára emelkedett.',
  },
  {
    id: 'fp-10',
    description: 'Belső folyamat leírás',
    text: 'A jóváhagyási folyamat három lépésből áll.',
  },
]

export const QUALITY_EVAL_CASES: QualityEvalCase[] = [
  {
    id: 'q-1',
    description: 'Bevétel-összehasonlítás — számok megmaradnak pszeudonimizálás után is',
    rawContext: 'SPAR bevétele 10 millió, Tesco bevétele 20 millió forint.',
    pseudoContext: '[[COMPANY_1]] bevétele 10 millió, [[COMPANY_2]] bevétele 20 millió forint.',
    rawResponse: 'A Tesco bevétele magasabb: 20 millió forint, szemben a SPAR 10 milliójával.',
    pseudoResponse:
      'A [[COMPANY_2]] bevétele magasabb: 20 millió forint, szemben a [[COMPANY_1]] 10 milliójával.',
    assertions: [
      { description: 'megemlíti a magasabb összeget', type: 'contains', value: '20' },
      { description: 'összehasonlítást ad', type: 'contains', value: 'magasabb' },
      { description: 'nem hallucinál irreleváns adatot', type: 'not_contains', value: '50 millió' },
    ],
  },
  {
    id: 'q-2',
    description: 'Darabszám összesítés — aritmetika független az entitásnevektől',
    rawContext: 'Három beszállító: Alfa Kft. (5 db), Béta Zrt. (3 db), Gamma Bt. (2 db).',
    pseudoContext:
      'Három beszállító: [[COMPANY_1]] (5 db), [[COMPANY_2]] (3 db), [[COMPANY_3]] (2 db).',
    rawResponse: 'Összesen 10 darab van a három beszállítótól.',
    pseudoResponse: 'Összesen 10 darab van a három beszállítótól.',
    assertions: [
      { description: 'helyes összeg', type: 'contains', value: '10' },
      { description: 'válasz nem üres', type: 'min_length', value: 10 },
    ],
  },
  {
    id: 'q-3',
    description: 'Határidő kérdés — dátum megmarad',
    rawContext: 'A szerződés lejárata: 2026-12-31. Az ügyfél: SPAR Magyarország Kft.',
    pseudoContext: 'A szerződés lejárata: 2026-12-31. Az ügyfél: [[COMPANY_1]].',
    rawResponse: 'A szerződés 2026. december 31-én jár le.',
    pseudoResponse: 'A szerződés 2026. december 31-én jár le.',
    assertions: [
      { description: 'megemlíti a dátumot', type: 'contains', value: '2026' },
      { description: 'nem kever össze entitást dátummal', type: 'not_contains', value: 'SPAR' },
    ],
  },
]

export const WORKFLOW_EVAL_CASES: WorkflowEvalCase[] = [
  { id: 'wf-1', description: 'CRM lista olvasás', expectSuccess: true },
  { id: 'wf-2', description: 'CRM egyedi rekord', expectSuccess: true },
  { id: 'wf-3', description: 'Tömbös CRM válasz', expectSuccess: true },
]

/** Modell-output minták az invalid surrogate rate méréshez (≤1% cél). */
export const MODEL_OUTPUT_SAMPLES: string[] = [
  'A [[COMPANY_1]] bevétele 10 millió forint volt.',
  'A [[COMPANY_2]] és a [[COMPANY_3]] együttműködik.',
  'Kérem küldje el a részleteket.',
  'A bevétel növekedése pozitív trendet mutat.',
  'A szerződés 2026. december 31-én jár le.',
  'Összesen 10 darab van a három beszállítótól.',
  'A [[COMPANY_1]] forgalma nőtt az előző negyedévhez képest.',
  'A jelentés elkészült, csatolva küldöm.',
  'A [[PERSON_1]] aláírta a dokumentumot.',
  'A raktár Budapesten található.',
  'A növekedés 15,3%-ot ért el.',
  'A tejtermékek ára emelkedett.',
  'A jóváhagyási folyamat három lépésből áll.',
  'A [[EMAIL_1]] címre elküldtük az ajánlatot.',
  'A beszállítói lista frissítve lett.',
  'A [[COMPANY_1]] bevétele magasabb: 20 millió forint.',
  'A határidő 2026. augusztus 20.',
  'A kérés azonosítója: REQ-2026-0819.',
  'A kiskereskedelmi lánc forgalma szezonális.',
  'A dokumentum ellenőrzése megtörtént.',
]

/** Ismert álnevek a MODEL_OUTPUT_SAMPLES-hez. */
export const KNOWN_SURROGATES = [
  '[[COMPANY_1]]',
  '[[COMPANY_2]]',
  '[[COMPANY_3]]',
  '[[PERSON_1]]',
  '[[EMAIL_1]]',
]

/** Audit/detekció tesztesetek (RL-P5) — nem a rate metrikához. */
export const SURROGATE_OUTPUT_CASES: SurrogateOutputCase[] = [
  {
    id: 'so-1',
    description: 'Érvényes, ismert álnév',
    output: 'A [[COMPANY_1]] forgalma nőtt.',
    knownSurrogates: ['[[COMPANY_1]]'],
    expectInvalid: false,
  },
  {
    id: 'so-2',
    description: 'Kitalált álnév — nincs a vaultban',
    output: 'Hívja a [[COMPANY_99]] ügyfélszolgálatát.',
    knownSurrogates: ['[[COMPANY_1]]'],
    expectInvalid: true,
  },
  {
    id: 'so-3',
    description: 'Ismeretlen entitástípus',
    output: 'Az [[UNKNOWN_1]] adata hiányzik.',
    knownSurrogates: [],
    expectInvalid: true,
  },
  {
    id: 'so-4',
    description: 'Tiszta szöveg álnév nélkül',
    output: 'A bevétel növekedett.',
    knownSurrogates: ['[[COMPANY_1]]'],
    expectInvalid: false,
  },
  {
    id: 'so-5',
    description: 'Több álnév, egy ismeretlen',
    output: '[[COMPANY_1]] és [[COMPANY_2]] együttműködik [[COMPANY_50]]-tel.',
    knownSurrogates: ['[[COMPANY_1]]', '[[COMPANY_2]]'],
    expectInvalid: true,
  },
]

/**
 * „Új munkatárs felvétele” (#957): a kezdőbarát varázsló tiszta logikája.
 *
 * - feladatkártyák + hangnem → munkakör-szöveg (a nyers szöveg a szakértő
 *   nézetben szerkeszthető)
 * - beépített minták és a „mondd el egy-két mondatban” javaslat
 * - tesztkérdések a próbához
 * - felkészültség-mérő
 *
 * Biztonság: a javaslatok csak a pakli létező eszközneveit adhatják, jogot
 * nem adnak — a varázslóban minden javaslat látható és átírható, és semmi
 * nem áll munkába magától.
 */
import { NORMAL_TOOL_CAPABILITY_NAMES } from '@/lib/tool-capability-catalog'
import {
  CAPABILITY_DECK,
  applyCapabilityDeckLevel,
  type CapabilityDeckCategory,
  type CapabilityDeckLevel,
} from '@/lib/agent-capability-deck'
import type { AutonomyLevel } from '@/lib/agent-autonomy'
import type { CreateAgentWizardStepId } from '@/lib/create-agent-wizard'

export type HireLocale = 'hu' | 'en'

export type HireTone = {
  address: 'informal' | 'formal'
  length: 'short' | 'detailed'
  language: 'match' | 'hu' | 'en'
}

export const DEFAULT_HIRE_TONE: HireTone = { address: 'informal', length: 'short', language: 'match' }

export const MAX_HIRE_CARDS = 12
const MAX_CARD_LENGTH = 300

/** Kártyák tisztítása: üres és ismétlődő sorok ki, hossz- és darabkorlát. */
export function normalizeHireCards(cards: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of cards) {
    const card = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_CARD_LENGTH)
    const key = card.toLowerCase()
    if (!card || seen.has(key)) continue
    seen.add(key)
    out.push(card)
    if (out.length >= MAX_HIRE_CARDS) break
  }
  return out
}

const COPY = {
  hu: {
    intro: (name: string) => `Te ${name} vagy, a csapat AI-munkatársa.`,
    when: 'Mikor fordulnak hozzád:',
    duties: 'A feladataid:',
    donts: 'Amit soha ne csinálj:',
    style: 'Stílus:',
    informal: 'Tegeződve szólítsd meg a felhasználót.',
    formal: 'Magázva szólítsd meg a felhasználót.',
    short: 'Röviden, lényegre törően válaszolj.',
    detailed: 'Részletesen, lépésenként magyarázva válaszolj.',
    match: 'A felhasználó nyelvén válaszolj.',
    langHu: 'Magyarul válaszolj.',
    langEn: 'Angolul válaszolj.',
    honesty: 'Ha valamiben nem vagy biztos, mondd meg őszintén, és kérdezz vissza.',
  },
  en: {
    intro: (name: string) => `You are ${name}, an AI teammate of the team.`,
    when: 'When people turn to you:',
    duties: 'Your duties:',
    donts: 'Never do the following:',
    style: 'Style:',
    informal: 'Address the user informally.',
    formal: 'Address the user formally.',
    short: 'Answer briefly and to the point.',
    detailed: 'Answer in detail, explaining step by step.',
    match: "Answer in the user's language.",
    langHu: 'Answer in Hungarian.',
    langEn: 'Answer in English.',
    honesty: 'If you are not sure about something, say so honestly and ask back.',
  },
} as const

/** A munkakör-szöveg a kártyákból és a hangnemből. */
export function composeRoleInstruction(input: {
  name: string
  description: string
  duties: readonly string[]
  donts: readonly string[]
  tone: HireTone
  locale: HireLocale
}): string {
  const c = COPY[input.locale]
  const duties = normalizeHireCards(input.duties)
  if (duties.length === 0) return ''
  const donts = normalizeHireCards(input.donts)
  const name = input.name.trim() || (input.locale === 'hu' ? 'az új munkatárs' : 'the new teammate')
  const lines: string[] = [c.intro(name)]
  const description = input.description.trim()
  if (description) lines.push('', c.when, description)
  lines.push('', c.duties, ...duties.map((d) => `- ${d}`))
  if (donts.length > 0) lines.push('', c.donts, ...donts.map((d) => `- ${d}`))
  const language =
    input.tone.language === 'hu' ? c.langHu : input.tone.language === 'en' ? c.langEn : c.match
  lines.push(
    '',
    c.style,
    `- ${input.tone.address === 'formal' ? c.formal : c.informal}`,
    `- ${input.tone.length === 'detailed' ? c.detailed : c.short}`,
    `- ${language}`,
    `- ${c.honesty}`,
  )
  return lines.join('\n')
}

// ── Minták ───────────────────────────────────────────────────────────────────

type Localized = Record<HireLocale, string>
type LocalizedList = Record<HireLocale, readonly string[]>

export type HireSample = {
  id: 'customer-service' | 'knowledge' | 'marketing' | 'invoice'
  emoji: string
  keywords: readonly string[]
  name: Localized
  description: Localized
  duties: LocalizedList
  donts: LocalizedList
  /** Javasolt hozzáférés pakli-kártyánként — teljes szint, így nincs részleges kártya. */
  access: Partial<Record<CapabilityDeckCategory, Exclude<CapabilityDeckLevel, 'off'>>>
  autonomy: AutonomyLevel
}

export const HIRE_SAMPLES: readonly HireSample[] = [
  {
    id: 'customer-service',
    emoji: '💬',
    keywords: ['vevő', 'vásárló', 'ügyfél', 'reklamáció', 'panasz', 'webshop', 'customer', 'support', 'complaint', 'order', 'rendelés'],
    name: { hu: 'Ügyfélszolgálati asszisztens', en: 'Customer service assistant' },
    description: {
      hu: 'Vevői kérdések, rendelések és reklamációk — ha ügyfél ír, hozzá fordulj.',
      en: 'Customer questions, orders and complaints — turn to them when a customer writes.',
    },
    duties: {
      hu: [
        'Megválaszolja a vevői kérdéseket a céges tudásanyag alapján.',
        'Válaszlevelet fogalmaz a beérkező megkeresésekre.',
        'Reklamációnál összefoglalja az esetet, és értesít engem.',
      ],
      en: [
        'Answers customer questions based on company knowledge.',
        'Writes replies to incoming requests.',
        'Summarises complaints and notifies me.',
      ],
    },
    donts: {
      hu: ['Nem ígér visszatérítést vagy kedvezményt jóváhagyás nélkül.'],
      en: ['Never promises refunds or discounts without approval.'],
    },
    access: { mail: 'read', knowledge: 'read' },
    autonomy: 'trainee',
  },
  {
    id: 'knowledge',
    emoji: '📚',
    keywords: ['tudás', 'tudástár', 'wiki', 'dokumentum', 'szabályzat', 'kézikönyv', 'knowledge', 'policy', 'handbook', 'faq', 'gyik'],
    name: { hu: 'Tudástár-asszisztens', en: 'Knowledge assistant' },
    description: {
      hu: 'Belső kérdések a céges dokumentumokból — ha valamit nem találsz, kérdezd őt.',
      en: 'Internal questions from company documents — ask them when you cannot find something.',
    },
    duties: {
      hu: [
        'Kizárólag a jóváhagyott dokumentumokból válaszol, forrásmegjelöléssel.',
        'Ha nincs válasz a dokumentumokban, ezt megmondja, és megnevezi, kit érdemes kérdezni.',
      ],
      en: [
        'Answers only from approved documents, citing sources.',
        'Says so when the documents have no answer and names who to ask.',
      ],
    },
    donts: {
      hu: ['Nem talál ki adatot, és nem válaszol a dokumentumokon kívüli forrásból.'],
      en: ['Never makes up data or answers from outside the documents.'],
    },
    access: { knowledge: 'read' },
    autonomy: 'trainee',
  },
  {
    id: 'marketing',
    emoji: '📣',
    keywords: ['marketing', 'poszt', 'social', 'hírlevél', 'blog', 'kampány', 'seo', 'newsletter', 'campaign', 'tartalom', 'content'],
    name: { hu: 'Marketing-segéd', en: 'Marketing helper' },
    description: {
      hu: 'Posztok, hírlevelek és blogcikkek első változata — ha tartalom kell, hozzá fordulj.',
      en: 'First versions of posts, newsletters and blog articles — turn to them when you need content.',
    },
    duties: {
      hu: [
        'Közösségimédia-posztokat ír a megadott témára.',
        'Hírlevél- és blogcikk-tervezetet készít.',
        'A kész anyagot a megadott mappába menti.',
      ],
      en: [
        'Writes social media posts on a given topic.',
        'Prepares newsletter and blog outlines.',
        'Saves finished material to the given folder.',
      ],
    },
    donts: {
      hu: ['Semmit nem tesz közzé magától.'],
      en: ['Never posts anything on their own.'],
    },
    access: { documents: 'read', knowledge: 'read' },
    autonomy: 'trainee',
  },
  {
    id: 'invoice',
    emoji: '🧾',
    keywords: ['számla', 'számlák', 'könyvelés', 'pénzügy', 'fizetés', 'invoice', 'billing', 'accounting', 'payment', 'kifizetés'],
    name: { hu: 'Számlaellenőr', en: 'Invoice checker' },
    description: {
      hu: 'Beérkező számlák ellenőrzése — ha számla jön, hozzá fordulj.',
      en: 'Checks incoming invoices — turn to them when an invoice arrives.',
    },
    duties: {
      hu: [
        'Ellenőrzi a beérkező számlák adatait (összeg, határidő, adószám).',
        'Eltérésnél jelzi a hibát, és összefoglalót küld nekem.',
      ],
      en: [
        'Checks incoming invoice details (amount, due date, tax number).',
        'Flags discrepancies and sends me a summary.',
      ],
    },
    donts: {
      hu: ['Nem indít és nem hagy jóvá kifizetést.'],
      en: ['Never initiates or approves a payment.'],
    },
    access: { mail: 'read', documents: 'read' },
    autonomy: 'trainee',
  },
]

const KNOWN_TOOLS = new Set(NORMAL_TOOL_CAPABILITY_NAMES)

/** Csak létező eszköznév maradhat (a javaslat megbízhatatlan bemenet). */
export function knownToolNames(names: Iterable<string>): string[] {
  return [...new Set([...names].map((n) => n.trim()).filter((n) => KNOWN_TOOLS.has(n)))]
}

/** A minta kártyánkénti hozzáféréséből a konkrét eszköznevek. */
export function toolsForSampleAccess(access: HireSample['access']): string[] {
  let enabled = new Set<string>()
  for (const card of CAPABILITY_DECK) {
    const level = access[card.id]
    if (level) enabled = applyCapabilityDeckLevel(card, level, enabled)
  }
  return knownToolNames(enabled)
}

export function hireSampleById(id: string | null | undefined): HireSample | null {
  return HIRE_SAMPLES.find((sample) => sample.id === id) ?? null
}

function keywordScore(sample: HireSample, text: string): number {
  return sample.keywords.reduce((score, keyword) => (text.includes(keyword) ? score + 1 : score), 0)
}

/** A leíráshoz legjobban illő minta (kulcsszó-egyezés), vagy null. */
export function matchHireSample(text: string): HireSample | null {
  const haystack = text.toLowerCase()
  let best: HireSample | null = null
  let bestScore = 0
  for (const sample of HIRE_SAMPLES) {
    const score = keywordScore(sample, haystack)
    if (score > bestScore) {
      best = sample
      bestScore = score
    }
  }
  return best
}

const GENERIC_DUTY_EXAMPLES: LocalizedList = {
  hu: [
    'Megválaszolja a kollégák kérdéseit a saját területén.',
    'Összefoglalót készít a beérkező anyagokról.',
    'Ha elakad, értesít engem.',
  ],
  en: [
    'Answers colleagues’ questions in their area.',
    'Summarises incoming material.',
    'Notifies me when stuck.',
  ],
}

/** Példa-feladatok az üres állapothoz, a kitöltött szerepkörhöz illesztve. */
export function suggestDutyExamples(text: string, locale: HireLocale): string[] {
  const sample = matchHireSample(text)
  return [...(sample ? sample.duties[locale] : GENERIC_DUTY_EXAMPLES[locale])]
}

const GENERIC_DONT_EXAMPLES: LocalizedList = {
  hu: ['Nem küld semmit külső címre jóváhagyás nélkül.', 'Nem ad ki személyes adatot.'],
  en: ['Never sends anything to an outside address without approval.', 'Never discloses personal data.'],
}

/** Példa-tiltások („Mit NE csináljon”) a szerepkörhöz. */
export function suggestDontExamples(text: string, locale: HireLocale): string[] {
  const sample = matchHireSample(text)
  return [...new Set([...(sample ? sample.donts[locale] : []), ...GENERIC_DONT_EXAMPLES[locale]])]
}

export type HireDraft = {
  name: string
  description: string
  duties: string[]
  donts: string[]
  tone: HireTone
  tools: string[]
  autonomy: AutonomyLevel
  sampleId: HireSample['id'] | null
}

export function draftFromSample(sample: HireSample, locale: HireLocale): HireDraft {
  return {
    name: sample.name[locale],
    description: sample.description[locale],
    duties: [...sample.duties[locale]],
    donts: [...sample.donts[locale]],
    tone: { ...DEFAULT_HIRE_TONE },
    tools: toolsForSampleAccess(sample.access),
    autonomy: sample.autonomy,
    sampleId: sample.id,
  }
}

// Ékezetes szavaknál a `\b` nem működik — sima részszó-egyezés.
const NOTIFY_RE = /szóljon|szólj|értesít|jelezzen|jelez|notify|tell me|let me know|alert/i

/**
 * „Mondd el egy-két mondatban” — gépi javaslat a leírásból: mondatokra és
 * „ha …” mellékmondatokra bontja feladatkártyákká, és a legjobban illő minta
 * nevét / tiltásait / olvasó eszközeit ajánlja. A javaslat a következő
 * lépéseken teljesen átírható; jogot magától nem ad, és a leírásban szereplő
 * utasítást nem hajtja végre (csak szövegként veszi át).
 */
export function draftFromDescription(text: string, locale: HireLocale): HireDraft {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 1000)
  const sample = matchHireSample(clean)
  const sentences = clean
    .split(/(?<=[.!?])\s+|;\s*|,\s*(?=(?:és\s+)?(?:ha|amikor|if|when)\b)/i)
    .map((part) => part.replace(/^(és|and)\s+/i, '').replace(/[.!?]+$/, '').trim())
    .filter((part) => part.length > 2)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1) + '.')
  const duties = normalizeHireCards(sentences.length > 0 ? sentences : [clean])
  const fallbackName = locale === 'hu' ? 'Új munkatárs' : 'New teammate'
  return {
    name: sample?.name[locale] ?? fallbackName,
    description: clean.length <= 200 ? clean : (sample?.description[locale] ?? clean.slice(0, 200)),
    duties: duties.length > 0 ? duties : [...GENERIC_DUTY_EXAMPLES[locale]],
    donts: sample ? [...sample.donts[locale]] : [],
    tone: { ...DEFAULT_HIRE_TONE },
    tools: sample ? toolsForSampleAccess(sample.access) : [],
    autonomy: 'trainee',
    sampleId: sample?.id ?? null,
  }
}

/** Megnevez-e értesítést a feladat (a próbakérdéshez). */
export function dutyMentionsNotify(duty: string): boolean {
  return NOTIFY_RE.test(duty)
}

/** Három próbakérdés a feladatkártyákból. */
export function suggestTestQuestions(input: {
  duties: readonly string[]
  description: string
  locale: HireLocale
}): string[] {
  const hu = input.locale === 'hu'
  const duties = normalizeHireCards(input.duties)
  const questions: string[] = []
  const first = duties[0]
  questions.push(
    hu
      ? 'Mutatkozz be röviden: miben tudsz segíteni nekem?'
      : 'Introduce yourself briefly: how can you help me?',
  )
  if (first) {
    questions.push(
      hu
        ? `Mutasd meg egy példán, hogyan csinálod ezt: „${first.replace(/\.$/, '')}”.`
        : `Show me with an example how you do this: “${first.replace(/\.$/, '')}”.`,
    )
  }
  const notify = duties.find(dutyMentionsNotify)
  questions.push(
    notify
      ? hu
        ? `Mit teszel, ha ez a helyzet áll elő: „${notify.replace(/\.$/, '')}”?`
        : `What do you do in this situation: “${notify.replace(/\.$/, '')}”?`
      : hu
        ? 'Mit csinálsz, ha olyat kérdezek, amire nem tudod a választ?'
        : 'What do you do if I ask something you do not know?',
  )
  return questions.slice(0, 3)
}

// ── Felkészültség-mérő ───────────────────────────────────────────────────────

export type HireReadinessItemId = 'name' | 'intro' | 'duty' | 'access' | 'knowledge' | 'team' | 'launch'

export type HireReadinessItem = {
  id: HireReadinessItemId
  done: boolean
  required: boolean
  weight: number
  step: CreateAgentWizardStepId
}

const READINESS_ITEMS: ReadonlyArray<Omit<HireReadinessItem, 'done'>> = [
  { id: 'name', required: true, weight: 15, step: 'identity' },
  { id: 'intro', required: true, weight: 15, step: 'identity' },
  { id: 'duty', required: true, weight: 20, step: 'duties' },
  { id: 'access', required: false, weight: 20, step: 'access' },
  { id: 'knowledge', required: false, weight: 10, step: 'knowledge' },
  { id: 'team', required: false, weight: 10, step: 'team' },
  { id: 'launch', required: false, weight: 10, step: 'launch' },
]

export type HireReadinessInput = {
  name: string
  description: string
  roleInstruction: string
  grantedToolCount: number
  connectorCount: number
  skillCount: number
  knowledgeDocumentCount: number
  wikiLinkCount: number
  sharedWithOthers: boolean
  live: boolean
}

/**
 * Tájékoztató mérő — nem blokkol. Kötelező csak a név, a bemutatkozás és
 * legalább egy feladat; a többi hiány kattintható tipp.
 */
export function computeHireReadiness(input: HireReadinessInput): {
  percent: number
  items: HireReadinessItem[]
  missing: HireReadinessItem[]
  requiredDone: boolean
} {
  const doneById: Record<HireReadinessItemId, boolean> = {
    name: input.name.trim().length > 0,
    intro: input.description.trim().length > 0,
    duty: input.roleInstruction.trim().length > 0,
    access: input.grantedToolCount + input.connectorCount + input.skillCount > 0,
    knowledge: input.knowledgeDocumentCount + input.wikiLinkCount > 0,
    team: input.sharedWithOthers,
    launch: input.live,
  }
  const items = READINESS_ITEMS.map((item) => ({ ...item, done: doneById[item.id] }))
  const percent = items.reduce((sum, item) => (item.done ? sum + item.weight : sum), 0)
  return {
    percent,
    items,
    missing: items.filter((item) => !item.done),
    requiredDone: items.every((item) => !item.required || item.done),
  }
}

/**
 * A varázsló által összeállított munkakör-szöveg visszafejtése kártyákra
 * (folytatáskor). Csak akkor `exact`, ha a kártyákból pontosan ugyanez a
 * szöveg állna össze — különben a szöveg kézzel szerkesztett, és a szakértő
 * nézetben marad.
 */
export function parseComposedRoleInstruction(input: {
  roleInstruction: string
  name: string
  description: string
  locale: HireLocale
}): { duties: string[]; donts: string[]; tone: HireTone; exact: boolean } {
  const text = input.roleInstruction.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  for (const locale of [input.locale, input.locale === 'hu' ? 'en' : 'hu'] as const) {
    const c = COPY[locale]
    const listAfter = (heading: string) => {
      const start = lines.indexOf(heading)
      if (start < 0) return []
      const out: string[] = []
      for (const line of lines.slice(start + 1)) {
        if (!line.startsWith('- ')) break
        out.push(line.slice(2))
      }
      return out
    }
    const duties = listAfter(c.duties)
    if (duties.length === 0) continue
    const donts = listAfter(c.donts)
    const style = listAfter(c.style)
    const tone: HireTone = {
      address: style.includes(c.formal) ? 'formal' : 'informal',
      length: style.includes(c.detailed) ? 'detailed' : 'short',
      language: style.includes(c.langHu) ? 'hu' : style.includes(c.langEn) ? 'en' : 'match',
    }
    const recomposed = composeRoleInstruction({
      name: input.name,
      description: input.description,
      duties,
      donts,
      tone,
      locale,
    })
    return { duties, donts, tone, exact: recomposed === text.trim() }
  }
  return { duties: [], donts: [], tone: { ...DEFAULT_HIRE_TONE }, exact: false }
}

// ── Ki dolgozik vele? ────────────────────────────────────────────────────────

export type HireTeamUser = {
  id: string
  role: string | null
  accessLevel: 'view' | 'operate' | null
}

/** Admin és jóváhagyó alapból hozzáfér — nekik nem kell külön engedély. */
export function isTeamMemberNeedingGrant(user: HireTeamUser): boolean {
  return user.role !== 'admin' && user.role !== 'approver'
}

export type HireTeamChoice = 'me' | 'team' | 'selected'

export function hireTeamChoice(users: readonly HireTeamUser[]): HireTeamChoice {
  const members = users.filter(isTeamMemberNeedingGrant)
  if (!members.some((user) => user.accessLevel)) return 'me'
  if (members.every((user) => user.accessLevel === 'operate')) return 'team'
  return 'selected'
}

/** Az „egész csapat” egy kattintása: kiknek kell még használati engedély. */
export function usersToGrantForWholeTeam(users: readonly HireTeamUser[]): string[] {
  return users
    .filter((user) => isTeamMemberNeedingGrant(user) && user.accessLevel !== 'operate')
    .map((user) => user.id)
}

/** Rajtad és az adminokon kívül látja-e más (figyelmeztetéshez). */
export function hireSharedWithOthers(users: readonly HireTeamUser[]): boolean {
  return users.some((user) => isTeamMemberNeedingGrant(user) && user.accessLevel !== null)
}

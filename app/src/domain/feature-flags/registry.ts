/**
 * #1126 fokozatos bevezetés: a flagek listája. Az állapot az adatbázisban van, a lista itt, így az
 * elgépelt név fordítási hiba, és egy bejegyzés törlése után a típushibák megmutatják az összes
 * használati helyet. Útmutató: `docs/feature-flags.md`.
 */
export type LocalizedText = { hu: string; en: string }

/** A platformon kívül futó kliensek, amelyek nem érik el közvetlenül a kiértékelőt. */
export const FEATURE_FLAG_EXTERNAL_CLIENTS = ['platform_chat', 'hermes'] as const
export type FeatureFlagExternalClient = (typeof FEATURE_FLAG_EXTERNAL_CLIENTS)[number]

/**
 * Mi a biztonságos, ha egy futó munka közben leállítják a flaget:
 * `finish_run` = a következő lépésnél érthető üzenettel lezárul; `old_path` = a régi úton folytatódik.
 */
export const FEATURE_FLAG_STOP_BEHAVIORS = ['finish_run', 'old_path'] as const
export type FeatureFlagStopBehavior = (typeof FEATURE_FLAG_STOP_BEHAVIORS)[number]

export type FeatureFlagDefinition = {
  /** Rövid név; a cég auditnaplója is ezt mutatja. */
  title: LocalizedText
  /** Mit kap a felhasználó bekapcsolva, közérthetően. */
  whatChanges: LocalizedText
  /** Mi történik leállításkor, és mi lesz a bekapcsolva keletkezett adatokkal. */
  whenOff: LocalizedText
  /** Felelős. */
  owner: string
  /** Kapcsolódó GitHub issue vagy PR száma. */
  issue: number
  /** Felülvizsgálati dátum (ÉÉÉÉ-HH-NN); ha lejár, a CI figyelmeztet. */
  reviewBy: string
  /** Csak akkor kell, ha a flag a chat-worker vagy a Hermes működését is kapcsolja. */
  externalClients?: {
    clients: readonly FeatureFlagExternalClient[]
    onStop: FeatureFlagStopBehavior
  }
}

/** A kulcs formája `terület.funkció`, pl. `chat.resumable_pause`. */
export const FEATURE_FLAGS = {
  'voice.elevenlabs': {
    title: { hu: 'ElevenLabs hangszolgáltató', en: 'ElevenLabs voice provider' },
    whatChanges: {
      hu: 'A platform-adminisztrátor a munkatárs hang-beszélgetéséhez az OpenAI helyett az ElevenLabs szolgáltatást is választhatja, a cég saját ElevenLabs-kulcsával. A hang és az elhangzott szöveg ilyenkor az ElevenLabshez kerül.',
      en: 'A platform admin can choose ElevenLabs instead of OpenAI for a teammate\'s voice conversations, using the company\'s own ElevenLabs key. The audio and the spoken text then go to ElevenLabs.',
    },
    whenOff: {
      hu: 'Az ElevenLabsre állított munkatársnál új hang-beszélgetés nem indul, és a futó beszélgetés a következő eszközhívásnál elveszíti az adatok elérését. Az OpenAI-t használó munkatársakat ez nem érinti. A beállítás és a mentett átiratok megmaradnak.',
      en: 'Teammates set to ElevenLabs cannot start new voice conversations, and a running one loses data access at its next tool call. Teammates on OpenAI are unaffected. The settings and saved transcripts remain.',
    },
    owner: 'Giret Gergely',
    issue: 1107,
    reviewBy: '2027-03-01',
  },
  'knowledge.file_download': {
    title: { hu: 'Tudásbázis-fájlok letöltése', en: 'Knowledge base file download' },
    whatChanges: {
      hu: 'A tudásbázis Fájlok fülén soronként Letöltés gomb jelenik meg azoknak, akik az adott tudásbázist láthatják. Minden letöltés naplózva van.',
      en: 'A Download button appears on each row of the Files tab for everyone who can see that knowledge base. Every download is logged.',
    },
    whenOff: {
      hu: 'A gomb eltűnik, és a letöltési cím „nem található” választ ad. A teljes tudásbázis ZIP-letöltése az adminoknak továbbra is működik. Adat nem változik.',
      en: 'The button disappears and the download address answers "not found". Admins can still download the whole knowledge base as a ZIP. No data changes.',
    },
    owner: 'Giret Gergely',
    issue: 1139,
    reviewBy: '2027-03-01',
  },
  'wiki.comments': {
    title: { hu: 'Wiki-kommentek', en: 'Wiki comments' },
    whatChanges: {
      hu: 'Aki olvashat egy wikit, kommentet írhat az oldalaihoz, az író joggal rendelkező AI-munkatárs pedig feldolgozza őket. A szerző a Teendők között kap visszajelzést.',
      en: 'Anyone who can read a wiki can comment on its pages, and an AI teammate with write access works through them. The author gets feedback under Tasks.',
    },
    whenOff: {
      hu: 'A kommentek panelje, füle, Teendők-listája és az AI-munkatárs eszközei eltűnnek. A meglévő kommentek megmaradnak, és újrabekapcsoláskor visszatérnek; a már elindult jóváhagyások lefutnak. Az oldalakon a kommentből származó forrás továbbra is olvasható.',
      en: 'The comments panel, tab, task list and the AI teammate tools disappear. Existing comments are kept and come back when it is switched on again; approvals already started still finish. Sources that came from a comment stay readable on the pages.',
    },
    owner: 'Giret Gergely',
    issue: 1129,
    reviewBy: '2027-03-01',
  },
} satisfies Record<string, FeatureFlagDefinition>

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS & string

export type FeatureFlagRegistry = Readonly<Record<string, FeatureFlagDefinition>>

/** Törölt kulcsok: nem használhatók újra, mert a régi adatbázis-sor új jelentést kapna. */
export const RETIRED_FEATURE_FLAG_KEYS: readonly string[] = []

const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
}

/** CI-ellenőrzés: a hibák megbuktatják a futást, a figyelmeztetések nem (D6). */
export function validateFeatureFlagRegistry(
  registry: FeatureFlagRegistry,
  retiredKeys: readonly string[],
  today: Date,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  for (const [key, def] of Object.entries(registry)) {
    if (!KEY_PATTERN.test(key)) errors.push(`${key}: a kulcs formája legyen terület.funkció (kisbetű, szám, aláhúzás)`)
    if (retiredKeys.includes(key)) errors.push(`${key}: törölt kulcs nem használható újra`)
    for (const field of ['title', 'whatChanges', 'whenOff'] as const) {
      if (!def[field]?.hu?.trim() || !def[field]?.en?.trim()) errors.push(`${key}: a(z) ${field} magyarul és angolul is kötelező`)
    }
    if (def.externalClients) {
      const { clients, onStop } = def.externalClients
      if (!clients?.length || !clients.every((client) => FEATURE_FLAG_EXTERNAL_CLIENTS.includes(client))) {
        errors.push(`${key}: az externalClients.clients legalább egy ismert klienst soroljon fel`)
      }
      if (!FEATURE_FLAG_STOP_BEHAVIORS.includes(onStop)) {
        errors.push(`${key}: az externalClients.onStop értéke finish_run vagy old_path`)
      }
    }
    if (!def.owner?.trim()) errors.push(`${key}: a felelős kötelező`)
    if (!Number.isInteger(def.issue) || def.issue <= 0) errors.push(`${key}: az issue száma kötelező`)
    if (!isRealDate(def.reviewBy ?? '')) {
      errors.push(`${key}: a felülvizsgálati dátum formája ÉÉÉÉ-HH-NN`)
    } else if (new Date(`${def.reviewBy}T23:59:59Z`).getTime() < today.getTime()) {
      warnings.push(`${key}: a felülvizsgálati dátum (${def.reviewBy}) lejárt`)
    }
  }
  return { errors, warnings }
}

// Gives each AI agent a human face: a nickname, an emoji, a personality line,
// a greeting and a living "mood" — so the team feels like real coworkers,
// not faceless services in a control panel.

export type AgentPersona = {
  nickname: string
  emoji: string
  trait: string
  greeting: string
  /** Two warm tones for the agent's avatar gradient. */
  gradient: [string, string]
}

const PERSONAS: Record<string, AgentPersona> = {
  'Könyvelő Agent': {
    nickname: 'Bori',
    emoji: '📒',
    trait: 'A számok költője. Minden tételt a helyére tesz, soha nem kapkod.',
    greeting: 'Szia! Hozd a számlákat, én rendet rakok bennük.',
    gradient: ['#d98a5b', '#b23a55'],
  },
  'Ellenőrző Agent': {
    nickname: 'Robi',
    emoji: '🔍',
    trait: 'A kételkedő barát. Kétszer is megnéz mindent, mielőtt rábólint.',
    greeting: 'Megnézem helyetted a részleteket — nyugodtan bízd rám.',
    gradient: ['#4d86a6', '#5d8a4f'],
  },
  'Dokumentum Agent': {
    nickname: 'Dóra',
    emoji: '📄',
    trait: 'A rendszerező. A papírhalomból pillanatok alatt sztorit ír.',
    greeting: 'Add ide a dokumentumot, kiolvasom belőle a lényeget.',
    gradient: ['#b07d24', '#c25f7d'],
  },
}

const FALLBACK_GRADIENTS: [string, string][] = [
  ['#b23a55', '#b07d24'],
  ['#5d8a4f', '#4d86a6'],
  ['#7d5fae', '#c25f7d'],
  ['#d98a5b', '#8c2840'],
]

/** Admin-editable persona overrides stored on the agent. Empty/nullish values
 *  fall back to the computed persona so nobody is left faceless. */
export type PersonaOverrides = {
  personaNickname?: string | null
  personaGreeting?: string | null
  personaTrait?: string | null
}

/** Deterministic persona for any agent — known ones are hand-written,
 *  the rest get a warm fallback so nobody is left faceless. Optional
 *  `overrides` (e.g. admin-edited name/greeting/trait) win when non-empty. */
export function personaFor(name: string, overrides?: PersonaOverrides): AgentPersona {
  const base = basePersonaFor(name)
  const nickname = overrides?.personaNickname?.trim()
  const greeting = overrides?.personaGreeting?.trim()
  const trait = overrides?.personaTrait?.trim()
  return {
    ...base,
    ...(nickname ? { nickname } : {}),
    ...(greeting ? { greeting } : {}),
    ...(trait ? { trait } : {}),
  }
}

function basePersonaFor(name: string): AgentPersona {
  if (PERSONAS[name]) return PERSONAS[name]

  const seed = [...name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  const gradient = FALLBACK_GRADIENTS[seed % FALLBACK_GRADIENTS.length]
  const nickname = name.split(/\s+/)[0] || name
  return {
    nickname,
    emoji: '✨',
    trait: 'Új a csapatban — alig várja, hogy bizonyíthasson.',
    greeting: 'Örülök, hogy itt lehetek! Mondd, miben segíthetek?',
    gradient,
  }
}

/** A warm, human reading of a machine status. */
export function humanStatus(status: string): { label: string; mood: 'awake' | 'resting' } {
  if (status === 'active') {
    return { label: 'Most épp dolgozik', mood: 'awake' }
  }
  if (status === 'retired') {
    return { label: 'Nyugdíjazva', mood: 'resting' }
  }
  if (status === 'suspended') {
    return { label: 'Felfüggesztve', mood: 'resting' }
  }
  if (status === 'draft') {
    return { label: 'Még vázlat', mood: 'resting' }
  }
  return { label: 'Kávészünetet tart', mood: 'resting' }
}

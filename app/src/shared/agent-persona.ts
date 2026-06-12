import type { Agent } from './types'

/**
 * Az agentek nem dobozok és nem szolgáltatás-fiókok — munkatársak.
 * Mindegyiknek van arca, beceneve, személyisége és hangulata.
 */
export interface AgentPersona {
  nickname: string
  emoji: string
  blurb: string
  superpower: string
  greeting: string
  gradient: [string, string]
}

const PERSONAS: Record<string, AgentPersona> = {
  'agent-bookkeeper-01': {
    nickname: 'Bori',
    emoji: '📒',
    blurb: 'Precíz, de türelmes. Imádja, ha a végén minden fillér a helyén van.',
    superpower: 'Számlák kiolvasása és könyvelési javaslat',
    greeting: 'Szia! Bori vagyok, a könyvelős. Küldd a számlákat, a többit bízd rám.',
    gradient: ['#f2b35e', '#ec7a5f'],
  },
  'agent-recon-01': {
    nickname: 'Robi',
    emoji: '🔍',
    blurb: 'Aprólékos detektív. Egyetlen eltérés sem kerüli el a figyelmét.',
    superpower: 'Tranzakciók egyeztetése és eltérés-jelzés',
    greeting: 'Helló, Robi vagyok. Ha valami nem stimmel a számokban, én megtalálom.',
    gradient: ['#82b6cf', '#8fc08a'],
  },
  'agent-doc-01': {
    nickname: 'Dóra',
    emoji: '📄',
    blurb: 'Gyorsolvasó. Bármilyen szerződésből pár perc alatt kihámozza a lényeget.',
    superpower: 'Szerződések és szabályzatok kivonatolása',
    greeting: 'Üdv, Dóra vagyok. Add ide a hosszú dokumentumokat — kivonatolom neked.',
    gradient: ['#b69ae0', '#e98aa6'],
  },
}

const FALLBACK_GRADIENTS: [string, string][] = [
  ['#ec7a5f', '#f2b35e'],
  ['#8fc08a', '#82b6cf'],
  ['#b69ae0', '#e98aa6'],
  ['#f2b35e', '#8fc08a'],
]

function hash(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function getPersona(agent: Pick<Agent, 'id' | 'name'>): AgentPersona {
  const known = PERSONAS[agent.id]
  if (known) return known
  const h = hash(agent.id)
  return {
    nickname: agent.name.split(' ')[0],
    emoji: '🤖',
    blurb: 'Új munkatárs — épp ismerkedik a csapattal.',
    superpower: 'Általános asszisztencia',
    greeting: `Szia! ${agent.name} vagyok, örülök hogy itt lehetek.`,
    gradient: FALLBACK_GRADIENTS[h % FALLBACK_GRADIENTS.length],
  }
}

export interface HumanStatus {
  label: string
  emoji: string
  color: string
  dot: string
}

export function humanStatus(status: Agent['status']): HumanStatus {
  switch (status) {
    case 'active':
      return { label: 'Most épp dolgozik', emoji: '✨', color: 'var(--color-sage)', dot: '#8fc08a' }
    case 'paused':
      return { label: 'Kávészünetet tart', emoji: '☕', color: 'var(--color-honey)', dot: '#f2b35e' }
    case 'retired':
      return { label: 'Nyugdíjba vonult', emoji: '🌅', color: 'var(--color-ink-faint)', dot: '#9a8678' }
  }
}

export type ConnectorUsageStatus = {
  usable: boolean
  text: string
}

function formatNameList(names: readonly string[], andWord: string): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} ${andWord} ${names[1]}`
  return `${names.slice(0, -1).join(', ')} ${andWord} ${names[names.length - 1]}`
}

type UsageCopy = {
  and: string
  capableOne: (list: string) => string
  capableMany: (list: string) => string
  capableCount: (count: number) => string
  missingCapability: string
  unassigned: string
}

const HU_USAGE: UsageCopy = {
  and: 'és',
  capableOne: (list) => `${list} rendelkezik a szükséges eszközjoggal.`,
  capableMany: (list) => `${list} rendelkeznek a szükséges eszközjoggal.`,
  capableCount: (count) => `${count} aktív agent rendelkezik a szükséges eszközjoggal.`,
  missingCapability: 'A fiók össze van kötve, de a hozzárendelt agenteknél hiányzik a szükséges eszközjog.',
  unassigned: 'A fiók össze van kötve, de még nincs agenthez rendelve.',
}

export function connectorUsageStatus(
  input: {
    assignedAgentCount: number
    capableAgentCount: number
    capableAgentDisplayNames?: readonly string[]
  },
  copy: UsageCopy = HU_USAGE,
): ConnectorUsageStatus {
  const capableNames = input.capableAgentDisplayNames?.filter((name) => name.trim().length > 0) ?? []
  if (capableNames.length > 0 || input.capableAgentCount > 0) {
    return {
      usable: true,
      text:
        capableNames.length > 0
          ? capableNames.length === 1
            ? copy.capableOne(formatNameList(capableNames, copy.and))
            : copy.capableMany(formatNameList(capableNames, copy.and))
          : copy.capableCount(input.capableAgentCount),
    }
  }
  if (input.assignedAgentCount > 0) {
    return { usable: false, text: copy.missingCapability }
  }
  return { usable: false, text: copy.unassigned }
}

export type ProviderVisual = 'gmail' | 'google_drive' | 'telegram' | 'microsoft' | 'generic'

export function providerVisual(provider: string): ProviderVisual {
  const normalized = provider.toLowerCase()
  if (
    normalized === 'google_drive' ||
    normalized === 'google-drive' ||
    normalized.includes('drive')
  ) {
    return 'google_drive'
  }
  if (normalized === 'gmail') return 'gmail'
  if (normalized === 'telegram') return 'telegram'
  if (normalized.includes('microsoft') || normalized.includes('office')) return 'microsoft'
  return 'generic'
}

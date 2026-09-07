export type ConnectorUsageStatus = {
  usable: boolean
  text: string
}

function formatHungarianNameList(names: readonly string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} és ${names[1]}`
  return `${names.slice(0, -1).join(', ')} és ${names[names.length - 1]}`
}

function capableAgentsUsageText(names: readonly string[]): string {
  const list = formatHungarianNameList(names)
  const verb = names.length === 1 ? 'rendelkezik' : 'rendelkeznek'
  return `${list} ${verb} a szükséges eszközjoggal.`
}

export function connectorUsageStatus(input: {
  assignedAgentCount: number
  capableAgentCount: number
  capableAgentDisplayNames?: readonly string[]
}): ConnectorUsageStatus {
  const capableNames = input.capableAgentDisplayNames?.filter((name) => name.trim().length > 0) ?? []
  if (capableNames.length > 0 || input.capableAgentCount > 0) {
    return {
      usable: true,
      text:
        capableNames.length > 0
          ? capableAgentsUsageText(capableNames)
          : `${input.capableAgentCount} aktív agent rendelkezik a szükséges eszközjoggal.`,
    }
  }
  if (input.assignedAgentCount > 0) {
    return {
      usable: false,
      text: 'A fiók össze van kötve, de a hozzárendelt agenteknél hiányzik a szükséges eszközjog.',
    }
  }
  return {
    usable: false,
    text: 'A fiók össze van kötve, de még nincs agenthez rendelve.',
  }
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

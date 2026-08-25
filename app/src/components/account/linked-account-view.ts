export type ConnectorUsageStatus = {
  usable: boolean
  text: string
}

export function connectorUsageStatus(input: {
  assignedAgentCount: number
  capableAgentCount: number
}): ConnectorUsageStatus {
  if (input.capableAgentCount > 0) {
    return {
      usable: true,
      text: `${input.capableAgentCount} aktív agent rendelkezik a szükséges eszközjoggal.`,
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

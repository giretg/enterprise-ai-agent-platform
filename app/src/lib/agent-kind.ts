export type AgentSandboxKind = 'wiki' | 'bookkeeper' | 'generic'

export type AgentSandboxSource = {
  name: string
  roleDescription?: string | null
  systemPrompt?: string | null
}

export function sandboxKindForAgent(agent: AgentSandboxSource): AgentSandboxKind {
  const text = [agent.name, agent.roleDescription, agent.systemPrompt]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (text.includes('wiki') || text.includes('tudás') || text.includes('knowledge')) {
    return 'wiki'
  }

  if (
    text.includes('könyvel') ||
    text.includes('számla') ||
    text.includes('invoice') ||
    text.includes('bookkeep') ||
    text.includes('reconciliation')
  ) {
    return 'bookkeeper'
  }

  return 'generic'
}

export function sandboxLabelForKind(kind: AgentSandboxKind) {
  if (kind === 'wiki') return 'Tudásbázis sandbox'
  if (kind === 'bookkeeper') return 'Könyvelő sandbox'
  return 'Általános sandbox'
}

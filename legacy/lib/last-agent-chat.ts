'use client'

const STORAGE_KEY = 'eai.last-agent-chat'

type LastAgentChatRecord = {
  tenantId: string
  agentId: string
  updatedAt: string
}

export function recordLastAgentChat(tenantId: string, agentId: string) {
  if (typeof window === 'undefined') return
  const payload: LastAgentChatRecord = {
    tenantId,
    agentId,
    updatedAt: new Date().toISOString(),
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // private mode / quota
  }
}

export function readLastAgentChat(tenantId: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastAgentChatRecord>
    if (parsed.tenantId !== tenantId || typeof parsed.agentId !== 'string') return null
    return parsed.agentId
  } catch {
    return null
  }
}

export async function recordLastAgentChatForCurrentTenant(agentId: string) {
  const { getTenantSwitcherState } = await import('@/app/actions/tenant')
  const res = await getTenantSwitcherState()
  if (res.success && res.data.activeTenantId) {
    recordLastAgentChat(res.data.activeTenantId, agentId)
  }
}

export type AgentChatSessionAgent = {
  id: string
  name: string
  status?: string
  avatarUrl?: string | null
  personaNickname?: string | null
  personaGreeting?: string | null
  personaTrait?: string | null
}

export type AgentChatSession = {
  /** Egy agenthez egy élő ablak — az agent id a session kulcs. */
  id: string
  agent: AgentChatSessionAgent
  canDistillSkill: boolean
  initialConversationId: string | null
  /** OAuth-grant után a chat-forduló automatikus folytatása. */
  resumeAfterGrant: boolean
  /** Növelve: a panel visszaáll a tálcáról / előtérbe jön. */
  restoreSignal: number
}

let sessions: AgentChatSession[] = []
const EMPTY_SERVER_SNAPSHOT: AgentChatSession[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function getAgentChatSessions() {
  return sessions
}

export function getAgentChatSessionsServerSnapshot(): AgentChatSession[] {
  return EMPTY_SERVER_SNAPSHOT
}

export function subscribeAgentChatSessions(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function openAgentChat(input: {
  agent: AgentChatSessionAgent
  canDistillSkill?: boolean
  initialConversationId?: string | null
  resumeAfterGrant?: boolean
}): string {
  const existing = sessions.find((session) => session.agent.id === input.agent.id)
  if (existing) {
    sessions = sessions.map((session) =>
      session.id === existing.id
        ? {
            ...session,
            agent: input.agent,
            canDistillSkill: input.canDistillSkill ?? session.canDistillSkill,
            initialConversationId:
              input.initialConversationId !== undefined
                ? input.initialConversationId
                : session.initialConversationId,
            resumeAfterGrant:
              input.resumeAfterGrant !== undefined
                ? input.resumeAfterGrant
                : session.resumeAfterGrant,
            restoreSignal: session.restoreSignal + 1,
          }
        : session,
    )
    emit()
    return existing.id
  }

  const id = input.agent.id
  sessions = [
    ...sessions,
    {
      id,
      agent: input.agent,
      canDistillSkill: input.canDistillSkill ?? false,
      initialConversationId: input.initialConversationId ?? null,
      resumeAfterGrant: input.resumeAfterGrant ?? false,
      restoreSignal: 0,
    },
  ]
  emit()
  return id
}

/** OAuth-folytatás egyszer fusson le — a panel indulás után törli a zászlót. */
export function clearAgentChatResumeAfterGrant(id: string) {
  const existing = sessions.find((session) => session.id === id)
  if (!existing || !existing.resumeAfterGrant) return
  sessions = sessions.map((session) =>
    session.id === id ? { ...session, resumeAfterGrant: false } : session,
  )
  emit()
}

export function closeAgentChat(id: string) {
  const next = sessions.filter((session) => session.id !== id)
  if (next.length === sessions.length) return
  sessions = next
  emit()
}

/** Teszt / reset. */
export function clearAgentChatSessions() {
  if (sessions.length === 0) return
  sessions = []
  emit()
}

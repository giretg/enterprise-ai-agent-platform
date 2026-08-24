type WorkspaceChatChrome = {
  startNewChat: () => void
  toggleHistory: () => void
  detach: () => void
  /** Van betöltött, mentett beszélgetés-szál — a fejléc ezt kombinálja az analysis.run kapuval. */
  hasSavedConversation: boolean
  analyzeDisabled: boolean
  analyze: () => void
}

let chrome: WorkspaceChatChrome | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function registerWorkspaceChatChrome(actions: WorkspaceChatChrome) {
  chrome = actions
  emit()
}

export function clearWorkspaceChatChrome() {
  chrome = null
  emit()
}

export function getWorkspaceChatChrome(): WorkspaceChatChrome | null {
  return chrome
}

export function subscribeWorkspaceChatChrome(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function workspaceChatStartNew() {
  chrome?.startNewChat()
}

export function workspaceChatToggleHistory() {
  chrome?.toggleHistory()
}

export function workspaceChatDetach() {
  chrome?.detach()
}

export function workspaceChatAnalyze() {
  chrome?.analyze()
}

export function getWorkspaceChatAnalyzeState(): Pick<
  WorkspaceChatChrome,
  'hasSavedConversation' | 'analyzeDisabled'
> {
  return {
    hasSavedConversation: chrome?.hasSavedConversation ?? false,
    analyzeDisabled: chrome?.analyzeDisabled ?? false,
  }
}

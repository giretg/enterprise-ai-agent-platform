export type WorkspaceDistillTarget = { id: string; name: string }

type WorkspaceChatChrome = {
  startNewChat: () => void
  toggleHistory: () => void
  detach: () => void
  /** Van betöltött, mentett beszélgetés-szál — a fejléc ezt kombinálja az analysis.run kapuval. */
  hasSavedConversation: boolean
  analyzeDisabled: boolean
  analyze: () => void
  distill: () => void
  distillDisabled: boolean
  distillPending: boolean
  distillTargets: WorkspaceDistillTarget[]
  distillTargetSkillId: string
  setDistillTargetSkillId: (id: string) => void
}

const EMPTY_CHROME_STATE = {
  hasSavedConversation: false,
  analyzeDisabled: false,
  distillDisabled: true,
  distillPending: false,
  distillTargets: [] as WorkspaceDistillTarget[],
  distillTargetSkillId: '',
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

export function workspaceChatDistill() {
  chrome?.distill()
}

export function workspaceChatSetDistillTarget(id: string) {
  chrome?.setDistillTargetSkillId(id)
}

export function getWorkspaceChatChromeState(): typeof EMPTY_CHROME_STATE {
  if (!chrome) return EMPTY_CHROME_STATE
  return {
    hasSavedConversation: chrome.hasSavedConversation,
    analyzeDisabled: chrome.analyzeDisabled,
    distillDisabled: chrome.distillDisabled,
    distillPending: chrome.distillPending,
    distillTargets: chrome.distillTargets,
    distillTargetSkillId: chrome.distillTargetSkillId,
  }
}

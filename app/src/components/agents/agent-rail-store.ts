'use client'

import { useSyncExternalStore } from 'react'
import type { AgentRailFilter } from '@/lib/agent-rail-types'

export type AgentRailUiState = {
  collapsed: boolean
  filter: AgentRailFilter
  search: string
  mobileOpen: boolean
}

const DEFAULT_STATE: AgentRailUiState = {
  collapsed: false,
  filter: 'all',
  search: '',
  mobileOpen: false,
}

let state: AgentRailUiState = { ...DEFAULT_STATE }
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function getAgentRailUiState(): AgentRailUiState {
  return state
}

export function getAgentRailUiServerSnapshot(): AgentRailUiState {
  return DEFAULT_STATE
}

export function subscribeAgentRailUi(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setAgentRailCollapsed(collapsed: boolean) {
  if (state.collapsed === collapsed) return
  state = { ...state, collapsed }
  emit()
}

export function toggleAgentRailCollapsed() {
  setAgentRailCollapsed(!state.collapsed)
}

export function setAgentRailFilter(filter: AgentRailFilter) {
  if (state.filter === filter) return
  state = { ...state, filter }
  emit()
}

export function setAgentRailSearch(search: string) {
  if (state.search === search) return
  state = { ...state, search }
  emit()
}

export function setAgentRailMobileOpen(mobileOpen: boolean) {
  if (state.mobileOpen === mobileOpen) return
  state = { ...state, mobileOpen }
  emit()
}

export function useAgentRailUiState() {
  return useSyncExternalStore(
    subscribeAgentRailUi,
    getAgentRailUiState,
    getAgentRailUiServerSnapshot,
  )
}

/** Teszt / reset. */
export function resetAgentRailUiState() {
  state = { ...DEFAULT_STATE }
  emit()
}

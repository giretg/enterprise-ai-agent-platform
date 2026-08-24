'use client'

import { useSyncExternalStore } from 'react'

let panelKey: string | null = null
let dockedPanelKeys: string[] = []
const EMPTY_DOCKED_PANELS_SNAPSHOT: string[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) emitListener(listener)
}

function emitListener(listener: () => void) {
  listener()
}

function dockKey(key: string) {
  if (dockedPanelKeys.includes(key)) return
  dockedPanelKeys = [...dockedPanelKeys, key]
}

function syncUrlPanelParam(key: string | null, pathname?: string) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (key) {
    url.searchParams.set('panel', key)
    window.history.pushState({}, '', url.toString())
    return
  }
  url.searchParams.delete('panel')
  const path = pathname ?? window.location.pathname
  const next = url.searchParams.toString()
  window.history.replaceState({}, '', next ? `${path}?${next}` : path)
}

function effectivePanelKey(): string | null {
  if (panelKey) return panelKey
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('panel')
}

export function getControlPlanePanelKey(): string | null {
  return effectivePanelKey()
}

export function getControlPlanePanelServerSnapshot(): string | null {
  return null
}

export function getControlPlaneDockedPanelKeys(): string[] {
  return dockedPanelKeys
}

export function getControlPlaneDockedPanelKeysServerSnapshot(): string[] {
  return EMPTY_DOCKED_PANELS_SNAPSHOT
}

export function subscribeControlPlanePanel(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setControlPlanePanelKey(key: string | null) {
  panelKey = key
  if (key) {
    dockedPanelKeys = dockedPanelKeys.filter((item) => item !== key)
  }
  emit()
}

/** Vissza gomb / popstate — a látható panel tálcára kerül, nem dobódik el az iframe. */
export function syncControlPlanePanelFromUrl(pathname: string) {
  if (typeof window === 'undefined') return
  const urlKey = new URLSearchParams(window.location.search).get('panel')
  const current = effectivePanelKey()
  if (!urlKey && current) {
    dockKey(current)
    panelKey = null
    emit()
    return
  }
  if (urlKey) {
    dockedPanelKeys = dockedPanelKeys.filter((item) => item !== urlKey)
    panelKey = urlKey
    emit()
  }
}

/** URL + store szinkron — header gombok és sáv-műveletek. */
export function openControlPlanePanel(key: string) {
  if (typeof window === 'undefined') return
  if (panelKey && panelKey !== key) {
    dockKey(panelKey)
  }
  dockedPanelKeys = dockedPanelKeys.filter((item) => item !== key)
  panelKey = key
  syncUrlPanelParam(key)
  emit()
}

/** Modál tálcára — az iframe életben marad a háttérben. */
export function minimizeControlPlanePanel(pathname: string) {
  if (typeof window === 'undefined') return
  const key = effectivePanelKey()
  if (!key) return
  dockKey(key)
  panelKey = null
  syncUrlPanelParam(null, pathname)
  emit()
}

export function restoreControlPlanePanel(key: string) {
  if (typeof window === 'undefined') return
  if (panelKey && panelKey !== key) {
    dockKey(panelKey)
  }
  dockedPanelKeys = dockedPanelKeys.filter((item) => item !== key)
  panelKey = key
  syncUrlPanelParam(key)
  emit()
}

export function closeControlPlanePanel(pathname: string) {
  if (typeof window === 'undefined') return
  const closing = effectivePanelKey()
  panelKey = null
  if (closing) {
    dockedPanelKeys = dockedPanelKeys.filter((item) => item !== closing)
  }
  syncUrlPanelParam(null, pathname)
  emit()
}

export function closeControlPlanePanelByKey(key: string, pathname: string) {
  if (typeof window === 'undefined') return
  dockedPanelKeys = dockedPanelKeys.filter((item) => item !== key)
  if (panelKey === key) {
    panelKey = null
    syncUrlPanelParam(null, pathname)
  }
  emit()
}

export function useControlPlanePanelKey() {
  return useSyncExternalStore(
    subscribeControlPlanePanel,
    getControlPlanePanelKey,
    getControlPlanePanelServerSnapshot,
  )
}

export function useControlPlaneDockedPanelKeys() {
  return useSyncExternalStore(
    subscribeControlPlanePanel,
    getControlPlaneDockedPanelKeys,
    getControlPlaneDockedPanelKeysServerSnapshot,
  )
}

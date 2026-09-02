'use client'

import { useSyncExternalStore } from 'react'
import type { ActiveRun } from '@/lib/active-runs'

/**
 * Megosztott „élő futások” hírcsatorna a vezérlőpult-héjon belül.
 *
 * A bal oldali munkatárs-sáv (`AgentRail`) amúgy is 5 mp-enként lekéri a
 * `/api/agents/rail-state` végpontot, aminek a válasza MÁR tartalmazza a
 * bejelentkezett user élő futásait (`runs`). A fejléc „Futások” panelje
 * korábban ugyanezt az adatot egy külön `/api/v1/active-runs` pollúttal kérte
 * le — pontosan ugyanabban a ~5 mp-es ütemben. Ez a store a sáv frissítéseit
 * teszi közzé, így a panel egyetlen extra kérés nélkül, ugyanazzal a
 * frissességgel követi a futásokat.
 */
export type ActiveRunsFeed = {
  runs: ActiveRun[]
  error: string | null
  /** Az utolsó sikeres közzététel ideje (ms). `null` = még nem jött adat. */
  receivedAt: number | null
}

const EMPTY_FEED: ActiveRunsFeed = { runs: [], error: null, receivedAt: null }

let feed: ActiveRunsFeed = EMPTY_FEED
const feedListeners = new Set<() => void>()
const refreshListeners = new Set<() => void>()

function emitFeed() {
  for (const listener of feedListeners) listener()
}

/** A sáv sikeres poll-válasza után hívandó. */
export function publishActiveRunsFeed(runs: ActiveRun[]): void {
  feed = { runs, error: null, receivedAt: Date.now() }
  emitFeed()
}

/** A sáv poll-hibája után hívandó — a legutóbbi futáslista megmarad. */
export function publishActiveRunsFeedError(message: string): void {
  if (feed.error === message) return
  feed = { ...feed, error: message }
  emitFeed()
}

export function getActiveRunsFeed(): ActiveRunsFeed {
  return feed
}

function getActiveRunsFeedServerSnapshot(): ActiveRunsFeed {
  return EMPTY_FEED
}

export function subscribeActiveRunsFeed(listener: () => void): () => void {
  feedListeners.add(listener)
  return () => {
    feedListeners.delete(listener)
  }
}

export function useActiveRunsFeed(): ActiveRunsFeed {
  return useSyncExternalStore(
    subscribeActiveRunsFeed,
    getActiveRunsFeed,
    getActiveRunsFeedServerSnapshot,
  )
}

/**
 * Azonnali sáv-frissítés kérése (pl. a panel megnyitásakor, vagy egy futás
 * leállítása/indítása után) — a következő ütemezett poll-t nem várjuk meg.
 * A `AgentRail` regisztrálja ide a `refresh` visszahívását.
 */
export function subscribeActiveRunsRefresh(listener: () => void): () => void {
  refreshListeners.add(listener)
  return () => {
    refreshListeners.delete(listener)
  }
}

export function requestActiveRunsRefresh(): void {
  for (const listener of refreshListeners) listener()
}

/** Teszt / reset. */
export function resetActiveRunsFeed(): void {
  feed = EMPTY_FEED
  feedListeners.clear()
  refreshListeners.clear()
}

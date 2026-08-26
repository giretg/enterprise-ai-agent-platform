'use client'

import { useSyncExternalStore } from 'react'
import type { ChangeSummary, ImpactResult } from '@/domain/training/training-composition'

export type TrainingPreviewState = {
  previewId: string
  proposedVersion: string
  changeSummary: ChangeSummary
  impactResult: ImpactResult
}

type Session = {
  preview: TrainingPreviewState | null
  error: string | null
  draft: string
}

const EMPTY_SESSION: Session = { preview: null, error: null, draft: '' }
const sessions = new Map<string, Session>()
const listeners = new Set<() => void>()
const STORAGE_PREFIX = 'eaap.trainingPreview.'

function emit() {
  for (const listener of listeners) listener()
}

function storageKey(agentId: string) {
  return `${STORAGE_PREFIX}${agentId}`
}

function canUseSessionStorage() {
  return typeof sessionStorage !== 'undefined'
}

function readPersisted(agentId: string): Session | null {
  if (!canUseSessionStorage()) return null
  try {
    const raw = sessionStorage.getItem(storageKey(agentId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Session>
    return {
      preview: previewStateFromActionData(parsed.preview),
      error: typeof parsed.error === 'string' ? parsed.error : null,
      draft: typeof parsed.draft === 'string' ? parsed.draft : '',
    }
  } catch {
    return null
  }
}

function persist(agentId: string, session: Session) {
  if (!canUseSessionStorage()) return
  try {
    if (!session.preview && !session.error && !session.draft) {
      sessionStorage.removeItem(storageKey(agentId))
    } else {
      sessionStorage.setItem(storageKey(agentId), JSON.stringify(session))
    }
  } catch {
    // privát mód / kvóta — a memóriabeli session ettől még él
  }
}

export function subscribeTrainingPreview(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function readTrainingPreviewSession(agentId: string): Session {
  const live = sessions.get(agentId)
  if (live) return live
  const persisted = readPersisted(agentId)
  if (!persisted) return EMPTY_SESSION
  sessions.set(agentId, persisted)
  return persisted
}

export function writeTrainingPreviewSession(agentId: string, patch: Partial<Session>) {
  if (!agentId) return
  const prev = readTrainingPreviewSession(agentId)
  const session: Session = {
    preview: patch.preview === undefined ? prev.preview : patch.preview,
    error: patch.error === undefined ? prev.error : patch.error,
    draft: patch.draft === undefined ? prev.draft : patch.draft,
  }
  if (!session.preview && !session.error && !session.draft) sessions.delete(agentId)
  else sessions.set(agentId, session)
  persist(agentId, session)
  emit()
}

export function clearTrainingPreviewSession(agentId: string) {
  writeTrainingPreviewSession(agentId, { preview: null, error: null, draft: '' })
}

/** Teszt: memóriabeli Map ürítése, sessionStorage megmarad (oldalfrissítés). */
export function forgetTrainingPreviewMemory() {
  sessions.clear()
}

export function serverTrainingPreviewSnapshot(): Session {
  return EMPTY_SESSION
}

export function useTrainingPreviewSession(agentId: string) {
  return useSyncExternalStore(
    subscribeTrainingPreview,
    () => readTrainingPreviewSession(agentId),
    serverTrainingPreviewSnapshot,
  )
}

export function previewStateFromActionData(data: unknown): TrainingPreviewState | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  if (typeof row.previewId !== 'string' || row.previewId.length === 0) return null
  if (typeof row.proposedVersion !== 'string') return null
  if (!row.changeSummary || typeof row.changeSummary !== 'object') return null
  if (!row.impactResult || typeof row.impactResult !== 'object') return null
  const changeSummary = row.changeSummary as ChangeSummary
  const impactResult = row.impactResult as ImpactResult
  if (!Array.isArray(changeSummary.added) || !Array.isArray(changeSummary.removed)) return null
  if (!Array.isArray(changeSummary.rewritten)) return null
  if (typeof impactResult.verdict !== 'string') return null
  return {
    previewId: row.previewId,
    proposedVersion: row.proposedVersion,
    changeSummary,
    impactResult,
  }
}

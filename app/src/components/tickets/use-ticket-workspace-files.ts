'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  shouldPollTicketWorkspaceFiles,
  ticketWorkspaceFilesUrl,
} from '@/lib/ticket-workspace-files-client'

const LIVE_POLL_MS = 2_000

/**
 * Ticket workspace-fájlok: újratöltés ticket-azonosító VAGY állapotváltáskor
 * (in_progress → done), és csendes poll élő futás alatt.
 *
 * A `router.refresh()` frissíti a szerver-propokat (válasz, állapot), de a
 * kliens-oldali fájllista ettől nem töltődik újra — ezért kell a state a
 * függőségbe, különben a kész DOCX a panelen és a szálban is láthatatlan marad.
 */
export function useTicketWorkspaceFiles(ticketId: string, ticketState: string) {
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const listUrl = ticketWorkspaceFilesUrl(ticketId)

  const loadFiles = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true)
      setError(null)
    }
    try {
      const res = await fetch(listUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { success: boolean; data?: { files: string[] } }
      setFiles(json.data?.files ?? [])
    } catch (e) {
      if (!quiet) {
        setError(e instanceof Error ? e.message : 'Nem sikerült betölteni a fájlokat')
      }
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [listUrl])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadFiles()
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [loadFiles, ticketState])

  useEffect(() => {
    if (!shouldPollTicketWorkspaceFiles(ticketState)) return
    const timer = window.setInterval(() => {
      void loadFiles(true)
    }, LIVE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [loadFiles, ticketState])

  return { files, loading, error, reload: loadFiles, listUrl }
}

'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { dispatchBoardTicket } from '@/app/actions/platform'

export type TicketDispatchClientResult =
  | { success: true; warning: string | null }
  | { success: false; error: string }

async function requestTicketDispatch(
  ticketId: string,
): Promise<TicketDispatchClientResult> {
  try {
    const result = await dispatchBoardTicket({ ticketId })
    if (!result.success) return { success: false, error: result.error }

    const warning =
      'warning' in result.data && typeof result.data.warning === 'string'
        ? result.data.warning
        : null
    return { success: true, warning }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'A feldolgozás indítása sikertelen.',
    }
  }
}

export function useTicketDispatch() {
  const router = useRouter()

  return useCallback(
    async (ticketId: string) => {
      const result = await requestTicketDispatch(ticketId)
      if (result.success) router.refresh()
      return result
    },
    [router],
  )
}

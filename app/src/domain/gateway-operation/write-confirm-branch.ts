import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server'
import type { WriteConfirmInput } from '@/domain/enterprise-tools'
import type { GatewayOperationView } from './types'

export const MRTR_PROTOCOL_VERSION = '2026-07-28'

/** Why the MCP client got a link instead of the in-chat form (#618). */
export type WriteConfirmLinkReason =
  | 'no_request_state_key'
  | 'protocol_not_2026_07_28'
  | 'elicitation_url_only'
  | 'no_form_elicitation'

export type WriteConfirmOffer = {
  confirmBranch: 'form' | 'link'
  confirmBranchReason: WriteConfirmLinkReason | 'mrtr_form' | 'not_awaiting_approval' | 'enqueue_failed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Client envelope → link reason when `mint` is off (mcp-server passes `hasCodec`). */
export function writeConfirmLinkReason(
  envelope: Record<string, unknown>,
  hasCodec: boolean,
): WriteConfirmLinkReason {
  if (!hasCodec) return 'no_request_state_key'
  if (envelope[PROTOCOL_VERSION_META_KEY] !== MRTR_PROTOCOL_VERSION) return 'protocol_not_2026_07_28'
  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY]
  const elicitation = isRecord(capabilities) ? capabilities.elicitation : undefined
  if (!isRecord(elicitation)) return 'no_form_elicitation'
  if ('url' in elicitation && !('form' in elicitation)) return 'elicitation_url_only'
  return 'no_form_elicitation'
}

export function formElicitationCapable(envelope: Record<string, unknown>): boolean {
  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY]
  const elicitation = isRecord(capabilities) ? capabilities.elicitation : undefined
  return (
    envelope[PROTOCOL_VERSION_META_KEY] === MRTR_PROTOCOL_VERSION &&
    isRecord(elicitation) &&
    ('form' in elicitation || !('url' in elicitation))
  )
}

/** What the MCP layer offered after enqueue (audit on `gateway.operation.enqueued`). */
export function resolveWriteConfirmOffer(
  confirm: WriteConfirmInput | undefined,
  enqueued: { ok: false } | { ok: true; view: GatewayOperationView },
): WriteConfirmOffer | null {
  if (!confirm) return null
  if (!enqueued.ok) return { confirmBranch: 'link', confirmBranchReason: 'enqueue_failed' }
  if (enqueued.view.status !== 'awaiting_approval') {
    return { confirmBranch: 'link', confirmBranchReason: 'not_awaiting_approval' }
  }
  if (confirm.mint) return { confirmBranch: 'form', confirmBranchReason: 'mrtr_form' }
  return {
    confirmBranch: 'link',
    confirmBranchReason: confirm.linkReason ?? 'no_form_elicitation',
  }
}

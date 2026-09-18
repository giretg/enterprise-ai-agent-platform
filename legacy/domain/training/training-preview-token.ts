/**
 * Mellékhatásmentes tanítási előnézet — HMAC-aláírt, rövid életű token.
 * A nyers tartalom a tokenben utazik, nincs preview-tábla; a submit
 * a tokenből olvassa vissza a javasolt teljes verziót.
 */
import { createHmac, timingSafeEqual } from 'crypto'
import { resolveSecret } from '@/lib/crypto/secret-resolver'
import type { ChangeSummary, ImpactResult, TrainingCompositionMode, TrainingInstruction } from './training-composition'

const PREVIEW_SECRET = resolveSecret(
  ['TRAINING_PREVIEW_SECRET', 'WRITE_GATE_SECRET'],
  'dev-training-preview-secret-change-in-prod',
)

export const TRAINING_PREVIEW_TTL_MS = 30 * 60 * 1000

export type TrainingPreviewPayload = {
  agentId: string
  actorId: string
  tenantId: string
  baseVersionId: string | null
  proposedVersion: string
  compositionMode: TrainingCompositionMode | null
  instruction: TrainingInstruction
  changeSummary: ChangeSummary
  impactResult: ImpactResult
  exp: number
}

export class TrainingPreviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TrainingPreviewError'
  }
}

function sign(encoded: string): string {
  return createHmac('sha256', PREVIEW_SECRET).update(encoded).digest('base64url')
}

export function signTrainingPreview(payload: Omit<TrainingPreviewPayload, 'exp'> & { exp?: number }): string {
  const full: TrainingPreviewPayload = {
    ...payload,
    exp: payload.exp ?? Date.now() + TRAINING_PREVIEW_TTL_MS,
  }
  const encoded = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
  return `${encoded}.${sign(encoded)}`
}

export function verifyTrainingPreview(token: string, now = Date.now()): TrainingPreviewPayload {
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) throw new TrainingPreviewError('preview token malformed')

  const expected = Buffer.from(sign(encoded))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new TrainingPreviewError('preview token signature invalid')
  }

  let payload: TrainingPreviewPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TrainingPreviewPayload
  } catch {
    throw new TrainingPreviewError('preview token payload invalid')
  }

  if (typeof payload.exp !== 'number' || payload.exp < now) {
    throw new TrainingPreviewError('Az előnézet lejárt — nézd meg újra, mit változtat a tanítás')
  }
  if (!payload.agentId || !payload.actorId || !payload.tenantId || typeof payload.proposedVersion !== 'string') {
    throw new TrainingPreviewError('preview token payload invalid')
  }
  return payload
}

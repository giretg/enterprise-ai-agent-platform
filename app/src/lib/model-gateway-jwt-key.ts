/**
 * Platform MODEL_GATEWAY_JWT_KEY: egy aláíró kulcs az összes tenant gateway-tokenjére.
 * Tenant-szintű nem lehet — a tokent előbb kell ellenőrizni, mint kiderülne a tenant.
 * Tároló: ugyanaz a connector-titoktár; SM id: `connector-key-model-gateway-jwt`.
 */
import { randomBytes } from 'node:crypto'
import {
  buildConnectorSecretRef,
  ConnectorApiKeyMissingError,
  loadConnectorApiKeyByRef,
  saveConnectorApiKey,
} from '@/domain/connector/connector-secret-store'

export const MODEL_GATEWAY_JWT_SECRET_ID = 'model-gateway-jwt'
const MIN_KEY_LENGTH = 32
const CACHE_MS = 60_000

let memo: { value: string; at: number } | null = null

export function parseModelGatewayJwtKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('invalid_jwt_key')
  const key = raw.trim()
  if (key.length < MIN_KEY_LENGTH || key.length > 500) throw new Error('invalid_jwt_key')
  return key
}

export function generateModelGatewayJwtKey(): string {
  return randomBytes(32).toString('base64url')
}

export function forgetModelGatewayJwtKeyCache(): void {
  memo = null
}

export async function loadModelGatewayJwtKeyFromStore(): Promise<string | null> {
  try {
    const key = await loadConnectorApiKeyByRef(buildConnectorSecretRef(MODEL_GATEWAY_JWT_SECRET_ID))
    const trimmed = key.trim()
    return trimmed.length >= MIN_KEY_LENGTH ? trimmed : null
  } catch (e) {
    if (e instanceof ConnectorApiKeyMissingError) return null
    throw e
  }
}

export async function saveModelGatewayJwtKey(raw: string): Promise<void> {
  await saveConnectorApiKey(MODEL_GATEWAY_JWT_SECRET_ID, parseModelGatewayJwtKey(raw))
  memo = null
}

/** Titoktár nyer; ha nincs, a platform `MODEL_GATEWAY_JWT_KEY` env. */
export async function resolveModelGatewayJwtKey(
  env: Record<string, string | undefined> = process.env,
  loadStored: () => Promise<string | null> = loadModelGatewayJwtKeyFromStore,
): Promise<string | null> {
  if (loadStored === loadModelGatewayJwtKeyFromStore && memo && Date.now() - memo.at < CACHE_MS) {
    return memo.value
  }
  const stored = await loadStored()
  const envKey = env.MODEL_GATEWAY_JWT_KEY?.trim()
  const value =
    stored ?? (envKey && envKey.length >= MIN_KEY_LENGTH ? envKey : null)
  if (value && loadStored === loadModelGatewayJwtKeyFromStore) memo = { value, at: Date.now() }
  return value
}

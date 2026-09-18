/**
 * PlaybookPack — WP-6 export/import (Governed Flow Builder spec §9, D9).
 *
 * Saját, contentHash-elt envelope (NEM a connector-export kiterjesztése). A pack
 * szuperhalmaz: playbook(ok) + StepTemplate + connector-template + eval + demo + doc.
 * A connector-szekció a MEGLÉVŐ connector-template descriptor alakot használja újra.
 *
 * KOCKÁZAT-MITIGÁCIÓ (D9 / §9): a pack CSAK template-et tartalmazhat — secret,
 * connector-grant, role-binding SOHA nem utazik a packben. Az import determinisztikusan
 * elutasítja, ha tiltott (secret/grant/binding) mezőt talál. Az import SOHA nem élesít
 * automatikusan — a tenant-specifikus értékek import után kitöltendő configként jelennek meg.
 */
import { computePlaybookContentHash, type PlaybookSpecV2 } from '@/lib/playbook-v2/spec'
import { createHash } from 'crypto'

export const PLAYBOOK_PACK_SCHEMA_VERSION = '1.0' as const

export type PackPlaybookEntry = {
  key: string
  name: string
  spec: PlaybookSpecV2
  contentHash?: string
}

export type PackStepTemplateEntry = {
  key: string
  name: string
  fragment: unknown
  contentHash?: string
}

export type PackConnectorTemplateEntry = {
  /** A MEGLÉVŐ connector-template descriptor (template-descriptor.ts alak). */
  descriptor: unknown
  contentHash?: string
}

export type PackMetadata = {
  title: string
  author: string
  description?: string
  createdAt?: string
}

export type PlaybookPack = {
  schemaVersion: typeof PLAYBOOK_PACK_SCHEMA_VERSION
  metadata: PackMetadata
  playbooks: Required<PackPlaybookEntry>[]
  stepTemplates: Required<PackStepTemplateEntry>[]
  connectorTemplates: Required<PackConnectorTemplateEntry>[]
  /** Opcionális demo input-payloadok és dokumentáció (nem tartalmaz secretet). */
  demoInputs?: Record<string, unknown>[]
  docs?: string
  /** A teljes envelope tartalom-hash-e (a metadata kivételével a szekciókból). */
  contentHash: string
}

/** A packben SOHA nem szerepelhet tenant-titok — ezekre az import hibát dob. */
const FORBIDDEN_TOP_LEVEL_KEYS = ['secrets', 'grants', 'roleBindings', 'connectorGrants', 'credentials']

function hashOf(value: unknown): string {
  const canonical = JSON.stringify(canon(value))
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon)
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return Object.keys(o)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canon(o[k])
        return acc
      }, {})
  }
  return value
}

export type ExportPlaybookPackInput = {
  playbooks: PackPlaybookEntry[]
  stepTemplates?: PackStepTemplateEntry[]
  connectorTemplates?: PackConnectorTemplateEntry[]
  demoInputs?: Record<string, unknown>[]
  docs?: string
  metadata: PackMetadata
}

export function exportPlaybookPack(input: ExportPlaybookPackInput): PlaybookPack {
  const playbooks = input.playbooks.map((p) => ({
    key: p.key,
    name: p.name,
    spec: p.spec,
    contentHash: computePlaybookContentHash(p.spec),
  }))
  const stepTemplates = (input.stepTemplates ?? []).map((t) => ({
    key: t.key,
    name: t.name,
    fragment: t.fragment,
    contentHash: hashOf(t.fragment),
  }))
  const connectorTemplates = (input.connectorTemplates ?? []).map((c) => ({
    descriptor: c.descriptor,
    contentHash: hashOf(c.descriptor),
  }))

  const body = { playbooks, stepTemplates, connectorTemplates, demoInputs: input.demoInputs ?? [], docs: input.docs ?? '' }
  return {
    schemaVersion: PLAYBOOK_PACK_SCHEMA_VERSION,
    metadata: { ...input.metadata, createdAt: input.metadata.createdAt ?? new Date().toISOString() },
    playbooks,
    stepTemplates,
    connectorTemplates,
    demoInputs: input.demoInputs,
    docs: input.docs,
    contentHash: hashOf(body),
  }
}

export type ImportedPlaybookPack = {
  valid: boolean
  errors: string[]
  warnings: string[]
  metadata: PackMetadata | null
  playbooks: Array<{ key: string; name: string; spec: PlaybookSpecV2; contentHash: string; hashOk: boolean }>
  stepTemplates: Array<{ key: string; name: string; fragment: unknown; contentHash: string; hashOk: boolean }>
  connectorTemplates: Array<{ descriptor: unknown; contentHash: string; hashOk: boolean }>
}

/**
 * Import — VALIDÁL, nem élesít (D9 / §9). Ellenőrzi az envelope-alakot, a per-szekció
 * contentHash-eket, és ELUTASÍTJA a tiltott (secret/grant/binding) mezőket. A tenant-
 * specifikus értékek kitöltése az import-wizard következő lépése (nem a pack tartalma).
 */
export function importPlaybookPack(raw: unknown): ImportedPlaybookPack {
  const errors: string[] = []
  const warnings: string[] = []
  const empty: ImportedPlaybookPack = {
    valid: false,
    errors,
    warnings,
    metadata: null,
    playbooks: [],
    stepTemplates: [],
    connectorTemplates: [],
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('A pack nem objektum.')
    return empty
  }
  const pack = raw as Record<string, unknown>

  // Biztonsági kapu: tiltott top-level mezők (secret/grant szivárgás).
  for (const key of FORBIDDEN_TOP_LEVEL_KEYS) {
    if (key in pack) {
      errors.push(
        `Tiltott mező a packben: '${key}'. A pack CSAK template-et tartalmazhat — secret/grant/binding sosem utazik a packben.`,
      )
    }
  }
  if (pack.schemaVersion !== PLAYBOOK_PACK_SCHEMA_VERSION) {
    errors.push(`Ismeretlen pack schemaVersion: ${String(pack.schemaVersion)}.`)
  }

  const metadata = (pack.metadata as PackMetadata | undefined) ?? null
  if (!metadata || typeof metadata.title !== 'string' || typeof metadata.author !== 'string') {
    errors.push('Hiányzó vagy hibás metadata (title/author kötelező).')
  }

  const playbooks: ImportedPlaybookPack['playbooks'] = []
  for (const entry of Array.isArray(pack.playbooks) ? pack.playbooks : []) {
    const e = entry as PackPlaybookEntry
    if (!e || typeof e.key !== 'string' || e.spec == null) {
      errors.push('Hibás playbook-bejegyzés a packben.')
      continue
    }
    const recomputed = computePlaybookContentHash(e.spec)
    const hashOk = e.contentHash == null || e.contentHash === recomputed
    if (!hashOk) {
      errors.push(`A(z) '${e.key}' playbook contentHash-e nem egyezik (sérült pack).`)
    }
    playbooks.push({
      key: e.key,
      name: e.name ?? e.key,
      spec: e.spec,
      contentHash: recomputed,
      hashOk,
    })
  }
  if (playbooks.length === 0) {
    errors.push('A pack nem tartalmaz playbookot.')
  }

  const stepTemplates: ImportedPlaybookPack['stepTemplates'] = []
  for (const entry of Array.isArray(pack.stepTemplates) ? pack.stepTemplates : []) {
    const e = entry as PackStepTemplateEntry
    if (!e || typeof e.key !== 'string') {
      warnings.push('Hibás step-template bejegyzés (kihagyva).')
      continue
    }
    const recomputed = hashOf(e.fragment)
    stepTemplates.push({
      key: e.key,
      name: e.name ?? e.key,
      fragment: e.fragment,
      contentHash: recomputed,
      hashOk: e.contentHash == null || e.contentHash === recomputed,
    })
  }

  const connectorTemplates: ImportedPlaybookPack['connectorTemplates'] = []
  for (const entry of Array.isArray(pack.connectorTemplates) ? pack.connectorTemplates : []) {
    const e = entry as PackConnectorTemplateEntry
    if (!e || e.descriptor == null) {
      warnings.push('Hibás connector-template bejegyzés (kihagyva).')
      continue
    }
    const recomputed = hashOf(e.descriptor)
    connectorTemplates.push({
      descriptor: e.descriptor,
      contentHash: recomputed,
      hashOk: e.contentHash == null || e.contentHash === recomputed,
    })
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    metadata,
    playbooks,
    stepTemplates,
    connectorTemplates,
  }
}

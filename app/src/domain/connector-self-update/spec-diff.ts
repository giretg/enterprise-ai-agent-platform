/**
 * Önfrissítő connector — capability-diff-motor (Dev-Spec §6, A2).
 *
 * A diff a spec SZÍVE: nem szövegdiffet, hanem CAPABILITY-szintű, kategorizált
 * változást ad, a használati kontextussal együtt ("mi változott ÉS ki használja").
 * Ez teszi az "egy gombot" biztonságossá — a jóváhagyó sosem vakon dönt.
 *
 * TISZTA modul: nincs DB, nincs hálózat. A "ki használja" visszakeresést a hívó
 * `usedByResolver`-ként injektálja (WP-4/WP-3 a repository-ból); a determinisztikus
 * teszt stubbal hívja.
 *
 * Kategóriák (§6):
 *  - added    : új végpont / új opcionális képesség — Alacsony kockázat (D5 auto-jelölt)
 *  - breaking : MOST HASZNÁLT végpont eltűnt, vagy paraméter kötelezővé/típusban változott — Magas
 *  - narrowed : a partner elvett egy végpontot, amit NEM használunk aktívan — Közepes
 *  - auth     : auth-mód változott, vagy egy fejléc kötelezővé vált (pl. Idempotency-Key) — Magas
 */
import type { CapabilitySet, OpKey } from './capability-set'
import { indexCapabilities } from './capability-set'
import type { ProposedTool } from '@/domain/provisioning/connector-config'

export type UsageRef = {
  type: 'agent' | 'playbook' | 'process'
  name: string
  id: string
}

/** Egy capability-t "használó" élő entitások visszakeresése (A2). Fail-open a diffre:
 * ha nincs resolver, üres listát adunk (de a kategorizálás akkor is helyes marad). */
export type UsedByResolver = (op: OpKey) => UsageRef[]

export type DiffRisk = 'low' | 'medium' | 'high'

export type DiffOp = {
  /** `"METHOD /path"` — a §6 példával egyező, ember- és gép-olvasható azonosító. */
  op: OpKey
  risk: DiffRisk
  /** Gépi változás-leírás, pl. `"removed"`, `"header_now_required: Idempotency-Key"`. */
  change?: string
  /** Auth-scope, pl. `"POST /*"` vagy egy konkrét op. */
  scope?: string
  /** A2: mely élő agent/Playbook/folyamat támaszkodik erre a capability-re. */
  usedBy?: UsageRef[]
}

export type CapabilityDiff = {
  added: DiffOp[]
  breaking: DiffOp[]
  narrowed: DiffOp[]
  auth: DiffOp[]
  /** Legalább egy tétel bármely kategóriában. */
  hasChanges: boolean
  /** A legmagasabb kockázat a teljes diffben (UI szín + kapu-döntés inputja). */
  highestRisk: DiffRisk | 'none'
}

function accessOf(tool: ProposedTool): 'read' | 'write' {
  return tool.access
}

function parameterIndex(tool: ProposedTool) {
  return new Map((tool.parameters ?? []).map((param) => [`${param.in}:${param.name.toLowerCase()}`, param]))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'secretAliasSuggested')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** A használók listája — üres tömb helyett `undefined`, hogy a JSON tömör maradjon. */
function usedBy(resolver: UsedByResolver | undefined, op: OpKey): UsageRef[] | undefined {
  if (!resolver) return undefined
  const refs = resolver(op)
  return refs.length > 0 ? refs : undefined
}

/**
 * Két capability-set közti kategorizált diff. `current` lehet `null` (első rögzítés):
 * ilyenkor MINDEN végpont `added` (a legelső jóváhagyás nem "változás", hanem alapállapot).
 */
export function computeCapabilityDiff(
  current: CapabilitySet | null,
  next: CapabilitySet,
  usedByResolver?: UsedByResolver,
): CapabilityDiff {
  const added: DiffOp[] = []
  const breaking: DiffOp[] = []
  const narrowed: DiffOp[] = []
  const auth: DiffOp[] = []

  const nextIndex = indexCapabilities(next)

  if (current === null) {
    for (const [op, tool] of nextIndex) {
      added.push({ op, risk: 'low', change: accessOf(tool) === 'write' ? 'added_write' : 'added' })
    }
    // Az első verzió sem vak blob-jóváhagyás: a kulcs célhostja és az auth mód
    // explicit, magas kockázatú tételként jelenik meg a jóváhagyónak.
    auth.push({
      op: 'AUTH *', risk: 'high', scope: '*',
      change: `initial_auth_mode: ${next.auth.type}/${next.authMode}`,
    })
    auth.push({
      op: 'AUTH *', risk: 'high', scope: '*',
      change: `initial_base_url: ${next.baseUrl}`,
    })
    auth.push({
      op: 'AUTH *', risk: 'high', scope: '*',
      change: `initial_egress_hosts: ${next.egressHosts.map((host) => host.toLowerCase()).sort().join(',')}`,
    })
    return finalize({ added, breaking, narrowed, auth })
  }

  const currentIndex = indexCapabilities(current)

  // 1) Eltűnt végpontok: HASZNÁLT → breaking (magas), nem használt → narrowed (közepes).
  for (const [op] of currentIndex) {
    if (nextIndex.has(op)) continue
    const refs = usedBy(usedByResolver, op)
    if (refs && refs.length > 0) {
      breaking.push({ op, risk: 'high', change: 'removed', usedBy: refs })
    } else {
      narrowed.push({ op, risk: 'medium', change: 'removed' })
    }
  }

  // 2) Új végpontok: additív (alacsony).
  for (const [op, tool] of nextIndex) {
    if (currentIndex.has(op)) continue
    added.push({ op, risk: 'low', change: accessOf(tool) === 'write' ? 'added_write' : 'added' })
  }

  // 3) Megmaradt végpontok mezőváltozásai.
  for (const [op, nextTool] of nextIndex) {
    const currentTool = currentIndex.get(op)
    if (!currentTool) continue

    // 3a) Egy fejléc kötelezővé vált (Idempotency-Key) → AUTH kategória (magas).
    //     A runtime ekkor minden írási híváshoz kötelezően fejlécet injektál — ha egy
    //     folyamat erre nem készült fel, az érintheti. A használók listáját is hozzuk.
    if (nextTool.idempotent === true && currentTool.idempotent !== true) {
      auth.push({
        op,
        risk: 'high',
        change: 'header_now_required: Idempotency-Key',
        scope: op,
        usedBy: usedBy(usedByResolver, op),
      })
    }

    // 3b) A hozzáférési szint szigorodott (read → write) — a partner ugyanazt az utat
    //     most mutálóként deklarálja. Törésveszélyes a rá épülő folyamatokra (magas).
    if (accessOf(currentTool) === 'read' && accessOf(nextTool) === 'write') {
      breaking.push({
        op,
        risk: 'high',
        change: 'access_narrowed: read_to_write',
        usedBy: usedBy(usedByResolver, op),
      })
    }

    const currentPagination = currentTool.pagination
    const nextPagination = nextTool.pagination
    if (canonicalJson(currentPagination) !== canonicalJson(nextPagination)) {
      if (!currentPagination && nextPagination) {
        added.push({ op, risk: 'low', change: 'pagination_declared' })
      } else {
        breaking.push({
          op,
          risk: 'high',
          change: 'pagination_changed',
          usedBy: usedBy(usedByResolver, op),
        })
      }
    }


    // 3c) Paraméter-kontraktus: új kötelező vagy típusváltozás breaking;
    // opcionális bővítés additív; eltűnés használattól függően breaking/narrowed.
    const currentParams = parameterIndex(currentTool)
    const nextParams = parameterIndex(nextTool)
    for (const [key, nextParam] of nextParams) {
      const currentParam = currentParams.get(key)
      const label = `${nextParam.in} ${nextParam.name}`
      if (!currentParam) {
        const item: DiffOp = {
          op,
          risk: nextParam.required ? 'high' : 'low',
          change: nextParam.required
            ? `required_param_added: ${label}`
            : `optional_param_added${nextTool.access === 'write' ? '_write' : ''}: ${label}`,
          usedBy: nextParam.required ? usedBy(usedByResolver, op) : undefined,
        }
        if (nextParam.required) breaking.push(item)
        else added.push(item)
        continue
      }
      if (currentParam.type !== nextParam.type) {
        breaking.push({
          op,
          risk: 'high',
          change: `param_type_changed: ${label} (${currentParam.type} -> ${nextParam.type})`,
          usedBy: usedBy(usedByResolver, op),
        })
      }
      if (!currentParam.required && nextParam.required) {
        breaking.push({ op, risk: 'high', change: `param_now_required: ${label}`, usedBy: usedBy(usedByResolver, op) })
      } else if (currentParam.required && !nextParam.required) {
        added.push({ op, risk: 'low', change: `required_param_relaxed: ${label}` })
      }
    }
    for (const [key, currentParam] of currentParams) {
      if (nextParams.has(key)) continue
      const refs = usedBy(usedByResolver, op)
      const item: DiffOp = { op, risk: refs?.length ? 'high' : 'medium', change: `param_removed: ${currentParam.in} ${currentParam.name}`, usedBy: refs }
      if (refs?.length) breaking.push(item)
      else narrowed.push(item)
    }
  }

  // 4) Kapcsolat-szintű auth-mód váltás (pl. bearer_token → oauth2) → AUTH (magas, teljes scope).
  if (canonicalJson(current.auth) !== canonicalJson(next.auth) || current.authMode !== next.authMode) {
    auth.push({
      op: 'AUTH *',
      risk: 'high',
      change: `auth_config_changed: ${current.auth?.type ?? '?'}/${current.authMode} -> ${next.auth?.type ?? '?'}/${next.authMode}`,
      scope: '*',
    })
  }

  // A partner cél-hostjának változása kulcs-exfiltrációs kockázat: sosem lehet
  // additív/no-change és sosem mehet automatikusan emberi kapu nélkül.
  if (current.baseUrl !== next.baseUrl) {
    auth.push({
      op: 'AUTH *',
      risk: 'high',
      change: `base_url_changed: ${current.baseUrl} -> ${next.baseUrl}`,
      scope: '*',
    })
  }
  const currentHosts = [...current.egressHosts].map((host) => host.toLowerCase()).sort()
  const nextHosts = [...next.egressHosts].map((host) => host.toLowerCase()).sort()
  if (JSON.stringify(currentHosts) !== JSON.stringify(nextHosts)) {
    auth.push({
      op: 'AUTH *',
      risk: 'high',
      change: `egress_hosts_changed: ${currentHosts.join(',')} -> ${nextHosts.join(',')}`,
      scope: '*',
    })
  }

  return finalize({ added, breaking, narrowed, auth })
}

function finalize(parts: {
  added: DiffOp[]
  breaking: DiffOp[]
  narrowed: DiffOp[]
  auth: DiffOp[]
}): CapabilityDiff {
  const hasChanges =
    parts.added.length > 0 ||
    parts.breaking.length > 0 ||
    parts.narrowed.length > 0 ||
    parts.auth.length > 0

  let highest: DiffRisk | 'none' = 'none'
  const bump = (r: DiffRisk) => {
    const order: Record<DiffRisk, number> = { low: 1, medium: 2, high: 3 }
    if (highest === 'none' || order[r] > order[highest as DiffRisk]) highest = r
  }
  for (const list of [parts.added, parts.breaking, parts.narrowed, parts.auth]) {
    for (const item of list) bump(item.risk)
  }

  return { ...parts, hasChanges, highestRisk: highest }
}

// ── Auto-jóváhagyás (D5/T4) ─────────────────────────────────────────────────
// Alapból MINDEN változás emberi kapun megy át. Az auto-jóváhagyás csak TISZTÁN
// additív, READ-ONLY változásra engedhető, és csak ha a tenant explicit engedélyezte.
export type AutoApprovePolicy = {
  /** Tenant opt-in (T4). Ha false/undefined → semmi sem auto-jóváhagyható. */
  enabled?: boolean
  /** Ha true, az additív WRITE végpontok is auto-mehetnek (alapból NEM). */
  allowAddedWrite?: boolean
}

/**
 * Igaz, ha a diff a policy szerint emberi kapu NÉLKÜL is jóváhagyható (D5).
 * Konzervatív: bármely breaking/narrowed/auth tétel → mindig emberi kapu.
 */
export function isAutoApprovable(diff: CapabilityDiff, policy: AutoApprovePolicy | null | undefined): boolean {
  if (!policy?.enabled) return false
  if (diff.breaking.length > 0 || diff.narrowed.length > 0 || diff.auth.length > 0) return false
  if (!diff.hasChanges) return true // nincs változás — nincs mit kapuzni
  if (!policy.allowAddedWrite) {
    const hasWrite = diff.added.some((d) => d.change === 'added_write' || d.change?.startsWith('optional_param_added_write:'))
    if (hasWrite) return false
  }
  return true
}

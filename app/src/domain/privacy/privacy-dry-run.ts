/**
 * APG-14 dry-run teszter: begépelt szövegre megmutatja, mit pszeudonimizálna
 * a rendszer — élő modellhívás és vault-írás nélkül.
 *
 * A találatok a meglévő `inspectPromptSensitivity` osztályozóból jönnek
 * (spec §14). Az álnév-előnézet csak kijelzés: nem allokál, nem perzisztál.
 */
import { inspectPromptSensitivity } from '@/domain/gateway/sensitivity-router'
import {
  actionForPrivacyCategory,
  canonicalPrivacyCategory,
  type PrivacyCategoryAction,
  type ResolvedPrivacyCategoryPolicy,
} from '@/domain/privacy/privacy-category-policy'
import { PRIVACY_ACTION_LABELS, PRIVACY_CATEGORY_LABELS } from '@/domain/privacy/privacy-admin-copy'
import type { PrivacyGatewayMode } from '@/domain/privacy/privacy-mode'
import { formatSurrogate, isSurrogateEntityType } from '@/domain/privacy/surrogate-format'

const PREVIEW_LABEL: Record<string, string> = {
  company: 'COMPANY',
  person: 'PERSON',
  email: 'EMAIL',
  phone: 'PHONE',
  account: 'ACCOUNT',
  taj: 'TAJ',
  adoszam: 'ADOSZAM',
  pan: 'CARD',
  iban: 'IBAN',
  secret_key: 'SECRET',
  card_broad: 'CARD',
}

export type PrivacyDryRunHit = {
  category: string
  categoryLabel: string
  snippet: string
  action: PrivacyCategoryAction
  actionLabel: string
  outcome: string
  alias: string | null
}

export type PrivacyDryRunResult = {
  hits: PrivacyDryRunHit[]
  mode: PrivacyGatewayMode
  /** Mindig false: a dry-run nem hív külső szolgáltatást. */
  calledExternalModel: false
  /** Mindig false: a dry-run nem ír a vaultba. */
  wroteVault: false
}

export function previewAliasForCategory(category: string, ordinal: number): string {
  const canonical = canonicalPrivacyCategory(category)
  if (isSurrogateEntityType(canonical)) return formatSurrogate(canonical, ordinal)
  const label =
    PREVIEW_LABEL[canonical] ?? (canonical.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'ITEM')
  return `[[${label}_${ordinal}]]`
}

export function describePrivacyDryRunOutcome(
  action: PrivacyCategoryAction,
  mode: PrivacyGatewayMode,
): string {
  if (mode === 'off') {
    return 'A védelem ki van kapcsolva: a modell a nyers adatot kapná, a csere nem futna.'
  }
  if (mode === 'observe') {
    if (action === 'tokenize') {
      return 'Megfigyelés: feljegyeznénk az álnevet, de a modell még a valódi adatot kapná.'
    }
    if (action === 'allow') return 'A valódi adat menne a modellnek — ez a szabály szerint engedett.'
    if (action === 'local_only') {
      return 'Megfigyelés: jeleznénk, hogy külső modell helyett helyi modell kellene; a hívás most még a nyers adattal menne.'
    }
    return 'Megfigyelés: jeleznénk a tiltást, de a hívás most még nem állna meg.'
  }
  if (action === 'tokenize') return 'A modell az álnevet kapná; a valódi adat bent maradna.'
  if (action === 'allow') return 'A valódi adat menne a külső modellnek.'
  if (action === 'local_only') {
    return 'Külső modell nem kapná meg. Ha van helyi modell, az dolgozna vele; ha nincs, a hívás megállna.'
  }
  return 'A hívás megállna, az adat sehova nem menne ki.'
}

/**
 * Szinkron, I/O-mentes próba. Nem fetch-el, nem ír vaultot, nem hív modellt.
 */
export function runPrivacyDryRun(input: {
  text: string
  policy: ResolvedPrivacyCategoryPolicy
  mode: PrivacyGatewayMode
}): PrivacyDryRunResult {
  const inspection = inspectPromptSensitivity([{ role: 'user', content: input.text }])
  const ordinals = new Map<string, number>()
  const hits: PrivacyDryRunHit[] = inspection.findings.map((finding) => {
    const category = canonicalPrivacyCategory(finding.category)
    const action = actionForPrivacyCategory(input.policy, category)
    const nextOrdinal = (ordinals.get(category) ?? 0) + 1
    ordinals.set(category, nextOrdinal)
    const alias = action === 'tokenize' ? previewAliasForCategory(category, nextOrdinal) : null
    const labels = PRIVACY_CATEGORY_LABELS[category]
    return {
      category,
      categoryLabel: labels?.label ?? category,
      snippet: finding.snippet,
      action,
      actionLabel: PRIVACY_ACTION_LABELS[action].label,
      outcome: describePrivacyDryRunOutcome(action, input.mode),
      alias,
    }
  })
  return {
    hits,
    mode: input.mode,
    calledExternalModel: false,
    wroteVault: false,
  }
}

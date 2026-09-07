'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import {
  importSkillMdAction,
  createSkillAction,
  updateSkillDisplayNameAction,
  updateSkillKindAction,
  updateSkillDescriptionAction,
  approveSkillVersionAction,
  rollbackSkillVersionAction,
  deactivateSkillAction,
  deleteSkillAction,
  proposeSkillVersionAction,
  getSkillVersionAction,
  diffSkillVersionsAction,
  reviewSkillVersionAction,
  type SkillCatalogEntry,
  type SkillVersionDetail,
  type SkillAdvisoryReviewResult,
} from '@/app/actions/skills'
import { ToolCapabilityCheckboxGroups } from '@/components/tool-capabilities/tool-capability-checkbox-groups'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { Badge, Card } from '@/components/ui/shell'
import type { SkillDiff } from '@/lib/skill/skill-diff'
import type { SkillParameter, SkillRuntimeHints } from '@/lib/skill/skill-content'
import {
  SKILL_RUNTIME_HINT_LIMITS,
  SKILL_ATTACHMENT_DESCRIPTION_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  clampSkillRuntimeHints,
} from '@/lib/skill/skill-content'
import { NORMAL_TOOL_CAPABILITY_GROUPS } from '@/lib/tool-capability-catalog'
import { skillDisplayLabel } from '@/lib/skill/skill-name'
import {
  SKILL_KIND_BADGE_TONE,
  SKILL_KIND_COPY,
  SKILL_SYSTEM_ROLE_LABEL,
  isSkillSystemRole,
  resolveSkillKind,
  type SkillKind,
  type SkillSystemRole,
} from '@/lib/skill/skill-kind'
import { SkillKindFields } from '@/components/skills/skill-kind-fields'

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  proposed: 'warning',
  approved: 'neutral',
  active: 'success',
  retired: 'neutral',
  rolled_back: 'danger',
}

const RISK_TONE: Record<string, string> = {
  high: 'bg-coral/15 text-coral',
  medium: 'bg-honey/15 text-honey',
  low: 'bg-sage/15 text-sage',
  none: 'bg-sage/15 text-sage',
}

function parseTriggerKeywords(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function formatTriggerKeywords(keywords: string[]): string {
  return keywords.join(', ')
}

function parseParameters(raw: string): SkillParameter[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const pipe = line.indexOf('|')
      if (pipe >= 0) {
        const name = line.slice(0, pipe).trim()
        const description = line.slice(pipe + 1).trim()
        return name ? { name, description } : null
      }
      return { name: line, description: '' }
    })
    .filter((p): p is SkillParameter => p !== null)
}

function formatParameters(params: SkillParameter[]): string {
  return params
    .map((p) => (p.description ? `${p.name} | ${p.description}` : p.name))
    .join('\n')
}

function requiresFromTools(tools: Set<string>) {
  return [...tools].map((toolName) => ({ toolName, reason: '' }))
}

const WALL_CLOCK_SEC_MIN = Math.round(SKILL_RUNTIME_HINT_LIMITS.maxWallClockMs.min / 1000)
const WALL_CLOCK_SEC_MAX = Math.round(SKILL_RUNTIME_HINT_LIMITS.maxWallClockMs.max / 1000)

/** A három hint-mező nyers (szerkesztés alatti) szöveges állapota. */
type RuntimeHintsDraft = {
  wallClockSec: string
  toolCalls: string
  preferredMode: '' | 'chat' | 'task'
  /** #199 — csatolható-e fájl a skillhez kötött feladathoz. Alapérték: igen. */
  allowAttachments: boolean
  /** Várt csatolmány leírása — a feladat-indító űrlapon jelenik meg. */
  attachmentDescription: string
}

const EMPTY_RUNTIME_HINTS: RuntimeHintsDraft = {
  wallClockSec: '',
  toolCalls: '',
  preferredMode: '',
  allowAttachments: true,
  attachmentDescription: '',
}

function runtimeHintsToDraft(hints: SkillRuntimeHints | undefined): RuntimeHintsDraft {
  return {
    wallClockSec: hints?.maxWallClockMs != null ? String(Math.round(hints.maxWallClockMs / 1000)) : '',
    toolCalls: hints?.maxToolCalls != null ? String(hints.maxToolCalls) : '',
    preferredMode: hints?.preferredMode ?? '',
    // Hiányzó érték = engedett (visszafelé kompatibilitás a meglévő skillekkel).
    allowAttachments: hints?.allowAttachments !== false,
    attachmentDescription: hints?.attachmentDescription ?? '',
  }
}

function draftToRuntimeHints(draft: RuntimeHintsDraft): SkillRuntimeHints | undefined {
  const sec = Number(draft.wallClockSec.trim())
  const calls = Number(draft.toolCalls.trim())
  return clampSkillRuntimeHints({
    maxWallClockMs: draft.wallClockSec.trim() && Number.isFinite(sec) ? sec * 1000 : null,
    maxToolCalls: draft.toolCalls.trim() && Number.isFinite(calls) ? calls : null,
    preferredMode: draft.preferredMode === '' ? null : draft.preferredMode,
    allowAttachments: draft.allowAttachments ? null : false,
    attachmentDescription: draft.allowAttachments ? draft.attachmentDescription : null,
  })
}

/** Hétköznapi, egysoros összefoglaló a listához. Üres hint → nincs sor. */
function describeRuntimeHints(hints: SkillRuntimeHints | undefined): string | null {
  if (!hints) return null
  const parts: string[] = []
  if (hints.maxWallClockMs != null) parts.push(`${Math.round(hints.maxWallClockMs / 1000)} mp`)
  if (hints.maxToolCalls != null) parts.push(`${hints.maxToolCalls} eszközhívás`)
  if (hints.preferredMode === 'task') parts.push('a boardon fut')
  else if (hints.preferredMode === 'chat') parts.push('chatben fut')
  if (hints.allowAttachments === false) parts.push('nem csatolható fájl')
  if (hints.attachmentDescription) parts.push('csatolmány-leírás')
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * Futási keret (`runtimeHints`) szerkesztő. Ugyanaz a három mező, amit a
 * `SKILL.md` frontmatter is hoz (`max-wall-clock-ms`, `max-tool-calls`,
 * `preferred-mode`) — importált skillnél itt válik láthatóvá és állíthatóvá.
 * Az időt másodpercben kérjük, mert az ember percekben gondolkodik; a tárolás
 * ezredmásodperc marad.
 */
function SkillRuntimeHintsFields({
  draft,
  onChange,
  disabled,
}: {
  draft: RuntimeHintsDraft
  onChange: (next: RuntimeHintsDraft) => void
  disabled?: boolean
}) {
  const applied = draftToRuntimeHints(draft)
  const clampedWallClock =
    applied?.maxWallClockMs != null &&
    draft.wallClockSec.trim() !== '' &&
    Math.round(applied.maxWallClockMs / 1000) !== Number(draft.wallClockSec.trim())
  const clampedToolCalls =
    applied?.maxToolCalls != null &&
    draft.toolCalls.trim() !== '' &&
    applied.maxToolCalls !== Number(draft.toolCalls.trim())

  return (
    <div
      className={`rounded-lg border border-ink-faint/30 p-3 ${disabled ? 'pointer-events-none opacity-50' : ''}`}
    >
      <p className="text-xs font-medium text-ink-soft">Futási keret (opcionális)</p>
      <p className="mt-1 text-[11px] text-ink-faint">
        Üresen hagyva a platform alapértéke érvényes (chatben ~180 mp / 60 eszközhívás). A skill
        csak <em>emelheti</em> a keretet, szűkíteni nem tudja.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="block text-[11px] text-ink-faint">
          Legfeljebb ennyi ideig fusson (mp)
          <input
            type="number"
            inputMode="numeric"
            min={WALL_CLOCK_SEC_MIN}
            max={WALL_CLOCK_SEC_MAX}
            value={draft.wallClockSec}
            onChange={(e) => onChange({ ...draft, wallClockSec: e.target.value })}
            placeholder={`${WALL_CLOCK_SEC_MIN}–${WALL_CLOCK_SEC_MAX}`}
            className="mt-1 w-full rounded-lg border border-ink-faint/30 bg-transparent px-2 py-1.5 text-sm text-ink"
          />
        </label>
        <label className="block text-[11px] text-ink-faint">
          Legfeljebb ennyi eszközhívás
          <input
            type="number"
            inputMode="numeric"
            min={SKILL_RUNTIME_HINT_LIMITS.maxToolCalls.min}
            max={SKILL_RUNTIME_HINT_LIMITS.maxToolCalls.max}
            value={draft.toolCalls}
            onChange={(e) => onChange({ ...draft, toolCalls: e.target.value })}
            placeholder={`${SKILL_RUNTIME_HINT_LIMITS.maxToolCalls.min}–${SKILL_RUNTIME_HINT_LIMITS.maxToolCalls.max}`}
            className="mt-1 w-full rounded-lg border border-ink-faint/30 bg-transparent px-2 py-1.5 text-sm text-ink"
          />
        </label>
        <label className="block text-[11px] text-ink-faint">
          Hol fusson
          <select
            value={draft.preferredMode}
            onChange={(e) =>
              onChange({ ...draft, preferredMode: e.target.value as RuntimeHintsDraft['preferredMode'] })
            }
            className="mt-1 w-full rounded-lg border border-ink-faint/30 bg-transparent px-2 py-1.5 text-sm text-ink"
          >
            <option value="">Alapértelmezés (chatben)</option>
            <option value="chat">Chatben</option>
            <option value="task">Hosszú feladat — a boardon fusson</option>
          </select>
        </label>
      </div>
      {(clampedWallClock || clampedToolCalls) && (
        <p className="mt-2 text-[11px] text-honey">
          A megadott érték a megengedett tartományon kívül esik — mentéskor{' '}
          {clampedWallClock && applied?.maxWallClockMs != null
            ? `${Math.round(applied.maxWallClockMs / 1000)} mp`
            : ''}
          {clampedWallClock && clampedToolCalls ? ' · ' : ''}
          {clampedToolCalls && applied?.maxToolCalls != null ? `${applied.maxToolCalls} hívás` : ''}{' '}
          lesz belőle.
        </p>
      )}
      {draft.preferredMode === 'task' && (
        <p className="mt-2 text-[11px] text-ink-faint">
          A chat ilyenkor nem futtatja végig a feladatot: ticketet nyit, és a munka a boardon
          folytatódik — a felhasználó a chatben megkapja a ticket hivatkozását.
        </p>
      )}
      {/* #199 — csatolmány-szabály. Bináris: a skill vagy fogad fájlt, vagy nem. */}
      <label className="mt-3 flex items-start gap-2 text-[11px] text-ink-faint">
        <input
          type="checkbox"
          checked={draft.allowAttachments}
          onChange={(e) =>
            onChange({
              ...draft,
              allowAttachments: e.target.checked,
              ...(!e.target.checked ? { attachmentDescription: '' } : {}),
            })
          }
          className="mt-0.5"
        />
        <span>
          <span className="text-ink-soft">Fájl csatolható a feladathoz</span>
          <span className="mt-0.5 block">
            Kikapcsolva a feladat-indító felületen nem jelenik meg fájlfeltöltés, és a
            közvetlen feltöltést a szerver is elutasítja. Akkor kapcsold ki, ha a skill
            bemenete kizárólag a paraméterekből jön.
          </span>
        </span>
      </label>
      {draft.allowAttachments && (
        <label className="mt-3 block text-[11px] text-ink-faint">
          Milyen fájlt várunk?
          <textarea
            value={draft.attachmentDescription}
            onChange={(e) => onChange({ ...draft, attachmentDescription: e.target.value })}
            maxLength={SKILL_ATTACHMENT_DESCRIPTION_MAX}
            rows={2}
            placeholder="Pl.: Excel táblázat az értékesítési adatokkal, PDF formátumú számla…"
            className="mt-1 w-full rounded-lg border border-ink-faint/30 bg-transparent px-2 py-1.5 text-sm text-ink"
          />
          <span className="mt-1 block">
            Ez a szöveg a feladat-indító űrlapon a fájlcsatolás fölött jelenik meg, és elmagyarázza
            a felhasználónak, milyen csatolmányt érdemes feltölteni.
          </span>
        </label>
      )}
    </div>
  )
}

function SkillRequiresToolPicker({
  enabled,
  onChange,
  disabled,
}: {
  enabled: Set<string>
  onChange: (next: Set<string>) => void
  disabled?: boolean
}) {
  return (
    <div
      className={`rounded-lg border border-ink-faint/30 p-3 ${disabled ? 'pointer-events-none opacity-50' : ''}`}
    >
      <p className="mb-3 text-xs text-ink-faint">Javasolt eszközök (requires)</p>
      <ToolCapabilityCheckboxGroups
        groups={NORMAL_TOOL_CAPABILITY_GROUPS}
        enabled={enabled}
        onChange={onChange}
      />
    </div>
  )
}

type DiffResult = {
  diff: SkillDiff
  base: { version: number; contentHash: string }
  target: { version: number; contentHash: string }
}

/**
 * Skill-katalógus kezelő UI (skill-catalog-spec.md WP-6/7). Három szerzési forrásból
 * kettő (import + kézi) itt landol; mindkettő a hardcoded validátoron megy át és
 * `proposed` verzióként áll elő. A verziólista mutatja a write-gate állapotot, az
 * aláírást, admin-jóváhagyást / rollbackot, in-place verzió-szerkesztést és diff-et.
 * A desztilláció (D14) a chat-panelből indul (agent-detail, admin).
 */
export function SkillCatalogManager({
  skills,
  isAdmin,
  isPlatformAdmin = false,
}: {
  skills: SkillCatalogEntry[]
  isAdmin: boolean
  /** Global skill meta/verzió írásához kell — tenant-admin önmagában nem elég. */
  isPlatformAdmin?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null)
  const [creationMode, setCreationMode] = useState<'import' | 'manual' | null>(null)
  const [expandedSkillIds, setExpandedSkillIds] = useState<Set<string>>(() => new Set())
  const [catalogQuery, setCatalogQuery] = useState('')

  const normalizedCatalogQuery = catalogQuery.trim().toLocaleLowerCase('hu-HU')
  const filteredSkills = normalizedCatalogQuery
    ? skills.filter((skill) =>
        [
          skillDisplayLabel(skill),
          skill.name,
          skill.description,
          skill.catalogScope,
          skill.kind,
          skill.sourceType,
        ]
          .join(' ')
          .toLocaleLowerCase('hu-HU')
          .includes(normalizedCatalogQuery),
      )
    : skills

  function toggleVersions(skillId: string) {
    setExpandedSkillIds((current) => {
      const next = new Set(current)
      if (next.has(skillId)) next.delete(skillId)
      else next.add(skillId)
      return next
    })
  }

  function openVersionEditor(skillId: string) {
    setExpandedSkillIds((current) => new Set(current).add(skillId))
    setEditingSkillId(skillId)
  }

  function run(fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) {
    startTransition(async () => {
      setError(null)
      setNotice(null)
      const res = await fn()
      if (res.success) {
        setNotice(okMsg)
        router.refresh()
      } else {
        setError(res.error ?? 'Ismeretlen hiba.')
      }
    })
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-coral">{error}</p>}
      {notice && (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          {notice}
        </p>
      )}

      {isAdmin && (
        <section className="atelier-card overflow-hidden">
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-coral">Új skill</p>
              <h2 className="mt-1 font-display text-xl font-semibold tracking-tight">Hogyan szeretnéd létrehozni?</h2>
              <p className="mt-1 max-w-2xl text-sm text-ink-soft">
                Válaszd ki a szerzés módját. Az űrlap csak megnyitás után jelenik meg, így a
                katalógus áttekintése fókuszban marad.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-expanded={creationMode === 'import'}
                onClick={() => setCreationMode((current) => (current === 'import' ? null : 'import'))}
                className={`rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                  creationMode === 'import'
                    ? 'border-coral bg-coral text-white'
                    : 'border-coral/35 bg-coral/8 text-coral hover:bg-coral/15'
                }`}
              >
                SKILL.md importálása
              </button>
              <button
                type="button"
                aria-expanded={creationMode === 'manual'}
                onClick={() => setCreationMode((current) => (current === 'manual' ? null : 'manual'))}
                className={`rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                  creationMode === 'manual'
                    ? 'border-ink bg-ink text-card'
                    : 'border-ink-faint/35 bg-card text-ink-soft hover:border-ink-soft hover:text-ink'
                }`}
              >
                Kézi létrehozás
              </button>
            </div>
          </div>
          {creationMode && (
            <div className="border-t border-line bg-night-2/35 p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-ink-soft">
                  {creationMode === 'import' ? 'SKILL.md importálása' : 'Skill kézi létrehozása'}
                </p>
                <button
                  type="button"
                  onClick={() => setCreationMode(null)}
                  className="rounded-full px-2 py-1 text-xs font-medium text-ink-faint hover:bg-card hover:text-ink"
                >
                  Bezárás
                </button>
              </div>
              {creationMode === 'import' ? (
                <ImportSkillForm
                  running={pending}
                  onRun={run}
                  isPlatformAdmin={isPlatformAdmin}
                />
              ) : (
                <CreateSkillForm
                  running={pending}
                  onRun={run}
                  isPlatformAdmin={isPlatformAdmin}
                />
              )}
            </div>
          )}
        </section>
      )}

      <Card
        title={`Katalógus · ${skills.length} skill`}
        className="[&>h2]:mb-1"
      >
        <p className="mb-5 text-sm text-ink-faint">
          Alapból minden skill legutóbbi verzióját látod. A teljes előzmény és a verzióműveletek
          a „Verziók” gomb mögött érhetők el.
        </p>
        {skills.length > 0 && (
          <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative block min-w-0 flex-1">
              <span className="sr-only">Keresés a skillek között</span>
              <svg
                aria-hidden
                viewBox="0 0 20 20"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              >
                <circle cx="8.5" cy="8.5" r="4.75" />
                <path d="m12 12 4.25 4.25" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={catalogQuery}
                onChange={(event) => setCatalogQuery(event.target.value)}
                placeholder="Keresés név, azonosító vagy leírás alapján…"
                className="w-full rounded-xl border border-ink-faint/30 bg-card px-9 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-coral focus:ring-2 focus:ring-coral/15"
              />
              {catalogQuery && (
                <button
                  type="button"
                  aria-label="Keresés törlése"
                  onClick={() => setCatalogQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-2 py-1 text-xs text-ink-faint hover:bg-night-2 hover:text-ink"
                >
                  ×
                </button>
              )}
            </label>
            <p className="shrink-0 text-xs text-ink-faint">
              {filteredSkills.length} / {skills.length} találat
            </p>
          </div>
        )}
        {skills.length === 0 ? (
          <p className="text-sm text-ink-faint">Még nincs skill a katalógusban.</p>
        ) : filteredSkills.length === 0 ? (
          <div className="rounded-xl border border-dashed border-ink-faint/30 bg-night-2/30 px-4 py-7 text-center">
            <p className="text-sm font-medium text-ink-soft">Nincs egyező skill.</p>
            <p className="mt-1 text-xs text-ink-faint">Próbálj más keresőkifejezést, vagy töröld a szűrőt.</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {filteredSkills.map((s) => {
              // Global skillt csak platform-admin írhat — a szerver is ezt kapuzza.
              const canWriteSkill =
                isAdmin && (s.catalogScope === 'tenant' || isPlatformAdmin)
              const latestVersion = s.versions[0]
              const versionsOpen = expandedSkillIds.has(s.id)
              const kind = resolveSkillKind(s.kind, s.catalogScope)
              return (
              <li key={s.id} className="atelier-soft overflow-hidden">
                <div className="p-4 sm:p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-display text-lg font-semibold tracking-tight text-ink">
                          {skillDisplayLabel(s)}
                        </h3>
                        {latestVersion && (
                          <Badge tone={STATUS_TONE[latestVersion.status] ?? 'neutral'}>
                            v{latestVersion.version} · {latestVersion.status}
                          </Badge>
                        )}
                        <span className="text-xs uppercase tracking-wide text-ink-faint">{s.riskTier}</span>
                      </div>
                      {s.displayName?.trim() && s.displayName.trim() !== s.name ? (
                        <p className="mt-0.5 font-mono text-[11px] text-ink-faint">{s.name}</p>
                      ) : null}
                      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-soft">{s.description}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Badge tone={SKILL_KIND_BADGE_TONE[kind]}>{SKILL_KIND_COPY[kind].label}</Badge>
                      {kind === 'system' && s.requiredSystemRole ? (
                        <Badge tone="neutral">
                          {isSkillSystemRole(s.requiredSystemRole)
                            ? SKILL_SYSTEM_ROLE_LABEL[s.requiredSystemRole]
                            : s.requiredSystemRole}
                        </Badge>
                      ) : null}
                      <Badge tone="neutral">{s.sourceType}</Badge>
                      {s.license && <Badge tone="neutral">{s.license}</Badge>}
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col gap-3 border-t border-ink-faint/15 pt-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
                      {latestVersion ? (
                        <span>
                          Legutóbbi változat: <span className="font-medium text-ink-soft">v{latestVersion.version}</span>
                          {latestVersion.signed && ' · aláírt'}
                          {' · '}{new Date(latestVersion.createdAt).toLocaleDateString('hu-HU')}
                        </span>
                      ) : (
                        <span>Nincs elérhető verzió.</span>
                      )}
                      {describeRuntimeHints(s.runtimeHints) && <span>Aktív futási keret: {describeRuntimeHints(s.runtimeHints)}</span>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        aria-expanded={versionsOpen}
                        onClick={() => toggleVersions(s.id)}
                        className="rounded-full border border-ink-faint/30 px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-ink-soft hover:text-ink"
                      >
                        {versionsOpen ? 'Verziók bezárása' : `Verziók (${s.versions.length})`}
                      </button>
                      {canWriteSkill && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => openVersionEditor(s.id)}
                          className="rounded-full bg-coral/15 px-3 py-1.5 text-xs font-semibold text-coral transition-colors hover:bg-coral/25 disabled:opacity-50"
                        >
                          Új verzió
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {versionsOpen && (
                  <div className="border-t border-line bg-card/55 p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-ink">Verzióelőzmény és kezelés</p>
                      {canWriteSkill && (
                        <div className="flex flex-wrap gap-2">
                          {s.versions.some((v) => v.status === 'active') && (
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() =>
                                run(
                                  () => deactivateSkillAction(s.id),
                                  `„${skillDisplayLabel(s)}” deaktiválva — nem hozzárendelhető új agentekhez.`,
                                )
                              }
                              className="rounded-full border border-honey/40 px-3 py-1 text-xs font-medium text-honey disabled:opacity-50"
                            >
                              Deaktiválás
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => {
                              void (async () => {
                                const confirmed = await confirmDialog({
                                  title: 'Skill törlése',
                                  description: `Biztosan törlöd a „${skillDisplayLabel(s)}” skillt és az összes verzióját? Csak hozzárendelés nélkül lehetséges.`,
                                  confirmLabel: 'Törlés',
                                  tone: 'danger',
                                })
                                if (!confirmed) return
                                run(
                                  () => deleteSkillAction(s.id),
                                  `„${skillDisplayLabel(s)}” törölve a katalógusból.`,
                                )
                              })()
                            }}
                            className="rounded-full border border-coral/40 px-3 py-1 text-xs font-medium text-coral disabled:opacity-50"
                          >
                            Törlés
                          </button>
                        </div>
                      )}
                    </div>

                    {canWriteSkill && (
                      <details className="mt-4 rounded-lg border border-ink-faint/20 bg-night-2/30 px-3 py-2">
                        <summary className="cursor-pointer text-xs font-medium text-ink-soft">Skill metaadatainak szerkesztése</summary>
                        <div className="mt-3 border-t border-ink-faint/15 pt-1">
                          <SkillDisplayNameEditor skill={s} running={pending} onRun={run} />
                          <SkillKindEditor
                            skill={s}
                            running={pending}
                            onRun={run}
                            isPlatformAdmin={isPlatformAdmin}
                          />
                          <SkillDescriptionEditor skill={s} running={pending} onRun={run} />
                        </div>
                      </details>
                    )}

                    {canWriteSkill && editingSkillId === s.id && (
                      <EditSkillVersionForm
                        skill={s}
                        running={pending}
                        onRun={run}
                        onClose={() => setEditingSkillId(null)}
                      />
                    )}

                    {s.versions.length >= 2 && <SkillVersionDiffPanel skill={s} running={pending} />}

                    <ul className="mt-4 space-y-2">
                      {s.versions.map((v) => (
                    <li
                      key={v.id}
                      className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-faint/10 pt-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-ink">v{v.version}</span>
                        <Badge tone={STATUS_TONE[v.status] ?? 'neutral'}>{v.status}</Badge>
                        {v.signed && <Badge tone="success">aláírt</Badge>}
                        <span className="font-mono text-ink-faint">
                          {v.contentHash.slice(0, 10)}…
                        </span>
                      </div>
                      {canWriteSkill && (
                        <div className="flex flex-wrap items-center gap-2">
                          {(v.status === 'proposed' || v.status === 'approved') && (
                            <>
                              <SkillVersionReviewButton versionId={v.id} />
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() =>
                                  run(
                                    () => approveSkillVersionAction(v.id),
                                    `v${v.version} jóváhagyva és aktiválva.`,
                                  )
                                }
                                className="rounded-full bg-coral/20 px-3 py-1 font-semibold text-coral disabled:opacity-50"
                              >
                                Jóváhagyás
                              </button>
                            </>
                          )}
                          {(v.status === 'retired' || v.status === 'rolled_back') && (
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() =>
                                run(
                                  () => rollbackSkillVersionAction(v.id),
                                  `Visszaállítva a v${v.version} verzióra.`,
                                )
                              }
                              className="rounded-full border border-ink-faint/30 px-3 py-1 font-medium text-ink-soft disabled:opacity-50"
                            >
                              Rollback
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                    </ul>
                  </div>
                )}
              </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}

function SkillVersionReviewButton({ versionId }: { versionId: string }) {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<SkillAdvisoryReviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function runReview() {
    setError(null)
    startTransition(async () => {
      const res = await reviewSkillVersionAction(versionId)
      if (res.success) {
        setResult(res.data)
        setOpen(true)
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={pending}
        onClick={runReview}
        className="rounded-full border border-honey/40 px-3 py-1 font-medium text-honey disabled:opacity-50"
      >
        {pending ? 'Review…' : 'LLM tanács'}
      </button>
      {error && <p className="absolute right-0 top-full z-10 mt-1 w-56 text-[10px] text-coral">{error}</p>}
      {open && result && (
        <div className="mt-2 w-full min-w-[280px] space-y-2 rounded-lg border border-honey/25 bg-honey/5 p-3 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-ink">Tanácsadó LLM-review (nem kapu)</span>
            <button type="button" onClick={() => setOpen(false)} className="text-ink-faint hover:text-ink">
              ×
            </button>
          </div>
          <p className="text-ink-soft">{result.review.riskSummary}</p>
          <p>
            LLM értékelés:{' '}
            <span className={`rounded px-1.5 py-0.5 font-medium ${RISK_TONE[result.review.overallAssessment] ?? ''}`}>
              {result.review.overallAssessment}
            </span>
            {' · '}
            Hardcoded validátor:{' '}
            <span className={result.validation.ok ? 'text-sage' : 'text-coral'}>
              {result.validation.ok ? 'ok' : 'elutasítva'}
            </span>
            {' · '}
            tier: {result.validation.riskTier}
          </p>
          {!result.validation.ok && result.validation.errors.length > 0 && (
            <ul className="list-inside list-disc text-coral">
              {result.validation.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {result.review.concerns.length > 0 && (
            <ul className="list-inside list-disc text-ink-soft">
              {result.review.concerns.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          {result.review.suggestedRequires.length > 0 && (
            <p className="text-ink-faint">
              Javasolt requires:{' '}
              {result.review.suggestedRequires.map((r) => r.toolName).join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function SkillVersionDiffPanel({
  skill,
  running,
}: {
  skill: SkillCatalogEntry
  running: boolean
}) {
  const versions = skill.versions
  const [baseId, setBaseId] = useState(versions[1]?.id ?? versions[0]?.id ?? '')
  const [targetId, setTargetId] = useState(versions[0]?.id ?? '')
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const versionLabel = (v: (typeof versions)[0]) => `v${v.version} (${v.status})`

  function runDiff() {
    setDiffError(null)
    startTransition(async () => {
      const res = await diffSkillVersionsAction({ baseVersionId: baseId, targetVersionId: targetId })
      if (res.success) setDiff(res.data)
      else setDiffError(res.error)
    })
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-ink-faint/15 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-ink-soft">Verzió-diff</span>
        <select
          value={baseId}
          onChange={(e) => setBaseId(e.target.value)}
          className="rounded border border-ink-faint/30 bg-transparent px-2 py-1"
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {versionLabel(v)}
            </option>
          ))}
        </select>
        <span className="text-ink-faint">→</span>
        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="rounded border border-ink-faint/30 bg-transparent px-2 py-1"
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {versionLabel(v)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={runDiff}
          disabled={running || pending || !baseId || !targetId}
          className="rounded-full border border-ink-faint/30 px-3 py-1 font-medium text-ink-soft disabled:opacity-50"
        >
          {pending ? 'Diff…' : 'Összehasonlítás'}
        </button>
      </div>
      {diffError && <p className="text-xs text-coral">{diffError}</p>}
      {diff && (
        <div className="space-y-2 text-xs">
          <p className="text-ink-soft">
            v{diff.base.version} ({diff.base.contentHash.slice(0, 8)}…) → v{diff.target.version} (
            {diff.target.contentHash.slice(0, 8)}…) · legmagasabb kockázat:{' '}
            <span
              className={`rounded px-1.5 py-0.5 font-medium ${RISK_TONE[diff.diff.highestRisk] ?? ''}`}
            >
              {diff.diff.highestRisk}
            </span>
          </p>
          {diff.diff.changes.length === 0 ? (
            <p className="text-sage">Nincs tartalmi különbség.</p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {diff.diff.changes.map((c, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${RISK_TONE[c.risk] ?? ''}`}
                  >
                    {c.category}/{c.kind}
                  </span>
                  <span className="text-ink-soft">{c.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function EditSkillVersionForm({
  skill,
  running,
  onRun,
  onClose,
}: {
  skill: SkillCatalogEntry
  running: boolean
  onRun: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
  onClose: () => void
}) {
  const defaultVersionId =
    skill.versions.find((v) => v.status === 'active')?.id ?? skill.versions[0]?.id ?? ''
  const [sourceVersionId, setSourceVersionId] = useState(defaultVersionId)
  const [instructions, setInstructions] = useState('')
  const [triggerKeywordsRaw, setTriggerKeywordsRaw] = useState('')
  const [parametersRaw, setParametersRaw] = useState('')
  const [runtimeHints, setRuntimeHints] = useState<RuntimeHintsDraft>(EMPTY_RUNTIME_HINTS)
  const [requiredTools, setRequiredTools] = useState<Set<string>>(() => new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function applyDetail(detail: SkillVersionDetail) {
    setInstructions(detail.content.instructions.join('\n\n'))
    setTriggerKeywordsRaw(formatTriggerKeywords(detail.content.triggerKeywords))
    setParametersRaw(formatParameters(detail.content.parameters))
    setRuntimeHints(runtimeHintsToDraft(detail.content.runtimeHints))
    setRequiredTools(new Set(detail.requires.map((r) => r.toolName)))
  }

  useEffect(() => {
    if (!sourceVersionId) return
    let cancelled = false

    void (async () => {
      setLoading(true)
      setLoadError(null)
      const res = await getSkillVersionAction(sourceVersionId)
      if (cancelled) return
      setLoading(false)
      if (!res.success) {
        setLoadError(res.error)
        return
      }
      applyDetail(res.data)
    })()

    return () => {
      cancelled = true
    }
  }, [sourceVersionId])

  function buildPropose() {
    const instructionBlocks = instructions
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    const requires = requiresFromTools(requiredTools)
    const hints = draftToRuntimeHints(runtimeHints)
    return proposeSkillVersionAction({
      skillId: skill.id,
      content: {
        instructions: instructionBlocks,
        triggerKeywords: parseTriggerKeywords(triggerKeywordsRaw),
        parameters: parseParameters(parametersRaw),
        ...(hints ? { runtimeHints: hints } : {}),
      },
      requires,
    })
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-coral/20 bg-coral/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-ink">
          In-place verzió-szerkesztő — a módosítás <em>proposed</em> verzióként landol
        </p>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-ink-faint hover:text-ink"
        >
          Bezárás
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-ink-soft">Forrás verzió:</span>
        <select
          value={sourceVersionId}
          onChange={(e) => setSourceVersionId(e.target.value)}
          className="rounded border border-ink-faint/30 bg-transparent px-2 py-1"
        >
          {skill.versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.version} ({v.status})
            </option>
          ))}
        </select>
        {loading && <span className="text-ink-faint">Betöltés…</span>}
      </div>
      {loadError && <p className="text-xs text-coral">{loadError}</p>}
      <textarea
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={8}
        placeholder="Instrukciók — üres sorral elválasztott blokkok"
        className="w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
        disabled={loading}
      />
      <input
        value={triggerKeywordsRaw}
        onChange={(e) => setTriggerKeywordsRaw(e.target.value)}
        placeholder="triggerKeywords (vesszővel elválasztva)"
        className="w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 font-mono text-xs"
        disabled={loading}
      />
      <textarea
        value={parametersRaw}
        onChange={(e) => setParametersRaw(e.target.value)}
        rows={3}
        placeholder="parameters — soronként: név | leírás"
        className="w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 font-mono text-xs"
        disabled={loading}
      />
      <SkillRuntimeHintsFields
        draft={runtimeHints}
        onChange={setRuntimeHints}
        disabled={loading}
      />
      <SkillRequiresToolPicker
        enabled={requiredTools}
        onChange={setRequiredTools}
        disabled={loading}
      />
      <button
        type="button"
        disabled={running || loading || instructions.trim().length === 0}
        onClick={() =>
          onRun(
            buildPropose,
            'Új verzió javasolva (proposed). Aktiváláshoz hagyd jóvá.',
          )
        }
        className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {running ? 'Mentés…' : 'Új verzió javaslása'}
      </button>
    </div>
  )
}

function ImportSkillForm({
  running,
  onRun,
  isPlatformAdmin,
}: {
  running: boolean
  onRun: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
  isPlatformAdmin: boolean
}) {
  const [raw, setRaw] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [kind, setKind] = useState<SkillKind>('tenant')
  const [requiredSystemRole, setRequiredSystemRole] = useState<SkillSystemRole | null>(null)

  return (
    <div className="max-w-4xl">
      <p className="mb-3 text-xs text-ink-faint">
        Illeszd be a <code>SKILL.md</code> tartalmát (YAML frontmatter + markdown törzs). A
        hardcoded validátor elutasítja a kódot (T2/T3) és a prompt-injection mintákat. A skill
        <em> proposed</em> verzióként jön létre; aktiválás külön jóváhagyással.
      </p>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={8}
        placeholder="---&#10;name: ...&#10;title: Megjelenített feladatnév&#10;description: ...&#10;---&#10;# Áttekintés"
        className="w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 font-mono text-xs"
      />
      <input
        value={sourceUrl}
        onChange={(e) => setSourceUrl(e.target.value)}
        placeholder="Forrás URL (opcionális)"
        className="mt-2 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
      />
      <div className="mt-3">
        <SkillKindFields
          kind={kind}
          requiredSystemRole={requiredSystemRole}
          isPlatformAdmin={isPlatformAdmin}
          disabled={running}
          onChange={(next) => {
            setKind(next.kind)
            setRequiredSystemRole(next.requiredSystemRole)
          }}
        />
      </div>
      <button
        type="button"
        disabled={running || raw.trim().length === 0}
        onClick={() =>
          onRun(
            () => importSkillMdAction({ raw, sourceUrl, kind, requiredSystemRole }),
            'Skill importálva — proposed verzióként. Aktiváláshoz hagyd jóvá.',
          )
        }
        className="mt-4 rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {running ? 'Importálás...' : 'Import'}
      </button>
    </div>
  )
}

function SkillKindEditor({
  skill,
  running,
  onRun,
  isPlatformAdmin,
}: {
  skill: SkillCatalogEntry
  running: boolean
  onRun: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
  isPlatformAdmin: boolean
}) {
  const [kind, setKind] = useState<SkillKind>(() => resolveSkillKind(skill.kind, skill.catalogScope))
  const [requiredSystemRole, setRequiredSystemRole] = useState<SkillSystemRole | null>(() =>
    isSkillSystemRole(skill.requiredSystemRole) ? skill.requiredSystemRole : null,
  )
  const propEpoch = `${skill.id}\0${skill.kind}\0${skill.requiredSystemRole ?? ''}`
  const appliedEpochRef = useRef(propEpoch)

  useEffect(() => {
    if (appliedEpochRef.current === propEpoch) return
    appliedEpochRef.current = propEpoch
    setKind(resolveSkillKind(skill.kind, skill.catalogScope))
    setRequiredSystemRole(
      isSkillSystemRole(skill.requiredSystemRole) ? skill.requiredSystemRole : null,
    )
  }, [propEpoch, skill.kind, skill.requiredSystemRole, skill.catalogScope])

  const canEdit = isPlatformAdmin && skill.catalogScope === 'global'
  const dirty =
    kind !== skill.kind ||
    (requiredSystemRole ?? null) !== (skill.requiredSystemRole ?? null)

  return (
    <div className="mt-3 space-y-2">
      <SkillKindFields
        name={`skill-kind-${skill.id}`}
        kind={kind}
        requiredSystemRole={requiredSystemRole}
        isPlatformAdmin={canEdit}
        disabled={running || !canEdit}
        disableKinds={skill.catalogScope === 'global' ? ['tenant'] : ['published', 'system']}
        onChange={(next) => {
          setKind(next.kind)
          setRequiredSystemRole(next.requiredSystemRole)
        }}
      />
      {canEdit ? (
        <button
          type="button"
          disabled={running || !dirty}
          onClick={() =>
            onRun(
              () =>
                updateSkillKindAction({
                  skillId: skill.id,
                  kind,
                  requiredSystemRole,
                }),
              `Fajta mentve: ${SKILL_KIND_COPY[kind].label}.`,
            )
          }
          className="rounded-full border border-ink-faint/30 px-3 py-1 text-xs font-medium text-ink-soft disabled:opacity-50"
        >
          Fajta mentése
        </button>
      ) : (
        <p className="text-[11px] text-ink-faint">
          {skill.catalogScope === 'tenant'
            ? 'A tenant-skill fajtája rögzített.'
            : 'A kiadott vagy rendszer fajtát csak platform-admin állíthatja.'}
        </p>
      )}
    </div>
  )
}

function SkillDisplayNameEditor({
  skill,
  running,
  onRun,
}: {
  skill: SkillCatalogEntry
  running: boolean
  onRun: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
}) {
  // A props-ból jövő érték mellett helyi „utolsó sikeres mentés” — ha a
  // router.refresh() régi Prisma-klienssel üresen jön vissza, ne törölje a mezőt.
  const propSaved = skill.displayName ?? ''
  const [committed, setCommitted] = useState(propSaved)
  const [value, setValue] = useState(propSaved)
  const propEpoch = `${skill.id}\0${propSaved}`
  const appliedEpochRef = useRef(propEpoch)

  // Prop-csere: üres props + meglévő committed = stale Prisma-read a refresh után — ne wipe-oljuk.
  useEffect(() => {
    if (appliedEpochRef.current === propEpoch) return
    appliedEpochRef.current = propEpoch
    if (propSaved.trim() || !committed.trim()) {
      setCommitted(propSaved)
      setValue(propSaved)
    }
  }, [propEpoch, propSaved, committed])

  const dirty = value.trim() !== committed.trim()

  return (
    <div className="mt-2 space-y-1">
      <label
        htmlFor={`skill-display-name-${skill.id}`}
        className="block text-[11px] font-medium text-ink-faint"
      >
        Megjelenített név
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={`skill-display-name-${skill.id}`}
          value={value}
          maxLength={SKILL_NAME_MAX}
          disabled={running}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Feladatválasztóban megjelenő név (üres = technikai név)"
          className="min-w-[14rem] flex-1 rounded-lg border border-ink-faint/30 bg-transparent px-3 py-1.5 text-sm text-ink"
        />
        <button
          type="button"
          disabled={running || !dirty}
          onClick={() =>
            onRun(async () => {
              const res = await updateSkillDisplayNameAction({
                skillId: skill.id,
                displayName: value.trim() || null,
              })
              if (res.success) {
                const next = res.data.displayName ?? ''
                setCommitted(next)
                setValue(next)
              }
              return res
            }, value.trim()
              ? `Megjelenített név mentve: „${value.trim()}”.`
              : 'Megjelenített név törölve — a select a technikai nevet mutatja.')
          }
          className="rounded-full border border-ink-faint/30 px-3 py-1 text-xs font-medium text-ink-soft disabled:opacity-50"
        >
          Mentés
        </button>
      </div>
    </div>
  )
}

function SkillDescriptionEditor({
  skill,
  running,
  onRun,
}: {
  skill: SkillCatalogEntry
  running: boolean
  onRun: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
}) {
  const saved = skill.description
  const [value, setValue] = useState(saved)
  const propEpoch = `${skill.id}\0${saved}`
  const appliedEpochRef = useRef(propEpoch)

  useEffect(() => {
    if (appliedEpochRef.current === propEpoch) return
    appliedEpochRef.current = propEpoch
    setValue(saved)
  }, [propEpoch, saved])

  const trimmed = value.trim()
  const dirty = trimmed !== saved.trim()
  const tooLong = trimmed.length > SKILL_DESCRIPTION_MAX
  const empty = trimmed.length === 0

  return (
    <div className="mt-2 space-y-1.5">
      <label
        htmlFor={`skill-description-${skill.id}`}
        className="block text-[11px] font-medium text-ink-faint"
      >
        Leírás (Level-0 index)
      </label>
      <textarea
        id={`skill-description-${skill.id}`}
        key={`description-${skill.id}-${saved.slice(0, 32)}`}
        value={value}
        maxLength={SKILL_DESCRIPTION_MAX}
        disabled={running}
        rows={3}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Rövid leírás — a skill-választó / katalógus mutatja betöltés előtt"
        className="w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-xs text-ink"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-[11px] ${tooLong || empty ? 'text-coral' : 'text-ink-faint'}`}>
          {trimmed.length}/{SKILL_DESCRIPTION_MAX}
          {empty ? ' — nem lehet üres' : ''}
        </span>
        <button
          type="button"
          disabled={running || !dirty || empty || tooLong}
          onClick={() =>
            onRun(
              () =>
                updateSkillDescriptionAction({
                  skillId: skill.id,
                  description: trimmed,
                }),
              'Leírás mentve.',
            )
          }
          className="rounded-full border border-ink-faint/30 px-3 py-1 text-xs font-medium text-ink-soft disabled:opacity-50"
        >
          Leírás mentése
        </button>
      </div>
    </div>
  )
}

function CreateSkillForm({
  running,
  onRun,
  isPlatformAdmin,
}: {
  running: boolean
  onRun: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
  isPlatformAdmin: boolean
}) {
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<SkillKind>('tenant')
  const [requiredSystemRole, setRequiredSystemRole] = useState<SkillSystemRole | null>(null)
  const [instructions, setInstructions] = useState('')
  const [triggerKeywordsRaw, setTriggerKeywordsRaw] = useState('')
  const [parametersRaw, setParametersRaw] = useState('')
  const [runtimeHints, setRuntimeHints] = useState<RuntimeHintsDraft>(EMPTY_RUNTIME_HINTS)
  const [requiredTools, setRequiredTools] = useState<Set<string>>(() => new Set())

  function build() {
    const instructionBlocks = instructions
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    const requires = requiresFromTools(requiredTools)
    const hints = draftToRuntimeHints(runtimeHints)
    return createSkillAction({
      name,
      displayName: displayName.trim() || null,
      description,
      kind,
      requiredSystemRole,
      content: {
        instructions: instructionBlocks,
        triggerKeywords: parseTriggerKeywords(triggerKeywordsRaw),
        parameters: parseParameters(parametersRaw),
        ...(hints ? { runtimeHints: hints } : {}),
      },
      requires,
    })
  }

  return (
    <div className="max-w-4xl">
      <p className="mb-3 text-xs text-ink-faint">
        Üres editor: strukturált mezők. Az instrukció-blokkokat üres sor választja el. A
        javasolt eszközöket pipáld ki — a grant külön admin-aktus.
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Skill neve (technikai azonosító)"
        className="w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
      />
      <input
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        maxLength={SKILL_NAME_MAX}
        placeholder="Megjelenített név (feladatválasztó, opcionális)"
        className="mt-2 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Rövid leírás (Level-0 index)"
        className="mt-2 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
      />
      <div className="mt-3">
        <SkillKindFields
          kind={kind}
          requiredSystemRole={requiredSystemRole}
          isPlatformAdmin={isPlatformAdmin}
          disabled={running}
          onChange={(next) => {
            setKind(next.kind)
            setRequiredSystemRole(next.requiredSystemRole)
          }}
        />
      </div>
      <textarea
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={6}
        placeholder="Instrukciók — üres sorral elválasztott blokkok"
        className="mt-2 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
      />
      <input
        value={triggerKeywordsRaw}
        onChange={(e) => setTriggerKeywordsRaw(e.target.value)}
        placeholder="triggerKeywords (vesszővel elválasztva, opcionális)"
        className="mt-2 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 font-mono text-xs"
      />
      <textarea
        value={parametersRaw}
        onChange={(e) => setParametersRaw(e.target.value)}
        rows={2}
        placeholder="parameters — soronként: név | leírás (opcionális)"
        className="mt-2 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 font-mono text-xs"
      />
      <div className="mt-2">
        <SkillRuntimeHintsFields draft={runtimeHints} onChange={setRuntimeHints} />
      </div>
      <div className="mt-2">
        <SkillRequiresToolPicker enabled={requiredTools} onChange={setRequiredTools} />
      </div>
      <button
        type="button"
        disabled={running || name.trim().length === 0 || instructions.trim().length === 0}
        onClick={() =>
          onRun(build, 'Skill létrehozva — proposed verzióként. Aktiváláshoz hagyd jóvá.')
        }
        className="mt-4 rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {running ? 'Létrehozás...' : 'Skill létrehozása'}
      </button>
    </div>
  )
}

'use client'

import { useRouter } from 'next/navigation'
import {
  Component,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { captureException } from '@/lib/observability'
import {
  importSkillMdAction,
  importSkillPackageAction,
  importSkillPackageVersionAction,
  listSkillCatalogAction,
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
import { formatToolUiName } from '@/lib/tool-ui-labels'
import {
  SKILL_KIND_COPY,
  resolveSkillKind,
  skillCatalogListPresentation,
  type SkillKind,
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
    <div className={disabled ? 'pointer-events-none opacity-50' : ''}>
      <div className="grid gap-3 sm:grid-cols-3">
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

/** Level-2 melléklet szerkesztés alatti alakja — bytes/sha256 szerveroldalon készül. */
type AttachmentDraft = { path: string; text: string }

function skillVersionExportPath(skill: SkillCatalogEntry, versionId: string): string | null {
  const version = skill.versions.find((v) => v.id === versionId)
  if (!version) return null
  return `/api/control-plane/skills/versions/${version.id}/export`
}


/**
 * Feltöltési méret-plafon a böngészőben. Tükrözi a szerveroldali
 * `SKILL_ATTACHMENT_MAX_BYTES`-t; azt a konstanst nem importáljuk, mert a modulja
 * `node:crypto`-t húzna a kliens bundle-be (l. a skill-catalog teszt őrét).
 */
const ATTACHMENT_UPLOAD_MAX_BYTES = 128 * 1024

/** Egy melléklet-fájl olvasó nézete: alapból csukva, hogy a lista áttekinthető maradjon. */
function SkillAttachmentReader({ path, text }: { path: string; text: string }) {
  return (
    <details className="rounded-lg border border-ink-faint/20 bg-card/60 px-3 py-2">
      <summary className="cursor-pointer font-mono text-xs text-ink-soft">
        {path} <span className="text-ink-faint">({Math.ceil(text.length / 1024)} KB)</span>
      </summary>
      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-ink-faint/15 pt-2 font-mono text-[11px] leading-relaxed text-ink-soft">
        {text}
      </pre>
    </details>
  )
}

/**
 * A skillhez tartozó fájlok szerkesztése. Szöveges melléklet: referencia,
 * sablon, vagy futtatható szkript (`scripts/`). A platform a kódot nem futtatja —
 * MCP-n a kliens kapja meg a csomag részeként.
 */
function SkillAttachmentsEditor({
  attachments,
  onChange,
  disabled,
}: {
  attachments: AttachmentDraft[]
  onChange: (next: AttachmentDraft[]) => void
  disabled?: boolean
}) {
  const [uploadError, setUploadError] = useState<string | null>(null)

  function update(index: number, patch: Partial<AttachmentDraft>) {
    onChange(attachments.map((a, i) => (i === index ? { ...a, ...patch } : a)))
  }

  return (
    <div>
      {attachments.length === 0 ? (
        <p className="text-xs text-ink-faint">Ehhez a verzióhoz nem tartozik fájl.</p>
      ) : (
        <ul className="space-y-2">
          {attachments.map((a, i) => (
            <li key={i} className="rounded-lg border border-ink-faint/15 bg-card/60 p-2">
              <div className="flex items-center gap-2">
                <input
                  value={a.path}
                  onChange={(e) => update(i, { path: e.target.value })}
                  placeholder="pl. references/adokulcsok.md"
                  disabled={disabled}
                  className="min-w-0 flex-1 rounded border border-ink-faint/30 bg-transparent px-2 py-1 font-mono text-xs"
                />
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(attachments.filter((_, idx) => idx !== i))}
                  className="rounded-full border border-coral/40 px-2 py-1 text-[11px] font-medium text-coral disabled:opacity-50"
                >
                  Törlés
                </button>
              </div>
              <textarea
                value={a.text}
                onChange={(e) => update(i, { text: e.target.value })}
                rows={6}
                disabled={disabled}
                className="mt-2 w-full rounded border border-ink-faint/30 bg-transparent px-2 py-1 font-mono text-[11px]"
              />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...attachments, { path: '', text: '' }])}
          className="rounded-full border border-ink-faint/30 px-3 py-1 text-xs font-medium text-ink-soft disabled:opacity-50"
        >
          Üres fájl hozzáadása
        </button>
        <label className="cursor-pointer rounded-full border border-ink-faint/30 px-3 py-1 text-xs font-medium text-ink-soft hover:border-ink-soft hover:text-ink">
          Fájl feltöltése
          <input
            type="file"
            multiple
            accept=".md,.txt,.html,.htm,.csv,.json,.yaml,.yml,.xml,.py,.sh,.js,.ts,.rb,text/*"
            disabled={disabled}
            className="sr-only"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (picked.length === 0) return
              setUploadError(null)
              void (async () => {
                const loaded: AttachmentDraft[] = []
                for (const file of picked) {
                  if (file.size > ATTACHMENT_UPLOAD_MAX_BYTES) {
                    setUploadError(
                      `A(z) „${file.name}” túl nagy (max ${ATTACHMENT_UPLOAD_MAX_BYTES / 1024} KB).`,
                    )
                    continue
                  }
                  loaded.push({ path: file.name, text: await file.text() })
                }
                if (loaded.length > 0) onChange([...attachments, ...loaded])
              })()
            }}
          />
        </label>
        <span className="text-[11px] text-ink-faint">Szöveges fájl, max 128 KB / db.</span>
      </div>
      {uploadError && <p className="mt-2 text-[11px] text-coral">{uploadError}</p>}
    </div>
  )
}

/**
 * Csak-olvasó skill-nézet („Megnyitás”). Ugyanazt a verzió-részletet tölti, amit a
 * szerkesztő — de semmit nem ír, így operátor is megnézheti, mit csinál a skill.
 */
function SkillDetailPanel({ skill }: { skill: SkillCatalogEntry }) {
  const defaultVersionId =
    skill.versions.find((v) => v.status === 'active')?.id ?? skill.versions[0]?.id ?? ''
  const [versionId, setVersionId] = useState(defaultVersionId)
  const [detail, setDetail] = useState<SkillVersionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!versionId) return
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      const res = await getSkillVersionAction(versionId)
      if (cancelled) return
      setLoading(false)
      if (!res.success) {
        setDetail(null)
        setError(res.error)
        return
      }
      setDetail(res.data)
    })()
    return () => {
      cancelled = true
    }
  }, [versionId])

  return (
    <div className="space-y-5">
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-ink">Melyik verziót nézed?</span>
        <select
          value={versionId}
          onChange={(e) => setVersionId(e.target.value)}
          className="rounded-lg border border-ink-faint/30 bg-card px-2 py-1 text-sm"
        >
          {skill.versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.version} ({v.status})
            </option>
          ))}
        </select>
        {(() => {
          const exportPath = skillVersionExportPath(skill, versionId)
          return exportPath ? (
            <a
              href={exportPath}
              className="rounded-full border border-ink-faint/30 px-3 py-1 text-xs font-semibold text-ink-soft hover:border-ink-soft hover:text-ink"
            >
              ZIP letöltése
            </a>
          ) : null
        })()}
        {loading && <span className="text-xs text-ink-faint">Betöltés…</span>}
      </label>
      {error && <p className="text-sm text-coral">{error}</p>}
      {detail && (
        <div className="space-y-4">
          <FormSection
            title="Mit csinál"
            hint="Ezt a szöveget kapja meg az agent, amikor a skill elindul."
          >
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-faint/20 bg-card/70 p-3 text-xs leading-relaxed text-ink-soft">
              {detail.content.instructions.join('\n\n')}
            </pre>
          </FormSection>

          <FormSection title="Mikor és mivel fut">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-ink-faint">Indító kulcsszavak</dt>
                <dd className="mt-0.5 text-ink-soft">
                  {detail.content.triggerKeywords.length > 0
                    ? detail.content.triggerKeywords.join(', ')
                    : 'nincs — a leírás alapján választja ki az agent'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-ink-faint">Futási keret</dt>
                <dd className="mt-0.5 text-ink-soft">
                  {describeRuntimeHints(detail.content.runtimeHints) ?? 'platform alapértéke'}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium text-ink-faint">Szükséges eszközök</dt>
                <dd className="mt-0.5 text-ink-soft">
                  {detail.requires.length > 0
                    ? detail.requires.map((r) => formatToolUiName(r.toolName)).join(', ')
                    : 'nincs — csak instrukció'}
                </dd>
              </div>
              {detail.content.parameters.length > 0 && (
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium text-ink-faint">Bemenetek</dt>
                  <dd className="mt-0.5">
                    <ul className="space-y-0.5 text-ink-soft">
                      {detail.content.parameters.map((p) => (
                        <li key={p.name}>
                          <span className="font-mono text-xs">{p.name}</span>
                          {p.description ? ` — ${p.description}` : ''}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
            </dl>
          </FormSection>

          <FormSection
            title={`Fájlok a képességhez (${detail.attachments.length})`}
            hint="Az agent csak akkor olvassa be őket, ha munka közben szüksége van rájuk."
          >
            {detail.attachments.length === 0 ? (
              <p className="text-xs text-ink-faint">Ehhez a verzióhoz nem tartozik fájl.</p>
            ) : (
              <div className="space-y-2">
                {detail.attachments.map((a) => (
                  <SkillAttachmentReader key={a.path} path={a.path} text={a.text} />
                ))}
              </div>
            )}
          </FormSection>
        </div>
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
    <div className={disabled ? 'pointer-events-none opacity-50' : ''}>
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
 * A desztilláció (D14) a beszélgetés ⋯ menüjéből indul (munkaterület és lebegő chat).
 */
class SkillCatalogErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    captureException(error, { source: 'skill-catalog-manager' })
  }

  render() {
    if (this.state.error) {
      return (
        <p className="text-sm text-coral">
          A katalógus megjelenítése elhasalt: {this.state.error.message}
        </p>
      )
    }
    return this.props.children
  }
}

/** A skill-lap fülei: egyszerre egy téma látszik (részletek / verziók / új verzió). */
type SkillRowTab = 'details' | 'versions' | 'edit'

const INPUT_CLASS =
  'w-full rounded-lg border border-ink-faint/30 bg-card px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-coral focus:ring-2 focus:ring-coral/15'
const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono text-xs`

/** Egységes űrlapmező: látható címke + egy mondat magyarázat + vezérlő. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {hint ? <p className="text-xs leading-relaxed text-ink-faint">{hint}</p> : null}
      {children}
    </div>
  )
}

/** Űrlap-szakasz: cím + magyarázat, hogy a hosszú editorok ne legyenek mezők masszája. */
function FormSection({
  title,
  hint,
  children,
}: {
  title: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-4 rounded-xl border border-ink-faint/20 bg-card/50 p-4">
      <div>
        <h4 className="font-display text-sm font-semibold text-ink">{title}</h4>
        {hint ? <p className="mt-1 text-xs leading-relaxed text-ink-faint">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
        active
          ? 'border-coral text-ink'
          : 'border-transparent text-ink-faint hover:text-ink-soft'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * A skill saját lapja / az űrlapok külön rétegen. A lista mögötte érintetlen marad —
 * korábban minden panel a katalógus-dobozban nyílt ki, és egymásba folytak.
 */
export function FormAlert({ error, notice }: { error?: string | null; notice?: string | null }) {
  if (!error && !notice) return null
  return (
    <div className="space-y-2">
      {error ? (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          {notice}
        </p>
      ) : null}
    </div>
  )
}

function skillHasActiveVersion(skill: SkillCatalogEntry): boolean {
  return skill.versions.some((v) => v.status === 'active')
}

/** Egy katalógus-sor — aktív és inaktív listában is ugyanaz a megjelenés. */
function SkillCatalogRow({
  skill,
  isAdmin,
  isPlatformAdmin,
  inactive,
  onOpen,
}: {
  skill: SkillCatalogEntry
  isAdmin: boolean
  isPlatformAdmin: boolean
  inactive?: boolean
  onOpen: (skillId: string, tab: SkillRowTab) => void
}) {
  const canWriteSkill = isAdmin && (skill.catalogScope === 'tenant' || isPlatformAdmin)
  const { kind, label: kindLabel, tone: kindTone, versions } = skillCatalogListPresentation(skill)
  const latestVersion = versions[0]
  const hints = describeRuntimeHints(skill.runtimeHints)

  return (
    <li key={skill.id}>
      <div className="atelier-soft flex flex-col gap-3 p-4 transition-colors hover:border-coral/30 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => onOpen(skill.id, 'details')}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-base font-semibold tracking-tight text-ink">
              {skillDisplayLabel(skill)}
            </h3>
            {inactive ? (
              <Badge tone="neutral">inaktív</Badge>
            ) : latestVersion ? (
              <Badge tone={STATUS_TONE[latestVersion.status] ?? 'neutral'}>
                v{latestVersion.version} · {latestVersion.status}
              </Badge>
            ) : null}
            <Badge tone={kindTone}>{kindLabel}</Badge>
            {kind === 'system' ? <Badge tone="neutral">system</Badge> : null}
          </div>
          <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-ink-soft">
            {skill.description}
          </p>
          <p className="mt-1.5 text-xs text-ink-faint">
            {versions.length} verzió
            {!inactive && latestVersion?.signed ? ' · aláírt' : ''}
            {latestVersion
              ? ` · ${new Date(latestVersion.createdAt).toLocaleDateString('hu-HU')}`
              : ''}
            {hints ? ` · ${hints}` : ''}
          </p>
        </button>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onOpen(skill.id, 'details')}
            className="rounded-full border border-ink-faint/30 px-3 py-1.5 text-xs font-semibold text-ink-soft hover:border-ink-soft hover:text-ink"
          >
            Megnyitás
          </button>
          {canWriteSkill && !inactive && (
            <button
              type="button"
              onClick={() => onOpen(skill.id, 'edit')}
              className="rounded-full border border-coral/35 bg-coral/8 px-3 py-1.5 text-xs font-semibold text-coral hover:bg-coral/15"
            >
              Új verzió
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

export function SkillModal({
  eyebrow,
  title,
  subtitle,
  tabs,
  onClose,
  error,
  notice,
  children,
}: {
  eyebrow: string
  title: ReactNode
  subtitle?: ReactNode
  tabs?: ReactNode
  onClose: () => void
  error?: string | null
  notice?: string | null
  children: ReactNode
}) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- portal mount gate
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mounted, onClose])

  if (!mounted) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-end justify-center bg-ink/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl border border-line bg-card shadow-2xl sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="shrink-0 border-b border-line px-4 pt-3 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-coral">
                {eyebrow}
              </p>
              <h2 id={titleId} className="mt-0.5 truncate font-display text-xl font-semibold text-ink">
                {title}
              </h2>
              {subtitle ? <div className="mt-1 text-xs text-ink-faint">{subtitle}</div> : null}
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-faint hover:bg-night-2 hover:text-ink"
              aria-label="Bezárás"
            >
              ✕
            </button>
          </div>
          {tabs ? (
            <div role="tablist" className="mt-3 flex gap-1 border-b border-line">
              {tabs}
            </div>
          ) : (
            <div className="h-3" />
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <FormAlert error={error} notice={notice} />
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function SkillCatalogManager(props: {
  skills: SkillCatalogEntry[]
  isAdmin: boolean
  isPlatformAdmin?: boolean
}) {
  return (
    <SkillCatalogErrorBoundary>
      <SkillCatalogManagerView {...props} />
    </SkillCatalogErrorBoundary>
  )
}

function SkillCatalogManagerView({
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
  /** A megnyitott skill saját lapja (modal); null = csak a lista látszik. */
  const [openSkillId, setOpenSkillId] = useState<string | null>(null)
  const [tab, setTab] = useState<SkillRowTab>('details')
  const [creationMode, setCreationMode] = useState<'import' | 'manual' | null>(null)
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogSkills, setCatalogSkills] = useState(skills)

  const normalizedCatalogQuery = catalogQuery.trim().toLocaleLowerCase('hu-HU')
  const filteredSkills = normalizedCatalogQuery
    ? catalogSkills.filter((skill) =>
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
    : catalogSkills
  const filteredActiveSkills = filteredSkills.filter(skillHasActiveVersion)
  const filteredInactiveSkills = filteredSkills.filter((s) => !skillHasActiveVersion(s))
  const activeSkillCount = catalogSkills.filter(skillHasActiveVersion).length
  const inactiveSkillCount = catalogSkills.length - activeSkillCount
  const modalOpen = Boolean(openSkillId || creationMode)

  function openSkill(skillId: string, nextTab: SkillRowTab) {
    setError(null)
    setNotice(null)
    setOpenSkillId(skillId)
    setTab(nextTab)
  }

  function openCreationMode(mode: 'import' | 'manual') {
    setError(null)
    setNotice(null)
    setCreationMode(mode)
  }

  async function refreshCatalog() {
    const refreshedCatalog = await listSkillCatalogAction()
    if (refreshedCatalog.success) setCatalogSkills(refreshedCatalog.data)
    router.refresh()
  }

  function run(
    fn: () => Promise<{ success: boolean; error?: string; data?: unknown }>,
    okMsg: string,
    onSuccess?: () => void | Promise<void>,
  ) {
    startTransition(async () => {
      setError(null)
      setNotice(null)
      const res = await fn()
      if (res.success) {
        const actionNotice =
          res.data && typeof res.data === 'object' && 'notice' in res.data
            ? (res.data as { notice?: unknown }).notice
            : null
        setNotice(typeof actionNotice === 'string' ? actionNotice : okMsg)
        const refreshedCatalog = await listSkillCatalogAction()
        if (refreshedCatalog.success) setCatalogSkills(refreshedCatalog.data)
        await onSuccess?.()
        router.refresh()
      } else {
        setError(res.error ?? 'Ismeretlen hiba.')
      }
    })
  }

  const current = openSkillId ? (catalogSkills.find((s) => s.id === openSkillId) ?? null) : null
  // Global skillt csak platform-admin írhat — a szerver is ezt kapuzza.
  const canWriteCurrent = Boolean(
    current && isAdmin && (current.catalogScope === 'tenant' || isPlatformAdmin),
  )
  const currentPresentation = current ? skillCatalogListPresentation(current) : null

  return (
    <div className="space-y-5">
      {!modalOpen && <FormAlert error={error} notice={notice} />}

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold tracking-tight">
              Katalógus · {activeSkillCount} aktív
              {inactiveSkillCount > 0 ? ` · ${inactiveSkillCount} inaktív` : ''}
            </h2>
            <p className="mt-1 text-sm text-ink-faint">
              Kattints egy képességre — a részletek, a verziók és a szerkesztés a saját
              lapján nyílnak meg.
            </p>
          </div>
          {isAdmin && (
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={() => openCreationMode('import')}
                className="rounded-full border border-ink-faint/35 bg-card px-4 py-2 text-sm font-semibold text-ink-soft transition-colors hover:border-ink-soft hover:text-ink"
              >
                Importálás
              </button>
              <button
                type="button"
                onClick={() => openCreationMode('manual')}
                className="rounded-full bg-coral px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-coral/90"
              >
                + Új képesség
              </button>
            </div>
          )}
        </div>

        {catalogSkills.length > 0 && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative block min-w-0 flex-1">
              <span className="sr-only">Keresés a képességek között</span>
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
                className={`${INPUT_CLASS} px-9`}
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
              {filteredSkills.length} / {catalogSkills.length} találat
            </p>
          </div>
        )}

        {catalogSkills.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-ink-faint/30 bg-night-2/30 px-4 py-8 text-center">
            <p className="text-sm font-medium text-ink-soft">Még nincs skill a katalógusban.</p>
            <p className="mt-1 text-xs text-ink-faint">
              {isAdmin
                ? 'Importálj egy SKILL.md fájlt, vagy hozz létre egyet kézzel.'
                : 'Admin tud skillt importálni vagy létrehozni.'}
            </p>
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-ink-faint/30 bg-night-2/30 px-4 py-7 text-center">
            <p className="text-sm font-medium text-ink-soft">Nincs egyező skill.</p>
            <p className="mt-1 text-xs text-ink-faint">
              Próbálj más keresőkifejezést, vagy töröld a szűrőt.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-6">
            {filteredActiveSkills.length > 0 ? (
              <ul className="space-y-2">
                {filteredActiveSkills.map((s) => (
                  <SkillCatalogRow
                    key={s.id}
                    skill={s}
                    isAdmin={isAdmin}
                    isPlatformAdmin={isPlatformAdmin}
                    onOpen={openSkill}
                  />
                ))}
              </ul>
            ) : (
              <div className="rounded-xl border border-dashed border-ink-faint/30 bg-night-2/30 px-4 py-6 text-center">
                <p className="text-sm font-medium text-ink-soft">Nincs aktív képesség a szűrésnek megfelelően.</p>
              </div>
            )}

            {filteredInactiveSkills.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-ink-soft">Inaktív képességek</h3>
                <p className="mt-1 text-xs text-ink-faint">
                  Deaktivált skillek — nem rendelhetők agenthez. A verzióelőzmény megmarad.
                </p>
                <ul className="mt-3 space-y-2">
                  {filteredInactiveSkills.map((s) => (
                    <SkillCatalogRow
                      key={s.id}
                      skill={s}
                      isAdmin={isAdmin}
                      isPlatformAdmin={isPlatformAdmin}
                      inactive
                      onOpen={openSkill}
                    />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>

      {current && currentPresentation && (
        <SkillModal
          eyebrow={currentPresentation.label}
          title={skillDisplayLabel(current)}
          subtitle={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono">{current.name}</span>
              <span>kockázat: {current.riskTier}</span>
              <span>forrás: {current.sourceType}</span>
              {current.license ? <span>licenc: {current.license}</span> : null}
            </span>
          }
          onClose={() => {
            setError(null)
            setNotice(null)
            setOpenSkillId(null)
          }}
          error={error}
          notice={notice}
          tabs={
            <>
              <TabButton active={tab === 'details'} onClick={() => setTab('details')}>
                Áttekintés
              </TabButton>
              <TabButton active={tab === 'versions'} onClick={() => setTab('versions')}>
                Verziók ({currentPresentation.versions.length})
              </TabButton>
              {canWriteCurrent && (
                <TabButton active={tab === 'edit'} onClick={() => setTab('edit')}>
                  Új verzió
                </TabButton>
              )}
            </>
          }
        >
          {tab === 'details' && <SkillDetailPanel skill={current} />}
          {tab === 'versions' && (
            <SkillVersionsPanel
              skill={current}
              canWrite={canWriteCurrent}
              isPlatformAdmin={isPlatformAdmin}
              pending={pending}
              onRun={run}
              onDeleted={() => setOpenSkillId(null)}
            />
          )}
          {tab === 'edit' && canWriteCurrent && (
            <EditSkillVersionForm
              skill={current}
              running={pending}
              onRun={run}
              onRefreshCatalog={refreshCatalog}
              onClose={() => setTab('versions')}
            />
          )}
        </SkillModal>
      )}

      {isAdmin && creationMode && (
        <SkillModal
          eyebrow="Új képesség"
          title={creationMode === 'import' ? 'Képesség importálása' : 'Képesség (skill) létrehozása'}
          subtitle="A képesség mindig javaslatként (proposed) jön létre — aktiválás külön jóváhagyással."
          onClose={() => {
            setError(null)
            setNotice(null)
            setCreationMode(null)
          }}
          tabs={
            <>
              <TabButton active={creationMode === 'import'} onClick={() => setCreationMode('import')}>
                Importálás (SKILL.md / ZIP)
              </TabButton>
              <TabButton active={creationMode === 'manual'} onClick={() => setCreationMode('manual')}>
                Kézi létrehozás
              </TabButton>
            </>
          }
        >
          {creationMode === 'import' ? (
            <ImportSkillForm
              onSuccess={() => setCreationMode(null)}
              onRefreshCatalog={refreshCatalog}
              isPlatformAdmin={isPlatformAdmin}
            />
          ) : (
            <CreateSkillForm
              onSuccess={() => setCreationMode(null)}
              onRefreshCatalog={refreshCatalog}
              isPlatformAdmin={isPlatformAdmin}
            />
          )}
        </SkillModal>
      )}
    </div>
  )
}

/** Verzióelőzmény, jóváhagyás/rollback, metaadat-szerkesztés és diff — egy helyen. */
function SkillVersionsPanel({
  skill,
  canWrite,
  isPlatformAdmin,
  pending,
  onRun,
  onDeleted,
}: {
  skill: SkillCatalogEntry
  canWrite: boolean
  isPlatformAdmin: boolean
  pending: boolean
  onRun: (
    fn: () => Promise<{ success: boolean; error?: string; data?: unknown }>,
    okMsg: string,
    onSuccess?: () => void | Promise<void>,
  ) => void
  onDeleted: () => void
}) {
  const [metaOpen, setMetaOpen] = useState(false)
  const versions = skill.versions

  return (
    <div className="space-y-5">
      <ul className="space-y-2">
        {versions.map((v) => {
          const exportPath = skillVersionExportPath(skill, v.id)
          return (
          <li
            key={v.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-faint/20 bg-card/50 px-3 py-2 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">v{v.version}</span>
              <Badge tone={STATUS_TONE[v.status] ?? 'neutral'}>{v.status}</Badge>
              {v.signed && <Badge tone="success">aláírt</Badge>}
              <span className="font-mono text-ink-faint">{v.contentHash.slice(0, 10)}…</span>
              <span className="text-ink-faint">
                {new Date(v.createdAt).toLocaleDateString('hu-HU')}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {exportPath ? (
                <a
                  href={exportPath}
                  className="rounded-full border border-ink-faint/30 px-3 py-1 font-medium text-ink-soft hover:border-ink-soft hover:text-ink"
                >
                  ZIP export
                </a>
              ) : null}
              {canWrite && (
                <>
                  {(v.status === 'proposed' || v.status === 'approved') && (
                    <>
                      <SkillVersionReviewButton versionId={v.id} />
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          onRun(
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
                        onRun(
                          () => rollbackSkillVersionAction(v.id),
                          `Visszaállítva a v${v.version} verzióra.`,
                        )
                      }
                      className="rounded-full border border-ink-faint/30 px-3 py-1 font-medium text-ink-soft disabled:opacity-50"
                    >
                      Visszaállítás
                    </button>
                  )}
                </>
              )}
            </div>
          </li>
          )
        })}
      </ul>

      {versions.length >= 2 && <SkillVersionDiffPanel skill={skill} running={pending} />}

      {canWrite && (
        <>
          <div className="rounded-xl border border-ink-faint/20 bg-card/50">
            <button
              type="button"
              aria-expanded={metaOpen}
              onClick={() => setMetaOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
            >
              <span>
                <span className="block text-sm font-semibold text-ink">
                  Név, fajta és leírás szerkesztése
                </span>
                <span className="mt-0.5 block text-xs text-ink-faint">
                  Ezek a skill egészére vonatkoznak — nem hoznak létre új verziót.
                </span>
              </span>
              <span className="shrink-0 text-ink-faint">{metaOpen ? '▲' : '▼'}</span>
            </button>
            {metaOpen && (
              <div className="border-t border-ink-faint/15 px-4 pb-4">
                <SkillDisplayNameEditor skill={skill} running={pending} onRun={onRun} />
                <SkillKindEditor
                  skill={skill}
                  running={pending}
                  onRun={onRun}
                  isPlatformAdmin={isPlatformAdmin}
                />
                <SkillDescriptionEditor skill={skill} running={pending} onRun={onRun} />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-coral/20 bg-coral/5 px-4 py-3">
            <p className="text-xs text-ink-soft">
              Veszélyes zóna — a deaktiválás leveszi az agentekről és inaktívvá teszi a skillt.
              A törlés végleges, és csak hozzárendelés nélkül lehetséges.
            </p>
            <div className="flex flex-wrap gap-2">
              {versions.some((v) => v.status === 'active') && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    onRun(
                      () => deactivateSkillAction(skill.id),
                      `„${skillDisplayLabel(skill)}” deaktiválva — lekerült az agentekről, nem rendelhető hozzá.`,
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
                      title: 'Képesség törlése',
                      description: `Biztosan törlöd a „${skillDisplayLabel(skill)}” képességet és az összes verzióját? Csak hozzárendelés nélkül lehetséges.`,
                      confirmLabel: 'Törlés',
                      tone: 'danger',
                    })
                    if (!confirmed) return
                    onRun(
                      () => deleteSkillAction(skill.id),
                      `„${skillDisplayLabel(skill)}” törölve a katalógusból.`,
                      onDeleted,
                    )
                  })()
                }}
                className="rounded-full border border-coral/40 px-3 py-1 text-xs font-medium text-coral disabled:opacity-50"
              >
                Törlés
              </button>
            </div>
          </div>
        </>
      )}
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

/** A verzió tartalma szerkesztés közben — a létrehozó és a szerkesztő űrlap közös alakja. */
type SkillContentDraft = {
  instructions: string
  triggerKeywordsRaw: string
  parametersRaw: string
  runtimeHints: RuntimeHintsDraft
  requiredTools: Set<string>
  attachments: AttachmentDraft[]
}

const EMPTY_CONTENT_DRAFT: SkillContentDraft = {
  instructions: '',
  triggerKeywordsRaw: '',
  parametersRaw: '',
  runtimeHints: EMPTY_RUNTIME_HINTS,
  requiredTools: new Set(),
  attachments: [],
}

function contentDraftFromDetail(detail: SkillVersionDetail): SkillContentDraft {
  return {
    instructions: detail.content.instructions.join('\n\n'),
    triggerKeywordsRaw: formatTriggerKeywords(detail.content.triggerKeywords),
    parametersRaw: formatParameters(detail.content.parameters),
    runtimeHints: runtimeHintsToDraft(detail.content.runtimeHints),
    requiredTools: new Set(detail.requires.map((r) => r.toolName)),
    // A mellékletek átöröklődnek az új verzióra — enélkül a szerkesztés csendben
    // elhagyná a csomagból importált fájlokat.
    attachments: detail.attachments.map((a) => ({ path: a.path, text: a.text })),
  }
}

/** Draft → szerver-payload (content + requires + attachments). */
function contentDraftPayload(draft: SkillContentDraft) {
  const hints = draftToRuntimeHints(draft.runtimeHints)
  return {
    content: {
      instructions: draft.instructions
        .split(/\n\s*\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      triggerKeywords: parseTriggerKeywords(draft.triggerKeywordsRaw),
      parameters: parseParameters(draft.parametersRaw),
      ...(hints ? { runtimeHints: hints } : {}),
    },
    requires: requiresFromTools(draft.requiredTools),
    attachments: draft.attachments
      .filter((a) => a.path.trim().length > 0)
      .map((a) => ({ path: a.path.trim(), text: a.text })),
  }
}

/** A verzió-tartalom mezői — ugyanaz a sorrend és szöveg új skillnél és új verziónál. */
function SkillContentFields({
  draft,
  onChange,
  disabled,
}: {
  draft: SkillContentDraft
  onChange: (next: SkillContentDraft) => void
  disabled?: boolean
}) {
  const set = (patch: Partial<SkillContentDraft>) => onChange({ ...draft, ...patch })

  return (
    <>
      <FormSection
        title="Mit csináljon a képesség?"
        hint="Ez a szöveg megy oda az agentnek, amikor a képesség elindul. Írd úgy, ahogy egy új kollégának magyaráznád el a feladatot."
      >
        <Field label="Instrukciók" hint="Az üres sorral elválasztott részekből külön lépés-blokk lesz.">
          <textarea
            value={draft.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            rows={10}
            disabled={disabled}
            placeholder={'Először kérdezd meg a partner nevét.\n\nUtána kérd le a CRM-ből az elmúlt 12 hónap rendeléseit.'}
            className={INPUT_CLASS}
          />
        </Field>
      </FormSection>

      <FormSection
        title="Mikor induljon, mit kérjen be"
        hint="Mindkettő elhagyható — ilyenkor az agent a leírás alapján dönt."
      >
        <Field
          label="Indító kulcsszavak"
          hint="Vesszővel elválasztva. Ha a felhasználó ezeket írja, az agent ezt a skillt választja."
        >
          <input
            value={draft.triggerKeywordsRaw}
            onChange={(e) => set({ triggerKeywordsRaw: e.target.value })}
            disabled={disabled}
            placeholder="havi report, hónapzáró jelentés, CEO-report"
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="Bemenetek" hint="Soronként egy: név | mire kell.">
          <textarea
            value={draft.parametersRaw}
            onChange={(e) => set({ parametersRaw: e.target.value })}
            rows={3}
            disabled={disabled}
            placeholder={'honap | melyik hónapról készüljön\npartner | a partner neve'}
            className={MONO_INPUT_CLASS}
          />
        </Field>
      </FormSection>

      <FormSection
        title="Futási keret"
        hint="Üresen hagyva a platform alapértéke érvényes (chatben ~180 mp / 60 eszközhívás). A skill csak emelheti a keretet, szűkíteni nem tudja."
      >
        <SkillRuntimeHintsFields
          draft={draft.runtimeHints}
          onChange={(runtimeHints) => set({ runtimeHints })}
          disabled={disabled}
        />
      </FormSection>

      <FormSection
        title="Javasolt eszközök"
        hint="Csak javaslat: a tényleges jogot az admin adja meg az agentnél. A skill szövege önmagában tehetetlen."
      >
        <SkillRequiresToolPicker
          enabled={draft.requiredTools}
          onChange={(requiredTools) => set({ requiredTools })}
          disabled={disabled}
        />
      </FormSection>

      <FormSection
        title={`Fájlok a képességhez (${draft.attachments.length})`}
        hint="Szöveges segédanyag: leírás, sablon, adat-táblázat. Az agent csak akkor olvassa be, ha munka közben szüksége van rá."
      >
        <SkillAttachmentsEditor
          attachments={draft.attachments}
          onChange={(attachments) => set({ attachments })}
          disabled={disabled}
        />
      </FormSection>
    </>
  )
}

export function EditSkillVersionForm({
  skill,
  running,
  onRun,
  onRefreshCatalog,
  onClose,
}: {
  skill: SkillCatalogEntry
  running: boolean
  onRun: (
    fn: () => Promise<{ success: boolean; error?: string }>,
    okMsg: string,
    onSuccess?: () => void | Promise<void>,
  ) => void
  onRefreshCatalog: () => Promise<void>
  onClose: () => void
}) {
  const [editMode, setEditMode] = useState<'manual' | 'zip'>('manual')
  const [zipPending, startZipTransition] = useTransition()
  const [zipError, setZipError] = useState<string | null>(null)
  const [archive, setArchive] = useState<File | null>(null)
  const [subpath, setSubpath] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const defaultVersionId =
    skill.versions.find((v) => v.status === 'active')?.id ?? skill.versions[0]?.id ?? ''
  const [sourceVersionId, setSourceVersionId] = useState(defaultVersionId)
  const [draft, setDraft] = useState<SkillContentDraft>(EMPTY_CONTENT_DRAFT)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (editMode !== 'manual' || !sourceVersionId) return
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
      setDraft(contentDraftFromDetail(res.data))
    })()

    return () => {
      cancelled = true
    }
  }, [editMode, sourceVersionId])

  function submitZip() {
    if (!archive) return
    startZipTransition(async () => {
      setZipError(null)
      const formData = new FormData()
      formData.set('skillId', skill.id)
      formData.set('archive', archive)
      formData.set('sourceUrl', sourceUrl)
      formData.set('subpath', subpath)
      const res = await importSkillPackageVersionAction(formData)
      if (res.success) {
        await onRefreshCatalog()
        onClose()
      } else {
        setZipError(res.error ?? 'Ismeretlen hiba.')
      }
    })
  }

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-honey/30 bg-honey/8 px-3 py-2 text-xs text-ink-soft">
        A mentés nem írja felül a mostani verziót: <em>javaslatként</em> (proposed) jön létre egy
        új verzió, amit a „Verziók” fülön kell jóváhagyni.
      </p>

      <Field label="Hogyan adjuk hozzá az új verziót?">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Új verzió forrása">
          {(
            [
              ['manual', 'Kézi szerkesztés'],
              ['zip', 'ZIP-csomag feltöltése'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={editMode === value}
              onClick={() => {
                setEditMode(value)
                setZipError(null)
              }}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                editMode === value
                  ? 'border-coral bg-coral/15 text-coral'
                  : 'border-ink-faint/30 text-ink-soft hover:border-ink-soft hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </Field>

      {editMode === 'manual' ? (
        <>
          <Field
            label="Miből induljunk ki?"
            hint="A választott verzió tartalma töltődik be az űrlapba — onnan szerkeszted tovább."
          >
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={sourceVersionId}
                onChange={(e) => setSourceVersionId(e.target.value)}
                className="rounded-lg border border-ink-faint/30 bg-card px-2 py-1.5 text-sm"
              >
                {skill.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version} ({v.status})
                  </option>
                ))}
              </select>
              {loading && <span className="text-xs text-ink-faint">Betöltés…</span>}
            </div>
          </Field>
          {loadError && <p className="text-sm text-coral">{loadError}</p>}

          <SkillContentFields draft={draft} onChange={setDraft} disabled={loading} />

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <button
              type="button"
              disabled={running || loading || draft.instructions.trim().length === 0}
              onClick={() =>
                onRun(
                  () =>
                    proposeSkillVersionAction({ skillId: skill.id, ...contentDraftPayload(draft) }),
                  'Új verzió javasolva. A „Verziók” fülön hagyd jóvá, hogy éles legyen.',
                  onClose,
                )
              }
              className="rounded-full bg-coral px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {running ? 'Mentés…' : 'Új verzió javaslása'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-sm font-medium text-ink-faint hover:text-ink"
            >
              Mégse
            </button>
          </div>
        </>
      ) : (
        <>
          <FormAlert error={zipError} />
          <FormSection
            title="ZIP-csomag"
            hint={`A csomag SKILL.md \`name\` mezője egyezzen a skill technikai nevével: ${skill.name}`}
          >
            <Field
              label="ZIP-csomag"
              hint="Egy SKILL.md fájl és opcionális szöveges referenciafájlok, legfeljebb 9 MB."
            >
              <input
                type="file"
                accept=".zip,application/zip"
                aria-label="Skill-verzió ZIP-csomag (legfeljebb 9 MB)"
                onChange={(event) => setArchive(event.target.files?.[0] ?? null)}
                className={`${INPUT_CLASS} file:mr-3 file:rounded-full file:border-0 file:bg-coral/15 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-coral`}
              />
            </Field>
            <Field
              label="Almappa a ZIP-en belül (opcionális)"
              hint="Csak akkor töltsd ki, ha a csomag több skillt tartalmaz."
            >
              <input
                value={subpath}
                aria-label="Skill almappája"
                onChange={(event) => setSubpath(event.target.value)}
                placeholder="skills/havi-report"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Forrás URL (opcionális)" hint="Honnan származik a csomag — az audit-nyomban látszik.">
              <input
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://…"
                className={INPUT_CLASS}
              />
            </Field>
          </FormSection>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <button
              type="button"
              disabled={zipPending || !archive}
              onClick={submitZip}
              className="rounded-full bg-coral px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {zipPending ? 'Feltöltés…' : 'ZIP importálása javaslatként'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-sm font-medium text-ink-faint hover:text-ink"
            >
              Mégse
            </button>
          </div>
        </>
      )}
    </div>
  )
}


function ImportSkillForm({
  onSuccess,
  onRefreshCatalog,
  isPlatformAdmin,
}: {
  onSuccess: () => void | Promise<void>
  onRefreshCatalog: () => Promise<void>
  isPlatformAdmin: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [formError, setFormError] = useState<string | null>(null)
  const [format, setFormat] = useState<'markdown' | 'zip'>('markdown')
  const [raw, setRaw] = useState('')
  const [archive, setArchive] = useState<File | null>(null)
  const [subpath, setSubpath] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [kind, setKind] = useState<SkillKind>('tenant')

  function submit() {
    startTransition(async () => {
      setFormError(null)
      const res =
        format === 'markdown'
          ? await importSkillMdAction({ raw, sourceUrl, kind })
          : await (async () => {
              const formData = new FormData()
              if (archive) formData.set('archive', archive)
              formData.set('sourceUrl', sourceUrl)
              formData.set('subpath', subpath)
              formData.set('kind', kind)
              return importSkillPackageAction(formData)
            })()
      if (res.success) {
        await onRefreshCatalog()
        await onSuccess()
      } else {
        setFormError(res.error ?? 'Ismeretlen hiba.')
      }
    })
  }

  return (
    <div className="space-y-4">
      <FormAlert error={formError} />
      <FormSection
        title="Honnan jön a képesség?"
        hint="A validátor elutasítja a prompt-injection mintákat, és futtatható fájlt nem enged be."
      >
        <Field label="Formátum">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Import formátuma">
            {(
              [
                ['markdown', 'Beillesztett SKILL.md szöveg'],
                ['zip', 'ZIP-csomag feltöltése'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={format === value}
                onClick={() => setFormat(value)}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                  format === value
                    ? 'border-coral bg-coral/15 text-coral'
                    : 'border-ink-faint/30 text-ink-soft hover:border-ink-soft hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>

        {format === 'markdown' ? (
          <Field
            label="SKILL.md tartalma"
            hint={
              <>
                YAML frontmatter (<code>name</code>, <code>title</code>, <code>description</code>) +
                markdown törzs.
              </>
            }
          >
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={10}
              placeholder="---&#10;name: havi-report&#10;title: Havi vezetői report&#10;description: ...&#10;---&#10;# Áttekintés"
              className={MONO_INPUT_CLASS}
            />
          </Field>
        ) : (
          <>
            <Field
              label="ZIP-csomag"
              hint="Egy SKILL.md fájl és opcionális szöveges referenciafájlok, legfeljebb 9 MB."
            >
              <input
                type="file"
                accept=".zip,application/zip"
                aria-label="Képesség ZIP-csomag (legfeljebb 9 MB)"
                onChange={(event) => setArchive(event.target.files?.[0] ?? null)}
                className={`${INPUT_CLASS} file:mr-3 file:rounded-full file:border-0 file:bg-coral/15 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-coral`}
              />
            </Field>
            <Field
              label="Almappa a ZIP-en belül (opcionális)"
              hint="Csak akkor töltsd ki, ha a csomag több skillt tartalmaz."
            >
              <input
                value={subpath}
                aria-label="Képesség almappája"
                onChange={(event) => setSubpath(event.target.value)}
                placeholder="skills/havi-report"
                className={INPUT_CLASS}
              />
            </Field>
          </>
        )}

        <Field label="Forrás URL (opcionális)" hint="Honnan származik a skill — az audit-nyomban látszik.">
          <input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://…"
            className={INPUT_CLASS}
          />
        </Field>
      </FormSection>

      <FormSection title="Ki használhatja?">
        <SkillKindFields
          kind={kind}
          isPlatformAdmin={isPlatformAdmin}
          disabled={pending}
          onChange={(next) => {
            setKind(next.kind)
          }}
        />
      </FormSection>

      <div className="border-t border-line pt-4">
        <button
          type="button"
          disabled={pending || (format === 'markdown' ? raw.trim().length === 0 : !archive)}
          onClick={submit}
          className="rounded-full bg-coral px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? 'Importálás…' : format === 'markdown' ? 'SKILL.md importálása' : 'ZIP importálása'}
        </button>
      </div>
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
  const propEpoch = `${skill.id}\0${skill.kind}`
  const [appliedEpoch, setAppliedEpoch] = useState(propEpoch)

  if (appliedEpoch !== propEpoch) {
    setAppliedEpoch(propEpoch)
    setKind(resolveSkillKind(skill.kind, skill.catalogScope))
  }

  const canEdit = isPlatformAdmin && skill.catalogScope === 'global'
  const dirty = kind !== skill.kind

  return (
    <div className="mt-3 space-y-2">
      <SkillKindFields
        name={`skill-kind-${skill.id}`}
        kind={kind}
        isPlatformAdmin={canEdit}
        disabled={running || !canEdit}
        disableKinds={skill.catalogScope === 'global' ? ['tenant'] : ['published', 'system']}
        onChange={(next) => {
          setKind(next.kind)
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
  const [appliedEpoch, setAppliedEpoch] = useState(propEpoch)

  // Prop-csere: üres props + meglévő committed = stale Prisma-read a refresh után — ne wipe-oljuk.
  if (appliedEpoch !== propEpoch) {
    setAppliedEpoch(propEpoch)
    if (propSaved.trim() || !committed.trim()) {
      setCommitted(propSaved)
      setValue(propSaved)
    }
  }

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
  const [appliedEpoch, setAppliedEpoch] = useState(propEpoch)

  if (appliedEpoch !== propEpoch) {
    setAppliedEpoch(propEpoch)
    setValue(saved)
  }

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
  onSuccess,
  onRefreshCatalog,
  isPlatformAdmin,
}: {
  onSuccess: () => void | Promise<void>
  onRefreshCatalog: () => Promise<void>
  isPlatformAdmin: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [formError, setFormError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<SkillKind>('tenant')
  const [draft, setDraft] = useState<SkillContentDraft>(EMPTY_CONTENT_DRAFT)

  function submit() {
    startTransition(async () => {
      setFormError(null)
      const res = await createSkillAction({
        name,
        displayName: displayName.trim() || null,
        description,
        kind,
        ...contentDraftPayload(draft),
      })
      if (res.success) {
        await onRefreshCatalog()
        await onSuccess()
      } else {
        setFormError(res.error ?? 'Ismeretlen hiba.')
      }
    })
  }

  return (
    <div className="space-y-4">
      <FormAlert error={formError} />
      <FormSection
        title="Alapadatok"
        hint="Ezt látja a felhasználó és az agent is, mielőtt a skill betöltődne."
      >
        <Field
          label="Technikai azonosító"
          hint="Kisbetű és kötőjel, később nem változtatható. Pl.: havi-vezetoi-report"
          htmlFor="new-skill-name"
        >
          <input
            id="new-skill-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="havi-vezetoi-report"
            className={MONO_INPUT_CLASS}
          />
        </Field>
        <Field
          label="Megjelenített név (opcionális)"
          hint="Ez jelenik meg a feladatválasztóban. Üresen hagyva a technikai nevet mutatjuk."
          htmlFor="new-skill-display-name"
        >
          <input
            id="new-skill-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={SKILL_NAME_MAX}
            placeholder="Havi vezetői report"
            className={INPUT_CLASS}
          />
        </Field>
        <Field
          label="Rövid leírás"
          hint="Egy-két mondat arról, mikor érdemes ezt a skillt választani."
          htmlFor="new-skill-description"
        >
          <textarea
            id="new-skill-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={SKILL_DESCRIPTION_MAX}
            rows={2}
            placeholder="Havi értékesítési report készítése a CRM adataiból, egyetlen nyomtatható HTML-ben."
            className={INPUT_CLASS}
          />
        </Field>
      </FormSection>

      <FormSection title="Ki használhatja?">
        <SkillKindFields
          kind={kind}
          isPlatformAdmin={isPlatformAdmin}
          disabled={pending}
          onChange={(next) => {
            setKind(next.kind)
          }}
        />
      </FormSection>

      <SkillContentFields draft={draft} onChange={setDraft} disabled={pending} />

      <div className="border-t border-line pt-4">
        <button
          type="button"
          disabled={pending || name.trim().length === 0 || draft.instructions.trim().length === 0}
          onClick={submit}
          className="rounded-full bg-coral px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? 'Létrehozás…' : 'Képesség (skill) létrehozása'}
        </button>
      </div>
    </div>
  )
}

'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  importSkillMdAction,
  createSkillAction,
  approveSkillVersionAction,
  rollbackSkillVersionAction,
  type SkillCatalogEntry,
} from '@/app/actions/skills'
import { Badge, Card } from '@/components/ui/shell'
import { Collapsible } from '@/components/ui/collapsible'

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  proposed: 'warning',
  approved: 'neutral',
  active: 'success',
  retired: 'neutral',
  rolled_back: 'danger',
}

/**
 * Skill-katalógus kezelő UI (skill-catalog-spec.md WP-6/7). Három szerzési forrásból
 * kettő (import + kézi) itt landol; mindkettő a hardcoded validátoron megy át és
 * `proposed` verzióként áll elő. A verziólista mutatja a write-gate állapotot, az
 * aláírást, és admin-jóváhagyást / rollbackot kínál. (A desztilláció — D14 — külön,
 * a beszélgetés felől indul.)
 */
export function SkillCatalogManager({
  skills,
  isAdmin,
}: {
  skills: SkillCatalogEntry[]
  isAdmin: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

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
        <div className="grid gap-6 lg:grid-cols-2">
          <ImportSkillForm running={pending} onRun={run} />
          <CreateSkillForm running={pending} onRun={run} />
        </div>
      )}

      <Card title={`Katalógus (${skills.length})`}>
        {skills.length === 0 ? (
          <p className="text-sm text-ink-faint">Még nincs skill a katalógusban.</p>
        ) : (
          <ul className="space-y-4">
            {skills.map((s) => (
              <li key={s.id} className="atelier-soft p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium text-ink">{s.name}</span>
                    <span className="ml-2 text-xs uppercase text-ink-faint">{s.riskTier}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{s.catalogScope}</Badge>
                    <Badge tone="neutral">{s.sourceType}</Badge>
                    {s.license && <Badge tone="neutral">{s.license}</Badge>}
                  </div>
                </div>
                <p className="mt-1 text-xs text-ink-soft">{s.description}</p>

                <ul className="mt-3 space-y-2">
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
                      {isAdmin && (
                        <div className="flex items-center gap-2">
                          {(v.status === 'proposed' || v.status === 'approved') && (
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
                          )}
                          {v.status !== 'active' && (
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
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function ImportSkillForm({
  running,
  onRun,
}: {
  running: boolean
  onRun: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
}) {
  const [raw, setRaw] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [scope, setScope] = useState<'tenant' | 'global'>('tenant')

  return (
    <Card title="Import — SKILL.md">
      <p className="mb-3 text-xs text-ink-faint">
        Illeszd be a <code>SKILL.md</code> tartalmát (YAML frontmatter + markdown törzs). A
        hardcoded validátor elutasítja a kódot (T2/T3) és a prompt-injection mintákat. A skill
        <em> proposed</em> verzióként jön létre; aktiválás külön jóváhagyással.
      </p>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={8}
        placeholder="---&#10;name: ...&#10;description: ...&#10;---&#10;# Áttekintés"
        className="w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 font-mono text-xs"
      />
      <input
        value={sourceUrl}
        onChange={(e) => setSourceUrl(e.target.value)}
        placeholder="Forrás URL (opcionális)"
        className="mt-2 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
      />
      <div className="mt-3 flex items-center gap-3">
        <Collapsible title="Hatókör" subtitle={scope === 'global' ? 'global (platform)' : 'tenant-lokális'}>
          <div className="flex gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={scope === 'tenant'}
                onChange={() => setScope('tenant')}
              />
              Tenant-lokális
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={scope === 'global'}
                onChange={() => setScope('global')}
              />
              Global (platform-admin)
            </label>
          </div>
        </Collapsible>
      </div>
      <button
        type="button"
        disabled={running || raw.trim().length === 0}
        onClick={() =>
          onRun(
            () => importSkillMdAction({ raw, sourceUrl, scope }),
            'Skill importálva — proposed verzióként. Aktiváláshoz hagyd jóvá.',
          )
        }
        className="mt-4 rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {running ? 'Importálás...' : 'Import'}
      </button>
    </Card>
  )
}

function CreateSkillForm({
  running,
  onRun,
}: {
  running: boolean
  onRun: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [requiresRaw, setRequiresRaw] = useState('')

  function build() {
    const instructionBlocks = instructions
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    const requires = requiresRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((toolName) => ({ toolName, reason: '' }))
    return createSkillAction({
      name,
      description,
      scope: 'tenant',
      content: { instructions: instructionBlocks, triggerKeywords: [], parameters: [] },
      requires,
    })
  }

  return (
    <Card title="Kézi szerzés">
      <p className="mb-3 text-xs text-ink-faint">
        Üres editor: strukturált mezők. Az instrukció-blokkokat üres sor választja el. A
        <code> requires</code> a javasolt eszközök vesszős listája — a grant külön admin-aktus.
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Skill neve"
        className="w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Rövid leírás (Level-0 index)"
        className="mt-2 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
      />
      <textarea
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={6}
        placeholder="Instrukciók — üres sorral elválasztott blokkok"
        className="mt-2 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
      />
      <input
        value={requiresRaw}
        onChange={(e) => setRequiresRaw(e.target.value)}
        placeholder="requires (pl. kb_search, xlsx_read_sheet)"
        className="mt-2 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 font-mono text-xs"
      />
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
    </Card>
  )
}

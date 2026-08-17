'use client'

import { useRef, useState } from 'react'
import { draftPlaybookFromDescription } from '@/app/actions/playbook'
import { PlaybookFieldHint } from '@/components/playbooks/playbook-field-hint'
import {
  SkillSlashMenu,
  useSkillSlashAutocomplete,
} from '@/components/skills/skill-slash-autocomplete'
import { useTenantSkillOptions } from '@/components/skills/use-tenant-skill-options'
import {
  syncPlaybookSpecInputSlots,
  type PlaybookDraftSpec,
  type PlaybookValidationResult,
} from '@/components/playbooks/playbook-spec-shared'

export type PlaybookAgentAssistScope = 'spec' | 'step' | 'gate'

function buildScopedDescription(
  scope: PlaybookAgentAssistScope,
  focusId: string | undefined,
  userText: string,
): string {
  const trimmed = userText.trim()
  if (scope === 'spec' || !focusId) return trimmed
  if (scope === 'step') {
    return (
      `Csak a(z) "${focusId}" lépést módosítsd a meglévő specen. ` +
      `A többi lépés, kapu, role, id és a folyamat struktúrája maradjon változatlan, ` +
      `hacsak a kérés kifejezetten mást nem kér.\n\nKérés: ${trimmed}`
    )
  }
  return (
    `Csak a(z) "${focusId}" kaput módosítsd a meglévő specen. ` +
    `A többi elem maradjon változatlan, hacsak a kérés kifejezetten mást nem kér.\n\nKérés: ${trimmed}`
  )
}

const PLACEHOLDERS: Record<PlaybookAgentAssistScope, string> = {
  spec: 'Pl.: Adj 60 perces timeoutot minden agent-lépéshez, és finomítsd a prompt sablonokat.',
  step: 'Pl.: Legyen formálisabb a prompt, és adj hozzá {{deadline}} trigger inputot.',
  gate: 'Pl.: Legyen L2 kritikusságú, four-eyes jóváhagyással.',
}

export function PlaybookAgentAssist({
  scope,
  focusId,
  focusLabel,
  spec,
  validation,
  onApply,
  compact = false,
}: {
  scope: PlaybookAgentAssistScope
  focusId?: string
  focusLabel?: string
  spec: PlaybookDraftSpec
  validation: PlaybookValidationResult
  onApply: (result: { spec: PlaybookDraftSpec; validation: PlaybookValidationResult }) => void
  compact?: boolean
}) {
  const [open, setOpen] = useState(compact)
  const [description, setDescription] = useState('')
  const [generating, setGenerating] = useState(false)
  const [statusText, setStatusText] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(
    null,
  )
  // Melyik skill leírását olvasta el az agent a tervezéshez — enélkül nem látszana,
  // hogy a javaslat egy meglévő, jóváhagyott munkamenet-leírásra épül-e.
  const [usedSkills, setUsedSkills] = useState<{ name: string; version: number }[]>([])

  // `/` a promptban → tenant skill-lista, ugyanaz a viselkedés, mint a chatben.
  // Csak nyitott dobozra töltünk (egy specen sok ilyen panel van).
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const tenantSkills = useTenantSkillOptions(open || !compact)
  const slash = useSkillSlashAutocomplete({
    skills: tenantSkills,
    value: description,
    onChange: setDescription,
    inputRef: promptRef,
    disabled: generating,
  })

  async function runAssist() {
    if (!description.trim()) return
    setMessage(null)
    setUsedSkills([])
    setGenerating(true)
    setStatusText('A Playbook-szerző agent elemzi és frissíti a specet…')
    try {
      const res = await draftPlaybookFromDescription({
        description: buildScopedDescription(scope, focusId, description),
        existingSpec: spec,
        priorValidation: validation,
      })
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error })
        return
      }
      const data = res.data as {
        spec: PlaybookDraftSpec
        validation: PlaybookValidationResult
        fixRounds?: number
        autoFixFailed?: boolean
        usedSkills?: { name: string; version: number }[]
      }
      const syncedSpec = syncPlaybookSpecInputSlots(data.spec)
      onApply({ spec: syncedSpec, validation: data.validation })
      setDescription('')
      setUsedSkills(data.usedSkills ?? [])

      if (data.autoFixFailed) {
        setMessage({
          tone: 'warn',
          text: 'Az agent 3 javítási kört futtatott, de maradtak validációs hibák — ellenőrizd a javaslatot.',
        })
      } else if ((data.fixRounds ?? 0) > 0 && data.validation.valid) {
        setMessage({
          tone: 'ok',
          text: `${data.fixRounds} automatikus javítási kör után a javaslat érvényes.`,
        })
      } else if (data.validation.valid) {
        setMessage({ tone: 'ok', text: 'Az agent javaslata alkalmazva — ellenőrizd, majd mentsd.' })
      } else {
        setMessage({
          tone: 'warn',
          text: 'A javaslat alkalmazva, de még vannak validációs hibák — javítsd vagy kérj újra.',
        })
      }
    } finally {
      setStatusText(null)
      setGenerating(false)
    }
  }

  const title =
    scope === 'spec'
      ? 'Playbook-szerző agent'
      : scope === 'step'
        ? `Agent segítség — lépés: ${focusLabel ?? focusId ?? ''}`
        : `Agent segítség — kapu: ${focusLabel ?? focusId ?? ''}`

  return (
    <div
      className={
        compact
          ? 'rounded-lg border border-ink/10 bg-paper/50 p-2 space-y-2'
          : 'rounded-lg border border-ink/10 bg-paper/40 p-3 space-y-2'
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className={`font-medium text-ink ${compact ? 'text-xs' : 'text-sm'}`}>{title}</p>
          {!compact && (
            <p className="text-xs text-ink-soft">
              Természetes nyelven írd le a módosítást — az agent javaslatot ad, de nem publikál.
              Meglévő skillre a <code>/</code> jellel hivatkozhatsz.
            </p>
          )}
          {compact && (
            <PlaybookFieldHint>
              Írd le szövegesen, mit szeretnél változtatni — az agent kitölti a mezőket, te ellenőrzöd
              és mented. Meglévő skillre a <code>/</code> jellel hivatkozhatsz: az agent elolvassa a
              skill teljes leírását, és ahhoz igazítja a lépést.
            </PlaybookFieldHint>
          )}
        </div>
        {compact && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded border border-ink/20 px-2 py-0.5 text-xs text-ink-soft"
          >
            {open ? 'Elrejt' : 'Megnyit'}
          </button>
        )}
      </div>

      {(open || !compact) && (
        <>
          <div className="relative">
            <textarea
              ref={promptRef}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value)
                slash.syncCursor(e.target)
                slash.setSelectedIndex(0)
              }}
              onSelect={(e) => slash.syncCursor(e.currentTarget)}
              onClick={(e) => slash.syncCursor(e.currentTarget)}
              onKeyUp={(e) => slash.syncCursor(e.currentTarget)}
              onKeyDown={(e) => slash.handleKeyDown(e)}
              rows={compact ? 2 : 3}
              placeholder={PLACEHOLDERS[scope]}
              disabled={generating}
              className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm disabled:opacity-50"
            />
            <SkillSlashMenu
              autocomplete={slash}
              emptyLabel="Ebben a szervezetben még nincs jóváhagyott skill."
            />
          </div>
          <button
            type="button"
            onClick={runAssist}
            disabled={generating || !description.trim()}
            className="rounded-lg border border-ink/20 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            {generating ? 'Agent dolgozik…' : 'Agent javaslat alkalmazása'}
          </button>
          {generating && statusText && (
            <div className="flex items-center gap-2 text-xs text-ink-soft">
              <svg className="h-3.5 w-3.5 animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                />
              </svg>
              {statusText}
            </div>
          )}
          {message && (
            <p
              className={`text-xs ${message.tone === 'err' ? 'text-coral' : message.tone === 'warn' ? 'text-honey' : 'text-sage'}`}
            >
              {message.text}
            </p>
          )}
          {usedSkills.length > 0 && (
            <p className="text-xs text-ink-soft">
              Az agent elolvasta ezt a skill-leírást és ehhez igazította a lépéseket:{' '}
              {usedSkills.map((s) => `${s.name} (v${s.version})`).join(', ')}.
            </p>
          )}
        </>
      )}
    </div>
  )
}

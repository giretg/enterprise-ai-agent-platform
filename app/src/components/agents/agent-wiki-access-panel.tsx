'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { setAgentWikiLinkAction } from '@/app/actions/knowledge-wiki'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Badge, Card } from '@/components/ui/shell'
import { errorKey } from '@/components/knowledge/wiki/knowledge-bases-list'

type Access = 'none' | 'read' | 'submit' | 'write'
type Mode = 'approval' | 'direct'

export type AgentWikiLinkRow = {
  connectorId: string
  kind: 'catalog' | 'agent' | 'shared' | 'private'
  own: boolean
  name: string
  template: 'general' | 'health-journal'
  access: Access
  writeMode: Mode
  collectFocus: string | null
  linked: boolean
  canEdit: boolean
  pageCount: number
}

const ACCESS_LEVELS: Access[] = ['none', 'read', 'submit', 'write']

export function AgentWikiAccessPanel({ agentId, rows }: { agentId: string; rows: AgentWikiLinkRow[] }) {
  const t = useTranslations('ControlPlane.wiki')
  return (
    <Card>
      <div className="mb-2 flex items-center">
        <h2 className="font-display text-lg font-semibold">{t('agent.title')}</h2>
        <HelpHint>{t('agent.help')}</HelpHint>
      </div>
      <p className="mb-4 max-w-2xl text-sm text-ink-soft">{t('agent.intro')}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-soft">{t('agent.empty')}</p>
      ) : (
        <ul className="space-y-3" data-testid="agent-wiki-links">
          {rows.map((row) => (
            <WikiLinkRow key={row.connectorId} agentId={agentId} row={row} />
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-ink-faint">
        {t('agent.publishNote')}{' '}
        <Link href={`/control-plane/agents/${agentId}?section=elesites`} className="font-medium text-coral">
          {t('agent.publishLink')}
        </Link>
      </p>
    </Card>
  )
}

function WikiLinkRow({ agentId, row }: { agentId: string; row: AgentWikiLinkRow }) {
  const t = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [access, setAccess] = useState<Access>(row.access)
  const [mode, setMode] = useState<Mode>(row.writeMode)
  const [focus, setFocus] = useState(row.collectFocus ?? '')
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const dirty = access !== row.access || mode !== row.writeMode || (focus.trim() || null) !== (row.collectFocus ?? null)
  const showsFocus = access === 'submit' || access === 'write'

  return (
    <li className="rounded-lg border border-line/70 p-3" data-testid={`agent-wiki-row-${row.connectorId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{row.name}</span>
        <Badge tone={row.kind === 'private' ? 'warning' : 'neutral'}>{row.own ? t('agent.own') : t(`kind.${row.kind}`)}</Badge>
        {row.template !== 'general' ? <Badge tone="neutral">{t(`templates.${row.template}.name`)}</Badge> : null}
        <span className="text-xs text-ink-faint">{t('agent.pages', { count: row.pageCount })}</span>
        <Link href={`/control-plane/knowledge/${row.connectorId}`} className="ml-auto text-xs text-coral-deep hover:underline">
          {t('agent.openWiki')}
        </Link>
      </div>
      <p className="mt-1 text-xs text-ink-faint" data-testid="agent-wiki-kind-hint">
        {t(`agent.kindHint.${row.own ? 'own' : row.kind}`)}
      </p>
      {!row.canEdit ? (
        <p className="mt-2 text-sm text-ink-soft">
          {t(`levels.${row.access}`)}
          {row.access === 'write' ? ` · ${t(`modes.${row.writeMode}`)}` : ''}
          <span className="block text-xs text-ink-faint">{row.kind === 'private' ? t('agent.privateOwnerOnly') : t('agent.adminOnly')}</span>
        </p>
      ) : (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            start(async () => {
              setMessage(null)
              const res = await setAgentWikiLinkAction({
                agentId,
                connectorId: row.connectorId,
                wikiAccess: access,
                ...(access === 'write' ? { wikiWriteMode: mode } : {}),
                wikiCollectFocus: showsFocus ? focus.trim() || null : null,
              })
              if (!res.success) {
                setMessage({ kind: 'error', text: t(`errors.${errorKey(res.error)}`) })
                return
              }
              setMessage({ kind: 'ok', text: t('agent.saved') })
              router.refresh()
            })
          }}
        >
          <div className="flex flex-wrap gap-4">
            <label className="text-sm">
              <span className="mb-1 flex items-center text-xs text-ink-faint">
                {t('agent.access')}
                <HelpHint>{t('agent.accessHelp')}</HelpHint>
              </span>
              <select
                value={access}
                onChange={(event) => setAccess(event.target.value as Access)}
                data-testid="agent-wiki-access"
                className="rounded-lg border border-line bg-paper px-3 py-1.5"
              >
                {ACCESS_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(`levels.${level}`)}
                  </option>
                ))}
              </select>
            </label>
            {access === 'write' ? (
              <label className="text-sm">
                <span className="mb-1 flex items-center text-xs text-ink-faint">
                  {t('agent.mode')}
                  <HelpHint>{t('agent.modeHelp')}</HelpHint>
                </span>
                <select
                  value={mode}
                  onChange={(event) => setMode(event.target.value as Mode)}
                  data-testid="agent-wiki-mode"
                  className="rounded-lg border border-line bg-paper px-3 py-1.5"
                >
                  <option value="approval">{t('modes.approval')}</option>
                  <option value="direct">{t('modes.direct')}</option>
                </select>
              </label>
            ) : null}
          </div>
          {access === 'write' && row.access !== 'write' ? (
            <p className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="agent-wiki-write-warning">
              {t('agent.writeWarning')}
            </p>
          ) : null}
          {showsFocus ? (
            <label className="block text-sm">
              <span className="mb-1 flex items-center text-xs text-ink-faint">
                {t('agent.collect')}
                <HelpHint>{t('agent.collectHelp')}</HelpHint>
              </span>
              <textarea
                value={focus}
                maxLength={2000}
                rows={2}
                onChange={(event) => setFocus(event.target.value)}
                placeholder={t(`agent.collectPlaceholder.${row.template}`)}
                data-testid="agent-wiki-collect"
                className="w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm"
              />
            </label>
          ) : null}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={pending || !dirty}
              data-testid="agent-wiki-save"
              className="rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? t('common.saving') : t('common.save')}
            </button>
            {message ? (
              <span className={`text-xs ${message.kind === 'ok' ? 'text-sage' : 'text-coral-deep'}`}>{message.text}</span>
            ) : null}
          </div>
        </form>
      )}
    </li>
  )
}

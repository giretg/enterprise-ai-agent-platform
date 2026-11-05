'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { setAgentWikiLinkAction } from '@/app/actions/knowledge-wiki'
import { useAgentKbCopy } from '@/components/agents/agent-kb-binding-summary'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Badge, Card } from '@/components/ui/shell'
import { errorKey } from '@/components/knowledge/wiki/knowledge-bases-list'

type Access = 'none' | 'read' | 'submit' | 'write'
type Mode = 'approval' | 'direct'

export type AgentWikiLinkRow = {
  connectorId: string
  kind: 'catalog' | 'agent' | 'shared' | 'private' | 'members'
  own: boolean
  name: string
  template: 'general' | 'health-journal'
  access: Access
  writeMode: Mode
  collectFocus: string | null
  linked: boolean
  canEdit: boolean
  sourceCount: number
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
      <p className="mb-3 max-w-2xl text-xs text-ink-faint">{t('agent.intro')}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-soft">{t('agent.empty')}</p>
      ) : (
        <ul className="space-y-2" data-testid="agent-wiki-links">
          {rows.map((row) => (
            <WikiLinkRow key={row.connectorId} agentId={agentId} row={row} />
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-ink-faint">
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
  const copy = useAgentKbCopy()(row)

  return (
    <li className="rounded-lg border border-line/70 px-3 py-2.5" data-testid={`agent-wiki-row-${row.connectorId}`}>
      <form
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
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm">
              <Link href={`/control-plane/knowledge/${row.connectorId}`} className="font-medium text-ink hover:text-coral-deep">
                {copy.title}
              </Link>
              {copy.kindLabel ? <span className="text-xs text-ink-faint">{copy.kindLabel}</span> : null}
              {row.template !== 'general' ? <Badge tone="neutral">{t(`templates.${row.template}.name`)}</Badge> : null}
              <HelpHint>{copy.help}</HelpHint>
            </p>
            <p className="mt-0.5 text-xs text-ink-faint">{copy.contents}</p>
          </div>
          {row.canEdit ? (
            <select
              aria-label={t('agent.access')}
              value={access}
              onChange={(event) => setAccess(event.target.value as Access)}
              data-testid="agent-wiki-access"
              className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm"
            >
              {ACCESS_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(`levels.${level}`)}
                </option>
              ))}
            </select>
          ) : (
            <p className="flex items-center text-sm text-ink-soft">
              {t(`levels.${row.access}`)}
              {row.access === 'write' ? ` · ${t(`modes.${row.writeMode}`)}` : ''}
              <HelpHint>
                {row.kind === 'private' ? t('agent.privateOwnerOnly') : row.kind === 'members' ? t('agent.membersOwnerOnly') : t('agent.adminOnly')}
              </HelpHint>
            </p>
          )}
        </div>
        {row.canEdit && (showsFocus || dirty) ? (
          <div className="mt-3 space-y-3 border-t border-line/50 pt-3">
            {access === 'write' ? (
              <label className="block text-sm">
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
            {dirty ? (
              <button
                type="submit"
                disabled={pending}
                data-testid="agent-wiki-save"
                className="rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {pending ? t('common.saving') : t('common.save')}
              </button>
            ) : null}
          </div>
        ) : null}
        {message ? (
          <p className={`mt-2 text-xs ${message.kind === 'ok' ? 'text-sage' : 'text-coral-deep'}`}>{message.text}</p>
        ) : null}
      </form>
    </li>
  )
}

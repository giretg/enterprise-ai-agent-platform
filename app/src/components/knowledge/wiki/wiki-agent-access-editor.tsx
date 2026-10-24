'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { setAgentWikiLinkAction } from '@/app/actions/knowledge-wiki'
import { Card } from '@/components/ui/shell'
import { errorKey } from './knowledge-bases-list'

type Access = 'none' | 'read' | 'submit' | 'write'
type Mode = 'approval' | 'direct'

export type WikiAgentAccessRow = {
  agentId: string
  agentName: string
  access: Access
  writeMode: Mode
  own: boolean
  editable: boolean
}

const ACCESS_LEVELS: Access[] = ['none', 'read', 'submit', 'write']

/** „Kik férnek hozzá” fül: munkatárs-jogok a tudásbázis felől, soronkénti mentéssel. */
export function WikiAgentAccessEditor({
  connectorId,
  canEdit,
  rows,
}: {
  connectorId: string
  canEdit: boolean
  rows: WikiAgentAccessRow[]
}) {
  const t = useTranslations('ControlPlane.wiki')
  return (
    <Card title={t('access.title')}>
      <p className="mb-3 max-w-2xl text-sm text-ink-soft">{canEdit ? t('access.introEdit') : t('access.intro')}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-soft">{canEdit ? t('access.noAgents') : t('access.empty')}</p>
      ) : (
        <table className="w-full text-sm" data-testid="wiki-access-table">
          <thead>
            <tr className="text-left text-xs text-ink-faint">
              <th className="py-1 pr-3 font-medium">{t('access.agent')}</th>
              <th className="py-1 pr-3 font-medium">{t('access.level')}</th>
              <th className="py-1 pr-3 font-medium">{t('access.mode')}</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <AccessRow key={row.agentId} connectorId={connectorId} row={row} canEdit={canEdit && row.editable} />
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-ink-faint">{canEdit ? t('access.publishNote') : t('access.howToChange')}</p>
    </Card>
  )
}

function AccessRow({ connectorId, row, canEdit }: { connectorId: string; row: WikiAgentAccessRow; canEdit: boolean }) {
  const t = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [access, setAccess] = useState<Access>(row.access)
  const [mode, setMode] = useState<Mode>(row.writeMode)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const dirty = access !== row.access || (access === 'write' && mode !== row.writeMode)

  const name = (
    <Link href={`/control-plane/agents/${row.agentId}?section=tudasbazis`} className="text-coral-deep hover:underline">
      {row.agentName}
    </Link>
  )

  if (!canEdit) {
    return (
      <tr className="border-t border-line/60 align-top">
        <td className="py-1.5 pr-3">{name}</td>
        <td className="py-1.5 pr-3">{t(`levels.${row.access}`)}</td>
        <td className="py-1.5 pr-3">{row.access === 'write' ? t(`modes.${row.writeMode}`) : '—'}</td>
        <td className="py-1.5" />
      </tr>
    )
  }

  return (
    <tr className="border-t border-line/60 align-top" data-testid={`wiki-access-row-${row.agentId}`}>
      <td className="py-1.5 pr-3">
        {name}
        {row.own ? <span className="ml-1 text-xs text-ink-faint">({t('access.ownKb')})</span> : null}
      </td>
      <td className="py-1.5 pr-3">
        <select
          value={access}
          onChange={(event) => setAccess(event.target.value as Access)}
          aria-label={t('access.level')}
          className="rounded-lg border border-line bg-paper px-2 py-1"
        >
          {ACCESS_LEVELS.map((level) => (
            <option key={level} value={level}>
              {t(`levels.${level}`)}
            </option>
          ))}
        </select>
      </td>
      <td className="py-1.5 pr-3">
        {access === 'write' ? (
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as Mode)}
            aria-label={t('access.mode')}
            className="rounded-lg border border-line bg-paper px-2 py-1"
          >
            <option value="approval">{t('modes.approval')}</option>
            <option value="direct">{t('modes.direct')}</option>
          </select>
        ) : (
          '—'
        )}
      </td>
      <td className="py-1.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={pending || !dirty}
            data-testid="wiki-access-save"
            onClick={() =>
              start(async () => {
                setMessage(null)
                const res = await setAgentWikiLinkAction({
                  agentId: row.agentId,
                  connectorId,
                  wikiAccess: access,
                  ...(access === 'write' ? { wikiWriteMode: mode } : {}),
                })
                if (!res.success) {
                  setMessage({ kind: 'error', text: t(`errors.${errorKey(res.error)}`) })
                  return
                }
                setMessage({ kind: 'ok', text: t('agent.saved') })
                router.refresh()
              })
            }
            className="rounded-lg bg-coral px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {pending ? t('common.saving') : t('common.save')}
          </button>
          {message ? (
            <span className={`text-xs ${message.kind === 'ok' ? 'text-sage' : 'text-coral-deep'}`}>{message.text}</span>
          ) : null}
        </div>
        {access === 'write' && row.access !== 'write' ? (
          <p className="mt-1 max-w-xs text-xs text-amber-900">{t('agent.writeWarning')}</p>
        ) : null}
      </td>
    </tr>
  )
}

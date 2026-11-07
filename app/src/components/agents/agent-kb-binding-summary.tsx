'use client'

import { useTranslations } from 'next-intl'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { wikiDisplayName } from '@/components/knowledge/wiki/wiki-format'
import { OpenInNewWindowLink } from '@/components/ui/open-in-new-window-link'

/** Egy munkatárs és egy tudásbázis kapcsolata. Egy tudásbázisban dokumentumok és a belőlük épült wiki is van. */
export type AgentKbBindingInfo = {
  connectorId: string
  kind: 'catalog' | 'agent' | 'shared' | 'private' | 'members' | 'public'
  /** A munkatárs saját tudásbázisa. Másik munkatársé is lehet `kind: 'agent'`, ekkor `own` hamis. */
  own: boolean
  /** `kind: 'agent'` esetén a tulajdonos munkatárs neve. */
  name: string
  /** Hatásos hozzáférés; `none` esetén a munkatárs sem a dokumentumokat, sem a wikit nem éri el. */
  access: 'none' | 'read' | 'submit' | 'write'
  writeMode: 'approval' | 'direct'
  sourceCount: number
  pageCount: number
}

export type AgentKbCopy = {
  title: string
  /** Üres, ha a cím már megmondja a fajtát. */
  kindLabel: string
  help: string
  contents: string
  /** Üres, ha a munkatárs nem éri el a tudásbázist. */
  rights: string
  unreachable: boolean
}

/** A szerviz tartalék neve, ha a tulajdonos munkatárs már nem található. */
const UNKNOWN_OWNER_NAME = 'Agent knowledge base'

/** Ugyanazt a címet és jogleírást adja a Konnektorok listának és a Wikik és jogok panelnek. */
export function useAgentKbCopy() {
  const t = useTranslations('ControlPlane.wiki')

  function identity(info: AgentKbBindingInfo): Pick<AgentKbCopy, 'title' | 'kindLabel'> {
    if (info.own) return { title: t('agent.own'), kindLabel: '' }
    if (info.kind === 'catalog') return { title: t('kind.catalog'), kindLabel: '' }
    if (info.kind === 'agent') {
      return {
        title:
          info.name === UNKNOWN_OWNER_NAME
            ? t('binding.agentTitleUnknown')
            : t('binding.agentTitle', { name: info.name }),
        kindLabel: t('binding.otherAgentKind'),
      }
    }
    if (info.kind === 'public') return { title: wikiDisplayName(t, info), kindLabel: t('kind.public') }
    return { title: info.name, kindLabel: t(`kind.${info.kind}`) }
  }

  function rights(info: AgentKbBindingInfo, accessMode?: 'read' | 'write'): string {
    if (info.access === 'none') return ''
    const wiki =
      info.access !== 'write'
        ? t(`levels.${info.access}`)
        : info.writeMode === 'direct'
          ? t('binding.writesDirectly')
          : t('binding.writesWithApproval')
    return accessMode === 'write' ? `${wiki} · ${t('binding.canUpload')}` : wiki
  }

  return (info: AgentKbBindingInfo, accessMode?: 'read' | 'write'): AgentKbCopy => ({
    ...identity(info),
    help: t(`agent.kindHint.${info.own ? 'own' : info.kind}`),
    contents:
      info.sourceCount === 0 && info.pageCount === 0
        ? t('binding.empty')
        : t('binding.contents', { documents: info.sourceCount, pages: info.pageCount }),
    rights: rights(info, accessMode),
    unreachable: info.access === 'none',
  })
}

export function KbBindingGroupHeader({ agentId }: { agentId: string }) {
  const t = useTranslations('ControlPlane.wiki.binding')
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h3 className="flex items-center text-sm font-semibold text-ink">
        {t('groupTitle')}
        <HelpHint>{t('groupHelp')}</HelpHint>
      </h3>
      <OpenInNewWindowLink href={rightsHref(agentId)} className="text-xs font-medium text-ink-soft hover:text-ink">
        {t('manageRights')}
      </OpenInNewWindowLink>
    </div>
  )
}

/** Halk információs sor a cím alatt; elérhetetlen kapcsolatnál kimondja az okot és a teendőt. */
export function KbBindingStatusLine({ agentId, copy }: { agentId: string; copy: AgentKbCopy }) {
  const t = useTranslations('ControlPlane.wiki.binding')
  return (
    <p className="mt-0.5 text-xs text-ink-faint">
      {copy.contents}
      {copy.rights ? ` · ${copy.rights}` : null}
      {copy.unreachable ? (
        <span className="mt-0.5 block font-medium text-amber-700">
          {t('unreachable')}{' '}
          <OpenInNewWindowLink href={rightsHref(agentId)} className="underline underline-offset-2 hover:text-ink">
            {t('fixAccess')}
          </OpenInNewWindowLink>
        </span>
      ) : null}
    </p>
  )
}

export function KbBindingIcon() {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-ink/10 bg-white text-ink-soft">
      <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
      </svg>
    </span>
  )
}

export function KbBindingOpenLink({ connectorId }: { connectorId: string }) {
  const t = useTranslations('ControlPlane.wiki.binding')
  return (
    <OpenInNewWindowLink href={`/control-plane/knowledge/${connectorId}`} className="text-xs font-medium text-coral hover:text-coral-deep">
      {t('open')}
    </OpenInNewWindowLink>
  )
}

function rightsHref(agentId: string): string {
  return `/control-plane/agents/${agentId}?section=tudasbazis`
}

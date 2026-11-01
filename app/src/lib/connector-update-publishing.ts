'use client'

import { confirmDialog } from '@/components/ui/confirm-dialog'
import { listConnectorAgentsForPublishing } from '@/app/actions/connector-publishing'
import { publishAgentDefinitionAction } from '@/app/actions/platform'
import { activateConnector as activate, updateGoogleAccountBinding as updateBinding } from '@/app/actions/provisioning'
import { approveMcpTools as approveMcp } from '@/app/actions/mcp-connectors'
import {
  approveSelfUpdatingVersion as approveVersion,
  rollbackSelfUpdatingVersion as rollbackVersion,
  syncSelfUpdatingConnector as sync,
} from '@/app/actions/self-updating-connectors'

async function offerPublishing(connectorId: string) {
  try {
    const result = await listConnectorAgentsForPublishing({ connectorId })
    if (!result.success) throw new Error(result.error)
    let remaining = result.data
    if (!remaining.length) return
    let description = `A kapcsolat módosítása elmentve. Az alábbi munkatársak használják:\n\n${remaining.map((agent) => `• ${agent.name}`).join('\n')}\n\nKözzéteszed őket most, hogy az új beállításokat használják? Ezzel az egyéb elmentett módosításaik is érvénybe lépnek.`
    while (remaining.length && await confirmDialog({
      title: 'Kapcsolódó munkatársak közzététele',
      description,
      confirmLabel: 'Közzététel',
      cancelLabel: 'Később',
    })) {
      const failures: string[] = []
      const failedAgents: typeof remaining = []
      // Publish sequentially: each agent gets its own audited, immutable version.
      for (const agent of remaining) {
        try {
          const published = await publishAgentDefinitionAction({ agentId: agent.id })
          if (!published.success) throw new Error(published.error)
        } catch (error) {
          failedAgents.push(agent)
          failures.push(`${agent.name}: ${error instanceof Error ? error.message : 'Nem sikerült a közzététel.'}`)
        }
      }
      remaining = failedAgents
      description = `A kapcsolat módosítása elmentve. Az alábbi munkatársak közzététele nem sikerült:\n\n${failures.join('\n')}\n\nÚjrapróbálod? A már sikeresen közzétett munkatársakat nem tesszük közzé újra.`
    }
  } catch (error) {
    await confirmDialog({
      title: 'A kapcsolat módosítása elmentve',
      description: error instanceof Error ? error.message : 'A munkatársak közzétételét a munkatársak oldalán tudod elvégezni.',
      confirmLabel: 'Rendben',
    })
  }
}

// Keep the saved connector result even if publication fails or is postponed.
export async function activateConnector(input: Parameters<typeof activate>[0]) {
  const result = await activate(input)
  if (result.success) await offerPublishing(result.data.connectorId)
  return result
}

export async function updateGoogleAccountBinding(input: Parameters<typeof updateBinding>[0]) {
  const result = await updateBinding(input)
  if (result.success) await offerPublishing(result.data.connectorId)
  return result
}

export async function approveMcpTools<T extends { connectorId: string }>(input: T) {
  const result = await approveMcp(input)
  if (result.success) await offerPublishing(input.connectorId)
  return result
}

export async function approveSelfUpdatingVersion(input: { connectorId: string; versionId: string }) {
  const result = await approveVersion(input)
  if (result.success) await offerPublishing(input.connectorId)
  return result
}

export async function rollbackSelfUpdatingVersion(input: { connectorId: string; versionId: string }) {
  const result = await rollbackVersion(input)
  if (result.success) await offerPublishing(input.connectorId)
  return result
}

export async function syncSelfUpdatingConnector(input: { connectorId: string }) {
  const result = await sync(input)
  if (result.success && result.data.kind === 'proposed' && result.data.autoApproved) {
    await offerPublishing(input.connectorId)
  }
  return result
}

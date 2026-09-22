'use client'

import { useState, useTransition } from 'react'
import {
  decideConversationSkillProposalAction,
  reviseConversationSkillProposalAction,
} from '@/app/actions/conversation-skills'
import type { OpenConversationSkillListRow } from '@/repositories/postgres/conversation-skill-repository'
import { Card } from '@/components/ui/shell'

export function ConversationSkillProposals({
  proposals,
}: {
  proposals: OpenConversationSkillListRow[]
}) {
  const [rows, setRows] = useState(proposals)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <Card>
      <h2 className="font-display text-lg font-semibold tracking-tight">
        Jóváhagyásra vár ({rows.length})
      </h2>
      <p className="mt-1 text-sm text-ink-faint">
        Beszélgetésből beküldött skill. Csak tenant admin bírálja. Jóváhagyás után
        a megnevezett agenten él és be van kapcsolva.
      </p>
      {error ? <p className="mt-3 text-sm text-coral">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm text-ink-soft">{notice}</p> : null}
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-faint">Nincs jóváhagyásra váró skill.</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {rows.map((proposal) => (
            <li key={proposal.id}>
              <ProposalCard
                proposal={proposal}
                onDone={(message) => {
                  setError(null)
                  setNotice(message)
                  setRows((current) => current.filter((row) => row.id !== proposal.id))
                }}
                onError={(message) => {
                  setNotice(null)
                  setError(message)
                }}
                onSaved={(next) => {
                  setError(null)
                  setNotice('Javaslat mentve.')
                  setRows((current) => current.map((row) => (row.id === next.id ? next : row)))
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function ProposalCard({
  proposal,
  onDone,
  onError,
  onSaved,
}: {
  proposal: OpenConversationSkillListRow
  onDone: (message: string) => void
  onError: (message: string) => void
  onSaved: (proposal: OpenConversationSkillListRow) => void
}) {
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState(proposal.name)
  const [description, setDescription] = useState(proposal.description)
  const [instructions, setInstructions] = useState(proposal.instructions)

  function save() {
    startTransition(async () => {
      const res = await reviseConversationSkillProposalAction({
        proposalId: proposal.id,
        name,
        description,
        instructions,
      })
      if (!res.success) {
        onError(res.error ?? 'A mentés sikertelen.')
        return
      }
      onSaved({ ...proposal, name, description, instructions })
    })
  }

  function decide(decision: 'approve' | 'reject') {
    startTransition(async () => {
      if (decision === 'approve') {
        const saved = await reviseConversationSkillProposalAction({
          proposalId: proposal.id,
          name,
          description,
          instructions,
        })
        if (!saved.success) {
          onError(saved.error ?? 'A mentés sikertelen.')
          return
        }
      }
      const res = await decideConversationSkillProposalAction({
        proposalId: proposal.id,
        decision,
      })
      if (!res.success) {
        onError(res.error ?? 'A bírálat sikertelen.')
        return
      }
      const missing = res.data.missingTools ?? []
      onDone(
        decision === 'approve'
          ? `Jóváhagyva, bekapcsolva${missing.length > 0 ? `. Hiányzó eszközök: ${missing.join(', ')}` : '.'}`
          : 'Elutasítva. A skill nem használható, a név felszabadult.',
      )
    })
  }

  return (
    <div className="rounded-xl border border-ink-faint/20 p-4">
      <p className="text-xs text-ink-faint">
        {proposal.requestedByName} · {proposal.agentName} ·{' '}
        {new Date(proposal.updatedAt).toLocaleString('hu-HU')}
      </p>
      <label className="mt-3 block text-xs font-medium text-ink-faint" htmlFor={`proposal-name-${proposal.id}`}>
        Név
      </label>
      <input
        id={`proposal-name-${proposal.id}`}
        value={name}
        disabled={pending}
        onChange={(event) => setName(event.target.value)}
        className="mt-1 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-1.5 text-sm"
      />
      <label className="mt-3 block text-xs font-medium text-ink-faint" htmlFor={`proposal-description-${proposal.id}`}>
        Leírás
      </label>
      <textarea
        id={`proposal-description-${proposal.id}`}
        value={description}
        disabled={pending}
        rows={2}
        onChange={(event) => setDescription(event.target.value)}
        className="mt-1 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
      />
      <label className="mt-3 block text-xs font-medium text-ink-faint" htmlFor={`proposal-instructions-${proposal.id}`}>
        Instrukció
      </label>
      <textarea
        id={`proposal-instructions-${proposal.id}`}
        value={instructions}
        disabled={pending}
        rows={5}
        onChange={(event) => setInstructions(event.target.value)}
        className="mt-1 w-full rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
      />
      <div className="mt-3">
        <p className="text-xs font-medium text-ink-faint">Melléklet — a beküldött marad</p>
        {proposal.attachments.length === 0 ? (
          <p className="mt-1 text-sm text-ink-faint">Nincs melléklet.</p>
        ) : (
          proposal.attachments.map((attachment) => (
            <pre
              key={attachment.path}
              className="mt-2 overflow-auto rounded-lg bg-night-2/40 p-3 text-xs text-ink-soft"
            >
              {attachment.path}
              {'\n'}
              {attachment.text}
            </pre>
          ))
        )}
      </div>
      <p className="mt-3 text-xs text-ink-faint">Agent: {proposal.agentName}. Jóváhagyáskor nem cserélhető.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={save}
          className="rounded-full border border-ink-faint/30 px-3 py-1 text-xs font-medium text-ink-soft disabled:opacity-50"
        >
          Mentés
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => decide('approve')}
          className="rounded-full bg-coral px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
        >
          Jóváhagyás
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => decide('reject')}
          className="rounded-full border border-coral/40 px-3 py-1 text-xs font-medium text-coral disabled:opacity-50"
        >
          Elutasítás
        </button>
      </div>
    </div>
  )
}

'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { isFileLikeSlot } from '@/lib/playbook-v2/trigger-input'
import {
  SkillSlashMenu,
  type SkillSlashAutocomplete,
} from '@/components/skills/skill-slash-autocomplete'
import {
  TaskScheduleFields,
  type TaskScheduleState,
} from '@/components/tickets/task-schedule-fields'
import type { PendingAttachment } from '@/components/agents/agent-chat-state'
import { AssignableWorkProjectSelect } from '@/components/work-projects/work-project-select'

export type AgentChatComposerMode = 'chat' | 'task' | 'process'

export type ChatProcessDefinition = {
  id: string
  name: string
  description: string | null
  slots: Array<{ name: string; type: string; required: boolean; description?: string }>
}

export type ChatSkillOption = {
  skillId: string
  skillVersionId: string
  name: string
  description: string
  allowAttachments: boolean
}

type AgentChatComposerProps = {
  embedded: boolean
  nickname: string
  archived: boolean
  statusMessage: string | null
  lastTicketId: string | null
  onOpenTicket: () => void
  attachmentWarningSkills: string[]
  attachments: PendingAttachment[]
  onRemoveAttachment: (id: string) => void
  onFilesSelected: (files: FileList | null) => void
  fileInputRef: RefObject<HTMLInputElement | null>
  mode: AgentChatComposerMode
  onModeChange: (mode: AgentChatComposerMode) => void
  disabled: boolean
  skills: ChatSkillOption[]
  slash: SkillSlashAutocomplete<ChatSkillOption>
  processes: ChatProcessDefinition[]
  selectedProcess: ChatProcessDefinition | null
  selectedProcessId: string | null
  processMissingFileAttachment: boolean
  onSelectProcess: (id: string | null) => void
  ticketSchedule: TaskScheduleState
  onTicketScheduleChange: (schedule: TaskScheduleState) => void
  input: string
  onInputChange: (value: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  turnBlocksComposer: boolean
  stopPending: boolean
  ticketPending: boolean
  pending: boolean
  canSubmit: boolean
  onStop: () => void
  onCreateTicket: () => void
  onSend: () => void
  projectKey: string
  onProjectKeyChange: (key: string) => void
}

function ProcessPicker({
  processes,
  selectedProcess,
  selectedProcessId,
  missingFile,
  disabled,
  onSelect,
}: Pick<
  AgentChatComposerProps,
  'processes' | 'selectedProcess' | 'selectedProcessId' | 'disabled'
> & {
  missingFile: boolean
  onSelect: (id: string | null) => void
}) {
  if (processes.length === 0) return null
  const requiredSlots = selectedProcess?.slots.filter((slot) => slot.required) ?? []
  const requiredFileSlots = requiredSlots.filter((slot) => isFileLikeSlot(slot.name))
  const requiredTextSlots = requiredSlots.filter((slot) => !isFileLikeSlot(slot.name))
  const instructions: string[] = []
  if (requiredFileSlots.length > 0) {
    instructions.push(
      missingFile
        ? `Csatolj fájlt a 📎 gombbal: ${requiredFileSlots.map((slot) => slot.description ? `${slot.name} (${slot.description})` : slot.name).join(', ')}`
        : `Fájl csatolva — ${requiredFileSlots.map((slot) => slot.name).join(', ')}`,
    )
  }
  if (requiredTextSlots.length > 0) {
    instructions.push(
      `Add meg üzenetben: ${requiredTextSlots.map((slot) => slot.description ? `${slot.name} (${slot.description})` : slot.name).join(', ')}`,
    )
  }

  return (
    <div className="mb-2 rounded-xl border border-sage/35 bg-sage/5 px-3 py-2.5">
      <p className="text-[11px] leading-snug text-ink-soft">
        Válassz folyamatot — a következő üzeneted vagy csatolmányod indítja el.
      </p>
      <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
        {processes.map((definition) => {
          const selected = definition.id === selectedProcessId
          return (
            <button
              key={definition.id}
              type="button"
              onClick={() => onSelect(selected ? null : definition.id)}
              disabled={disabled}
              className={`flex w-full flex-col rounded-lg px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                selected
                  ? 'border border-sage/50 bg-sage/15 ring-1 ring-sage/30'
                  : 'border border-transparent hover:bg-card'
              }`}
            >
              <span className="text-xs font-semibold text-ink">{definition.name}</span>
              {definition.description ? (
                <span className="line-clamp-2 text-[11px] leading-snug text-ink-faint">
                  {definition.description}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
      {selectedProcess ? (
        <p className="mt-2 rounded-lg border border-sage/30 bg-card/80 px-3 py-2 text-xs text-ink-soft">
          {requiredSlots.length === 0
            ? `A(z) „${selectedProcess.name}” folyamat indul a következő üzeneteddel.`
            : `A(z) „${selectedProcess.name}” folyamat indul. ${instructions.join(' · ')}`}
        </p>
      ) : null}
    </div>
  )
}

export function AgentChatComposer(props: AgentChatComposerProps) {
  const {
    embedded, nickname, archived, statusMessage, lastTicketId, onOpenTicket,
    attachmentWarningSkills, attachments, onRemoveAttachment, onFilesSelected,
    fileInputRef, mode, onModeChange, disabled, skills, slash, processes,
    selectedProcess, selectedProcessId, processMissingFileAttachment, onSelectProcess,
    ticketSchedule, onTicketScheduleChange, input, onInputChange, textareaRef, onKeyDown,
    turnBlocksComposer, stopPending, ticketPending, pending, canSubmit, onStop,
    onCreateTicket, onSend, projectKey, onProjectKeyChange,
  } = props
  const [plusOpen, setPlusOpen] = useState(false)
  const plusRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!plusOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (plusRef.current && !plusRef.current.contains(event.target as Node)) setPlusOpen(false)
    }
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setPlusOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [plusOpen])
  const modeOptions: Array<{ value: AgentChatComposerMode; label: string; hint: string }> = [
    { value: 'chat', label: 'Beszélgetés', hint: 'Az agent most válaszol.' },
    { value: 'task', label: 'Feladat', hint: 'Az üzenetből feladat lesz a táblán — akár időzítve.' },
    ...(processes.length > 0
      ? [{ value: 'process' as const, label: 'Folyamat', hint: 'A következő üzenet elindítja a folyamatot.' }]
      : []),
  ]

  return (
    <>
      {archived ? (
        <p className="mb-2 rounded-lg border border-line bg-night-2 px-3 py-2 text-xs text-ink-faint">
          Ez a szál archivált: elolvasható, de új üzenet nem fűzhető hozzá.
        </p>
      ) : null}
      {statusMessage ? (
        <p className="mb-2 text-xs text-ink-soft">
          {statusMessage}
          {lastTicketId ? (
            <>
              {' '}
              <Link
                href={`/control-plane/tickets/${lastTicketId}`}
                onClick={onOpenTicket}
                className="font-semibold text-coral hover:underline"
              >
                Feladat megnyitása →
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {attachmentWarningSkills.length > 0 ? (
        <p className="mb-3 rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-xs text-honey">
          A(z) {attachmentWarningSkills.join(', ')} képesség jellemzően nem fájlból dolgozik —
          a csatolmányt lehet, hogy figyelmen kívül hagyja.
        </p>
      ) : null}
      {attachments.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="group relative overflow-hidden rounded-xl border border-line bg-card">
              {attachment.kind === 'image' && attachment.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={attachment.previewUrl} alt={attachment.file.name} className="h-16 w-16 object-cover" />
              ) : (
                <div className="flex h-16 w-28 items-center justify-center px-2 text-xs text-ink-faint">
                  📎 {attachment.file.name}
                </div>
              )}
              <button
                type="button"
                onClick={() => onRemoveAttachment(attachment.id)}
                className="absolute right-1 top-1 rounded-full bg-ink/70 px-1.5 py-0.5 text-[10px] text-card hover:bg-ink"
                aria-label={`${attachment.file.name} eltávolítása`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {mode === 'process' ? (
        <ProcessPicker
          processes={processes}
          selectedProcess={selectedProcess}
          selectedProcessId={selectedProcessId}
          missingFile={processMissingFileAttachment}
          disabled={disabled}
          onSelect={onSelectProcess}
        />
      ) : null}
      {mode === 'task' ? (
        <div className="mb-2 rounded-xl border border-honey/35 bg-honey/5 px-3 py-2.5">
          <TaskScheduleFields state={ticketSchedule} disabled={disabled} onChange={onTicketScheduleChange} />
        </div>
      ) : null}

      <div className={`relative flex items-end gap-1.5 rounded-2xl border border-line p-1.5 shadow-sm focus-within:border-coral/40 focus-within:ring-2 focus-within:ring-coral/15 sm:gap-2 sm:p-2 ${embedded ? 'bg-paper' : 'bg-card'}`}>
        <SkillSlashMenu autocomplete={slash} emptyLabel="Ehhez az AI munkatárshoz nincs engedélyezett képesség hozzárendelve." position="above" className="left-12" />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.txt,.md,.csv,.json,.pdf,.doc,.docx"
          className="hidden"
          onChange={(event) => onFilesSelected(event.target.files)}
        />
        <div className="relative shrink-0" ref={plusRef}>
          <button
            type="button"
            onClick={() => setPlusOpen((open) => !open)}
            disabled={disabled}
            aria-expanded={plusOpen}
            aria-label="Üzenet beállításai: projekt, mód és képesség"
            title="Projekt, mód és képesség választása"
            className={`rounded-xl p-2.5 text-lg font-semibold leading-none disabled:opacity-40 ${
              plusOpen ? 'bg-night-2 text-ink' : 'text-ink-faint hover:bg-night-2'
            }`}
          >
            +
          </button>
          {plusOpen ? (
            <div className="absolute bottom-full left-0 z-40 mb-1.5 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-card p-2 shadow-xl">
              <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Projekt</p>
              <AssignableWorkProjectSelect
                id="agent-chat-project"
                value={projectKey}
                onChange={onProjectKeyChange}
                disabled={disabled}
              />
              <p className="px-1 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Mi legyen az üzenetből</p>
              <div className="flex flex-col gap-1" role="radiogroup" aria-label="Mi legyen az üzenetből">
                {modeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={mode === option.value}
                    title={option.hint}
                    onClick={() => {
                      onModeChange(option.value)
                      setPlusOpen(false)
                    }}
                    disabled={disabled}
                    className={`rounded-lg px-3 py-2 text-left text-xs font-semibold transition-colors disabled:opacity-40 ${
                      mode === option.value ? 'bg-night-2 text-ink shadow-sm' : 'text-ink-faint hover:bg-night-2 hover:text-ink-soft'
                    }`}
                  >
                    {option.label}
                    <span className="block text-[11px] font-normal text-ink-faint">{option.hint}</span>
                  </button>
                ))}
              </div>
              {skills.length > 0 ? (
                <>
                  <p className="px-1 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Képesség</p>
                  <div className="max-h-48 overflow-y-auto rounded-lg">
                    {skills.map((skill) => (
                      <button
                        key={skill.skillVersionId}
                        type="button"
                        onClick={() => {
                          slash.insertAtCursor(skill)
                          setPlusOpen(false)
                        }}
                        className="flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-night-2"
                      >
                        <span className="text-xs font-semibold text-ink">⚡ {skill.name}</span>
                        <span className="line-clamp-2 text-[11px] text-ink-faint">{skill.description}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={disabled} className="shrink-0 rounded-xl p-2.5 text-ink-faint hover:bg-night-2 disabled:opacity-40" aria-label="Fájl vagy kép csatolása">📎</button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => {
            onInputChange(event.target.value)
            slash.syncCursor(event.target)
            slash.setSelectedIndex(0)
          }}
          onSelect={(event) => slash.syncCursor(event.currentTarget)}
          onClick={(event) => slash.syncCursor(event.currentTarget)}
          onKeyUp={(event) => slash.syncCursor(event.currentTarget)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={mode === 'task' ? 'Mi legyen a feladat?' : mode === 'process' ? (selectedProcess ? 'Üzenet vagy csatolmány a folyamathoz…' : 'Előbb válassz folyamatot…') : `Üzenet ${nickname} részére…`}
          disabled={disabled}
          className="max-h-36 min-h-[44px] flex-1 resize-none bg-transparent px-1 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50"
        />
        {turnBlocksComposer ? (
          <button type="button" onClick={onStop} disabled={stopPending} className="shrink-0 rounded-xl border border-coral bg-card px-4 py-2.5 text-sm font-semibold text-coral disabled:opacity-50">
            {stopPending ? 'Megállítás…' : 'Megállítás'}
          </button>
        ) : mode === 'task' ? (
          <button type="button" onClick={onCreateTicket} disabled={!canSubmit} className="shrink-0 rounded-xl bg-honey px-4 py-2.5 text-sm font-semibold text-card disabled:opacity-40">
            {ticketPending ? '…' : ticketSchedule.mode !== 'none' ? 'Ütemezés' : 'Feladat létrehozása'}
          </button>
        ) : (
          <button type="button" onClick={onSend} disabled={!canSubmit} className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-semibold text-card disabled:opacity-40 ${mode === 'process' ? 'bg-sage' : 'bg-coral'}`}>
            {pending ? '…' : mode === 'process' ? 'Folyamat indítása' : 'Küldés'}
          </button>
        )}
      </div>
      {!embedded ? <p className="mt-1.5 px-1 text-[11px] text-ink-faint">Enter küld · Shift+Enter új sor{skills.length > 0 ? ' · / jellel skillt indítasz' : ''}</p> : null}
    </>
  )
}

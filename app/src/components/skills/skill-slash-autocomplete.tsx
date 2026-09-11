'use client'

/**
 * Skill slash-autocomplete — a chat komponerében megismert `/` menü kiemelve,
 * hogy MINDEN olyan beviteli mező használhassa, ahol egy skillre kell hivatkozni
 * (chat, Playbook-szerző prompt). A viselkedés-logika a már meglévő, tesztelt
 * `@/lib/skill/skill-slash-command` tiszta függvényeiből jön — itt csak a React
 * állapot és a menü megjelenítése él, hogy a felhasználó ugyanazt a `/` élményt
 * kapja mindenhol.
 */
import { useCallback, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import {
  appendSkillSlashToken,
  filterSkillsForSlashQuery,
  getActiveSlashQuery,
  insertSkillSlashToken,
  skillNameToSlashToken,
} from '@/lib/skill/skill-slash-command'

/** A menüben megjeleníthető minimális skill-alak (chat és katalógus is kielégíti). */
export interface SlashSkillOption {
  skillVersionId: string
  name: string
  description: string
}

export interface SkillSlashAutocomplete<T extends SlashSkillOption> {
  /** Nyitva van-e a menü (van aktív `/` kontextus és nincs letiltva). */
  open: boolean
  options: T[]
  /** Van-e egyáltalán elérhető skill — üres találat két okból lehet (nincs / nem illeszkedik). */
  hasSkills: boolean
  selectedIndex: number
  /** A szövegmező `onChange`/`onSelect`/`onKeyUp` eseményéhez — kurzor követés. */
  syncCursor: (target: HTMLTextAreaElement | HTMLInputElement) => void
  /** Nyitott menünél a nyilak/Enter/Tab lekezelve; `true` = az esemény elfogyott. */
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => boolean
  /** Egy találat beszúrása a `/` helyére. */
  applySelection: (skill: T) => void
  /** `/token` beszúrása a kurzorhoz `/` gépelés nélkül (skill-választó gomb). */
  insertAtCursor: (skill: T) => void
  setSelectedIndex: (index: number) => void
}

export function useSkillSlashAutocomplete<T extends SlashSkillOption>(params: {
  skills: T[]
  value: string
  onChange: (value: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null> | RefObject<HTMLInputElement | null>
  disabled?: boolean
}): SkillSlashAutocomplete<T> {
  const { skills, value, onChange, inputRef, disabled } = params
  const [cursor, setCursor] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  // Escape-pel elrejtett menü: annak a `/`-nek a pozíciója, amit a felhasználó
  // elutasított. Egy ÚJ `/` (más pozíció) menüje újra kinyílik.
  const [dismissedStart, setDismissedStart] = useState<number | null>(null)

  const slashContext = useMemo(() => getActiveSlashQuery(value, cursor), [value, cursor])
  const options = useMemo(
    () => (slashContext ? filterSkillsForSlashQuery(skills, slashContext.query) : []),
    [skills, slashContext],
  )
  const open = !disabled && slashContext !== null && slashContext.start !== dismissedStart

  const syncCursor = useCallback((target: HTMLTextAreaElement | HTMLInputElement) => {
    setCursor(target.selectionStart ?? 0)
  }, [])

  const applySelection = useCallback(
    (skill: T) => {
      if (!slashContext) return
      const next = insertSkillSlashToken({
        text: value,
        cursorPos: cursor,
        slashStart: slashContext.start,
        token: skillNameToSlashToken(skill.name),
      })
      onChange(next.text)
      setCursor(next.cursorPos)
      setSelectedIndex(0)
      setDismissedStart(null)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(next.cursorPos, next.cursorPos)
      })
    },
    [cursor, inputRef, onChange, slashContext, value],
  )

  const insertAtCursor = useCallback(
    (skill: T) => {
      const next = appendSkillSlashToken({
        text: value,
        cursorPos: cursor,
        token: skillNameToSlashToken(skill.name),
      })
      onChange(next.text)
      setCursor(next.cursorPos)
      setSelectedIndex(0)
      setDismissedStart(null)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(next.cursorPos, next.cursorPos)
      })
    },
    [cursor, inputRef, onChange, value],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): boolean => {
      if (!open || options.length === 0) return false
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((index) => Math.min(index + 1, options.length - 1))
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((index) => Math.max(index - 1, 0))
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const skill = options[selectedIndex]
        if (skill) applySelection(skill)
        return true
      }
      if (e.key === 'Escape') {
        // Csak a menüt csukjuk be, a szöveget és a kurzort nem bántjuk. Sem
        // preventDefault, sem stopPropagation: a befoglaló panel Escape-je
        // (pl. chat ablak bezárása) továbbra is a felhasználóé.
        setDismissedStart(slashContext?.start ?? null)
        return true
      }
      return false
    },
    [applySelection, open, options, selectedIndex, slashContext],
  )

  return {
    open,
    options,
    hasSkills: skills.length > 0,
    selectedIndex,
    syncCursor,
    handleKeyDown,
    applySelection,
    insertAtCursor,
    setSelectedIndex,
  }
}

/**
 * A `/` menü megjelenítése. A `position` a szövegmezőhöz képest: a chatben a
 * komponer FÖLÖTT nyílik ('above'), űrlapon a mező ALATT ('below').
 */
export function SkillSlashMenu<T extends SlashSkillOption>({
  autocomplete,
  emptyLabel,
  position = 'below',
  className = 'left-0',
}: {
  autocomplete: SkillSlashAutocomplete<T>
  /** Üzenet, ha egyáltalán nincs elérhető skill (nem csak a szűrő nem talált). */
  emptyLabel: string
  position?: 'above' | 'below'
  /** Vízszintes igazítás (a chat komponerében a menü a gombok mellé csúszik). */
  className?: string
}) {
  if (!autocomplete.open) return null
  const anchor = position === 'above' ? 'bottom-full mb-1' : 'top-full mt-1'
  return (
    <div
      role="listbox"
      aria-label="Képesség slash-parancsok"
      className={`absolute z-20 max-h-48 w-72 overflow-y-auto rounded-xl border border-line bg-card py-1 shadow-lg ${anchor} ${className}`}
    >
      {autocomplete.options.length === 0 ? (
        <p className="px-3 py-2 text-xs text-ink-faint">
          {autocomplete.hasSkills ? 'Nincs illeszkedő képesség.' : emptyLabel}
        </p>
      ) : (
        autocomplete.options.map((skill, index) => (
          <button
            key={skill.skillVersionId}
            type="button"
            role="option"
            aria-selected={index === autocomplete.selectedIndex}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => autocomplete.applySelection(skill)}
            className={`flex w-full flex-col px-3 py-2 text-left text-xs transition-colors ${
              index === autocomplete.selectedIndex
                ? 'bg-coral/10 text-coral-deep'
                : 'hover:bg-night-2'
            }`}
          >
            <span className="font-semibold">/{skillNameToSlashToken(skill.name)}</span>
            <span className="line-clamp-2 text-ink-faint">{skill.description}</span>
          </button>
        ))
      )}
    </div>
  )
}

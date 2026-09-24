'use client'

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

export type ConfirmTone = 'default' | 'danger'

export type ConfirmDialogOptions = {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmTone
}

export type PromptDialogOptions = ConfirmDialogOptions & {
  inputLabel?: string
  placeholder?: string
  /** Ha true, üres szöveggel nem lehet megerősíteni. Alapértelmezés: true. */
  required?: boolean
  maxLength?: number
  initialValue?: string
  multiline?: boolean
}

type PendingConfirm = {
  kind: 'confirm'
  options: ConfirmDialogOptions
  resolve: (value: boolean) => void
}

type PendingPrompt = {
  kind: 'prompt'
  options: PromptDialogOptions
  resolve: (value: string | null) => void
}

type PendingDialog = PendingConfirm | PendingPrompt

type ConfirmDialogStore = {
  pending: PendingDialog | null
  queue: PendingDialog[]
  listeners: Set<() => void>
}

const STORE_KEY = '__eaiConfirmDialogStore'

function getStore(): ConfirmDialogStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: ConfirmDialogStore }
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = {
      pending: null,
      queue: [],
      listeners: new Set(),
    }
  }
  return g[STORE_KEY]
}

function emit() {
  for (const listener of getStore().listeners) listener()
}

function subscribe(listener: () => void) {
  const store = getStore()
  store.listeners.add(listener)
  return () => {
    store.listeners.delete(listener)
  }
}

function getSnapshot() {
  return getStore().pending
}

function getServerSnapshot(): PendingDialog | null {
  return null
}

function enqueue(next: PendingDialog) {
  const store = getStore()
  if (store.pending) {
    store.queue.push(next)
  } else {
    store.pending = next
    emit()
  }
}

function settle() {
  const store = getStore()
  store.pending = store.queue.shift() ?? null
  emit()
}

/**
 * In-app megerősítő dialógus — a natív `window.confirm` helyett.
 * A `ConfirmDialogHost`-nak a fa valamelyik közös ősén mountolva kell lennie.
 */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    enqueue({ kind: 'confirm', options, resolve })
  })
}

/**
 * In-app szövegbekérő dialógus — a natív `window.prompt` helyett.
 * Mégse / Escape → `null`. Megerősítés → a begépelt szöveg (trimelve, ha required).
 */
export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    enqueue({ kind: 'prompt', options, resolve })
  })
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DialogChrome({
  titleId,
  descriptionId,
  title,
  description,
  tone,
  onDismiss,
  children,
  footer,
}: {
  titleId: string
  descriptionId?: string
  title: string
  description?: string
  tone: ConfirmTone
  onDismiss: () => void
  children?: ReactNode
  footer: ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-ink/50 p-4 backdrop-blur-[2px]"
      onClick={onDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="atelier-card w-full max-w-md overflow-hidden p-0 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          {tone === 'danger' ? (
            <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-coral/10 text-coral-deep">
              <WarningIcon className="h-5 w-5" />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="font-display text-lg font-semibold text-ink">
              {title}
            </h3>
            {description ? (
              <p id={descriptionId} className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {children ? <div className="px-5 pt-4">{children}</div> : null}
        <div className="flex flex-wrap justify-end gap-2 px-5 py-4">{footer}</div>
      </div>
    </div>
  )
}

function ActiveConfirmDialog({
  options,
  onResolve,
}: {
  options: ConfirmDialogOptions
  onResolve: (value: boolean) => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const tone = options.tone ?? 'default'
  const cancelLabel = options.cancelLabel ?? 'Mégse'
  const confirmLabel = options.confirmLabel ?? (tone === 'danger' ? 'Törlés' : 'Megerősít')

  useEffect(() => {
    const focusTarget = tone === 'danger' ? cancelRef.current : confirmRef.current
    focusTarget?.focus()
  }, [tone])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onResolve(false)
        return
      }
      if (event.key !== 'Tab') return
      const order = [cancelRef.current, confirmRef.current].filter(
        (node): node is HTMLButtonElement => node != null,
      )
      if (order.length < 2) return
      const first = order[0]!
      const last = order[order.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onResolve])

  return (
    <DialogChrome
      titleId={titleId}
      descriptionId={options.description ? descriptionId : undefined}
      title={options.title}
      description={options.description}
      tone={tone}
      onDismiss={() => onResolve(false)}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            onClick={() => onResolve(false)}
            className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:bg-night-2"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => onResolve(true)}
            className={
              tone === 'danger'
                ? 'rounded-full bg-coral px-4 py-2 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(43,80,255,0.6)] transition hover:bg-coral/90'
                : 'rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent/90'
            }
          >
            {confirmLabel}
          </button>
        </>
      }
    />
  )
}

function ActivePromptDialog({
  options,
  onResolve,
}: {
  options: PromptDialogOptions
  onResolve: (value: string | null) => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const inputId = useId()
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const [value, setValue] = useState(options.initialValue ?? '')
  const tone = options.tone ?? 'default'
  const required = options.required !== false
  const cancelLabel = options.cancelLabel ?? 'Mégse'
  const confirmLabel = options.confirmLabel ?? 'Megerősít'
  const trimmed = value.trim()
  const canConfirm = !required || trimmed.length > 0

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onResolve(null)
        return
      }
      if (event.key === 'Enter' && !options.multiline && canConfirm) {
        event.preventDefault()
        onResolve(trimmed)
        return
      }
      if (event.key !== 'Tab') return
      const order: HTMLElement[] = []
      if (inputRef.current) order.push(inputRef.current)
      if (cancelRef.current) order.push(cancelRef.current)
      if (confirmRef.current) order.push(confirmRef.current)
      if (order.length === 0) return
      const first = order[0]!
      const last = order[order.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canConfirm, onResolve, options.multiline, trimmed])

  const inputClassName =
    'w-full rounded-lg border border-line bg-night-2 px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-coral/40 focus:outline-none focus:ring-2 focus:ring-coral/20'

  return (
    <DialogChrome
      titleId={titleId}
      descriptionId={options.description ? descriptionId : undefined}
      title={options.title}
      description={options.description}
      tone={tone}
      onDismiss={() => onResolve(null)}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            onClick={() => onResolve(null)}
            className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:bg-night-2"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={!canConfirm}
            onClick={() => onResolve(trimmed)}
            className={
              tone === 'danger'
                ? 'rounded-full bg-coral px-4 py-2 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(43,80,255,0.6)] transition hover:bg-coral/90 disabled:opacity-50'
                : 'rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent/90 disabled:opacity-50'
            }
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {options.inputLabel ? (
        <label htmlFor={inputId} className="mb-1.5 block text-xs font-medium text-ink-soft">
          {options.inputLabel}
        </label>
      ) : (
        <label htmlFor={inputId} className="sr-only">
          {options.placeholder ?? 'Szöveg'}
        </label>
      )}
      {options.multiline ? (
        <textarea
          id={inputId}
          ref={inputRef as RefObject<HTMLTextAreaElement>}
          value={value}
          maxLength={options.maxLength}
          rows={3}
          placeholder={options.placeholder}
          className={inputClassName}
          onChange={(event) => setValue(event.target.value)}
        />
      ) : (
        <input
          id={inputId}
          ref={inputRef as RefObject<HTMLInputElement>}
          type="text"
          value={value}
          maxLength={options.maxLength}
          placeholder={options.placeholder}
          className={inputClassName}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
    </DialogChrome>
  )
}

/**
 * Globális host a `confirmDialog` / `promptDialog` hívásokhoz.
 * Mountold egyszer a közös layoutban (pl. AuthProviders mellett).
 */
export function ConfirmDialogHost() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client portal mount gate
    setMounted(true)
  }, [])

  if (!mounted || !current) return null

  const resolveConfirm = (value: boolean) => {
    if (current.kind !== 'confirm') return
    current.resolve(value)
    settle()
  }

  const resolvePrompt = (value: string | null) => {
    if (current.kind !== 'prompt') return
    current.resolve(value)
    settle()
  }

  return createPortal(
    current.kind === 'confirm' ? (
      <ActiveConfirmDialog key="confirm" options={current.options} onResolve={resolveConfirm} />
    ) : (
      <ActivePromptDialog key="prompt" options={current.options} onResolve={resolvePrompt} />
    ),
    document.body,
  )
}

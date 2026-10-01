'use client'

import { useRef, useState, useTransition } from 'react'
import { submitContactInquiry } from '@/app/actions/contact-inquiries'
import { Link } from '@/i18n/navigation'

export function ContactForm({
  copy,
}: {
  copy: {
    name: string
    phone: string
    email: string
    message: string
    namePlaceholder: string
    phonePlaceholder: string
    emailPlaceholder: string
    messagePlaceholder: string
    submit: string
    submitting: string
    success: string
    error: string
    privacy: string
    privacyLink: string
  }
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const [pending, startTransition] = useTransition()
  const [feedback, setFeedback] = useState<{ success: boolean; message: string } | null>(null)

  const inputClass = 'mt-1.5 w-full rounded-lg border border-line bg-white px-3.5 py-3 text-sm text-ink placeholder:text-ink-faint outline-none transition focus:border-coral/60 focus:ring-4 focus:ring-coral/10'
  const labelClass = 'block text-sm font-semibold text-ink'

  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        const values = new FormData(form)
        setFeedback(null)
        startTransition(async () => {
          const result = await submitContactInquiry({
            name: String(values.get('name') ?? ''),
            phone: String(values.get('phone') ?? ''),
            email: String(values.get('email') ?? ''),
            message: String(values.get('message') ?? ''),
            website: String(values.get('website') ?? ''),
          })
          if (result.success) {
            formRef.current?.reset()
            setFeedback({ success: true, message: copy.success })
          } else {
            setFeedback({ success: false, message: copy.error })
          }
        })
      }}
      className="space-y-5"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <label className={labelClass}>
          {copy.name} <span className="text-coral" aria-hidden>*</span>
          <input name="name" autoComplete="name" required minLength={2} maxLength={120} placeholder={copy.namePlaceholder} className={inputClass} />
        </label>
        <label className={labelClass}>
          {copy.phone} <span className="text-coral" aria-hidden>*</span>
          <input name="phone" type="tel" autoComplete="tel" required minLength={6} maxLength={40} placeholder={copy.phonePlaceholder} className={inputClass} />
        </label>
      </div>
      <label className={labelClass}>
        {copy.email} <span className="text-coral" aria-hidden>*</span>
        <input name="email" type="email" autoComplete="email" required maxLength={254} placeholder={copy.emailPlaceholder} className={inputClass} />
      </label>
      <label className={labelClass}>
        {copy.message} <span className="text-coral" aria-hidden>*</span>
        <textarea name="message" required minLength={10} maxLength={6000} rows={5} placeholder={copy.messagePlaceholder} className={`${inputClass} min-h-36 resize-y leading-relaxed`} />
      </label>
      <label aria-hidden="true" className="pointer-events-none absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
        Website
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>

      <div className="flex flex-col gap-4 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xs text-xs leading-relaxed text-ink-faint">
          {copy.privacy}{' '}
          <Link href="/privacy" className="font-medium text-ink-soft underline decoration-line underline-offset-2 hover:text-coral-deep">{copy.privacyLink}</Link>
        </p>
        <button
          type="submit"
          disabled={pending}
          className="signal-btn inline-flex min-h-12 items-center justify-center gap-3 rounded-lg border border-ink bg-ink px-5 py-3 text-sm font-semibold text-white [--sweep:var(--color-lime)] hover:text-ink disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? copy.submitting : copy.submit}
          {!pending && <span aria-hidden>↗</span>}
        </button>
      </div>
      {feedback && (
        <p role={feedback.success ? 'status' : 'alert'} className={`rounded-lg px-4 py-3 text-sm ${feedback.success ? 'border border-sage/20 bg-sage/5 text-sage' : 'border border-rose/20 bg-rose/5 text-rose'}`}>
          {feedback.message}
        </p>
      )}
    </form>
  )
}

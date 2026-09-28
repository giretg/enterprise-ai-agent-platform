'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { redeemInvitation } from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

export function RedeemInvitationForm({ initialToken }: { initialToken: string }) {
  const t = useTranslations('ControlPlane.redeem')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [token, setToken] = useState(initialToken)
  const [name, setName] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  return (
    <Card title={t('cardTitle')}>
      <div className="space-y-4">
        <label className="block text-sm text-ink-soft">
          {t('token')}
          <textarea
            value={token}
            onChange={(event) => setToken(event.target.value)}
            rows={4}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 font-mono text-xs text-ink"
          />
        </label>
        <label className="block text-sm text-ink-soft">
          {t('displayName')}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
            placeholder={t('namePlaceholder')}
          />
        </label>
        <button
          type="button"
          disabled={pending || !token.trim()}
          className="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(43,80,255,0.6)] disabled:opacity-50"
          onClick={() => {
            startTransition(async () => {
              const result = await redeemInvitation({
                token,
                name: name.trim() || undefined,
              })
              if (result.success) {
                setSuccess(true)
                setMessage(t('activated', { role: result.data.role ?? '' }))
                router.refresh()
              } else {
                setSuccess(false)
                setMessage(result.error)
              }
            })
          }}
        >
          {t('activate')}
        </button>
      </div>

      {message && (
        <div
          className={`mt-4 rounded-lg border p-3 text-sm ${
            success
              ? 'border-sage/35 bg-sage/10 text-sage'
              : 'border-coral/35 bg-coral/10 text-coral-deep'
          }`}
        >
          {message}
          {success && (
            <Link href="/control-plane" className="ml-2 font-semibold hover:underline">
              {t('continue')}
            </Link>
          )}
        </div>
      )}
    </Card>
  )
}

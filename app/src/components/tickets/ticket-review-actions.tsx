'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  cancelProcessFromReview,
  resolveProcessStepFromReview,
  retryProcessStepFromReview,
} from '@/app/actions/process'
import { WorkspaceFileDropzone } from '@/components/workspace/workspace-file-dropzone'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { Card } from '@/components/ui/shell'
import { uploadTicketWorkspaceFile } from '@/lib/ticket-workspace-files-client'

export type TicketReviewContext = {
  reviewTicketId: string
  stepId: string | null
  stepName: string | null
  stepTicketId: string | null
  canRetry: boolean
  requiredOutputFields: string[]
  currentOutputValues: Record<string, string>
  retryAttempt: number
  maxRetryAttempts: number
}

type Choice = 'retry' | 'accept' | 'cancel'

function ChoiceButton({
  active,
  title,
  hint,
  onClick,
  disabled,
}: {
  active: boolean
  title: string
  hint: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`flex-1 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        active
          ? 'border-honey/50 bg-honey/[0.1] shadow-[inset_0_0_0_1px_rgba(196,151,74,0.15)]'
          : 'border-line bg-card hover:border-honey/35 hover:bg-honey/[0.05]'
      }`}
    >
      <span className="block text-sm font-semibold text-ink">{title}</span>
      <span className="mt-0.5 block text-xs leading-snug text-ink-soft">{hint}</span>
    </button>
  )
}

/**
 * „Mi legyen ezzel a feladattal?" — az emberi felülvizsgálat lezárása.
 *
 * A felhasználónak nem állapotot kell állítania (az korábban a folyamatot
 * megkerülve írta a ticketet), hanem a három értelmes döntés közül választania.
 * Mindhárom a folyamat-állapotgépen megy át, és nyomot hagy az auditban.
 */
export function TicketReviewActions({
  review,
  canOverride,
  canCancel,
}: {
  review: TicketReviewContext
  canOverride: boolean
  canCancel: boolean
}) {
  const router = useRouter()
  const [choice, setChoice] = useState<Choice>('retry')
  const [clarification, setClarification] = useState('')
  const [values, setValues] = useState<Record<string, string>>(review.currentOutputValues)
  const [acceptNote, setAcceptNote] = useState('')
  const [cancelReason, setCancelReason] = useState('')
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const retriesLeft = Math.max(0, review.maxRetryAttempts - review.retryAttempt)
  const retryBlockedReason = !review.canRetry
    ? 'Ehhez a lépéshez nincs AI munkatárs rendelve, ezért nem indítható újra.'
    : retriesLeft === 0
      ? `Ez a lépés már ${review.retryAttempt} alkalommal futott újra a pontosításaid után. Több próbálkozás nem segít — fogadd el kézi kiegészítéssel, vagy állítsd le a folyamatot.`
      : null

  function uploadFile(file: File) {
    if (!review.stepTicketId) return
    setUploading(true)
    setMessage(null)
    void uploadTicketWorkspaceFile(review.stepTicketId, file)
      .then(() => setUploadedFiles((prev) => [...prev, file.name]))
      .catch((err: unknown) =>
        setMessage({
          tone: 'err',
          text: err instanceof Error ? err.message : 'A fájl feltöltése nem sikerült',
        }),
      )
      .finally(() => setUploading(false))
  }

  function submitRetry() {
    if (!clarification.trim()) {
      setMessage({ tone: 'err', text: 'Írd le, mit csináljon másképp az AI munkatárs.' })
      return
    }
    startTransition(async () => {
      const res = await retryProcessStepFromReview({
        reviewTicketId: review.reviewTicketId,
        clarification: clarification.trim(),
      })
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error })
        return
      }
      setMessage({
        tone: 'ok',
        text: 'A lépés újraindult a pontosításoddal. A folyamat innen magától megy tovább.',
      })
      setClarification('')
      router.refresh()
    })
  }

  function submitAccept() {
    const missing = review.requiredOutputFields.filter((field) => !values[field]?.trim())
    if (missing.length > 0) {
      setMessage({
        tone: 'err',
        text: `Ezek a mezők kellenek a következő lépésnek: ${missing.join(', ')}`,
      })
      return
    }
    startTransition(async () => {
      const res = await resolveProcessStepFromReview({
        reviewTicketId: review.reviewTicketId,
        outputPatch: values,
        note: acceptNote.trim() || undefined,
      })
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error })
        return
      }
      setMessage({ tone: 'ok', text: 'Elfogadva — a folyamat továbblép a következő lépésre.' })
      router.refresh()
    })
  }

  function submitCancel() {
    if (!cancelReason.trim()) {
      setMessage({ tone: 'err', text: 'A leállítás indoklása kötelező.' })
      return
    }
    startTransition(async () => {
      const confirmed = await confirmDialog({
        title: 'Leállítod a folyamatot?',
        description:
          'A futás visszavonásra kerül, és minden hozzá tartozó nyitott feladat lezárul. Ez nem vonható vissza.',
        confirmLabel: 'Leállítom',
      })
      if (!confirmed) return
      const res = await cancelProcessFromReview({
        reviewTicketId: review.reviewTicketId,
        reason: cancelReason.trim(),
      })
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error })
        return
      }
      setMessage({ tone: 'ok', text: 'A folyamat leállt, a nyitott feladatok lezárultak.' })
      router.refresh()
    })
  }

  return (
    <Card title="Mi legyen ezzel a feladattal?" className="border-honey/30 bg-honey/[0.04]">
      <p className="mb-3 text-sm text-ink-soft">
        A folyamat a(z){' '}
        <span className="font-medium text-ink">{review.stepName ?? 'megjelölt'}</span> lépésnél áll
        meg. Válaszd ki, hogyan menjen tovább — a döntésed a folyamaton is átvezetődik.
      </p>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <ChoiceButton
          active={choice === 'retry'}
          onClick={() => setChoice('retry')}
          title="Javítsd ki és futtasd újra"
          hint="Megmondod, mit csináljon másképp, és az AI munkatárs újrapróbálja."
        />
        <ChoiceButton
          active={choice === 'accept'}
          onClick={() => setChoice('accept')}
          title="Elfogadom, mehet tovább"
          hint="A hiányzó adatot te adod meg, a folyamat lép a következő lépésre."
          disabled={!canOverride}
        />
        <ChoiceButton
          active={choice === 'cancel'}
          onClick={() => setChoice('cancel')}
          title="Állítsuk le a folyamatot"
          hint="A futás véget ér, a nyitott feladatok lezárulnak."
          disabled={!canCancel}
        />
      </div>

      {choice === 'retry' && (
        <div>
          {retryBlockedReason ? (
            <p className="rounded-lg border border-coral/25 bg-coral/[0.06] p-3 text-sm text-coral">
              {retryBlockedReason}
            </p>
          ) : (
            <>
              <label
                htmlFor="review-clarification"
                className="mb-1 block text-sm font-medium text-ink"
              >
                Mit csináljon másképp?
              </label>
              <textarea
                id="review-clarification"
                value={clarification}
                onChange={(event) => setClarification(event.target.value)}
                rows={4}
                maxLength={8000}
                placeholder="Pl.: A válaszod végén add vissza a feldolgozottLapPath értékét is."
                className="w-full rounded-lg border border-line bg-night-2 p-3 text-sm text-ink"
              />
              <p className="mt-1 text-xs text-ink-faint">
                A szöveg bekerül a lépés feladat-szálába, és az AI munkatárs ezzel a kiegészítéssel
                fut újra. {retriesLeft} próbálkozás maradt.
              </p>

              {review.stepTicketId && (
                <div className="mt-3">
                  <p className="mb-1 text-sm font-medium text-ink">Hiányzó fájl pótlása</p>
                  <WorkspaceFileDropzone
                    disabled={pending}
                    uploading={uploading}
                    onFileSelected={uploadFile}
                  />
                  <p className="mt-1 text-xs text-ink-faint">
                    A feltöltött fájl a lépés munkaterületére kerül — az AI munkatárs ott találja meg.
                  </p>
                  {uploadedFiles.length > 0 && (
                    <p className="mt-1 text-xs text-sage">
                      Feltöltve: {uploadedFiles.join(', ')}
                    </p>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={submitRetry}
                disabled={pending || uploading}
                className="mt-3 rounded-full bg-honey px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-50"
              >
                {pending ? 'Indítás…' : 'Küldés és újrafuttatás'}
              </button>
            </>
          )}
        </div>
      )}

      {choice === 'accept' && (
        <div>
          {!canOverride ? (
            <p className="rounded-lg border border-line bg-card p-3 text-sm text-ink-soft">
              Ehhez jóváhagyói jogosultság kell — kérd meg a folyamat gazdáját.
            </p>
          ) : (
            <>
              {review.requiredOutputFields.length > 0 ? (
                <>
                  <p className="mb-2 text-sm text-ink">
                    A következő lépésnek ezekre az adatokra van szüksége. Ami hiányzik, azt itt add
                    meg:
                  </p>
                  <div className="space-y-2">
                    {review.requiredOutputFields.map((field) => (
                      <div key={field}>
                        <label
                          htmlFor={`review-field-${field}`}
                          className="mb-1 block font-mono text-xs text-ink-soft"
                        >
                          {field}
                        </label>
                        <input
                          id={`review-field-${field}`}
                          value={values[field] ?? ''}
                          onChange={(event) =>
                            setValues((prev) => ({ ...prev, [field]: event.target.value }))
                          }
                          className="w-full rounded-lg border border-line bg-night-2 p-2.5 text-sm text-ink"
                        />
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-ink">
                  Ehhez a lépéshez nincs kötelezően kitöltendő adat — az elfogadással a folyamat
                  egyszerűen továbbmegy.
                </p>
              )}
              <label htmlFor="review-accept-note" className="mb-1 mt-3 block text-sm font-medium text-ink">
                Indoklás (bekerül a naplóba)
              </label>
              <textarea
                id="review-accept-note"
                value={acceptNote}
                onChange={(event) => setAcceptNote(event.target.value)}
                rows={2}
                maxLength={4000}
                placeholder="Pl.: A fájl elkészült, kézzel ellenőriztem."
                className="w-full rounded-lg border border-line bg-night-2 p-3 text-sm text-ink"
              />
              <p className="mt-1 text-xs text-ink-faint">
                Az elfogadás átlépi a gépi hibajelzést, ezért a naplóba bekerül, hogy ki és mit
                fogadott el.
              </p>
              <button
                type="button"
                onClick={submitAccept}
                disabled={pending}
                className="mt-3 rounded-full bg-sage px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:brightness-95 disabled:opacity-50"
              >
                {pending ? 'Mentés…' : 'Elfogadás és továbblépés'}
              </button>
            </>
          )}
        </div>
      )}

      {choice === 'cancel' && (
        <div>
          {!canCancel ? (
            <p className="rounded-lg border border-line bg-card p-3 text-sm text-ink-soft">
              A folyamat leállításához adminisztrátori jogosultság kell.
            </p>
          ) : (
            <>
              <label htmlFor="review-cancel-reason" className="mb-1 block text-sm font-medium text-ink">
                Miért állítod le?
              </label>
              <textarea
                id="review-cancel-reason"
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="Pl.: Rossz forrásfájllal indult, újat indítok."
                className="w-full rounded-lg border border-line bg-night-2 p-3 text-sm text-ink"
              />
              <button
                type="button"
                onClick={submitCancel}
                disabled={pending}
                className="mt-3 rounded-full border border-coral/40 bg-coral/12 px-5 py-2.5 text-sm font-semibold text-coral-deep transition-colors hover:bg-coral/22 disabled:opacity-50"
              >
                {pending ? 'Leállítás…' : 'Folyamat leállítása'}
              </button>
            </>
          )}
        </div>
      )}

      {message && (
        <p
          className={`mt-3 text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}
          role="status"
        >
          {message.text}
        </p>
      )}
    </Card>
  )
}

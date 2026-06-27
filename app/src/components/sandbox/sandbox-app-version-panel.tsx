'use client'

import { useEffect, useState, useTransition } from 'react'
import { getSandboxAppPreviewUrl, activateSandboxAppVersion } from '@/app/actions/platform'
import { Badge } from '@/components/ui/shell'

type VersionSummary = {
  versionId: string
  version: number
  status: string
  changeSummary: string
  contentHash: string
  artifactSizeBytes: number
  createdByLabel: string
  createdAt: string
  validationResult: unknown
}

type ValidationResult = {
  status?: string
  warnings?: string[]
  errors?: string[]
}

function statusTone(s: string): 'success' | 'neutral' | 'warning' | 'danger' {
  if (s === 'active') return 'success'
  if (s === 'superseded') return 'neutral'
  if (s === 'blocked') return 'danger'
  return 'warning'
}

function parseValidation(raw: unknown): ValidationResult {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as ValidationResult
  return {}
}

export function SandboxAppVersionPanel({
  appId,
  appName,
  activeVersionId,
  versions,
}: {
  appId: string
  appName: string
  activeVersionId?: string
  versions: VersionSummary[]
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewVersion, setPreviewVersion] = useState<number | undefined>(
    versions.find((v) => v.status === 'active')?.version ?? versions[0]?.version,
  )
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [activating, startActivate] = useTransition()
  const [activateError, setActivateError] = useState<string | null>(null)

  useEffect(() => {
    if (previewVersion === undefined) return
    let cancelled = false
    setPreviewUrl(null)
    setPreviewError(null)
    void (async () => {
      const res = await getSandboxAppPreviewUrl({ appId, version: previewVersion })
      if (cancelled) return
      if (res.success) setPreviewUrl(res.data.previewUrl)
      else setPreviewError(res.error)
    })()
    return () => { cancelled = true }
  }, [appId, previewVersion])

  const handleActivate = (version: number) => {
    setActivateError(null)
    startActivate(async () => {
      const res = await activateSandboxAppVersion({ appId, version })
      if (!res.success) setActivateError(res.error)
      else window.location.reload()
    })
  }

  const activeVersion = versions.find((v) => v.status === 'active')

  return (
    <div className="space-y-6">
      {/* Preview panel */}
      <section className="atelier-card overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-lg font-semibold">Preview</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Sandbox izolált origin · nincs hálózat · nincs platform session · nincs cookie
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {activeVersion && (
              <Badge tone="success">aktív: v{activeVersion.version}</Badge>
            )}
            {previewVersion !== undefined && (
              <span className="text-xs text-ink-soft">
                Preview: v{previewVersion}
              </span>
            )}
          </div>
        </div>

        <div className="relative">
          {previewUrl ? (
            <iframe
              key={previewVersion}
              title={`${appName} – preview v${previewVersion}`}
              src={previewUrl}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className="h-[480px] w-full bg-white"
            />
          ) : previewError ? (
            <div className="flex h-48 items-center justify-center text-sm text-coral">
              {previewError}
            </div>
          ) : (
            <div className="flex h-48 items-center justify-center text-sm text-ink-soft">
              Preview betöltése…
            </div>
          )}
        </div>

        {previewUrl && (
          <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
            <a
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-ink-soft hover:border-coral/45 hover:text-coral"
            >
              Megnyitás új lapon
            </a>
            <a
              href={`/api/sandbox-apps/${appId}/export`}
              className="rounded-full bg-sage/20 px-4 py-1.5 text-xs font-semibold text-sage hover:bg-sage/30"
              title={`SHA-256: ${activeVersion?.contentHash ?? '—'}`}
            >
              .html export
            </a>
          </div>
        )}
      </section>

      {/* Verziólista */}
      <section className="atelier-card p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Verziók</h2>

        {activateError && (
          <p className="mb-3 rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
            {activateError}
          </p>
        )}

        <div className="space-y-2">
          {versions.map((v) => {
            const val = parseValidation(v.validationResult)
            const isPreviewSelected = v.version === previewVersion
            return (
              <div
                key={v.versionId}
                className={`rounded-lg border p-4 transition-colors ${
                  isPreviewSelected ? 'border-sage/40 bg-sage/5' : 'border-line'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-bold">v{v.version}</span>
                      <Badge tone={statusTone(v.status)}>{v.status}</Badge>
                      <Badge tone={v.createdByLabel === 'agent' ? 'warning' : 'neutral'}>
                        {v.createdByLabel}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-ink-soft">{v.changeSummary}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-ink-faint">
                      <span className="font-mono">{v.contentHash.slice(0, 16)}…</span>
                      <span>{(v.artifactSizeBytes / 1024).toFixed(1)} KB</span>
                      <span>
                        {new Date(v.createdAt).toLocaleString('hu-HU', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </span>
                    </div>
                    {val.warnings && val.warnings.length > 0 && (
                      <ul className="mt-2 space-y-0.5">
                        {val.warnings.map((w, i) => (
                          <li key={i} className="text-xs text-honey">
                            ⚠ {w}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 self-start">
                    <button
                      type="button"
                      onClick={() => setPreviewVersion(v.version)}
                      disabled={isPreviewSelected}
                      className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:border-sage/40 hover:text-sage disabled:opacity-40"
                    >
                      Preview
                    </button>
                    {v.status !== 'active' && (
                      <button
                        type="button"
                        onClick={() => handleActivate(v.version)}
                        disabled={activating}
                        className="rounded-full bg-coral/15 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/25 disabled:opacity-50"
                      >
                        {activating ? 'Aktiválás…' : 'Aktiválás'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { decommissionActiveConnector } from '@/app/actions/provisioning'

type ConnectorRow = {
  id: string
  name: string
  type: string
  authMode: string
  tenantId: string | null
  canDecommission: boolean
}

type OAuthReadiness = {
  configured: boolean
  persisted: boolean
  source: 'platform' | 'env' | 'tenant_legacy' | null
}

type DrivePickerReadiness = OAuthReadiness & {
  appId: string | null
}

function readinessTone(configured: boolean): 'ok' | 'warn' {
  return configured ? 'ok' : 'warn'
}

function ReadinessLine({
  label,
  configured,
  detail,
}: {
  label: string
  configured: boolean
  detail: string
}) {
  const tone = readinessTone(configured)
  return (
    <li className="flex items-start gap-2 text-sm">
      <span
        aria-hidden
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
          tone === 'ok' ? 'bg-emerald-400' : 'bg-amber-400'
        }`}
      />
      <span className={tone === 'ok' ? 'text-ink-soft' : 'text-amber-100/90'}>
        <span className="font-medium text-ink">{label}:</span> {detail}
      </span>
    </li>
  )
}

/**
 * Tenant-admin: a delegált connectorok életciklusa (leszerelés) és a Google OAuth
 * állapot. A felhasználók saját összekötése a Kapcsolt fiókok oldalon van.
 */
export function DelegatedConnectorsAdminPanel({
  initialConnectors,
  googleOauth,
  googleDriveOauth,
  googleDrivePicker,
  hasGoogleDriveConnector,
  canManagePlatformOauth,
}: {
  initialConnectors: ConnectorRow[]
  googleOauth: OAuthReadiness
  googleDriveOauth: OAuthReadiness
  googleDrivePicker: DrivePickerReadiness
  hasGoogleDriveConnector: boolean
  canManagePlatformOauth: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [connectors, setConnectors] = useState(initialConnectors)
  const [decommissionTarget, setDecommissionTarget] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const driveReady =
    !hasGoogleDriveConnector || (googleDriveOauth.configured && googleDrivePicker.configured)

  return (
    <div className="space-y-6">
      <Card title="Google OAuth — Gmail">
        <div className="space-y-3 text-sm text-ink-soft">
          <ReadinessLine
            label="Platform OAuth client"
            configured={googleOauth.configured}
            detail={
              googleOauth.configured
                ? 'Be van állítva. A tényleges működést consent utáni smoke teszt igazolja.'
                : 'Hiányzik — a Gmail összekötés nem fog működni.'
            }
          />
          {canManagePlatformOauth ? (
            <p>
              <Link
                href="/control-plane/platform/settings?section=google-oauth"
                className="text-ink underline"
              >
                Megnyitás a platform-beállításokban
              </Link>
            </p>
          ) : null}
        </div>
      </Card>

      {hasGoogleDriveConnector ? (
        <Card title="Google OAuth — Drive">
          <div className="space-y-3 text-sm text-ink-soft">
            <ReadinessLine
              label="Drive OAuth client"
              configured={googleDriveOauth.configured}
              detail={
                googleDriveOauth.configured
                  ? 'Be van állítva (külön client a Gmailtől).'
                  : 'Hiányzik — a Drive összekötés nem fog működni.'
              }
            />
            <ReadinessLine
              label="Google Picker"
              configured={googleDrivePicker.configured}
              detail={
                googleDrivePicker.configured
                  ? `Be van állítva${googleDrivePicker.appId ? ` · App ID: ${googleDrivePicker.appId}` : ''}.`
                  : 'Hiányzik — az „olvasás + írás kijelölt fájlokon” profil fájlválasztója nem működik.'
              }
            />
            {!driveReady ? (
              <p className="rounded-lg border border-amber/35 bg-amber/10 px-3 py-2 text-xs leading-5 text-ink-soft">
                A tenantben van aktív Google Drive connector, de a platform readiness hiányos.
                Ellenőrizd a GCP-ben a Drive, Docs, Sheets, Slides és Picker API-kat, az origin/API
                key korlátozásokat, majd állítsd be a platform credentialokat.
              </p>
            ) : null}
            {canManagePlatformOauth ? (
              <p>
                <Link
                  href="/control-plane/platform/settings?section=google-drive-oauth"
                  className="text-ink underline"
                >
                  Megnyitás a platform Drive / Picker beállításokban
                </Link>
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card title="Delegált connectorok">
        <p className="mb-4 text-sm text-ink-soft">
          Ezeket a connectorokat a tagok a saját fiókjukkal kötik be. A leszerelés archiválja a
          connectort, és a hozzá tartozó user-grantek érvényüket vesztik.
        </p>
        {message && (
          <p className="mb-3 rounded-lg border border-sage/35 bg-sage/10 px-3 py-2 text-sm text-sage">
            {message}
          </p>
        )}
        {error && (
          <p className="mb-3 rounded-lg border border-coral/35 bg-coral/10 px-3 py-2 text-sm text-coral-deep">
            {error}
          </p>
        )}
        {connectors.length === 0 ? (
          <p className="text-sm text-ink-soft">Nincs aktív user_delegated connector.</p>
        ) : (
          <ul className="space-y-3">
            {connectors.map((connector) => (
              <li
                key={connector.id}
                className="atelier-soft flex items-center justify-between gap-4 p-3"
              >
                <div>
                  <p className="font-medium text-ink">{connector.name}</p>
                  <p className="text-xs text-ink-soft">
                    {connector.type} · {connector.authMode}
                    {connector.tenantId ? '' : ' · globális'}
                  </p>
                </div>
                {!connector.canDecommission ? (
                  <span className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-soft">
                    Csak platform-superadmin szerelheti le
                  </span>
                ) : decommissionTarget === connector.id ? (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="text-xs text-coral">Biztosan leszereljük?</span>
                    <button
                      type="button"
                      disabled={pending}
                      className="rounded-lg border border-coral/50 bg-coral/10 px-3 py-1.5 text-sm text-coral"
                      onClick={() =>
                        startTransition(async () => {
                          const res = await decommissionActiveConnector({
                            connectorId: connector.id,
                            reason: 'Admin leszerelés a Rendszer felületről',
                          })
                          if (res.success) {
                            setConnectors((prev) => prev.filter((c) => c.id !== connector.id))
                            setDecommissionTarget(null)
                            setError(null)
                            setMessage('Connector leszerelve és archiválva.')
                          } else setError(res.error)
                        })
                      }
                    >
                      Igen, megszüntetés
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-soft"
                      onClick={() => setDecommissionTarget(null)}
                    >
                      Mégse
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={pending}
                    className="rounded-lg border border-coral/40 px-3 py-1.5 text-sm text-coral hover:bg-coral/10"
                    onClick={() => setDecommissionTarget(connector.id)}
                  >
                    Leszerelés
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

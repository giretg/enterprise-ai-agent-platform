'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  activateConnectorDraftPipeline,
  createConnectorFromTemplateAction,
  listConnectorCatalog,
  listConnectorTemplatesAction,
  listProvisioningDrafts,
} from '@/app/actions/provisioning'
import { Badge, Card } from '@/components/ui/shell'

type CatalogRow = {
  id: string
  name: string
  type: string
  description?: string | null
  lifecycleState?: string
}

type DraftRow = {
  draftId: string
  name: string
  lifecycleState: string
  reviewStatus: string
  sandboxTestOk: boolean | null
  connectorType: string
}

type TemplateDescriptor = {
  connectorType?: string
  authMethods: Array<{ kind: string }>
  instanceFields: Array<{
    name: string
    label: string
    type: string
    required?: boolean
    secretAliasHint?: string
  }>
  scopeCatalog: Array<{ value: string; label: string; default?: boolean }>
  activationHelp?: string
}

type TemplateRow = {
  id: string
  key: string
  version: number
  origin: string
  displayName: string
  description: string | null
  status: string
  descriptor: TemplateDescriptor
}

function typeLabel(type: string) {
  if (type === 'google_drive') return 'Google Drive'
  if (type === 'gmail') return 'Gmail'
  if (type === 'http_api') return 'HTTP API'
  return type
}

export function ProvisioningPanel(props: {
  canManageCatalog: boolean
  isSuperadmin: boolean
  activeTenantId: string | null
  initialCatalog?: CatalogRow[]
  initialDrafts?: DraftRow[]
  initialTemplates?: TemplateRow[]
  initialError?: string | null
}) {
  const [catalog, setCatalog] = useState<CatalogRow[]>(props.initialCatalog ?? [])
  const [drafts, setDrafts] = useState<DraftRow[]>(props.initialDrafts ?? [])
  const [templates, setTemplates] = useState<TemplateRow[]>(props.initialTemplates ?? [])
  const [error, setError] = useState<string | null>(props.initialError ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [secrets, setSecrets] = useState<Record<string, string>>({})

  const reload = useCallback(async () => {
    const [catalogRes, draftRes, templateRes] = await Promise.all([
      listConnectorCatalog(),
      listProvisioningDrafts(),
      listConnectorTemplatesAction(),
    ])
    if (!catalogRes.success) {
      setError(catalogRes.error)
      return
    }
    if (!draftRes.success) {
      setError(draftRes.error)
      return
    }
    if (!templateRes.success) {
      setError(templateRes.error)
      return
    }
    setError(null)
    setCatalog(catalogRes.data)
    setDrafts(draftRes.data)
    setTemplates(templateRes.data.filter((row) => row.status === 'active'))
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const picked = templates.find((row) => row.id === pickedId) ?? null
  const openDrafts = useMemo(
    () => drafts.filter((row) => row.lifecycleState === 'draft' || row.lifecycleState === 'validated'),
    [drafts],
  )

  function selectTemplate(template: TemplateRow) {
    setPickedId(template.id)
    setName(template.displayName)
    setValues({})
    setSecrets({})
  }

  async function createFromTemplate() {
    if (!picked) return
    setBusy('create')
    const authMethodKind = picked.descriptor.authMethods[0]?.kind
    if (
      authMethodKind !== 'api_key' &&
      authMethodKind !== 'bearer' &&
      authMethodKind !== 'basic' &&
      authMethodKind !== 'service_oauth2' &&
      authMethodKind !== 'user_delegated_oauth2'
    ) {
      setError('A sablonnak nincs támogatott hitelesítési módja.')
      setBusy(null)
      return
    }
    const selectedScopes = picked.descriptor.scopeCatalog
      .filter((scope) => scope.default)
      .map((scope) => scope.value)
    const result = await createConnectorFromTemplateAction({
      templateId: picked.id,
      name: name.trim() || picked.displayName,
      authMethodKind,
      instanceValues: values,
      secretAliases: secrets,
      selectedScopes: selectedScopes.length > 0 ? selectedScopes : undefined,
    })
    setBusy(null)
    if (!result.success) {
      setError(result.error)
      return
    }
    setPickedId(null)
    await reload()
  }

  async function activateDraft(draftId: string, connectorType: string) {
    setBusy(draftId)
    const result = await activateConnectorDraftPipeline({
      draftId,
      confirmKeyless: connectorType === 'http_api',
    })
    setBusy(null)
    if (!result.success) {
      setError(result.error)
      return
    }
    await reload()
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Konnektorok</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Katalógus</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Aktív kapcsolatok és sablonból új konnektor. Az LLM provisioning-asszisztens és az
          önfrissítő konnektorok kikerültek.
        </p>
      </div>
      {error ? <p className="text-sm text-coral-deep">{error}</p> : null}

      <Card title="Aktív kapcsolatok">
        {catalog.length === 0 ? (
          <p className="text-sm text-ink-soft">Nincs megjeleníthető konnektor.</p>
        ) : (
          <ul className="divide-y divide-line/70">
            {catalog.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{row.name}</span>
                  {row.description ? (
                    <span className="mt-0.5 block text-xs text-ink-soft">{row.description}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-ink-soft">{typeLabel(row.type)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {props.canManageCatalog ? (
        <Card title="Új konnektor sablonból">
          {templates.length === 0 ? (
            <p className="text-sm text-ink-soft">Nincs sablon a katalógusban. Seedeld a builtin sablonokat.</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {templates.map((template) => (
                <li key={template.id}>
                  <button
                    type="button"
                    onClick={() => selectTemplate(template)}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                      picked?.id === template.id
                        ? 'border-coral/50 bg-coral/10'
                        : 'border-ink/10 bg-white/40 hover:border-coral/35'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{template.displayName}</span>
                      <Badge tone={template.origin === 'builtin' ? 'success' : 'warning'}>
                        {template.origin}
                      </Badge>
                    </span>
                    {template.description ? (
                      <span className="mt-1 block text-xs text-ink-soft">{template.description}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {picked ? (
            <div className="mt-4 space-y-3 rounded-lg border border-ink/10 bg-white/50 p-3">
              <p className="text-sm font-medium">{picked.displayName}</p>
              {picked.descriptor.activationHelp ? (
                <p className="whitespace-pre-wrap text-xs text-ink-soft">{picked.descriptor.activationHelp}</p>
              ) : null}
              <label className="block text-xs text-ink-soft">
                Név
                <input
                  className="mt-1 w-full rounded-md border border-ink/15 bg-white px-2 py-1 text-sm text-ink"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {picked.descriptor.instanceFields.map((field) => (
                <label key={field.name} className="block text-xs text-ink-soft">
                  {field.label}
                  <input
                    type={field.type === 'secret' ? 'password' : 'text'}
                    className="mt-1 w-full rounded-md border border-ink/15 bg-white px-2 py-1 text-sm text-ink"
                    value={field.type === 'secret' ? (secrets[field.name] ?? '') : (values[field.name] ?? '')}
                    onChange={(event) => {
                      if (field.type === 'secret') {
                        setSecrets((current) => ({ ...current, [field.name]: event.target.value }))
                      } else {
                        setValues((current) => ({ ...current, [field.name]: event.target.value }))
                      }
                    }}
                  />
                </label>
              ))}
              <button
                type="button"
                disabled={busy === 'create'}
                onClick={() => void createFromTemplate()}
                className="rounded-md bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                Draft létrehozása
              </button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {props.canManageCatalog && openDrafts.length > 0 ? (
        <Card title="Aktiválásra váró draftok">
          <ul className="divide-y divide-line/70">
            {openDrafts.map((row) => (
              <li key={row.draftId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <span className="font-medium">{row.name}</span>
                  <span className="ml-2 text-ink-soft">
                    {typeLabel(row.connectorType)} · {row.lifecycleState}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={busy === row.draftId}
                  onClick={() => void activateDraft(row.draftId, row.connectorType)}
                  className="rounded-md bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  Aktiválás
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}

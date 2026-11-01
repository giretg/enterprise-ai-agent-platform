/** Sablonkulcs → feltöltött ikon (data URL); tenant-sablon felülírja a platformot. */
export function iconDataUrlByTemplateKey(
  templates: ReadonlyArray<{ key: string; tenantId: string | null; descriptor: unknown }>,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const template of templates) {
    const descriptor = template.descriptor as { iconDataUrl?: unknown } | null
    const icon =
      descriptor && typeof descriptor.iconDataUrl === 'string' ? descriptor.iconDataUrl : null
    if (!icon) continue
    if (template.tenantId) map.set(template.key, icon)
    else if (!map.has(template.key)) map.set(template.key, icon)
  }
  return map
}

export function provenanceTemplateKey(config: unknown): string | null {
  const key = (config as { provenance?: { templateKey?: unknown } } | null)?.provenance?.templateKey
  return typeof key === 'string' ? key : null
}

function fold(value: string): string {
  return value.trim().toLowerCase()
}

/** Sablonikon: provenance kulcs, vagy név/displayName egyezés, különben a connector típusa. */
export function resolveConnectorIcon(input: {
  name: string | null
  type: string | null
  config: unknown
  templates: ReadonlyArray<{ key: string; displayName: string; tenantId: string | null }>
  iconByTemplateKey: Map<string, string>
}): { iconDataUrl: string | null; provider: string } {
  const fromProvenance = provenanceTemplateKey(input.config)
  if (fromProvenance) {
    return {
      iconDataUrl: input.iconByTemplateKey.get(fromProvenance) ?? null,
      provider: fromProvenance,
    }
  }
  const name = input.name ? fold(input.name) : ''
  const match = name
    ? input.templates.find(
        (template) => fold(template.key) === name || fold(template.displayName) === name,
      )
    : undefined
  if (match) {
    return {
      iconDataUrl: input.iconByTemplateKey.get(match.key) ?? null,
      provider: match.key,
    }
  }
  return {
    iconDataUrl: null,
    provider: input.type ?? 'http_api',
  }
}

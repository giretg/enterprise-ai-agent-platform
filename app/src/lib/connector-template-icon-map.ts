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

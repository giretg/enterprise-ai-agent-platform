/**
 * Legacy MemoryVersion.content tételes kezelése a Tanítás UI számára.
 * A DB továbbra is egy szövegblokkot tárol; a UI bullet / bekezdés tételeken dolgozik.
 */

export const EMPTY_MEMORY_PLACEHOLDER = '(nincs rögzített tapasztalat)'

const BULLET_RE = /^\s*([-*•]|\d+[.)])\s+/

export type MemoryItemOperation =
  | { operation: 'add'; text: string }
  | { operation: 'update'; itemIndex: number; text: string }
  | { operation: 'remove'; itemIndex: number }

/** Szövegblokk → tételek (bullet sorok, különben nem üres bekezdések). */
export function parseMemoryItems(content: string | null | undefined): string[] {
  const raw = (content ?? '').trim()
  if (!raw || raw === EMPTY_MEMORY_PLACEHOLDER) return []

  const lines = raw.split(/\r?\n/)
  const hasBullets = lines.some((line) => BULLET_RE.test(line))

  if (hasBullets) {
    const items: string[] = []
    let current: string | null = null
    for (const line of lines) {
      if (BULLET_RE.test(line)) {
        if (current !== null) items.push(current)
        current = line.replace(BULLET_RE, '').trimEnd()
      } else if (current !== null) {
        const cont = line.trim()
        if (cont) current = `${current}\n${cont}`
      } else {
        const standalone = line.trim()
        if (standalone) items.push(standalone)
      }
    }
    if (current !== null) items.push(current)
    return items.map((i) => i.trim()).filter(Boolean)
  }

  return raw
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
}

/** Tételek → kanonikus bullet-lista (vagy üres-placeholder). */
export function serializeMemoryItems(items: string[]): string {
  const cleaned = items.map((i) => i.trim()).filter(Boolean)
  if (cleaned.length === 0) return EMPTY_MEMORY_PLACEHOLDER
  return cleaned.map((item) => `- ${item.replace(/\n/g, '\n  ')}`).join('\n')
}

export function applyMemoryItemChange(
  content: string | null | undefined,
  change: MemoryItemOperation,
): string {
  const items = parseMemoryItems(content)

  if (change.operation === 'add') {
    const text = change.text.trim()
    if (!text) throw new Error('A hozzáadandó szabály nem lehet üres')
    return serializeMemoryItems([...items, text])
  }

  if (change.itemIndex < 0 || change.itemIndex >= items.length) {
    throw new Error('Érvénytelen szabály-index')
  }

  if (change.operation === 'remove') {
    return serializeMemoryItems(items.filter((_, i) => i !== change.itemIndex))
  }

  const text = change.text.trim()
  if (!text) throw new Error('A módosított szabály nem lehet üres')
  const next = [...items]
  next[change.itemIndex] = text
  return serializeMemoryItems(next)
}

/**
 * #946 soronkénti eltérés a wiki jóváhagyó kártyához (LCS). Egy oldal legfeljebb
 * `WIKI_MAX_PAGE_CHARS` hosszú, így a négyzetes tábla kicsi marad; a túl nagy
 * bemenetnél egyszerű „minden törölve / minden új” eredményt adunk.
 */
export type LineDiffRow = { kind: 'same' | 'add' | 'del'; text: string }

const MAX_CELLS = 4_000_000

export function diffLines(before: string, after: string): LineDiffRow[] {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))]
  }
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const rows: LineDiffRow[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      rows.push({ kind: 'del', text: a[i++] })
    } else {
      rows.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < a.length) rows.push({ kind: 'del', text: a[i++] })
  while (j < b.length) rows.push({ kind: 'add', text: b[j++] })
  return rows
}

/** Változatlan sorok összecsukása: a változások körül `context` sor marad. */
export function collapseUnchanged(
  rows: LineDiffRow[],
  context = 2,
): Array<LineDiffRow | { kind: 'skip'; count: number }> {
  const keep = rows.map((row) => row.kind !== 'same')
  const near = rows.map((_, index) => {
    for (let d = -context; d <= context; d++) if (keep[index + d]) return true
    return false
  })
  const out: Array<LineDiffRow | { kind: 'skip'; count: number }> = []
  let skipped = 0
  rows.forEach((row, index) => {
    if (near[index]) {
      if (skipped) out.push({ kind: 'skip', count: skipped })
      skipped = 0
      out.push(row)
    } else skipped++
  })
  if (skipped) out.push({ kind: 'skip', count: skipped })
  return out
}

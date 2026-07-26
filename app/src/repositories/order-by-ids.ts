/**
 * A batch `IN (...)` lekérdezések eredménye nem garantálja a bemeneti ID-k
 * sorrendjét. Ez a helper visszaállítja az eredeti findById/Promise.all
 * szemantikát: a kért sorrendet és duplikációkat megtartja, a hiányzó ID-ket
 * pedig kihagyja.
 */
export function orderRowsByIds<T extends { id: string }>(
  ids: readonly string[],
  rows: readonly T[],
): T[] {
  const rowsById = new Map(rows.map((row) => [row.id, row] as const))
  const ordered: T[] = []
  for (const id of ids) {
    const row = rowsById.get(id)
    if (row) ordered.push(row)
  }
  return ordered
}

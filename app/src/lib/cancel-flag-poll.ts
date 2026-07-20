/**
 * Kooperatív cancel-flag DB-poll: egy azonnali újrapróbálás, majd az utolsó
 * ismert érték megőrzése. Így a sikeresen beolvasott Stop nem veszik el
 * átmeneti DB-hibán, és a flotta sem áll le tévesen teljes kieséskor.
 */
export async function pollCancelRequested(params: {
  read: () => Promise<boolean>
  previous: boolean
}): Promise<boolean> {
  try {
    return await params.read()
  } catch {
    try {
      return await params.read()
    } catch {
      return params.previous
    }
  }
}

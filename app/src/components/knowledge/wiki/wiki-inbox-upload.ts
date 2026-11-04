/**
 * Egy fájl feltöltése a wiki tálcájára, a sikertelenség okával együtt: a felület
 * ebből mondja meg, mi történt és mi a teendő.
 */

/** D12: fájlonként legfeljebb 25 MB (a szerver is ellenőrzi: KB_MAX_FILE_BYTES). */
export const MAX_INBOX_FILE_BYTES = 25 * 1024 * 1024

export type InboxUploadResult =
  | { success: true; data: { status: 'queued' | 'duplicate' } }
  | { success: false; error: string }

export type InboxUploadOutcome =
  | { kind: 'queued' }
  | { kind: 'duplicate' }
  /** A böngésző nem tudta beolvasni: tipikusan csak a felhőben lévő OneDrive-/Drive-fájl. */
  | { kind: 'unreadable' }
  /** A szerver válaszolt, és elutasította; az `error` a szerver hibakódja. */
  | { kind: 'rejected'; error: string }
  /** Beolvasás után nem jött értelmezhető válasz: hálózati vagy szerverhiba. */
  | { kind: 'interrupted' }

/**
 * Küldés előtt memóriába olvassuk a fájlt: így a felhős helyőrző külön hibaként
 * látszik, és a beolvasás közben változó fájl sem bontja meg a kérést.
 */
export async function uploadInboxFile(
  file: File,
  send: (file: File) => Promise<InboxUploadResult>,
): Promise<InboxUploadOutcome> {
  let copy: File
  try {
    copy = new File([await file.arrayBuffer()], file.name, { type: file.type })
  } catch {
    return { kind: 'unreadable' }
  }
  try {
    const res = await send(copy)
    if (!res.success) return { kind: 'rejected', error: res.error }
    return { kind: res.data.status }
  } catch {
    return { kind: 'interrupted' }
  }
}

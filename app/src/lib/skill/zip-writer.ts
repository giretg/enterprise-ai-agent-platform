import { zipCrc32 } from './zip-reader'

export type ZipWriteEntry = { path: string; bytes: Uint8Array }

/**
 * Minimál, stored-only ZIP-író skill-csomag exportra. Szándékosan keskeny:
 * nincs tömörítés, nincs mappa-bejegyzés — csak amit a skill-import olvas.
 */
export function buildStoredZip(entries: ZipWriteEntry[]): Uint8Array {
  const normalized = entries
    .map((entry) => ({ path: entry.path.replace(/\\/g, '/').replace(/^\/+/, ''), bytes: entry.bytes }))
    .filter((entry) => entry.path.length > 0 && !entry.path.endsWith('/'))
    .sort((a, b) => a.path.localeCompare(b.path))

  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const entry of normalized) {
    const nameBytes = new TextEncoder().encode(entry.path)
    const crc = zipCrc32(entry.bytes)
    const size = entry.bytes.byteLength

    const local = Buffer.alloc(30 + nameBytes.byteLength)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBytes.byteLength, 26)
    local.writeUInt16LE(0, 28)
    nameBytes.forEach((b, i) => {
      local[30 + i] = b
    })

    const central = Buffer.alloc(46 + nameBytes.byteLength)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBytes.byteLength, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBytes.forEach((b, i) => {
      central[46 + i] = b
    })

    localParts.push(new Uint8Array(local), entry.bytes)
    centralParts.push(new Uint8Array(central))
    offset += local.byteLength + entry.bytes.byteLength
  }

  const centralDirectory = concatBytes(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(normalized.length, 8)
  eocd.writeUInt16LE(normalized.length, 10)
  eocd.writeUInt32LE(centralDirectory.byteLength, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return concatBytes([...localParts, centralDirectory, new Uint8Array(eocd)])
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

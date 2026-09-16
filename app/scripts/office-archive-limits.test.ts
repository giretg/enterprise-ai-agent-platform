/**
 * Run: npx tsx scripts/office-archive-limits.test.ts
 *
 * A feltöltési Office-feldolgozás csak a ZIP-korlát ellenőrzése UTÁN hívhatja
 * a Mammoth/ExcelJS parserét: egy kicsi, erősen tömörített input sem
 * foglalhat korlátlan memóriát.
 */
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'

import { extractStructured } from '../src/lib/kb-extraction'
import { docxRead } from '../src/domain/file-editor/adapters/docx-adapter'
import { xlsxReadSheet } from '../src/domain/file-editor/adapters/xlsx-adapter'
import { FileEditorError } from '../src/domain/file-editor/workspace-storage'
import { assertZipEntriesWithinLimits, zipCrc32, ZipReadError } from '../src/lib/skill/zip-reader'

type ZipFile = { name: string; contents: Buffer; declaredSize?: number; crc?: number }

function zipWithFiles(files: ZipFile[]): Buffer {
  const locals: Buffer[] = []
  const centralEntries: Buffer[] = []
  let localOffset = 0
  for (const file of files) {
    const encodedName = Buffer.from(file.name)
    const compressed = deflateRawSync(file.contents)
    const declaredSize = file.declaredSize ?? file.contents.length
    const crc = file.crc ?? zipCrc32(file.contents)
    const local = Buffer.alloc(30 + encodedName.length + compressed.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(declaredSize, 22)
    local.writeUInt16LE(encodedName.length, 26)
    encodedName.copy(local, 30)
    compressed.copy(local, 30 + encodedName.length)

    const central = Buffer.alloc(46 + encodedName.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(declaredSize, 24)
    central.writeUInt16LE(encodedName.length, 28)
    central.writeUInt32LE(localOffset, 42)
    encodedName.copy(central, 46)
    locals.push(local)
    centralEntries.push(central)
    localOffset += local.length
  }

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralEntries.reduce((size, entry) => size + entry.length, 0), 12)
  eocd.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...locals, ...centralEntries, eocd])
}

const compressedBomb = zipWithFiles([{ name: 'word/document.xml', contents: Buffer.alloc(256 * 1024, 'A') }])
assert.throws(
  () => assertZipEntriesWithinLimits(compressedBomb, {
    maxFileBytes: 128 * 1024,
    maxTotalBytes: 128 * 1024,
    maxEntries: 10,
  }),
  (error: unknown) => error instanceof ZipReadError && error.code === 'file_too_large',
)

const lyingBomb = zipWithFiles([{
  name: 'word/document.xml',
  contents: Buffer.alloc(256 * 1024, 'A'),
  declaredSize: 1,
}])
assert.throws(
  () => assertZipEntriesWithinLimits(lyingBomb, {
    maxFileBytes: 128 * 1024,
    maxTotalBytes: 128 * 1024,
    maxEntries: 10,
  }),
  (error: unknown) => error instanceof ZipReadError && error.code === 'corrupt',
)

/** EOCD entryCount alábecslés: a CD-ben rejtett bomba a régi kaput átugrotta, a JSZip viszont kibontotta. */
function zipWithUndercountedEocd(files: ZipFile[], reportedEntryCount: number): Buffer {
  const full = zipWithFiles(files)
  const eocd = full.length - 22
  assert.equal(full.readUInt32LE(eocd), 0x06054b50)
  full.writeUInt16LE(reportedEntryCount, eocd + 8)
  full.writeUInt16LE(reportedEntryCount, eocd + 10)
  return full
}

const undercountLimits = {
  maxFileBytes: 128 * 1024,
  maxTotalBytes: 128 * 1024,
  maxEntries: 10,
}

const undercountBomb = zipWithUndercountedEocd(
  [
    { name: 'word/document.xml', contents: Buffer.from('safe') },
    { name: 'word/bomb.xml', contents: Buffer.alloc(256 * 1024, 'A') },
  ],
  1,
)
assert.throws(
  () => assertZipEntriesWithinLimits(undercountBomb, undercountLimits),
  (error: unknown) => error instanceof ZipReadError && error.code === 'file_too_large',
)

const undercountMismatch = zipWithUndercountedEocd(
  [
    { name: 'word/document.xml', contents: Buffer.from('safe') },
    { name: 'word/extra.xml', contents: Buffer.from('hidden') },
  ],
  1,
)
assert.throws(
  () => assertZipEntriesWithinLimits(undercountMismatch, undercountLimits),
  (error: unknown) => error instanceof ZipReadError && error.code === 'corrupt',
)

const undercountTooMany = zipWithUndercountedEocd(
  Array.from({ length: 12 }, (_, i) => ({ name: `word/f${i}.xml`, contents: Buffer.from('x') })),
  1,
)
assert.throws(
  () => assertZipEntriesWithinLimits(undercountTooMany, undercountLimits),
  (error: unknown) => error instanceof ZipReadError && error.code === 'too_many_entries',
)

const invalidPathBomb = zipWithFiles([{
  name: '../word/document.xml',
  contents: Buffer.alloc(256 * 1024, 'A'),
  declaredSize: 1,
}])
assert.throws(
  () => assertZipEntriesWithinLimits(invalidPathBomb, {
    maxFileBytes: 128 * 1024,
    maxTotalBytes: 128 * 1024,
    maxEntries: 10,
  }),
  (error: unknown) => error instanceof ZipReadError && error.code === 'corrupt',
)

const badCrc = zipWithFiles([{ name: 'word/document.xml', contents: Buffer.from('safe'), crc: 0 }])
assert.throws(
  () => assertZipEntriesWithinLimits(badCrc, {
    maxFileBytes: 128 * 1024,
    maxTotalBytes: 128 * 1024,
    maxEntries: 10,
  }),
  (error: unknown) => error instanceof ZipReadError && error.code === 'corrupt',
)

const twoFiles = zipWithFiles([
  { name: 'word/a.xml', contents: Buffer.alloc(96 * 1024, 'A') },
  { name: 'word/b.xml', contents: Buffer.alloc(96 * 1024, 'B') },
])
assert.throws(
  () => assertZipEntriesWithinLimits(twoFiles, {
    maxFileBytes: 128 * 1024,
    maxTotalBytes: 128 * 1024,
    maxEntries: 10,
  }),
  (error: unknown) => error instanceof ZipReadError && error.code === 'archive_too_large',
)

const declaredTotalTooLarge = zipWithFiles([
  { name: 'word/a.xml', contents: Buffer.from('A'), declaredSize: 96 * 1024 },
  { name: 'word/b.xml', contents: Buffer.from('B'), declaredSize: 96 * 1024 },
])
assert.throws(
  () => assertZipEntriesWithinLimits(declaredTotalTooLarge, {
    maxFileBytes: 128 * 1024,
    maxTotalBytes: 128 * 1024,
    maxEntries: 10,
  }),
  (error: unknown) => error instanceof ZipReadError && error.code === 'corrupt',
)

async function verifyOfficeParserGate(): Promise<void> {
  await assert.rejects(
    () => extractStructured({ buffer: Buffer.from('not a zip'), filename: 'rossz.docx' }),
    /tömörítetlen tartalma túl nagy vagy sérült/,
  )
  await assert.rejects(
    () => extractStructured({ buffer: Buffer.from('not a zip'), filename: 'rossz.xlsx' }),
    /tömörítetlen tartalma túl nagy vagy sérült/,
  )
  await assert.rejects(
    () => docxRead(Buffer.from('not a zip')),
    (error: unknown) => error instanceof FileEditorError && error.code === 'INVALID_ARGS',
  )
  await assert.rejects(
    () => xlsxReadSheet(Buffer.from('not a zip')),
    (error: unknown) => error instanceof FileEditorError && error.code === 'INVALID_ARGS',
  )
}

verifyOfficeParserGate()
  .then(() => console.log('office-archive-limits.test.ts: ok'))
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })

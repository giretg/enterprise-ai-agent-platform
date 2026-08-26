/**
 * Office Open XML (docx/xlsx) letöltési álnév-feloldás.
 * A tárban a fájl tokenizált marad; a néző a feloldott másolatot kapja.
 *
 * Futtatás: npm run test:office-surrogate-resolve
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { docxCreate, docxRead } from '../src/domain/file-editor/adapters/docx-adapter'
import { xlsxCreate, xlsxReadSheet } from '../src/domain/file-editor/adapters/xlsx-adapter'
import { resolveOfficeFileEgressForViewer } from '../src/domain/privacy/resolve-office-egress'
import { resolveHtmlDisplayText } from '../src/domain/privacy/resolve-display-text'
import type { SurrogateEngine } from '../src/domain/privacy/surrogate-engine'
import {
  isOfficeOpenXmlWorkspaceFile,
  officeWorkspaceContentType,
  workspaceFileNeedsPrivacyEgress,
} from '../src/lib/workspace-file-visibility'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const COMPANY = '[[COMPANY@S15_1]]'
const PERSON = '[[PERSON_1]]'
const TENANT = '11111111-1111-1111-1111-111111111111'
const TICKET = '22222222-2222-2222-2222-222222222222'
const USER = '33333333-3333-3333-3333-333333333333'

const DISPLAY: Record<string, string> = {
  [COMPANY]: 'Vimpex',
  [PERSON]: 'Kovács Anna',
}

function stubEngine(): SurrogateEngine {
  return {
    async peekRef() {
      return { ok: true, record: {} }
    },
    peekDisplayValue(_tenantId: string, _scope: unknown, surrogate: string) {
      return DISPLAY[surrogate]
    },
    async resolveDisplayValue(_tenantId: string, _scope: unknown, surrogate: string) {
      return DISPLAY[surrogate]
    },
  } as unknown as SurrogateEngine
}

async function xmlParts(buffer: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buffer)
  const out: Record<string, string> = {}
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name]
    if (!entry || entry.dir || !/\.xml$/i.test(name)) continue
    out[name] = await entry.async('string')
  }
  return out
}

async function main() {
  console.log('Office álnév-feloldás (docx/xlsx letöltés)\n')

  await test('Word XML szöveg-node (xml:space=preserve) feloldható a HTML parserrel', async () => {
    const xml = `<w:t xml:space="preserve">${COMPANY} – Utolsó 2 hónap rendelési riport</w:t>`
    const out = await resolveHtmlDisplayText(xml, async (s) => DISPLAY[s] ?? null)
    assert.equal(out, '<w:t xml:space="preserve">Vimpex – Utolsó 2 hónap rendelési riport</w:t>')
  })

  await test('docx címsor és core title: company feloldódik, a tár nem változik', async () => {
    const original = await docxCreate({
      title: `${COMPANY} – Utolsó 2 hónap rendelési riport`,
      subject: 'Rendelési riport',
      blocks: [
        { type: 'heading', level: 1, text: `${COMPANY} – Utolsó 2 hónap rendelési riport` },
        { type: 'paragraph', text: `Partner: ${COMPANY}. Kapcsolattartó: ${PERSON}.` },
      ],
    })
    const resolved = await resolveOfficeFileEgressForViewer({
      buffer: original,
      engine: stubEngine(),
      tenantId: TENANT,
      ticketId: TICKET,
      requesterUserId: USER,
      surface: 'export_report',
    })
    assert.notEqual(resolved.equals(original), true, 'a kimenet feloldott másolat')

    const text = (await docxRead(resolved)).text
    assert.match(text, /Vimpex/)
    assert.doesNotMatch(text, /\[\[COMPANY@S15_1\]\]/)
    // export_report alapból csak company — a személy álnév marad
    assert.match(text, /\[\[PERSON_1\]\]/)
    assert.doesNotMatch(text, /Kovács Anna/)

    const parts = await xmlParts(resolved)
    assert.match(parts['word/document.xml'] ?? '', /Vimpex/)
    assert.match(parts['docProps/core.xml'] ?? '', /Vimpex/)

    const storedText = (await docxRead(original)).text
    assert.match(storedText, /\[\[COMPANY@S15_1\]\]/)
  })

  await test('xlsx cella: company feloldódik', async () => {
    const original = await xlsxCreate([
      {
        name: 'Riport',
        rows: [
          ['Partner', 'Érték'],
          [COMPANY, 121090],
        ],
      },
    ])
    const resolved = await resolveOfficeFileEgressForViewer({
      buffer: original,
      engine: stubEngine(),
      tenantId: TENANT,
      ticketId: TICKET,
      requesterUserId: USER,
      surface: 'export_report',
    })
    const sheet = await xlsxReadSheet(resolved)
    const partner = sheet.rows[0]?.Partner
    assert.equal(partner, 'Vimpex')
  })

  await test('álnév nélküli docx: ugyanaz a buffer', async () => {
    const original = await docxCreate({
      blocks: [{ type: 'paragraph', text: 'Nincs álnév.' }],
    })
    const resolved = await resolveOfficeFileEgressForViewer({
      buffer: original,
      engine: stubEngine(),
      tenantId: TENANT,
      ticketId: TICKET,
      requesterUserId: USER,
      surface: 'export_report',
    })
    assert.equal(resolved.equals(original), true)
  })

  await test('a vimpex ticket docx címe feloldódik (regresszió)', async () => {
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      '../.data/workspace/df05f309-4041-4bc8-a9b4-8ba0ef83f420/c445e87c-c30b-4a5e-a83e-0359e68104b9/riport_S15_1_utolso_2_honap_rendelesek.docx',
    )
    let original: Buffer
    try {
      original = readFileSync(fixture)
    } catch {
      console.log('  · fixture hiányzik, kihagyva')
      return
    }
    const resolved = await resolveOfficeFileEgressForViewer({
      buffer: original,
      engine: stubEngine(),
      tenantId: TENANT,
      ticketId: TICKET,
      requesterUserId: USER,
      surface: 'export_report',
    })
    const text = (await docxRead(resolved)).text
    assert.match(text, /Vimpex/)
    assert.doesNotMatch(text, /\[\[COMPANY@S15_1\]\]/)
  })

  await test('útvonal-heurisztika: office fájl privacy egress, signed URL nem', () => {
    assert.equal(isOfficeOpenXmlWorkspaceFile('riport.docx'), true)
    assert.equal(isOfficeOpenXmlWorkspaceFile('riport.xlsx'), true)
    assert.equal(isOfficeOpenXmlWorkspaceFile('riport.html'), false)
    assert.equal(workspaceFileNeedsPrivacyEgress('riport.docx'), true)
    assert.equal(workspaceFileNeedsPrivacyEgress('riport.html'), true)
    assert.equal(workspaceFileNeedsPrivacyEgress('scan.bin'), false)
    assert.equal(
      officeWorkspaceContentType('a.docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
  })

  await test('mindkét workspace route a közös Office-feloldót hívja', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    for (const rel of [
      'src/app/api/v1/tickets/[id]/workspace/files/route.ts',
      'src/app/api/v1/conversations/[id]/workspace/files/route.ts',
    ]) {
      const src = readFileSync(join(root, rel), 'utf8')
      assert.match(src, /resolveOfficeWorkspaceFile\(/)
      assert.match(src, /workspaceFileNeedsPrivacyEgress\(/)
      assert.match(src, /isOfficeOpenXmlWorkspaceFile\(/)
    }
  })

  console.log(failures === 0 ? '\nMinden teszt zöld.' : `\n${failures} hiba.`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()

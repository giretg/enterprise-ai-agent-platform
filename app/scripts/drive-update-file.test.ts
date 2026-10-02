/**
 * google_drive_update_file: meglévő Drive szövegfájl teljes felülírása MCP-n (wiki-oldal, napló).
 * Futtatás: npm run test:drive-update-file
 */
import assert from 'node:assert/strict'
import {
  GOOGLE_DRIVE_UPDATE_FILE_TOOL,
  ENTERPRISE_WRITE_TOOLS,
  googleDriveUpdateFileInputSchema,
  isEnterpriseWriteTool,
  schemaForEnterpriseTool,
} from '../src/domain/enterprise-tools'
import { executeGoogleDriveTool } from '../src/domain/enterprise-tools/handlers/google-drive'
import { GoogleDriveApiError } from '../src/domain/connector-grant/google-drive-api-client'
import { pendingArgsSummary, pendingOperationHeadline } from '../src/domain/gateway-operation/pending-args-summary'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

const DEFINITION = '44444444-4444-4444-8444-444444444444'

async function main() {

await check('írás-toolként regisztrált: jóváhagyás nélkül nem futhat', () => {
  assert.equal(isEnterpriseWriteTool(GOOGLE_DRIVE_UPDATE_FILE_TOOL), true)
  assert.ok((ENTERPRISE_WRITE_TOOLS as readonly string[]).includes('google_drive_update_file'))
  assert.equal(schemaForEnterpriseTool(GOOGLE_DRIVE_UPDATE_FILE_TOOL), googleDriveUpdateFileInputSchema)
})

await check('séma: fileId, textContent és idempotencyKey kötelező', () => {
  const ok = googleDriveUpdateFileInputSchema.safeParse({
    definitionId: DEFINITION,
    fileId: 'abc',
    textContent: '# oldal',
    idempotencyKey: 'k1',
  })
  assert.equal(ok.success, true)
  for (const missing of ['fileId', 'textContent', 'idempotencyKey']) {
    const args: Record<string, unknown> = {
      definitionId: DEFINITION,
      fileId: 'abc',
      textContent: '# oldal',
      idempotencyKey: 'k1',
    }
    delete args[missing]
    assert.equal(googleDriveUpdateFileInputSchema.safeParse(args).success, false, missing)
  }
  assert.equal(
    googleDriveUpdateFileInputSchema.safeParse({
      definitionId: DEFINITION,
      fileId: 'abc',
      textContent: '',
      idempotencyKey: 'k1',
    }).success,
    false,
  )
})

await check('felülírás stubbal: friss modifiedTime-mal lefut', async () => {
  const listed = (await executeGoogleDriveTool('google_drive_search', {}, 'stub-token')) as {
    files: Array<{ id: string; modifiedTime?: string }>
  }
  const target = listed.files[0]!
  const result = (await executeGoogleDriveTool(
    GOOGLE_DRIVE_UPDATE_FILE_TOOL,
    { fileId: target.id, textContent: 'új tartalom', expectedModifiedTime: target.modifiedTime },
    'stub-token',
  )) as { file: { id: string } }
  assert.equal(result.file.id, target.id)
})

await check('közben módosított fájl: nem ír, file_modified hibával áll meg', async () => {
  await assert.rejects(
    () =>
      executeGoogleDriveTool(
        GOOGLE_DRIVE_UPDATE_FILE_TOOL,
        { fileId: 'stub-file-1', textContent: 'új', expectedModifiedTime: '2000-01-01T00:00:00.000Z' },
        'stub-token',
      ),
    (error: unknown) => error instanceof GoogleDriveApiError && error.code === 'file_modified',
  )
})

await check('hiányzó fileId/textContent: hiba, nem néma siker', async () => {
  await assert.rejects(() => executeGoogleDriveTool(GOOGLE_DRIVE_UPDATE_FILE_TOOL, { fileId: 'x' }, 'stub-token'))
  await assert.rejects(() => executeGoogleDriveTool(GOOGLE_DRIVE_UPDATE_FILE_TOOL, { textContent: 'x' }, 'stub-token'))
})

await check('jóváhagyási kártya: látszik, hogy felülírás, és mi lesz az új tartalom', () => {
  const args = { fileId: 'wiki-1', textContent: '# Új wiki-oldal' }
  assert.match(pendingOperationHeadline(GOOGLE_DRIVE_UPDATE_FILE_TOOL, args), /felülír/i)
  const summary = pendingArgsSummary(GOOGLE_DRIVE_UPDATE_FILE_TOOL, args)
  assert.match(summary, /wiki-1/)
  assert.match(summary, /felülír/i)
  assert.match(summary, /Új wiki-oldal/)
})

if (failures > 0) {
  console.log(`\n${failures} hiba`)
  process.exit(1)
}
console.log('\nMinden ellenőrzés átment.')
}

void main()

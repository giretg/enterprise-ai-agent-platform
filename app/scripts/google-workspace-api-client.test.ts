/**
 * Futtatás: GOOGLE_WORKSPACE_API_STUB=true npx tsx scripts/google-workspace-api-client.test.ts
 */
import assert from 'node:assert/strict'
import { GoogleWorkspaceApiClient } from '../src/domain/connector-grant/google-workspace-api-client'

process.env.GOOGLE_WORKSPACE_API_STUB = 'true'

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}`)
    throw e
  }
}

async function main() {
  const client = new GoogleWorkspaceApiClient('stub-token')

  await test('docs apply edits stub', async () => {
    await client.applyDocsEdits('doc-1', [
      { insertText: { location: { index: 1 }, text: 'Hello' } },
    ])
  })

  await test('sheets write range stub', async () => {
    const res = await client.writeSheetsRange({
      fileId: 'sheet-1',
      range: 'A1:B2',
      values: [['a', 'b'], ['c', 'd']],
    })
    assert.equal(res.updatedCells, 4)
  })

  await test('slides apply edits stub', async () => {
    await client.applySlidesEdits('slides-1', [
      { replaceAllText: { containsText: { text: '{{title}}' }, replaceText: 'Cím' } },
    ])
  })

  console.log('\nAll google-workspace-api-client tests passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

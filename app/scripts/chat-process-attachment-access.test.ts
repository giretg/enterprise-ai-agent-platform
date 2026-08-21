/**
 * Chat csatolmány workspace-tükrözés + dokumentum-hozzáférés tenant-feloldás.
 *
 * ÜZLETI HÁTTÉR: chatből indított Folyamatnál a lépés-agent gyakran run-as
 * nélkül fut (`actingTenantId = null`). A ticketre kötött PDF csatolmány
 * eddig `document_access_denied`-re bukott, mert a tenant-határ csak az
 * acting tenantot nézte. Emellett a `pdf_path` rés az eredeti fájlnevet kapta,
 * miközben a workspace-tükrözés `.pdf.txt`-ként írja ki a kinyert szöveget
 * → `FILE_NOT_FOUND`.
 *
 * Futtatás: npx tsx scripts/chat-process-attachment-access.test.ts
 */
import assert from 'node:assert/strict'
import { chatAttachmentWorkspacePath } from '../src/lib/attachment-workspace'
import { applyChatTriggerAttachments } from '../src/lib/playbook-v2/trigger-input'
import { decideDocumentTenantAccess } from '../src/lib/document-tenant-access'

const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const TENANT_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('chat-process-attachment-access')

check('PDF chat csatolmány workspace path → .pdf.txt', () => {
  assert.equal(
    chatAttachmentWorkspacePath('043_15 2026.07.16.pdf'),
    '043_15 2026.07.16.pdf.txt',
  )
})

check('szöveges csatolmány megtartja az eredeti nevet', () => {
  assert.equal(chatAttachmentWorkspacePath('jegyzet.md'), 'jegyzet.md')
})

check('chat-trigger pdf_path a tükrözött .txt pathot kapja', () => {
  const filled = applyChatTriggerAttachments(
    {},
    ['pdf_path', 'documentId'],
    [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'lap.pdf', mimeType: 'application/pdf' }],
  )
  assert.equal(filled.pdf_path, 'lap.pdf.txt')
  assert.equal(filled.documentId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
})

check('ticket-tenant = doc stamp → reachable (actingUser nélkül is)', () => {
  // A canAccessDocument a ticket.tenantId-t adja át ide; actingTenantId lehet null.
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'unattached', stampedTenantId: TENANT_A },
      uploaderHasActiveMembership: false,
      actorTenantId: TENANT_A,
    }),
    true,
  )
})

check('ticket-tenant IDEGEN stamp → továbbra is tiltott', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'unattached', stampedTenantId: TENANT_B },
      uploaderHasActiveMembership: true,
      actorTenantId: TENANT_A,
    }),
    false,
  )
})

check('actingTenantId null (régi fail-closed) → tiltott unattached dokra', () => {
  assert.equal(
    decideDocumentTenantAccess({
      attachment: { kind: 'unattached', stampedTenantId: TENANT_A },
      uploaderHasActiveMembership: false,
      actorTenantId: null,
    }),
    false,
  )
})

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('OK — chat-process-attachment-access')

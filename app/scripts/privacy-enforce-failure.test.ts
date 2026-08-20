/**
 * APG-13 — ENFORCE fail-closed / fail-open mátrix (spec §15).
 *
 * DoD: hibainjektálás mind a négy rétegre; fail-closed magyar üzenet, nem stack trace.
 *
 * Futtatás: npm run test:privacy-enforce-failure
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { OSTOROSBOR_CRM_PRIVACY_FIELDS } from '../src/domain/privacy/connector-privacy'
import { runKnownValueSubstitution } from '../src/domain/privacy/known-value-substitution'
import { transformPromptMessages } from '../src/domain/privacy/prompt-privacy-transform'
import {
  failurePolicyForLayer,
  PrivacyTransformBlockedError,
  VaultUnavailableError,
} from '../src/domain/privacy/privacy-transform-failure'
import { SurrogateEngine, type PrivacyAuditSink } from '../src/domain/privacy/surrogate-engine'
import { transformStructuredOutput } from '../src/domain/privacy/structured-output-transform'
import {
  computeSurrogateHmac,
  type InsertRefInput,
  type PrivacyScope,
  type RefEntityRef,
  type RefVaultRecord,
  type SurrogateHmacFields,
  type SurrogateVault,
  type VaultLookup,
} from '../src/domain/privacy/surrogate-vault'

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

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001'
const CONNECTOR = 'dddddddd-0000-4000-8000-000000000004'
const CONVERSATION = 'eeeeeeee-0000-4000-8000-000000000005'
const HMAC_KEY = 'test-tenant-hmac-key'
const COMPANY = 'SPAR Magyarország Kereskedelmi Kft.'
const EMAIL = 'ada.lovelace@spar.hu'

const SCOPE: PrivacyScope = { type: 'conversation', id: CONVERSATION }

class SilentAudit implements PrivacyAuditSink {
  async recordUnknownSurrogate(): Promise<void> {}
  async recordResolveDenied(): Promise<void> {}
}

class InMemorySurrogateVault implements SurrogateVault {
  readonly rows: RefVaultRecord[] = []

  constructor(private readonly resolveTenantKey: (tenantId: string) => string) {}

  private lookup(row: RefVaultRecord | undefined): VaultLookup {
    if (!row) return { status: 'miss' }
    return { status: 'hit', record: row }
  }

  async findByEntity(
    tenantId: string,
    scope: PrivacyScope,
    entity: RefEntityRef,
  ): Promise<VaultLookup> {
    return this.lookup(
      this.rows.find(
        (row) =>
          row.tenantId === tenantId &&
          row.scopeType === scope.type &&
          row.scopeId === scope.id &&
          row.entityType === entity.entityType &&
          row.connectorId === entity.connectorId &&
          row.sourceId === entity.sourceId,
      ),
    )
  }

  async findBySurrogate(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<VaultLookup> {
    return this.lookup(
      this.rows.find(
        (row) =>
          row.tenantId === tenantId &&
          row.scopeType === scope.type &&
          row.scopeId === scope.id &&
          row.surrogate === surrogate,
      ),
    )
  }

  async findHitsBySurrogateInTenant(): Promise<RefVaultRecord[]> {
    return []
  }

  async listByScope(): Promise<RefVaultRecord[]> {
    return []
  }

  async maxOrdinal(): Promise<number> {
    return 0
  }

  async insertRef(input: InsertRefInput): Promise<RefVaultRecord> {
    const fields: SurrogateHmacFields = {
      tenantId: input.tenantId,
      scopeType: input.scope.type,
      scopeId: input.scope.id,
      entityType: input.entityType,
      surrogate: input.surrogate,
      class: 'ref',
      connectorId: input.connectorId,
      sourceId: input.sourceId,
    }
    const record: RefVaultRecord = {
      ...fields,
      id: randomUUID(),
      hmac: computeSurrogateHmac(this.resolveTenantKey(input.tenantId), fields),
    }
    this.rows.push(record)
    return record
  }

  async insertRefs(inputs: InsertRefInput[]): Promise<RefVaultRecord[]> {
    const records: RefVaultRecord[] = []
    for (const input of inputs) records.push(await this.insertRef(input))
    return records
  }
}

class FailingVault extends InMemorySurrogateVault {
  async insertRefs(): Promise<RefVaultRecord[]> {
    throw new VaultUnavailableError()
  }
}

function engine(vault: SurrogateVault = new InMemorySurrogateVault(() => HMAC_KEY)) {
  return new SurrogateEngine(vault, new SilentAudit())
}

function assertHungarianBlocked(error: unknown, layer: string) {
  assert.equal(error instanceof PrivacyTransformBlockedError, true, 'PrivacyTransformBlockedError kell')
  const blocked = error as PrivacyTransformBlockedError
  assert.equal(blocked.layer, layer)
  assert.equal(blocked.message, blocked.userMessage)
  assert.match(blocked.userMessage, /[áéíóöőúüű]/i, 'magyar üzenet kell')
  assert.equal(blocked.userMessage.includes('\n'), false, 'stack trace ne legyen a message-ben')
}

async function main() {
  console.log('APG-13 ENFORCE fail-closed / fail-open mátrix\n')

  await test('policy: strukturált mező és vault → fail-closed', () => {
    assert.equal(failurePolicyForLayer('structured_field'), 'fail_closed')
    assert.equal(failurePolicyForLayer('vault'), 'fail_closed')
  })

  await test('policy: known-value strukturált forrás → fail-closed, egyéb → fail-open', () => {
    assert.equal(failurePolicyForLayer('known_value', { knownValueFromStructuredField: true }), 'fail_closed')
    assert.equal(failurePolicyForLayer('known_value', { knownValueFromStructuredField: false }), 'fail_open')
  })

  await test('policy: scanner → fail-open', () => {
    assert.equal(failurePolicyForLayer('scanner'), 'fail_open')
  })

  await test('strukturált mező: vault hiba injektálva → fail-closed, magyar üzenet', async () => {
    const eng = engine(new FailingVault(() => HMAC_KEY))
    try {
      await transformStructuredOutput({
        output: { id: 1, company_name: COMPANY },
        fields: OSTOROSBOR_CRM_PRIVACY_FIELDS,
        engine: eng,
        tenantId: TENANT,
        connectorId: CONNECTOR,
        scope: SCOPE,
        apply: true,
      })
      assert.fail('dobás kellett')
    } catch (error) {
      assertHungarianBlocked(error, 'vault')
    }
  })

  await test('vault elérhetetlen: prompt scanner ENFORCE → fail-closed', async () => {
    const eng = engine(new FailingVault(() => HMAC_KEY))
    try {
      await transformPromptMessages({
        messages: [{ role: 'user', content: `Írd meg a ${EMAIL} címre.` }],
        mode: 'enforce',
        policy: async () => 'tokenize' as const,
        engine: eng,
        tenantId: TENANT,
        scope: SCOPE,
      })
      assert.fail('dobás kellett')
    } catch (error) {
      assertHungarianBlocked(error, 'vault')
    }
  })

  await test('scanner: policy hiba injektálva → fail-open, nyers szöveg marad', async () => {
    const eng = engine()
    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: `Küldd a ${EMAIL} címre.` }],
      mode: 'enforce',
      policy: async () => {
        throw new Error('inject-scanner-policy')
      },
      engine: eng,
      tenantId: TENANT,
      scope: SCOPE,
    })
    assert.equal(result.applied, false)
    assert.equal(result.messages[0]?.content?.includes(EMAIL), true)
    assert.equal(result.failure?.layer, 'scanner')
    assert.equal(result.failure?.policy, 'fail_open')
  })

  await test('known-value: strukturált forrás hiba → fail-closed', async () => {
    try {
      await runKnownValueSubstitution({
        text: `Megjegyzés: ${COMPANY}`,
        fromStructuredField: true,
        mode: 'enforce',
        work: async () => {
          throw new Error('inject-known-value')
        },
      })
      assert.fail('dobás kellett')
    } catch (error) {
      assertHungarianBlocked(error, 'known_value')
    }
  })

  await test('known-value: nem strukturált forrás hiba → fail-open + audit meta', async () => {
    const result = await runKnownValueSubstitution({
      text: `Megjegyzés: ${COMPANY}`,
      fromStructuredField: false,
      mode: 'enforce',
      work: async () => {
        throw new Error('inject-known-value')
      },
    })
    assert.equal(result.text, `Megjegyzés: ${COMPANY}`)
    assert.equal(result.appliedCount, 0)
    assert.equal(result.failure?.layer, 'known_value')
    assert.equal(result.failure?.policy, 'fail_open')
  })

  console.log(
    failures === 0
      ? '\nMinden APG-13 enforce-failure teszt zöld.'
      : `\n${failures} teszt elbukott.`,
  )
  if (failures > 0) process.exit(1)
}

main()

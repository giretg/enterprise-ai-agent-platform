import type { SurrogateEntityType } from '../src/domain/privacy/surrogate-format'
import type {
  InsertValInput,
  PrivacyScope,
  ValVaultLookup,
  ValVaultRecord,
} from '../src/domain/privacy/surrogate-vault'

/** Ref-only teszt vaultokhoz: val metódusok üres/stub implementációja (APG-18). */
export const valVaultMethodStubs = {
  async findValByFingerprint(
    _tenantId: string,
    _scope: PrivacyScope,
    _entityType: SurrogateEntityType,
    _fingerprint: string,
  ): Promise<ValVaultLookup> {
    return { status: 'miss' }
  },
  async findValBySurrogate(
    _tenantId: string,
    _scope: PrivacyScope,
    _surrogate: string,
  ): Promise<ValVaultLookup> {
    return { status: 'miss' }
  },
  async insertVal(_input: InsertValInput): Promise<ValVaultRecord> {
    throw new Error('val vault stub: insertVal nem támogatott ebben a tesztben')
  },
}

import { repositories } from '@/repositories/postgres'
import { PostgresClientInstallRepository } from '@/repositories/postgres/client-install-repository'
import { PostgresMachineFloorRepository } from '@/repositories/postgres/machine-floor-repository'
import { clientPolicyTimingFromEnv, type ClientPolicyDeps } from '@/domain/client-policy/client-install'

const store = new PostgresClientInstallRepository()
const floors = new PostgresMachineFloorRepository()

export function clientPolicyDeps(): ClientPolicyDeps {
  return {
    store,
    audit: repositories.audit,
    timing: clientPolicyTimingFromEnv(),
    lookupExpectedManagedDirHash: (key) => floors.expectedHash(key),
    // Tartalék, ha ehhez az installhoz még nincs kiadott gép-padló.
    expectedManagedDirHash: process.env.CLIENT_POLICY_EXPECTED_MANAGED_DIR_HASH || undefined,
  }
}

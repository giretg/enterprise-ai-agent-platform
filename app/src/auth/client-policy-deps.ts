import { repositories } from '@/repositories/postgres'
import { PostgresClientInstallRepository } from '@/repositories/postgres/client-install-repository'
import { clientPolicyTimingFromEnv, type ClientPolicyDeps } from '@/domain/client-policy/client-install'

const store = new PostgresClientInstallRepository()

export function clientPolicyDeps(): ClientPolicyDeps {
  return {
    store,
    audit: repositories.audit,
    timing: clientPolicyTimingFromEnv(),
    // A V1-8 (`/etc/hermes` kiosztás) ide köti a várt hash-t; addig az összevetés kimarad.
    expectedManagedDirHash: process.env.CLIENT_POLICY_EXPECTED_MANAGED_DIR_HASH || undefined,
  }
}

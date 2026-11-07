import { notFound } from 'next/navigation'
import { featureFlagSnapshotOf } from '@/domain/feature-flags/admin-service'
import {
  createFeatureFlagEvaluator,
  type FeatureFlagEvaluator,
  type FeatureFlagScope,
} from '@/domain/feature-flags/evaluator'
import { createFeatureGates, createToolFeatureGate } from '@/domain/feature-flags/gates'
import type { FeatureFlagKey } from '@/domain/feature-flags/registry'
import { TOOL_FEATURE_FLAGS } from '@/domain/feature-flags/tool-flags'
import { repositories } from '@/repositories/postgres'

const globalForFlags = globalThis as unknown as { featureFlagEvaluator?: FeatureFlagEvaluator<FeatureFlagKey> }

function createEvaluator(): FeatureFlagEvaluator<FeatureFlagKey> {
  return createFeatureFlagEvaluator<FeatureFlagKey>({
    load: async () => featureFlagSnapshotOf(await repositories.featureFlags.loadAll()),
    onLoadError: (error) => console.error('feature_flags.load_failed', error instanceof Error ? error.message : error),
  })
}

/**
 * Példányonként egy: a Next.js ugyanazt a modult több rétegben is betöltheti, de a mentő szerverművelet
 * cache-ürítésének a többi réteg döntéseire is hatnia kell.
 */
export const featureFlagEvaluator: FeatureFlagEvaluator<FeatureFlagKey> =
  (globalForFlags.featureFlagEvaluator ??= createEvaluator())

const gates = createFeatureGates<FeatureFlagKey>(featureFlagEvaluator)

/** Szerverkomponens, művelet, ütemezett futás: a tenant kötelező, háttérfutásnál soronként kell kiértékelni. */
export const isFeatureEnabled = gates.isFeatureEnabled
export const requireFeature = gates.requireFeature
export const featureGuardResponse = gates.featureGuardResponse

/** Szerveroldali oldalhoz: letiltott funkciónál 404, mintha az oldal nem is létezne. */
export async function requireFeatureForPage(key: FeatureFlagKey, scope: FeatureFlagScope): Promise<void> {
  if (!(await featureFlagEvaluator.isEnabled(key, scope))) notFound()
}

export const productionToolFeatureGate = createToolFeatureGate(TOOL_FEATURE_FLAGS, featureFlagEvaluator)

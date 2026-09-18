import type { ResolvedPrivacyCategoryPolicy } from '@/domain/privacy/privacy-category-policy'
import type { KnownValueReplacement } from '@/domain/privacy/known-value-substitution'
import type { PrivacyGatewayMode } from '@/domain/privacy/privacy-mode'
import {
  buildEntityMarkers,
  type PrivacyEntityMarker,
} from '@/domain/privacy/privacy-observability'

/** A chat UI számára szerializálható privacy-kontextus (APG-22). */
export type ChatPrivacyMarkerContext = {
  mode: PrivacyGatewayMode
  policy: ResolvedPrivacyCategoryPolicy
  knownValues: KnownValueReplacement[]
}

export function privacyHighlightEnabled(
  context: ChatPrivacyMarkerContext | null | undefined,
): context is ChatPrivacyMarkerContext {
  return context != null && context.mode !== 'off'
}

/** Megfigyelés / érvényesítés alatt: milyen spanok lennének / lettek védve. */
export function buildChatPrivacyMarkers(
  text: string,
  context: ChatPrivacyMarkerContext | null | undefined,
): PrivacyEntityMarker[] {
  if (!privacyHighlightEnabled(context) || !text.trim()) return []
  return buildEntityMarkers({
    text,
    mode: context.mode,
    policy: context.policy,
    knownValues: context.knownValues,
  })
}

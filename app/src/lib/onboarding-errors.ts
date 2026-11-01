const SELF_SERVICE_ERROR_KEYS = [
  'terms_required',
  'name_required',
  'name_too_long',
  'tax_id_too_long',
  'user_not_found',
  'user_suspended',
  'assumed_context',
  'cap_reached',
  'slug_exhausted',
  'unavailable',
] as const

export type OnboardingErrorKey = (typeof SELF_SERVICE_ERROR_KEYS)[number] | 'invitation' | 'generic'

/** Szerver-hibakód → `Onboarding.errors.*` kulcs (a felület üzleti szöveget mutat, nem kódot). */
export function onboardingErrorKey(error: string): OnboardingErrorKey {
  const code = error.startsWith('self_service:') ? error.slice('self_service:'.length) : null
  const known = SELF_SERVICE_ERROR_KEYS.find((key) => key === code)
  if (known) return known
  if (error.startsWith('invitation:')) return 'invitation'
  return 'generic'
}

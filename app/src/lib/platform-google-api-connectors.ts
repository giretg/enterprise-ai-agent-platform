/** Globális sablonok, amelyek a platform Google API OAuth appot használják (nem tenant clientId). */
export const PLATFORM_GOOGLE_API_CONNECTOR_TEMPLATE_KEYS = [
  'google-analytics',
  'google-search-console',
  'google-ads',
  'google-calendar',
  'google-sheets',
] as const

export type PlatformGoogleApiConnectorTemplateKey =
  (typeof PLATFORM_GOOGLE_API_CONNECTOR_TEMPLATE_KEYS)[number]

export function isPlatformGoogleApiConnectorTemplateKey(
  key: string | null | undefined,
): key is PlatformGoogleApiConnectorTemplateKey {
  if (!key) return false
  return (PLATFORM_GOOGLE_API_CONNECTOR_TEMPLATE_KEYS as readonly string[]).includes(key)
}

/** A materializált config `provider` mezője megegyezik a sablon kulccsal. */
export function isPlatformGoogleApiConnectorProvider(provider: string): boolean {
  return isPlatformGoogleApiConnectorTemplateKey(provider)
}

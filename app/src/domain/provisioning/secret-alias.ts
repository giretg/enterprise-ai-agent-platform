/** A provisioning és a kliens által közösen elfogadott, feloldható secret-hivatkozások. */
export function isResolvableSecretAlias(value: string): boolean {
  return (
    /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
    value.startsWith('secret-manager:projects/') ||
    value.startsWith('secret-ref:')
  )
}

/** `promisePage` query value → page index; missing or malformed values fall back to the first page. */
export function parsePromisePage(value: string | undefined): number {
  const page = Number(value)
  return Number.isSafeInteger(page) && page >= 0 && page <= Math.floor(Number.MAX_SAFE_INTEGER / 50) ? page : 0
}

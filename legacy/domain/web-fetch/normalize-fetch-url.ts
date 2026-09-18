/**
 * Közös URL-normalizáló a Known URL regiszterhez, az `allowedSourceUrls`
 * építéséhez és a web_fetch URL-invariánsához. A fragmentet levágja, hogy egy
 * `...pdf#page=3` hop ne essen `url_not_in_conversation`-re.
 */
export function normalizeFetchUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

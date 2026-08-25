import { redirect } from 'next/navigation'

/**
 * A régi „Fiókok" oldal a Kapcsolt fiókokba olvadt. Az OAuth-callback és a régi
 * könyvjelzők query-paramétereit (connected, error) továbbadjuk.
 */
export default async function ConnectorsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const query = await searchParams
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value) params.set(key, value)
  }
  const qs = params.toString()
  redirect(qs ? `/control-plane/account?${qs}` : '/control-plane/account')
}

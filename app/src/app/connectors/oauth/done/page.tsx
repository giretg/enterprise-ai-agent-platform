export default async function ConnectorOAuthDonePage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>
}) {
  const params = await searchParams
  const error = params.error?.trim()
  const failed = Boolean(error)

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <h1 className="font-display text-3xl text-ink">
        {failed ? 'A fiók összekötése nem sikerült' : 'Fiók összekötve'}
      </h1>
      <p className="mt-3 text-base text-ink-soft">
        {failed
          ? 'Bezárhatod ezt a lapot, és próbáld újra az AI kliensben.'
          : 'Bezárhatod ezt a lapot, és folytathatod az AI kliensben.'}
      </p>
      <p className="mt-2 text-base text-ink-soft">
        {failed
          ? 'You can close this tab and retry the connection in your AI client.'
          : 'You can close this tab and retry the tool in your AI client.'}
      </p>
      {failed && error ? (
        <p className="mt-6 font-mono text-sm text-ink-faint">{error}</p>
      ) : null}
    </main>
  )
}

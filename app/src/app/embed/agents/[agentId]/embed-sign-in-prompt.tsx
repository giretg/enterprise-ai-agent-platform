'use client'

/**
 * Beágyazott agent-chat — kijelentkezett állapot (feature-spec #481, D5). Ugyanabban
 * az ablakban visz a bejelentkezéshez, `redirect_url`-lel vissza az embed-URL-re.
 */
export function EmbedSignInPrompt() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
      <p className="max-w-sm text-sm text-ink-soft">
        A beszélgetéshez jelentkezz be a platformra.
      </p>
      <button
        type="button"
        onClick={() => {
          window.location.href = `/sign-in?redirect_url=${encodeURIComponent(window.location.href)}`
        }}
        className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral"
      >
        Bejelentkezés
      </button>
    </div>
  )
}

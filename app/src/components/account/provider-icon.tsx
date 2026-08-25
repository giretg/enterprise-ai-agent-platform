type ProviderIconProps = {
  provider: string
  className?: string
}

function GmailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#4285F4" d="M2.5 6.4v11.1c0 .8.7 1.5 1.5 1.5h2.6V9.9L12 14l5.4-4.1V19H20c.8 0 1.5-.7 1.5-1.5V6.4L12 13.6 2.5 6.4Z" />
      <path fill="#34A853" d="M2.5 6.4v11.1C2.5 18.3 3.2 19 4 19h2.6V9.9L2.5 6.8v-.4Z" />
      <path fill="#FBBC04" d="M17.4 9.9V19H20c.8 0 1.5-.7 1.5-1.5V6.8l-4.1 3.1Z" />
      <path fill="#EA4335" d="M2.5 6.4c0-1.2 1.4-1.9 2.4-1.2L12 10.6l7.1-5.4c1-.7 2.4 0 2.4 1.2v.4L12 14 2.5 6.8v-.4Z" />
    </svg>
  )
}

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#2AABEE" />
      <path
        fill="white"
        d="m17.7 7.3-2 9.5c-.2.7-.6.9-1.2.5l-3-2.2-1.5 1.4c-.2.2-.3.3-.7.3l.2-3.1 5.7-5.1c.2-.2-.1-.3-.4-.1l-7 4.4-3-.9c-.7-.2-.7-.7.1-1l11.8-4.5c.5-.2 1 .1 1 .8Z"
      />
    </svg>
  )
}

function MicrosoftIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#F25022" d="M2 2h9v9H2z" />
      <path fill="#7FBA00" d="M13 2h9v9h-9z" />
      <path fill="#00A4EF" d="M2 13h9v9H2z" />
      <path fill="#FFB900" d="M13 13h9v9h-9z" />
    </svg>
  )
}

function GenericProviderIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M10.5 13.5a4 4 0 0 0 5.7.1l2.4-2.4a4 4 0 0 0-5.7-5.7l-1.4 1.4" />
      <path d="M13.5 10.5a4 4 0 0 0-5.7-.1l-2.4 2.4a4 4 0 0 0 5.7 5.7l1.4-1.4" />
    </svg>
  )
}

export function ProviderIcon({ provider, className = 'h-7 w-7' }: ProviderIconProps) {
  const normalized = provider.toLowerCase()
  if (normalized === 'gmail' || normalized.includes('google')) {
    return <GmailIcon className={className} />
  }
  if (normalized === 'telegram') return <TelegramIcon className={className} />
  if (normalized.includes('microsoft') || normalized.includes('office')) {
    return <MicrosoftIcon className={className} />
  }
  return <GenericProviderIcon className={className} />
}

export function isClerkUiEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
}

export function isClerkEnabled(): boolean {
  return Boolean(process.env.CLERK_SECRET_KEY) && isClerkUiEnabled()
}

export function isDevAuthAllowed(): boolean {
  return process.env.NODE_ENV !== 'production'
}

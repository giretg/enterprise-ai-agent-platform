import { SignUp } from '@clerk/nextjs'
import { AuthLocaleShell } from '@/components/auth/auth-locale-shell'
import { signUpForceRedirectUrl } from '@/lib/control-plane-entry'

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const forceRedirectUrl = signUpForceRedirectUrl(await searchParams)

  return (
    <AuthLocaleShell>
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        {...(forceRedirectUrl ? { forceRedirectUrl } : {})}
      />
    </AuthLocaleShell>
  )
}

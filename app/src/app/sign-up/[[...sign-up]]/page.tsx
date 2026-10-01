import { SignUp } from '@clerk/nextjs'
import { AuthLocaleShell } from '@/components/auth/auth-locale-shell'

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const hasInvitationTicket = Boolean(params.__clerk_ticket || params.ticket)

  return (
    <AuthLocaleShell>
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        {...(!hasInvitationTicket
          ? { forceRedirectUrl: '/control-plane/pending?registration=complete' }
          : {})}
      />
    </AuthLocaleShell>
  )
}

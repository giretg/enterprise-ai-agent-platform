import { SignIn } from '@clerk/nextjs'
import { AuthLocaleShell } from '@/components/auth/auth-locale-shell'

export default function SignInPage() {
  return (
    <AuthLocaleShell>
      <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
    </AuthLocaleShell>
  )
}

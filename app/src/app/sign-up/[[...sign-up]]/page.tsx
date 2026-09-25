import { SignUp } from '@clerk/nextjs'
import { AuthLocaleShell } from '@/components/auth/auth-locale-shell'

export default function SignUpPage() {
  return (
    <AuthLocaleShell>
      <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
    </AuthLocaleShell>
  )
}

import { SignIn } from '@clerk/nextjs'

export default function SignInPage() {
  return (
    <div className="signal-grid flex min-h-screen items-center justify-center px-4">
      <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
    </div>
  )
}

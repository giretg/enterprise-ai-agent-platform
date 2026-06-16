import { RedeemInvitationForm } from '@/components/iam/redeem-invitation-form'

export default async function RedeemInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Meghívó</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Hozzáférés aktiválása</h1>
        <p className="mt-1 text-ink-soft">
          A meghívó token egyszer használható, és beváltás után a fiók szerepköre aktiválódik.
        </p>
      </div>

      <RedeemInvitationForm initialToken={token ?? ''} />
    </div>
  )
}

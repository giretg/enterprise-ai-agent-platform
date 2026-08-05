import { requireTenantRole } from '@/auth/tenant-context'
import { getNavVisibility } from '@/app/actions/menu-access'
import { MenuAccessPanel } from '@/components/iam/menu-access-panel'

/**
 * Menü-hozzáférés — szerepkörönként állítható fejléc-menü (tenant admin jog).
 *
 * A guard szándékosan ugyanaz, mint a többi admin oldalon: a menü-kurálás maga is
 * admin művelet, és a menüpont elrejtése SEM helyettesíti — az oldal a közvetlen
 * URL-en is csak adminnak nyílik.
 */
export default async function MenuAccessPage() {
  await requireTenantRole('admin')
  const res = await getNavVisibility()

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Menü-hozzáférés</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Ki melyik menüt látja</h1>
        <p className="mt-1 max-w-3xl text-ink-soft">
          Itt állítod be, hogy egy-egy szerepkör milyen menüpontokat és almenüket lásson a
          fejlécben. Alapból mindenki a szerepköréhez tartozó teljes menüt látja — elrejteni ott
          érdemes, ahol egy funkció az adott szerepkör napi munkájához nem tartozik.
        </p>
      </div>

      {res.success ? (
        <MenuAccessPanel initialPolicy={res.data.policy} />
      ) : (
        <p className="text-sm text-ink-faint">{res.error}</p>
      )}
    </div>
  )
}

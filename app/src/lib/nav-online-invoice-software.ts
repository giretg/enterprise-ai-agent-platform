import { z } from 'zod'

/** A NAV Online Számla kérések `software` blokkja: a platform mint lekérdező szoftver adatai. */
export const NAV_SOFTWARE_PLATFORM_KEY = 'nav.online_invoice.software'

export const navSoftwareSchema = z.object({
  softwareId: z
    .string()
    .trim()
    .regex(/^[0-9A-Z-]{18}$/, 'A szoftver-azonosító pontosan 18 karakter (nagybetű, szám, kötőjel).'),
  softwareName: z.string().trim().min(1, 'Add meg a szoftver nevét.').max(50),
  softwareMainVersion: z.string().trim().min(1, 'Add meg a szoftver verzióját.').max(15),
  softwareDevName: z.string().trim().min(1, 'Add meg a fejlesztő nevét.').max(512),
  softwareDevContact: z.string().trim().min(1, 'Add meg a fejlesztő elérhetőségét (e-mail).').max(200),
  softwareDevCountryCode: z.string().trim().regex(/^[A-Z]{2}$/, 'Az országkód két nagybetű (pl. HU).').default('HU'),
  softwareDevTaxNumber: z.string().trim().min(1, 'Add meg a fejlesztő adószámát.').max(50),
})
export type NavSoftware = z.infer<typeof navSoftwareSchema>

export function parseNavSoftware(raw: unknown): NavSoftware | null {
  const parsed = navSoftwareSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export async function loadNavSoftware(): Promise<NavSoftware | null> {
  const { prisma } = await import('@/lib/db')
  const row = await prisma.platformSetting.findUnique({ where: { key: NAV_SOFTWARE_PLATFORM_KEY } })
  return parseNavSoftware(row?.value)
}

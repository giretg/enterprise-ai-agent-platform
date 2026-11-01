import { managedInstallerFilename, type InstallerPlatform } from '@/domain/client-policy/installer-filename'

/** A munkatárshoz tartozó céges telepítő letöltése a gépi beállítás API-ról. */
export async function downloadManagedInstaller(
  userId: string,
  platform: InstallerPlatform = 'posix',
): Promise<void> {
  const query = new URLSearchParams({ userId, format: 'installer', platform })
  const response = await fetch(`/api/client-policy/machine-floor?${query}`)
  if (!response.ok) throw new Error('download_failed')
  const url = URL.createObjectURL(await response.blob())
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = managedInstallerFilename(platform)
    link.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

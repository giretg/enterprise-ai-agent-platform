import { MANAGED_INSTALLER_FILENAME } from '@/domain/client-policy/installer-filename'

/** A munkatárshoz tartozó céges telepítő letöltése a gépi beállítás API-ról. */
export async function downloadManagedInstaller(userId: string): Promise<void> {
  const response = await fetch(
    `/api/client-policy/machine-floor?userId=${encodeURIComponent(userId)}&format=installer`,
  )
  if (!response.ok) throw new Error('download_failed')
  const url = URL.createObjectURL(await response.blob())
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = MANAGED_INSTALLER_FILENAME
    link.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

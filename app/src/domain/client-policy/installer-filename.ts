/** A Control Plane által kiadott egyfájlos céges telepítő neve. */
export const MANAGED_INSTALLER_FILENAME = 'excellence-telepito.sh'
export const MANAGED_WINDOWS_INSTALLER_FILENAME = 'excellence-telepito.ps1'

export type InstallerPlatform = 'posix' | 'windows'

export function managedInstallerFilename(platform: InstallerPlatform): string {
  return platform === 'windows' ? MANAGED_WINDOWS_INSTALLER_FILENAME : MANAGED_INSTALLER_FILENAME
}

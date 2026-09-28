export const PROJECT_WORK_ERROR_LABELS: Record<string, string> = {
  approver_not_authorized: 'Ehhez jóváhagyói szerep kell. Nézegetni szabad, írni nem.',
  NO_USER: 'Jelentkezz be újra.',
  NO_TENANT: 'Nincs aktív tenant.',
  INSUFFICIENT_ROLE: 'Nincs jogosultságod ehhez.',
  TENANT_NOT_ACTIVE: 'A tenant nem aktív.',
  invalid_args: 'Érvénytelen kérés.',
  schema_mismatch: 'A művelet nem sikerült.',
  invalid_project_key: 'Érvénytelen projektazonosító.',
  reserved_project_key: 'Az Általános projekt beépített, nem hozható létre.',
  unknown_project: 'Ismeretlen projekt.',
  project_key_taken: 'Ilyen kulccsal már van projekt.',
  invalid_path: 'Érvénytelen fájlútvonal.',
  file_not_found: 'A fájl nem található.',
  file_too_large: 'A fájl túl nagy (legfeljebb 200 KB).',
  quota_exceeded: 'Betelt a projekt tárhelye.',
  secret_blocked: 'Titoknak tűnő tartalom — az írás blokkolva.',
  invalid_memory_kind: 'Tölts ki minden mezőt (a cím és a tartalom kötelező).',
  memory_not_found: 'Ez az emlék már nem aktív — időközben felülírták.',
  agent_not_found: 'A munkatárs nem található.',
  'Agent not found': 'A munkatárs nem található.',
}

export function projectWorkErrorLabel(code: string, t?: (key: string) => string): string {
  if (t) {
    const key = `errors.${code}`
    return code in PROJECT_WORK_ERROR_LABELS ? t(key) : t('errors.fallback')
  }
  return PROJECT_WORK_ERROR_LABELS[code] ?? 'A művelet nem sikerült.'
}

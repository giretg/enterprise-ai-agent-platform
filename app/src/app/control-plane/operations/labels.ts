export const OPERATION_ERROR_LABELS: Record<string, string> = {
  approver_not_authorized: 'Nincs jogod jóváhagyni vagy elutasítani ezt a műveletet.',
  operation_not_found: 'A művelet nem található.',
  operation_not_awaiting_approval: 'Ez a művelet már nem vár jóváhagyásra.',
  approval_already_decided: 'Erről a műveletről már döntöttek.',
  drive_write_not_allowed: 'A Google Drive írás ehhez a mappához nem engedélyezett.',
  google_drive_auth_failed: 'A Google Drive bejelentkezés sikertelen.',
  google_drive_api_error: 'A Google Drive kérés sikertelen.',
  tool_execution_failed: 'A művelet végrehajtása sikertelen.',
  http_api_error: 'A célrendszer elutasította a kérést.',
  missing_api_key: 'A connectorhoz nincs beállítva API-kulcs.',
  agent_access_denied: 'Ehhez a munkatárshoz már nincs működési jogod.',
  invalid_args: 'Érvénytelen kérés.',
  schema_mismatch:
    'Az adatbázis séma nem a Core MVP. A jóváhagyási sor a gateway_operations táblát igényli.',
}

export function operationErrorLabel(code: string): string {
  return OPERATION_ERROR_LABELS[code] ?? 'A művelet nem sikerült.'
}

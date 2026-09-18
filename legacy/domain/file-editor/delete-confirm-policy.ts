/** Deliverable kimenetek: törlés csak explicit confirm:true-val (continue regresszió ellen). */
const DELETE_CONFIRM_EXT = /\.(xlsx|xlsm|docx|pptx)$/i

export function requiresDeleteConfirm(path: string): boolean {
  return DELETE_CONFIRM_EXT.test(path)
}

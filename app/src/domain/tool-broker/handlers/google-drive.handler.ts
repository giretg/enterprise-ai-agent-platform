import { GoogleDriveApiClient } from '@/domain/connector-grant/google-drive-api-client'
import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

const GOOGLE_DRIVE_TOOLS = new Set([
  'google_drive_search',
  'google_drive_get_file',
  'google_drive_read_file',
  'google_drive_list_drives',
  'google_drive_create_folder',
  'google_drive_upload_file',
  'google_drive_update_file',
  'google_drive_rename_file',
  'google_drive_move_file',
  'google_drive_copy_file',
  'google_drive_trash_file',
  'google_drive_restore_file',
  'google_drive_share_file',
  'google_docs_apply_edits',
  'google_sheets_write_range',
  'google_slides_apply_edits',
])

export const googleDriveHandler: ToolHandler = {
  id: 'google_drive',
  handles(tool) {
    return GOOGLE_DRIVE_TOOLS.has(tool)
  },
  async execute({ ctx, input, authorization }: ToolHandlerArgs) {
    const accessToken = await ctx.resolveDelegatedAccessToken(input, authorization)
    const drive = new GoogleDriveApiClient(accessToken)

    switch (input.tool) {
      case 'google_drive_search':
        return drive.search(input.args)
      case 'google_drive_get_file':
        return drive.getFile(input.args)
      case 'google_drive_read_file':
        return drive.readFile(input.args)
      case 'google_drive_list_drives':
        return drive.listDrives(input.args)
      case 'google_drive_create_folder':
        return drive.createFolder(input.args)
      case 'google_drive_rename_file':
        return drive.renameFile(input.args)
      case 'google_drive_move_file':
        return drive.moveFile(input.args)
      case 'google_drive_copy_file':
        return drive.copyFile(input.args)
      case 'google_drive_trash_file': {
        const file = await drive.trashFile(input.args)
        return file
      }
      case 'google_drive_restore_file': {
        const file = await drive.restoreFile(input.args)
        return file
      }
      case 'google_drive_share_file':
        return drive.shareFile(input.args)
      case 'google_drive_update_file':
        if (!input.args.textContent) {
          throw new Error('google_drive_update_file requires textContent in v1')
        }
        return drive.updateTextContent({
          fileId: input.args.fileId,
          textContent: input.args.textContent,
          expectedModifiedTime: input.args.expectedModifiedTime,
        })
      case 'google_drive_upload_file':
        throw new Error(
          'google_drive_upload_file requires artifactRef upload pipeline — v1-ben text-only update_file csak text/* MIME-ra biztonságos.',
        )
      case 'google_docs_apply_edits':
      case 'google_sheets_write_range':
      case 'google_slides_apply_edits':
        // Ne irányítsuk google_drive_update_file-ra: a textContent media-upload
        // Workspace/bináris MIME-n adatvesztést okozna.
        throw new Error(
          `${input.tool} not implemented in v1 — native Docs/Sheets/Slides edit API required (google_drive_update_file textContent is text/* only)`,
        )
      default:
        throw new Error(`Unknown Google Drive tool: ${input.tool}`)
    }
  },
}

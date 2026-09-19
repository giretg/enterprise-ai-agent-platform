/**
 * Enterprise tool gateway: snapshot policy + live connector/grant checks.
 * Drive read is synchronous; writes enqueue a GatewayOperation (#541).
 */
export {
  authorizeToolCall,
  type AuthorizeToolCallDeps,
  type AuthorizeToolCallInput,
  type AuthorizeToolCallResult,
  type LiveConnectorRow,
  type LiveGrantRow,
  type ToolCallPrincipal,
} from './authorize-tool-call'
export { invokeEnterpriseTool, type EnterpriseToolDeps, type EnterpriseToolMcpResult } from './invoke-enterprise-tool'
export { asUuid, ENTERPRISE_TOOL_ERROR_MESSAGES, enterpriseToolErrorMessage } from './tool-error-messages'
export {
  ENTERPRISE_DRIVE_TOOLS,
  ENTERPRISE_DRIVE_WRITE_TOOLS,
  ENTERPRISE_KB_TOOLS,
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  GOOGLE_DRIVE_READ_FILE_TOOL,
  GOOGLE_DRIVE_SEARCH_TOOL,
  KB_GET_PAGE_TOOL,
  KB_INGEST_TOOL,
  KB_LIST_INDEX_TOOL,
  KB_SEARCH_TOOL,
  googleDriveCreateFolderInputSchema,
  googleDriveReadFileInputSchema,
  googleDriveSearchInputSchema,
  kbGetPageInputSchema,
  kbIngestInputSchema,
  kbListIndexInputSchema,
  kbSearchInputSchema,
  isEnterpriseDriveTool,
  isEnterpriseDriveWriteTool,
  isEnterpriseKbTool,
  isEnterpriseTool,
  schemaForEnterpriseDriveTool,
  schemaForEnterpriseKbTool,
  type EnterpriseDriveTool,
  type EnterpriseDriveWriteTool,
  type EnterpriseKbTool,
} from './tool-definitions'

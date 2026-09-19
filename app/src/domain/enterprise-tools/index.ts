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
export {
  invokeEnterpriseTool,
  authorizationLinkFields,
  type EnterpriseToolDeps,
  type EnterpriseToolMcpResult,
  type StartDelegatedAuthorization,
} from './invoke-enterprise-tool'
export { asUuid, ENTERPRISE_TOOL_ERROR_MESSAGES, enterpriseToolErrorMessage, enterpriseToolErrorPayload } from './tool-error-messages'
export {
  ENTERPRISE_DRIVE_TOOLS,
  ENTERPRISE_DRIVE_WRITE_TOOLS,
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  GOOGLE_DRIVE_READ_FILE_TOOL,
  GOOGLE_DRIVE_SEARCH_TOOL,
  googleDriveCreateFolderInputSchema,
  googleDriveReadFileInputSchema,
  googleDriveSearchInputSchema,
  isEnterpriseDriveTool,
  isEnterpriseDriveWriteTool,
  schemaForEnterpriseDriveTool,
  type EnterpriseDriveTool,
  type EnterpriseDriveWriteTool,
} from './tool-definitions'

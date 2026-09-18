/**
 * Enterprise tool gateway: snapshot policy + live connector/grant checks.
 * Drive read tools only (#540). Writes stay on #541.
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
export {
  ENTERPRISE_DRIVE_TOOLS,
  GOOGLE_DRIVE_READ_FILE_TOOL,
  GOOGLE_DRIVE_SEARCH_TOOL,
  googleDriveReadFileInputSchema,
  googleDriveSearchInputSchema,
  isEnterpriseDriveTool,
  schemaForEnterpriseDriveTool,
  type EnterpriseDriveTool,
} from './tool-definitions'

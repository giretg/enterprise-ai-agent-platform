/**
 * Stdio MCP bridge — Goose extension → platform Tool Broker REST API (S3 spike).
 */
import {
  handleMcpRequest,
  invokePlatformToolViaHttp,
  readMcpFramedMessages,
} from '../src/harness/platform-mcp-bridge'

readMcpFramedMessages(process.stdin, (message) =>
  handleMcpRequest(message, (tool, args) => invokePlatformToolViaHttp(tool, args, process.env)),
).catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
})

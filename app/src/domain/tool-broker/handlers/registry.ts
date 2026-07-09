/**
 * WP-8 — tool-név → handler feloldás. A regiszter egy rendezett lista; az elso
 * `handles(tool)===true` handler nyer. Így az egzakt nevek és a prefix-csoportok
 * (file_, sandbox_app.) egységesen kezelhetok.
 *
 * Új tool bekötése: importáld a handlert és vedd fel a `TOOL_HANDLERS` listába
 * (a broker-mag nem módosul).
 */
import type { ToolHandler } from './tool-handler'
import { kbHandler } from './kb.handler'
import { boardWriteHandler } from './board-write.handler'
import { ticketCreateHandler } from './ticket-create.handler'
import { agentAskHandler } from './agent-ask.handler'
import { webResearchHandler } from './web-research.handler'
import { agentDirectoryHandler } from './agent-directory.handler'
import { webSearchHandler } from './web-search.handler'
import { httpApiHandler } from './http-api.handler'
import { repoHandler } from './repo.handler'
import { fileToolHandler } from './file.handler'
import { sandboxAppHandler } from './sandbox-app.handler'
import { sandboxVersioningHandler } from './sandbox-versioning.handler'
import { gmailHandler } from './gmail.handler'
import { memoryProposeHandler } from './memory.handler'

export const TOOL_HANDLERS: readonly ToolHandler[] = [
  kbHandler,
  boardWriteHandler,
  ticketCreateHandler,
  agentAskHandler,
  webResearchHandler,
  agentDirectoryHandler,
  webSearchHandler,
  httpApiHandler,
  repoHandler,
  fileToolHandler,
  sandboxAppHandler,
  sandboxVersioningHandler,
  gmailHandler,
  memoryProposeHandler,
]

export function resolveToolHandler(tool: string): ToolHandler | undefined {
  return TOOL_HANDLERS.find((handler) => handler.handles(tool))
}

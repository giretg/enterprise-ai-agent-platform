import type { ToolBrokerInvokeInput } from '@/domain/tool-broker/tool-broker-service'
import type { ToolBrokerService } from '@/domain/tool-broker/tool-broker-service'
import type {
  GatewayMessage,
  GatewayToolCall,
  ModelConfig,
  ModelGateway,
  ToolDefinition,
} from '@/domain/gateway/model-gateway'
import type { ToolBrokerRepository } from '@/repositories/interfaces'
import type { XlsxRow, XlsxSheetSpec, CellStyle, XlsxCellChange } from '@/domain/file-editor/adapters/xlsx-adapter'

/** Chatben hívható platform toolok (capability + connector alapján szűrve).
 *  Kihagyva: kb_search (előre lefut a runtime-ban), board_write (belső ticket állapotgép). */
export const CHAT_PLATFORM_TOOLS = [
  'agent_catalog',
  'agent_resolve',
  'ticket_create',
  'agent_ask',
  'gmail_search',
  'gmail_get_message',
  'gmail_create_draft',
  'gmail_send',
  'file_read',
  'file_write',
  'file_edit',
  'file_list',
  'file_glob',
  'file_search',
  'file_delete',
  'xlsx_read_sheet',
  'xlsx_write_cells',
  'xlsx_append_rows',
  'xlsx_create',
  'xlsx_format_range',
  'xlsx_layout',
  'docx_read',
  'pdf_read',
  'pdf_create',
] as const

export type ChatPlatformToolName = (typeof CHAT_PLATFORM_TOOLS)[number]

/**
 * Kontextus-agnosztikus tool loop kontextus: vagy egy chat beszélgetés
 * (`conversationId`), vagy egy aszinkron feladat-ticket (`ticketId`).
 * A két ág kölcsönösen kizáró — egyszerre csak az egyik adható meg.
 */
export type ToolLoopContext =
  | { conversationId: string; ticketId?: never }
  | { ticketId: string; conversationId?: never }

export type ToolLoopMode = 'chat' | 'task'

// A tool definíciók most NATÍVAN mennek a modellnek (function calling) — a
// részletes paraméter-leírás a séma (TOOL_SCHEMAS). Itt csak rövid viselkedési
// irányelv marad; NINCS szövegbe ágyazott JSON-protokoll.
const TOOL_INSTRUCTION = `
Ha külső adatra (email, fájl, más agent) vagy ticketre / fájlműveletre van szükség, NE találj ki tényt — hívd a megfelelő eszközt a natív tool-hívással (function call).
- Cselekvéskor (pl. fájl/Excel létrehozása) NE csak írd le szövegesen, hogy mit fogsz tenni — azonnal hívd az eszközt.
- Email-lekérdezésnél (pl. „milyen leveleim vannak ma”) ELŐSZÖR a gmail_search eszközt hívd, ne a tudásbázist.
- XLSX: a cellaérték (value) csak konkrét adat (szöveg/szám/logikai). A megjelenést (félkövér fejléc, háttérszín, igazítás, oszlopszélesség) KIZÁRÓLAG a megfelelő mezőkkel állítsd — a cella style/numFmt mezője (xlsx_write_cells), vagy az xlsx_format_range / xlsx_layout eszköz. SOHA ne írj stílus-JSON-t vagy elrendezést cellaértékként, és ne tegyél meta-sorokat (forrás, tulajdonos) a fejléc helyére.
- Ha nincs több eszközszükséglet, válaszolj természetes magyar szöveggel.
`

const STR = { type: 'string' } as const
const NUM = { type: 'number' } as const
const BOOL = { type: 'boolean' } as const
// Cellaérték: KIZÁRÓLAG konkrét skalár (szöveg/szám/logikai/null) — NEM stílus
// vagy elrendezés. A formázás a `style` mezőbe megy, nem a value-ba.
const CELL_VALUE = { type: ['string', 'number', 'boolean', 'null'] } as const

type ToolSchema = { description: string; inputSchema: Record<string, unknown> }

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: true }
}

/** XLSX cella-stílus séma (CellStyle tükre) — fontos, hogy a modell ezt a
 *  strukturált alakot adja meg, ne stílus-JSON-t írjon cellaértékként. */
const STYLE_SCHEMA = objectSchema({
  font: objectSchema({ bold: BOOL, italic: BOOL, size: NUM, color: STR, name: STR }),
  fill: objectSchema({ color: STR }),
  alignment: objectSchema({
    horizontal: { type: 'string', enum: ['left', 'center', 'right'] },
    vertical: { type: 'string', enum: ['top', 'middle', 'bottom'] },
    wrapText: BOOL,
  }),
  numFmt: STR,
})

/** A platform toolok natív JSON Schema definíciói (function calling). */
const TOOL_SCHEMAS: Record<ChatPlatformToolName, ToolSchema> = {
  agent_catalog: {
    description: 'Szervezeti agentek katalógusa — keresés nicknév/név alapján vagy konkrét agentId-vel.',
    inputSchema: objectSchema({ query: STR, agentId: STR, limit: NUM }),
  },
  agent_resolve: {
    description: 'Egy agent feloldása név/nicknév szerint UUID-re.',
    inputSchema: objectSchema({ query: STR, limit: NUM }, ['query']),
  },
  ticket_create: {
    description: 'Új Kanban ticket létrehozása (feladat humán vagy agent felelősnek).',
    inputSchema: objectSchema(
      {
        title: STR,
        payload: { type: 'object', additionalProperties: true },
        assigneeType: { type: 'string', enum: ['human', 'agent'] },
        assigneeId: STR,
        sourceDocumentId: STR,
      },
      ['title'],
    ),
  },
  agent_ask: {
    description: 'Kérdés egy másik agentnek. CSAK completed:true esetén idézd a választ.',
    inputSchema: objectSchema(
      { targetAgentId: STR, question: STR, context: { type: 'object', additionalProperties: true } },
      ['targetAgentId', 'question'],
    ),
  },
  gmail_search: {
    description: 'Gmail keresés (Gmail keresőszintaxis, pl. "is:unread newer_than:1d").',
    inputSchema: objectSchema({ query: STR, maxResults: NUM }, ['query']),
  },
  gmail_get_message: {
    description: 'Egy Gmail levél teljes tartalma messageId alapján.',
    inputSchema: objectSchema({ id: STR }, ['id']),
  },
  gmail_create_draft: {
    description: 'Gmail piszkozat létrehozása.',
    inputSchema: objectSchema({ to: STR, subject: STR, body: STR, threadId: STR }, ['to', 'subject', 'body']),
  },
  gmail_send: {
    description: 'Gmail küldés — jóváhagyott ticket mellett (draftId vagy közvetlen mezők).',
    inputSchema: objectSchema({ draftId: STR, to: STR, subject: STR, body: STR, approvalTicketId: STR }),
  },
  file_read: {
    description: 'Munkaterület fájl beolvasása (opcionális offset/limit sorokkal).',
    inputSchema: objectSchema({ path: STR, offset: NUM, limit: NUM }, ['path']),
  },
  file_write: {
    description: 'Munkaterület fájl írása (felülír / létrehoz).',
    inputSchema: objectSchema({ path: STR, content: STR }, ['path', 'content']),
  },
  file_edit: {
    description: 'Pontos string-csere egy munkaterület fájlban.',
    inputSchema: objectSchema(
      { path: STR, old_string: STR, new_string: STR, replace_all: BOOL },
      ['path', 'old_string', 'new_string'],
    ),
  },
  file_list: {
    description: 'Munkaterület fájlok listázása (opcionálisan rekurzívan).',
    inputSchema: objectSchema({ path: STR, recursive: BOOL }),
  },
  file_glob: {
    description: 'Fájlkeresés glob mintával (pl. "**/*.csv").',
    inputSchema: objectSchema({ pattern: STR }, ['pattern']),
  },
  file_search: {
    description: 'Tartalom-keresés regex mintával a munkaterületen.',
    inputSchema: objectSchema(
      { pattern: STR, path: STR, glob: STR, ignore_case: BOOL, max_results: NUM },
      ['pattern'],
    ),
  },
  file_delete: {
    description: 'Munkaterület fájl törlése.',
    inputSchema: objectSchema({ path: STR }, ['path']),
  },
  xlsx_read_sheet: {
    description: 'Egy XLSX munkalap beolvasása.',
    inputSchema: objectSchema({ path: STR, sheet: STR, max_rows: NUM }, ['path']),
  },
  xlsx_write_cells: {
    description:
      'Cellák írása ÉS formázása egy XLSX munkalapon. Minden change: { cell, value, style?, numFmt? }. ' +
      'A `value` csak konkrét érték (szöveg/szám/logikai/null); a megjelenést (félkövér, szín, igazítás) a `style` mezőbe tedd — SOHA ne írj stílus-JSON-t a value-ba. ' +
      'Ha a fájl még nem létezik, automatikusan létrejön (NE használj file_write-ot XLSX-hez).',
    inputSchema: objectSchema(
      {
        path: STR,
        sheet: STR,
        changes: {
          type: 'array',
          items: objectSchema({ cell: STR, value: CELL_VALUE, style: STYLE_SCHEMA, numFmt: STR }, ['cell']),
        },
      },
      ['path', 'changes'],
    ),
  },
  xlsx_append_rows: {
    description:
      'Sorok hozzáfűzése egy XLSX munkalaphoz. Ha a fájl még nem létezik, automatikusan létrejön (NE használj file_write-ot XLSX-hez).',
    inputSchema: objectSchema(
      { path: STR, sheet: STR, rows: { type: 'array', items: { type: 'array', items: {} } } },
      ['path', 'rows'],
    ),
  },
  xlsx_create: {
    description:
      'ÚJ XLSX munkafüzet létrehozása egy vagy több munkalappal és sorokkal. Új Excel készítésekor EZT hívd — a fejléc + adatsorok egyetlen hívásban megadhatók a sheets[].rows mezőben.',
    inputSchema: objectSchema(
      {
        path: STR,
        sheets: {
          type: 'array',
          items: objectSchema(
            { name: STR, rows: { type: 'array', items: { type: 'array', items: {} } } },
            ['name'],
          ),
        },
      },
      ['path', 'sheets'],
    ),
  },
  xlsx_format_range: {
    description:
      'Cellatartomány (pl. "A1:F1") formázása egyben: font (bold/italic/size/color), fill (háttérszín), alignment. Fejléc és sávozás formázásához EZT használd, ne a value-t.',
    inputSchema: objectSchema(
      { path: STR, sheet: STR, range: STR, style: STYLE_SCHEMA },
      ['path', 'range', 'style'],
    ),
  },
  xlsx_layout: {
    description: 'Munkalap-elrendezés: cellaegyesítés, oszlopszélesség, sormagasság, rögzítés, autoszűrő.',
    inputSchema: objectSchema(
      {
        path: STR,
        sheet: STR,
        mergeCells: { type: 'array', items: STR },
        columnWidths: { type: 'array', items: objectSchema({ column: STR, width: NUM }, ['column', 'width']) },
        rowHeights: { type: 'array', items: objectSchema({ row: NUM, height: NUM }, ['row', 'height']) },
        freeze: objectSchema({ rows: NUM, columns: NUM }),
        autoFilter: STR,
      },
      ['path'],
    ),
  },
  docx_read: {
    description: 'DOCX dokumentum szövegének beolvasása.',
    inputSchema: objectSchema({ path: STR }, ['path']),
  },
  pdf_read: {
    description: 'PDF szövegének beolvasása (opcionális oldaltartomány, pl. "1-3").',
    inputSchema: objectSchema({ path: STR, page_range: STR }, ['path']),
  },
  pdf_create: {
    description:
      'Táblázatos PDF létrehozása (valódi .pdf). PDF készítéséhez EZT hívd — ne file_write-ot vagy HTML/MD-t. ' +
      'Egy meglévő Excelből: add meg a source_xlsx-et (a munkalapot a PDF automatikusan átveszi). ' +
      'Vagy közvetlenül: headers + rows (sorok tömbök tömbjeként). title opcionális cím.',
    inputSchema: objectSchema(
      {
        path: STR,
        source_xlsx: STR,
        sheet: STR,
        title: STR,
        headers: { type: 'array', items: STR },
        rows: { type: 'array', items: { type: 'array', items: {} } },
      },
      ['path'],
    ),
  },
}

function toToolDefinitions(allowed: ChatPlatformToolName[]): ToolDefinition[] {
  return allowed.map((name) => ({ name, ...TOOL_SCHEMAS[name] }))
}

function isChatPlatformTool(name: string): name is ChatPlatformToolName {
  return (CHAT_PLATFORM_TOOLS as readonly string[]).includes(name)
}

// Vékony szöveges fallback: ha egy (gyenge) modell figyelmen kívül hagyja a natív
// tool use-t és mégis {"tool":...,"args":{...}} JSON-t ír, ezzel kimentjük.
function extractToolCall(content: string): { tool: string; args: Record<string, unknown> } | null {
  const trimmed = content.trim()

  const codeBlock = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i)
  const candidates = [codeBlock?.[1], trimmed.startsWith('{') ? trimmed : null]

  const inline = trimmed.match(/\{[\s\S]*"tool"\s*:\s*"[^"]+"[\s\S]*\}/)
  if (inline?.[0]) candidates.push(inline[0])

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate) as { tool?: string; args?: Record<string, unknown> }
      if (typeof parsed.tool === 'string' && parsed.args && typeof parsed.args === 'object') {
        return { tool: parsed.tool, args: parsed.args }
      }
    } catch {
      // continue
    }
  }
  return null
}

function stripToolArtifacts(content: string): string {
  return content
    .replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/gi, '')
    .replace(/\{[\s\S]*"tool"\s*:\s*"[^"]+"[\s\S]*\}/g, '')
    .trim()
}

function strArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  return typeof args[key] === 'string' ? args[key] : fallback
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  return typeof args[key] === 'number' ? args[key] : undefined
}

function boolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === 'boolean' ? args[key] : undefined
}

function recordArg(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key]
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function buildToolInvoke(
  tool: ChatPlatformToolName,
  args: Record<string, unknown>,
  base: {
    agentId: string
    agentVersion: number
    context: ToolLoopContext
    actingUserId?: string
  },
): ToolBrokerInvokeInput {
  const common = {
    agentId: base.agentId,
    agentVersion: base.agentVersion,
    ...base.context,
    ...(base.actingUserId ? { actingUserId: base.actingUserId } : {}),
  }

  switch (tool) {
    case 'agent_resolve':
      return {
        ...common,
        tool: 'agent_resolve',
        args: {
          query: strArg(args, 'query'),
          limit: numArg(args, 'limit'),
        },
      }

    case 'agent_catalog':
      return {
        ...common,
        tool: 'agent_catalog',
        args: {
          query: typeof args.query === 'string' ? args.query : undefined,
          agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
          limit: numArg(args, 'limit'),
        },
      }

    case 'ticket_create':
      return {
        ...common,
        tool: 'ticket_create',
        args: {
          title: strArg(args, 'title'),
          payload: recordArg(args, 'payload') ?? {},
          assigneeType: args.assigneeType === 'agent' ? 'agent' : 'human',
          assigneeId: typeof args.assigneeId === 'string' ? args.assigneeId : undefined,
          sourceDocumentId: typeof args.sourceDocumentId === 'string' ? args.sourceDocumentId : undefined,
        },
      }

    case 'agent_ask':
      return {
        ...common,
        tool: 'agent_ask',
        args: {
          targetAgentId: strArg(args, 'targetAgentId'),
          question: strArg(args, 'question'),
          context: recordArg(args, 'context'),
        },
      }

    case 'gmail_search':
      return {
        ...common,
        tool: 'gmail_search',
        args: {
          query: strArg(args, 'query'),
          maxResults: numArg(args, 'maxResults'),
        },
      }

    case 'gmail_get_message':
      return {
        ...common,
        tool: 'gmail_get_message',
        args: { id: strArg(args, 'id') },
      }

    case 'gmail_create_draft':
      return {
        ...common,
        tool: 'gmail_create_draft',
        args: {
          to: strArg(args, 'to'),
          subject: strArg(args, 'subject'),
          body: strArg(args, 'body'),
          threadId: typeof args.threadId === 'string' ? args.threadId : undefined,
        },
      }

    case 'gmail_send':
      return {
        ...common,
        tool: 'gmail_send',
        args: {
          draftId: typeof args.draftId === 'string' ? args.draftId : undefined,
          to: typeof args.to === 'string' ? args.to : undefined,
          subject: typeof args.subject === 'string' ? args.subject : undefined,
          body: typeof args.body === 'string' ? args.body : undefined,
          approvalTicketId: typeof args.approvalTicketId === 'string' ? args.approvalTicketId : undefined,
        },
      }

    case 'file_read':
      return {
        ...common,
        tool: 'file_read',
        args: {
          path: strArg(args, 'path'),
          offset: numArg(args, 'offset'),
          limit: numArg(args, 'limit'),
        },
      }

    case 'file_write':
      return {
        ...common,
        tool: 'file_write',
        args: {
          path: strArg(args, 'path'),
          content: strArg(args, 'content'),
        },
      }

    case 'file_edit':
      return {
        ...common,
        tool: 'file_edit',
        args: {
          path: strArg(args, 'path'),
          old_string: strArg(args, 'old_string'),
          new_string: strArg(args, 'new_string'),
          replace_all: boolArg(args, 'replace_all'),
        },
      }

    case 'file_list':
      return {
        ...common,
        tool: 'file_list',
        args: {
          path: typeof args.path === 'string' ? args.path : undefined,
          recursive: boolArg(args, 'recursive'),
        },
      }

    case 'file_glob':
      return {
        ...common,
        tool: 'file_glob',
        args: { pattern: strArg(args, 'pattern') },
      }

    case 'file_search':
      return {
        ...common,
        tool: 'file_search',
        args: {
          pattern: strArg(args, 'pattern'),
          path: typeof args.path === 'string' ? args.path : undefined,
          glob: typeof args.glob === 'string' ? args.glob : undefined,
          ignore_case: boolArg(args, 'ignore_case'),
          max_results: numArg(args, 'max_results'),
        },
      }

    case 'file_delete':
      return {
        ...common,
        tool: 'file_delete',
        args: { path: strArg(args, 'path') },
      }

    case 'xlsx_read_sheet':
      return {
        ...common,
        tool: 'xlsx_read_sheet',
        args: {
          path: strArg(args, 'path'),
          sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
          max_rows: numArg(args, 'max_rows'),
        },
      }

    case 'xlsx_write_cells':
      return {
        ...common,
        tool: 'xlsx_write_cells',
        args: {
          path: strArg(args, 'path'),
          sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
          changes: Array.isArray(args.changes) ? (args.changes as XlsxCellChange[]) : [],
        },
      }

    case 'xlsx_append_rows':
      return {
        ...common,
        tool: 'xlsx_append_rows',
        args: {
          path: strArg(args, 'path'),
          sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
          rows: Array.isArray(args.rows) ? (args.rows as XlsxRow[]) : [],
        },
      }

    case 'xlsx_create':
      return {
        ...common,
        tool: 'xlsx_create',
        args: {
          path: strArg(args, 'path'),
          sheets: Array.isArray(args.sheets) ? (args.sheets as XlsxSheetSpec[]) : [],
        },
      }

    case 'xlsx_format_range':
      return {
        ...common,
        tool: 'xlsx_format_range',
        args: {
          path: strArg(args, 'path'),
          sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
          range: strArg(args, 'range'),
          style: (args.style as CellStyle) ?? {},
        },
      }

    case 'xlsx_layout':
      return {
        ...common,
        tool: 'xlsx_layout',
        args: {
          path: strArg(args, 'path'),
          sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
          mergeCells: Array.isArray(args.mergeCells) ? (args.mergeCells as string[]) : undefined,
          columnWidths: Array.isArray(args.columnWidths)
            ? (args.columnWidths as Array<{ column: string; width: number }>)
            : undefined,
          rowHeights: Array.isArray(args.rowHeights)
            ? (args.rowHeights as Array<{ row: number; height: number }>)
            : undefined,
          freeze:
            args.freeze && typeof args.freeze === 'object' && !Array.isArray(args.freeze)
              ? (args.freeze as { rows?: number; columns?: number })
              : undefined,
          autoFilter: typeof args.autoFilter === 'string' ? args.autoFilter : undefined,
        },
      }

    case 'docx_read':
      return {
        ...common,
        tool: 'docx_read',
        args: { path: strArg(args, 'path') },
      }

    case 'pdf_read':
      return {
        ...common,
        tool: 'pdf_read',
        args: {
          path: strArg(args, 'path'),
          page_range: typeof args.page_range === 'string' ? args.page_range : undefined,
        },
      }

    case 'pdf_create':
      return {
        ...common,
        tool: 'pdf_create',
        args: {
          path: strArg(args, 'path'),
          source_xlsx: typeof args.source_xlsx === 'string' ? args.source_xlsx : undefined,
          sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
          title: typeof args.title === 'string' ? args.title : undefined,
          headers: Array.isArray(args.headers) ? (args.headers as string[]) : undefined,
          rows: Array.isArray(args.rows)
            ? (args.rows as Array<Array<string | number | boolean | null>>)
            : undefined,
        },
      }

    default: {
      const _exhaustive: never = tool
      throw new Error(`Unsupported chat tool: ${_exhaustive}`)
    }
  }
}

/**
 * Egységes, kontextus-agnosztikus agent tool loop. Chat (`conversationId`) és
 * feladat-ticket (`ticketId`) kontextusban egyaránt fut — a képességek
 * azonosak, csak a kontextus (és a board_write utómunka a hívónál) tér el.
 */
export async function runAgentToolLoop(params: {
  gateway: ModelGateway
  toolBroker: ToolBrokerService
  toolCaps: ToolBrokerRepository
  agentId: string
  agentVersion: number
  context: ToolLoopContext
  mode: ToolLoopMode
  /** Chatben a beszélgető felhasználó; taskban a broker oldja fel a ticket run-as payloadjából. */
  actingUserId?: string
  messages: GatewayMessage[]
  modelConfig: ModelConfig
  allowedTools: ChatPlatformToolName[]
  maxTurns?: number
}): Promise<{ content: string; toolCallCount: number }> {
  const maxTurns = params.maxTurns ?? 10
  const modeNote =
    params.mode === 'task'
      ? 'Ez egy aszinkron feladat — a végeredményed visszakerül a ticketbe. Dolgozz végig minden szükséges eszközhívást, majd add meg a kész választ természetes magyar szövegként (NE JSON).'
      : 'Ez egy közvetlen beszélgetés — a végén természetes magyar szöveggel válaszolj a felhasználónak (NE JSON).'
  const messages: GatewayMessage[] = [
    ...params.messages,
    { role: 'system', content: TOOL_INSTRUCTION },
    { role: 'system', content: modeNote },
    {
      role: 'system',
      content: `A számodra engedélyezett eszközök: ${params.allowedTools.join(', ')}`,
    },
    {
      role: 'system',
      content: `A te agent UUID-d: ${params.agentId} — ticket_create híváskor ha magadnak szeretnél assignálni, ezt add meg assigneeId-ként (assigneeType: "agent").`,
    },
  ]

  let toolCallCount = 0
  const tools = toToolDefinitions(params.allowedTools)

  for (let turn = 0; turn < maxTurns; turn++) {
    const { content, toolCalls } = await params.gateway.call({
      agentId: params.agentId,
      ...params.context,
      messages,
      modelConfig: params.modelConfig,
      ...(tools.length ? { tools } : {}),
    })

    // Natív tool hívások; ha nincs, a vékony fallback megpróbálja a beágyazott
    // {"tool":...} JSON-t kimenteni (gyenge modellek kedvéért).
    let calls: GatewayToolCall[] = toolCalls ?? []
    if (calls.length === 0) {
      const fallback = extractToolCall(content)
      if (fallback) {
        calls = [{ id: `fallback_${turn}`, name: fallback.tool, input: fallback.args }]
      }
    }

    if (calls.length === 0) {
      const cleaned = stripToolArtifacts(content)
      if (cleaned) return { content: cleaned, toolCallCount }

      if (turn < maxTurns - 1) {
        messages.push({
          role: 'user',
          content: '[Belső] Üres válasz. Fogalmazd meg magyarul a felhasználónak.',
        })
        continue
      }
      return { content: content.trim() || 'Nem kaptam választ a modelltől.', toolCallCount }
    }

    // Az asszisztens turn (szöveg + tool hívások) bekerül a kontextusba, hogy a
    // tool eredmények a hívásokhoz köthetők legyenek.
    const assistantText = stripToolArtifacts(content)
    messages.push({
      role: 'assistant',
      ...(assistantText ? { content: assistantText } : {}),
      toolCalls: calls,
    })

    for (const call of calls) {
      if (!isChatPlatformTool(call.name) || !params.allowedTools.includes(call.name)) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: `ELUTASÍTVA: az eszköz „${call.name}" nem elérhető. Engedélyezett: ${params.allowedTools.join(', ')}`,
        })
        continue
      }

      try {
        const invokeInput = buildToolInvoke(call.name, call.input, {
          agentId: params.agentId,
          agentVersion: params.agentVersion,
          context: params.context,
          actingUserId: params.actingUserId,
        })

        const result = await params.toolBroker.invoke(invokeInput)
        toolCallCount += 1

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: result.denied
            ? `ELUTASÍTVA: ${result.reason}`
            : JSON.stringify(result.result),
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : 'tool_call_failed'
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: `HIBA: ${message}`,
        })
      }
    }
  }

  messages.push({
    role: 'system',
    content:
      'Fogalmazd meg a felhasználónak magyarul. agent_ask: completed:true + answer → fogalmazd át; completed:false → mondd el hogy nem sikerült. Gmail/file eszköz: csak a tool eredményére támaszkodj, ne találj ki adatot. connector_grant_missing esetén jelezd hogy csatlakoztasd a fiókot. Ne használj JSON tool blokkot.',
  })

  const { content: finalContent } = await params.gateway.call({
    agentId: params.agentId,
    ...params.context,
    messages,
    modelConfig: params.modelConfig,
  })

  return {
    content: stripToolArtifacts(finalContent) || finalContent.trim(),
    toolCallCount,
  }
}

export async function listAllowedChatTools(
  toolCaps: ToolBrokerRepository,
  agentId: string,
): Promise<ChatPlatformToolName[]> {
  const caps = await toolCaps.findCapabilitiesForAgent(agentId)
  return caps
    .filter((c) => c.allowed && isChatPlatformTool(c.toolName))
    .map((c) => c.toolName as ChatPlatformToolName)
}

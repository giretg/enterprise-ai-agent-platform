/**
 * Tool-onkénti KIMENETI SZERZŐDÉSEK (issue #195, WP-3 + WP-4).
 *
 * `Record<ToolName, ToolOutputContract>` → KIMERÍTŐ: egy új tool hozzáadása
 * fordításidőben kényszeríti a szerződés-döntést, ahogy a bizalmi regiszternél
 * (`tool-trust-registry.ts`) is. Egy elfelejtett szerződés nem maradhat ki.
 *
 * ÜZLETI OLVASAT — mit fog meg ez a fájl:
 *   - `xlsx_append_rows` 0 sorral, `xlsx_write_cells` 0 cellával → ez az ÜRES
 *     EXCEL hibaosztály gyökere: eddig `ok`-ként ment vissza;
 *   - `file_edit` 0 cserével → a „megjavítottam" válasz, ami valójában nem
 *     változtatott semmit;
 *   - `kb_search` / `file_search` / `gmail_search` 0 találattal → az agent
 *     eddig könnyen továbbment, mintha talált volna valamit;
 *   - `repo_open_pull_request` `changed:false` → „megnyitottam a PR-t", holott
 *     nem volt mit beletenni.
 *
 * MÉRT HATÁS (D4): a mellékhatásos toolok `effect`-je mindig a handler által
 * VISSZAADOTT, mért mezőből jön (bytesWritten, cellsUpdated, rowsAppended,
 * filesChanged, draftId…), sosem a puszta „ok: true" állításból.
 *
 * MÉRET-KAPU (D6): tool-onkénti `maxModelBytes` szándékosan NINCS beállítva.
 * Az issue kockázati megjegyzése szerint a szigorú korlát feladatokat törhet el,
 * ezért az első kör a globális, bő alapértelmezés (`DEFAULT_MAX_MODEL_BYTES`) —
 * a chat-tool-loop munkaterületre kitelepítő archiválása ennél jóval hamarabb
 * lép, tehát a modell így is védve van. A tool-onkénti szigorítás a valós
 * méret-eloszlás ismeretében, külön lépésben élesíthető.
 */
import { z } from 'zod'

import type { ToolName } from './tool-broker-types'
import type { ToolEffectSummary, ToolOutputContract } from './tool-output-contract'

// ── Alak-olvasó segédek ──────────────────────────────────────────────────────
// A predikátumok szándékosan NEM kasztolnak a domain-típusra: a szerződésnek a
// tényleges futásidejű alakról kell döntenie, nem arról, amit a típus ígér.

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function num(value: unknown, key: string): number | null {
  const raw = rec(value)[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

function str(value: unknown, key: string): string | null {
  const raw = rec(value)[key]
  return typeof raw === 'string' ? raw : null
}

function arr(value: unknown, key: string): unknown[] | null {
  const raw = rec(value)[key]
  return Array.isArray(raw) ? raw : null
}

function bool(value: unknown, key: string): boolean | null {
  const raw = rec(value)[key]
  return typeof raw === 'boolean' ? raw : null
}

function effect(amount: number, unit: string, target: string | null): ToolEffectSummary {
  return { amount, unit, target }
}

/** Lista-alapú üresség egyetlen mezőre — a leggyakoribb minta. */
function emptyList(key: string, message: string) {
  return (output: unknown): string | null => {
    const list = arr(output, key)
    return list && list.length === 0 ? message : null
  }
}

/** Számlált mellékhatás egyetlen mért mezőből (0 → a broker `empty`-t ad). */
function countedEffect(countKey: string, unit: string, targetKey = 'path') {
  return (output: unknown): ToolEffectSummary | null => {
    const amount = num(output, countKey)
    if (amount === null) return null
    return effect(amount, unit, str(output, targetKey))
  }
}

/** Azonosító-alapú mellékhatás: a mért „hatás" maga a keletkezett azonosító. */
function identifiedEffect(idKey: string, unit: string) {
  return (output: unknown): ToolEffectSummary | null => {
    const id = str(output, idKey)
    if (!id) return effect(0, unit, null)
    return effect(1, unit, id)
  }
}

// ── Gyakori séma-építők ──────────────────────────────────────────────────────
// `looseObject`: az ismeretlen mezők ÁTMENNEK. A szerződés a szükséges mezőket
// kényszeríti ki, nem szűkíti a kimenetet (a broker amúgy is az eredeti
// objektumot adja tovább, nem a parse eredményét).

const listResult = (key: string) => z.looseObject({ [key]: z.array(z.unknown()) })
const pathAndCount = (countKey: string) =>
  z.looseObject({ path: z.string(), [countKey]: z.number() })

// ── D7 bemeneti méret-kapuk ──────────────────────────────────────────────────

/** Egy munkaterületi írás felső határa (a workspace-tár és a memória védelme). */
const MAX_WRITE_CONTENT_BYTES = 20 * 1024 * 1024
/** Egy hívásban hozzáfűzhető sorok felső határa. */
const MAX_APPEND_ROWS = 50_000
/** Inline átadott nyilvántartási sorok felső határa (nagy lista → fájlból). */
const MAX_INLINE_NYILVANTARTAS_ROWS = 20_000

function contentSizeLimit(field: string) {
  return (args: Record<string, unknown>): string | null => {
    const value = args[field]
    if (typeof value !== 'string') return null
    const bytes = Buffer.byteLength(value, 'utf8')
    return bytes > MAX_WRITE_CONTENT_BYTES
      ? `a beírandó tartalom ${bytes} bájt, a felső határ ${MAX_WRITE_CONTENT_BYTES} bájt. Darabold több írásra, vagy írd ki előbb egy köztes fájlba.`
      : null
  }
}

// ── A szerződés-regiszter ────────────────────────────────────────────────────

export const TOOL_OUTPUT_CONTRACTS: Record<ToolName, ToolOutputContract> = {
  // ── Levelezés ─────────────────────────────────────────────────────────────
  gmail_search: {
    outputSchema: listResult('messages'),
    emptiness: emptyList('messages', 'a keresés egyetlen levelet sem talált a megadott feltételre'),
  },
  gmail_get_message: {
    outputSchema: z.record(z.string(), z.unknown()),
    emptiness: (output) =>
      Object.keys(rec(output)).length === 0 ? 'a levél nem tartalmazott olvasható mezőt' : null,
  },
  mailbox_count: {
    // A 0 darabszám ÉRVÉNYES válasz egy „hány levél van?" kérdésre — nem üresség.
    outputSchema: z.looseObject({ count: z.number(), query: z.string() }),
    emptiness: () => null,
  },
  gmail_create_draft: {
    outputSchema: z.looseObject({ draftId: z.string() }),
    effect: identifiedEffect('draftId', 'létrehozott piszkozat'),
  },
  gmail_send: {
    outputSchema: z.looseObject({ messageId: z.string() }),
    effect: identifiedEffect('messageId', 'elküldött levél'),
  },

  google_drive_search: {
    outputSchema: listResult('files'),
    emptiness: emptyList('files', 'a keresés egyetlen Drive fájlt sem talált'),
  },
  google_drive_get_file: {
    outputSchema: z.record(z.string(), z.unknown()),
    emptiness: (output) =>
      Object.keys(rec(output)).length === 0 ? 'a fájl metaadat üres volt' : null,
  },
  google_drive_read_file: {
    outputSchema: z.looseObject({
      file: z.record(z.string(), z.unknown()),
      contentType: z.string(),
      truncated: z.boolean(),
      warnings: z.array(z.string()),
    }),
    emptiness: (output) =>
      !str(output, 'text') && (rec(output).warnings as unknown[] | undefined)?.length === 0
        ? 'a fájl nem tartalmazott kinyerhető szöveget'
        : null,
    partial: (output) => (bool(output, 'truncated') === true ? 'a fájltartalom csonkolva lett' : null),
  },
  google_drive_list_drives: {
    outputSchema: listResult('drives'),
    emptiness: emptyList('drives', 'nincs elérhető megosztott meghajtó'),
  },
  google_drive_create_folder: {
    outputSchema: z.looseObject({ file: z.record(z.string(), z.unknown()), created: z.boolean() }),
    effect: identifiedEffect('file.id', 'létrehozott mappa'),
  },
  google_drive_upload_file: {
    outputSchema: z.looseObject({ file: z.record(z.string(), z.unknown()), created: z.boolean() }),
    effect: identifiedEffect('file.id', 'feltöltött fájl'),
  },
  google_drive_update_file: {
    outputSchema: z.looseObject({
      file: z.record(z.string(), z.unknown()),
      conflict: z.boolean().optional(),
    }),
    effect: identifiedEffect('file.id', 'frissített fájl'),
  },
  google_drive_rename_file: {
    outputSchema: z.record(z.string(), z.unknown()),
    effect: identifiedEffect('id', 'átnevezett fájl'),
  },
  google_drive_move_file: {
    outputSchema: z.record(z.string(), z.unknown()),
    effect: identifiedEffect('id', 'áthelyezett fájl'),
  },
  google_drive_copy_file: {
    outputSchema: z.looseObject({ file: z.record(z.string(), z.unknown()), created: z.boolean() }),
    effect: identifiedEffect('file.id', 'másolat'),
  },
  google_drive_trash_file: {
    outputSchema: z.record(z.string(), z.unknown()),
    effect: identifiedEffect('id', 'kukába helyezett fájl'),
  },
  google_drive_restore_file: {
    outputSchema: z.record(z.string(), z.unknown()),
    effect: identifiedEffect('id', 'visszaállított fájl'),
  },
  google_drive_share_file: {
    outputSchema: z.looseObject({ permissionId: z.string() }),
    effect: identifiedEffect('permissionId', 'megosztási jog'),
  },
  google_docs_apply_edits: {
    outputSchema: z.record(z.string(), z.unknown()),
    effect: identifiedEffect('fileId', 'Docs módosítás'),
  },
  google_sheets_write_range: {
    outputSchema: z.record(z.string(), z.unknown()),
    effect: identifiedEffect('fileId', 'Sheets írás'),
  },
  google_slides_apply_edits: {
    outputSchema: z.record(z.string(), z.unknown()),
    effect: identifiedEffect('fileId', 'Slides módosítás'),
  },

  // ── HTTP API connector ────────────────────────────────────────────────────
  http_api_get: {
    outputSchema: z.looseObject({ ok: z.boolean(), status: z.number() }),
    emptiness: (output) => {
      if (bool(output, 'ok') === false) {
        return `a hívás nem járt eredménnyel (HTTP ${num(output, 'status') ?? '?'})${
          str(output, 'hint') ? ` — ${str(output, 'hint')}` : ''
        }`
      }
      const body = rec(output).body
      if (body === null || body === undefined) return 'a válasz törzse üres volt'
      if (Array.isArray(body) && body.length === 0) return 'a válasz üres listát tartalmazott'
      return null
    },
    // A `truncated` két esetet fed: (a) a törzs tényleg csonkult (ilyenkor a body
    // maga is `truncated: true` + `preview`), (b) a válasz nagy volt, de HIÁNYTALAN.
    // A kettőt külön kell közölni: ha a modellnek azt mondjuk, hogy csonkolt adatot
    // kapott, akkor egy hiánytalanul átadott fájlt/listát is újra és újra visszaolvas
    // — vagy nem mer válaszolni belőle.
    partial: (output) => {
      if (bool(output, 'truncated') !== true) return null
      const body = rec(output).body
      const bodyCut = bool(body, 'truncated') === true
      return bodyCut
        ? 'a válasz nem fért be egészben, ezért csonkolva jött vissza'
        : 'a válasz nagy volt (a törzs hiánytalan) — a lényeget szűrve emeld ki, ne dumpold a kontextusba'
    },
  },
  http_api_get_all: {
    outputSchema: z.looseObject({
      ok: z.boolean(),
      path: z.string(),
      pageCount: z.number(),
      itemCount: z.number(),
      items: z.array(z.unknown()),
    }),
    // ok:false (auth/HTTP/arrayPath hiba) SOHA nem „üres nyilvántartás":
    // a validateToolOutput az emptiness-t a partial ELŐTT értékeli, ezért ha
    // itt itemCount===0-ra empty-t adnánk, a partial „ne egyeztess" üzenete
    // soha nem futna — a modell/gépi fogyasztó pedig törlésnek nézné a hibát.
    emptiness: (output) => {
      if (bool(output, 'ok') === false) return null
      return (num(output, 'itemCount') ?? 0) === 0
        ? `a végiglapozás egyetlen sort sem hozott (${str(output, 'path') ?? 'ismeretlen útvonal'})`
        : null
    },
    // A csonka lapozás a legveszélyesebb csendes hiba: ebből lesz a hamis
    // „182 új rekord" egyeztetés. Kötelezően látszania kell.
    partial: (output) => {
      if (bool(output, 'ok') === false) {
        return `a lapozás megszakadt (${str(output, 'error') ?? 'ismeretlen hiba'}), így csak ${
          num(output, 'itemCount') ?? 0
        } sor jött be — a lista NEM teljes, ne egyeztess vele`
      }
      const provenance = rec(rec(output).provenance)
      if (provenance.paginationComplete === false) {
        return 'a lapozás elérte a maximális oldalszámot, a lista NEM teljes — ne egyeztess vele'
      }
      return null
    },
  },
  http_api_request: {
    outputSchema: z.looseObject({ ok: z.boolean(), status: z.number() }),
    // Írás jellegű API-hívás: a mért hatás a sikeres válasz maga (státuszkóddal).
    effect: (output) => {
      const ok = bool(output, 'ok')
      const status = num(output, 'status')
      return effect(ok === true ? 1 : 0, 'sikeres API-hívás', status === null ? null : `HTTP ${status}`)
    },
    maxInputSize: (args) => {
      const body = args.body
      if (body === undefined || body === null) return null
      const bytes = Buffer.byteLength(
        typeof body === 'string' ? body : JSON.stringify(body) ?? '',
        'utf8',
      )
      return bytes > MAX_WRITE_CONTENT_BYTES
        ? `a kérés törzse ${bytes} bájt, a felső határ ${MAX_WRITE_CONTENT_BYTES} bájt.`
        : null
    },
  },

  // ── Web ───────────────────────────────────────────────────────────────────
  web_search: {
    outputSchema: z.looseObject({
      results: z.array(z.unknown()),
      warnings: z.array(z.unknown()),
    }),
    emptiness: emptyList('results', 'a webes keresés egyetlen találatot sem adott'),
    partial: (output) => {
      const warnings = arr(output, 'warnings') ?? []
      if (warnings.length === 0) return null
      const first = str(warnings[0], 'message') ?? str(warnings[0], 'code') ?? 'ismeretlen ok'
      return `a keresés figyelmeztetéssel zárult (${first}) — előfordulhat, hogy nem minden forrás került bele`
    },
  },
  web_research_request: {
    outputSchema: z.looseObject({ ok: z.boolean() }),
    emptiness: (output) => {
      if (bool(output, 'ok') !== false) return null
      const error = str(output, 'error')
      if (error === 'domain_not_allowed' || error === 'NO_TRUSTED_SOURCE') {
        return 'a webes kutatás nem talált letölthető, engedélyezett forrást — a bank domainjét a tenant-admin veheti fel a web-kereső allowlistre (a lista a letöltést is kapuzza)'
      }
      if (error === 'domain_denied') {
        return 'a kért domain a tiltólistán van, ezért a kutatás nem futott le'
      }
      return `a webes kutatás nem futott le (${error ?? 'ismeretlen ok'})`
    },
  },

  // ── Dokumentum-olvasás ────────────────────────────────────────────────────
  document_read: {
    outputSchema: z.looseObject({
      documentId: z.string(),
      filename: z.string(),
      pages: z.array(z.unknown()),
    }),
    emptiness: (output) =>
      (arr(output, 'pages') ?? []).length === 0
        ? `a(z) "${str(output, 'filename') ?? 'dokumentum'}" fájlból egyetlen olvasható oldal sem jött ki`
        : null,
    partial: (output) =>
      bool(output, 'truncated') === true
        ? 'a dokumentum nem fért be egészben, csak egy része olvasható a válaszban'
        : null,
  },
  tulajdoni_lap_parse: {
    outputSchema: z.looseObject({ nezet: z.string(), filename: z.string() }),
    effect: (output) => {
      const summary = rec(rec(output).osszesites)
      const owners = num(summary, 'egyediTulajdonos') ?? arr(output, 'tulajdonosok')?.length ?? 0
      const parsed = Object.keys(summary).length > 0 ? Math.max(owners, 1) : owners
      return effect(parsed, 'feldolgozott tulajdonosi rekord', str(output, 'kimenet'))
    },
    emptiness: (output) => {
      const owners = arr(output, 'tulajdonosok')
      const entries = arr(output, 'bejegyzesek')
      const szeljegyek = arr(output, 'szeljegyek')
      const anyRows =
        (owners?.length ?? 0) + (entries?.length ?? 0) + (szeljegyek?.length ?? 0)
      // Az összefoglaló nézet nem ad sorlistát — ott az összesítés léte a jel.
      if (anyRows > 0) return null
      if (Object.keys(rec(rec(output).osszesites)).length > 0) return null
      return `a(z) "${str(output, 'filename') ?? 'tulajdoni lap'}" fájlból egyetlen tulajdonost, bejegyzést vagy széljegyet sem sikerült kinyerni`
    },
    partial: (output) => {
      const warning = str(output, 'figyelmeztetes')
      return warning ? `a lap ellenőrzése figyelmeztetést adott: ${warning}` : null
    },
  },
  /**
   * Egyeztetett sorok száma a mért hatás (Excel opcionális — `path` lehet null).
   * Coverage-only ágon a `coverage` mező a jel — ne essen a heurisztikus `empty`-re.
   * 0 egyeztetett sor → `empty` (klasszikus incidens).
   */
  tulajdoni_lap_egyeztetes: {
    outputSchema: z.looseObject({ ok: z.boolean() }),
    effect: (output) => {
      const coverage = rec(rec(output).coverage)
      const rows = num(rec(output).egyeztetes, 'osszesSor')
      // Coverage-only: nincs egyeztetes blokk — a lefedett id-k a mért hatás.
      if (typeof coverage.ok === 'boolean' && rows == null) {
        const n = Math.max(num(coverage, 'expected') ?? 0, num(coverage, 'applied') ?? 0, 1)
        return effect(n, 'ellenőrzött ownership-id', str(output, 'muveletekPath'))
      }
      return effect(rows ?? 0, 'egyeztetett sor', str(output, 'path'))
    },
    emptiness: (output) => {
      const coverage = rec(rec(output).coverage)
      if (typeof coverage.ok === 'boolean') return null
      const rows = num(rec(output).egyeztetes, 'osszesSor')
      if (rows === 0) {
        return 'az eszköz lefutott, de 0 egyeztetett sor lett az eredménye — a művelet nem járt tényleges hatással'
      }
      return null
    },
    partial: (output) => {
      const coverage = rec(rec(output).coverage)
      if (typeof coverage.ok === 'boolean' && coverage.ok === false) {
        const msg = str(coverage, 'message')
        return msg
          ? `a proposal lefedettség bukott: ${msg}`
          : 'a proposal lefedettség bukott — missing/extra ownership id'
      }
      const warning = str(output, 'figyelmeztetes')
      if (warning && !warning.startsWith('Lefedettség:')) {
        return `a lap ellenőrzése bukott: ${warning} — az egyeztetés nem teljes`
      }
      const needsAttention = arr(rec(output).egyeztetes, 'figyelmet_igenyel') ?? []
      return needsAttention.length > 0
        ? `${needsAttention.length} tétel emberi ellenőrzést igényel, ezek nincsenek lezárva`
        : null
    },
    maxInputSize: (args) => {
      const rows = args.nyilvantartas
      return Array.isArray(rows) && rows.length > MAX_INLINE_NYILVANTARTAS_ROWS
        ? `${rows.length} nyilvántartási sort adtál át közvetlenül, a felső határ ${MAX_INLINE_NYILVANTARTAS_ROWS}. Írd ki a listát a munkaterületre és add át a nyilvantartasPath-ot.`
        : null
    },
  },
  get_debug_trace: {
    outputSchema: z.looseObject({
      traceId: z.string(),
      agentTurnId: z.string(),
      conversationId: z.string(),
      projection: z.record(z.string(), z.unknown()),
    }),
    /**
     * D3 — a projekció lehet üres (nincs mit megmutatni a debug AI-nak); ezt a
     * tool mondja meg, nem a heurisztika. Enélkül a debugoló azt hinné, hogy a
     * trace lekérése sikerült, csak épp semmit nem tartalmaz.
     */
    emptiness: (output) => {
      const projection = (output as { projection?: Record<string, unknown> } | null)?.projection
      if (!projection || Object.keys(projection).length === 0) {
        return 'ehhez a fordulóhoz nincs megjeleníthető debug-trace'
      }
      return null
    },
  },

  run_index: {
    outputSchema: z.looseObject({
      runs: z.array(z.looseObject({ runId: z.string(), grain: z.string() })),
      returnedCount: z.number(),
      limit: z.number(),
      truncated: z.boolean(),
      scope: z.record(z.string(), z.unknown()),
    }),
    emptiness: (output) => {
      const count = (output as { returnedCount?: number } | null)?.returnedCount ?? 0
      return count === 0 ? 'a megadott szkópban nem található futás' : null
    },
    partial: (output) => {
      const truncated = (output as { truncated?: boolean } | null)?.truncated === true
      return truncated
        ? 'több futás illeszkedik a szkópra, mint amennyit visszaadtunk — szűkítsd a szkópot vagy kérj kisebb limitet'
        : null
    },
  },

  run_trace: {
    outputSchema: z.looseObject({
      view: z.enum(['summary', 'detail', 'process']),
      runId: z.string(),
      grain: z.enum(['turn', 'ticket', 'process']),
    }),
    // Megtalált futás érvényes válasz, akkor is ha csendes — a hiány `run_not_found`.
    emptiness: () => null,
    partial: (output) => {
      const view = (output as { view?: string } | null)?.view
      if (view === 'process') return null
      if (view === 'detail') {
        const truncated = (output as { truncated?: boolean } | null)?.truncated === true
        return truncated
          ? 'több idővonal-sor illeszkedik a szűrőre, mint amennyit visszaadtunk — lapozz offset-tel vagy szűkítsd a tartományt'
          : null
      }
      const summary = (output as { summary?: { nonOkToolCallsTruncated?: boolean } } | null)?.summary
      return summary?.nonOkToolCallsTruncated === true
        ? 'több nem-ok eszközhívás van, mint amennyit az összefoglaló felsorol — kérj detail nézetet szűréssel'
        : null
    },
  },

  run_stats: {
    outputSchema: z.looseObject({
      runCount: z.number(),
      toolOutcomeMatrix: z.array(z.looseObject({ toolName: z.string(), totalCalls: z.number() })),
      latencyByTool: z.array(z.looseObject({ toolName: z.string(), count: z.number() })),
      promptCache: z.looseObject({
        measuredCalls: z.number(),
        unmeasuredCalls: z.number(),
        hitRatio: z.number().nullable(),
      }),
      repeatedSourceKeys: z.array(
        z.looseObject({ sourceKey: z.string(), rereadCount: z.number(), readCount: z.number() }),
      ),
      denialReasons: z.array(z.looseObject({ policyDecision: z.string(), count: z.number() })),
      skillLoads: z.array(z.looseObject({ action: z.string(), count: z.number() })),
      totals: z.looseObject({ toolCallCount: z.number(), modelCallCount: z.number() }),
    }),
    emptiness: (output) => {
      const toolCalls = (output as { totals?: { toolCallCount?: number } } | null)?.totals
        ?.toolCallCount
      return toolCalls === 0 ? 'a megadott szkópban nincs eszközhívás az aggregáláshoz' : null
    },
    partial: (output) => {
      const truncated = (output as { truncated?: boolean } | null)?.truncated === true
      const sourceTruncated =
        (output as { repeatedSourceKeysTruncated?: boolean } | null)?.repeatedSourceKeysTruncated ===
        true
      if (truncated) {
        return 'több futás illeszkedik a szkópra, mint amennyit az aggregátum figyelembe vett — szűkítsd a szkópot'
      }
      if (sourceTruncated) {
        return 'több eszközhívás van a szkópban, mint amennyit a forrás-kulcs mintavétel feldolgozott — szűkítsd a szkópot'
      }
      return null
    },
  },

  /**
   * `reconcile_records` — 2. INCIDENS. A párosítás sorrend-függése (a teljes
   * egyezés globális elsőbbsége) a `lib/reconcile-records.ts`-ben megoldott; itt
   * a MÉRT hatás és a részlegesség kikényszerítése a feladat. A kombinatorikus
   * bemeneti kapu a handlerben fut (a sorszám csak a fájlok beolvasása után ismert).
   */
  reconcile_records: {
    outputSchema: z.looseObject({
      ok: z.boolean(),
      outputPath: z.string(),
      summary: z.looseObject({ total: z.number() }),
    }),
    effect: (output) =>
      effect(num(rec(output).summary, 'total') ?? 0, 'egyeztetett sor', str(output, 'outputPath')),
    partial: (output) => {
      const uncertain = num(output, 'uncertainCount') ?? 0
      return uncertain > 0
        ? `${uncertain} pár bizonytalan (nem teljes kulcson egyezett), ezeket emberi ellenőrzés nélkül nem szabad késznek tekinteni`
        : null
    },
  },

  // ── Tudásbázis / katalógus ────────────────────────────────────────────────
  kb_search: {
    outputSchema: listResult('hits'),
    emptiness: emptyList('hits', 'a tudásbázis-keresés egyetlen találatot sem adott'),
  },
  kb_list_index: {
    outputSchema: listResult('pages'),
    emptiness: emptyList('pages', 'a tudásbázis-index üres a megadott útvonalra'),
  },
  kb_get_page: {
    outputSchema: z.looseObject({ found: z.boolean(), path: z.string() }),
    emptiness: (output) =>
      bool(output, 'found') === false
        ? `a tudásbázisban nincs ilyen oldal: ${str(output, 'path') ?? '(ismeretlen)'}`
        : null,
  },
  user_directory: {
    outputSchema: listResult('users'),
    emptiness: emptyList('users', 'a keresésre egyetlen felhasználó sem illeszkedik'),
  },
  agent_catalog: {
    outputSchema: listResult('agents'),
    emptiness: emptyList('agents', 'a katalógus egyetlen agentet sem adott vissza'),
  },
  agent_resolve: {
    outputSchema: listResult('agents'),
    emptiness: emptyList('agents', 'a névre egyetlen elérhető agent sem illeszkedik'),
  },
  agent_ask: {
    outputSchema: z.looseObject({ ok: z.boolean(), ticketId: z.string() }),
    emptiness: (output) => {
      const error = str(output, 'error')
      if (error) return `a megkérdezett agent nem tudott válaszolni (${error})`
      // Szinkron (chat) delegálásnál a `completed` jelzi, hogy megjött a válasz.
      if (bool(output, 'completed') === true && !str(output, 'answer')) {
        return 'a megkérdezett agent lefutott, de üres választ adott'
      }
      return null
    },
  },

  // ── Board / ticket ────────────────────────────────────────────────────────
  board_write: {
    outputSchema: z.looseObject({ ok: z.boolean(), ticketId: z.string(), state: z.string() }),
    effect: (output) =>
      effect(bool(output, 'ok') === true ? 1 : 0, 'állapotváltás', str(output, 'ticketId')),
  },
  ticket_create: {
    outputSchema: z.looseObject({ ok: z.boolean(), ticketId: z.string() }),
    effect: identifiedEffect('ticketId', 'létrehozott ticket'),
  },

  // ── Repó ──────────────────────────────────────────────────────────────────
  repo_prepare: {
    outputSchema: z.looseObject({ ok: z.boolean(), repoPath: z.string() }),
    emptiness: (output) =>
      (num(output, 'filesIndexed') ?? 0) === 0
        ? 'a repó előkészítése egyetlen fájlt sem indexelt'
        : null,
  },
  repo_open_pull_request: {
    outputSchema: z.looseObject({ ok: z.boolean(), changed: z.boolean() }),
    // `changed:false` → nem volt mit PR-be tenni. Eddig „sikeres" hívás volt.
    effect: (output) => {
      if (bool(output, 'changed') !== true) return effect(0, 'módosított fájl', null)
      return effect(
        num(output, 'filesChanged') ?? 0,
        'módosított fájl',
        str(output, 'pullRequestUrl'),
      )
    },
  },

  sandbox_exec: {
    outputSchema: z.looseObject({
      exitCode: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
      outputs: z.array(z.string()),
    }),
    effect: (output) => effect(1, 'sandbox-futtatás', (arr(output, 'outputs') ?? []).join(', ') || null),
    partial: (output) => {
      const reasons = [
        bool(output, 'stdoutTruncated') ? 'stdout csonkolva' : null,
        bool(output, 'stderrTruncated') ? 'stderr csonkolva' : null,
      ].filter(Boolean)
      return reasons.length ? reasons.join(', ') : null
    },
  },

  // ── Munkaterületi fájlok — olvasás ────────────────────────────────────────
  file_read: {
    outputSchema: z.looseObject({ path: z.string(), totalLines: z.number(), content: z.string() }),
    emptiness: (output) =>
      (str(output, 'content') ?? '').length === 0
        ? `a(z) "${str(output, 'path') ?? 'fájl'}" ezen a szakaszon üres`
        : null,
  },
  file_list: {
    outputSchema: z.looseObject({ path: z.string(), entries: z.array(z.unknown()) }),
    emptiness: (output) =>
      (arr(output, 'entries') ?? []).length === 0
        ? `a(z) "${str(output, 'path') ?? '.'}" könyvtár üres`
        : null,
  },
  file_glob: {
    outputSchema: listResult('paths'),
    emptiness: emptyList('paths', 'a mintára egyetlen fájl sem illeszkedik a munkaterületen'),
  },
  file_search: {
    outputSchema: z.looseObject({ matches: z.array(z.unknown()), truncated: z.boolean() }),
    emptiness: emptyList('matches', 'a keresés egyetlen találatot sem adott a munkaterületen'),
    partial: (output) =>
      bool(output, 'truncated') === true
        ? 'a találatlista elérte a felső határt, ezért nem teljes'
        : null,
  },
  xlsx_read_sheet: {
    outputSchema: z.looseObject({ sheet: z.string(), rows: z.array(z.unknown()) }),
    emptiness: (output) =>
      (num(output, 'rowCount') ?? (arr(output, 'rows') ?? []).length) === 0
        ? `a(z) "${str(output, 'sheet') ?? 'munkalap'}" munkalap egyetlen adatsort sem tartalmaz`
        : null,
  },
  docx_read: {
    outputSchema: z.looseObject({ text: z.string() }),
    emptiness: (output) =>
      (str(output, 'text') ?? '').trim().length === 0
        ? 'a Word-dokumentumból nem jött ki olvasható szöveg'
        : null,
  },
  pdf_read: {
    outputSchema: z.looseObject({ text: z.string(), numPages: z.number() }),
    emptiness: (output) =>
      (str(output, 'text') ?? '').trim().length === 0
        ? 'a PDF-ből nem jött ki olvasható szöveg (lehet, hogy szkennelt kép)'
        : null,
    partial: (output) =>
      bool(output, 'truncated') === true
        ? `a PDF nem fért be egészben, csak a ${str(output, 'pagesRead') ?? 'megadott'} oldalak olvashatók`
        : null,
  },

  // ── Munkaterületi fájlok — írás (D4: MÉRT hatás) ──────────────────────────
  file_write: {
    outputSchema: pathAndCount('bytesWritten'),
    effect: countedEffect('bytesWritten', 'bájt'),
    maxInputSize: contentSizeLimit('content'),
  },
  create_html: {
    outputSchema: pathAndCount('bytesWritten'),
    effect: countedEffect('bytesWritten', 'bájt'),
    maxInputSize: contentSizeLimit('html'),
  },
  file_edit: {
    // 0 csere = a fájl NEM változott. Eddig „sikeres szerkesztés" volt.
    outputSchema: pathAndCount('replacements'),
    effect: countedEffect('replacements', 'csere'),
  },
  file_delete: {
    outputSchema: z.looseObject({ deleted: z.boolean(), path: z.string() }),
    effect: (output) =>
      effect(bool(output, 'deleted') === true ? 1 : 0, 'törölt fájl', str(output, 'path')),
  },
  xlsx_write_cells: {
    outputSchema: pathAndCount('cellsUpdated'),
    effect: countedEffect('cellsUpdated', 'írt cella'),
  },
  xlsx_append_rows: {
    outputSchema: pathAndCount('rowsAppended'),
    effect: countedEffect('rowsAppended', 'hozzáfűzött sor'),
    maxInputSize: (args) => {
      const rows = args.rows
      return Array.isArray(rows) && rows.length > MAX_APPEND_ROWS
        ? `${rows.length} sort adtál át egy hívásban, a felső határ ${MAX_APPEND_ROWS}. Darabold több hívásra.`
        : null
    },
  },
  xlsx_format_range: {
    outputSchema: z.looseObject({ path: z.string(), range: z.string() }),
    effect: (output) => {
      const range = str(output, 'range')
      return effect(range ? 1 : 0, 'formázott tartomány', str(output, 'path'))
    },
  },
  xlsx_layout: {
    outputSchema: pathAndCount('operations'),
    effect: countedEffect('operations', 'elrendezési művelet'),
  },
  xlsx_create: {
    outputSchema: pathAndCount('sheets'),
    effect: countedEffect('sheets', 'létrehozott munkalap'),
  },
  docx_create: {
    outputSchema: pathAndCount('bytesWritten'),
    effect: countedEffect('bytesWritten', 'bájt'),
  },
  pdf_create: {
    outputSchema: pathAndCount('bytesWritten'),
    effect: countedEffect('bytesWritten', 'bájt'),
  },
  pptx_create: {
    outputSchema: pathAndCount('bytesWritten'),
    effect: countedEffect('bytesWritten', 'bájt'),
  },

  // ── Memória ───────────────────────────────────────────────────────────────
  memory_propose: {
    outputSchema: z.looseObject({ ok: z.boolean() }),
    effect: (output) => {
      if (bool(output, 'ok') !== true) return effect(0, 'memória-javaslat', null)
      return effect(1, 'memória-javaslat', str(output, 'candidateId'))
    },
  },

  // ── Sandbox alkalmazások ──────────────────────────────────────────────────
  'sandbox_app.create': {
    outputSchema: z.looseObject({ appId: z.string() }),
    effect: identifiedEffect('appId', 'létrehozott alkalmazás'),
  },
  'sandbox_app.update_artifact': {
    outputSchema: z.looseObject({ versionId: z.string(), version: z.number() }),
    effect: identifiedEffect('versionId', 'új verzió'),
    partial: (output) => {
      const warnings = arr(rec(output).validationResult, 'warnings') ?? []
      return warnings.length > 0
        ? `a verzió elkészült, de ${warnings.length} ellenőrzési figyelmeztetéssel`
        : null
    },
  },
  'sandbox_app.preview': {
    outputSchema: z.looseObject({ previewUrl: z.string() }),
    emptiness: (output) =>
      (str(output, 'previewUrl') ?? '').length === 0 ? 'nem készült előnézeti hivatkozás' : null,
  },
  'sandbox_app.export': {
    outputSchema: z.looseObject({ filename: z.string(), sizeBytes: z.number() }),
    effect: countedEffect('sizeBytes', 'exportált bájt', 'filename'),
  },
  'sandbox_app.list': {
    outputSchema: listResult('apps'),
    emptiness: emptyList('apps', 'egyetlen sandbox alkalmazás sem érhető el'),
  },
  'sandbox_app.get': {
    outputSchema: z.looseObject({ appId: z.string(), html: z.string() }),
    emptiness: (output) =>
      (str(output, 'html') ?? '').length === 0
        ? 'az alkalmazás verziója üres tartalmat adott vissza'
        : null,
  },
  'sandbox.commit': {
    outputSchema: z.looseObject({ commitId: z.string() }),
    effect: identifiedEffect('commitId', 'commit'),
  },
  'sandbox.request_promotion': {
    outputSchema: z.looseObject({ promotionId: z.string() }),
    effect: identifiedEffect('promotionId', 'promóció-kérés'),
  },
  'sandbox.snapshot': {
    outputSchema: z.looseObject({ snapshotId: z.string() }),
    effect: identifiedEffect('snapshotId', 'pillanatkép'),
  },
}

/**
 * Egy tool kimeneti szerződése. FAIL-SAFE: a nem leképezett (ismeretlen /
 * jövőbeli) tool `undefined`-et kap — ilyenkor a kapu a heurisztikus üresség-
 * vizsgálatra és a „mellékhatásos tool mért hatás nélkül → `empty`" szabályra
 * esik vissza. Inkább egy fölösleges „nem találtam semmit", mint egy néma
 * üres Excel.
 */
export function resolveToolOutputContract(tool: string): ToolOutputContract | undefined {
  return TOOL_OUTPUT_CONTRACTS[tool as ToolName]
}

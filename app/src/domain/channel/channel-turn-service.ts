/**
 * 1:1 agent-chat a csatornán — a csatorna-forduló feldolgozója (Telegram feature-spec
 * #70/#73/#74, D5/D8/D9/D10/D11/D13).
 *
 * Ez a modul a #73 megbízható bejövő-sor szeletét (fail-closed identitás-ellenőrzés,
 * agent-engedély kapu) építi tovább a #74 szeletre: az összekötött felhasználó privát
 * üzenete a MEGLÉVŐ agent-futásidőt hívja, és a válasz — CÍMKÉZVE (agent + projekt),
 * DARABOLVA, az érzékenységi kapun átvezetve — a csatornára megy ki. Két bejárata van,
 * egyetlen varraton keresztül:
 *
 *  1. `enqueueInbound` — a bejövő webhook (a linking-szolgáltatáson át) egy TARTÓS forduló-sort
 *     ír; a webhook azonnal nyugtáz, a forduló túléli a kérést (D8).
 *  2. `processQueued` — a meglévő worker MÁSODIK munkatípusa (D8): felveszi a sort, lefuttatja
 *     a fordulót, és a KIMENŐ hívásokat a befecskendezett `ChannelOutboundTransport`-on küldi
 *     (D11 — a varrat egyetlen helyen dublőrizhető).
 *
 * A tesztek CSAK külső viselkedést figyelnek: hatás éri a szolgáltatást (sor-írás vagy
 * feldolgozás), és megnézzük, milyen kimenő hívások keletkeztek — vagy nem — és milyen
 * audit-/perzisztencia-hatás született (#70 Testing Decisions). Az agent-futásidő
 * BEFECSKENDEZETT (`ChannelAgentRuntime`), így a teszt a CSATORNÁT méri, nem a modellt.
 *
 * Szerkezeti garanciák, amiket a kód kikényszerít:
 *  - A futásidő CSAK a VÉGSŐ választ adja vissza (nincs gondolkodási nyom) — a belső
 *    gondolkodási nyom szerkezetileg nem kerülhet ki Telegramra (spec §26 / Out of Scope).
 *  - Az érzékenységi kapu a KIMENŐ szövegre fut (D10): `clean` → mehet; `sensitive`/`forbidden`
 *    → BLOKK (nem terelés) — a nyers szöveg egyetlen kimenő hívásban sem szerepel.
 *  - Az identitás és a szerepkör-határ MINDEN fordulónál ÉLŐBEN dől el (D2): visszavont kötés →
 *    a futásidő NEM hívódik (fail-closed).
 */
import type {
  Agent,
  ChannelIdentity,
  ChannelSession,
  ChannelTurn,
  ChannelType,
} from '@prisma/client'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import { evaluateTenantOperationGate } from '@/lib/tenant-operation-gate'
import { classifyPrompt } from '@/domain/gateway/sensitivity-router'
import type {
  AuditRepository,
  ChannelAgentGrantRepository,
  ChannelIdentityRepository,
  ChannelSessionRepository,
  ChannelTurnRepository,
  TenantMembershipRepository,
  TenantRepository,
} from '@/repositories/interfaces'
import type { ChannelOutboundTransport } from './channel-outbound-transport'
import { CHANNEL_AUDIT_ACTIONS } from './channel-types'
import {
  chunkCounterLabel,
  chunkOutboundText,
  TELEGRAM_MAX_MESSAGE_CHARS,
} from './channel-message-chunker'
import { pseudonymFromLookupHash } from './channel-identity-crypto'

// ── Felhasználó felé látszó, keret-/hibaüzenetek (D16 / NFR-1: hétköznapi magyar) ──

/** Összekötött, de agent nélküli felhasználó — érthető útmutatás, nem néma, nem rejtélyes (§10). */
export const NO_AGENT_TEXT =
  'Össze vagy kötve, de a szervezeted rendszergazdája még egyetlen agentet sem engedélyezett neked ' +
  'Telegramon. Szólj neki, hogy adjon hozzáférést — utána már tudsz itt kérdezni.'

/** Az alapértelmezett agenttől időközben elvették a jogot (story 35) — nem hibaüzenet. */
export const AGENT_UNAVAILABLE_TEXT =
  'Az agenthez, amivel itt beszélgettél, épp nincs jogosultságod. Ha ez tévedés, szólj a ' +
  'rendszergazdádnak. Amint visszakapod a hozzáférést, folytathatjuk.'

/** Fájl / kép / hangüzenet — a bot érthetően megmondja, hogy ezt még nem tudja kezelni (§27). */
export const UNSUPPORTED_CONTENT_TEXT =
  'Ezt még nem tudom kezelni — egyelőre csak szöveges üzenetre tudok válaszolni. ' +
  'Írd le szöveggel, amiben segíthetek.'

/** Érzékeny / tiltott kimenet blokkolása Telegramon (D10) — a nyers szöveg nem megy ki. */
export const SENSITIVITY_BLOCK_TEXT =
  'A válasz olyan érzékeny adatot tartalmazna (pl. bankkártyaszám, számlaszám vagy kulcs), ' +
  'amit Telegramra nem küldök ki. Nézd meg a választ a webes felületen, ott biztonságosan látod.'

/** Időtúllépés — hétköznapi magyar (§23). */
export const TIMEOUT_TEXT =
  'Elnézést, ez most tovább tartott a megengedettnél, és megszakadt. Kérlek, próbáld újra kicsit később.'

/** Modellhiba — hétköznapi magyar (§23). */
export const MODEL_ERROR_TEXT =
  'Elnézést, most nem sikerült választ adnom egy belső hiba miatt. Kérlek, próbáld újra kicsit később.'

/** Napi model-keret elfogyott — érthető magyar (§24). */
export const BUDGET_EXHAUSTED_TEXT =
  'Mára elfogyott a szervezeted napi kerete a válaszokra. Holnap újra tudok segíteni, ' +
  'vagy szólj a rendszergazdádnak, ha sürgős.'

/** Váratlan hiba, ami után nem próbálkozunk tovább — a felhasználó ne maradjon némán. */
export const UNKNOWN_ERROR_TEXT =
  'Elnézést, valami félrement a válasz elkészítésekor. Kérlek, próbáld újra kicsit később.'

/** A gyűjtő projekt (D9) felhasználó felé látszó, hétköznapi neve. */
const GENERAL_PROJECT_LABEL = 'Általános'
const GENERAL_PROJECT_KEY = '__general__'

/** 24 óra tétlenség után új beszélgetés (D9) — a megőrzési határidő így ténylegesen érvényesül. */
export const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000

const TELEGRAM: ChannelType = 'telegram'

// ── Ports ────────────────────────────────────────────────────────────────────

/** A bejövő üzenet minimál alakja (a webhookból kivonva). A `kind` a fájl/hang detektálás. */
export type ChannelInboundTurnMessage = {
  updateId: number
  externalThreadId: string
  externalUserId: string
  text: string | null
  /** `text` = feldolgozható; `unsupported` = fájl/kép/hang (a bot érthetően elutasítja). */
  kind: 'text' | 'unsupported'
}

/**
 * A MEGLÉVŐ agent-futásidő befecskendezett portja. Csak a VÉGSŐ választ adja vissza — a belső
 * gondolkodási nyom itt nem jelenhet meg (szerkezeti garancia a §26 ellen). A valós adapter a
 * webes chat-futásidőt hívja ugyanarra a beszélgetésre (így a Telegram-beszélgetés a weben is
 * látszik), a teszt-dublőr előre megadott választ ad.
 */
export interface ChannelAgentRuntime {
  runTurn(input: {
    agentId: string
    tenantId: string | null
    userId: string
    conversationId: string
    projectKey: string
    text: string
  }): Promise<ChannelAgentRuntimeResult>
}

export type ChannelAgentRuntimeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'timeout' | 'model_error' | 'budget_exhausted' | 'unknown' }

/**
 * A beszélgetés életciklus-portja (web-láthatóság + 24 órás gördülés, D9). A csatorna a MEGLÉVŐ
 * beszélgetés-modellt használja, ezért a Telegram-forgalom a webes felületen is megjelenik
 * (AC „a Telegram-beszélgetés a weben is látszik"), és a megőrzési határidő a beszélgetés
 * létrehozásakor beáll. A tényleges üzenet-perzisztálást (user + agent) a futásidő végzi a
 * kapott `conversationId`-ba — így a csatorna nem duplázza a webes írásokat.
 */
export interface ChannelConversationPort {
  findById(id: string): Promise<{
    id: string
    agentId: string
    tenantId: string | null
    lastMessageAt: Date
    retainUntil: Date | null
  } | null>
  create(input: {
    tenantId: string | null
    agentId: string
    createdById: string
    projectKey: string
    channel: ChannelType
    channelExternalId: string
    title: string | null
  }): Promise<{ id: string; retainUntil: Date | null }>
}

/** Agent-olvasó port — a válasz-címkéhez (név) és a tenant-határhoz (D2). */
export interface ChannelAgentReader {
  findById(id: string): Promise<Pick<Agent, 'id' | 'name' | 'tenantId' | 'personaNickname'> | null>
}

export type ChannelTurnServiceDeps = {
  sessions: ChannelSessionRepository
  identities: ChannelIdentityRepository
  grants: ChannelAgentGrantRepository
  turns: ChannelTurnRepository
  agents: ChannelAgentReader
  conversations: ChannelConversationPort
  runtime: ChannelAgentRuntime
  transport: ChannelOutboundTransport
  audit: Pick<AuditRepository, 'append'>
  /**
   * A kötéskor rögzített szervezet megnevezése a `/szervezet` parancshoz (story 14). Több
   * szervezetben is tag felhasználónak Telegramon nincs szervezet-váltó, ezért meg kell tudnia
   * kérdezni, kinek a nevében beszél. Opcionális: hiányában a parancs a nevet nem tudja kiírni.
   */
  resolveOrgName?: (tenantId: string | null) => Promise<string | null>
  /**
   * Élő hozzáférési kapuk minden feldolgozott üzenet előtt. Ezek szándékosan a workerben
   * vannak: a már sorba állított Telegram-üzenet sem futhat le egy azóta visszavont tagság,
   * tenant-felfüggesztés vagy csatorna-kill-switch után.
   */
  memberships: Pick<TenantMembershipRepository, 'findByTenantAndUser'>
  tenants: Pick<TenantRepository, 'findById'>
  isChannelEnabled: (tenantId: string | null) => Promise<boolean>
  now?: () => Date
  /** A címke-prefixszel csökkentett hasznos darab-hossz. Alap: Telegram-korlát − tartalék. */
  chunkLimit?: number
  /** Ennyi próbálkozás után a forduló véglegesen `failed` (nem próbálkozik tovább). */
  maxAttempts?: number
  /** Ennyi ideje `running` állapotú sor elavultnak számít (elszállt worker) — visszavehető. */
  staleRunningMs?: number
}

export type ProcessTurnOutcome =
  | 'no_session'
  | 'fail_closed'
  | 'unsupported'
  | 'no_agent'
  | 'agent_unavailable'
  | 'answered'
  | 'blocked_sensitive'
  | 'runtime_error'
  | 'retried'
  | 'failed'
  /** Beépített parancs (agent-váltás, agent-lista, szervezet, súgó) — nem hívtuk a modellt. */
  | 'command'

const DEFAULT_CHUNK_LIMIT = TELEGRAM_MAX_MESSAGE_CHARS - 200
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_STALE_RUNNING_MS = 5 * 60 * 1000

/**
 * A hozzáférési kapu OLVASÁSA szállt el (nem tiltás született). Külön típus, mert a kezelése is
 * más: kimenő hívás nélkül újrapróbálható forduló — se válasz, se hibaértesítés nem mehet ki,
 * amíg a jogosultság bizonytalan.
 */
class ChannelAccessCheckError extends Error {
  constructor(cause: unknown) {
    super(`channel access check failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'ChannelAccessCheckError'
  }
}

export class ChannelTurnService {
  private readonly now: () => Date
  private readonly chunkLimit: number
  private readonly maxAttempts: number
  private readonly staleRunningMs: number

  constructor(private readonly deps: ChannelTurnServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.chunkLimit = deps.chunkLimit ?? DEFAULT_CHUNK_LIMIT
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.staleRunningMs = deps.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS
  }

  // ── Bejárat 1: sor-írás a bejövő webhookból (túléli a kérést, D8) ──────────

  /**
   * Egy összekötött felhasználó privát üzenetét TARTÓS forduló-sorba írja. A webhook ezután
   * azonnal nyugtáz; a tényleges futás a workerre marad (`processQueued`). A duplikáció-védelem
   * (frissítés-vízjel) a hívó linking-szolgáltatásban történt már meg — ide csak egyszer jut el
   * ugyanaz a frissítés.
   */
  async enqueueInbound(input: {
    sessionId: string
    identity: ChannelIdentity
    message: ChannelInboundTurnMessage
  }): Promise<ChannelTurn> {
    const kind = input.message.kind
    const turn = await this.deps.turns.enqueue({
      sessionId: input.sessionId,
      inboundRef: String(input.message.updateId),
      inboundText: kind === 'text' ? input.message.text : null,
      inboundKind: kind,
    })
    await this.deps.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: CHANNEL_AUDIT_ACTIONS.turnEnqueued,
      targetType: 'channel_turn',
      targetId: turn.id,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'queued',
      metadata: {
        channelType: TELEGRAM,
        inboundKind: kind,
        pseudonym: pseudonymFromLookupHash(input.identity.lookupHash),
        tenantId: input.identity.tenantId,
      },
      tenantId: input.identity.tenantId,
    })
    return turn
  }

  // ── Bejárat 2: a worker második munkatípusa (D8) ──────────────────────────

  /** A `queued` (és elavult `running`) sorok feldolgozása. A worker ciklusonként hívja. */
  async processQueued(input: { limit: number }): Promise<{ processed: number }> {
    const now = this.now()
    const claimed = await this.deps.turns.claimNextBatch({
      limit: input.limit,
      now,
      staleRunningBefore: new Date(now.getTime() - this.staleRunningMs),
    })
    for (const turn of claimed) {
      await this.runClaimedTurn(turn)
    }
    return { processed: claimed.length }
  }

  /** Egy lefoglalt forduló feldolgozása, teljes hiba-kerítéssel (újrapróbálhatóság, D8). */
  async runClaimedTurn(turn: ChannelTurn): Promise<ProcessTurnOutcome> {
    try {
      return await this.processTurn(turn)
    } catch (error) {
      // Váratlan elszállás → a forduló ÚJRAPRÓBÁLHATÓ (D8). A próbálkozások kimerülésekor
      // véglegesen `failed`, és — best-effort — a felhasználó nem marad némán.
      // KIVÉTEL: ha maga a hozzáférés-ellenőrzés szállt el, a jogosultság bizonytalan, ezért
      // egyetlen kimenő hívás sem mehet ki (a hibaértesítés sem) — a leállított vagy visszavont
      // csatorna még életjelet sem adhat.
      const accessCheckFailed = error instanceof ChannelAccessCheckError
      const message = error instanceof Error ? error.message : String(error)
      const meta = accessCheckFailed
        ? { error: truncate(message), reason: 'access_check_failed' }
        : { error: truncate(message) }
      if (turn.attempts >= this.maxAttempts) {
        await this.deps.turns.markFailed(turn.id, message)
        if (!accessCheckFailed) await this.tryNotifyFatal(turn)
        await this.auditTurn(turn, 'failed', accessCheckFailed ? 'fail_closed' : 'error', meta)
        return 'failed'
      }
      await this.deps.turns.markRetry(turn.id, message)
      await this.auditTurn(turn, 'retry', accessCheckFailed ? 'fail_closed' : 'retry', meta)
      return 'retried'
    }
  }

  private async processTurn(turn: ChannelTurn): Promise<ProcessTurnOutcome> {
    const session = await this.deps.sessions.findById(turn.sessionId)
    if (!session) {
      await this.deps.turns.markDone(turn.id)
      return 'no_session'
    }

    // Identitás ÉLŐ feloldása (D2): visszavont/tiltott kötés → a futásidő NEM hívódik (fail-closed).
    const identity = session.identityId
      ? await this.deps.identities.findById(session.identityId)
      : null
    if (!identity || identity.status !== 'active') {
      await this.deps.turns.markDone(turn.id)
      await this.auditTurn(turn, 'completed', 'fail_closed', {
        pseudonym: identity ? pseudonymFromLookupHash(identity.lookupHash) : null,
      })
      return 'fail_closed'
    }

    // A Telegram-kötés csak a külső fiókot azonosítja; NEM helyettesíti az élő platform-
    // jogosultságot. A queued üzenet később fut, ezért minden alkalommal újraellenőrizzük a
    // tagságot, a tenant életciklusát és a tenant-szintű Telegram kill-switch-et. Hiba vagy
    // hiányzó rekord is tiltás (fail-closed), és nincs kimenő üzenet, nehogy a leállított
    // csatorna adatot szivárogtasson.
    if (!(await this.authorizeQueuedTurn(turn, identity))) return 'fail_closed'

    // Fájl / hang → érthető elutasítás, agent-futás nélkül (§27).
    if (turn.inboundKind !== 'text' || turn.inboundText == null) {
      await this.sendFrame(session, UNSUPPORTED_CONTENT_TEXT, identity, turn, 'unsupported')
      await this.deps.turns.markDone(turn.id)
      return 'unsupported'
    }

    // Beépített parancsok (story 14/28): agent-váltás, agent-lista, szervezet, súgó. A modellt
    // NEM hívjuk — ezek a csatorna saját, kormányzáson kívüli kényelmi válaszai, és a jogosultsági
    // metszet itt is ÉLŐBEN dől el (a lista csak az engedélyezett agenteket mutatja).
    const command = parseCommand(turn.inboundText)
    if (command) {
      await this.runCommand(session, identity, turn, command)
      await this.deps.turns.markDone(turn.id)
      return 'command'
    }

    // Agent-metszet (D5): a csatorna-engedélyek adják az elérhető agenteket. Nincs engedély →
    // érthető útmutatás („szólj az adminodnak"), nem néma.
    const grants = await this.deps.grants.listForIdentity(identity.id)
    if (grants.length === 0) {
      await this.sendFrame(session, NO_AGENT_TEXT, identity, turn, 'no_agent')
      await this.deps.turns.markDone(turn.id)
      return 'no_agent'
    }

    // Az aktív agent az előző fordulóból (ha még engedélyezett), különben az első engedély.
    const activeGrant =
      grants.find((g) => g.agentId === session.activeAgentId) ?? grants[0]
    const agent = await this.deps.agents.findById(activeGrant.agentId)
    // Tenant-határ (D2): egy másik szervezethez tartozó (vagy eltűnt) agent nem oldódik fel.
    if (!agent || !isAgentReachableFromTenant(agent.tenantId, identity.tenantId)) {
      await this.sendFrame(session, AGENT_UNAVAILABLE_TEXT, identity, turn, 'agent_unavailable')
      await this.deps.turns.markDone(turn.id)
      return 'agent_unavailable'
    }
    // Az agent-feloldás is aszinkron: a közben visszavont jogosultság után még a session
    // aktív-agent mutatóját sem írhatjuk át.
    if (!(await this.authorizeQueuedTurn(turn, identity, agent.id))) return 'fail_closed'
    if (session.activeAgentId !== agent.id) {
      await this.deps.sessions.update(session.id, { activeAgentId: agent.id })
    }

    const projectKey = activeGrant.projectKey || GENERAL_PROJECT_KEY

    // A beszélgetés létrehozása is tartós tenant-adatot ír. Ha a kapu az agent-feloldás alatt
    // záródott be, még ezt a belső mellékhatást se végezzük el egy tiltott csatornafordulóhoz.
    if (!(await this.authorizeQueuedTurn(turn, identity, agent.id))) return 'fail_closed'

    // 24 órás gördülő beszélgetés (D9): a megőrzési határidő a létrehozáskor áll be. A user- és
    // agent-üzenetet a futásidő perzisztálja ebbe a beszélgetésbe (web-láthatóság, AC).
    const conversationId = await this.resolveConversation({
      session,
      agentId: agent.id,
      identity,
      projectKey,
    })

    // „Gépel" jelzés a feldolgozás alatt (§20). A korábbi kapu és ez közé szándékosan nincs
    // tartós futás, de az ellenőrzés közvetlenül a kimenet előtt van: kill-switch vagy
    // visszavonás esetén még a jelzés se adjon életjelet a leállított csatornáról.
    if (!(await this.authorizeQueuedTurn(turn, identity, agent.id))) return 'fail_closed'
    await this.deps.transport.send({
      channelType: TELEGRAM,
      method: 'sendChatAction',
      // Dupla idézőjel: az audit-katalógus szkenner ne vegye literálnak a ChatAction payloadot.
      payload: { chat_id: session.externalThreadId, action: "typing" },
    })

    // A MEGLÉVŐ agent-futásidő. Csak a VÉGSŐ választ adja vissza (nincs gondolkodási nyom).
    const result = await this.deps.runtime.runTurn({
      agentId: agent.id,
      tenantId: identity.tenantId,
      userId: identity.userId,
      conversationId,
      projectKey,
      text: turn.inboundText,
    })

    // A modellfutás hosszú lehet. Közben a tenant-admin visszavonhatja a tagságot vagy
    // elzárhatja a Telegramot; a válasz ekkor NEM hagyhatja el a hiteles platformot.
    if (!(await this.authorizeQueuedTurn(turn, identity, agent.id))) return 'fail_closed'

    const label = buildLabel(agent, projectKey)

    if (!result.ok) {
      // Időtúllépés / modellhiba / keret elfogyott → hétköznapi magyar (§23/§24), nem néma.
      const text = errorText(result.reason)
      const delivered = await this.sendLabeled(session, label, [text], identity, turn, agent.id, 'runtime_error', {
        reason: result.reason,
      })
      if (delivered === 'access_revoked') return 'fail_closed'
      await this.deps.turns.markDone(turn.id)
      return 'runtime_error'
    }

    // Érzékenységi kapu a KIMENŐ szövegen (D10): sensitive/forbidden → BLOKK (nem terelés).
    // A nyers választ a futásidő már a hiteles tárba írta (web-láthatóság); Telegramra CSAK a
    // blokk megy — a nyers szöveg egyetlen kimenő hívásban sem szerepel.
    // A `classifyPrompt` az `assistant`/`user`/`tool` szerepű üzeneteket nézi — a kimenő
    // agent-válasz itt `assistant`-ként osztályozódik (formátum-alapú detektor, D10).
    const sensitivity = classifyPrompt([{ role: 'assistant', content: result.text }])
    if (sensitivity.level !== 'clean') {
      await this.sendToThread(session, `${label}\n\n${SENSITIVITY_BLOCK_TEXT}`)
      await this.deps.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: CHANNEL_AUDIT_ACTIONS.messageBlocked,
        targetType: 'channel_turn',
        targetId: turn.id,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: sensitivity.level,
        metadata: {
          channelType: TELEGRAM,
          sensitivity: sensitivity.level,
          // Csak a kategória (pl. `pan`) kerül auditba — a nyers találat SOHA.
          matchedCategory: sensitivity.matchedCategory ?? null,
          pseudonym: pseudonymFromLookupHash(identity.lookupHash),
        },
        tenantId: identity.tenantId,
      })
      await this.deps.turns.markDone(turn.id)
      return 'blocked_sensitive'
    }

    // Tiszta válasz (a futásidő már perzisztálta, web-láthatóság): címkézett, darabolt kiküldés.
    const chunks = chunkOutboundText(result.text, this.chunkLimit)
    const delivered = await this.sendLabeled(
      session,
      label,
      chunks,
      identity,
      turn,
      agent.id,
      'answered',
      { chunks: chunks.length },
    )
    if (delivered === 'access_revoked') return 'fail_closed'
    if (delivered === 'blocked_by_user') {
      await this.deps.identities.updateStatus(identity.id, 'blocked')
    }
    await this.deps.turns.markDone(turn.id)
    return 'answered'
  }

  // ── Beépített parancsok (story 14/28) ──────────────────────────────────────

  /**
   * A jelenleg ELÉRHETŐ agentek: a csatorna-engedélyek metszete a tenant-határral, feloldott
   * névvel. Ugyanaz a kapu, ami a fordulót is engedi — a lista nem mutathat többet, mint
   * amivel a felhasználó tényleg beszélhet.
   */
  private async listAvailableAgents(identity: ChannelIdentity): Promise<
    { agentId: string; name: string; projectKey: string }[]
  > {
    const grants = await this.deps.grants.listForIdentity(identity.id)
    const out: { agentId: string; name: string; projectKey: string }[] = []
    for (const grant of grants) {
      const agent = await this.deps.agents.findById(grant.agentId)
      if (!agent || !isAgentReachableFromTenant(agent.tenantId, identity.tenantId)) continue
      out.push({
        agentId: agent.id,
        name: agent.personaNickname?.trim() || agent.name,
        projectKey: grant.projectKey || GENERAL_PROJECT_KEY,
      })
    }
    return out
  }

  private async runCommand(
    session: ChannelSession,
    identity: ChannelIdentity,
    turn: ChannelTurn,
    command: { name: string; argument: string },
  ): Promise<void> {
    const text = await this.commandReply(session, identity, command)
    // A parancs NEVE auditálható (nem tartalom); az argumentum NEM — az felhasználói szöveg.
    await this.sendFrame(session, text, identity, turn, 'command', { command: command.name })
  }

  private async commandReply(
    session: ChannelSession,
    identity: ChannelIdentity,
    command: { name: string; argument: string },
  ): Promise<string> {
    if (command.name === 'szervezet') {
      const orgName = (await this.deps.resolveOrgName?.(identity.tenantId)) ?? null
      const org = orgName?.trim() ? `„${orgName.trim()}"` : 'a hozzád rendelt szervezet'
      return (
        `Itt ${org} nevében beszélsz. Ez az összekötéskor rögzült, és nem váltható Telegramon — ` +
        'ha másik szervezetben szeretnél dolgozni, a webes felületen szüntesd meg az összekötést, ' +
        'válts szervezetet, és kösd össze újra.'
      )
    }

    const agents = await this.listAvailableAgents(identity)
    if (agents.length === 0) return NO_AGENT_TEXT

    if (command.name === 'agentek') {
      const lines = agents.map((a, i) => {
        const active = a.agentId === session.activeAgentId || (!session.activeAgentId && i === 0)
        const project = a.projectKey === GENERAL_PROJECT_KEY ? GENERAL_PROJECT_LABEL : a.projectKey
        return `${i + 1}. ${a.name} — ${project}${active ? ' (most ezzel beszélsz)' : ''}`
      })
      return (
        'Ezeket az agenteket éred el Telegramon:\n' +
        lines.join('\n') +
        '\n\nVáltáshoz írd: /valt 2 — vagy /valt és az agent nevének eleje.'
      )
    }

    if (command.name === 'valt') {
      if (!command.argument) {
        return 'Írd a parancs után, melyikre váltsak — például: /valt 2 — vagy az agent nevének elejét. A listát a /agentek paranccsal kéred le.'
      }
      const target = matchAgent(agents, command.argument)
      if (!target) {
        return `Nem találtam „${command.argument}" néven agentet azok között, amiket elérsz. Kérd le a listát: /agentek`
      }
      if (session.activeAgentId !== target.agentId) {
        // Az agent-váltás ÚJ beszélgetést nyit (a `conversationId` nullázásával): a másik agent
        // ne örökölje az előző agent beszélgetés-szálát.
        await this.deps.sessions.update(session.id, {
          activeAgentId: target.agentId,
          conversationId: null,
        })
      }
      const project =
        target.projectKey === GENERAL_PROJECT_KEY ? GENERAL_PROJECT_LABEL : target.projectKey
      return `Rendben, mostantól ${target.name} válaszol (projekt: ${project}). Új beszélgetést kezdtünk vele — írd le, miben segíthet.`
    }

    // `/segitseg` (és a `/start` paraméter nélküli alakja): mit lehet itt csinálni.
    return (
      'Itt az agentjeiddel beszélgethetsz — csak írd le a kérdésed hétköznapi nyelven.\n\n' +
      'Amit még tudok:\n' +
      '/agentek — kiket érsz el, és épp melyikkel beszélsz\n' +
      '/valt — váltás másik agentre\n' +
      '/szervezet — melyik szervezet nevében beszélsz itt\n\n' +
      'Ha egy napig nem írsz, új beszélgetés indul, hogy a tegnapi téma ne keveredjen a maiba. ' +
      'Fájlt és hangüzenetet egyelőre nem tudok feldolgozni.'
    )
  }

  // ── Segédek ────────────────────────────────────────────────────────────────

  private async authorizeIdentity(identity: ChannelIdentity, agentId?: string): Promise<
    | { allowed: true }
    | {
        allowed: false
        reason:
          | 'tenant_missing'
          | 'membership_inactive'
          | 'tenant_inactive'
          | 'channel_disabled'
          | 'agent_grant_revoked'
      }
  > {
    if (!identity.tenantId) return { allowed: false, reason: 'tenant_missing' }

    const membership = await this.deps.memberships.findByTenantAndUser(
      identity.tenantId,
      identity.userId,
    )
    if (!membership || membership.status !== 'active') {
      return { allowed: false, reason: 'membership_inactive' }
    }

    const tenantGate = await evaluateTenantOperationGate({
      tenants: this.deps.tenants,
      gateTenantId: identity.tenantId,
    })
    if (!tenantGate.allowed) return { allowed: false, reason: 'tenant_inactive' }

    if (!(await this.deps.isChannelEnabled(identity.tenantId))) {
      return { allowed: false, reason: 'channel_disabled' }
    }
    if (agentId && !(await this.deps.grants.findForIdentityAgent(identity.id, agentId))) {
      return { allowed: false, reason: 'agent_grant_revoked' }
    }
    return { allowed: true }
  }

  /**
   * A sorba állított forduló élő, auditált fail-closed kapuja. Minden tartós mellékhatás és
   * Telegram-kimenet előtt újra használjuk, mert a hozzáférés a worker várakozása vagy a
   * modellfutás alatt is visszavonható.
   */
  private async authorizeQueuedTurn(
    turn: ChannelTurn,
    identity: ChannelIdentity,
    agentId?: string,
  ): Promise<boolean> {
    let access: Awaited<ReturnType<ChannelTurnService['authorizeIdentity']>>
    try {
      access = await this.authorizeIdentity(identity, agentId)
    } catch (error) {
      // A jogosultság BIZONYTALANSÁGA (pl. pillanatnyi adatbázis-hiba) más, mint egy kimondott
      // tiltás: nem tudjuk, van-e joga a felhasználónak. Ilyenkor sem küldünk semmit — de a
      // munkatárs üzenetét sem dobjuk el némán, véglegesen: a forduló újrapróbálható marad (D8),
      // és csak a próbálkozások kimerülése után lesz `failed`, kimenő értesítés nélkül.
      throw new ChannelAccessCheckError(error)
    }
    if (access.allowed) return true
    await this.deps.turns.markDone(turn.id)
    await this.auditTurn(turn, 'completed', 'fail_closed', {
      reason: access.reason,
      pseudonym: pseudonymFromLookupHash(identity.lookupHash),
      tenantId: identity.tenantId,
    })
    return false
  }

  /**
   * A 24 órás gördülő beszélgetés feloldása (D9). Ha van élő (ugyanahhoz az agenthez tartozó,
   * 24 órán belül aktív) beszélgetés, azt folytatjuk; különben ÚJ beszélgetés jön létre saját
   * megőrzési határidővel, és a munkamenet erre mutat.
   */
  private async resolveConversation(input: {
    session: ChannelSession
    agentId: string
    identity: ChannelIdentity
    projectKey: string
  }): Promise<string> {
    const now = this.now()
    if (input.session.conversationId) {
      const existing = await this.deps.conversations.findById(input.session.conversationId)
      if (
        existing &&
        existing.agentId === input.agentId &&
        now.getTime() - existing.lastMessageAt.getTime() <= ROLLING_WINDOW_MS
      ) {
        return existing.id
      }
    }
    const created = await this.deps.conversations.create({
      tenantId: input.identity.tenantId,
      agentId: input.agentId,
      createdById: input.identity.userId,
      projectKey: input.projectKey,
      channel: TELEGRAM,
      channelExternalId: input.session.externalThreadId,
      title: null,
    })
    await this.deps.sessions.update(input.session.id, { conversationId: created.id })
    return created.id
  }

  /** Keret-/hibaüzenet küldése a szálba (címke nélkül) + audit. */
  private async sendFrame(
    session: ChannelSession,
    text: string,
    identity: ChannelIdentity,
    turn: ChannelTurn,
    outcome: ProcessTurnOutcome,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await this.sendToThread(session, text)
    await this.auditTurn(turn, 'completed', outcome, {
      pseudonym: pseudonymFromLookupHash(identity.lookupHash),
      ...(extra ?? {}),
    })
  }

  /**
   * Címkézett (agent + projekt), darabolt kiküldés. MINDEN darab elején ott a címke (a darab
   * így önmagában érvényes). A `blocked_by_user` jelzést visszaadja (a hívó tiltottra állítja
   * a kötést, D15).
   */
  private async sendLabeled(
    session: ChannelSession,
    label: string,
    chunks: string[],
    identity: ChannelIdentity,
    turn: ChannelTurn,
    agentId: string,
    outcome: ProcessTurnOutcome,
    auditMeta: Record<string, unknown>,
  ): Promise<'ok' | 'blocked_by_user' | 'access_revoked'> {
    const total = chunks.length
    for (let i = 0; i < total; i++) {
      if (!(await this.authorizeQueuedTurn(turn, identity, agentId))) return 'access_revoked'
      const counter = chunkCounterLabel(i, total)
      const header = counter ? `${label} ${counter}` : label
      const res = await this.sendToThread(session, `${header}\n\n${chunks[i]}`)
      if (res === 'blocked_by_user') {
        await this.auditTurn(turn, 'completed', outcome, {
          ...auditMeta,
          delivered: i,
          pseudonym: pseudonymFromLookupHash(identity.lookupHash),
          blockedByUser: true,
        })
        return 'blocked_by_user'
      }
    }
    await this.auditTurn(turn, 'completed', outcome, {
      ...auditMeta,
      delivered: total,
      pseudonym: pseudonymFromLookupHash(identity.lookupHash),
    })
    return 'ok'
  }

  private async sendToThread(
    session: ChannelSession,
    text: string,
  ): Promise<'ok' | 'blocked_by_user' | 'error'> {
    const res = await this.deps.transport.send({
      channelType: TELEGRAM,
      method: 'sendMessage',
      payload: { chat_id: session.externalThreadId, text },
    })
    if (res.ok) return 'ok'
    return res.reason === 'blocked_by_user' ? 'blocked_by_user' : 'error'
  }

  /** Best-effort értesítés végleges hibánál — a felhasználó ne maradjon némán. */
  private async tryNotifyFatal(turn: ChannelTurn): Promise<void> {
    const session = await this.deps.sessions.findById(turn.sessionId)
    if (!session) return
    await this.deps.transport
      .send({
        channelType: TELEGRAM,
        method: 'sendMessage',
        payload: { chat_id: session.externalThreadId, text: UNKNOWN_ERROR_TEXT },
      })
      .catch(() => {})
  }

  private async auditTurn(
    turn: ChannelTurn,
    kind: 'completed' | 'retry' | 'failed',
    outcome: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const action =
      kind === 'completed'
        ? CHANNEL_AUDIT_ACTIONS.turnCompleted
        : kind === 'retry'
          ? CHANNEL_AUDIT_ACTIONS.turnRetry
          : CHANNEL_AUDIT_ACTIONS.turnFailed
    await this.deps.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action,
      targetType: 'channel_turn',
      targetId: turn.id,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: outcome,
      metadata: { channelType: TELEGRAM, ...metadata },
    })
  }
}

// ── Tiszta segédfüggvények ────────────────────────────────────────────────────

/** A válasz-címke: 🤖 <agent-név> · <projekt>. MINDEN kimenő válasz elején (D5/§29). */
export function buildLabel(
  agent: Pick<Agent, 'name' | 'personaNickname'>,
  projectKey: string,
): string {
  const name = agent.personaNickname?.trim() || agent.name
  return `🤖 ${name} · ${projectLabel(projectKey)}`
}

function projectLabel(projectKey: string): string {
  return !projectKey || projectKey === GENERAL_PROJECT_KEY ? GENERAL_PROJECT_LABEL : projectKey
}

function errorText(reason: 'timeout' | 'model_error' | 'budget_exhausted' | 'unknown'): string {
  switch (reason) {
    case 'timeout':
      return TIMEOUT_TEXT
    case 'model_error':
      return MODEL_ERROR_TEXT
    case 'budget_exhausted':
      return BUDGET_EXHAUSTED_TEXT
    default:
      return UNKNOWN_ERROR_TEXT
  }
}

function truncate(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s
}

/**
 * A beépített parancsok felismerése (story 14/28). Ékezet nélküli és angol alakot is elfogadunk,
 * mert a telefonos billentyűzeten az ékezet gyakran elmarad; a Telegram `/parancs@botnév` alakját
 * is kezeljük. Ami nem ismert parancs, az sima üzenet marad, és az agenthez megy.
 */
const COMMAND_ALIASES: Record<string, string> = {
  agentek: 'agentek',
  agents: 'agentek',
  valt: 'valt',
  vált: 'valt',
  switch: 'valt',
  szervezet: 'szervezet',
  hol: 'szervezet',
  org: 'szervezet',
  segitseg: 'segitseg',
  segítség: 'segitseg',
  help: 'segitseg',
  start: 'segitseg',
}

export function parseCommand(text: string | null): { name: string; argument: string } | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [head, ...rest] = trimmed.slice(1).split(/\s+/)
  // A `/parancs@botnév` alakból a bot-nevet levágjuk.
  const key = (head ?? '').split('@')[0]!.toLowerCase()
  const name = COMMAND_ALIASES[key]
  if (!name) return null
  return { name, argument: rest.join(' ').trim() }
}

/** Agent-találat sorszám (1-alapú) vagy név-előtag alapján — ahogy a felhasználó gépeli. */
function matchAgent<T extends { name: string }>(agents: T[], argument: string): T | null {
  const index = Number.parseInt(argument, 10)
  if (Number.isInteger(index) && index >= 1 && index <= agents.length) return agents[index - 1]!
  const needle = argument.toLowerCase()
  return (
    agents.find((a) => a.name.toLowerCase() === needle) ??
    agents.find((a) => a.name.toLowerCase().startsWith(needle)) ??
    agents.find((a) => a.name.toLowerCase().includes(needle)) ??
    null
  )
}

/**
 * Csatorna-bot szolgáltatás (CB-*) — platform-bot regisztráció / frissítés
 * (Telegram feature-spec #70/#71, D3/D14). Fakes-szel, DB nélkül.
 *
 * A tesztek külső viselkedést figyelnek: a bot titok-REFERENCIAKÉNT tárol (sosem nyersen),
 * a felületi nézet a titkot nem adja vissza, minden művelet auditált, és csatorna-típusonként
 * egyetlen platform-bot él (a második regisztráció `already_exists`).
 */
import assert from 'node:assert/strict'
import type { ChannelBot } from '@prisma/client'
import { ChannelBotService } from '../src/domain/channel/channel-bot-service'
import { RecordingChannelTransport } from '../src/domain/channel/channel-outbound-transport'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import type {
  AuditRepository,
  ChannelBotRepository,
  CreateChannelBotInput,
  UpdateChannelBotInput,
} from '../src/repositories/interfaces'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`)
  }
}

type AuditRow = { action: string; targetType: string; targetId: string | null; metadata: Record<string, unknown> }

/** In-memory ChannelBot tár, ami a valós invariánst utánozza (egy platform-bot / típus). */
function makeHarness() {
  const rows = new Map<string, ChannelBot>()
  const audits: AuditRow[] = []
  let seq = 0

  const bots: ChannelBotRepository = {
    async findPlatformBot(channelType) {
      for (const b of rows.values()) if (b.channelType === channelType && b.tenantId === null) return b
      return null
    },
    async findById(id) {
      return rows.get(id) ?? null
    },
    async create(input: CreateChannelBotInput) {
      // Az egyetlen-platform-bot invariáns (a valós migráció részleges egyedi indexe).
      if (input.tenantId === null) {
        for (const b of rows.values()) {
          if (b.channelType === input.channelType && b.tenantId === null) {
            throw new Error('duplicate platform bot (unique index)')
          }
        }
      }
      const now = new Date()
      const bot: ChannelBot = {
        id: `bot-${++seq}`,
        channelType: input.channelType,
        tenantId: input.tenantId,
        name: input.name,
        accessKeySecretRef: input.accessKeySecretRef,
        webhookSecretRef: input.webhookSecretRef,
        status: input.status ?? 'active',
        createdById: input.createdById,
        createdAt: now,
        updatedAt: now,
      }
      rows.set(bot.id, bot)
      return bot
    },
    async update(id, input: UpdateChannelBotInput) {
      const cur = rows.get(id)
      if (!cur) throw new Error('not found')
      const next: ChannelBot = {
        ...cur,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.accessKeySecretRef !== undefined ? { accessKeySecretRef: input.accessKeySecretRef } : {}),
        ...(input.webhookSecretRef !== undefined ? { webhookSecretRef: input.webhookSecretRef } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: new Date(),
      }
      rows.set(id, next)
      return next
    },
  }

  const audit: Pick<AuditRepository, 'append'> = {
    append: async (data) => {
      // A katalógus-regisztráltságot élesen is ellenőrizzük (fail-fast a valós repóban).
      assertAuditActionRegistered(data.action)
      audits.push({
        action: data.action,
        targetType: data.targetType,
        targetId: data.targetId ?? null,
        metadata: (data.metadata ?? {}) as Record<string, unknown>,
      })
      return data as never
    },
  }

  const svc = new ChannelBotService({ bots, audit: audit as AuditRepository })

  // Beüzemelő harness: KÖZÖS kimenő dublőr + a három környezeti feltétel befecskendezve, hogy a
  // `setWebhook` / `getMe` / `getWebhookInfo` út hálózat nélkül, determinisztikusan mérhető legyen.
  const transport = new RecordingChannelTransport()
  function setupSvc(opts?: {
    botUsername?: string
    botUsernameConfigured?: boolean
    publicUrlConfigured?: boolean
    webhookSecret?: string
  }) {
    return new ChannelBotService({
      bots,
      audit: audit as AuditRepository,
      transport,
      resolveWebhookSecret: async () => opts?.webhookSecret ?? 'nagyon-hosszu-titok',
      resolveWebhookUrl: (channelType) => `https://platform.example/api/channels/${channelType}/webhook`,
      resolveBotUsername: () => ({
        username: opts?.botUsername ?? 'ceg_agent_bot',
        configured: opts?.botUsernameConfigured ?? true,
      }),
      isPublicAppUrlConfigured: () => opts?.publicUrlConfigured ?? true,
    })
  }

  return { svc, audits, rows, transport, setupSvc }
}

const VALID = {
  channelType: 'telegram' as const,
  name: 'Platform Telegram Bot',
  accessKeySecretRef: 'secret-manager:projects/p/secrets/telegram-bot-token',
  webhookSecretRef: 'env:TELEGRAM_WEBHOOK_SECRET',
}

async function main() {
  console.log('=== Csatorna-bot szolgáltatás ===')

  await test('CB-1 platform-bot regisztráció: tenantId null (= platform), auditált', async () => {
    const { svc, audits, rows } = makeHarness()
    const res = await svc.registerPlatformBot(VALID, 'admin-1')
    assert.equal(res.ok, true)
    assert.equal(res.ok && res.bot.isPlatformLevel, true)
    assert.equal(res.ok && res.bot.tenantId, null)
    const stored = [...rows.values()][0]
    assert.equal(stored.tenantId, null)
    assert.equal(audits.length, 1)
    assert.equal(audits[0].action, 'channel.bot.register')
    assert.equal(audits[0].targetType, 'channel_bot')
  })

  await test('CB-2 a hozzáférési kulcs + webhook titok CSAK referenciaként tárolódik', async () => {
    const { rows } = makeHarness()
    const { svc } = makeHarness()
    void rows
    const res = await svc.registerPlatformBot(VALID, 'admin-1')
    assert.equal(res.ok, true)
    if (res.ok) {
      // A publikus nézet SOHA nem adja vissza a referenciát/titkot — csak a meglét jelzését.
      const serialized = JSON.stringify(res.bot)
      assert.ok(!serialized.includes('telegram-bot-token'), 'a titok-referencia nem lehet a nézetben')
      assert.ok(!serialized.includes('TELEGRAM_WEBHOOK_SECRET'), 'a webhook-referencia nem lehet a nézetben')
      assert.equal(res.bot.hasAccessKey, true)
      assert.equal(res.bot.hasWebhookSecret, true)
    }
  })

  await test('CB-3 nyers titok (nem referencia) elutasítva', async () => {
    const { svc, audits } = makeHarness()
    const res = await svc.registerPlatformBot(
      { ...VALID, accessKeySecretRef: '123456:RAW-TELEGRAM-TOKEN' },
      'admin-1',
    )
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, 'invalid_secret_ref')
    assert.equal(audits.length, 0) // elutasított regisztráció nem auditál sikert
  })

  await test('CB-4 üres név elutasítva', async () => {
    const { svc } = makeHarness()
    const res = await svc.registerPlatformBot({ ...VALID, name: '   ' }, 'admin-1')
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, 'invalid_name')
  })

  await test('CB-5 egyetlen platform-bot: a második regisztráció already_exists', async () => {
    const { svc } = makeHarness()
    assert.equal((await svc.registerPlatformBot(VALID, 'admin-1')).ok, true)
    const again = await svc.registerPlatformBot(VALID, 'admin-1')
    assert.equal(again.ok, false)
    assert.equal(!again.ok && again.reason, 'already_exists')
  })

  await test('CB-6 frissítés: név/státusz megy a kulcs újbóli megadása nélkül', async () => {
    const { svc, audits } = makeHarness()
    await svc.registerPlatformBot(VALID, 'admin-1')
    const res = await svc.updatePlatformBot(
      { channelType: 'telegram', name: 'Új név', status: 'disabled' },
      'admin-2',
    )
    assert.equal(res.ok, true)
    assert.equal(res.ok && res.bot.name, 'Új név')
    assert.equal(res.ok && res.bot.status, 'disabled')
    const updateAudit = audits.find((a) => a.action === 'channel.bot.update')
    assert.ok(updateAudit, 'van channel.bot.update audit')
    assert.equal(updateAudit!.metadata.accessKeyRotated, false)
    assert.equal(updateAudit!.metadata.webhookSecretRotated, false)
  })

  await test('CB-7 frissítés kulcs-rotációval: a referencia felülíródik, audit jelzi', async () => {
    const { svc, audits, rows } = makeHarness()
    await svc.registerPlatformBot(VALID, 'admin-1')
    const res = await svc.updatePlatformBot(
      { channelType: 'telegram', accessKeySecretRef: 'secret-manager:projects/p/secrets/rotated' },
      'admin-2',
    )
    assert.equal(res.ok, true)
    const stored = [...rows.values()][0]
    assert.equal(stored.accessKeySecretRef, 'secret-manager:projects/p/secrets/rotated')
    const updateAudit = audits.find((a) => a.action === 'channel.bot.update')!
    assert.equal(updateAudit.metadata.accessKeyRotated, true)
  })

  await test('CB-8 frissítés nyers titokkal elutasítva', async () => {
    const { svc } = makeHarness()
    await svc.registerPlatformBot(VALID, 'admin-1')
    const res = await svc.updatePlatformBot(
      { channelType: 'telegram', webhookSecretRef: 'raw-not-a-ref' },
      'admin-2',
    )
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, 'invalid_secret_ref')
  })

  await test('CB-9 frissítés regisztrált bot nélkül → not_found', async () => {
    const { svc } = makeHarness()
    const res = await svc.updatePlatformBot({ channelType: 'telegram', name: 'x' }, 'admin-1')
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, 'not_found')
  })

  await test('CB-10 getPlatformBot: nincs bot → null; regisztráció után nézet titok nélkül', async () => {
    const { svc } = makeHarness()
    assert.equal(await svc.getPlatformBot('telegram'), null)
    await svc.registerPlatformBot(VALID, 'admin-1')
    const view = await svc.getPlatformBot('telegram')
    assert.ok(view)
    assert.equal(view!.isPlatformLevel, true)
    assert.ok(!JSON.stringify(view).includes('telegram-bot-token'))
  })

  await test('CB-11 setup-állapot: kimondja, ha a bot-felhasználónév vagy a publikus cím hiányzik', async () => {
    const { setupSvc } = makeHarness()
    const svc = setupSvc({ botUsernameConfigured: false, publicUrlConfigured: false })
    const state = await svc.getSetupState('telegram')
    assert.equal(state.bot, null)
    assert.equal(state.botUsernameConfigured, false)
    assert.equal(state.webhookUrlConfigured, false)
    assert.match(state.webhookUrl, /\/api\/channels\/telegram\/webhook$/)
  })

  await test('CB-12 webhook bekötése: setWebhook a titkos fejléccel, auditált, a titok NEM auditálódik', async () => {
    const { setupSvc, transport, audits } = makeHarness()
    const svc = setupSvc({ webhookSecret: 'sup3r-titk0s-fejlec' })
    await svc.registerPlatformBot(VALID, 'admin-1')
    transport.reset()

    const res = await svc.installWebhook('telegram', 'admin-1')
    assert.equal(res.ok, true)
    assert.equal(transport.calls.length, 1)
    const call = transport.calls[0]!
    assert.equal(call.method, 'setWebhook')
    assert.equal(call.payload.secret_token, 'sup3r-titk0s-fejlec')
    assert.deepEqual(call.payload.allowed_updates, ['message', 'callback_query'])
    assert.match(String(call.payload.url), /^https:\/\/platform\.example\//)

    const entry = audits.find((a) => a.action === 'channel.bot.webhook_installed')
    assert.ok(entry, 'a bekötés auditálandó')
    assert.ok(!JSON.stringify(entry!.metadata).includes('sup3r-titk0s-fejlec'))
  })

  await test('CB-13 webhook bekötése fail-closed: nincs bot / nincs publikus cím → nincs kimenő hívás', async () => {
    const noBot = makeHarness()
    const a = await noBot.setupSvc().installWebhook('telegram', 'admin-1')
    assert.equal(a.ok === false && a.reason, 'not_found')
    assert.equal(noBot.transport.calls.length, 0)

    const noUrl = makeHarness()
    const svc = noUrl.setupSvc({ publicUrlConfigured: false })
    await svc.registerPlatformBot(VALID, 'admin-1')
    noUrl.transport.reset()
    const b = await svc.installWebhook('telegram', 'admin-1')
    assert.equal(b.ok === false && b.reason, 'public_url_missing')
    assert.equal(noUrl.transport.calls.length, 0)
  })

  await test('CB-14 kapcsolat-ellenőrzés: felismeri az idegen webhookot és a rossz felhasználónevet', async () => {
    const { setupSvc, transport } = makeHarness()
    const svc = setupSvc({ botUsername: 'elgepelt_bot' })
    await svc.registerPlatformBot(VALID, 'admin-1')
    transport.reset()
    transport.queueResults(
      { ok: true, providerMessageId: null, result: { username: 'ceg_agent_bot' } },
      {
        ok: true,
        providerMessageId: null,
        result: { url: 'https://masik-rendszer.example/hook', pending_update_count: 4 },
      },
    )

    const check = await svc.checkConnection('telegram')
    assert.equal(check.reachable, true)
    assert.equal(check.botUsername, 'ceg_agent_bot')
    assert.equal(check.webhookMatches, false, 'idegen webhook-cím nem számít egyezésnek')
    assert.equal(check.usernameMatches, false, 'az elgépelt env rossz mélylinket adna')
    assert.equal(check.pendingUpdateCount, 4)
  })

  await test('CB-15 kapcsolat-ellenőrzés: helyes beüzemelésnél minden egyezik', async () => {
    const { setupSvc, transport } = makeHarness()
    const svc = setupSvc()
    await svc.registerPlatformBot(VALID, 'admin-1')
    transport.reset()
    transport.queueResults(
      { ok: true, providerMessageId: null, result: { username: 'ceg_agent_bot' } },
      {
        ok: true,
        providerMessageId: null,
        result: {
          url: 'https://platform.example/api/channels/telegram/webhook',
          pending_update_count: 0,
        },
      },
    )

    const check = await svc.checkConnection('telegram')
    assert.equal(check.webhookMatches, true)
    assert.equal(check.usernameMatches, true)
    assert.equal(check.failureReason, null)
  })

  await test('CB-16 kapcsolat-ellenőrzés: nem elérhető bot → reachable=false, nincs találgatás', async () => {
    const { setupSvc, transport } = makeHarness()
    const svc = setupSvc()
    await svc.registerPlatformBot(VALID, 'admin-1')
    transport.reset()
    transport.queueResults({ ok: false, reason: 'provider_error', detail: 'status_401' })
    const check = await svc.checkConnection('telegram')
    assert.equal(check.reachable, false)
    assert.equal(check.failureReason, 'provider_error')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt BUKOTT.`)
    process.exit(1)
  }
  console.log('\nMinden csatorna-bot szolgáltatás teszt zöld.')
}

void main()

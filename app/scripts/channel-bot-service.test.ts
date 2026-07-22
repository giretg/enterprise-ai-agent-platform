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
  return { svc, audits, rows }
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

  if (failures > 0) {
    console.error(`\n${failures} teszt BUKOTT.`)
    process.exit(1)
  }
  console.log('\nMinden csatorna-bot szolgáltatás teszt zöld.')
}

void main()

/**
 * Minden agent self_evolution_profile-jában kikapcsolja a négy szem elvet.
 * MemoryTraining v1.1.1 §4.5.1: szándékos, a mostani tanítási folyamat mellett
 * a kapcsoló zsákutcába zárná a ticketet. Idempotens.
 * Futtatás: npx tsx --import ./scripts/load-env.ts scripts/disable-four-eyes-training.ts
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../src/lib/db'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function withFourEyesOff(raw: unknown): { next: Record<string, unknown>; changed: boolean } {
  const profile = asRecord(raw) ?? {}
  const durable = asRecord(profile.durable_memory_approval_policy)
  const activationMode =
    durable?.activation_mode === 'operator_can_activate' || durable?.activation_mode === 'approver_required'
      ? durable.activation_mode
      : 'approver_required'
  if (durable?.four_eyes_required === false && durable.activation_mode === activationMode) {
    return { next: profile, changed: false }
  }
  return {
    next: {
      ...profile,
      durable_memory_approval_policy: {
        ...(durable ?? {}),
        activation_mode: activationMode,
        four_eyes_required: false,
      },
    },
    changed: true,
  }
}

async function main() {
  const agents = await prisma.agent.findMany({
    select: { id: true, name: true, selfEvolutionProfile: true },
    orderBy: { name: 'asc' },
  })
  let updated = 0
  let skipped = 0
  for (const agent of agents) {
    const { next, changed } = withFourEyesOff(agent.selfEvolutionProfile)
    if (!changed) {
      skipped++
      continue
    }
    await prisma.agent.update({
      where: { id: agent.id },
      data: { selfEvolutionProfile: next as Prisma.InputJsonValue },
    })
    updated++
    console.log(`  ${agent.name}: four_eyes_required=false`)
  }
  console.log(`Kész: ${updated} agent frissítve, ${skipped} már ki volt kapcsolva.`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

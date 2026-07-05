import { PrismaClient } from '@prisma/client'
import { PlaybookCompiler } from '@/domain/playbook/playbook-compiler'

async function main() {
  const prisma = new PrismaClient()
  const p = prisma as any
  const pvId = process.argv[2]
  if (!pvId) throw new Error('Pass playbookVersionId as arg')

  const pv = await p.playbookVersionV2.findFirst({ where: { id: pvId } })
  if (!pv) throw new Error(`PlaybookVersionV2 not found: ${pvId}`)

  const compiler = new PlaybookCompiler()
  const newCompiledSpec = compiler.compile(pv.spec, { playbookVersionId: pvId })

  for (const rule of newCompiledSpec.ticketRules) {
    console.log(`  ${rule.stepId}: ${rule.allowedTransitions.map((t: any) => `${t.fromState}→${t.toState}`).join(', ')}`)
  }

  await p.playbookVersionV2.update({ where: { id: pvId }, data: { compiledSpec: newCompiledSpec } })
  console.log('Done: compiledSpec updated in DB')
  await prisma.$disconnect()
}
main().catch(console.error)

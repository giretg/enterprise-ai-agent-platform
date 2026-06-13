import { prisma } from '@/lib/db'
import type { EvalRun } from '@prisma/client'

export type GoldenSetAssertion = {
  description: string
  type: 'contains' | 'not_contains' | 'min_length'
  value: string | number
}

type AssertionResult = { description: string; passed: boolean; reason: string }

function runAssertion(a: GoldenSetAssertion, content: string): AssertionResult {
  switch (a.type) {
    case 'contains': {
      const passed = content.toLowerCase().includes(String(a.value).toLowerCase())
      return { description: a.description, passed, reason: `contains "${a.value}"` }
    }
    case 'not_contains': {
      const passed = !content.toLowerCase().includes(String(a.value).toLowerCase())
      return { description: a.description, passed, reason: `not_contains "${a.value}"` }
    }
    case 'min_length': {
      const passed = content.length >= Number(a.value)
      return { description: a.description, passed, reason: `min_length ${a.value} (actual: ${content.length})` }
    }
    default:
      return {
        description: a.description,
        passed: false,
        reason: `unknown assertion type: ${(a as GoldenSetAssertion).type}`,
      }
  }
}

export class EvalService {
  async run(params: {
    evalId: string
    proposedContent: string
    agentVersion: number
    memoryVersionId?: string
    trigger: 'pre_training_approval' | 'scheduled' | 'manual'
  }): Promise<EvalRun> {
    const evalDef = await prisma.eval.findUnique({ where: { id: params.evalId } })
    if (!evalDef) throw new Error('Eval not found')

    const assertions = evalDef.goldenSet as GoldenSetAssertion[]
    const results = assertions.map((a) => runAssertion(a, params.proposedContent))
    const passed = results.every((r) => r.passed)
    const score = assertions.length > 0 ? results.filter((r) => r.passed).length / assertions.length : 1

    return prisma.evalRun.create({
      data: {
        evalId: params.evalId,
        trigger: params.trigger,
        agentVersion: params.agentVersion,
        memoryVersionId: params.memoryVersionId ?? null,
        passed,
        score,
        details: { results },
      },
    })
  }

  async findActiveForAgent(agentId: string) {
    return prisma.eval.findFirst({ where: { agentId, status: 'active' } })
  }

  async findAllForAgent(agentId: string) {
    return prisma.eval.findMany({
      where: { agentId },
      include: { runs: { orderBy: { createdAt: 'desc' }, take: 1 } },
    })
  }

  async create(params: {
    agentId: string
    name: string
    goldenSet: GoldenSetAssertion[]
  }) {
    return prisma.eval.create({ data: params })
  }
}

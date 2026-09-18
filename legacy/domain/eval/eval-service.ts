import { prisma } from '@/lib/db'
import type { EvalRun } from '@prisma/client'

type EvalPersistence = Pick<typeof prisma, 'eval' | 'evalRun'>

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
  constructor(private readonly db: EvalPersistence = prisma) {}

  async run(params: {
    evalId: string
    /** Az eval mindig pontosan ennek az agentnek a minőségi kapuja. */
    agentId: string
    proposedContent: string
    agentVersion: number
    memoryVersionId?: string
    trigger: 'pre_training_approval' | 'scheduled' | 'manual'
  }): Promise<EvalRun> {
    const evalDef = await this.db.eval.findUnique({ where: { id: params.evalId } })
    // A hívó által megadott agent-verzió csak akkor hiteles metaadat, ha az eval
    // valóban ugyanahhoz az agenthez tartozik. Ellenkező esetben egy másik
    // agent enyhébb golden setje hibásan a cél-agent minőségi kapujának
    // eredményeként jelenhetne meg.
    if (!evalDef || evalDef.agentId !== params.agentId) throw new Error('Eval not found')

    const assertions = evalDef.goldenSet as GoldenSetAssertion[]
    const results = assertions.map((a) => runAssertion(a, params.proposedContent))
    const passed = results.every((r) => r.passed)
    const score = assertions.length > 0 ? results.filter((r) => r.passed).length / assertions.length : 1

    return this.db.evalRun.create({
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
    return this.db.eval.findFirst({ where: { agentId, status: 'active' } })
  }

  async findAllForAgent(agentId: string) {
    return this.db.eval.findMany({
      where: { agentId },
      include: { runs: { orderBy: { createdAt: 'desc' }, take: 1 } },
    })
  }

  async create(params: {
    agentId: string
    name: string
    goldenSet: GoldenSetAssertion[]
  }) {
    return this.db.eval.create({ data: params })
  }
}

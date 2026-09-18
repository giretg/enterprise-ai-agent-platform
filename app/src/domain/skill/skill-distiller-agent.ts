export type DistillTranscriptTurn = {
  role: 'user' | 'assistant' | 'tool' | 'agent'
  text: string
  toolName?: string
}

export type SkillDistillDraft = {
  name: string
  description: string
  content: unknown
  requires: Array<{ toolName: string; reason: string }>
  riskTier: string
}

export class SkillDistillerAgent {
  async distill(_input: Record<string, unknown>): Promise<{ draft: SkillDistillDraft }> {
    throw new Error('Skill distillation moved to the harness (Phase 0)')
  }
}

export type SkillAdvisoryReview = {
  riskSummary: string
  overallAssessment: 'low' | 'medium' | 'high'
  concerns: string[]
  suggestedRequires: Array<{ toolName: string; reason: string }>
}

export class SkillReviewAgent {
  async review(_input: Record<string, unknown>): Promise<{ review: SkillAdvisoryReview }> {
    throw new Error('Skill review moved to the harness (Phase 0)')
  }
}

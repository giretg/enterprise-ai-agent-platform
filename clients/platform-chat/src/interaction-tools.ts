/**
 * Kérdés-kártya és munkaterv (#1025) — harness-eszközök, a worker helyben válaszol (nem MCP-hívás).
 * - `ask_user`: a forduló `awaiting_input`-ra áll és leáll; a user választása (vagy szabad szövege)
 *   tool-eredményként megy vissza a modellnek.
 * - `update_plan`: `plan` eseményt ír, a chat élőben mutatja a munkatervet.
 */
import type { PlanItem, Question, QuestionAnswer } from './store.ts'

export const ASK_USER = 'ask_user'
export const UPDATE_PLAN = 'update_plan'
export const INTERACTION_TOOLS: readonly string[] = [ASK_USER, UPDATE_PLAN]

/** Fordulónként legfeljebb ennyi kérdés — utána a munkatárs a legvalószínűbb értelmezéssel dolgozik. */
export const MAX_QUESTIONS_PER_TURN = 3
const MIN_OPTIONS = 2
const MAX_OPTIONS = 5
const QUESTION_MAX_CHARS = 300
const LABEL_MAX_CHARS = 80
const DESCRIPTION_MAX_CHARS = 160
const MAX_PLAN_ITEMS = 12
const PLAN_TITLE_MAX_CHARS = 120
const ANSWER_MAX_CHARS = 2000
const PLAN_STATUSES = ['pending', 'in_progress', 'done'] as const

export const INTERACTION_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: ASK_USER,
      description:
        'Kattintható választási kérdés a felhasználónak, ha a kérés valóban kétértelmű (pl. több szóba jöhető címzett vagy dokumentum), ' +
        'és válasz nélkül rossz dolgot tennél. Előbb nézz utána az eszközökkel, és a talált konkrét lehetőségeket kínáld fel. ' +
        `Egyértelmű kérésnél ne kérdezz. Fordulónként legfeljebb ${MAX_QUESTIONS_PER_TURN} kérdés. A választ tool-eredményként kapod.`,
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', maxLength: QUESTION_MAX_CHARS, description: 'Rövid, közérthető kérdés.' },
          options: {
            type: 'array',
            minItems: MIN_OPTIONS,
            maxItems: MAX_OPTIONS,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', maxLength: LABEL_MAX_CHARS, description: 'A gomb felirata.' },
                description: { type: 'string', maxLength: DESCRIPTION_MAX_CHARS, description: 'Opcionális rövid magyarázat.' },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
          allowOther: { type: 'boolean', description: 'A felhasználó saját szöveggel is válaszolhat (alapértelmezés: igen).' },
          multiSelect: { type: 'boolean', description: 'Több lehetőség is választható (alapértelmezés: nem).' },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: UPDATE_PLAN,
      description:
        'Munkaterv a felhasználónak: a teljes lépéslista az aktuális állapottal. Csak 3 vagy több lépéses feladatnál használd; ' +
        'az elején add meg a lépéseket, és minden lépés után küldd el újra a frissített listát.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_PLAN_ITEMS,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', maxLength: PLAN_TITLE_MAX_CHARS, description: 'A lépés közérthető megnevezése.' },
                status: { type: 'string', enum: [...PLAN_STATUSES] },
              },
              required: ['title', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['steps'],
        additionalProperties: false,
      },
    },
  },
] as const

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

export function parseQuestion(args: Record<string, unknown>): Question | { error: string } {
  const question = text(args.question, QUESTION_MAX_CHARS)
  if (!question) return { error: 'Error: add meg a kérdést (question).' }
  const raw = Array.isArray(args.options) ? args.options : []
  const options: Question['options'] = []
  for (const o of raw) {
    const item = o && typeof o === 'object' ? (o as Record<string, unknown>) : {}
    const label = text(item.label, LABEL_MAX_CHARS)
    if (!label || options.some((x) => x.label === label)) continue
    const description = text(item.description, DESCRIPTION_MAX_CHARS)
    options.push(description ? { label, description } : { label })
  }
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return { error: `Error: ${MIN_OPTIONS}–${MAX_OPTIONS} különböző lehetőséget adj meg (options[].label).` }
  }
  return { question, options, allowOther: args.allowOther !== false, multiSelect: args.multiSelect === true }
}

export function parsePlan(args: Record<string, unknown>): PlanItem[] | { error: string } {
  const raw = Array.isArray(args.steps) ? args.steps : []
  const steps: PlanItem[] = []
  for (const s of raw.slice(0, MAX_PLAN_ITEMS)) {
    const item = s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
    const title = text(item.title, PLAN_TITLE_MAX_CHARS)
    const status = PLAN_STATUSES.find((x) => x === item.status)
    if (title && status) steps.push({ title, status })
  }
  if (steps.length === 0) return { error: 'Error: a steps lista üres vagy hibás (title + status: pending | in_progress | done).' }
  return steps
}

export const planProgress = (steps: PlanItem[]) => `${steps.filter((s) => s.status === 'done').length}/${steps.length} kész`

/** A user válasza: csak a felkínált lehetőségek, egyválasztós kérdésnél egy; a szabad szöveg mindig számít (#1025/3). */
export function normalizeAnswer(question: Question, input: { selected?: unknown; text?: unknown }): QuestionAnswer | null {
  const labels = new Set(question.options.map((o) => o.label))
  const selected = [...new Set(Array.isArray(input.selected) ? input.selected.filter((x): x is string => typeof x === 'string' && labels.has(x)) : [])]
  if (Array.isArray(input.selected) && selected.length !== input.selected.length) return null
  if (!question.multiSelect && selected.length > 1) return null
  const answerText = typeof input.text === 'string' ? input.text.trim().slice(0, ANSWER_MAX_CHARS) : ''
  if (selected.length === 0 && !answerText) return null
  return answerText ? { selected, text: answerText } : { selected }
}

/** A válasz a user üzenetében (a beszélgetésben ez látszik a user buborékjában). */
export function answerDisplay(answer: QuestionAnswer): string {
  return [answer.selected.join(', '), answer.text].filter(Boolean).join(' — ')
}

/** A modellnek visszamenő tool-eredmény. */
export function answerToolText(answer: QuestionAnswer, attachmentNote = ''): string {
  const parts = [
    answer.selected.length ? `A felhasználó választása: ${answer.selected.map((l) => `„${l}”`).join(', ')}.` : '',
    answer.text ? `A felhasználó saját szöveggel válaszolt: „${answer.text}”` : '',
  ]
  return parts.filter(Boolean).join('\n') + attachmentNote
}

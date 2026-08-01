/**
 * Teszt-fixture: HITELES Tool Broker eredmény (issue #195).
 *
 * A broker `invoke` visszatérése a kikényszerített kimeneti szerződés óta két
 * csatornát ad (`modelText` a modellnek, `machineData` a gépi fogyasztóknak) és
 * egy KÖTELEZŐ kimenetel-mezőt. A dublőröknek ugyanazt az alakot kell adniuk,
 * mint az éles keretnek — különben a teszt olyan viselkedést mérne, ami élesben
 * nem létezik (pl. hiányzó becsomagolás vagy elmaradt `empty` közlés).
 *
 * Ezért ez a fixture UGYANAZT a tiszta függvényt hívja, mint a broker
 * (`buildToolOutcomeChannels`), nem másolja a logikát.
 */
import { buildToolOutcomeChannels } from '../../src/domain/tool-broker/tool-output-contract'
import { resolveToolOutputContract } from '../../src/domain/tool-broker/tool-output-contracts'
import {
  isSideEffectingTool,
  resolveTrustClass,
} from '../../src/domain/tool-broker/tool-trust-registry'
import type {
  ToolBrokerInvokeResult,
  TrustClass,
} from '../../src/domain/tool-broker/tool-broker-types'

/** Sikeres tool-eredmény a broker valódi alakjában (szerződés-kapuval együtt). */
export function fakeToolBrokerSuccess(
  tool: string,
  output: unknown,
  trust: TrustClass = resolveTrustClass(tool),
): ToolBrokerInvokeResult {
  const channels = buildToolOutcomeChannels({
    tool,
    trust,
    output,
    contract: resolveToolOutputContract(tool),
    sideEffecting: isSideEffectingTool(tool),
  })
  return {
    denied: false,
    trust,
    outcome: channels.outcome,
    outcomeReason: channels.outcomeReason,
    effect: channels.effect,
    modelText: channels.modelText,
    machineData: channels.machineData,
    result: output,
    resultMeta: {},
    latencyMs: 1,
  } as unknown as ToolBrokerInvokeResult
}

/** Elutasított tool-hívás a broker valódi alakjában (a kimenetel `failed`). */
export function fakeToolBrokerDenied(reason: string): ToolBrokerInvokeResult {
  return { denied: true, reason, latencyMs: 1, outcome: 'failed' }
}

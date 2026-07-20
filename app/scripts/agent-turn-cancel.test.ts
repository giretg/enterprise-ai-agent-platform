/**
 * Stop a perzisztált fordulóra (issue #65).
 *
 * A megszakítás a forduló azonosítójára hivatkozik, nem a beszélgetésére. A
 * helyi runner-jelzés csak gyorsítás — a több-instance eset a DB-flagen
 * keresztül működik, ezért itt mindkét utat külön ellenőrizzük.
 */
import assert from 'node:assert/strict'
import { AgentTurnRunner } from '../src/domain/agent/agent-turn-runner'
import { evaluateLoopContinuation, type LoopGuardLimits } from '../src/domain/agent/loop-stop-decision'

const limits: LoopGuardLimits = {
  maxTurns: 10,
  maxWallClockMs: 180_000,
  maxToolCalls: 60,
  maxNoProgressTurns: 3,
}

const idleState = {
  turn: 0,
  elapsedMs: 0,
  toolCallCount: 0,
  noProgressTurns: 0,
  limits,
}

async function main(): Promise<void> {
  // --- A helyi jel a FORDULÓ azonosítójára szól ---------------------------------

  {
    const runner = new AgentTurnRunner()
    let release = () => {}
    const handle = runner.start('turn-1', async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    assert.ok(handle, 'a futásnak el kell indulnia')

    assert.equal(runner.isCancelRequested('turn-1'), false)
    assert.equal(runner.requestCancel('turn-1'), true)
    assert.equal(runner.isCancelRequested('turn-1'), true)

    // Egy MÁSIK forduló jelét ez nem billenti át — nincs beszélgetés-szintű átfedés.
    assert.equal(runner.isCancelRequested('turn-2'), false)

    release()
    await handle.completion
  }

  // --- Ismeretlen / máshol futó forduló: nem hiba, csak nincs helyi találat -----

  {
    const runner = new AgentTurnRunner()
    assert.equal(
      runner.requestCancel('turn-elsewhere'),
      false,
      'másik instance-en futó fordulóra a helyi jelzés false-t ad',
    )
    assert.equal(runner.isCancelRequested('turn-elsewhere'), false)
  }

  // --- A lezárt futás jele nem marad hátra --------------------------------------

  {
    const runner = new AgentTurnRunner()
    const handle = runner.start('turn-3', async () => {})
    assert.ok(handle)
    await handle.completion
    assert.equal(
      runner.isCancelRequested('turn-3'),
      false,
      'a lezárt futás kikerül a registryből, nem szivárog át a következő fordulóra',
    )
  }

  // --- A döntéshozó a jelet leállásra fordítja (a jel forrásától függetlenül) ---

  {
    // Helyi jel (Stop ugyanarra az instance-re érkezett).
    assert.deepEqual(evaluateLoopContinuation({ ...idleState, cancelRequested: true }), {
      continue: false,
      reason: 'cancelled',
    })

    // Nincs jel → fut tovább.
    assert.deepEqual(evaluateLoopContinuation({ ...idleState, cancelRequested: false }), {
      continue: true,
    })

    // A megszakítás a többi korlátot MEGELŐZI: a felhasználói szándék az első.
    assert.deepEqual(
      evaluateLoopContinuation({
        ...idleState,
        turn: 99,
        elapsedMs: 999_999,
        toolCallCount: 999,
        noProgressTurns: 99,
        cancelRequested: true,
      }),
      { continue: false, reason: 'cancelled' },
      'a cancelled indok győz a wallclock/tool-budget/no-progress felett',
    )
  }
}

void main().then(() => {
  console.log('agent-turn-cancel.test.ts: ok')
})

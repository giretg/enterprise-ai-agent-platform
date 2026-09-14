import assert from 'node:assert'
import {
  recoverDsmlToolCallsFromText,
  recoverDeepseekNativeToolCallsFromText,
} from '@/domain/agent/chat-tool-loop'
import { buildToolInvokeInput } from '@/domain/tool-broker/tool-registry'

// 1) DeepSeek DSML-formátumú, natívan nem parse-olt tool-hívás felismerése
// (a 2026-09-14-i Gábor-beszélgetésben ez a szöveg szivárgott ki a chatbe).
const leaked =
  'Ha nincs ilyen függőben lévő művelet, ezt írd.' +
  '<invoke name="memory_propose"><parameter name="reason">teszt</parameter></invoke>' +
  '</｜DSML｜tool_calls>'
const recovered = recoverDsmlToolCallsFromText(leaked)
assert.strictEqual(recovered.length, 1)
assert.strictEqual(recovered[0].tool, 'memory_propose')
assert.strictEqual(recovered[0].args.reason, 'teszt')
console.log('OK  DSML <invoke> hívás felismerve szövegből')

// 1b) DeepSeek natív, tokenizer-szintű tool-call formátuma (nem <invoke>,
// hanem <｜tool▁call▁begin｜>function<｜tool▁sep｜>NÉV ... <｜tool▁call▁end｜>) —
// ezt még nem láttuk élesben szivárogni, de a modell dokumentált saját
// formátuma, és a DeepSeek adja a hívások többségét ezen a platformon.
const nativeLeaked =
  '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>memory_propose\n' +
  '```json\n{"reason":"teszt"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>'
const nativeRecovered = recoverDeepseekNativeToolCallsFromText(nativeLeaked)
assert.strictEqual(nativeRecovered.length, 1)
assert.strictEqual(nativeRecovered[0].tool, 'memory_propose')
assert.strictEqual(nativeRecovered[0].args.reason, 'teszt')
console.log('OK  DeepSeek natív tool-call token felismerve szövegből')

// 2) A memory_propose hiányos hívása a gate ELŐTT bukjon el (buildToolInvokeInput-nál),
// ne csak mélyen a memory-acceptance-policy-ban, futás közben (miután már
// elfogyasztott egy felhasználói jóváhagyást).
assert.throws(
  () =>
    buildToolInvokeInput(
      'memory_propose',
      { operation: 'create', reason: 'ok' }, // path/title/text hiányzik
      { agentId: 'a', agentVersion: 1 },
    ),
  /Érvénytelen argumentumok/,
)
console.log('OK  hiányos memory_propose a séma-kapun bukik, nem jut el a jóváhagyásig')

console.log('Minden teszt sikeres.')

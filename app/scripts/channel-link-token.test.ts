/**
 * Deep-link összekötő token (CLT-*) — aláírás, konstans idejű vetés, formátum-őr, jti-hossz
 * (Telegram feature-spec #70/#72, D12). DB nélkül, tiszta logikai tesztek.
 *
 * Futtatás: npm run test:channel-link-token
 */
import assert from 'node:assert/strict'
import {
  isValidStartParam,
  newLinkJti,
  signLinkClaims,
  verifyLinkSignature,
  type ChannelLinkTokenClaims,
} from '../src/domain/channel/channel-link-token'

let passed = 0
let failed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

const CLAIMS: ChannelLinkTokenClaims = {
  jti: 'abc123',
  channelType: 'telegram',
  userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  tenantId: '11111111-1111-1111-1111-111111111111',
}

check('determinisztikus: ugyanazok a mezők ugyanazt az aláírást adják', () => {
  assert.equal(signLinkClaims(CLAIMS), signLinkClaims(CLAIMS))
})

check('a helyes aláírás átmegy a konstans idejű vetésen', () => {
  assert.equal(verifyLinkSignature(CLAIMS, signLinkClaims(CLAIMS)), true)
})

check('egyetlen mező eltérése érvényteleníti az aláírást (kötés-integritás)', () => {
  const sig = signLinkClaims(CLAIMS)
  assert.equal(verifyLinkSignature({ ...CLAIMS, tenantId: '22222222-2222-2222-2222-222222222222' }, sig), false)
  assert.equal(verifyLinkSignature({ ...CLAIMS, userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }, sig), false)
  assert.equal(verifyLinkSignature({ ...CLAIMS, jti: 'other' }, sig), false)
})

check('platform-szintű (tenantId null) és konkrét szervezet aláírása KÜLÖNBÖZIK', () => {
  const a = signLinkClaims({ ...CLAIMS, tenantId: null })
  const b = signLinkClaims({ ...CLAIMS, tenantId: '' })
  // A null → '' kanonizálás ne mossa össze a valódi üres stringgel jelölt eseteket a
  // szervezet-azonosítóval (UUID sosem üres), és a null se ütközzön más mezővel.
  assert.equal(verifyLinkSignature({ ...CLAIMS, tenantId: null }, a), true)
  assert.equal(a, b) // dokumentált: a null és az üres string azonos (nincs valós üres-string tenant)
})

check('hamis aláírás elbukik (nem dob, csak false)', () => {
  assert.equal(verifyLinkSignature(CLAIMS, 'nem-is-alairas'), false)
  assert.equal(verifyLinkSignature(CLAIMS, ''), false)
})

check('jti Telegram-kompatibilis: <=64 kar, [A-Za-z0-9_-]', () => {
  for (let i = 0; i < 50; i++) {
    const jti = newLinkJti()
    assert.ok(jti.length <= 64, `jti túl hosszú: ${jti.length}`)
    assert.ok(isValidStartParam(jti), `jti nem érvényes start-param: ${jti}`)
  }
})

check('start-param formátum-őr: szóköz / túl hosszú / üres elutasítva', () => {
  assert.equal(isValidStartParam('abc-DEF_123'), true)
  assert.equal(isValidStartParam('van benne szokoz'), false)
  assert.equal(isValidStartParam(''), false)
  assert.equal(isValidStartParam('x'.repeat(65)), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

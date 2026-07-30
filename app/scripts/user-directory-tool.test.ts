/**
 * user_directory agent-tool tesztek.
 * Futtatás: npm run test:user-directory
 *
 * A tiszta szűrő (filterUserDirectory) determinisztikusan tesztelhető DB nélkül.
 * A tenant-izolációt és a capability/connector-kaput a Tool Broker authorizer
 * kényszeríti ki (külön tesztelve); itt a keresési/szűrési szemantikát fedjük.
 */
import assert from 'node:assert/strict'
import {
  filterUserDirectory,
  type UserDirectorySearchEntry,
} from '../src/domain/tool-broker/tool-broker-service'

let failures = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`)
  }
}

const DIR: UserDirectorySearchEntry[] = [
  { userId: 'u1', name: 'Kovács Anna', email: 'anna@ceg.hu', role: 'operator', jobDescription: 'Marketing vezető', status: 'active' },
  { userId: 'u2', name: 'Nagy Béla', email: 'bela@ceg.hu', role: 'viewer', jobDescription: 'Copywriter', status: 'active' },
  { userId: 'u3', name: 'Szabó Csaba', email: 'csaba@ceg.hu', role: 'approver', jobDescription: null, status: 'active' },
]

function main() {
  console.log('=== user_directory tool ===')

  test('üres vagy hiányzó query fail-closed: nem kérhető le a teljes névsor', () => {
    assert.deepEqual(filterUserDirectory(DIR, {}), { users: [] })
    assert.deepEqual(filterUserDirectory(DIR, { query: '   ' }), { users: [] })
    // Csak írásjel: a normalizálás szóközzé alakítja, tehát üres keresés — nem
    // eshet át a kapun üres szótaggal (az mindenkire illeszkedne).
    assert.deepEqual(filterUserDirectory(DIR, { query: '...' }), { users: [] })
    assert.deepEqual(filterUserDirectory(DIR, { query: '@' }), { users: [] })
  })

  test('a jobDescription (szerep) alapján keres — "marketing" → a marketing vezető', () => {
    const res = filterUserDirectory(DIR, { query: 'marketing' })
    assert.deepEqual(res.users.map((u) => u.userId), ['u1'])
  })

  test('ékezet- és kisbetű-független ("kovacs" → Kovács Anna)', () => {
    const res = filterUserDirectory(DIR, { query: 'KOVACS' })
    assert.deepEqual(res.users.map((u) => u.userId), ['u1'])
  })

  test('szerep (role) alapján is szűr', () => {
    const res = filterUserDirectory(DIR, { query: 'approver' })
    assert.deepEqual(res.users.map((u) => u.userId), ['u3'])
  })

  test('e-mail alapján kereshető, de az e-mail nem kerül az eredménybe', () => {
    const res = filterUserDirectory(DIR, { query: 'bela@ceg.hu' })
    assert.deepEqual(res.users.map((u) => u.userId), ['u2'])
    assert.equal('email' in res.users[0], false)
    assert.ok(!JSON.stringify(res).includes('bela@ceg.hu'))
  })

  test('az e-mail csak TELJES címre illeszkedik — domain-részlettel nem enumerálható', () => {
    // A domainre / „@"-ra illesztés a teljes tenant-névsort adná vissza, ami
    // ugyanaz a tömeges lekérés, amit az üres query tiltása megakadályoz.
    assert.deepEqual(filterUserDirectory(DIR, { query: 'ceg.hu' }).users, [])
    assert.deepEqual(filterUserDirectory(DIR, { query: '@ceg.hu' }).users, [])
    // A cím helyi része ugyanakkor névként továbbra is kereshető marad
    // ("anna" → Kovács Anna): ez a tool rendeltetésszerű célzott keresése.
    assert.deepEqual(filterUserDirectory(DIR, { query: 'anna' }).users.map((u) => u.userId), ['u1'])
  })

  test('több keresőszó ÉS-kapcsolt (minden szónak illeszkednie kell)', () => {
    assert.equal(filterUserDirectory(DIR, { query: 'nagy copywriter' }).users.length, 1)
    assert.equal(filterUserDirectory(DIR, { query: 'nagy marketing' }).users.length, 0)
  })

  test('nincs találat → üres lista (nem hiba)', () => {
    assert.deepEqual(filterUserDirectory(DIR, { query: 'nincs-ilyen-xyz' }).users, [])
  })

  test('limit korlátoz és 1..100 közé szorít', () => {
    // "a" mindhárom névben szerepel (Kovács Anna / Nagy Béla / Szabó Csaba).
    assert.equal(filterUserDirectory(DIR, { query: 'a', limit: 2 }).users.length, 2)
    assert.equal(filterUserDirectory(DIR, { query: 'a', limit: 0 }).users.length, 1) // min 1
    assert.equal(filterUserDirectory(DIR, { query: 'a', limit: 999 }).users.length, 3) // cap 100 → mind
  })

  test('a leírás nélküli user (null jobDescription) nem dob hibát keresésnél', () => {
    const res = filterUserDirectory(DIR, { query: 'szabo' })
    assert.deepEqual(res.users.map((u) => u.userId), ['u3'])
  })

  if (failures > 0) {
    console.error(`\n${failures} user_directory teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden user_directory teszt zöld.')
}

main()

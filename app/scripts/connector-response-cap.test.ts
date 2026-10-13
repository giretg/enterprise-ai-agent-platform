/**
 * Determinisztikus teszt a válasz-törzs kemény bájt-plafonjához (`readResponseTextCapped`).
 * Futtatás: npm run test:connector-response-cap
 *
 * Bizonyítja, hogy egy korlátlan válasz-törzs NEM húzódik egészben a memóriába: a plafon
 * átlépésekor az olvasás leáll, a streamet lezárjuk, és a bemenet csak a plafonig fogy.
 */
import assert from 'node:assert/strict'
import { readResponseTextCapped } from '../src/domain/connector/response-cap'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Response, amelynek törzse `chunks` darab `chunkBytes` méretű blokkot adna ki, amíg olvassák. */
function streamingResponse(chunkBytes: number, chunks: number, onPull?: () => void): Response {
  let produced = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= chunks) {
        controller.close()
        return
      }
      produced += 1
      onPull?.()
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x41)) // 'A'
    },
  })
  return new Response(stream)
}

async function main() {
  console.log('connector response-cap')

  await test('a plafon alatti törzs teljesen visszajön, nincs csonkolás', async () => {
    const res = new Response('árvíztűrő tükörfúrógép') // többbájtos UTF-8
    const out = await readResponseTextCapped(res, 10 * 1024)
    assert.equal(out.truncated, false)
    assert.equal(out.text, 'árvíztűrő tükörfúrógép')
  })

  await test('a plafon fölötti törzs csonkolt, és az olvasás a plafonnál leáll', async () => {
    let pulls = 0
    // 20 × 1 MiB = 20 MiB-ot adna ki, de 2 MiB-os plafonnal csak ~2-3 blokk fogyhat.
    const res = streamingResponse(1024 * 1024, 20, () => {
      pulls += 1
    })
    const out = await readResponseTextCapped(res, 2 * 1024 * 1024)
    assert.equal(out.truncated, true, 'truncated jelzésnek igaznak kell lennie')
    assert.ok(out.text.length <= 2 * 1024 * 1024, 'a szöveg nem lépheti túl a plafont')
    // A lényeg: NEM olvastuk végig a 20 MiB-ot — a stream a plafonnál lezárult.
    assert.ok(pulls <= 4, `a producer a plafonnál megállt (pulls=${pulls}, nem mind a 20)`)
  })

  await test('üres / törzs nélküli válasz nem dob', async () => {
    const res = new Response(null, { status: 204 })
    const out = await readResponseTextCapped(res, 1024)
    assert.equal(out.text, '')
    assert.equal(out.truncated, false)
  })

  await test('pontosan a plafon méretű törzs NEM számít csonkoltnak', async () => {
    const res = new Response('A'.repeat(1000))
    const out = await readResponseTextCapped(res, 1000)
    assert.equal(out.truncated, false)
    assert.equal(out.text.length, 1000)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nminden teszt zöld')
}

void main()

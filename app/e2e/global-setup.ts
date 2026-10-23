/**
 * Playwright global setup. A korábbi W7-es ticket-fixture a `Ticket` modell
 * megszűnésével elavult; a specek most maguk készítik elő az adataikat
 * (lásd `wiki-control-plane.spec.ts`).
 */
import { resolve } from 'node:path'
import { config } from 'dotenv'

async function globalSetup() {
  config({ path: resolve(process.cwd(), '.env.local') })
  config({ path: resolve(process.cwd(), '.env') })
}

export default globalSetup

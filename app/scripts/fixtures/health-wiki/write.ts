/** #947: a szintetikus lelet-PDF-ek fájlba írása a kézi smoke-hoz. npm run fixtures:health-wiki [-- <mappa>] */
import { join } from 'node:path'
import { writeHealthWikiFixtures } from './fixtures'

const outDir = process.argv[2] ?? join(import.meta.dirname, 'out')
writeHealthWikiFixtures(outDir).then((count) => console.log(`${count} szintetikus lelet-PDF → ${outDir}`))

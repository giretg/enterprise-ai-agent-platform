import { config } from 'dotenv'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

config({ path: resolve(appRoot, '.env.local') })
config({ path: resolve(appRoot, '.env') })

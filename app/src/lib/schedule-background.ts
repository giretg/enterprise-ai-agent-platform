/**
 * Háttérmunka ütemezése HTTP/server-action válasz után is.
 *
 * Next.js kéréskontextusban az `after()` életben tartja a processzt a task
 * végéig (serverless/Cloud Run lefagyasztás ellen). Script/teszt környezetben
 * elég a fire-and-forget promise a Node event loopon.
 */
export function scheduleBackgroundWork(task: () => Promise<void>): void {
  try {
    // Szándékosan sync require: a domain/launcher ne top-level next importtal
    // kössön Next.js-hez (script/teszt futások).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nextServer = require('next/server') as {
      after?: (task: () => void | Promise<void>) => void
    }
    if (typeof nextServer.after === 'function') {
      nextServer.after(() => task())
      return
    }
  } catch {
    // Outside Next request graph — fall through.
  }
  void task()
}

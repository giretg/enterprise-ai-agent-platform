/**
 * SSE komment-heartbeat (`: ping …`). Tool-körök alatt ritka a `data:` esemény;
 * bufferelő proxy/runtime nélkül a chunkok beragadhatnak. A komment sorokat a
 * kliens figyelmen kívül hagyja, de a TCP-t átöblítik.
 */
export function startSseCommentHeartbeat(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  intervalMs = 2000,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`))
    } catch {
      // A stream már zárva — a hívó finally-ban clearInterval-lel takarít.
    }
  }, intervalMs)
}

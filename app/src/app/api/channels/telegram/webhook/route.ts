import { NextResponse } from 'next/server'
import { services } from '@/domain'
import { readJson } from '@/lib/api-response'

/**
 * Telegram bejövő webhook — VÉKONY, logikátlan adapter (Telegram feature-spec #70/#72, D15).
 *
 * A route mindössze kivonja a titkos fejlécet és a frissítés minimál mezőit, majd átadja a
 * csatorna-szolgáltatásnak — MINDEN érdemi logika (fejléc-vetés konstans idővel, duplikáció,
 * összekötés, bekötetlen semleges válasz) ott van (a HTTP-réteg így nem igényel külön tesztet).
 *
 * A válasz MINDIG gyors 200 (story 57): a Telegram különben újraküld és letiltja a csatornát.
 * Hibás/hiányzó fejléc esetén sincs feldolgozás, de a HTTP-válasz akkor is 200 — csendes
 * elutasítás, hogy egy próbálgató ne kapjon jelet a fejléc helyességéről.
 */
export async function POST(request: Request) {
  try {
    const secretHeader = request.headers.get('x-telegram-bot-api-secret-token')
    // Túl nagy / érvénytelen törzs → null (csendes elutasítás, gyors 200), OOM-vektor nélkül.
    const body = (await readJson(request).catch(() => null)) as TelegramUpdate | null

    const callback = extractCallbackQuery(body)
    if (callback) {
      // Jóváhagyó-gomb koppintása (#76, D5/D6): aláírás/kötés-ellenőrzés, ÉLŐ jogosultság,
      // saját-kérés kapu, kettős-koppintás nyugtázás, majd a KÖZÖS állapotgép léptetése — mind a
      // csatorna-szolgáltatásban (a HTTP-réteg vékony marad). A titkos fejléc vetése is ott van.
      await services.channelApproval.handleApprovalCallback({ ...callback, secretHeader })
    } else {
      const message = extractMessage(body)
      if (message) {
        // Fire-and-await: az összekötés/semleges-válasz gyors; a bekötött chat-forduló későbbi
        // szelet (D8), az majd sort ír és a workerre bízza.
        await services.channelLinking.handleInboundUpdate({ message, secretHeader })
      }
    }
  } catch {
    // A bejövő út SOHA nem szivárogtat hibát a Telegramnak — mindig nyugtázunk.
  }
  return NextResponse.json({ ok: true })
}

type TelegramUpdate = {
  update_id?: number
  message?: {
    text?: string
    chat?: { id?: number | string }
    from?: { id?: number | string }
    // Nem-szöveges tartalmak (fájl/kép/hang) — ezekre a bot érthetően „még nem tudom kezelni"
    // választ ad (spec §27 / Out of Scope). A jelenlétüket detektáljuk, a tartalmukat nem.
    document?: unknown
    photo?: unknown
    voice?: unknown
    audio?: unknown
    video?: unknown
    video_note?: unknown
    sticker?: unknown
    animation?: unknown
  }
  // Jóváhagyó-gomb koppintása (#76). A `data` a rövid, aláírt `callback_data`; a `message` a
  // gombot hordozó üzenet (a döntés utáni szerkesztéshez kell a `message_id`).
  callback_query?: {
    id?: string
    data?: string
    from?: { id?: number | string }
    message?: { message_id?: number; chat?: { id?: number | string } }
  }
}

function extractCallbackQuery(update: TelegramUpdate | null): {
  externalUserId: string
  externalThreadId: string
  callbackQueryId: string
  callbackData: string | null
  messageId: string | number | null
} | null {
  const cb = update?.callback_query
  if (!cb || typeof cb.id !== 'string') return null
  const fromId = cb.from?.id
  const chatId = cb.message?.chat?.id
  if (fromId == null || chatId == null) return null
  return {
    externalUserId: String(fromId),
    externalThreadId: String(chatId),
    callbackQueryId: cb.id,
    callbackData: typeof cb.data === 'string' ? cb.data : null,
    messageId: cb.message?.message_id ?? null,
  }
}

function extractMessage(update: TelegramUpdate | null): {
  updateId: number
  externalThreadId: string
  externalUserId: string
  text: string | null
  kind: 'text' | 'unsupported'
} | null {
  if (!update || typeof update.update_id !== 'number') return null
  const message = update.message
  const chatId = message?.chat?.id
  const fromId = message?.from?.id
  if (chatId == null || fromId == null) return null
  const text = typeof message?.text === 'string' ? message.text : null
  const hasAttachment =
    message?.document != null ||
    message?.photo != null ||
    message?.voice != null ||
    message?.audio != null ||
    message?.video != null ||
    message?.video_note != null ||
    message?.sticker != null ||
    message?.animation != null
  // Fájl/kép/hang → `unsupported` (akkor is, ha van képaláírás — egyelőre nem dolgozzuk fel);
  // különben ha van szöveg → `text`; egyébként nem feldolgozható frissítés.
  const kind: 'text' | 'unsupported' = hasAttachment ? 'unsupported' : text != null ? 'text' : 'unsupported'
  if (!hasAttachment && text == null) return null
  return {
    updateId: update.update_id,
    externalThreadId: String(chatId),
    externalUserId: String(fromId),
    text,
    kind,
  }
}

'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  checkTelegramChannelConnection,
  getTelegramChannelSetup,
  installTelegramWebhook,
  registerPlatformChannelBot,
  updatePlatformChannelBot,
} from '@/app/actions/channel'

/**
 * Platform-admin beüzemelő képernyő a Telegram-csatornához (#70 story 53/55/56 + D3/D16/NFR-1).
 *
 * Ez a szelet zárja azt a rést, amitől a csatorna a felületről NEM volt beüzemelhető: a
 * bot-regisztráció server-action létezett, de nem hívta semmi, és a webhookot csak kézzel,
 * `curl`-lel lehetett bekötni a Telegramnál. Emiatt a rendszergazda a metrika-panelen csak
 * annyit látott, hogy „nincs regisztrált platform-bot", anélkül hogy bármit tehetett volna.
 *
 * A képernyő ezért NÉGY számozott lépés, mindegyik kimondja, mi történik és miért:
 *  1. bot létrehozása a BotFathernél (a platformon kívül),
 *  2. a bot adatainak megadása ITT (nyers kulcs + webhook-titok + felhasználónév — a
 *     titkok a menedzselt titok-tárba kerülnek, mint az API-kulcsok),
 *  3. a webhook bekötése egyetlen gombbal,
 *  4. ellenőrzés — a Telegram maga mondja meg, működik-e.
 */

type SetupResult = Awaited<ReturnType<typeof getTelegramChannelSetup>>
export type ChannelSetupView = Extract<SetupResult, { success: true }>['data']
type CheckResult = Awaited<ReturnType<typeof checkTelegramChannelConnection>>
type ConnectionCheck = Extract<CheckResult, { success: true }>['data']

function Step({
  index,
  title,
  done,
  children,
}: {
  index: number
  title: string
  done: boolean
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-line/60 bg-panel/30 p-4">
      <div className="flex items-center gap-3">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            done ? 'bg-emerald-500/20 text-emerald-500' : 'bg-line/40 text-ink-soft'
          }`}
          aria-hidden
        >
          {done ? '✓' : index}
        </span>
        <h3 className="text-sm font-medium text-ink">{title}</h3>
      </div>
      <div className="mt-3 space-y-3 pl-9">{children}</div>
    </section>
  )
}

export function ChannelBotPanel({
  initial,
  canEdit,
}: {
  initial: ChannelSetupView
  canEdit: boolean
}) {
  const [setup, setSetup] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [check, setCheck] = useState<ConnectionCheck | null>(null)
  const [name, setName] = useState(initial.bot?.name ?? 'Platform Telegram bot')
  const [botUsername, setBotUsername] = useState(initial.bot?.botUsername ?? '')
  const [accessKey, setAccessKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')

  const bot = setup.bot
  const registered = Boolean(bot)

  async function reload() {
    const fresh = await getTelegramChannelSetup()
    if (fresh.success) {
      setSetup(fresh.data)
      setBotUsername(fresh.data.bot?.botUsername ?? '')
    }
  }

  function saveBot() {
    setMessage(null)
    startTransition(async () => {
      const res = registered
        ? await updatePlatformChannelBot({
            channelType: 'telegram',
            name: name.trim(),
            botUsername: botUsername.trim(),
            ...(accessKey.trim() ? { accessKey: accessKey.trim() } : {}),
            ...(webhookSecret ? { webhookSecret } : {}),
          })
        : await registerPlatformChannelBot({
            channelType: 'telegram',
            name: name.trim(),
            botUsername: botUsername.trim(),
            accessKey: accessKey.trim(),
            webhookSecret,
          })
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error })
        return
      }
      setAccessKey('')
      setWebhookSecret('')
      setMessage({
        tone: 'ok',
        text: registered
          ? 'A bot beállításait frissítettük. Ha kulcsot cseréltél, kösd be újra a webhookot a 3. lépésben.'
          : 'A botot regisztráltuk. Folytasd a 3. lépéssel: kösd be a webhookot.',
      })
      await reload()
    })
  }

  function toggleStatus() {
    if (!bot) return
    const next = bot.status === 'active' ? 'disabled' : 'active'
    setMessage(null)
    startTransition(async () => {
      const res = await updatePlatformChannelBot({ channelType: 'telegram', status: next })
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error })
        return
      }
      setMessage({
        tone: 'ok',
        text:
          next === 'active'
            ? 'A csatornát bekapcsoltuk az egész platformon.'
            : 'A csatornát kikapcsoltuk: a rendszer egyetlen Telegram-üzenetre sem válaszol, és kifelé sem küld.',
      })
      await reload()
    })
  }

  function install() {
    setMessage(null)
    startTransition(async () => {
      const res = await installTelegramWebhook()
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error })
        return
      }
      setMessage({ tone: 'ok', text: 'A webhookot bekötöttük. Ellenőrizd a 4. lépésben.' })
      await reload()
    })
  }

  function verify() {
    setMessage(null)
    startTransition(async () => {
      const res = await checkTelegramChannelConnection()
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error })
        return
      }
      setCheck(res.data)
    })
  }

  const canSave =
    canEdit &&
    name.trim().length > 0 &&
    botUsername.trim().length > 0 &&
    (registered || (accessKey.trim().length > 0 && webhookSecret.length > 0))

  return (
    <Card title="Telegram-csatorna beüzemelése">
      <div className="space-y-5">
        <p className="text-xs text-ink-soft">
          Az egész platform <strong>egyetlen</strong> Telegram-botot használ: minden szervezet
          ezen keresztül éri el az agentjeit. Amíg ez a négy lépés nincs kész, a felhasználók
          hiába kattintanak a „Telegram összekötése&rdquo; gombra — nem történik semmi.
        </p>

        <Step index={1} title="Hozz létre egy botot a Telegramban" done={registered}>
          <p className="text-xs text-ink-soft">
            A Telegramban írj a <strong>@BotFather</strong> nevű botnak, add ki a{' '}
            <code className="rounded bg-panel/60 px-1">/newbot</code> parancsot, és válassz nevet.
            A végén kapsz egy <strong>hozzáférési kulcsot (tokent)</strong> és a bot{' '}
            <strong>felhasználónevét</strong> (pl. <code className="rounded bg-panel/60 px-1">@cegem_agent_bot</code>).
            Mindkettőre szükség lesz. Ez a lépés a platformon kívül történik.
          </p>
        </Step>

        <Step index={2} title="Regisztráld a botot itt a platformon" done={registered}>
          <p className="text-xs text-ink-soft">
            Mindent <strong>ezen a felületen</strong> adsz meg: a BotFathertől kapott{' '}
            <strong>hozzáférési kulcsot</strong>, egy általad választott hosszú véletlen{' '}
            <strong>webhook-titkot</strong>, és a bot <strong>felhasználónevét</strong> (@ nélkül).
            A két titok a szerver menedzselt titok-tárába kerül (mint az API-kulcsok) — az
            adatbázisban csak hivatkozás szerepel, a képernyőre sosem olvashatók vissza, és a
            naplókba sem kerülnek be.
          </p>
          <p className="text-xs text-ink-soft">
            A <strong>webhook-titok</strong> egy általad választott, hosszú véletlen szöveg
            (legalább 16 karakter). Ezzel ismerjük fel, hogy a beérkező üzenet tényleg a
            Telegramtól jön, és nem valaki más próbál agent-futást indítani nálunk.
          </p>

          {registered && bot ? (
            <div className="rounded-md border border-line/60 bg-panel/40 p-3 text-xs text-ink-soft">
              <p className="text-ink">
                Regisztrálva: <strong>{bot.name}</strong>
                {bot.botUsername ? (
                  <>
                    {' '}· <code className="rounded bg-panel/60 px-1">@{bot.botUsername}</code>
                  </>
                ) : null}{' '}
                · {bot.status === 'active' ? 'aktív' : 'kikapcsolva'}
              </p>
              <p className="mt-1">
                Hozzáférési kulcs: {bot.hasAccessKey ? 'beállítva' : 'HIÁNYZIK'} · Webhook titkos
                fejléc: {bot.hasWebhookSecret ? 'beállítva' : 'HIÁNYZIK'}
              </p>
              <p className="mt-1">
                A titok-mezőket csak akkor töltsd ki, ha <strong>cserélni</strong> akarod a kulcsot —
                üresen hagyva a jelenlegi marad érvényben. A nevet és a felhasználónevet bármikor
                átírhatod.
              </p>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-ink-soft">
              A bot neve (csak nálunk, azonosításra)
              <input
                value={name}
                disabled={!canEdit || pending}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-line/60 bg-panel/40 px-3 py-1.5 text-sm text-ink disabled:opacity-50"
              />
            </label>
            <label className="text-xs text-ink-soft">
              Bot felhasználóneve (@ nélkül, a BotFathertől)
              <input
                value={botUsername}
                disabled={!canEdit || pending}
                placeholder="cegem_agent_bot"
                onChange={(e) => setBotUsername(e.target.value)}
                className="mt-1 w-full rounded-md border border-line/60 bg-panel/40 px-3 py-1.5 font-mono text-sm text-ink disabled:opacity-50"
              />
            </label>
            <label className="text-xs text-ink-soft">
              Hozzáférési kulcs (BotFather-token)
              <input
                type="password"
                value={accessKey}
                disabled={!canEdit || pending}
                placeholder={registered ? '•••••• (üresen hagyva marad a jelenlegi)' : '123456:ABC-DEF…'}
                autoComplete="new-password"
                onChange={(e) => setAccessKey(e.target.value)}
                className="mt-1 w-full rounded-md border border-line/60 bg-panel/40 px-3 py-1.5 font-mono text-sm text-ink disabled:opacity-50"
              />
            </label>
            <label className="text-xs text-ink-soft">
              Webhook titkos fejléc (saját, hosszú véletlen szöveg)
              <input
                type="password"
                value={webhookSecret}
                disabled={!canEdit || pending}
                placeholder={registered ? '•••••• (üresen hagyva marad a jelenlegi)' : 'pl. 32 véletlen karakter'}
                autoComplete="new-password"
                onChange={(e) => setWebhookSecret(e.target.value)}
                className="mt-1 w-full rounded-md border border-line/60 bg-panel/40 px-3 py-1.5 font-mono text-sm text-ink disabled:opacity-50"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!canSave || pending}
              onClick={saveBot}
              className="rounded-md border border-coral/50 bg-coral/10 px-4 py-1.5 text-sm text-coral-deep transition hover:bg-coral/20 disabled:opacity-50"
            >
              {registered ? 'Beállítások mentése' : 'Bot regisztrálása'}
            </button>
            {registered && canEdit ? (
              <button
                type="button"
                disabled={pending}
                onClick={toggleStatus}
                className="rounded-md border border-line/60 bg-panel/40 px-4 py-1.5 text-sm text-ink-soft transition hover:border-line disabled:opacity-50"
              >
                {bot?.status === 'active'
                  ? 'Csatorna kikapcsolása (incidens-elzárás)'
                  : 'Csatorna bekapcsolása'}
              </button>
            ) : null}
          </div>

          {!setup.botUsernameConfigured ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-ink-soft">
              <p className="font-medium text-ink">Hiányzik a bot felhasználóneve</p>
              <p className="mt-1">
                Az összekötő link jelenleg a{' '}
                <code className="rounded bg-panel/60 px-1">{setup.botUsername}</code> helykitöltő
                névre mutat. Ha így hagyod, a felhasználók a „Telegram összekötése&rdquo; gombra
                kattintva <strong>rossz vagy nemlétező bothoz</strong> jutnak. Írd be a BotFathertől
                kapott felhasználónevet (@ nélkül) fent, és mentsd el.
              </p>
            </div>
          ) : (
            <p className="text-xs text-ink-soft">
              Az összekötő link innen épül:{' '}
              <code className="rounded bg-panel/60 px-1">
                https://t.me/{setup.botUsername}?start=…
              </code>
            </p>
          )}
        </Step>

        <Step index={3} title="Kösd be a webhookot a Telegramnál" done={Boolean(check?.webhookMatches)}>
          <p className="text-xs text-ink-soft">
            Ezzel mondjuk meg a Telegramnak, hogy a botnak írt üzeneteket <em>hova</em> küldje.
            E nélkül a bot létezik, de egyetlen üzenetet sem ad át nekünk — a felhasználó ír, és
            soha nem kap választ. A gomb a titkos fejlécet is átadja, hogy a beérkező üzeneteket
            fel tudjuk ismerni.
          </p>
          <p className="text-xs text-ink-soft">
            Cél-cím: <code className="break-all rounded bg-panel/60 px-1">{setup.webhookUrl}</code>
          </p>
          {!setup.webhookUrlConfigured ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-ink-soft">
              <p className="font-medium text-ink">Hiányzik a platform publikus webcíme</p>
              <p className="mt-1">
                A <code className="rounded bg-panel/60 px-1">NEXT_PUBLIC_APP_URL</code> nincs
                beállítva, ezért nem tudjuk megmondani a Telegramnak, hova küldje az üzeneteket.
                A Telegram csak <strong>kívülről elérhető HTTPS-címre</strong> kézbesít — fejlesztői
                gépen ez általában nem teljesül.
              </p>
            </div>
          ) : null}
          <button
            type="button"
            disabled={!canEdit || pending || !registered || !setup.webhookUrlConfigured}
            onClick={install}
            className="rounded-md border border-coral/50 bg-coral/10 px-4 py-1.5 text-sm text-coral-deep transition hover:bg-coral/20 disabled:opacity-50"
          >
            Webhook bekötése most
          </button>
        </Step>

        <Step index={4} title="Ellenőrizd, hogy tényleg működik" done={Boolean(check?.reachable && check?.webhookMatches)}>
          <p className="text-xs text-ink-soft">
            Megkérdezzük magát a Telegramot: válaszol-e a bot, és a mi címünkre küldi-e az
            üzeneteket. Így nem kell kitalálni, hogy jó-e a beállítás.
          </p>
          <button
            type="button"
            disabled={pending || !registered}
            onClick={verify}
            className="rounded-md border border-line/60 bg-panel/40 px-4 py-1.5 text-sm text-ink-soft transition hover:border-line disabled:opacity-50"
          >
            {pending ? 'Ellenőrzés…' : 'Kapcsolat ellenőrzése'}
          </button>

          {check ? (
            <div className="space-y-1 rounded-md border border-line/60 bg-panel/40 p-3 text-xs">
              {!check.reachable ? (
                <p className="text-coral-deep">
                  A bot nem válaszol. A leggyakoribb ok, hogy a megadott hozzáférési kulcs nem
                  helyes, vagy a hivatkozott titok nem oldható fel.
                </p>
              ) : (
                <>
                  <p className="text-ink">
                    A bot válaszol{check.botUsername ? ` — @${check.botUsername}` : ''}.
                  </p>
                  {check.webhookMatches ? (
                    <p className="text-emerald-600">
                      A Telegram a mi címünkre küldi az üzeneteket. A csatorna üzemkész.
                    </p>
                  ) : (
                    <p className="text-coral-deep">
                      A Telegram jelenleg{' '}
                      {check.webhookUrl
                        ? <>a(z) <code className="break-all">{check.webhookUrl}</code> címre küld</>
                        : 'sehova nem küld'}
                      , nem hozzánk. Futtasd a 3. lépést.
                    </p>
                  )}
                  {check.botUsername && !check.usernameMatches ? (
                    <p className="text-coral-deep">
                      A beállított felhasználónév (<code>{setup.botUsername}</code>) nem egyezik a
                      valódival (<code>{check.botUsername}</code>) — az összekötő link rossz botra
                      mutat. Javítsd a felhasználónevet a 2. lépésben.
                    </p>
                  ) : null}
                  {check.pendingUpdateCount ? (
                    <p className="text-ink-soft">
                      {check.pendingUpdateCount} üzenet vár feldolgozásra a Telegram oldalán —
                      ez torlódásra utal.
                    </p>
                  ) : null}
                  {check.lastErrorMessage ? (
                    <p className="text-ink-soft">
                      A Telegram utolsó kézbesítési hibája: {check.lastErrorMessage}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </Step>

        {message ? (
          <p className={`text-xs ${message.tone === 'ok' ? 'text-emerald-600' : 'text-coral-deep'}`}>
            {message.text}
          </p>
        ) : null}

        {!canEdit ? (
          <p className="text-[11px] text-ink-faint">
            A csatorna beüzemeléséhez platform-admin jogosultság kell.
          </p>
        ) : null}
      </div>
    </Card>
  )
}

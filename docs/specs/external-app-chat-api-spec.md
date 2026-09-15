# Feature-spec — Beágyazott agent-chat: a platform chat-ablaka idegen alkalmazásból (CRM és mások)

**Verzió:** 0.2 (a v0.1 „API-kulcsos külső csatorna" vitaanyag grill-ülés utáni átírása)
**Dátum:** 2026-09-15
**Státusz:** döntött — implementálható (v1 = A-út); az API-út halasztott alternatíva (§9)
**GitHub issue:** #481
**Kapcsolódik:** #70 (Telegram-csatorna), #52/#80 (agent-láthatósági gráf), #97 (trust-envelope), #59–#67 (forduló ellenállóság), #355 (agent-sáv shell), #411 (jóváhagyás-kártya tartalma)

## 0. Vezetői döntés

**A cél:** egy másik alkalmazásban (első: a CRM, de **bármely** app ugyanígy) megjelenhessen a platform chat-ablaka, és a felhasználó ott beszélgethessen egy kiválasztott agenttel. Az agent a saját connectorán (`http_api`/MCP) ír vissza az appba — az nem része ennek a specnek.

**A döntés:** nem API-t építünk, hanem **beágyazható platform-chatet külön ablakban** (A-út). Az app egy gombbal `window.open`-nel megnyitja a platform csupasz chat-route-ját; a Clerk-session első-fél sütiként működik; a kontextust `postMessage` viszi. Nincs új hitelesítés, nincs kulcs, nincs új futásidő, nincs app-oldali chat-UI.

**Miért nem iframe:** a platform és a beágyazó appok **nem** egy registrable domain alatt futnak. Idegen domainű iframe-ben a Safari/Chrome nem küldi a platform Clerk-sütijét; a Clerk hivatalosan nem támogatja a cross-site iframe-et; az `AgentChatPanel` 9 server-action modulra + 4 fetch-re épül, mind sütis auth-tal. Token-átadásos iframe = a panel auth-vezetékének átírása és a webes panel kettéválása (4–5 nap, tartós dupla-karbantartás). Elvetve.

**Miért nem az API-út (v0.1):** ~7 nap platform-munka + minden beágyazó app saját chat-UI-t, jóváhagyás-kártyát, link-flow-t ír. Az A-út 1 nap, és appokként egy gomb. Az API-út **megmarad tartaléknak** (§9), ha in-page UI kötelezővé válik vagy nem-platformos user is jön.

**Rögzített elvek:**
- Semmi app-specifikus a kódban. A CRM = az első allowlist-bejegyzés, nem különleges eset.
- Aki idegen appból használja a platformot, annak **platform-fiókja van** (Clerk). Az app saját belépési módja lényegtelen.
- A bizalmi osztály a bejárattól nem függ: ugyanaz az ember, ugyanaz az agent, ugyanazok a kapuk (következmény-kapu, érzékenységi router, keret, egress), mint a weben.
- Egy user = egy tenant (`User.tenantId`) — az allowlist-feloldás egyértelmű.

## 1. Scope

### 1.1 In scope — v1
- `ChannelType` += `embedded_app`.
- `/embed/agents/[agentId]?app=<slug>&thread=<id>` csupasz chat-route (shell nélkül).
- `postMessage` szerződés (kontextus-átadás, origin-ellenőrzés).
- Tenant-beállítás: „Beágyazó alkalmazások" allowlist (`Tenant.settings.embedApps`) + oldal.
- Kijelentkezett állapot kezelése az embed-ablakban.
- Az embedből nyitott beszélgetés a webes listában is látszik.
- Költség: mérhetőség a `channel` alapján (keret nélkül).
- Integrációs függelék: a beágyazó app 10-soros JS-példája.

### 1.2 Out of scope
- Cross-site iframe (sem süti-kerülővel, sem token-átadással).
- API-kulcsos külső csatorna, link-token, `/api/ext/*`, OpenAPI — §9 halasztott.
- Megosztott (per-ügy, több-useres) szál.
- Névtelen / nem tenant-tag chatbot.
- Proaktív app-felé értesítés.
- Kontextus perzisztálása a beszélgetésre.

## 2. Mai állapot (kódból)

| Építőelem | Hol | Újrahasznosítás |
|---|---|---|
| Chat-panel | `components/agents/agent-chat-panel.tsx` | változatlan; az embed-route rendereli |
| Forduló-bemenet | `agentChatStreamTurnInputSchema`, `briefing { goal, source, constraint, approval }` | a kontextus a `briefing.source`-ba megy |
| Beszélgetés-csatorna | `Conversation.channel`, `channelExternalId` | enum bővül |
| Tenant-beállítás | `Tenant.settings Json` | `embedApps` lista, tábla nélkül |
| Clerk-védelem | `src/proxy.ts` `clerkMiddleware` | az embed-route védett, nem public |
| Sandbox-CSP minta | `lib/sandbox-csp.ts` `frame-ancestors` | az embed-route `frame-ancestors 'none'` |
| Trust-envelope | #97 `EXTERNAL_UNTRUSTED_DATA` | a kontextus burkolata |

**Ami nincs:** csupasz chat-route; `embedded_app` csatorna; origin-allowlist beállítás és oldal; `postMessage`-kezelő.

## 3. Döntések

### D1 — Külön ablak, nem iframe
Az app `window.open('<platform>/embed/agents/<agentId>?app=<slug>&thread=<id>', 'eai-chat', 'popup,width=…')`. Top-level böngésző-kontextus → a Clerk-süti első-fél, a meglévő panel és minden server-action változatlanul működik. Az embed-route válasza `Content-Security-Policy: frame-ancestors 'none'`.

### D2 — Az appot a `?app=<slug>` azonosítja
A slug a tenant allowlist-bejegyzés kulcsa. Ismeretlen slug vagy üres allowlist → 404. A slug per-user szál-kulcs; hamisítása csak a saját beszélgetéseit keveri — nincs bizalmi következmény (a `postMessage` origin ettől függetlenül ellenőrzött, D4).

### D3 — Szál = per-user beszélgetés
`Conversation { channel: embedded_app, channelExternalId: "<slug>:<thread>", createdById: user }`. Ha van, folytatódik; ha nincs, létrejön. Cím: `"<app-név> · <thread>"`, amíg a user/agent nem ad mást. **Nincs** megosztott szál: két user ugyanarra az ügyre két beszélgetést kap (a webes modell változatlan). A webes agent-listában ugyanez a sor látszik — „egy beszélgetés, több nézet".

Részleges egyedi index: `(channel, channel_external_id, created_by_id) WHERE channel = 'embedded_app'`.

### D4 — `postMessage` szerződés
- embed → opener: `{ type: 'eai:ready' }` betöltéskor (`targetOrigin` = az allowlist-bejegyzés originje).
- opener → embed: `{ type: 'eai:context', label: string, data: Record<string, unknown> }`, max 8 kB. Az embed csak az allowlist originjéről fogad (`event.origin` ellenőrzés); hibás origin némán eldobva.
- A kontextus a stream-API külön `embeddedContext { appSlug, label, data }` mezőjén megy, **nyersen**; a **szerver** ellenőrzi a slugot az allowlisten és a 8 kB-ot, majd `<<<EXTERNAL_UNTRUSTED_DATA source="embedded_app:<slug>">>>` burkolattal (#97) a modell-prompt elé fűzi (`latestUserTextOverride`, mint a `/slash` skill-feloldás). *(Implementációs korrekció: a `briefing.source` út nem jó — a `taskBriefing` csak ticket-promóciókor ér a modellhez, a `content` pedig perzisztálódik.)* Az opener bármikor küldhet újat; minden ezután küldött forduló azt viszi. **Nem perzisztált**: a weben folytatva nincs kontextus — rendben, az agent a connectorán lekéri.
- Indok az „untrusted"-re: az app rekordjaiban ügyfél által írt szöveg van; a mellékhatásos tool utána a következmény-kapura esik — kívánt viselkedés.

### D5 — Kijelentkezett állapot
Nincs Clerk-session → az embed-route egy állapot-komponenst mutat: *„A beszélgetéshez jelentkezz be a platformra"* + gomb → sign-in (ugyanabban az ablakban, `redirect_url` vissza az embed-URL-re). Nincs beágyazott sign-in.

### D6 — Jóváhagyás, connector-grant, Stop, reconnect
Semmi új: a panel kártyái. A chat-jóváhagyás **önjóváhagyás** (`assertActorCanDecide` = beszélgetés-hozzáférés + agent elérhető a tenantból), mint a weben — a v0.1 D5 „SoD" állítása téves volt; SoD csak a ticket-úton van. A connector-grant OAuth-popup top-level ablakból működik.

### D7 — Allowlist tárolás és UI
`Tenant.settings.embedApps: [{ slug, name, origin }]`. Oldal `/control-plane/embed-apps` („Beágyazó alkalmazások", a Menü-hozzáférés mellett): lista, hozzáadás (név, origin, slug automatikusan a névből), törlés. Tenant-admin szerkeszti. **Üres lista = az embed-route zárva** a tenantnak — külön kill-switch nincs. Audit: `embed.app.changed { actor, slug, change }`.

Üres állapot szövege (NFR közérthető UI): *„Itt engedélyezheted, hogy egy másik rendszered — például a CRM — a saját felületéről nyisson beszélgetést az agenteiddel. Add meg a rendszer nevét és a címét (origin); a felhasználók a platform-fiókjukkal lépnek be."*

### D8 — Költség
Mérés a `Conversation.channel = embedded_app` alapján; alkeret nincs. Ha a számla indokolja, később.

### D9 — Agent-választás és láthatóság
Az agent az URL-ben fix (az app dönti, melyikhez nyit). Láthatóság = a meglévő webes gráf (#52/#80); idegen tenant agentje → 404 (ne szivárogjon a létezés).

## 4. Folyamatok

**Bekötés (egyszer, appónként):** tenant-admin felveszi az appot (név, origin) → kap egy slugot → az app fejlesztője beteszi a gombot (§8 példa).

**Használat:** user az appban kattint → `window.open` embed-URL → (nincs session: D5) → panel betölt → `eai:ready` → app `eai:context` → user ír → forduló a kontextussal → agent connectoron dolgozik → jóváhagyás-kártya ugyanott → válasz. Ablak bezárva; újranyitva ugyanaz a szál folytatódik (D3).

**Incidens:** app-bejegyzés törlése → a slug 404; üres lista → tenant-szinten zárva.

## 5. Adatmodell

```
enum ChannelType { telegram, embedded_app }
-- Tenant.settings.embedApps: [{ slug, name, origin }]   (Json, nincs új tábla)
-- Conversation: részleges egyedi index (channel, channel_external_id, created_by_id) WHERE channel='embedded_app'
```

## 6. Munkacsomagok

| WP | Tartalom | Becslés |
|---|---|---|
| WP-1 | Enum + index migráció; `embedApps` olvasó/író a tenant-beállításban; audit-esemény | 0,25 nap |
| WP-2 | `/embed/agents/[agentId]` route + layout (shell nélkül), slug/thread feloldás, beszélgetés-keresés/létrehozás, `frame-ancestors 'none'`, kijelentkezett állapot | 0,5 nap |
| WP-3 | `postMessage` kezelő a panel körül; kontextus → `embeddedContext`, szerveroldali burkolat; méret-kapu | 0,25 nap |
| WP-4 | `/control-plane/embed-apps` oldal | 0,5 nap |
| WP-5 | Integrációs függelék (§8) + tesztek | 0,25 nap |
| WP-6 | CRM-oldali gomb — **külön issue a CRM-repóban** | külön |

**Elfogadás (tesztek):** ismeretlen slug → 404; üres allowlist → 404; idegen tenant agentje → 404; nincs session → bejelentkezés-állapot; ugyanaz a `thread` két usertől két beszélgetés, ugyanattól a usertől ugyanaz; `eai:context` rossz originről eldobva; jó originről a következő forduló modell-promptja burkolva tartalmazza (a szerver burkol; nem engedélyezett slug → 403); 8 kB felett elutasítva; a beszélgetés a webes listában látszik `"<app> · <thread>"` címmel; embed-válasz fejlécében `frame-ancestors 'none'`; `embed.app.changed` audit íródik.

## 7. Nyitott kérdések
Nincs — a 2026-09-15-i grill-ülés minden ágat lezárt. Változás esetén §9.

## 8. Függelék — a beágyazó app kódja (bármely app)

```js
const PLATFORM = 'https://<platform-origin>'
const win = window.open(
  `${PLATFORM}/embed/agents/${agentId}?app=crm&thread=${encodeURIComponent(dealId)}`,
  'eai-chat', 'popup,width=480,height=720')
window.addEventListener('message', (e) => {
  if (e.origin !== PLATFORM || e.data?.type !== 'eai:ready') return
  win.postMessage({ type: 'eai:context', label: 'Megnyitott ügy', data: deal }, PLATFORM)
})
```

## 9. Halasztott alternatíva — API-kulcsos külső csatorna (a v0.1 lényege)

**Mikor kell mégis:** (a) in-page chat-UI kötelező egy appban; (b) nem platformos user is chatelne; (c) nem böngészős kliens.

**Mi lenne (a v0.1 D1–D9 a grill korrekcióival):** `external_app` csatorna; tenant-kötésű `ExternalApp` + rotálható `ExternalAppKey` (`eai_app_…`, lookup-hash + bcrypt, max 2 aktív); `Authorization: Bearer` + `X-External-User-Id`; ember-kötés a meglévő link-token folyamattal (`ChannelIdentity`); hozzáférés = platform-hozzáférés ∩ kulcs `allowedAgentIds`; **csak JSON + `GET /turns/{turnId}` poll** (SSE nem — a kulcs szerveroldali, az app-backendek tipikusan nem proxyznak streamet); `context` untrusted burkolattal; **önjóváhagyás** a chat-jóváhagyáson (nem SoD); `memory_candidate`/`thinking`/`activity` esemény kihagyva; admin-kulcsoldal; OpenAPI + útmutató. Becslés ~7 nap + appokként saját UI. A jelen v1 semmit nem dob el belőle: az `embedApps` allowlist és az embed-route a link-token megerősítő oldalhoz is kell.

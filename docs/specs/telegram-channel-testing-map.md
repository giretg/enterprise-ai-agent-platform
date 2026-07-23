# Telegram-csatorna — Testing Decisions 1–22 lefedettségi térkép (#70 → #78)

**Cél:** a #70 feature-spec *Testing Decisions* szakaszának 22 varrat-esetét egy helyen
összevezetni a tényleges tesztekkel — hogy a #78 (üzemeltetés: metrikák + megőrzési takarítás)
záró ticketnél látszódjon, melyik eset **lefedett**, és melyik **hivatkozott regresszióként** egy
megelőző (vagy még nyitott) ticketből.

A varrat elve változatlan (#70): **egy** varrat, a csatorna-szolgáltatás befecskendezett
kimenetén; a teszt hatást ér a szolgáltatáson (bármelyik bejáraton), és a **rögzített kimenő
hívásokat** és **audit-bejegyzéseket** nézi — sosem hív külön belső ellenőrzőt.

## Jelmagyarázat

- ✅ **Lefedett** — van rá varrat-teszt ebben a repóban (a hivatkozott `npm` szkripttel futtatva).
- 🔗 **Regresszió** — egy korábbi slice tesztje fedi (a #78 nem duplikálja).
- ⏳ **Függőben** — a futásidő-szeletet egy még nyitott, a #78-at **blokkoló** ticket hozza
  (#74 admin agent-engedélyek + chat-forduló futásidő, #76 eseményvezérelt jóváhagyás,
  #77 proaktív értesítés). A séma és az audit-katalógus már ma viszi; a viselkedés-teszt a
  megfelelő slice-szal érkezik. Itt **explicit regresszió-hivatkozásként** soroljuk fel, a #78
  AC-nek megfelelően („lefedettek vagy explicit regresszióként hivatkozottak").

| # | Testing Decision (#70) | Állapot | Fedő teszt / hivatkozás |
|---|---|---|---|
| 1 | Identitás fail-closed: ismeretlen küldő → futásidő nem hívódik, egy semleges válasz, aztán csend | 🔗 | `test:channel-linking` (CL — bekötetlen egyszeri semleges válasz + némítás); a futásidő itt szerkezetileg nem is hívódik |
| 2 | Szervezeti határ: más szervezet agentjéhez nincs hozzáférés | ⏳ #74 | A szervezet a tokenből rögzül (`test:channel-linking`); az agent-metszet érvényesítése a #74 futásidő |
| 3 | Szerepkör élő feloldása: visszavont tagság/szerepkör azonnal hat | 🔗 / ⏳ #74 | Visszavonás azonnali fail-closed: `test:channel-linking` (CL visszavonás). Üzenetenkénti szerepkör-feloldás: #74 |
| 4 | Superadmin-korlát: „szervezet felvétele" Telegramon nem érvényesül | 🔗 | Szerkezeti (D2): a szervezet a tokenből jön, nincs kódút a váltásra — `test:channel-linking` (a kötés a token szervezetére szól) |
| 5 | Titkos fejléc: hibás/hiányzó → nincs feldolgozás, nincs kimenő hívás | 🔗 | `test:channel-linking` (CL bad_secret — konstans idejű vetés a szolgáltatásban) |
| 6 | Duplikáció: azonos update_id kétszer → egy forduló, egy kimenő üzenet | 🔗 | `test:channel-linking` (CL duplikáció-vízjel) |
| 7 | Összekötés: érvényes token → kötés + értesítés; lejárt/elhasznált/hamis → nincs kötés, érthető üzenet | 🔗 | `test:channel-linking` (CL link-flow összes ága) |
| 8 | Visszavonás → azonnali fail-closed | 🔗 | `test:channel-linking` (CL visszavonás, saját + admin) |
| 9 | Agent-metszet: platformon elérhető ⊗ Telegramra engedélyezett | ⏳ #74 | Az agent-engedély (grant) séma megvan; a metszet-érvényesítés a #74 futásidő |
| 10 | Címkézés: minden kimenő válasz tartalmazza az agentet és a projektet | ⏳ #74 | A bekötött chat-forduló kimenő útja a #74 slice |
| 11 | Gördülő beszélgetés: 24 órán belül ugyanaz, utána új (saját megőrzési határidővel) | ⏳ #74 | `channel_sessions.last_activity_at` megvan; a gördülés a #74 futásidő |
| 12 | Projekt-hatókör: a forduló a grant projektkulcsával fut | ⏳ #74 | A grant `project_key` séma megvan; a futtatás a #74 slice |
| 13 | Érzékenységi kapu: tiltott/érzékeny válasz nyers szövege sehol a kimenő hívásokban | ⏳ #74/#75 | A `channel.message.blocked` audit-akció megvan; a kimenő kapu a chat-forduló slice |
| 14 | Jóváhagyás — kapuk külön-külön (nem-jogosult / saját kérés / visszavont jog / visszajátszás / már eldöntött) | ⏳ #76 | Eseményvezérelt jóváhagyás gombokkal — #76 |
| 15 | Gombok jogosultság-tudata | ⏳ #76 | #76 |
| 16 | Kettős koppintás → nyugtázás, nem hiba, nincs kettős hatás | 🔗 / ⏳ #76 | **Összekötési** kettős koppintás idempotens sikere: `test:channel-linking` (CL). **Jóváhagyási** kettős koppintás: #76 |
| 17 | Eseményvezérelt kiváltás: `awaiting_human` → azonnali értesítés | ⏳ #76 | #76 |
| 18 | Darabolás: hosszú válasz több érvényes üzenetre, sorrendhelyesen | ⏳ #74 | Kimenő chat-út — #74 |
| 19 | Proaktív értesítés: nem regisztrált címzett → nincs küldés; küldési hiba → a Monitor-futás nem bukik | ⏳ #77 | #77 |
| 20 | Bot letiltva: letiltás után a küldés abbamarad, a kötés jelölődik | 🔗 / ⏳ #74 | A letiltás **detektálása** (`blocked_by_user`): `test:channel-transport` (CT). A kötés jelölése + küldés-leállítás a küldő-út slice (#74) |
| 21 | Worker-tartósság: a forduló-sor megmarad és újrapróbálható | ⏳ #74 | A `channel_turns` sor-séma megvan; a worker második munkatípusa a #74 slice. (A #78 megőrzési takarítója maga is sor-alapú, újrapróbálható — l. CR-4) |
| 22 | Audit: minden eset determinisztikus, **álnevesített** azonosítójú audit-bejegyzést ír | ✅ | **#78 új:** `test:channel-retention` (CR-1 — a takarítás álnevesített, nyers chat id nélküli auditja; CR-5 összegző). **Regresszió:** `test:channel-linking` (minden CL-hatás álnevesített audit). A `pseudonymFromLookupHash` / `pseudonymFromExternalThreadId` egy helyen tartja az álnevesítést |

## A #78 által ADOTT új lefedettség (üzemeltetés)

A #78 két új üzemeltetői képességet hoz, saját varrat-tesztekkel:

- **Forgalmi és hibametrikák** (story 59) — `test:channel-metrics` (CM-0…CM-6): a metrika az
  audit-akció-számokból és a csatorna-táblák aggregátumaiból áll össze, időablakkal, a bot
  állapotával; hiányzó akció 0 (nem hiba); a külső azonosítók az audit-forrásban is álnevesítve.
- **Megőrzési takarítás** (D4) — `test:channel-retention` (CR-1…CR-7): a bot a horizonton túl
  törli a **saját** kimenő üzeneteit a `deleteMessage`-dzsel a közös kimenő átvitelen; idempotens
  (a provider szerint már nem létező üzenet takarítottnak jelölődik), az átmeneti hiba
  újrapróbálható, és minden törlés **álnevesített** auditot ír (nyers chat id / tartalom sehol).

## NFR-1 (közérthető magyar)

Minden #78-ban bevezetett felhasználó-/üzemeltető-felé látszó szöveg hétköznapi magyar,
önmagát magyarázó: az üzemeltetői panel címkéi (Forgalom / Hibák / Pillanatnyi állapot), a
takarítás-gomb és a visszajelzései, valamint a server-action hibaüzenetei. A csatorna korábbi
bot-üzenetei (összekötés, elutasítás, semleges válasz) változatlanul magyarok (#72).

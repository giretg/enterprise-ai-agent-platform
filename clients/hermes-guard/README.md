# Excellence Hermes gép-padló

A munkatárs gépére kerülő, rendszergazdai Hermes-beállítás. A munkatárs a saját Hermes-konfigjából nem tudja kikapcsolni a céges modell-utat és a Guardot. A finomabb, asszisztensenkénti engedélyt a Guard dönti el; ide csak az kerül, ami a munkatárs egyik asszisztensénél sem engedett.

## Telepítés (ez kell az adminnak)

1. A Control Plane **Első lépések** oldalán, a Hermes Desktop Enterprise kártyán válaszd ki a munkatársat.
2. Kattints a **Telepítő letöltése** gombra. Egyetlen kis fájl jön (`excellence-telepito.sh`), benne a gép beállítása és a Guard.
3. Másold a fájlt a munkatárs Macjére, nyisd meg a Terminált a fájl mappájában, és futtasd:

```
sudo bash excellence-telepito.sh
```

4. Indítsd újra a Hermest. A munkatárs az Első lépések további pontjai szerint köti be a Botokat.

Macen és Linuxon működik. A natív Windows Hermesnek még nincs céges telepítője (#755): a Hermes managed könyvtára POSIX-első, a padló Unix-útvonalakat hash-el.

Ugyanez a gomb a **Hermes céges kontroll** oldalon a munkatárs sorában is ott van. A telepítő újrafuttatható: engedélybővítés után töltsd le újra, és futtasd megint. Az `installId` ugyanaz marad.

Adj a munkatársnak hozzáférést legalább egy éles AI-munkatárshoz, mielőtt telepítesz; üres hozzáférésnél a gép minden helyi műveletet tilt.

## Céges kontroll az adminfelületről

1. **Adminisztráció → Hermes céges kontroll**: céges alap (Kötött pálya / Standard / Szabad), munkatársi preset és képességenkénti kivételek. A céges alapnál lazább kivételhez külön megerősítés és auditbejegyzés kell.
2. Az **AI-munkatárs adatlap → Eszközök** részen állíts képesség-plafont. A tényleges jog a munkatárs engedélyének és az agent plafonjának metszete.
3. Töltsd le és futtasd a telepítőt (fent).
4. A munkatárs újraindítja a Hermest, bejelentkezik az Excellence MCP-kapcsolatra és Botot választ.
5. Ellenőrizzétek az alábbi átvételi eseteket, utána terítsétek a gépi csomagot központilag.

Mentéskor verzió nő, és a beállítás az auditnaplóval egy tranzakcióban kerül mentésre. Más admin közben történt módosítását a szerver nem írja felül. Visszavonás a következő kérésnél, engedélybővítés legkésőbb a következő sessionben érvényes. Ha a korábbi gépi csomag letiltotta a most engedélyezett funkciót, új csomag telepítése is kell. A letöltés új elvárt hash-t adhat: a régi, eltérő csomag ezután nem kap céges modellválaszt a telepítésig.

Szerveroldalon szükséges a `MODEL_GATEWAY_JWT_KEY` (külön, legalább 32 véletlen karakteres Secret Manager kulcs) és a kapcsolódó adatbázis-migrációk: lásd [DEPLOY.md](../../DEPLOY.md). Kulcs nélkül a token-csere elutasít.

## Fejlesztői letöltés

Admin, a szervezetben:

```
GET /api/client-policy/machine-floor?userId=<a munkatárs azonosítója>
GET /api/client-policy/machine-floor?userId=<id>&format=installer
```

A JSON válaszban benne van a `config.yaml`, a `.env`, az `excellence-install-id` és a `managedDirHash`. Az `installer` formátum egy futtatható scriptet ad, padlóval és Guarddal együtt.

Ha a scriptet erről a mappáról futtatod (sudo):

```
sudo ./install-managed.sh floor.json
```

Amit feltesz:

| Hova | Mi | Jog |
|---|---|---|
| `/etc/hermes/config.yaml`, `.env`, `excellence-install-id` | a letöltött padló | root, könyvtár 0755, fájl 0644 |
| `/opt/excellence/bin/exc-token` | rövid életű modell-token | root, 0755 |
| `/opt/excellence/bin/exc-guard` | shell-hook tartalék (V1-6) | root, 0755 |

A végén, ha a `hermes` parancs elérhető, lefut a `hermes config`. A managed kulcsokat onnan kell látni; a `hermes config set` ezekre „managed, cannot be changed” választ ad.

## Hova kerül a Guard plugin

2026-10-03, a Hermes forrásából (`NousResearch/hermes-agent` main). A plugin-felderítési útvonal a forrás alapján rögzítve; a CLI managed konfigurációja a helyben telepített Hermes `6ec05205` runtime-ján, elkülönített profillal is ellenőrizve (spec §12). Desktop- és gateway-forgalmi mérés még nincs.

Az általános plugin innen töltődik, ha a neve szerepel a `plugins.enabled` listában:

- `$HERMES_HOME/plugins/<név>/plugin.yaml`
- alapértelmezés: `~/.hermes/plugins/excellence-guard/`
- Desktop-profil: `~/.hermes/profiles/<profil>/plugins/excellence-guard/` (profilonként saját `HERMES_HOME`)

A `HERMES_BUNDLED_PLUGINS` a beépített pluginkönyvtárat cseréli, nem egészíti ki, ezért a telepítő nem nyúl hozzá.

A telepítő a plugin-könyvtárat (`excellence-guard/plugin.yaml`) bemásolja a kanonikus `/opt/excellence/hermes-plugins/excellence-guard/` alá, és a sudozó user `~/.hermes` profiljaiba. A home könyvtár a useré, ezért a fájlt ki tudja törölni. A `plugins.enabled` és a `hooks.pre_tool_call` pinjét nem: azok az `/etc/hermes`-ben vannak, a `hermes config set` elutasítja. A hook `fail_closed`: ha az `exc-guard` hiányzik, timeoutol vagy hibázik, a tool nem fut le.

A telepítő hiányzó Guard- vagy token-segéd esetén megáll, mielőtt a padlót módosítaná. A letöltött csomag hash-ét és kötelező mezőit ellenőrzi; hibás csomag nem írja felül a meglévő beállításokat. Új Desktop-profil létrehozása után futtasd újra, hogy a Guard abba a profilba is bekerüljön.

## Átállás: a laptopokon tárolt kulcsok

A managed `.env` üresre állítja az ismert szolgáltatói kulcsokat (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, és a többi a generátor listájában). Ettől a Hermes nem tud kimenni a céges átjáró mellett. A kulcs a szolgáltatónál ettől még él.

Telepítés előtt vagy közvetlenül utána vond vissza (rotáld) azokat a kulcsokat, amelyek eddig a laptop `~/.hermes/.env` fájljában vagy a Hermes kulcstárában voltak. A céges modellkulcs csak az Excellence Model Gateway-en marad. A Hermes managed env csak a Hermes folyamatát érinti, a gép többi programjának kulcsát nem törli.

## Érvényesítés és az első verzió korlátai

- A Model Gateway friss heartbeatet, a session agenthez kötött regisztrációját és a szerver által kiadott gépi csomag hash-egyezését ellenőrzi. Nem kiadott vagy eltérő csomag = nincs céges modellválasz.
- A shell-hook minden tool előtt friss szerver-policyt kér; a munkatárs által írható snapshot-cache nem adhat engedélyt. A profilt a root által telepített modellútvonalhoz ellenőrzi. Elérhetetlenségkor Kötött pálya, visszavonáskor teljes tiltás érvényes.
- Az e-mail és az e-mail-fejlécből megismert név kitakarható és visszaállítható. Más **felismert** adattípusnál a kitakarás egyelőre blokk. Cégnév és tetszőleges név teljes felismerése a #747 része. A `warn` csak kategóriaadatot naplóz, az `off` átenged; az agent szigorúbb szűrője mindig érvényes.
- Helyi projektírás, domain-listás böngésző és jóváhagyott helyi skill-betöltés a hiteles szerveroldali listák bekötéséig tiltott. A natív lokális memória céges memória módban tiltott; használd az Excellence MCP memóriaeszközeit. Sandbox/felhős böngésző helyi backendje külön szelet (#748/#749).
- A natív `/skill` parancs és más, tool-middleware-t megkerülő kliensútvonalak külön átvételi ellenőrzést igényelnek; a plugin önmagában nem ad teljes gépszintű kontrollt.
- A heartbeat jelenlétjelzés, nem kriptográfiai géphitelesítés. T2 kontrollhoz adminjog nélküli, MDM-mel kezelt gép és kimenő hálózati szabály kell. Adminjogú vagy saját, módosított klienssel a lokális korlátok nem bizonyíthatók; a szerveroldali vállalati hozzáférés-kontroll továbbra is érvényes.

## Átvételi ellenőrzés

- Állíts B munkatársnak sandboxos kódfuttatást, erősítsd meg a kivételt, és ellenőrizd az auditot. A helyi `terminal` továbbra is tiltott; a céges sandbox eszköz használható, ha az agent hozzáférése engedi.
- Normál és streamelt céges modellhívás, valamint MCP- és helyi tool-hívás auditja azonos user/agent/session/turn azonosítóval.
- Szolgáltatóváltás és segédhívások (tömörítés, címadás, vision) hálózati ellenőrzése: kizárólag a céges gateway.
- Guard nélküli, eltérő hash-ű vagy nem telepített kliens ne kapjon modellválaszt.
- Agent- vagy felhasználói hozzáférés visszavonása a következő hívásnál tiltson.
- Desktop-session 30 percen túl, laptop alvás/ébredés, tokenmegújítás, új Bot-profil telepítése.

2026-10-03: a helyi Hermes `6ec05205` named-provider feloldása (`excellence` → `custom`), plugin-betöltése és valós middleware-lánca ellenőrizve. Ez kompatibilitási mérés, nem éles szolgáltatói vagy teljes Desktop-session mérés.

## Hash

A `managedDirHash` a három fájl (`config.yaml`, `.env`, `excellence-install-id`) sha256-jéből áll, `excellence-managed-dir-v1` előtaggal. A Guard heartbeatje ugyanezt küldi; eltérésnél a szerver megtagadja a céges modellhívást.

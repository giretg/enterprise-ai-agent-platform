# Excellence Hermes gép-padló

A munkatárs gépére kerülő, rendszergazdai Hermes-beállítás. A munkatárs a saját Hermes-konfigjából nem tudja kikapcsolni a céges modell-utat és a Guardot. A finomabb, asszisztensenkénti engedélyt a Guard dönti el; ide csak az kerül, ami a munkatárs egyik asszisztensénél sem engedett.

## Telepítés (ez kell az adminnak)

1. A Control Plane **Első lépések** oldalán, a Hermes Desktop Enterprise kártyán válaszd ki a munkatársat.
2. Kattints a **Telepítő letöltése** gombra. Egyetlen kis fájl jön (`excellence-telepito.sh`), benne a gép beállítása és a Guard.
3. Másold a fájlt a munkatárs Macjére, nyisd meg a Terminált a fájl mappájában, és futtasd:

```
sudo bash excellence-telepito.sh
```

4. Indítsd újra a Hermest. A telepítő a látható AI-munkatársakból vékony Bot-csatlakozókat is kirak (`~/.hermes/profiles/exc-…`), és átmásolja a default profil azon Excellence MCP belépőjét, amely ugyanarra a címre mutat, mint a Bot. Ha nincs ilyen (pl. a Bot másik cégé), vagy a belépő lejárt, terminálban egyszer jelentkezz be: `hermes -p exc-<név> mcp login excellence` — ez megnyitja a böngészőt. Az asztali app „Sign in” gombja erre nem képes, mert a háttérben futó Hermes nem nyithat böngészőt. A munkatárs Bot Mode-ban nyitja meg őket; a „Töltsd le az AI munkatársaimat” mondatot ne írja be.

Macen és Linuxon a fenti `.sh` telepítőt használd; natív Windowson a PowerShell-telepítőt (lásd [Telepítés Windowson](#telepítés-windowson-755)). A Windowsos számítógépen futó WSL-ben a Linuxos telepítés érvényes.

Ugyanez a gomb a **Hermes céges kontroll** oldalon a munkatárs sorában is ott van. A telepítő újrafuttatható: engedélybővítés után töltsd le újra, és futtasd megint. Az `installId` ugyanaz marad.

Adj a munkatársnak hozzáférést legalább egy éles AI-munkatárshoz, mielőtt telepítesz; üres hozzáférésnél a gép minden helyi műveletet tilt.

## Ha egy Bot nem válaszol

A munkatárs a Hermes-hibaüzenetnél a **Részletek** gombra kattintva látja a hiba okát. Ha ott ez áll: `key_cmd for provider 'excellence' exited 1`, lejárt a Bot belépése a platformra.

1. Töltsd le és futtasd újra a legfrissebb céges telepítőt, majd a munkatárs zárja be és nyissa meg újra a Hermest.
2. Ha a hiba megmarad, léptesd be újra a Botot a saját profiljában (nem a default profilban). A `<bot-profil>` helyére a Bot mappájának neve kerül, például `exc-alfred`.

Mac / Linux (Terminál):

```sh
HERMES_HOME="$HOME/.hermes/profiles/<bot-profil>" hermes mcp login excellence
```

Windows (PowerShell):

```powershell
$env:HERMES_HOME="$env:LOCALAPPDATA\hermes\profiles\<bot-profil>"; hermes mcp login excellence
```

Ezután megnyílik a böngésző: a munkatárs jelentkezzen be, és fogadja el.

## Céges kontroll az adminfelületről

1. **Adminisztráció → Hermes céges kontroll**: céges alap (Kötött pálya / Standard / Szabad), munkatársi preset és képességenkénti kivételek. A céges alapnál lazább kivételhez külön megerősítés és auditbejegyzés kell.
2. Az **AI-munkatárs adatlap → Eszközök** részen állíts képesség-plafont. A tényleges jog a munkatárs engedélyének és az agent plafonjának metszete.
3. Töltsd le és futtasd a telepítőt (fent).
4. A munkatárs újraindítja a Hermest, Bot Mode-ban megnyit egy telepített Botot, és a böngészőben belép a platformra.
5. Ellenőrizzétek az alábbi átvételi eseteket, utána futtassátok a telepítőt a többi gépen is.

Mentéskor verzió nő, és a beállítás az auditnaplóval egy tranzakcióban kerül mentésre. Más admin közben történt módosítását a szerver nem írja felül. Visszavonás a következő kérésnél, engedélybővítés legkésőbb a következő sessionben érvényes. Ha a korábbi telepítés letiltotta a most engedélyezett funkciót, a telepítőt újra le kell tölteni és futtatni. A letöltés új elvárt azonosítót adhat: a régi, eltérő beállítás ezután nem kap céges modellválaszt a telepítésig.

Szerveroldalon szükséges a `MODEL_GATEWAY_JWT_KEY` (külön, legalább 32 véletlen karakteres Secret Manager kulcs) és a kapcsolódó adatbázis-migrációk: lásd [DEPLOY.md](../../DEPLOY.md). Kulcs nélkül a token-csere elutasít.

## Fejlesztői letöltés

Admin, a szervezetben:

```
GET /api/client-policy/machine-floor?userId=<a munkatárs azonosítója>
GET /api/client-policy/machine-floor?userId=<id>&format=installer
```

A JSON válaszban benne van a `config.yaml`, a `.env`, az `excellence-install-id`, a `managedDirHash` és a `bots[]` (vékony Hermes-profilok). Az `installer` formátum egy futtatható scriptet ad, padlóval, Guarddal és Bot-csatlakozókkal együtt. A `bots` nem része a `managedDirHash`-nek.

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

## Telepítés Windowson (#755)

**WSL:** ha a Hermes a WSL-disztribúcióban fut, ott Linuxként telepíts: alap csomag és `sudo ./install-managed.sh floor.json` a disztribúción belül. A Windows-oldali Hermes ezt nem látja.

**Natív Windows:** a csomagot `platform=windows` paraméterrel töltsd le, mert a `config.yaml` más parancsútvonalakat tartalmaz:

```
GET /api/client-policy/machine-floor?userId=<a munkatárs azonosítója>&platform=windows
```

A munkatárs gépén, „Futtatás rendszergazdaként” PowerShellből, a `clients\hermes-guard` mappából:

```
powershell -ExecutionPolicy Bypass -File .\install-managed.ps1 floor.json
```

Ha nem a bejelentkezett munkatársnak telepítesz, add meg: `-User CEG\kovacs.anna`. Ha a Python nem a `PATH`-on van: `-Python "C:\Program Files\Python312\python.exe"`. Gépszintű Python 3.8+ kell. A felhasználói mappába telepített Pythont (például a Microsoft Store-ét) a telepítő elutasítja, mert azt a munkatárs kicserélhetné.

| Hova | Mi |
|---|---|
| `C:\ProgramData\Excellence\hermes\` | `config.yaml`, `.env`, `excellence-install-id` |
| `C:\ProgramData\Excellence\bin\exc-token(.cmd)`, `exc-guard(.cmd)` | token-segéd és shell-hook tartalék; a `.cmd` a rögzített Pythont indítja `-I -X utf8` kapcsolóval |
| `C:\ProgramData\Excellence\hermes-plugins\excellence-guard\` | a Guard plugin |
| `%LOCALAPPDATA%\hermes\plugins\`, `...\profiles\*\plugins\` | a Guard plugin a munkatárs profiljaiban |
| gépszintű `HERMES_MANAGED_DIR` | `C:\ProgramData\Excellence\hermes` |

A `C:\ProgramData\Excellence` könyvtárat csak a SYSTEM és az Administrators írhatja, a Users csoport csak olvashatja. A telepítő a korábbi explicit jogokat törli. A Hermes Windowson nem keres natív managed helyet (U3), ezért a gépszintű környezeti változó mondja meg neki. A telepítő a munkatárs saját `HERMES_MANAGED_DIR` változóját törli (a bejelentkezett és a megadott profilból is), majd szól a Windowsnak, hogy az új folyamatok lássák. A munkatársnak elég bezárni és újra megnyitni a Hermest, kijelentkezni nem kell.

Ha a munkatárs később újra beállítja a saját változót, a Guard nem követi: a műveletet megállítja, a céges modell pedig nem válaszol. A Mac- és a Windows-padló hash-e egymás mellett él, az egyik letöltése a másikat nem érvényteleníti.

Élő Hermes Desktop-mérés Windowson még nincs. A telepítést, az ACL-t, a környezeti változót és a `.cmd` → `exc-guard` láncot a CI `windows-latest` futtatója ellenőrzi. WSL-ben a Hermes Linux-folyamat, ott az `install-managed.sh` és a posix csomag a helyes út.

## Hova kerül a Guard plugin

2026-10-03, a Hermes forrásából (`NousResearch/hermes-agent` main). A plugin-felderítési útvonal a forrás alapján rögzítve; a CLI managed konfigurációja a helyben telepített Hermes `6ec05205` runtime-ján, elkülönített profillal is ellenőrizve (spec §12). Desktop- és gateway-forgalmi mérés még nincs.

Az általános plugin innen töltődik, ha a neve szerepel a `plugins.enabled` listában:

- `$HERMES_HOME/plugins/<név>/plugin.yaml`
- alapértelmezés: `~/.hermes/plugins/excellence-guard/`
- Desktop-profil: `~/.hermes/profiles/<profil>/plugins/excellence-guard/` (profilonként saját `HERMES_HOME`)

A `HERMES_BUNDLED_PLUGINS` a beépített pluginkönyvtárat cseréli, nem egészíti ki, ezért a telepítő nem nyúl hozzá.

A telepítő a plugin-könyvtárat (`excellence-guard/plugin.yaml`) bemásolja a kanonikus `/opt/excellence/hermes-plugins/excellence-guard/` alá, és a sudozó user `~/.hermes` profiljaiba — beleértve a `bots[]` alapján frissen kirakott `exc-…` Bot-profilokat. A home könyvtár a useré, ezért a fájlt ki tudja törölni. A `plugins.enabled` és a `hooks.pre_tool_call` pinjét nem: azok az `/etc/hermes`-ben vannak, a `hermes config set` elutasítja. A hook `fail_closed`: ha az `exc-guard` hiányzik, timeoutol vagy hibázik, a tool nem fut le.

A telepítő hiányzó Guard- vagy token-segéd esetén megáll, mielőtt a padlót módosítaná. A letöltött csomag hash-ét és kötelező mezőit ellenőrzi; hibás csomag nem írja felül a meglévő beállításokat. Új AI-munkatárs vagy hozzáférés-változás után töltsd le és futtasd újra, hogy a Bot-csatlakozó és a Guard bekerüljön. A telepítő nem töröl idegen (nem `exc-`) profilokat.

A telepítő a Bot-profilok `config.yaml`-jában a `mcp_servers.excellence.headers` alá beírja az `X-Excellence-Install-Id` fejlécet a gép `excellence-install-id` értékével, így a Bot céges eszközhívásainál az auditban látszik, melyik gépről jöttek. Ha az Agent Sync újraírja a configot, az `exc-token` a következő modellhívásnál visszateszi. Csak a saját `excellence` blokkhoz nyúl, symlinkelt profilt nem ír, és nem menedzselt gépen (nincs azonosító) nem ír fejlécet. Az azonosító nem hiteles (a munkatárs átírhatja): csak audit-korrelációra jó, jogosultság nem épül rá.

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

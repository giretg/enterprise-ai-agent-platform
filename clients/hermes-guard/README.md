# Excellence Hermes gép-padló

A munkatárs gépére kerülő, rendszergazdai Hermes-beállítás. A munkatárs a saját Hermes-konfigjából nem tudja kikapcsolni a céges modell-utat és a Guardot. A finomabb, asszisztensenkénti engedélyt a Guard dönti el; ide csak az kerül, ami a munkatárs egyik asszisztensénél sem engedett.

## Céges kontroll az adminfelületről

1. **Adminisztráció → Hermes céges kontroll**: céges alap (Kötött pálya / Standard / Szabad), munkatársi preset és képességenkénti kivételek. A céges alapnál lazább kivételhez külön megerősítés és auditbejegyzés kell.
2. Az **AI-munkatárs adatlap → Eszközök** részen állíts képesség-plafont. A tényleges jog a munkatárs engedélyének és az agent plafonjának metszete.
3. Adj a munkatársnak hozzáférést legalább egy éles agenthez; az admin a munkatárs sorából letölti a gépi JSON-csomagot.
4. Az informatikus telepíti a csomagot, majd a munkatárs újraindítja a Hermest, bejelentkezik az Excellence MCP-kapcsolatra és Botot választ.
5. Ellenőrizzétek az alábbi átvételi eseteket, utána terítsétek a gépi csomagot központilag.

Mentéskor verzió nő, és a beállítás az auditnaplóval egy tranzakcióban kerül mentésre. Más admin közben történt módosítását a szerver nem írja felül. Visszavonás a következő kérésnél, engedélybővítés legkésőbb a következő sessionben érvényes. Ha a korábbi gépi csomag letiltotta a most engedélyezett funkciót, új csomag telepítése is kell. A letöltés új elvárt hash-t adhat: a régi, eltérő csomag ezután nem kap céges modellválaszt a telepítésig.

Szerveroldalon szükséges a `MODEL_GATEWAY_JWT_KEY` (külön, legalább 32 véletlen karakteres Secret Manager kulcs) és a kapcsolódó adatbázis-migrációk: lásd [DEPLOY.md](../../DEPLOY.md). Kulcs nélkül a token-csere elutasít.

## Letöltés

Admin, a szervezetben:

```
GET /api/client-policy/machine-floor?userId=<a munkatárs azonosítója>
```

A válaszban benne van a `config.yaml`, a `.env`, az `excellence-install-id` és a `managedDirHash`. Mentsd `floor.json` néven.

## Telepítés

A munkatárs gépén, a `clients/hermes-guard` mappából (sudo):

```
sudo ./install-managed.sh floor.json
```

A szkript újrafuttatható: policy-bővítés után töltsd le újra a csomagot, és futtasd megint. Az `installId` ugyanaz marad.

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

A `C:\ProgramData\Excellence` könyvtárat csak a SYSTEM és az Administrators írhatja, a Users csoport csak olvashatja. A telepítő a korábbi explicit jogokat törli. A Hermes Windowson nem keres natív managed helyet (U3), ezért a gépszintű környezeti változó mondja meg neki. A változó a munkatárs következő bejelentkezésétől érvényes. A munkatárs saját `HERMES_MANAGED_DIR` változóját a telepítő eltávolítja. Ha később újra beállítja, a Hermes nem a céges padlót olvassa, a Guard heartbeatje eltérő hash-t küld, és a céges modell nem válaszol.

Egy munkatársnak egyszerre egy kiadott padlója érvényes. A Windows-csomag letöltése után a korábbi macOS- vagy Linux-csomag eltérő hash-t ad.

Élő Hermes Desktop-mérés Windowson még nincs. A telepítést, az ACL-t, a környezeti változót és a `.cmd` → `exc-guard` láncot a CI `windows-latest` futtatója ellenőrzi.

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

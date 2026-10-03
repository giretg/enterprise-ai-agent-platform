# Excellence Hermes gép-padló

A munkatárs gépére kerülő, rendszergazdai Hermes-beállítás. A munkatárs a saját Hermes-konfigjából nem tudja kikapcsolni a céges modell-utat és a Guardot. A finomabb, asszisztensenkénti engedélyt a Guard dönti el; ide csak az kerül, ami a munkatárs egyik asszisztensénél sem engedett.

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

## Hash

A `managedDirHash` a három fájl (`config.yaml`, `.env`, `excellence-install-id`) sha256-jéből áll, `excellence-managed-dir-v1` előtaggal. A Guard heartbeatje ugyanezt küldi; eltérésnél a szerver jelez.

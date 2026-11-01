# 0001 — Konnektor-beállítások három szinten: platform, tenant (fiókkötés), felhasználó

## Kontextus

A Google Ads, Google Analytics és Search Console konnektoroknál keveredett, hogy mi platform- és mi cégadat. A Google Ads developer tokent a cég adminja adta meg aktiváláskor, a sablon-súgó a cég adminját a Google Cloud Console-ba küldte OAuth appot regisztrálni, miközben azt valójában nem tudta megmondani, hogy a konnektor a cég MELYIK fiókját érje el — az agent bármelyik fiókot hívhatta, amihez a belépett felhasználónak joga volt.

## Döntés

Egy delegált Google-konnektor három, külön tárolt és külön felületen kezelt szintből áll:

| Szint | Ki állítja | Mit | Hol tároljuk |
|---|---|---|---|
| Platform | superadmin | Google API OAuth app, Google Ads developer token | `platform_settings` (`oauth.google.api`, `google.ads.developer_token`) |
| Tenant | cég admin | **Fiókkötés**: Ads customer ID(k) (+ opcionális MCC), GA4 property ID(k), Search Console property-k | `connectors.config.googleAccountBinding` |
| Felhasználó | maga a felhasználó | saját Google-belépés | `connector_grants` |

- A developer token platform-szintű, mert az API-t hívó alkalmazást (a platform OAuth appjának Cloud projektjét) azonosítja, nem a hirdetőt. A futásidő injektálja; a régi, cég-configban tárolt fejléc csak tartalék.
- A fiókkötés futásidejű határ (mint a GitHub repo-scope): a kötésen kívüli fiókra menő hívást a platform a külső rendszer megkérdezése nélkül elutasítja. Fiók-független hívás (elérhető fiókok listája) engedett.
- A kötés aktív konnektoron is módosítható újranyitás nélkül, mert a felhasználói belépések identitása nem változik; auditált (`provisioning.connector.google_account_binding`).
- Ha a Google 401/403-at ad, a modell olyan hintet kap, amely a felhasználó saját hozzáférésére mutat, nem más fiókazonosító kipróbálására.

## Következmények

- Új Google Ads / Analytics / Search Console konnektor fiókkötés nélkül nem aktiválható; Google Ads platform developer token (vagy régi cég-szintű tartalék) nélkül sem.
- Régi, kötés nélküli konnektorok visszafelé kompatibilisen korlátlanok maradnak, a felület jelzi és szerkeszthetővé teszi a kötést.
- Új Google fiókos sablonnál a fiókkötés célmezője `googleAccountBinding.accountIds` / `googleAccountBinding.managerAccountId`.

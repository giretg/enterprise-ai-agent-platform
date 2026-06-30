# Feature-spec — IAM / RBAC, admin onboarding és jogosultsági modell

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-06-30
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (§4.3 admin-paraméterezés / jogosultságok, §4.4 Identity & Access Management ember + agent, §4.4.1 auth-provider választás Clerk/Keycloak, §4.4.2 deny-by-default + admin-vezérelt onboarding, §4.6.1 write-gate token-filozófia, §4.9.1 megosztott erőforrás, §7. megfelelőség / négy-szem-elv, §8.2 prompt injection és eszköz-jogosultság, §8.5 append-only audit, §8.7 platformfüggetlenség / Keycloak upgrade-path), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (v1.0, `users` séma, `role` mező, `requireRole` middleware, CR-MVP — Fázis 2 governance-kapu), `AI-Agent-Platform-Feature-Spec-AgentRegistry.md` (v1.0, `agent_api_keys` service-account, RBAC-kapuzott életciklus-átmenetek), `AI-Agent-Platform-Feature-Spec-MemoryTraining.md` (write-gate token mint aláírt, rövid életű, egyszer beváltható kredenciál), `Excellence Ai/AI-Agent-Platform-Feature-Spec-PerUser-Connector.md` (delegált connector-hozzáférés, a humán identitáshoz kötött grant)
**Olvasó:** fejlesztő(k). Feltételezi az append-only audit (`appendEvent` / `verifyChain`, §8.5), a tenant-scope modell (§8.8), a write-gate token-séma (§4.6.1) és az auth-provider OIDC-absztrakció ismeretét.
**Státusz:** **MVP-horog kész, governance-kapu Fázis 2.** Az MVP (`users` tábla + `role` mező + `requireRole` middleware) már bevezeti a négy szerepkört és a szerveroldali kapuzást. Ez a dokumentum a **teljes** IAM/RBAC réteget specifikálja: az auth-provider OIDC-absztrakciót (Clerk → Keycloak fájdalommentes csere), a `pending/active/suspended` státusz-állapotgépet, a deny-by-default autorizációs magot, az admin-vezérelt meghívásos onboardingot (aláírt, lejáró, egyszer beváltható token), a lock-out elleni invariánsokat (utolsó admin, ön-módosítás tiltása), valamint a Fázis 3 erőforrás-szintű (per-agent / per-Playbook) láthatóságot mint előretervezett bővítést.

---

## 0. Mit ad ez a dokumentum

Meghatározza, **ki kicsoda** a platformban és **mit szabad neki** — emberre és agentre egyaránt. Ez az a réteg, amelyre minden más feature-spec hallgatólagosan épít: a Playbook állapotátmenetei, az Agent Registry életciklus-műveletei, a tanítási write-gate, a connector-grantek és a sandbox-promóció mind **RBAC-kapuzott, auditált műveletek**. A koncepció központi ígérete — *„kontrollált, auditálható, zárt AI-üzem"* (§2) — IAM nélkül nem teljesíthető: kontroll az, hogy a jogosultság **szerveroldalon, deny-by-default módon** dől el, soha nem a promptban (§8.2).

**A feature öt, élesen elhatárolt invariánsra épül:**

1. **Authentikáció ≠ autorizáció, és külön rétegben él.** A *ki ő* kérdést az auth-provider (Clerk hostolt / Keycloak on-prem) válaszolja meg egy OIDC-absztrakció mögött; a *mit szabad neki* kérdést **mindig a saját Control Plane** dönti el, auditálhatóan. Így a banki upgrade-path (Keycloak-csere, §8.7) az autorizációs réteget nem érinti (N-IAM-1).
2. **Deny-by-default.** Ami nincs explicit engedélyezve, az tiltott — emberre (szerepkör + státusz) és agentre (capability, §8.2) egyaránt. A hiányzó konfiguráció soha nem jelent „szabad" hozzáférést (N-IAM-2).
3. **A hozzáférés két, együtt ható tengely.** Egy felhasználónak van **szerepköre** (`admin | approver | operator | viewer`) és **státusza** (`pending | active | suspended`). A hozzáférés a kettő konjunkciója: `active` státusz **és** elégséges szerepkör nélkül a művelet tiltott (N-IAM-3).
4. **Admin-vezérelt, token-alapú onboarding.** Az elsődleges belépési út az admin által kiállított **aláírt, lejáró, egyszer beváltható** meghívó — ugyanaz a token-filozófia, mint a tanítási write-gate-é (§4.6.1). Az önregisztráció másodlagos, `pending` + szerepkör nélküli, így semmihez nem fér hozzá (N-IAM-4).
5. **Lock-out- és ön-módosítás elleni kemény korlátok.** Az utolsó aktív admin nem fokozható le és nem függeszthető fel; admin a saját szerepét/státuszát nem írhatja át (a négy-szem-elv minimuma, §7.). Minden hozzáférési esemény **hash-láncolt auditesemény** (N-IAM-5).

**Miért fontos feature:** az IAM/RBAC minden más réteg felfüggesztési pontja. A `requireRole` middleware-t a Playbook-, Agent Registry-, Memory- és Connector-spec mind hívja; a *„ki adott kinek jogot, mikor"* a legtipikusabb compliance-kérdés egy auditon (§7.). A formalizálás kódszinten zárja ki a privilege-escalationt (OWASP LLM06 / Excessive Agency, §8.2) és bizonyíthatóvá teszi a hozzáférés-kezelést.

---

## 1. Scope

### 1.1 In scope (teljes feature)

1. **Auth-provider OIDC-absztrakció** (`AuthProvider` interfész): a Clerk (hostolt prototípus) és a Keycloak (on-prem / szabályozott) mögötti egységes belső identitás-kontraktus, hogy a csere ne igényelje az app újraírását (§4.4.1).
2. **`users` registry** mint tenant-scoped első-rendű entitás: külső identitás-referencia (`external_subject`), szerepkör, státusz, audit-mezők. A belső felhasználói rekord a jogosultság forrása, **nem** az auth-provider.
3. **Négy konfigurálható szerepkör** (`admin | approver | operator | viewer`) deklaratív **permission-mátrixszal**: minden védett művelet a mátrixból kapja a minimális szerepkövetelményt (nincs kódba szórt szerep-feltétel).
4. **Státusz-állapotgép** (`pending → active → suspended`, + visszaút) explicit átmenetekkel, mindegyik RBAC-kapuzott és auditált; a `suspended` azonnal megvonja a hozzáférést, a rekord és az auditnyom megmarad (non-repudiation).
5. **Deny-by-default autorizációs mag** (`authorizeUser()` / `requireRole()` middleware): minden bejövő kérés kötelezően áthalad rajta; az engedély a (státusz ∧ szerepkör ∧ tenant ∧ permission-mátrix) konjunkciója.
6. **Admin-vezérelt meghívásos onboarding** (`invitations`): aláírt, lejáró, egyszer beváltható meghívó előre kiosztott szerepkörrel; beváltáskor `active`. Opcionális **domain-allowlist** az önregisztrációhoz.
7. **Önregisztrációs (másodlagos) út:** `pending` + szerepkör nélküli fiók → „admin-jóváhagyásra vár" képernyő; az admin szerepkör-kiosztással teszi `active`-vá.
8. **Offboarding / felfüggesztés** (`suspend` / `reactivate`): azonnali hozzáférés-megvonás, a humán megfelelője a finomszemcsés agent-kill-switchnek (Agent Registry §4.9.4).
9. **Lock-out- és ön-módosítás-védő invariánsok** kódszintű kikényszerítéssel (utolsó admin, self-edit tiltása).
10. **Agent-identitás illesztése** (csak a kapcsolódási felület): az agent **nem** humán felhasználó, hanem service-account (`agent_api_keys`, Agent Registry §3.7); a humán RBAC és az agent-capability **két külön kapu** — itt a határvonalat és a közös audit-célt rögzítjük, nem az agent-authz belső működését.
11. **Hash-láncolt hozzáférési audit:** meghívás, beváltás, szerepkiosztás, státuszváltás, sikertelen authz mind append-only auditesemény (§8.5).
12. **Control Plane UI:** felhasználólista (szerep + státusz badge), meghívó-kiállító, pending-jóváhagyási sor, szerep-/státusz-szerkesztő diff+védőkorlátokkal, audit-nézet a hozzáférési eseményekre.

### 1.2 Out of scope (most NEM)

- **Az auth-provider belső konfigurációja** (SAML/OIDC connection setup, SCIM-provisioning a cég IdP-jéhez, Clerk/Keycloak tenant-beállítás) — ez deployment/üzemeltetési feladat, nem alkalmazás-kód. A spec az **absztrakciós kontraktust** és a belső user-szinkronizációt (`syncFromProvider`) fedi, nem a provider admin-felületét.
- **Az agent-capability / Tool Broker authz belső modellje** (§8.2) — külön (még meg nem írt) Tool Broker feature-spec hatóköre; itt csak az ember↔agent kapu-elhatárolás.
- **A write-gate token belső kiállítása és a tanítási pipeline** (§4.6.1) — a Memory/Training spec hatóköre; az `invitations` token a *filozófiát* osztja vele (aláírt, rövid életű, egyszer beváltható), de külön entitás.
- **A per-user delegált connector-kredenciálok** (`connector_grants`, §4.12.1) — külön spec; az IAM csak a humán identitást adja, amelyhez a grant kötődik.
- **Az append-only audit-lánc motorja** (`appendEvent` / `verifyChain` belső implementáció, §8.5) — saját (még meg nem írt) audit feature-spec; itt csak a kibocsátott esemény-típusokat és a kötelező mezőket definiáljuk.
- **A Fázis 3 erőforrás-szintű, finomszemcsés humán láthatóság teljes motorja** (per-agent / per-Playbook / per-ticket-típus ACL) — itt csak az adatmodell-horog és a tervezett kiterjesztés (§10), nem a teljes implementáció.

### 1.3 Az MVP-re gyakorolt hatás

A feature **additív, és meglévő horgokra épül**. Az MVP már tartalmazza a `users` táblát a `role` mezővel (`admin | approver | operator | viewer`) és a `requireRole` middleware-t. Az MVP-ben a kapuzás **„puha"**: a `role` mező létezik, de a teljes deny-by-default státusz-kapu, a meghívásos onboarding és a lock-out-védelem a **Fázis 2 (governance)** része — összhangban a koncepció §4.4.2 záró megjegyzésével (*„a Fázis 1 csak a szerepkör-mezőt vezeti be, a tényleges hozzáférés-kaput a Fázis 2 zárja be"*). Ez a spec ezeket **kiegészíti** (státusz-állapotgép, `invitations`, OIDC-absztrakció mint külön réteg, kemény invariánsok, audit-eseménytípusok, UI), nem írja át. A meglévő `requireRole`, tenant-scope és audit-lánc változatlanul újrahasznosul.

---

## 2. Hogyan illeszkedik a meglévő architektúrához

```
   KÜLSŐ IdP (cég Entra/Okta/Google)
        │ SAML/OIDC, SCIM
        ▼
 ┌─────────────────────┐        OIDC-absztrakció (4.4.1)
 │  AUTH-PROVIDER       │   ┌──────────────────────────────┐
 │  Clerk (hostolt)     │──▶│  AuthProvider interfész       │   "ki ő" (authentikáció)
 │  Keycloak (on-prem)  │   │  verifyToken() → subject      │
 └─────────────────────┘   └───────────────┬──────────────┘
                                            │ external_subject
   ┌──────────────────────── CONTROL PLANE (1. app) ─────────────────────────────────┐
   │                                        ▼                                          │
   │   ┌──────────────────────┐    ┌───────────────────────────┐                       │
   │   │  users (tenant-scoped)│◀──│  syncFromProvider()        │   belső user-rekord   │
   │   │  role | status        │    └───────────────────────────┘   = a jog FORRÁSA     │
   │   │  external_subject     │                                                        │
   │   └─────────┬────────────┘                                                         │
   │             │                                                                       │
   │   ┌─────────▼──────────────────┐   ┌──────────────────────┐   ┌──────────────────┐ │
   │   │  STÁTUSZ-ÁLLAPOTGÉP        │   │  PERMISSION-MÁTRIX    │   │  invitations      │ │
   │   │  pending→active→suspended  │   │  művelet → min. szerep│   │  aláírt, lejáró,   │ │
   │   └─────────┬──────────────────┘   └───────────┬──────────┘   │  1× beváltható    │ │
   │             │                                  │              └────────┬─────────┘ │
   │             └───────────────┬──────────────────┘                       │           │
   │                             ▼                                          ▼           │
   │             ┌──────────────────────────────────────────┐   "mit szabad" (autoriz.) │
   │             │  authorizeUser()  /  requireRole()        │   DENY-BY-DEFAULT          │
   │             │  (státusz ∧ szerep ∧ tenant ∧ mátrix)     │                            │
   │             └──────────────────┬───────────────────────┘                            │
   │   ▲ kemény korlát: utolsó admin véd, self-edit tilt    │ minden hozzáférési esemény │
   │   │                                                     ▼                            │
   │   └─────────────── APPEND-ONLY AUDIT (§8.5) ◀── invite/redeem/role/suspend/deny ──── │
   └──────────────────────────────────────────────────────────────────────────────────────┘
        │ requireRole(...)            │ user_id (delegálás)        │ ember ≠ agent
        ▼ (kapuzott művelet)          ▼                            ▼
   PLAYBOOK / AGENT REGISTRY /    PER-USER CONNECTOR (§4.12.1)   AGENT service-account
   MEMORY / SANDBOX-PROMÓCIÓ      (grant a humán identitáshoz)    (külön capability-kapu, §8.2)
```

**Kulcselv:** az auth-provider csak **igazolja, hogy ki vagy** (egy `external_subject` azonosítót ad), de **semmit nem dönt el arról, mit szabad**. Az utóbbi 100%-ban a Control Plane belső `users` rekordján és a permission-mátrixon múlik. Ez teszi a Clerk → Keycloak cserét fájdalommentessé, és tartja a governance-logikát auditálhatóan a saját kontrollhatáron belül.

---

## 3. Adatmodell

Prisma-szerű jelölés; a **dőlt** mezők az MVP-n túli, Fázis 2/3 kiegészítések. Minden tábla tenant-scoped (§8.8).

### 3.1 `users` — a belső felhasználói rekord (a jogosultság forrása)

```
id                 uuid  pk
tenant_id          uuid  not null            -- izolációs határ (§8.8); nincs cross-tenant láthatóság
external_subject   text  nullable unique     -- az auth-provider stabil subject-azonosítója (sub claim); NULL amíg meghívót nem váltott be
email              text  not null
display_name       text  nullable
role               enum(admin|approver|operator|viewer) nullable   -- NULL = nincs szerep (pending önregisztráció); deny-by-default
status             enum(pending|active|suspended) not null default pending
invited_by         fk users  nullable        -- ki hívta be (meghívásos úton); NULL önregisztrációnál
created_at         timestamptz not null
updated_at         timestamptz not null

-- Fázis 2 kiegészítések:
activated_at       timestamptz nullable
suspended_at       timestamptz nullable
suspended_by       fk users nullable
suspended_reason   text nullable
last_login_at      timestamptz nullable
```

**Invariáns:** a hozzáférés engedélyezése **kizárólag** akkor lehetséges, ha `status = active` **és** `role IS NOT NULL` **és** a kért művelet a permission-mátrixban a `role` szintjén megengedett (N-IAM-2, N-IAM-3). A `role IS NULL` (önregisztrált, jóvá nem hagyott) felhasználó **semmilyen** védett végponthoz nem fér — csak a `GET /me` „várj a jóváhagyásra" nézethez.

**Index:** `(tenant_id, status)` a pending-sor és a lista-nézethez; `(external_subject)` unique a provider-szinkronhoz; `(tenant_id, role)` az „utolsó admin"-ellenőrzéshez.

### 3.2 `invitations` — admin-vezérelt, egyszer beváltható meghívó

```
id                 uuid  pk
tenant_id          uuid  not null
email              text  not null            -- akinek szól (a beváltáskor ezzel kell egyeznie a provider-emailnek)
role               enum(admin|approver|operator|viewer) not null  -- előre kiosztott szerep
token_hash         text  not null            -- a kibocsátott token SHA-256 hash-e; nyers token CSAK egyszer, a kiállításkor látszik
issued_by          fk users not null         -- a meghívó admin
issued_at          timestamptz not null
expires_at         timestamptz not null      -- rövid életű (default 72 óra)
redeemed_at        timestamptz nullable       -- beváltás időbélyege; egyszer használatos
redeemed_user_id   fk users nullable
status             enum(pending|redeemed|revoked|expired) not null default pending
```

**Token-filozófia (a write-gate mintájára, §4.6.1):** a token **aláírt** (HMAC vagy aszimmetrikus, a write-gate-tel közös kulcskezelés), **rövid életű** (`expires_at`), **nem visszajátszható** (a `token_hash`-t tároljuk, a nyers tokent soha; beváltáskor `status: redeemed` atomi tranzakcióban). Lejárt / már beváltott / visszavont token **nem fogad el** (N-IAM-4).

**Index:** `(token_hash)` a beváltás-kereséshez; `(tenant_id, status)` a függő meghívók listájához.

### 3.3 `role_permissions` — deklaratív permission-mátrix (művelet → minimális szerep)

```
id                 uuid  pk
permission_key     text  not null            -- pl. "agent.create", "ticket.approve", "audit.read", "user.invite"
min_role           enum(admin|approver|operator|viewer) not null
description        text  nullable
-- seed-elt, verziózott referencia-adat; módosítása maga is admin-jogú, auditált művelet
```

**Megvalósítás:** a mátrix **adat**, nem kód — a `requireRole(permissionKey)` a `min_role`-t innen olvassa. Egy ordinális szerep-rangsor (`viewer < operator < approver < admin`) dönti el, hogy a felhasználó `role`-ja eléri-e a `min_role`-t. A mátrix módosítása `user.permission.update` jogot igényel (csak admin) és auditált, hogy *„ki lazított a kapun, mikor"* visszakereshető legyen.

> **Megjegyzés a négy szerep szemantikájáról (§4.3):** `viewer` = csak olvasás (board, napló-nézet, ha kap rá jogot); `operator` = ticket létrehozás/kezelés, agent-futás indítás; `approver` = jóváhagyási láncok (multi-level approval, tanítási write-gate emberi jóváhagyás); `admin` = paraméterezés, user-provisioning, permission-mátrix, kill-switch. A pontos kulcs→szerep leképezést a seed-mátrix rögzíti, és minden feature-spec a maga műveleteihez ehhez igazodik.

### 3.4 *`resource_grants` — Fázis 3 erőforrás-szintű humán láthatóság (horog)*

```
id                 uuid  pk
tenant_id          uuid  not null
user_id            fk users not null
resource_type      enum(agent|playbook|ticket_type) not null
resource_id        uuid  not null            -- a konkrét agent/Playbook/ticket-típus
access_level        enum(view|operate|approve) not null
granted_by         fk users not null
granted_at         timestamptz not null
```

**Cél (§4.4.2 Fázis 3 terv):** a négy szerepkörnél finomabb, erőforrás-szintű láthatóság — egy felhasználó csak bizonyos agenteket / Playbookokat / ticket-típusokat lát/kezel (pl. egy ügyfél-osztály csak a saját agentjeit). A Fázis 1-2-ben a tábla **nincs kikényszerítve** (üres = a szerepkör dönt); a Fázis 3-ban a `authorizeUser()` egy záró metszetet alkalmaz: `effektív hozzáférés = szerep-mátrix ∩ resource_grants`. Itt csak a séma-horog és az invariáns iránya rögzül; a motor a Fázis 3 hatóköre.

---

## 4. Státusz-állapotgép

```
                 (önregisztráció, domain-allowlist OK)
          ┌──────────────────────────────────────────┐
          │                                           ▼
   [ nincs fiók ] ──(meghívó beváltása)──▶ [ active ] ◀── role kiosztás ── [ pending ]
                         role előre kiosztva    │   ▲                          │
                                                │   │  reactivate (admin)      │ (semmihez nem fér,
                                       suspend  │   │                          │  csak "várj" nézet)
                                       (admin)  ▼   │                          │
                                          [ suspended ] ─────────────────────────┘
                                          (azonnali hozzáférés-megvonás,
                                           rekord + auditnyom megmarad)
```

| Átmenet | Kiváltó | Jog | Mellékhatás | Audit-esemény |
|---|---|---|---|---|
| → `pending` | önregisztráció (opc.) | domain-allowlist | `role = NULL`, `external_subject` kötve | `user.selfregister` |
| → `active` (meghívóból) | meghívó beváltása | érvényes token | `role` a meghívóból, `external_subject` kötve, `activated_at` | `user.invite.redeem` |
| `pending → active` | szerep-kiosztás | `admin` | `role` beállítva, `activated_at` | `user.role.assign` |
| `active → suspended` | offboarding/felfüggesztés | `admin` | hozzáférés azonnal megvonva, `suspended_at/by/reason` | `user.suspend` |
| `suspended → active` | visszaállítás | `admin` | hozzáférés visszaadva | `user.reactivate` |
| `active`-on belül szerepváltás | szerep módosítás | `admin` | `role` frissítve (lock-out-check!) | `user.role.change` |

**Kemény korlátok az állapotgépen (N-IAM-5):**

- **Utolsó admin véd:** ha a tenantban a `role = admin AND status = active` felhasználók száma 1, az adott rekordon a `suspend`, a lefokozás (`role.change` nem-adminra) és a self-suspend **elutasított** (`409 LAST_ADMIN_LOCK`).
- **Self-edit tilt:** admin a **saját** `role`-ját vagy `status`-át nem módosíthatja (`403 SELF_MODIFICATION_FORBIDDEN`) — a négy-szem-elv minimuma (§7.). Másik admin teheti meg.
- A `suspended` átmenet **nem törli** a rekordot és az auditnyomot (non-repudiation): a felhasználó-történet visszakereshető marad.

---

## 5. Auth-provider absztrakció (Clerk → Keycloak fájdalommentes csere)

A humán authentikáció egy szűk belső interfész mögött él, hogy a deployment-döntés (hostolt vs. on-prem) ne szivárogjon az alkalmazás-kódba (§4.4.1, §8.7).

```ts
interface AuthProvider {
  // A bejövő bearer/cookie tokenből stabil identitást ad; NEM dönt jogosultságot.
  verifyToken(raw: string): Promise<{ subject: string; email: string; displayName?: string }>;
  // Opcionális SCIM/webhook-szinkron a provider felől (lifecycle-esemény: created/deactivated).
  onLifecycleEvent?(evt: ProviderLifecycleEvent): Promise<void>;
}
```

- **`ClerkAuthProvider`** (prototípus / hostolt, nem szabályozott ügyfél): kész UI, gyors Next.js-integráció, Enterprise SSO (SAML/OIDC) + SCIM a cég IdP-jéhez. **Nem self-hostolható → on-premre nem alkalmas.**
- **`KeycloakAuthProvider`** (bank / pénzügyi / on-prem): self-hostolt OIDC/OAuth2/SAML, LDAP/AD, SCIM; az identitásadat a cég kontrollhatárán belül marad.

**Két architekturális szabály (a csere fájdalommentességéért):**

1. **Humán auth standard OIDC-absztrakció mögött** — a kód csak az `AuthProvider`-rel beszél, a konkrét provider config-/DI-szinten cserélhető. A Clerk ↔ Keycloak csere **nem** igényli az app újraírását.
2. **Agent-authz NEM a külső auth-providerben** — az agentek nem humán felhasználók, hanem API-kulcsos service-account-ok (Agent Registry §3.7); a finomszemcsés jogosultság (ticket-jogok, erőforrás-hozzáférés, jóváhagyási láncok) a **saját Control Plane-ben** él. Előny: a Clerk per-MAU díja csak az emberekre vonatkozik, és a governance-logika auditálhatóan nálunk marad.

**`syncFromProvider(subject, email, displayName)`:** az első sikeres `verifyToken` után megkeresi/létrehozza a belső `users` rekordot (`external_subject` szerint). Ha nincs hozzá meghívó-beváltás és nincs önregisztrációs allowlist-egyezés → `pending`, `role = NULL`. **A belső rekord, nem a provider, a jog forrása.**

> **Külső hivatkozások a döntéshez (§4.4.1):** Clerk Enterprise SSO SAML/OIDC connection-okkel ([clerk.com docs](https://clerk.com/docs/guides/configure/auth-strategies/enterprise-connections/overview)); Keycloak standard OIDC/OAuth2/SAML self-hostolt identity serverként ([keycloak.org](https://www.keycloak.org/), [Server Admin Guide](https://www.keycloak.org/docs/latest/server_admin/index.html)). A Clerk SAML/SCIM tier-besorolása forrásonként ellentmondó és gördülő kiadásban van — **éles döntés előtt a friss árazás közvetlen ellenőrzése szükséges** (validálandó, §10).

---

## 6. Szolgáltatás-réteg / API

Minden végpont tenant-scoped, és — a `POST /auth/redeem` kivételével — kötelezően áthalad a `requireRole`-on (deny-by-default). Hibakódok a §8-ban.

| Művelet | Végpont (vázlat) | Jog (`permission_key`) | Leírás |
|---|---|---|---|
| Identitás-szinkron | belső, `verifyToken` után | — | `syncFromProvider`; `pending`/`role=NULL` ha nincs jogalap |
| Saját profil | `GET /me` | bármely auth-elt (státusztól függő nézet) | `pending` → „várj a jóváhagyásra"; `active` → teljes nézet |
| Meghívó kiállítása | `POST /users/invite` | `user.invite` (admin) | aláírt, lejáró token; nyers token **egyszer** a válaszban |
| Meghívó beváltása | `POST /auth/redeem` | token (nem szerep) | email-egyezés + nem lejárt/beváltott → `active`, `role` a meghívóból |
| Meghívó visszavonása | `POST /users/invite/:id/revoke` | `user.invite` (admin) | `status: revoked`; beválthatatlan |
| Pending jóváhagyás | `POST /users/:id/approve` | `user.approve` (admin) | `role` kiosztás → `active` |
| Szerep módosítás | `PATCH /users/:id/role` | `user.role.write` (admin) | lock-out + self-edit check |
| Felfüggesztés | `POST /users/:id/suspend` | `user.suspend` (admin) | azonnali megvonás; lock-out check |
| Visszaállítás | `POST /users/:id/reactivate` | `user.suspend` (admin) | `suspended → active` |
| Felhasználólista | `GET /users` | `user.read` (admin) | szerep + státusz szűréssel |
| Hozzáférési audit | `GET /audit/access` | `audit.read` (admin/approver) | meghívás/beváltás/szerep/státusz/deny események |
| Permission-mátrix | `GET/PATCH /permissions` | `user.permission.write` (admin) | a mátrix olvasása/módosítása (auditált) |

**`requireRole(permissionKey)` middleware (a deny-by-default mag):**

```
1. token = extractBearer(req)               // hiányzik → 401 NO_TOKEN
2. { subject } = AuthProvider.verifyToken(token)   // érvénytelen → 401 INVALID_TOKEN
3. user = users.findByExternalSubject(subject, req.tenant_id)
                                            // nincs / más tenant → 403 NO_USER (nem szivárog létezés)
4. if user.status != 'active'  → 403 INACTIVE  (pending/suspended)
5. if user.role IS NULL        → 403 NO_ROLE
6. minRole = role_permissions[permissionKey].min_role   // ismeretlen kulcs → 403 (deny-by-default!)
7. if rank(user.role) < rank(minRole)  → 403 INSUFFICIENT_ROLE
8. (Fázis 3) if resource_grants nem üres a típusra → metszet-ellenőrzés
9. ok → next();  minden 4–7 elutasítás → user.authz.deny audit-esemény
```

Az **ismeretlen permission-kulcs alapból tilt** (6. lépés) — új védett művelet véletlen „nyitva felejtése" nem lehetséges (N-IAM-2).

---

## 7. Onboarding-folyamatok (end-to-end)

**A) Admin-meghívás (elsődleges út):**

1. Admin: `POST /users/invite { email, role }` → a szerver `users` rekordot készít (`pending`, a kívánt `role` előjegyezve a meghívón), kibocsát egy aláírt tokent, tárolja a `token_hash`-t, a nyers tokent **egyszer** visszaadja (meghívólink).
2. A meghívott a linkre kattint, belép az auth-providernél (vagy regisztrál ott) → `POST /auth/redeem { token }`.
3. A szerver ellenőrzi: aláírás OK, nem lejárt, nem beváltott/visszavont, **az auth-email egyezik a meghívó emailjével**. Atomi tranzakció: `invitation.status: redeemed`, `users.role` a meghívóból, `users.status: active`, `external_subject` kötve.
4. Audit: `user.invite.issue` (1. lépés), `user.invite.redeem` (3. lépés).

**B) Önregisztráció (másodlagos, opcionális):**

1. A felhasználó regisztrál az auth-providernél → első `verifyToken` → `syncFromProvider`.
2. Ha **domain-allowlist** be van kapcsolva és az email nem egyezik → a fiók nem jön létre (`403 DOMAIN_NOT_ALLOWED`). Ha egyezik (vagy az allowlist ki van kapcsolva) → `users` rekord `pending`, `role = NULL`.
3. A felhasználó **csak** a `GET /me` „admin-jóváhagyásra vár" nézetet látja, semmilyen védett végponthoz nem fér.
4. Admin: `POST /users/:id/approve { role }` → `active`. Audit: `user.selfregister`, majd `user.role.assign`.

**C) Offboarding:** `POST /users/:id/suspend { reason }` → azonnali hozzáférés-megvonás (a következő `requireRole` a 4. lépésen elbukik), `suspended_at/by/reason`. A felhasználói rekord és minden korábbi auditnyom megmarad.

---

## 8. Biztonsági invariánsok és audit

**Megnevezett invariánsok (a tesztek ezekre hivatkoznak):**

- **N-IAM-1 — authz ≠ provider.** A jogosultságot soha az auth-provider claim-jei döntik el, hanem a belső `users.role` + permission-mátrix. A provider csak `subject`-et ad. (Keycloak-csere nem érinti az authz-réteget.)
- **N-IAM-2 — deny-by-default.** Ismeretlen permission-kulcs, `role = NULL`, vagy hiányzó mátrix-bejegyzés → **tilt**. Nincs „implicit engedély".
- **N-IAM-3 — kettős kapu.** `status = active` **és** elégséges `role` együtt kell; bármelyik hiánya → tilt.
- **N-IAM-4 — token-higiénia.** Lejárt / már beváltott / visszavont / email-nem-egyező / aláírás-hibás meghívó → elutasítva; a nyers token sosem tárolódik (csak hash).
- **N-IAM-5 — lock-out & self-edit.** Az utolsó aktív admin nem fokozható/függeszthető; admin a saját szerepét/státuszát nem írhatja át.
- **N-IAM-6 — tenant-izoláció.** Egy felhasználó kizárólag a saját tenantjának erőforrásait látja/kezeli; cross-tenant `external_subject`-egyezés sem ad hozzáférést (§8.8).
- **N-IAM-7 — ember ≠ agent.** A humán RBAC és az agent-capability két külön kapu; egy agent (service-account) soha nem szerez humán szerepkört, és fordítva (§8.2).

**Audit (append-only, hash-láncolt, §8.5).** Kötelező esemény-típusok közös mezőkkel (`actor_user_id`, `tenant_id`, `target_user_id`, `prev_hash`, `hash`, `ts`): `user.invite.issue`, `user.invite.redeem`, `user.invite.revoke`, `user.selfregister`, `user.role.assign`, `user.role.change`, `user.suspend`, `user.reactivate`, `user.permission.update`, `user.authz.deny`. Az utolsó (`deny`) a **gyanús minták** flag-elését szolgálja (ismételt jogosultság-emelési kísérlet → §8.2), és bemenet a Proaktív monitornak. A *„ki adott kinek jogot, mikor"* compliance-kérdés ezekből bizonyíthatóan megválaszolható.

---

## 9. Tesztek (kötelező negatív tesztek)

1. **Deny-by-default:** ismeretlen `permission_key`-re hívott `requireRole` → 403, nem 200 (N-IAM-2).
2. **Pending nem fér hozzá:** `role = NULL`, `pending` user bármely védett végponton → 403 NO_ROLE; csak `GET /me` megy (N-IAM-3).
3. **Suspended azonnal kizár:** aktív session-nel rendelkező user felfüggesztése után a következő kérés → 403 INACTIVE (N-IAM-3).
4. **Token egyszer használatos:** ugyanaz a meghívó-token második beváltása → 409/403, az első után `redeemed` (N-IAM-4).
5. **Lejárt token:** `expires_at` utáni beváltás → elutasítva (N-IAM-4).
6. **Email-mismatch:** a meghívó emailjétől eltérő auth-emaillel beváltás → elutasítva (N-IAM-4).
7. **Utolsó admin véd:** az egyetlen aktív admin self-suspend / lefokozás → 409 LAST_ADMIN_LOCK (N-IAM-5).
8. **Self-edit tilt:** admin a saját `role`/`status` PATCH-e → 403 SELF_MODIFICATION_FORBIDDEN (N-IAM-5).
9. **Provider-claim nem emel jogot:** a token egy „admin"-nak látszó custom claim-mel, de a belső `users.role = viewer` → viewer-jogok (N-IAM-1).
10. **Tenant-izoláció:** A tenant usere B tenant `/users/:id`-jére → 403/404, nem szivárog létezés (N-IAM-6).
11. **Domain-allowlist:** nem engedett domainnel önregisztráció → 403 DOMAIN_NOT_ALLOWED (§7/B).
12. **Audit-lánc sértetlenség:** minden fenti elutasítás/művelet után a hash-lánc `verifyChain`-nel valid, és a `deny` esemény jelen van (§8.5).

---

## 10. Fázisolás és nyitott kérdések

**Fázisolás:**

- **Fázis 1 (MVP, kész horog):** `users` tábla + `role` mező + `requireRole` middleware; „puha" kapu, a négy szerepkör bevezetve.
- **Fázis 2 (governance, ez a spec gerince):** `status`-állapotgép, `invitations` + meghívásos onboarding, `AuthProvider` OIDC-absztrakció külön rétegként, deklaratív permission-mátrix, deny-by-default szerveroldali kikényszerítés, lock-out/self-edit invariánsok, audit-eseménytípusok, Control Plane UI.
- **Fázis 3 (skálázás / multi-tenant):** `resource_grants` — erőforrás-szintű (per-agent / per-Playbook / per-ticket-típus) humán láthatóság; a valódi use case élesedéssel (integráció, több felhasználói csoport) együtt épül ki (§4.4.2 Fázis 3 terv).

**Nyitott kérdések / validálandó (§10.A-szellem):**

- **Clerk SAML/SCIM árazás és tier:** a források ellentmondóak és gördülő kiadásban — éles döntés előtt friss árazás-ellenőrzés (§4.4.1).
- **SCIM-deprovisioning szemantika:** a provider felőli „deaktiválás" (`onLifecycleEvent`) automatikusan `suspended`-et váltson-e, vagy csak admin-jelölést — banki ügyfélnél a HR-rendszer az igazságforrás; validálandó ügyfélinterjún.
- **Approver vs. admin határ a permission-mátrixban:** mely jóváhagyási láncok (tanítási write-gate, multi-level ticket-approval) tartoznak `approver`-höz és mi marad `admin`-nál — a Playbook- és Memory-spec jóváhagyási pontjaival együtt kell finomítani.
- **Session-revokáció a felfüggesztéskor:** a `suspended` a *következő* kérésen biztosan kizár; szükséges-e ezen felül aktív token-revokáció a providernél (Keycloak back-channel logout) az azonnali hatáshoz — on-prem szabályozott környezetben igen, validálandó.

---

*Ez a dokumentum a koncepció §4.3-4.4 és §8.2 fejlesztői specifikációja. Az append-only audit-lánc (§8.5) és a Tool Broker / agent-capability (§8.2) önálló feature-spec-jei még nem készültek el; ez a spec a kibocsátott audit-eseménytípusokat és az ember↔agent kapu-elhatárolást definiálja, a belső motorjaikat nem.*

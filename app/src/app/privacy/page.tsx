import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPage } from '@/components/public-site/public-site-shell'

export const metadata: Metadata = {
  title: 'Adatvédelmi tájékoztató',
  description:
    'How Excellence AI collects, uses, stores, and shares personal data, including Google user data from Gmail and Google Drive.',
  robots: { index: true, follow: true },
}

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Adatvédelmi tájékoztató"
      description="Ez a tájékoztató elmondja, milyen adatokat kezel az Excellence AI, beleértve a Google-fiókból származó adatokat, mire használjuk őket, hol tároljuk, kivel osztjuk meg, és hogyan kérheted a törlésüket."
      updated="2026. szeptember 13."
    >
      <p>
        Az <strong>Excellence AI</strong> szolgáltatást az <strong>Excellence Pay Kft.</strong>{' '}
        („adatkezelő”, „mi”) üzemelteti a <Link href="/">https://ai.excellencepay.com</Link>{' '}
        címen. Ez a dokumentum a GDPR és a Google API Services User Data Policy szerinti
        tájékoztatás. Az ÁSZF külön oldalon olvasható:{' '}
        <Link href="/gtc">https://ai.excellencepay.com/gtc</Link>.
      </p>
      <p>
        Adatvédelmi megkeresés:{' '}
        <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>.
      </p>

      <h2>1. Milyen adatokat kezelünk</h2>
      <h3>Fiók és munkaterület</h3>
      <p>
        Meghívásos belépéskor kezeljük a nevedet, e-mail-címedet, a szervezeti tagságodat, a
        szerepkörödet, és a belépési eseményeket. A beléptetést a Clerk végzi; a munkaterület
        adatait a saját adatbázisunkban tároljuk, tenantonként elkülönítve.
      </p>
      <h3>Az ügynökökkel végzett munka</h3>
      <p>
        Kezeljük a beszélgetéseket, feladatokat, feltöltött fájlokat, jóváhagyásokat, auditnaplókat
        és a költségkereteket. Ezek a céged munkájának részei: a tenant adminisztrátora látja őket
        a jogosultsága szerint, más tenant nem.
      </p>
      <h3>Google-felhasználói adatok</h3>
      <p>
        A Google-fiók csatlakoztatása <strong>nem kötelező</strong> a belépéshez. Csak akkor kérünk
        Google-hozzáférést, ha te (vagy a céged adminja által neked engedélyezett funkció)
        Gmailt vagy Google Drive-ot akar használni. Ilyenkor a Google OAuth-on keresztül, a
        hozzájárulásoddal a következőkhöz férhetünk hozzá, a kért jogosultság szerint:
      </p>
      <ul>
        <li>
          <strong>Alapprofil:</strong> e-mail-cím és alapvető profilazonosító (hogy a csatlakoztatott
          fiókot megjelenítsük és a tokent a felhasználódhoz kössük).
        </li>
        <li>
          <strong>Gmail:</strong> üzenetek olvasása, piszkozat készítése, küldés, címkézés — csak a
          kért Gmail-művelethez, a megadott scope szerint.
        </li>
        <li>
          <strong>Google Drive:</strong> fájlok listázása, olvasása, létrehozása, módosítása,
          áthelyezése, megosztása — a megadott Drive-scope szerint (olvasás, kijelölt fájlok, vagy
          admin által engedélyezett tágabb írás).
        </li>
      </ul>
      <p>
        Nem kérünk Domain-wide Delegation-t, és nem lépünk be a Google-fiókodba a hozzájárulásod
        nélkül. A Google-tokeneket titkosított token-tárolóban tartjuk, nem a böngészőben és nem a
        promptban.
      </p>

      <h2>2. Mire használjuk az adatokat</h2>
      <ul>
        <li>A beléptetéshez és a jogosultságok érvényesítéséhez.</li>
        <li>
          Az Excellence AI ügynökeinek futtatásához: a kért feladat elvégzése, például e-mail
          összegzése, Drive-dokumentum olvasása vagy készítése, belső tudás keresése.
        </li>
        <li>Auditáláshoz, biztonsági események kivizsgálásához, költségkontrollhoz.</li>
        <li>A szolgáltatás üzemeltetéséhez, hibajavításhoz, ügyfélszolgálathoz.</li>
      </ul>
      <p>
        <strong>Nem</strong> használjuk a Google-felhasználói adatokat reklámprofilozásra, nem
        adjuk el, és nem használjuk általános AI/ML modell tanítására vagy javítására. A Google
        Workspace API-adatot csak a felhasználó által kért, a termékben látható funkcióhoz
        használjuk (Limited Use).
      </p>

      <h2>3. Kivel osztjuk meg</h2>
      <p>Az adatokat a feladat elvégzéséhez szükséges mértékben a következő címzettek kaphatják:</p>
      <ul>
        <li>
          <strong>Nyelvi modellek szolgáltatói</strong> (a tenant beállításától függően például
          OpenAI, Anthropic, Google, xAI): a kérés szövege és a feladathoz szükséges csatolt
          tartalom. A kimenő szövegen adatvédelmi átjáró fut: személyes és érzékeny adatok egy
          része álnevesítve vagy blokkolva megy ki, a tenant szabálya szerint.
        </li>
        <li>
          <strong>Clerk</strong> — beléptetés.
        </li>
        <li>
          <strong>Google Cloud / Firebase App Hosting, adatbázis- és tárhelyszolgáltatók</strong> —
          üzemeltetés, titkosított tárolás.
        </li>
        <li>
          A saját szervezeted adminisztrátorai és a jogosult munkatársak — a tenantban látható
          munkára.
        </li>
      </ul>
      <p>
        Google-felhasználói adatot harmadik félnek csak a kért funkció teljesítéséhez adunk át, a
        hozzájárulásoddal. Nem értékesítjük, nem adjuk bérbe, és nem használjuk független
        adatbrókernek.
      </p>

      <h2>4. Tárolás, megőrzés, törlés</h2>
      <p>
        A fiók- és munkaterület-adatokat az Európai Unióban vagy az üzemeltető által szerződésesen
        védett infrastruktúrán tároljuk. A Google access/refresh token titkosítva, a felhasználóhoz
        és a tenanthoz kötve él, amíg a kapcsolat aktív.
      </p>
      <p>Törlés és visszavonás:</p>
      <ul>
        <li>
          A Google-kapcsolatot a fiókbeállításokban bármikor bonthatod; ekkor a helyi tokeneket
          töröljük, és a további API-hívás leáll. A Google-fiókodban is visszavonhatod a hozzáférést:{' '}
          <a href="https://myaccount.google.com/permissions">https://myaccount.google.com/permissions</a>
          .
        </li>
        <li>
          A tenant adminisztrátora vagy az adatkezelő a fiók megszűnésekor a munkaterület adatait a
          szerződés és a jogszabályos megőrzési idők szerint törli vagy anonimizálja.
        </li>
        <li>
          Az auditnaplókat biztonsági okból a szerződéses megőrzési ideig tarthatjuk, utána
          töröljük vagy aggregáljuk.
        </li>
      </ul>

      <h2>5. Jogalap és érintetti jogok</h2>
      <p>
        A kezelés jogalapja jellemzően a szerződés teljesítése (a szolgáltatás nyújtása), jogos
        érdek (biztonság, audit, visszaélés elleni védelem), és a Google-adatoknál a hozzájárulásod
        (OAuth consent), amelyet bármikor visszavonhatsz.
      </p>
      <p>
        Kérheted a hozzáférést, helyesbítést, törlést, korlátozást, adathordozást, és tiltakozhatsz
        a jogos érdeken alapuló kezelés ellen. Panaszt tehetsz a Nemzeti Adatvédelmi és
        Információszabadság Hatóságnál (NAIH). Írj a{' '}
        <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a> címre.
      </p>

      <h2>6. Google user data (English)</h2>
      <p>
        <strong>Excellence AI</strong> is a governed enterprise AI coworker platform operated by
        Excellence Pay Kft. at <Link href="/">https://ai.excellencepay.com</Link>. Connecting a
        Google account is optional and is requested only when a signed-in user wants Gmail or Google
        Drive features.
      </p>
      <p>
        <strong>What we access.</strong> With the user&apos;s OAuth consent, and only for the
        scopes granted, Excellence AI may access: Google account email/profile identifiers to label
        the connected account; Gmail messages and metadata to read, draft, send, or label email;
        Google Drive files and metadata to list, read, create, update, move, or share files as the
        user requested.
      </p>
      <p>
        <strong>How we use it.</strong> Google user data is used solely to provide the visible,
        user-facing features the user asked an Excellence AI agent to perform (for example:
        summarize inbox threads, draft a reply, read a Drive document, or write a file the user
        requested). We do not use Google user data to serve ads, to build independent user
        profiles, or to train, improve, or create general-purpose AI/ML models.
      </p>
      <p>
        <strong>How we store it.</strong> OAuth access and refresh tokens are stored encrypted in a
        server-side token vault, bound to the user, tenant, and connector grant. Message and file
        content may be processed in memory for the duration of a run and may appear in the
        workspace conversation or audit trail of that tenant. We do not keep a wholesale copy of
        the user&apos;s Gmail mailbox or Drive as a secondary archive.
      </p>
      <p>
        <strong>How we share it.</strong> To complete the requested task, relevant content may be
        sent to the large-language-model provider configured for that tenant (for example OpenAI,
        Anthropic, Google, or xAI). A privacy gateway can tokenize or block sensitive fields before
        egress, according to tenant policy. Hosting, authentication, and database processors act as
        subprocessors. We do not sell Google user data. We do not transfer it to third parties
        except as needed to provide the user-facing feature, with the user&apos;s consent.
      </p>
      <p>
        <strong>Limited Use.</strong> Excellence AI&apos;s use of information received from Google
        APIs adheres to the{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. Workspace API data is used only to provide or
        improve user-facing features that are prominent in the requesting application.
      </p>
      <p>
        <strong>Revoke and delete.</strong> Users can disconnect Google in Excellence AI account
        settings; we then delete the stored tokens and stop API calls. Users can also revoke access
        at{' '}
        <a href="https://myaccount.google.com/permissions">https://myaccount.google.com/permissions</a>
        . Privacy requests: <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>.
      </p>
    </LegalPage>
  )
}

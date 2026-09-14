import { Link } from '@/i18n/navigation'

export function PrivacyHu() {
  return (
    <div lang="hu">
      <p>
        Ez az <strong>Excellence AI</strong> adatkezelési tájékoztatója. Az Excellence AI
        kontrollált vállalati AI-munkatárs platform, amelyet az <strong>Excellence Pay Kft.</strong>{' '}
        („Excellence Pay”, „mi”) üzemeltet a <Link href="/">https://ai.excellencepay.com</Link>{' '}
        címen. Ez önálló adatvédelmi oldal, nem a honlap összefoglalója. ÁSZF:{' '}
        <Link href="/gtc">https://ai.excellencepay.com/gtc</Link>.
      </p>
      <p>
        Adatvédelmi kapcsolat:{' '}
        <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>.
      </p>
      <p>
        A tájékoztató a Google OAuth / Google API Services verifikációjához és a GDPR-hoz készült.
        Bemutatja, hogyan fér hozzá, használja, tárolja és osztja meg az alkalmazás a
        Google-felhasználói adatokat.
      </p>

      <h2>1. Kik vagyunk</h2>
      <p>
        Adatkezelő: <strong>Excellence Pay Kft.</strong>, az Excellence AI szolgáltatás
        üzemeltetője a https://ai.excellencepay.com címen. Az Excellence AI meghívásos, belépéshez
        kötött munkatér. Nem nyilvános fogyasztói chatbot, és nem irányul gyermekekre.
      </p>
      <p>
        Adatvédelmi megkeresés, hozzáférési és törlési kérelem:{' '}
        <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>.
      </p>

      <h2>2. Milyen személyes adatokat kezelünk (a Google API-kon kívül)</h2>
      <p>Az Excellence AI használata során kezelhetjük:</p>
      <ul>
        <li>
          <strong>Fiók és azonosítás:</strong> név, e-mail-cím, szervezeti (tenant) tagság,
          szerepkör és belépési események. A beléptetést a Clerk végzi.
        </li>
        <li>
          <strong>Munkatér-tartalom:</strong> AI-ügynökökkel folytatott beszélgetések, feladatok,
          feltöltött fájlok, jóváhagyások, playbookok, tudástári dokumentumok, költségkeretek és
          auditnaplók. Ezek a megrendelő szervezetéi, tenantonként elkülönítve.
        </li>
        <li>
          <strong>Eszköz- és biztonsági adatok:</strong> IP-cím, user-agent, időbélyegek és
          hasonló technikai naplók a beléptetéshez, visszaélés megelőzéséhez és incidensvizsgálathoz.
          Reklámazonosítót nem használunk.
        </li>
        <li>
          <strong>Sütik:</strong> a belépéshez (Clerk) és az alkalmazás biztonságához szükséges
          munkamenet-sütik. Reklám sütit, remarketing pixelt és önálló analitikai SDK-t nem
          használunk.
        </li>
      </ul>

      <h2>3. Milyen Google-felhasználói adatokhoz fér hozzá ez az alkalmazás</h2>
      <p>
        A Google-fiók csatlakoztatása <strong>opcionális</strong>. Az Excellence AI-ba belépéshez
        nem kell Google-belépés. Google OAuth-hozzáférést csak akkor kérünk, ha a belépett
        felhasználó (vagy a tenant-adminisztrátor által számára engedélyezett funkció) Gmailt
        vagy Google Drive-ot szeretne használni.
      </p>
      <p>
        A felhasználó OAuth-hozzájárulásával, és csak a megadott scope-okra, az Excellence AI a
        következő Google-felhasználói adatokhoz férhet hozzá:
      </p>
      <ul>
        <li>
          <strong>Google-fiók profilazonosítók:</strong> e-mail-cím és alapvető profilazonosítók
          (például <code>openid</code>,{' '}
          <code>https://www.googleapis.com/auth/userinfo.email</code>,{' '}
          <code>https://www.googleapis.com/auth/userinfo.profile</code>), hogy a csatlakoztatott
          fiókot felcímkézzük, és a tokent a belépett felhasználóhoz kössük.
        </li>
        <li>
          <strong>Gmail:</strong> üzenettörzs, fejlécek, címkék, piszkozatok, valamint küldés és
          módosítás a megadott jogosultság szerint. Tipikus scope-ok:{' '}
          <code>https://www.googleapis.com/auth/gmail.readonly</code>,{' '}
          <code>https://www.googleapis.com/auth/gmail.compose</code>,{' '}
          <code>https://www.googleapis.com/auth/gmail.send</code> és{' '}
          <code>https://www.googleapis.com/auth/gmail.modify</code>. Ezeket csak arra használjuk,
          hogy a felhasználó által az ügynökre bízott e-mailt keressük, olvassuk, piszkozatoljuk,
          elküldjük vagy címkézzük.
        </li>
        <li>
          <strong>Google Drive:</strong> fájl- és mappametaadatok és tartalom a megadott
          jogosultság szerint. Tipikus scope-ok:{' '}
          <code>https://www.googleapis.com/auth/drive.readonly</code>,{' '}
          <code>https://www.googleapis.com/auth/drive.file</code>, és — csak ha a tenant
          adminisztrátora engedélyezi — <code>https://www.googleapis.com/auth/drive</code>. Ezekkel
          listázunk, keresünk, olvasunk, létrehozunk, frissítünk, áthelyezünk, másolunk, kukába
          teszünk, visszaállítunk vagy megosztunk a felhasználó által kért fájlokat.
        </li>
      </ul>
      <p>
        Nem kérünk Domain-wide Delegation-t. Google-fiókhoz a felhasználó OAuth-hozzájárulása
        nélkül nem férünk hozzá. Csak a csatlakoztatott funkcióhoz szükséges scope-ot kérjük.
      </p>

      <h2>4. Hogyan használja ez az alkalmazás a Google-felhasználói adatokat</h2>
      <p>
        A Google-felhasználói adatokat kizárólag az Excellence AI-ban a felhasználó által kért,
        a termékben látható szolgáltatásokhoz használjuk. Példák:
      </p>
      <ul>
        <li>a felhasználó által az ügynökre bízott Gmail-szálak összefoglalása vagy keresése;</li>
        <li>válasz piszkozatolása vagy küldése a csatlakoztatott Gmail-fiókból a beállított jóváhagyás után;</li>
        <li>Google Drive-dokumentum olvasása, hogy az ügynök válaszoljon vagy piszkozatot készítsen;</li>
        <li>Drive-fájl létrehozása vagy frissítése, ha a felhasználó ezt kérte.</li>
      </ul>
      <p>A Google-felhasználói adatot szükség szerint arra is használjuk, hogy:</p>
      <ul>
        <li>érvényesítsük a hozzáférés-szabályozást, a tenant-elkülönítést és az emberi jóváhagyási kapukat;</li>
        <li>auditnyomot vezessünk az ügynökfutásokról a megrendelő szervezet számára;</li>
        <li>üzemeltessük, védjük, hibakeressük és támogassuk a szolgáltatást.</li>
      </ul>
      <p>
        Google-felhasználói adatot <strong>nem</strong> értékesítünk. Google-felhasználói adatot{' '}
        <strong>nem</strong> használunk célzott reklámra, személyre szabott hirdetésre,
        remarketingre, érdeklődésalapú hirdetésre, hitelképesség-vizsgálatra, hitelezésre vagy
        önálló profilozásra. Google Workspace API-adatot <strong>nem</strong> használunk általános
        vagy nem személyre szabott AI / ML modellek fejlesztésére, javítására vagy tanítására.
      </p>

      <h2>5. Hogyan tárolja ez az alkalmazás a Google-felhasználói adatokat</h2>
      <p>
        Az OAuth access- és refresh-tokeneket titkosítva, szerveroldali token-tárolóban őrizzük
        (élesben Google Cloud Secret Manager), a felhasználóhoz, a tenanthoz és a csatlakozó
        granthez kötve. Token nem kerül a böngészőbe, a promptba vagy az alkalmazásnaplóba.
      </p>
      <p>
        A Gmail-üzenettörzseket és a Drive-fájltartalmat a kért feladat elvégzéséhez dolgozzuk
        fel. Megjelenhetnek az adott tenant beszélgetésében, feladatában vagy auditnaplójában,
        hogy a szervezet átnézhesse az ügynök munkáját. Nem tartunk fenn másodlagos, teljes
        archívumot a felhasználó Gmail-fiókjáról vagy Google Drive-járól.
      </p>
      <p>
        A fiók- és munkatér-adatokat az Európai Unióban vagy az üzemeltető által szerződésesen
        védett infrastruktúrán tároljuk. Az adat úton TLS-t használ. Nyugalmi állapotban a
        tárhely- és adatbázis-feldolgozók szabványos titkosítása védi.
      </p>

      <h2>6. Hogyan osztjuk meg, továbbítjuk vagy hozzuk nyilvánosságra a Google-felhasználói adatokat</h2>
      <p>
        Google-felhasználói adatot harmadik félnek nem adunk át az Excellence AI felhasználó felé
        látható funkcióinak nyújtásán vagy javításán kívül, kivéve ha azt jogszabály vagy
        biztonsági vizsgálat megköveteli.
      </p>
      <p>Címzettek, akik a kért feladat elvégzéséhez releváns adatot kaphatnak:</p>
      <ul>
        <li>
          <strong>A tenantban beállított nyelvi modell szolgáltatói</strong> (például OpenAI,
          Anthropic, Google vagy xAI): a futáshoz szükséges promptszöveg és csatolt tartalom.
          Adatvédelmi kapu a tenant szabálya szerint tokenizálhatja vagy blokkolhatja az érzékeny
          mezőket (például nevek, e-mailek, telefonszámok, titkok) a kimenet előtt.
        </li>
        <li>
          <strong>Clerk</strong> — az Excellence AI-fiók beléptetése és munkamenet-kezelése (nem
          a Google-postafiók).
        </li>
        <li>
          <strong>Google Cloud / Firebase App Hosting és adatbázis-feldolgozók</strong> —
          tárhely, titkosított tárolás és üzemeltetési infrastruktúra alfeldolgozóként.
        </li>
        <li>
          <strong>A megrendelő szervezet</strong> — a tenant adminisztrátorai és jogosult
          munkatársai láthatják a saját tenantjuk beszélgetéseit, jóváhagyásait és auditnaplóit.
          Más tenant nem.
        </li>
      </ul>
      <p>
        Google-felhasználói adatot nem adunk el adatbrókereknek. Nem továbbítjuk hirdetési
        platformokra. Az Excellence Pay munkatársai Google-felhasználói adathoz csak biztonság,
        visszaélés-vizsgálat, jogi kötelezettség, vagy a felhasználó / tenant-adminisztrátor által
        kért támogatás miatt férhetnek hozzá.
      </p>

      <h2>7. Adatvédelmi mechanizmusok</h2>
      <p>Biztonsági eljárások védik az adatok bizalmasságát:</p>
      <ul>
        <li>TLS-titkosítás úton az alkalmazáshoz és a Google API-hívásokhoz;</li>
        <li>OAuth access- és refresh-tokenek titkosított, szerveroldali tárolása;</li>
        <li>tenant-elkülönítés, hogy egy szervezet ne olvashassa a másikét;</li>
        <li>
          hozzáférés-szabályozás, szerepkör-alapú jogosultság és emberi jóváhagyási kapu érzékeny
          kimenő műveletek előtt (például e-mail küldése vagy Drive-fájl megosztása);
        </li>
        <li>
          adatvédelmi kapu, amely álnevesítheti vagy blokkolhatja az érzékeny mezőket, mielőtt a
          tartalom külső modellhez menne;
        </li>
        <li>auditnapló az ügynökfutásokról, csatlakozóhasználatról és adminisztratív változásokról;</li>
        <li>nincs Domain-wide Delegation, és nincs végfelhasználó megszemélyesítése szolgáltatásfiókkal.</li>
      </ul>

      <h2>8. Megőrzés és törlés</h2>
      <p>
        A személyes adatot addig őrizzük, amíg e tájékoztató céljaihoz szükséges, kivéve ha
        hosszabb időt jogszabály ír elő vagy enged. A megőrzési idő lejártakor töröljük vagy
        anonimizáljuk.
      </p>
      <ul>
        <li>
          <strong>Google OAuth-tokenek:</strong> csak a Google-kapcsolat idejére. Ha a Google-t
          az Excellence AI fiókbeállításaiban bontod, a tárolt tokeneket töröljük, és nem hívjuk
          tovább a Google API-t.
        </li>
        <li>
          <strong>Visszavonás Google-nál:</strong> az Excellence AI a{' '}
          <a href="https://myaccount.google.com/permissions">
            https://myaccount.google.com/permissions
          </a>{' '}
          oldalon is visszavonható.
        </li>
        <li>
          <strong>Munkatér-tartalom:</strong> a megrendelői szerződés idejére, majd a szerződés
          és a jogi megőrzési kötelezettségek szerint törölve vagy anonimizálva.
        </li>
        <li>
          <strong>Auditnaplók:</strong> a szerződéses biztonsági megőrzési ideig, majd törölve
          vagy összesítve.
        </li>
      </ul>
      <p>
        Törlést kérhetsz a <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>{' '}
        címen vagy a tenant-adminisztrátorodon keresztül. A törlési kérelmeket a jogi és
        biztonsági megőrzési korlátok mellett teljesítjük.
      </p>

      <h2>9. A Google-felhasználói adatok korlátozott használata (Limited Use)</h2>
      <p>
        Az Excellence AI a Google API-kból kapott információt a{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , beleértve a Limited Use követelményeket, szerint használja.
      </p>
      <p>
        A Google Workspace API-adatot csak az Excellence AI-ban látható, felhasználó felé szóló
        funkciók nyújtására vagy javítására használjuk. Google-felhasználói adatot nem adunk
        tovább, kivéve e funkciók nyújtását a felhasználó hozzájárulásával, biztonságot,
        jogszabályi kötelezettséget, vagy egyesülést / értékesítést előzetes, kifejezett
        hozzájárulás után. Google Workspace API-t nem használunk nem személyre szabott AI és/vagy
        ML modellek fejlesztésére, javítására vagy tanítására.
      </p>

      <h2>10. Jogalap és jogaid</h2>
      <p>
        A kezelés jogalapja a szerződés teljesítése (a szolgáltatás nyújtása), jogos érdek
        (biztonság, audit, visszaélés megelőzése), és — a Google API-hozzáférésnél — a
        hozzájárulásod, amelyet a Google-fiók bontásával bármikor visszavonhatsz.
      </p>
      <p>
        Kérheted a hozzáférést, helyesbítést, törlést, korlátozást, hordozhatóságot, és tiltakozhatsz
        a jogos érdeken alapuló kezelés ellen. Panaszt tehetsz a Nemzeti Adatvédelmi és
        Információszabadság Hatóságnál (NAIH). Kapcsolat:{' '}
        <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>.
      </p>

      <h2>11. Gyermekek</h2>
      <p>
        Az Excellence AI üzleti munkatér a megrendelő szervezetek meghívott, felnőtt tagjainak.
        Nem irányul 16 év alattiakra, és tudtunkkal nem gyűjtünk Google-felhasználói adatot
        gyermekektől.
      </p>

      <h2>12. Változások</h2>
      <p>
        Ha megváltozik, hogyan használja az Excellence AI a Google-felhasználói adatokat, ezt a
        tájékoztatót frissítjük, és a szükséges módon értesítjük a felhasználókat, ideértve a
        hozzájárulás újbóli kérését, mielőtt a Google-felhasználói adatot új módon használnánk.
      </p>
    </div>
  )
}

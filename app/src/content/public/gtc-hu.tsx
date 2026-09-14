import { Link } from '@/i18n/navigation'

export function GtcHu() {
  return (
    <div lang="hu">
      <p>
        Ezek az általános szerződési feltételek („ÁSZF”) az <strong>Excellence Pay Kft.</strong>{' '}
        („szolgáltató”) által a <Link href="/">https://ai.excellencepay.com</Link> címen
        üzemeltetett <strong>Excellence AI</strong> platformra vonatkoznak. Az adatkezelést a{' '}
        <Link href="/privacy">adatvédelmi tájékoztató</Link> szabályozza.
      </p>

      <h2>1. A szolgáltatás</h2>
      <p>
        Az Excellence AI kontrollált vállalati AI-munkatárs platform. A megrendelő szervezet
        (tenant) meghívott munkatársai AI-ügynököket indíthatnak, feladatot adhatnak nekik,
        csatlakoztathatnak eszközöket (például Gmail vagy Google Drive), és a jogosultságuk szerint
        jóváhagyhatnak érzékeny műveleteket. A platform nem nyilvános, bárki által regisztrálható
        fogyasztói szolgáltatás: a belépés meghívásos.
      </p>

      <h2>2. Szerződéskötés és fiók</h2>
      <ul>
        <li>A szervezet a szolgáltatóval külön megrendelés vagy előfizetés alapján szerződik.</li>
        <li>
          A felhasználó a meghívó elfogadásával és a belépéssel elfogadja ezt az ÁSZF-et és az
          adatvédelmi tájékoztatót.
        </li>
        <li>
          A fiók személyes. A belépési adatokat tilos megosztani. A szervezet adminisztrátora
          visszavonhatja a hozzáférést.
        </li>
      </ul>

      <h2>3. Elfogadható használat</h2>
      <p>A felhasználó és a szervezet felelős azért, hogy az Excellence AI-t jogszerűen használja. Tilos:</p>
      <ul>
        <li>mások fiókjához vagy adatahoz jogosulatlanul hozzáférni,</li>
        <li>a platformot visszaélésre, jogsértő tartalom előállítására vagy rejtett adatkinyerésre használni,</li>
        <li>
          a csatlakoztatott Google- vagy egyéb fiókokat a tulajdonos hozzájárulása nélkül
          használni,
        </li>
        <li>a biztonsági vagy jogosultsági korlátokat megkerülni.</li>
      </ul>
      <p>
        Az AI-ügynök kimenete javaslat. A szervezet felelős a kimenet ellenőrzéséért, mielőtt
        üzleti, jogi vagy ügyfél felé ható lépést tesz. A jóváhagyási kapuk a termék részei, de
        nem helyettesítik a szervezet saját belső kontrolljait.
      </p>

      <h2>4. Csatlakoztatott fiókok (Google és mások)</h2>
      <p>
        A Google-fiók, Gmail vagy Drive csatlakoztatása opcionális. A hozzájárulás a Google
        OAuth-képernyőjén történik. A felhasználó bármikor bonthatja a kapcsolatot az Excellence
        AI-ban és a Google-fiók jogosultságainál. A szolgáltató a Google API-kat a Google
        feltételei és a Limited Use szabályok szerint használja; részletek:{' '}
        <Link href="/privacy">adatvédelmi tájékoztató</Link>.
      </p>
      <p>
        A csatlakoztatott fiókban végzett művelet a felhasználó (és a szervezet) nevében történik.
        Az ügynök csak annyi jogosultsággal dolgozik, amennyit a Google-hozzájárulás, a tenant
        szabálya és az ügynök beállítása együtt megenged.
      </p>

      <h2>5. Szellemi tulajdon</h2>
      <p>
        Az Excellence AI szoftvere, védjegye és dokumentációja a szolgáltatóé. A szervezet
        megtartja a saját adataira, dokumentumaira és a platformba feltöltött tartalomra vonatkozó
        jogait. A szolgáltató a feltöltött tartalmat csak a szolgáltatás nyújtásához használja.
      </p>

      <h2>6. Elérhetőség és felelősség</h2>
      <p>
        A platformot „adott állapotban” nyújtjuk, ésszerű gondossággal. Nem vállalunk helytállást
        a nyelvi modellek tévedéseiért, a külső szolgáltatók (Google, modell-API, beléptetés)
        kieséséért, és a felhasználó által jóváhagyott kimenet üzleti következményeiért. A
        szolgáltató felelőssége a magyar jog által megengedett mértékben a szervezet által az
        adott időszakra fizetett díjra korlátozódik, kivéve a szándékos károkozást és a
        jogszabályban ki nem zárható felelősséget.
      </p>

      <h2>7. Díjak, felmondás</h2>
      <p>
        A díjazást a szervezet és a szolgáltató közötti megrendelés rögzíti. A szervezet a
        szerződése szerint mondhatja fel az előfizetést. A szolgáltató azonnali hatállyal
        felfüggesztheti a hozzáférést, ha a használat jogsértő, a díj nem érkezik meg, vagy a
        platform biztonságát veszélyezteti. Felmondás után a fiók- és munkaterület-adatokra az
        adatvédelmi tájékoztató megőrzési szabályai vonatkoznak.
      </p>

      <h2>8. Irányadó jog</h2>
      <p>
        Az ÁSZF-re a magyar jog irányadó. A felek a hatáskörrel rendelkező magyar bíróságokhoz
        fordulnak, ha a vitát nem tudják egyeztetéssel rendezni.
      </p>

      <h2>9. Kapcsolat</h2>
      <p>
        Excellence Pay Kft. · Excellence AI
        <br />
        Honlap: <Link href="/">https://ai.excellencepay.com</Link>
        <br />
        Adatvédelem: <a href="mailto:privacy@excellencepay.com">privacy@excellencepay.com</a>
      </p>
    </div>
  )
}

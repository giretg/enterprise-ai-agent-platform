# Tulajdoni lap — mezőreferencia és szövegkinyerési buktatók

Ezt akkor olvasd, ha a parsert bővíteni vagy hibázni kell. A szokásos
feldolgozáshoz elég a `scripts/parse_tulajdoni_lap.py` futtatása.

## Tartalom

- [A dokumentum szerkezete](#a-dokumentum-szerkezete)
- [Bejegyzés-anatómia](#bejegyzés-anatómia)
- [A két sablon mezőcímkéi](#a-két-sablon-mezőcímkéi)
- [Bejegyzéstípusok](#bejegyzéstípusok)
- [Szövegkinyerési buktatók](#szövegkinyerési-buktatók)

## A dokumentum szerkezete

Fix sorrend, minden e-hiteles lapon azonos:

| Szakasz | Tartalom |
|---|---|
| fejléc | földhivatal, ügyazonosító (`INYER/TULLAP/<dátum>/<sorszám>`), kelt |
| `SZÉLJEGYZÉK` | folyamatban lévő, még be nem jegyzett beadványok |
| `I. RÉSZ` | az ingatlan fizikai adatai: alrészletek, művelési ág, terület, AK, minőségi osztályok |
| `II. RÉSZ` | tulajdonjogi bejegyzések, sorszámozva 1..N |
| `III. RÉSZ` | terhek és tények, külön sorszámozva 1..M |

A lap végén záró szöveg: *„Az E-hiteles tulajdonilap-másolat tartalma a kiadást
megelőző napig megegyezik…"* — ez jelzi a dokumentum végét.

## Bejegyzés-anatómia

Minden bejegyzés a `Bejegyző határozat, érkezési idő:` sorral kezdődik. Ez a
megbízható elválasztó. Utána:

```
Bejegyző határozat, érkezési idő:
39829/2018.06.04
Törlő határozat              <- OPCIONÁLIS; ha itt van, a bejegyzés MÁR NEM HATÁLYOS
45820/2019.09.02
17.                          <- sorszám: ez választja el a fejléc-dobozt a törzstől
Tulajdonjog                  <- a bejegyzés típusa
Jogállás: TULAJDONOS
Tulajdoni hányad: 46811520/5943372372
Jogcím: részarány kiadás, 2525/2002.06.05
Eredeti határozat: 2525/2002.06.05
Név: Ficzere Tiborné, Születési név: Pap Ilona, Születési év: 1959, Anyja neve: Szalóki Ilona
Jogosult címe: 3327 NOVAJ, Akácfa utca 1/a.
```

**Kritikus:** a „Törlő határozat" a **sorszám előtt**, a fejléc-dobozban áll, nem a
törzsben. A hatályosság-vizsgálatot ezért a sorszám előtti részre kell futtatni —
ha az egész bejegyzésben keresel „Törlő határozat" szöveget, a következő bejegyzés
fejléce is beleszólhat.

## A két sablon mezőcímkéi

A ~2025 őszétől iktatott bejegyzések új sablont használnak. Ugyanaz a fogalom
más címkével szerepel:

| Fogalom | Régi sablon | Új (INYER) sablon |
|---|---|---|
| jogcím | `Jogcím: vétel, 12345/2020.01.01` | `Jogváltozás jogcíme: adásvétel` |
| hányad | `Tulajdoni hányad: 401466240/23773489488` | `Tulajdoni hányad: 3957408 / 23773489488` (szóközökkel!) |
| jogállás | `Jogállás: TULAJDONOS` | `Jogállás: Tulajdonos` |
| hivatkozás | `Utalás: II/319, II/59` | `Utalás a törölt bejegyzésre: II / 224, II / 63.` |
| eredeti | `Eredeti határozat: 2525/2002.06.05` | `Eredeti bejegyzés/szerzés iktatószáma: 50522/2021.11.08` |
| iktatószám | `39829/2018.06.04` | `INYER/2025/125284/4 2025.09.08. 00:00:00` |
| törlő határozat | `45820/2019.09.02` | `INYER/2026/574094/3 2026.05.04. 00:00:00` |

Új sablonban megjelenő, régiben nem létező mezők:

```
A felhívást kiadó hatóság adatai: Dr. Szabó Dávid Zsolt Közjegyzői Irodája
Határozat száma: 33019/N/270/2025/12.
Jog terjedelme: Egész tulajdoni illetőség, Utalás: II / 486
Követelés összege: 962.100 Magyar forint főkövetelés és járulékai erejéig
Változás keletkezésének időpontja: 2021.01.13.
```

**A legfontosabb eltérés a nevek írásmódja:** az új sablon **CSUPA NAGYBETŰVEL**
írja a neveket (`SOLTÉSZ GÁBOR GERGŐ`, anyja `IVÁNOS MÁRTA`), a régi Kezdőbetűsen
(`Soltész Gábor Gergő`, `Ivános Márta`). Ha a tulajdonos-összesítés kulcsa nem
kisbetűsít, **ugyanaz a személy két külön tulajdonosként jelenik meg**, és a
tulajdonrésze megosztva, alábecsülve látszik. Ez a hiba némán történik — az
összeg-validáció **nem** fogja meg, mert a hányad összege így is 1 marad.

## Bejegyzéstípusok

**II. RÉSZ** — a sorszám utáni első sor:

| Típus | Jelentés |
|---|---|
| `Tulajdonjog` | tulajdoni hányad — ez számít bele a tulajdon-összesítésbe |
| `Tulajdonosi jogokat gyakorló szervezet` | régi címke; Magyar Állam hányadához tartozó joggyakorló |
| `Tulajdonosi joggyakorló` | új címke, ugyanaz |
| `Jogállás bejegyzése – tsz. földhasználati jog` | történeti tsz-jog; jellemzően hosszú, egymást felváltó láncban, a végén mind törölve |

Csak a `Tulajdonjog` megy a tulajdon-összesítésbe. A joggyakorló ugyanazt a
hányadot ismétli — ha beszámítod, duplán számolsz.

**III. RÉSZ** — gyakori típusok:

```
Özvegyi jog                                   Végrehajtási jog
Holtig tartó haszonélvezeti jog               Jelzálogjog
Gondnokság alá helyezés                       Zárlat
Jogosult gondnokság alá helyezése             Árverés kitűzése
Jogosult kiskorúsága                          Tulajdoni helyzet rendezetlensége
Közös tulajdon rendezésének kötelezettsége    Eljárás megszüntetése
Önálló szöveges bejegyzés                     Ingatlan-nyilvántartási eljárás megszüntetése
A föld tulajdonjogának átruházására irányuló szerződés benyújtása
```

Ez a lista nem teljes és nem is lesz az — a földhivatal újakat vezethet be.
A parser ezért nem fix listával dolgozik, hanem a sorszám utáni első sort veszi
típusnak, és a nyers szöveget is megőrzi (`raw` mező).

## Szövegkinyerési buktatók

**Oldal-szemét.** Minden oldalon ismétlődik a fejléc (földhivatal neve, cím,
ügyazonosító, `Oldal N/237`, település, hrsz) és a lábléc
(`Folytatás a következő oldalon` / `Folytatás az előző oldalról`). A parser úgy
találja meg a fejlécet, hogy **soronként összehasonlítja az oldalakat**, és amelyik
sor mindegyiken azonos, az fejléc — ez általánosabb, mint egy adott földhivatal
fejlécére illeszteni, és más lapokon is működik.

**Oldalhatáron átlógó bejegyzések.** A bejegyzések nem igazodnak oldalhatárhoz.
Ezért a helyes sorrend: szemét eltávolítása → **az összes oldal egyetlen szöveggé
fűzése** → csak utána bontás bejegyzésekre. Ha oldalanként parse-olsz, a határon
lévő bejegyzések csonkulnak.

**Nem mindig szóköz.** Néhol dupla szóköz van a címke után (`Név:  AGRÁRMINISZTÉRIUM`),
a hányadban lehet szóköz a per-jel körül. A regexeknek toleránsnak kell lenniük.

**Ékezetes kisbetűsítés.** A magyar ékezetes karaktereknél `.lower()` helyett
`.casefold()` a helyes, és érdemes a szóközöket is normalizálni, mielőtt
névkulcsot képzel.

**A validáció nem mindenható.** A hányadösszeg = 1 próba a hatályos/törölt
szétválasztást és a törtek kiolvasását ellenőrzi. **Nem** fogja meg a
név-összevonási hibákat, a rossz típus-besorolást vagy a hiányzó címeket — ezekre
külön kell figyelni (pl. nézd meg, van-e csupa nagybetűs név a tulajdonosok közt,
ami kisbetűs párral is szerepel).

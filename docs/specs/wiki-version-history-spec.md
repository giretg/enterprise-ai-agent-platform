# Feature-spec — Wiki-előzmények: változás-nézet, visszaállítás, időutazás, megőrzés és GDPR-törlés

**Verzió:** 1.0
**Dátum:** 2026-10-26
**Státusz:** fejlesztésre kész
**GitHub issue:** [#978](https://github.com/giretg/enterprise-ai-agent-platform/issues/978)
**Előzmény:** LLM Wiki EPIC [#941](https://github.com/giretg/enterprise-ai-agent-platform/issues/941) (#942–#947, #965, #968)
**Célközönség:** product, tenant-admin, security/compliance és fejlesztők

## 0. Vezetői döntés

**A probléma:** az agent-wiki folyamatosan változik: agentek írják, emberek hagyják jóvá. Az oldalak minden verziója ma is megmarad, de nem lehet összevetni őket, nem lehet visszaállni egy korábbira, és nem lehet megnézni, mit tudott a wiki egy korábbi napon. Az agent sem látja, mi változott, mióta utoljára dolgozott a wikin. A régi verziók ráadásul korlátlanul gyűlnek: nincs megőrzési szabály, és nincs mód arra, hogy egy személyes adatot minden korábbi verzióból is auditáltan kitöröljünk.

**A javaslat:** „git-szerű” előzmény-réteg a **meglévő adatbázis-táblákra**. A change-set a commit, az oldal-revízió a fájl-előzmény. Ezt egészítjük ki változás-nézettel, visszaállítással, wiki-szintű sorszámmal (időutazás), agent-oldali változáslistával, címkékkel, megőrzési szabállyal és auditált GDPR-törléssel.

**Elvetve: valódi git-backend** (isomorphic-git, bare repo GCS-ben, GitHub-tükör). Elveszne a tenant-szűrés, a wiki-jogkezelés, a jóváhagyási út és az audit, amit már a DB-re építettünk. Egy új tárolót is üzemeltetni kellene, és a GDPR-törlés git-ben (history rewrite) a legnehezebb művelet. A meglévő ZIP-export (`WikiConsoleService.exportZip`) kielégíti a „vigyem ki markdownban” igényt.

**Elvetve: ágak (branch) és merge.** A jóváhagyásra váró change-set már most PR-ként működik.

## 1. Cél és scope

### 1.1 In scope — v1

1. **Változás-nézet:** két tetszőleges oldalverzió összevetése, és egy teljes change-set nézete (mi változott egy módosításban).
2. **Visszaállítás:** egy oldal visszaállítása egy korábbi verzióra, illetve egy teljes change-set visszavonása. Mindkettő új change-setként íródik, a régiek nem törlődnek.
3. **Wiki-szintű sorszám és időutazás:** minden alkalmazott change-set kap egy wikin belül növekvő sorszámot. A wikit meg lehet nézni egy adott dátumon vagy sorszámon érvényes állapotában.
4. **Agent-változáslista:** új MCP-eszköz (`kb_wiki_changes`) és egy jelzés a briefingben arról, hány módosítás történt az agent legutóbbi átnézése óta. A lista összefoglaló, diffet nem tartalmaz.
5. **Címkék:** egy wiki-állapot elnevezése (pl. „Q3 audit előtti állapot”). A címkézett állapotot a ritkítás nem törli.
6. **Megőrzés és ritkítás:** wikinként állítható, mennyi ideig őrizzük meg a régi verziókat. Napi takarító ritkítja, majd törli őket.
7. **GDPR-törlés:** egy tartalom auditált, végleges kitörlése az aktuális oldalból, az összes régi verzióból és minden másolatból.

### 1.2 Out of scope — v1

- Valódi git, ágak, merge, GitHub-tükör (lásd 0.).
- **Nyers források verziózása** (`Document`). Egy frissített forrás új dokumentumként érkezik, ahogy ma is. A GDPR-törlés viszont a nyers forrásokra is kiterjed (§7).
- A `WIKI.md` (séma) verziózása. A változását most is a `kb.wiki.schema.changed` audit-esemény rögzíti.
- Emberi „újdonságok” olvasási jelzés a konzolon. v1-ben csak az agentnek van ilyen.
- Keresés régi verziókban. A `kb_search` index (`KnowledgeChunk`) továbbra is csak az aktuális állapotot tartalmazza.
- Szöveg-szintű diff az MCP-n (D4).

## 2. Mi van már meg (main, 2026-10-26)

| Szükséglet | Meglévő elem | Hiány |
|---|---|---|
| commit | `WikiChangeSet` (`pending`/`applied`/`rejected`/`reverted`), `pages` JSON, `logEntry`, `approverScope` | nincs wiki-szintű sorszám; a `reverted` állapotot és a `revert` log-opot semmi nem állítja be |
| fájl-előzmény | `WikiPageRevision` (`pageId`, `version`, `title`, `summary`, `body`, `frontmatter`, `contentHash`, `changeSetId`) | nincs benne `path` és `status`, így egy áthelyezés vagy archiválás korábbi állapota nem rekonstruálható |
| ütközés | `baseVersion` és `expectedVersion` az `applyChangeSet`-ben → `conflict` | — |
| diff | `diffLines` (`@/lib/text-line-diff`), a jóváhagyó kártya már használja (`getChangeSetReview`) | verziók közötti diff nincs |
| előzmény-UI | „Előzmények (N)” lenyíló az oldalon (`control-plane/knowledge/[connectorId]/page.tsx:241`) | csak lista: nincs megnyitás, diff és visszaállítás |
| audit | `kb.wiki.changeset.reverted` már szerepel az `event-catalog`-ban | nincs írója |
| export | `exportZip` → `kb.wiki.exported` | — |
| törlés | privát KB 30 napos sweep és `purge` (a revíziókat is törli); `knowledgeBase.deleteDocument` | nincs tartalom-szintű, revíziókon átívelő törlés |
| ütemezett futás | napi `ai-audit-retention` belső route (Cloud Scheduler) | — |

**Fontos lelet:** a tartalom ma **három helyen** is megvan: `WikiPage` (aktuális), `WikiPageRevision` (minden verzió) és `WikiChangeSet.pages` (a javasolt oldalak teljes szövege, alkalmazás után is). A megőrzésnek és a GDPR-törlésnek mindhármat kezelnie kell, a `WikiLogEntry.title`/`note` mezőt és a jóváhagyásra váró `GatewayOperation` argumentumát is (§6, §7).

## 3. Döntések

| # | Döntés | Indoklás |
|---|---|---|
| **D1** | **Megőrzés: wikinként állítható ritkítás + auditált GDPR-törlés.** Két érték: „minden verzió megmarad ennyi ideig” (alapértelmezés 90 nap) és „régi verziók törlése ennyi idő után” (alapértelmezés 365 nap, lehet „soha”). A kettő között oldalanként naponta egy verzió marad. Mindig megmarad: az aktuális verzió, oldalanként a legutóbbi 5, a címkézett állapotok verziói és azok, amelyekre jóváhagyásra váró change-set hivatkozik. | A felhasználó döntése (10-26). A minimum-szabályok miatt a visszaállítás mindig működik a közelmúltra. |
| **D2** | **Visszaállítást kezdeményezhet a wiki jóváhagyója és a tenant-admin közvetlenül, az agent pedig jóváhagyással.** Az agent visszaállítása **mindig** jóváhagyásra vár, akkor is, ha egyébként szabadon írhatja a wikit (`wikiWriteMode`). | A felhasználó döntése (10-26). A visszaállítás egyszerre sok oldalt érinthet, és könnyű vele jó tudást eldobni. |
| **D3** | **Nyers források: v1-ben nincs verziózás.** | A felhasználó nem döntött róla (10-26), ez az alapértelmezés. Lásd §11, Q1. |
| **D4** | **Az agent változáslistát kap összefoglalóval, diffet nem.** Tartalma: sorszám, időpont, szerző, a log-bejegyzés címe és megjegyzése, valamint oldalanként útvonal, művelet, cím és sorstatisztika (+12/−3). A részletekért az agent a `kb_get_page`-et hívja. | A felhasználó döntése (10-26). Token-költség. |
| **D5** | **A visszaállítás új change-set, amely nem írja át az előzményt.** A visszavont change-set állapota `reverted` lesz, és hivatkozik az új change-setre. | Az audit-lánc ép marad, és a visszaállítás is visszavonható. |
| **D6** | **A sorszám az alkalmazáskor születik, nem a beküldéskor.** | A jóváhagyásra váró change-setek más sorrendben alkalmazódhatnak, mint ahogy beérkeztek. A sorszám a wiki tényleges állapotsorát követi. |
| **D7** | **Minden oldal-írás change-seten keresztül megy.** A `createPage`/`updatePage` közvetlen hívóit (ha vannak `changeSetId` nélkül) szintetikus, azonnal alkalmazott change-setbe csomagoljuk. | Különben az időutazás és a változáslista lyukas. |
| **D8** | **Ütköző visszaállítás: mindent vagy semmit.** Ha egy change-set visszavonásakor egy érintett oldalt azóta más is módosított, a visszavonás nem fut le. A UI megmutatja az ütköző oldalakat, és oldalanként felajánlja a visszaállítást. | Nem kell félig visszavont állapottal foglalkozni, és az oldalankénti út mindig elérhető. |
| **D9** | **A GDPR-törlés helyén sír-jel (tombstone) marad, nem lyuk.** A revízió sora megmarad üres tartalommal, `erasedAt`/`erasureId` mezővel, és a `contentHash` is megmarad. | Az idővonal és a verziószámok folytonosak maradnak, az audit pedig hash alapján igazolja, mi törlődött, a tartalom nélkül. |
| **D10** | **GDPR-törlést közös wikiben a tenant-admin indíthat, privát wikiben csak a tulajdonos.** Kötelező indoklás, előnézet és begépelt megerősítés. | A privát KB tartalmát az admin nem látja (D13 / #942). |

## 4. Adatmodell (migráció `00NN_wiki_version_history`)

```prisma
model WikiChangeSet {
  // + meglévő mezők
  seq             Int?      // D6: alkalmazáskor, wikin belül növekvő; pending/rejected = null
  revertsId       String?   @map("reverts_id") @db.Uuid      // ezt a change-setet vonja vissza
  revertedById    String?   @map("reverted_by_id") @db.Uuid  // ez vonta vissza
  pagesPrunedAt   DateTime? @map("pages_pruned_at") @db.Timestamptz // §6: a pages JSON tartalma kiürítve
  @@unique([wikiId, seq])
}

model WikiPageRevision {
  // + meglévő mezők
  path        String?                         // áthelyezés rekonstruálásához; backfill: aktuális path
  status      WikiPageStatus?                 // archiválás rekonstruálásához; backfill: published
  createdByAgentId String? @map("created_by_agent_id") @db.Uuid
  createdByUserId  String? @map("created_by_user_id") @db.Uuid
  erasedAt    DateTime? @map("erased_at") @db.Timestamptz   // D9
  erasureId   String?   @map("erasure_id") @db.Uuid
  @@index([pageId, createdAt])
}

model AgentWiki {
  // + meglévő mezők
  nextSeq                Int  @default(1) @map("next_seq")
  retentionFullDays      Int  @default(90)  @map("retention_full_days")   // D1
  retentionDeleteDays    Int? @default(365) @map("retention_delete_days") // null = soha
}

model WikiTag {
  id        String   @id @default(uuid()) @db.Uuid
  wikiId    String   @map("wiki_id") @db.Uuid
  name      String
  note      String?
  seq       Int                                   // erre az állapotra mutat
  createdByUserId String @map("created_by_user_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz
  @@unique([wikiId, name])
  @@map("wiki_tags")
}

model WikiReadCursor {           // §5.4: agent „legutóbb látott” sorszáma
  wikiId    String @map("wiki_id") @db.Uuid
  agentId   String @map("agent_id") @db.Uuid
  userId    String @map("user_id") @db.Uuid
  seenSeq   Int    @map("seen_seq")
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz
  @@id([wikiId, agentId, userId])
  @@map("wiki_read_cursors")
}

model WikiErasure {              // §7, tartalom nélkül
  id          String   @id @default(uuid()) @db.Uuid
  wikiId      String   @map("wiki_id") @db.Uuid
  connectorId String   @map("connector_id") @db.Uuid
  requestedBy String   @map("requested_by") @db.Uuid
  reason      String                        // jogalap / ügyszám, szabad szöveg, PII nélkül
  scope       Json                          // { kind, pageIds?, revisionIds?, documentIds?, matchHash? }
  counts      Json                          // érintett sorok darabszáma táblánként
  erasedHashes String[] @map("erased_hashes") // törölt revíziók contentHash-e
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
  @@map("wiki_erasures")
}
```

**Backfill:** a meglévő `applied` change-setek `appliedAt`, majd `createdAt` szerinti sorrendben kapnak `seq`-et. A revíziók `path`/`status` mezője a lap aktuális értékét kapja. Ez a régi áthelyezéseknél pontatlan; a UI a migráció előtti időpontokra ezt jelzi: „az áthelyezések a bevezetés előtt nem pontosak”. A `nextSeq` = max(seq)+1.

**Sorszám-kiosztás:** az `applyChangeSet` tranzakcióján belül `UPDATE agent_wikis SET next_seq = next_seq + 1 … RETURNING`. Ez sor-zárat ad, így két párhuzamos alkalmazás nem kaphat azonos számot.

## 5. Funkciók

### 5.1 Változás-nézet (konzol)

- Az oldal „Előzmények” panelje lista helyett **idővonal**: verzió, időpont, szerző (agent neve vagy felhasználó), a change-set log-címe és sorszáma (`#128`), valamint a címkék.
- Bármely verzió **megnyitható** olvasásra („Így nézett ki október 3-án”), egy sávval: „Ez egy korábbi verzió. [Aktuális megnyitása] [Visszaállítás erre]”.
- **Összevetés:** alapértelmezés szerint az előző verzióval; két verzió kijelölésével tetszőleges párra. A törzs sor-diffet kap (`diffLines`), a cím, az összefoglaló és a források mezőnkénti „volt → lett” sort.
- **Change-set nézet** (`/control-plane/knowledge/[connectorId]/changes/[seq]`): a jóváhagyó kártya komponensét használja újra (`getChangeSetReview`), csak olvasó módban, és innen indítható a visszavonás.
- **Wiki-szintű „Változások” fül:** az alkalmazott change-setek sorszám szerint csökkenő sorrendben, szűrhető szerzőre és dátumra.

### 5.2 Visszaállítás

Két művelet, mindkettő a meglévő `applyChangeSet` útján fut:

| Művelet | Generált műveletek |
|---|---|
| **Oldal visszaállítása N. verzióra** | egy `upsert` a revízió tartalmával (`title`, `summary`, `body`, `frontmatter`), `path`/`status` visszaállítással, `baseVersion` = aktuális verzió |
| **Change-set visszavonása** | oldalanként az inverz: létrehozott → `archive`; módosított → `upsert` az előző revízióra; archivált → visszaállítás `published`-re; áthelyezett → `move` vissza. Mindegyik `baseVersion` = a visszavont change-set utáni verzió (D8). |

- Ki indíthatja: D2. Ember a konzolról a megszokott megerősítő ablakkal („3 oldal változik vissza. [Előnézet] [Visszaállítás]”), és ez azonnal alkalmazódik. Az agent az új `kb_wiki_revert` eszközzel indít; ez **mindig** `pending` change-setet és jóváhagyó linket ad (`approverScope` = a wiki meglévő jóváhagyója).
- A visszaállító change-set `logEntry.op = 'revert'`, a `revertsId` mezője kitöltve. Alkalmazáskor a visszavont change-set állapota `reverted` lesz, a `revertedById` mezője kitöltve, és megy a `kb.wiki.changeset.reverted` audit.
- Egy visszavonás visszavonása (redo) ugyanez a művelet a visszaállító change-seten.
- Sír-jeles (GDPR-törölt) revízióra nem lehet visszaállni. A gomb le van tiltva, mellette a magyarázat: „Ezt a verziót adatvédelmi okból töröltük.”
- A ritkítás által már törölt verzió nem jelenik meg az idővonalon.

### 5.3 Időutazás

- A „Változások” fülön és a wiki fejlécén egy dátum- és sorszám-választó: „Állapot ekkor: [2026-10-01 ▾]”. Ilyenkor a wiki **csak olvasható** nézetben jelenik meg: az index, az oldalak és a linkek az adott állapotot mutatják, felül sávval: „Így nézett ki a wiki 2026-10-01-én (#97). [Vissza a mostanihoz]”.
- Az állapot számítása: minden oldalra a legutolsó olyan revízió, amelynek change-setje `seq ≤ S`. Archivált (`status = archived`) oldal nem látszik. Nem létező oldal (még nem született meg) nem látszik.
- Ha a ritkítás miatt a pontos állapot már nincs meg, a legközelebbi korábbi megőrzött verzió jelenik meg, és a sáv ezt jelzi: „Néhány oldal ebből az időszakból csak napi felbontásban maradt meg.”
- Az MCP-n `kb_get_page` kap egy opcionális `asOf` paramétert (sorszám vagy ISO-dátum), így az agent egy oldal korábbi állapotát is ki tudja olvasni („Mi volt a laborérték-összefoglaló szeptemberben?”). Az `index.md` `asOf`-fal az akkori indexet generálja.

### 5.4 Agent-változáslista

Új MCP-eszköz, olvasás-jog kell hozzá (`wikiAccess ≥ read`):

```
kb_wiki_changes { wikiId, since?: number | "last_seen", limit?: number (≤50), markSeen?: boolean = true }
→ { latestSeq, sinceSeq, truncated, changes: [{
     seq, appliedAt, author: { kind: agent|user, name }, op, title, note?,
     reverts?: seq,
     pages: [{ path, action: created|updated|archived|moved|restored, title, linesAdded, linesRemoved, fromPath? }]
   }] }
```

- `since` alapértéke `"last_seen"`, vagyis a `WikiReadCursor` értéke a (wiki, agent, user) hármasra. Ha nincs cursor, az utolsó 10 change-set jön.
- `markSeen: true` esetén a cursor a visszaadott legnagyobb `seq`-re lép.
- **Briefing:** a `listWikis` sorai kapnak egy `changes: { latestSeq, unseen }` mezőt, ha `unseen > 0`. Az eszközleírás és a briefing-szöveg alapján az agent a munka elején egyszer hívja meg (pl. „7 új módosítás a legutóbbi átnézés óta, hívd a kb_wiki_changes-t”).
- Privát wikiben a változások csak a tulajdonos munkamenetében jelennek meg (a meglévő `isKnowledgeBaseVisibleTo` szűrés).
- A `pages` lista change-setenként legfeljebb 50 elem (a change-set maximuma is 50).

### 5.5 Címkék

- A konzolon a „Változások” fülön egy sorszámra: „Állapot elnevezése…” → név és megjegyzés. Szerkesztő vagy admin hozhatja létre, és ugyanők törölhetik is.
- A címke a sorszámot rögzíti, és megvédi a ritkítástól azokat a revíziókat, amelyek ezen a sorszámon érvényesek voltak (§6).
- Az időutazás-választóban a címkék is szerepelnek.
- A ZIP-export opcionálisan egy címke szerinti állapotot is tud exportálni („Exportálás ebben az állapotban”).
- v1-ben az agent nem hoz létre címkét.

## 6. Megőrzés és ritkítás (D1)

**Beállítás:** a wiki „Beállítások” fülén, közérthető szöveggel:

> **Régi verziók megőrzése**
> Minden verzió megmarad ennyi ideig: [90 nap ▾]
> Utána naponta egy verzió marad, és ennyi idő után a régi verziók törlődnek: [1 év ▾] (lehet „Soha”)
> *Az aktuális oldal, oldalanként a legutóbbi 5 verzió és az elnevezett állapotok mindig megmaradnak.*

Választható értékek: 30 / 90 / 180 nap és 1 év a teljes előzményre; 90 nap / 1 / 2 / 5 év és „Soha” a törlésre. A törlés ideje nem lehet rövidebb a teljes előzmény idejénél. Módosíthatja a tenant-admin, privát wikinél a tulajdonos. Minden módosítás auditált (`kb.wiki.retention.changed`).

**Takarító:** napi feladat a meglévő `ai-audit-retention` route-ban, a privát-KB sweep mellett. Wikinként, kötegelve (≤ 1000 revízió / wiki / futás, hogy ne fogyjon el a Neon-pool):

1. **Ritkítás:** a `retentionFullDays`-nél régebbi, `retentionDeleteDays`-nél újabb revíziókból oldalanként és naptári naponként csak a nap utolsó revíziója marad.
2. **Törlés:** a `retentionDeleteDays`-nél régebbi revíziók törlődnek.
3. **Mindig megmarad (védett):** az aktuális verzió; oldalanként a legutóbbi 5; minden címke `seq`-jén érvényes revízió; minden `pending` change-set `baseVersion`-je; a sír-jelek (D9, mert ezek az audit igazolásai).
4. **Change-set tartalom kiürítése:** a `retentionFullDays`-nél régebbi `applied`/`rejected`/`reverted` change-setek `pages` JSON-jából kikerül a `body`/`frontmatter`/`summary`, csak az útvonal, a művelet és a cím marad. Beáll a `pagesPrunedAt`. A sor metaadata (szerző, időpont, `seq`, log-cím) megmarad, így a „Változások” lista és a `kb_wiki_changes` hiánytalan marad.
5. Futás végén egy `kb.wiki.retention.swept` audit-esemény darabszámokkal, tartalom nélkül.

A diff-statisztika (`linesAdded`/`linesRemoved`) az alkalmazáskor kiszámolódik, és bekerül a change-set `pages` összefoglalójába. Így a kiürítés után is megmarad.

## 7. GDPR-törlés (D9, D10)

**Folyamat a konzolon** („Beállítások” → „Adatvédelmi törlés”):

1. **Mit keresünk:** (a) kijelölt oldal(ak) **teljes előzménye**; (b) egy kijelölt **verzió**; vagy (c) **szöveg-előfordulás**: egy név, azonosító vagy más kifejezés minden helyen.
2. **Előnézet:** a rendszer kilistázza a találatokat helyenként. Ezek: aktuális oldal, régi verziók, change-set tartalmak (jóváhagyásra várók is), log-bejegyzések, nyers források (`Document.extractedText` és eredeti fájl), keresési index (`KnowledgeChunk`), és jóváhagyásra váró `GatewayOperation` argumentumok. A (c) esetben az előnézet mutatja a környező szöveget.
3. **Mód:** kifejezés-találatnál *kitakarás* (a kifejezés helyére `[törölve]` kerül) vagy *teljes törlés* (az érintett verzió sír-jellé válik). Oldal- és verzió-módban csak teljes törlés van. A nyers forrás teljes törlése a meglévő `knowledgeBase.deleteDocument` úton megy.
4. **Indoklás** (kötelező, szabad szöveg, pl. ügyszám; a UI figyelmeztet, hogy ide ne kerüljön személyes adat) és **megerősítés** a wiki nevének begépelésével.
5. **Végrehajtás egy tranzakcióban.** Ha az aktuális oldal is érintett, egy szintetikus change-set (`op = note`, cím: „Adatvédelmi törlés”) írja az új verziót, és az indexet újraépíti. A régi verziók sír-jellé válnak, illetve kitakarás esetén a szövegük cserélődik, és új `contentHash`-t kapnak.
6. **Audit:** `WikiErasure` sor és `kb.wiki.erasure.executed` audit-esemény: ki, mikor, indoklás, scope, darabszámok, a törölt revíziók `contentHash`-e. **A törölt tartalom és a keresett kifejezés nem kerül az auditba.** A (c) módnál a kifejezés helyett annak sózott hash-e (`matchHash`) tárolódik.

**Mi nem törölhető így:** az audit-napló meglévő bejegyzései. Ezek ma sem tartalmaznak oldal-tartalmat (`redactKbAuditForVisibility`). Ha egy régi bejegyzésben mégis lenne személyes adat, az a meglévő audit-retention hatásköre. Az ellenőrzés a WP-0 része.

**Exportok:** a korábban letöltött ZIP-ek a platformon kívül vannak. A törlés-képernyő ezt egy mondatban jelzi.

## 8. Jogosultság és biztonság

| Művelet | Közös wiki | Privát wiki |
|---|---|---|
| előzmény, diff, időutazás olvasása | aki a wikit látja (`view`) | csak a tulajdonos |
| oldal-visszaállítás, change-set visszavonása (ember) | a wiki jóváhagyója (`approverScope`) és a tenant-admin | a tulajdonos |
| visszaállítás (agent, `kb_wiki_revert`) | `wikiAccess: write` kell; mindig jóváhagyásra vár (D2) | ua., a jóváhagyó a tulajdonos |
| `kb_wiki_changes`, `kb_get_page asOf` | `wikiAccess ≥ read` | ua. + tulajdonos-munkamenet |
| címke | szerkesztő, admin | tulajdonos |
| megőrzési beállítás | tenant-admin | tulajdonos |
| GDPR-törlés | tenant-admin | tulajdonos |

- Minden új lekérdezés `connectorId`-re szűr (D-B / #942), a sorszám és a revízió-id nem elég.
- Az `asOf` olvasás ugyanazt a `resolveWikiTarget` + láthatóság-ellenőrzést futtatja, mint a jelenlegi `kb_get_page`. Ismeretlen vagy nem látható → `not_found`.
- Új audit-események az `event-catalog`-ba: `kb.wiki.changeset.revert_requested`, `kb.wiki.page.restored`, `kb.wiki.tag.created`, `kb.wiki.tag.deleted`, `kb.wiki.retention.changed`, `kb.wiki.retention.swept`, `kb.wiki.erasure.executed`. A meglévő `kb.wiki.changeset.reverted` író-oldalt kap.
- A `kb_wiki_revert` write-kind, ezért regisztrálni kell az írás-kapuban, és a `skipsWriteApproval` **soha** nem engedi át (D2).

## 9. Munkacsomagok

| WP | Tartalom | Függ |
|---|---|---|
| **WP-0** | Felmérés: van-e `changeSetId` nélküli oldal-író út (D7); audit-bejegyzésekben van-e oldal-tartalom; a `pages` JSON-t olvasó helyek listája. | — |
| **WP-1** | Migráció (§4), backfill, sorszám-kiosztás az `applyChangeSet`-ben, `path`/`status`/szerző a revízióba, diff-statisztika a change-setbe; D7 csomagolás. | WP-0 |
| **WP-2** | Konzol: idővonal, verzió megnyitása, kétverziós diff, change-set nézet, „Változások” fül. | WP-1 |
| **WP-3** | Visszaállítás: oldal és change-set (domain + konzol), D8 ütközés-UI, `reverted` állapot, audit. | WP-1 |
| **WP-4** | MCP: `kb_wiki_changes`, `WikiReadCursor`, briefing `changes` mező, `kb_get_page asOf`, `kb_wiki_revert` (mindig jóváhagyással). | WP-1, WP-3 |
| **WP-5** | Időutazás-nézet a konzolon, címkék, címke szerinti ZIP-export. | WP-2 |
| **WP-6** | Megőrzési beállítás és napi takarító (§6). | WP-1, WP-5 (címke-védelem) |
| **WP-7** | GDPR-törlés (§7): előnézet, kitakarás és törlés, sír-jel, `WikiErasure`, audit. | WP-1, WP-6 |
| **WP-8** | e2e: a `test:kb-wiki-e2e` bővítése (írás → diff → visszavonás → `kb_wiki_changes` → ritkítás → GDPR-törlés). | mind |

## 10. Elfogadási kritériumok

1. Egy oldal két tetszőleges verziója egymás mellett összevethető, a törzs sor-diffel, a mezők „volt → lett” sorral.
2. Egy 3 oldalas change-set visszavonása után a három oldal tartalma bájtra egyezik a change-set előtti revízióval, és a visszavont change-set `reverted`. A visszavonás visszavonása az eredeti állapotot adja vissza.
3. Ha a visszavonandó change-set egyik oldalát azóta más is módosította, semmi nem íródik, és a UI megnevezi az ütköző oldalt.
4. Az agent `kb_wiki_revert` hívása `wikiWriteMode = direct` mellett is `awaiting_approval` választ ad.
5. `kb_wiki_changes` egymás utáni két hívása: a második (új írás nélkül) üres listát ad, és a briefing `unseen` értéke 0.
6. A `kb_get_page asOf=<dátum>` azt a tartalmat adja, ami akkor érvényes volt; egy azóta áthelyezett oldal a régi útvonalán is megtalálható.
7. Két párhuzamos alkalmazás soha nem kap azonos `seq`-et (teszt párhuzamos tranzakciókkal).
8. A takarító után az aktuális verzió, oldalanként a legutóbbi 5 és a címkézett állapotok megmaradnak; a többi a beállítás szerint ritkul vagy törlődik; a régi change-setek `pages` tartalma kiürül.
9. Egy név GDPR-kitakarása után a név nem található az aktuális oldalban, egyik revízióban, change-set `pages`-ben, log-bejegyzésben, keresési indexben és jóváhagyásra váró gateway-argumentumban sem. Az audit nem tartalmazza a nevet.
10. Privát wikinél az admin semmilyen előzmény-tartalmat nem lát, és GDPR-törlést sem indíthat.

## 11. Nyitott kérdések

- **Q1 (D3):** kell-e később a nyers források verziózása (ugyanaz a fájl frissítve, régi megtartva), vagy elég az „új dokumentum” minta?
- **Q2:** a „legutóbbi 5 verzió mindig megmarad” szabály felülírhatja-e a rövid törlési időt? Most igen. Ha egy tenant szigorúbb törlést akar, ehhez kapcsoló kell.
- **Q3:** kapjon-e emberi felhasználó is „újdonságok” jelzést a konzolon (ugyanaz a cursor, `agentId` nélkül)? → v2-jelölt.
- **Q4:** legyen-e négy-szem elv (második admin jóváhagyása) a GDPR-törlésnél közös wikiben?

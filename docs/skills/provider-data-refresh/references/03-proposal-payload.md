# 2.5. ChangeProposal payload — a módosított export

Az élő adatot **csak emberi approve** viszi át. A proposal a kutatott változások
javaslata, round-trip formában.

## Szabályok

1. **Round-trip:** vedd az 1.4-ben lekért `data` objektumot **szó szerint**, változtasd a
   kutatott mezők **értékeit**, küldd vissza az egészet. Ne építsd kézzel, ne vágd le az
   érintetlen ágakat — hiányzó mainservice = törlés. Csonkolt (`truncated`) exportból sosem.
2. **`base_revision`** = `payload.exportMetadata.revision` = az export, amiből dolgoztál.
   Mindháromnak egyeznie kell az élő revisióval a `ready_for_review` átmenetkor, különben
   `409 STALE_PROPOSAL`.
3. **`payload.exportMetadata.bankId` és `payload.bank._id`** = path `bankId`.
4. **Meglévő `_id`:** 24 hex ObjectId csak akkor fogadható, ha az élő hierarchiában van. Új
   mainservice/product/feeset/fee: **nem-ObjectId placeholder**, pl. `"new-pos-terminal-1"`.
   Ismeretlen ObjectId = idegen entitás, nem create.
5. **Justification:** minden megváltozott mezőhöz nem-üres string az entitás saját
   `justifications` fájában, a mezőnév tükreként. Nincs külön top-level justification alak.
   `ready_for_review` üres justificationnel → `422` + `details[].path`.
6. Csak azt változtasd, amit a kutatás alátámaszt. `_id` mezőket (kivéve új placeholder)
   soha ne írd át.
7. Work file másolat: `provider-data-refresh/{slug}/{slug}_frissitett_{YYYY-MM-DD}.json` (ha
   ≤ 200 000 karakter) — a jelentéshez; **ez nem importálható magától** az élő rendszerbe.
8. A proposal csak a **Bank hierarchiát** viszi, a globális szótárakat (payment scheme,
   feature, device, tipp) nem. Hiányzó entitást a jelentésben jelezd.

## Justification példa (export alak)

```json
{
  "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
  "cost_fixed": 3490,
  "justifications": {
    "cost_fixed": "Havi alapdíj emelkedett 2990 → 3490 Ft. Forrás: https://szolgaltato.hu/arak (2026-08-25-i állapot)"
  }
}
```

Bank mező:

```json
{
  "bank": {
    "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
    "dba_name": "Példa",
    "justifications": {
      "dba_name": "A szolgáltató a honlapon már ezt a kereskedői nevet használja. Forrás: https://szolgaltato.hu (2026-08-25)"
    }
  }
}
```

## Létrehozás

Amíg összerakod: ne küldj semmit. Amikor kész (minden justification megvan), **közvetlenül
`ready_for_review`** státusszal hozd létre: a `draft` → `ready` átmenet `PATCH`-et és `If-Match`-et
igényelne; a közvetlen `ready_for_review` egyszerűbb, és egy hívásba fér. Ready-re állítás **supersede-eli** a bank előző ready
proposalját; egyszerre csak egy ready él.

`http_api_request`:

```json
{
  "definitionId": "…",
  "method": "POST",
  "path": "/banks/{BANK_ID}/research/proposals",
  "idempotencyKey": "pdr-proposal-{BANK_ID}-{YYYYMMDD}-1",
  "body": "{\"status\":\"ready_for_review\",\"base_revision\":\"sha256:…\",\"source_urls\":[\"https://szolgaltato.hu/arak\"],\"payload\":{ … }}"
}
```

A `templates/proposal-body.json` csak váz: a `payload` a lekért export `data` objektuma legyen, szó szerint,
a megváltozott mezők értékeivel és a `justifications` fával.

A `body` **JSON string**, kompakt (szóköz és sortörés nélkül), legfeljebb 200 000 karakter.
A hívás `awaiting_approval`-lal tér vissza: add át az `approvalUrl`-t a felhasználónak. A
jóváhagyás után a `platform.gateway_operation.get` `result` mezőjéből olvasd ki a `data.id`-t
(ez a run `proposal_id`-ja, 24 hex karakter) és a `data.version`-t.

## Nagy export (200 000 karakter fölött)

A proposal teljes exportot visz, a connector `body` argumentuma viszont legfeljebb 200 000
karakter. Mérd meg a kompakt payloadot a küldés előtt. Ha nem fér bele (vagy az export
`truncated`), **ne vágd meg** a fát és ne küldj részleges payloadot:

1. A javasolt változásokat teljes egészében írd a riport változástáblázatába és a 3.5-be.
2. Ha belefér a work file-ba, mentsd a `…_frissitett_….json` másolatot; ha nem, a mezőlistát
   (entitás-útvonal, régi → új, forrás) mentsd work file-ba.
3. A run outcome `needs_human`; a `summary` írja le: "a proposal payload a connector
   200 000 karakteres body-limitje miatt nem küldhető (X karakter)", és hogy az adminnak kell
   a limitet vagy a beküldést megoldania.
4. Szólj a felhasználónak; ez platform-oldali akadály, nem kutatási hiba.

## Stale

Ha közben ember szerkesztette a Bankot, nincs rebase. Új export, új payload, **új**
proposal, új `idempotencyKey`. A `http_api_get` `/banks/{id}/research/proposals/{proposalId}`
`stale` és `current_revision` mezője ezt előre jelzi.

## Ha nincs adatváltozás

Ne hozz létre proposalt. A run outcome `unchanged` (vagy `needs_human`, ha a döntés emberi).

## Hibakezelés

- `422`: javítsd a `details[].path` szerinti mezőket, majd **új** `idempotencyKey`.
- `409 STALE_PROPOSAL`: új export + új proposal.
- `409 IDEMPOTENCY_CONFLICT`: ugyanaz a kulcs más body-val — használj új kulcsot.
- `412` / `428`: stale vagy hiányzó `If-Match` — újra GET, az új `etag`-gel próbáld újra.
- `awaiting_approval` majd elutasítás: nincs proposal; a run `needs_human`.

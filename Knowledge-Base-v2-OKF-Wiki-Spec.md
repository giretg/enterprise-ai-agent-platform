# Knowledge Base v2 — OKF Wiki + Hybrid Retrieval specifikáció

**Projekt:** Enterprise AI Agent Platform  
**Státusz:** javasolt Fázis 2 / KB-v2 specifikáció  
**Dátum:** 2026-07-03  
**Cél:** a jelenlegi `Document.extractedText` + egyszerű `kb_search` alapú tudásbázis kiváltása egy enterprise-szintű, auditálható, agent-barát knowledge base réteggel.

---

## 0. Vezetői összefoglaló

A platformban jelenleg az agenthez feltöltött fájlok egyszerűen dokumentumként kerülnek tárolásra, a kinyert szöveg pedig `Document.extractedText` mezőben él. A dokumentum csak jóváhagyás után kap `connectorId`-t és `processed` státuszt, ettől válik kereshetővé a `knowledge_base` connectoron keresztül.

Ez jó governance-alap, de retrieval és knowledge-management szempontból kevés. A javasolt KB-v2 célja, hogy a feltöltött dokumentumokból opcionálisan strukturált, ember által review-zható és agent által hatékonyan használható tudásréteg készüljön.

**Döntési javaslat:**

> Vezessünk be egy **OKF-kompatibilis LLM-wiki canonical layert** és mellé egy **Postgres/pgvector alapú hibrid retrieval indexet**.

Ez nem „wiki vagy RAG” döntés, hanem rétegezett modell:

```text
Raw file
  → extracted normalized text
  → OKF/markdown knowledge bundle
  → review + publish
  → chunk/full-text/vector index
  → kb_search v2 / kb_get_page tools
```

---

## 1. Probléma

### 1.1 Jelenlegi állapot

A jelenlegi rendszerben a dokumentum fő adattárolási formája:

- eredeti fájl referenciája: `Document.storageRef`,
- opcionálisan kinyert szöveg: `Document.extractedText`,
- feldolgozási állapot: `Document.status`,
- KB-hez kapcsolás: `Document.connectorId`.

A `KnowledgeBaseService` jelenlegi felelőssége jó:

- feltöltött dokumentumhoz training ticketet nyit,
- a dokumentum addig nem kereshető, amíg nincs jóváhagyva,
- jóváhagyás után `connectorId + processed` állapotot kap,
- elutasításkor `failed` státuszba kerül.

### 1.2 Hiányosságok

A sima `extractedText` alapú tudásbázis problémái:

1. **Nem kurált tudás.** A PDF/DOCX nyers szövege sok zajt, ismétlést, header/footer maradványt és rossz sorrendet tartalmazhat.
2. **Nem review-zható értelmesen.** Egy nagy text blobban nehéz emberként átnézni, mit fog tudni az agent.
3. **Nem navigálható.** Az agent nem tud fogalmak, szabályok, runbookok, folyamatok között linkelten mozogni.
4. **Gyenge citation/provenance.** A válaszok hivatkozása csak akkor lesz jó, ha chunk-szinten megőrzünk source span információt.
5. **Nehezen frissíthető.** Új verzióknál nincs jó diff egy dokumentum tudástartalma között.
6. **Nem skálázódik jól enterprise corpusra.** Kulcsszavas keresés vagy egyszerű text scan nem elég.

---

## 2. Célállapot

A KB-v2 célja:

- feltöltött fájlokból opcionálisan **agent-friendly knowledge artifact** készüljön,
- a canonical tudás **ember által olvasható markdown/OKF bundle** legyen,
- minden tudásfrissítés maradjon **write-gate / approval / audit** alatt,
- a runtime retrieval legyen **hibrid**: metadata filter + full-text + vector search + citation map,
- az agent továbbra is kizárólag a Tool Broker által engedélyezett eszközökkel férjen hozzá,
- a régi `kb_search` tool szerződés lehetőleg backward-compatible maradjon.

---

## 3. Döntés: OKF-kompatibilis LLM-wiki + hibrid retrieval

### 3.1 Miért OKF-kompatibilis wiki?

Az Open Knowledge Format jellegű megközelítés minimális, vendorsemleges és agent-barát:

- markdown fájlok,
- YAML frontmatter,
- ember által review-zható szerkezet,
- linkelhető concept page-ek,
- exportálható bundle,
- nincs kötelező vendor runtime.

A platform governance-modelljéhez ez különösen jól illik, mert a tudás nem fekete doboz embedding-index lesz, hanem diffelhető, verziózható, review-zható artifact.

### 3.2 Miért nem csak vector DB?

A csak embedding-alapú RAG gyors, de enterprise szinten problémás:

- nehezen auditálható,
- nem látszik, mit „tud” pontosan az agent,
- a duplikált/ellentmondó tudás rosszul kezelhető,
- diff és approval UX gyenge.

### 3.3 Miért nem csak wiki?

A wiki önmagában nem elég runtime retrievalnek. Nagyobb corpusnál kell:

- chunkolás,
- full-text index,
- embedding index,
- metadata filter,
- citation mapping,
- opcionális reranking.

### 3.4 Végleges javaslat

**Canonical knowledge layer:** OKF-kompatibilis markdown wiki bundle.  
**Runtime retrieval layer:** Postgres/pgvector alapú hibrid index.  
**Agent access layer:** Tool Broker mögötti `kb_search v2`, később `kb_get_page` és `kb_list_index`.

---

## 4. Fogalmak

### 4.1 Raw Document

Az eredeti feltöltött dokumentum. Ez marad a `Document` rekord és a `storageRef` mögött.

### 4.2 Extracted Text

A dokumentumból kinyert normalizált text/markdown. Backward compatibility és feldolgozási input céljára megmaradhat.

### 4.3 Knowledge Artifact

Egy verziózott, review-zható tudáscsomag, amely egy vagy több forrásdokumentumból készült.

### 4.4 OKF Bundle

Markdown fájlok könyvtára YAML frontmatterrel:

```text
kb/agent-123/
  index.md
  policies/
    index.md
    remote-work-policy.md
    expense-policy.md
  procedures/
    onboarding.md
  glossary/
    terms.md
  log.md
```

### 4.5 Knowledge Chunk

A publikált OKF bundle indexelhető egysége. Egy chunk tartalmazza:

- text,
- path,
- section,
- metadata,
- source span,
- embedding,
- full-text index mező.

### 4.6 Source Span

Az eredeti dokumentumra mutató provenance adat:

- dokumentum ID,
- filename,
- page,
- paragraph,
- table/cell range,
- byte offset vagy text range,
- eredeti rövid idézet.

---

## 5. Példa OKF concept page

```markdown
---
type: Policy
title: Remote Work Policy
description: Company policy for remote work eligibility, approval and reporting.
resource: gcs://bucket/raw/hr-remote-policy.pdf
tags: [hr, remote-work, policy]
timestamp: 2026-07-03T10:00:00Z
source_document_id: "..."
agent_id: "..."
connector_id: "..."
classification: internal
confidence: draft_llm_generated
---

# Remote Work Policy

## Summary

Employees may request remote work if the role and team operating model allow it.

## Rules

- Approval is required from the direct manager.
- Exceptions are handled by HR.
- Changes must be recorded in the HR system.

## Related

- [Onboarding](../procedures/onboarding.md)
- [Expense Policy](./expense-policy.md)

## Citations

- Source: page 3, paragraph 2
- Source: page 5, table 1
```

---

## 6. Célarchitektúra

```text
CONTROL PLANE
  Agent Registry
  KB upload UI
  KB artifact review UI
  Training/write-gate tickets
  Audit log

DATA PLANE
  Raw document storage
  Extraction pipeline
  OKF generator
  OKF validator
  Knowledge artifact store
  Knowledge chunk index

TOOL BROKER
  kb_search v2
  kb_get_page
  kb_list_index

AGENT RUNTIME
  Goose / harness
  Model Gateway
  Tool Broker only, no direct KB/database access
```

A legfontosabb termék-elv változatlan:

> Az agent nem fér hozzá közvetlenül a dokumentumokhoz vagy az adatbázishoz. Minden tudáslekérdezés a Tool Brokeren átmegy, ahol authorization, audit és policy enforcement történik.

---

## 7. Pipeline

### 7.1 Upload

A felhasználó feltölt egy fájlt az agenthez.

Rögzítendő:

- `Document.filename`,
- `Document.storageRef`,
- `Document.status = uploaded`,
- `Document.uploadedById`,
- opcionálisan `mimeType`, `contentHash`, `metadata`.

### 7.2 Processing mode választás

A UI három módot kínáljon:

1. **Raw text only** — legacy / gyors mód.
2. **OKF wiki draft** — LLM által generált wiki javaslat review-ra.
3. **OKF wiki + retrieval index** — teljes KB-v2 feldolgozás.

### 7.3 Extraction

Fájlformátumok első körben:

- PDF: `pdf-parse`, később layout-aware parser,
- DOCX: `mammoth`,
- XLSX: `exceljs`,
- Markdown/HTML/plain text: direkt parser.

Kimenet:

- normalized markdown,
- source spans,
- structural blocks: heading, paragraph, table, list, code, image-placeholder.

### 7.4 Segmentation

A pipeline bontsa a dokumentumot szemantikai egységekre:

- fejezetek,
- policy rule-ok,
- definíciók,
- táblák,
- folyamatlépések,
- FAQ jellegű elemek.

### 7.5 OKF generation

Az LLM hozzon létre:

- `index.md`,
- concept page-eket,
- `log.md` feldolgozási naplóval,
- warnings listát,
- source coverage reportot.

A generálás nem publikál automatikusan. Mindig `pending_review` vagy `draft` státuszú artifact jön létre.

### 7.6 Validation

Automatikus validáció:

- YAML frontmatter parse,
- kötelező mezők megléte,
- broken markdown links,
- üres oldalak,
- túl hosszú oldalak,
- citation coverage,
- source span integritás,
- tenant/agent/connector egyezés,
- tiltott külső linkek vagy érzékeny adatok jelzése.

### 7.7 Human review

Approver nézet:

- eredeti dokumentum,
- extracted normalized text,
- generált OKF file tree,
- concept page preview,
- diff az előző artifact verzióhoz,
- validation warnings,
- approve/reject.

### 7.8 Publish

Approval után:

- `KnowledgeArtifact.status = published`,
- `Document.status = processed`,
- `Document.connectorId = knowledge_base connector`,
- `KnowledgeChunk` rekordok létrejönnek,
- embeddings generálódnak,
- full-text index frissül,
- audit event rögzül.

---

## 8. Adatmodell-javaslat

### 8.1 Enumok

```prisma
enum KnowledgeProcessingMode {
  raw_text_only
  okf_wiki
  structured_rag
  okf_plus_rag
}

enum KnowledgeArtifactStatus {
  draft
  processing
  pending_review
  published
  failed
  superseded
}

enum KnowledgeArtifactFormat {
  okf_v0_1
  markdown_bundle
  raw_markdown
  json
}
```

### 8.2 Document bővítés

```prisma
model Document {
  // meglévő mezők változatlanul
  id            String         @id @default(uuid()) @db.Uuid
  filename      String
  storageRef    String         @map("storage_ref")
  extractedText String?        @map("extracted_text")
  status        DocumentStatus @default(uploaded)
  connectorId   String?        @map("connector_id") @db.Uuid
  uploadedById  String         @map("uploaded_by") @db.Uuid
  createdAt     DateTime       @default(now()) @map("created_at") @db.Timestamptz

  // KB-v2 javasolt mezők
  mimeType       String?        @map("mime_type")
  contentHash    String?        @map("content_hash")
  processingMode KnowledgeProcessingMode? @map("processing_mode")
  metadata       Json           @default("{}")
}
```

### 8.3 KnowledgeArtifact

```prisma
model KnowledgeArtifact {
  id               String                  @id @default(uuid()) @db.Uuid
  tenantId         String?                 @map("tenant_id") @db.Uuid
  agentId          String                  @map("agent_id") @db.Uuid
  connectorId      String                  @map("connector_id") @db.Uuid
  sourceDocumentId String?                 @map("source_document_id") @db.Uuid

  format           KnowledgeArtifactFormat @default(okf_v0_1)
  status           KnowledgeArtifactStatus @default(draft)
  version          Int
  contentHash      String                  @map("content_hash")
  bundleRef        String                  @map("bundle_ref")
  generationModel  String?                 @map("generation_model")
  generationPromptHash String?             @map("generation_prompt_hash")
  validationResult Json                    @default("{}") @map("validation_result")
  reviewSummary    String?                 @map("review_summary")
  createdById      String?                 @map("created_by") @db.Uuid
  approvedById     String?                 @map("approved_by") @db.Uuid
  createdAt        DateTime                @default(now()) @map("created_at") @db.Timestamptz
  publishedAt      DateTime?               @map("published_at") @db.Timestamptz

  @@unique([connectorId, sourceDocumentId, version])
  @@index([tenantId, agentId, status])
  @@index([connectorId, status])
  @@map("knowledge_artifacts")
}
```

### 8.4 KnowledgeChunk

```prisma
model KnowledgeChunk {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId     String?  @map("tenant_id") @db.Uuid
  artifactId   String   @map("artifact_id") @db.Uuid
  connectorId  String   @map("connector_id") @db.Uuid
  agentId      String   @map("agent_id") @db.Uuid

  path         String
  title        String
  type         String
  section      String?
  chunkIndex   Int      @map("chunk_index")
  text         String
  summary      String?
  tags         Json     @default("[]")
  metadata     Json     @default("{}")
  sourceSpan   Json?    @map("source_span")
  contentHash  String   @map("content_hash")

  // pgvector raw SQL migrationgel vagy Prisma Unsupported mezővel kezelhető
  // embedding Unsupported("vector(1536)")?

  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@index([tenantId, agentId])
  @@index([connectorId])
  @@index([artifactId, path])
  @@map("knowledge_chunks")
}
```

### 8.5 KnowledgeProcessingJob opcionális modell

Ha a ticket payload nem elég, külön job tábla javasolt:

```prisma
enum KnowledgeProcessingJobStatus {
  queued
  running
  pending_review
  completed
  failed
  cancelled
}

model KnowledgeProcessingJob {
  id               String @id @default(uuid()) @db.Uuid
  tenantId         String? @map("tenant_id") @db.Uuid
  agentId          String @map("agent_id") @db.Uuid
  connectorId      String @map("connector_id") @db.Uuid
  sourceDocumentId String @map("source_document_id") @db.Uuid
  ticketId         String? @map("ticket_id") @db.Uuid
  status           KnowledgeProcessingJobStatus @default(queued)
  mode             KnowledgeProcessingMode
  inputRef         String? @map("input_ref")
  outputArtifactId String? @map("output_artifact_id") @db.Uuid
  error            String?
  metadata         Json @default("{}")
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz
  startedAt        DateTime? @map("started_at") @db.Timestamptz
  completedAt      DateTime? @map("completed_at") @db.Timestamptz

  @@index([tenantId, status])
  @@index([agentId, status])
  @@map("knowledge_processing_jobs")
}
```

---

## 9. Tool Broker API

### 9.1 `kb_search v2`

A meglévő tool neve maradhat `kb_search`, de a mögöttes implementáció cserélődik.

Input:

```ts
type KbSearchInput = {
  query: string
  agentId: string
  topK?: number
  mode?: 'answer_context' | 'wiki_navigation' | 'exact_lookup'
  filters?: {
    tags?: string[]
    type?: string[]
    sourceDocumentId?: string
    updatedAfter?: string
  }
}
```

Output:

```ts
type KbSearchResult = {
  chunks: Array<{
    text: string
    score: number
    artifactId: string
    path: string
    title: string
    type: string
    source: {
      documentId?: string
      filename?: string
      page?: number
      section?: string
      quote?: string
    }
  }>
  suggestedLinks?: Array<{
    title: string
    path: string
    reason: string
  }>
}
```

### 9.2 `kb_get_page`

Későbbi tool teljes OKF oldal lekérésére.

```ts
type KbGetPageInput = {
  agentId: string
  path: string
  artifactId?: string
}
```

### 9.3 `kb_list_index`

Későbbi tool navigációhoz.

```ts
type KbListIndexInput = {
  agentId: string
  pathPrefix?: string
  maxDepth?: number
}
```

---

## 10. Retrieval stratégia

A `kb_search v2` lépései:

1. **Authorization:** Tool Broker ellenőrzi, hogy az agent használhatja-e a `knowledge_base` connectort.
2. **Scope filter:** tenant, agent, connector, published artifact.
3. **Metadata filter:** tags, type, sourceDocumentId, retention/classification.
4. **Full-text search:** Postgres `tsvector` / `websearch_to_tsquery`.
5. **Vector search:** pgvector cosine similarity.
6. **Fusion:** reciprocal rank fusion vagy egyszerű súlyozott merge.
7. **Rerank:** opcionális LLM/reranker.
8. **Citation assembly:** source span + OKF path + document metadata.
9. **Audit:** tool call, input hash, output refs, policy decision.

### 10.1 Miért Postgres/pgvector?

A platform már Postgres/Prisma alapú. A pgvector előnye, hogy a vektorok az üzleti adatok mellett maradnak, JOIN-olhatók tenant/agent/connector metadata mezőkkel, és nem kell külön vector DB-t üzemeltetni az MVP-hez.

Később a `KnowledgeIndexStore` interfész mögött cserélhető külső search substrate-ra.

---

## 11. Domain service változások

### 11.1 `KnowledgeBaseService`

A jelenlegi service maradjon orchestration layer, de bővüljön:

```ts
type RequestDocumentParams = {
  agentId: string
  documentId: string
  createdById: string
  processingMode?: 'raw_text_only' | 'okf_wiki' | 'okf_plus_rag'
}
```

Javasolt új metódusok:

```ts
requestDocument(params)
startProcessing(ticketId)
createDraftArtifact(params)
approveArtifact(params)
rejectArtifact(params)
publishArtifact(params)
listPendingArtifacts(agentId)
```

### 11.2 Approval jelentésének változása

Jelenleg approval után a dokumentum `connectorId + processed` állapotot kap. KB-v2-ben approval után:

- artifact publikálódik,
- chunk index épül,
- document státusz processed,
- connectorId beáll,
- audit event rögzül.

### 11.3 Backward compatibility

Ha nincs `KnowledgeArtifact`, a `kb_search` fallbackelhet a régi `Document.extractedText` keresésre.

---

## 12. UI/UX javaslat

### 12.1 Upload képernyő

Új kapcsolók:

- „Csak nyers szövegként használja”
- „Dolgozza fel agent-friendly knowledge base-re”
- „Készítsen OKF wiki javaslatot jóváhagyásra”

Megjelenítendő feldolgozási státusz:

- uploaded,
- extracting,
- generating wiki,
- validating,
- awaiting approval,
- published,
- failed.

### 12.2 Review képernyő

Hárompaneles nézet:

1. Forrásdokumentum / extracted text.
2. Generált OKF file tree + page preview.
3. Validation report + approve/reject.

Külön kiemelések:

- alacsony citation coverage,
- ellentmondó állítások,
- broken links,
- nem besorolt tartalom,
- potenciálisan érzékeny adat.

### 12.3 Agent sandbox nézet

Kérdés-válasz után a citation ne csak dokumentumot mutasson, hanem:

- OKF page title,
- section,
- original filename,
- source page/paragraph,
- artifact version.

---

## 13. Audit és governance

Új audit actionök:

- `kb.processing.started`,
- `kb.processing.failed`,
- `kb.artifact.generated`,
- `kb.artifact.validation_failed`,
- `kb.artifact.approved`,
- `kb.artifact.rejected`,
- `kb.artifact.published`,
- `kb.index.rebuilt`,
- `kb.search.executed`.

Audit metadata:

```json
{
  "agentId": "...",
  "connectorId": "...",
  "documentId": "...",
  "artifactId": "...",
  "artifactVersion": 3,
  "contentHash": "...",
  "processingMode": "okf_plus_rag",
  "model": "...",
  "validation": {
    "brokenLinks": 0,
    "citationCoverage": 0.92,
    "warnings": 2
  }
}
```

---

## 14. Security és compliance

### 14.1 Isolation

- Agent csak Tool Broker toolokon át fér hozzá.
- Runtime csak `published` artifactból kereshet.
- Draft/pending artifact csak review UI-ban látható.

### 14.2 Tenant és agent scope

Minden indexelt chunk tartalmazzon:

- `tenantId`,
- `agentId`,
- `connectorId`,
- `artifactId`.

A `kb_search` első lépése mindig scope filter.

### 14.3 Retention és legal hold

A KB-v2 később kapcsolódjon a meglévő retention policy modellhez. Egy dokumentum törlésekor vagy lejáratakor:

- artifact superseded/deleted állapot,
- chunkok soft delete vagy tombstone,
- audit trail megőrzés policy szerint.

### 14.4 Sensitive data warnings

A processing pipeline jelezze:

- személyes adat,
- API key / secret gyanú,
- pénzügyi adat,
- szerződéses/confidential tartalom.

Az első MVP-ben ez lehet regex + LLM classifier warning, nem enforcement.

---

## 15. Eval stratégia

Minden publikált artifacthoz opcionálisan generáljunk eval setet:

- 10–30 kérdés a dokumentumból,
- expected citation path/source span,
- negatív kérdések: „nem tudható a dokumentumból”,
- regression futtatás artifact publish után.

Eval metrikák:

- answer groundedness,
- citation correctness,
- retrieval recall,
- no-answer precision,
- latency,
- token cost.

---

## 16. MVP roadmap

### Sprint 1 — Data model és skeleton

- `KnowledgeArtifact` modell.
- `KnowledgeChunk` modell.
- `KnowledgeProcessingMode` enum.
- `Document` minimális bővítése.
- Repository interfészek.
- Üres processing job flow.

Acceptance:

- dokumentumhoz létrejön draft artifact,
- approval előtt nem kereshető,
- approval után published státuszt kap.

### Sprint 2 — Extraction és OKF generator

- PDF/DOCX/XLSX/MD extraction.
- Normalized markdown output.
- OKF bundle generator.
- `index.md`, concept page-ek, `log.md`.
- Basic validator.

Acceptance:

- egy feltöltött policy PDF-ből OKF bundle készül,
- broken link és frontmatter validáció fut,
- source spans legalább section szinten megmaradnak.

### Sprint 3 — Review UI

- KB artifact review oldal.
- File tree preview.
- Diff előző verzióhoz.
- Approve/reject.
- Audit events.

Acceptance:

- approver látja a generált wiki tartalmat,
- approve után publish történik,
- reject után nem kereshető.

### Sprint 4 — Hybrid retrieval

- `KnowledgeChunk` indexelés.
- Full-text search.
- pgvector embedding mező és index.
- Fusion logic.
- `kb_search v2` Tool Broker mögött.

Acceptance:

- agent kérdésre chunk + citation payloadot kap,
- fallback működik legacy `extractedText` dokumentumokra,
- csak published artifactból keres.

### Sprint 5 — Eval és polish

- Auto eval generation.
- Retrieval regression.
- Citation correctness report.
- Latency/cost logging.

Acceptance:

- artifact publish után eval futtatható,
- regresszió jelzi, ha retrieval/citation romlik.

---

## 17. Első implementációs szelet

A legkisebb hasznos változtatás:

1. `KnowledgeArtifact` tábla létrehozása.
2. `KnowledgeBaseService.approveDocument()` módosítása úgy, hogy ne csak `Document.connectorId + processed` legyen, hanem `KnowledgeArtifact(published)` is.
3. Egy egyszerű OKF bundle generátor markdown fájlokra.
4. `KnowledgeChunk` létrehozása heading-alapú chunkolással.
5. `kb_search` fallback + új chunk search.

Ez még embedding nélkül is értéket ad, mert:

- review-zható canonical artifact jön létre,
- citation path javul,
- később könnyű ráépíteni pgvectorral.

---

## 18. Nyitott döntések

| # | Döntés | Javaslat |
|---|---|---|
| D1 | OKF bundle hol tárolódjon? | MVP: GCS/storageRef prefix vagy DB-backed virtual files; később Git export |
| D2 | pgvector bekapcsolható-e Neon/Cloud SQL környezetben? | Spike szükséges |
| D3 | Embedding provider | Model Gateway mögött, provider-absztrakcióval |
| D4 | Draft artifact szerkeszthető-e kézzel? | MVP-ben csak approve/reject; később inline edit |
| D5 | One document = one artifact vagy multi-document bundle? | MVP: one document → one artifact; később bundle merge |
| D6 | OKF schema strictness | MVP: minimális frontmatter schema; később versioned schema |

---

## 19. Nem cél az első verzióban

- teljes vállalati document management rendszer,
- real-time collaborative wiki editor,
- automatikus publikálás emberi review nélkül,
- külső SaaS vector DB kötelező bevezetése,
- multi-agent shared ontology teljes megoldása,
- complex knowledge graph reasoning.

---

## 20. Összegzés

A KB-v2 javasolt iránya:

> **OKF-kompatibilis LLM-wiki canonical layer + Postgres/pgvector hibrid retrieval layer + meglévő Tool Broker/write-gate governance.**

Ez illeszkedik a platform meglévő architektúrájához:

- a `knowledge_base` connector megmarad,
- a `kb_search` tool megmarad,
- az approval flow megmarad,
- az audit modell erősödik,
- a nyers dokumentum nem tűnik el,
- az agent jobb, citálhatóbb, karbantarthatóbb tudást kap.

A változtatás nem egyszerű technikai RAG-upgrade, hanem termékdifferenciátor: a platform nem csak fájlokat tölt fel agentekhez, hanem kontrollált, review-zható, verziózott enterprise knowledge layert épít belőlük.

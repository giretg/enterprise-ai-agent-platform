/**
 * Governed Flow Builder — StepTemplate katalógus (WP-3, §3.2, §6).
 *
 * Governance-safe, újrahasznosítható lépés-legók a Canvas palettájához. A template SOHA nem ad
 * futásidejű tool-jogot (D3) — a `requiredCapabilities` csak JAVASLAT; a capability-t a Tool Broker
 * kényszeríti ki runtime-ban. A fragment a `playbookStepSchema` részhalmaza + opcionális gate,
 * `__ROLE__` role-placeholder-rel, amit beszúráskor valós role-hoz kell kötni.
 */
import type { PrismaClient } from '@prisma/client'
import { computePlaybookContentHash } from '@/lib/playbook-v2/spec'

export type StepTemplateFragment = {
  step: Record<string, unknown>
  suggestedGate: Record<string, unknown> | null
}

export type StepTemplateCatalogItem = {
  key: string
  name: string
  description: string
  category: string
  fragment: StepTemplateFragment
}

/** Beépített kezdő-katalógus (globális, tenantId=null). */
export const STARTER_STEP_TEMPLATES: StepTemplateCatalogItem[] = [
  {
    key: 'invoice-exception-classifier',
    name: 'Számla-eltérés osztályozó',
    description:
      'Beérkező számla osztályozása (clean_match / minor_exception / major_exception) strukturált döntéssel — Decision Step alapnak.',
    category: 'Pénzügy',
    fragment: {
      step: {
        id: '__PLACEHOLDER__',
        name: 'Számla-eltérés osztályozó',
        ticketType: 'invoice_classification',
        assignedRole: '__ROLE__',
        requiredCapabilities: ['file_read', 'kb_search'],
        instructionTemplate:
          'Osztályozd a beérkező számlát: {{invoice_ref}}. Add meg a `decision` mezőt (clean_match | minor_exception | major_exception), a `confidence`-t (0–1) és az `evidence`-t.',
        outputContract: { requiredFields: ['decision', 'confidence', 'evidence'] },
      },
      suggestedGate: null,
    },
  },
  {
    key: 'payment-reconciliation-reviewer',
    name: 'Fizetés-egyeztetés review',
    description:
      'Bankkivonat és főkönyv egyeztetése, eltérés-lista előállítása; ajánlott L2 emberi jóváhagyó kapuval.',
    category: 'Pénzügy',
    fragment: {
      step: {
        id: '__PLACEHOLDER__',
        name: 'Fizetés-egyeztetés review',
        ticketType: 'reconciliation_review',
        assignedRole: '__ROLE__',
        requiredCapabilities: ['file_read', 'xlsx_read_sheet'],
        instructionTemplate:
          'Egyeztesd a(z) {{statement_ref}} kivonatot a főkönyvvel, és sorold fel az eltéréseket (`exception_list`) egy rövid `summary`-vel.',
        outputContract: { requiredFields: ['exception_list', 'summary'] },
      },
      suggestedGate: {
        id: 'reconciliation_approval',
        type: 'human_approval',
        blocking: true,
        criticality: 'L2',
        evidenceRequired: true,
      },
    },
  },
  {
    key: 'policy-checker',
    name: 'Policy ellenőrzés',
    description:
      'Dokumentum megfelelőség-ellenőrzése a belső szabályzat ellen; compliant/findings kimenettel.',
    category: 'Compliance',
    fragment: {
      step: {
        id: '__PLACEHOLDER__',
        name: 'Policy ellenőrzés',
        ticketType: 'policy_check',
        assignedRole: '__ROLE__',
        requiredCapabilities: ['kb_search'],
        instructionTemplate:
          'Ellenőrizd, hogy a(z) {{document_ref}} megfelel-e a vonatkozó belső szabályzatnak. Add meg a `compliant` (true/false) és a `findings` mezőt.',
        outputContract: { requiredFields: ['compliant', 'findings'] },
      },
      suggestedGate: null,
    },
  },
]

/** A published globális + tenant-specifikus StepTemplate-ek fragment-listája a palettához. */
export async function listPublishedStepTemplates(
  prisma: PrismaClient,
  tenantId: string | null,
): Promise<StepTemplateCatalogItem[]> {
  const templates = await prisma.stepTemplate.findMany({
    where: {
      status: 'published',
      currentPublishedVersionId: { not: null },
      OR: [{ tenantId: null }, ...(tenantId ? [{ tenantId }] : [])],
    },
    include: { versions: true },
    orderBy: { name: 'asc' },
  })

  const items: StepTemplateCatalogItem[] = []
  for (const t of templates) {
    const version = t.versions.find((v) => v.id === t.currentPublishedVersionId)
    if (!version) continue
    const fragment = version.fragment as unknown as StepTemplateFragment
    if (!fragment || typeof fragment !== 'object' || !fragment.step) continue
    items.push({
      key: t.key,
      name: t.name,
      description: t.description ?? '',
      category: t.category ?? '',
      fragment,
    })
  }
  return items
}

/** Idempotens seed: a beépített katalógus globális (tenantId=null), published verzióval. */
export async function ensureStarterStepTemplates(prisma: PrismaClient): Promise<void> {
  for (const item of STARTER_STEP_TEMPLATES) {
    const contentHash = computePlaybookContentHash(item.fragment)
    const existing = await prisma.stepTemplate.findFirst({
      where: { tenantId: null, key: item.key },
      include: { versions: true },
    })

    if (!existing) {
      const created = await prisma.stepTemplate.create({
        data: {
          tenantId: null,
          key: item.key,
          name: item.name,
          description: item.description,
          category: item.category,
          status: 'published',
        },
      })
      const version = await prisma.stepTemplateVersion.create({
        data: {
          templateId: created.id,
          version: 1,
          fragment: item.fragment as unknown as object,
          contentHash,
        },
      })
      await prisma.stepTemplate.update({
        where: { id: created.id },
        data: { currentPublishedVersionId: version.id },
      })
      continue
    }

    // Meglévő: ha nincs azonos contentHash-ű verzió, hozzáfűzünk egy újat és publikáljuk.
    const match = existing.versions.find((v) => v.contentHash === contentHash)
    if (match) {
      if (existing.currentPublishedVersionId !== match.id || existing.status !== 'published') {
        await prisma.stepTemplate.update({
          where: { id: existing.id },
          data: { currentPublishedVersionId: match.id, status: 'published' },
        })
      }
      continue
    }
    const nextVersion = Math.max(0, ...existing.versions.map((v) => v.version)) + 1
    const version = await prisma.stepTemplateVersion.create({
      data: {
        templateId: existing.id,
        version: nextVersion,
        fragment: item.fragment as unknown as object,
        contentHash,
      },
    })
    await prisma.stepTemplate.update({
      where: { id: existing.id },
      data: {
        name: item.name,
        description: item.description,
        category: item.category,
        status: 'published',
        currentPublishedVersionId: version.id,
      },
    })
  }
}

'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requirePlatformRole } from '@/auth/tenant-context'
import { repositories } from '@/repositories/postgres'
import { fail, ok } from '@/lib/result'

const contactInquirySchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(6).max(40),
  email: z.string().trim().email().max(254),
  message: z.string().trim().min(10).max(6000),
  website: z.string().max(200).optional(),
})

/** Public contact form. A filled honeypot is accepted silently and not stored. */
export async function submitContactInquiry(input: {
  name: string
  phone: string
  email: string
  message: string
  website?: string
}) {
  const parsed = contactInquirySchema.safeParse(input)
  if (!parsed.success) return fail('invalid_input')
  if (parsed.data.website?.trim()) return ok({ submitted: true })

  try {
    await repositories.contactInquiries.create({
      name: parsed.data.name,
      phone: parsed.data.phone,
      email: parsed.data.email.toLowerCase(),
      message: parsed.data.message,
    })
    return ok({ submitted: true })
  } catch {
    return fail('submit_failed')
  }
}

export async function listContactInquiries() {
  try {
    await requirePlatformRole('platform_auditor')
    const inquiries = await repositories.contactInquiries.findMany({ limit: 200 })
    return ok(inquiries.map((inquiry) => ({
      id: inquiry.id,
      name: inquiry.name,
      phone: inquiry.phone,
      email: inquiry.email,
      message: inquiry.message,
      status: inquiry.status,
      createdAt: inquiry.createdAt.toISOString(),
      reviewedAt: inquiry.reviewedAt?.toISOString() ?? null,
    })))
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Failed to list contact inquiries')
  }
}

export async function markContactInquiryReviewed(input: { inquiryId: string }) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const { inquiryId } = z.object({ inquiryId: z.string().uuid() }).parse(input)
    await repositories.contactInquiries.markReviewed(inquiryId, ctx.user.id)
    revalidatePath('/control-plane/platform/contact')
    return ok({ reviewed: true })
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Failed to update contact inquiry')
  }
}

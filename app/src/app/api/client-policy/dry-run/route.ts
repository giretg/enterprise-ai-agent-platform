import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { CONTENT_FILTER_KEYS, capabilityLevels } from '@/domain/client-policy/capabilities'
import { dryRunContentFilter } from '@/domain/model-gateway/content-filter'

export const dynamic = 'force-dynamic'

/** Csak a tartalomszűrő kulcsai, érvényes szinttel; a próbaszöveg nem tárolódik és nem naplózódik. */
const schema = z.object({
  text: z.string().min(1).max(20_000),
  capabilities: z.record(z.string(), z.string()).refine((caps) =>
    CONTENT_FILTER_KEYS.every((key) => caps[key] === undefined || capabilityLevels(key).includes(caps[key]))),
})

export async function POST(request: Request): Promise<Response> {
  const auth = await requireTenantApiUser('admin')
  if (!auth.ok) return auth.response
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  const capabilities = Object.fromEntries(CONTENT_FILTER_KEYS.flatMap((key) => parsed.data.capabilities[key] ? [[key, parsed.data.capabilities[key]]] : []))
  return NextResponse.json(await dryRunContentFilter(auth.user.activeTenantId, parsed.data.text, capabilities))
}

/**
 * #663 megnevezett jóváhagyó feloldása — binding van-e, és használható-e.
 *
 * Ha az agent/konnektor megnevezett jóváhagyót állít, de a user hiányzik vagy
 * a tenant-tagsága nem aktív, NE essünk vissza „nincs megnevezett”-re: az
 * négyszemközti kapu csendes eltűnése (kérelmező self-approve).
 */
export type DesignatedApproverResolution =
  | { kind: 'none' }
  | { kind: 'designated'; userId: string; name: string }
  | { kind: 'unavailable' }

export function resolveDesignatedApproverBinding(input: {
  /** Konnektor > agent sorrendben már feloldott user id, vagy null ha nincs binding. */
  approverUserId: string | null
  membershipStatus: string | null | undefined
  user: { id: string; name: string | null; email: string } | null
}): DesignatedApproverResolution {
  if (!input.approverUserId) return { kind: 'none' }
  if (!input.user || input.membershipStatus !== 'active') return { kind: 'unavailable' }
  return {
    kind: 'designated',
    userId: input.user.id,
    name: input.user.name?.trim() || input.user.email,
  }
}

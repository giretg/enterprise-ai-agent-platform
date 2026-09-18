import { z } from 'zod'

/**
 * `knownDomain` — hostname, opcionális `*.` prefix. Nem query-fragment:
 * szóköz, `OR`, idézőjel, séma mind elutasítva.
 */
export const KNOWN_DOMAIN_RE =
  /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

export const knownDomainSchema = z
  .string()
  .trim()
  .max(255)
  .regex(KNOWN_DOMAIN_RE, 'invalid_hostname')
  .optional()

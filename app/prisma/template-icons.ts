import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MAX_TEMPLATE_ICON_DATA_URL_LENGTH,
  type TemplateDescriptor,
} from '../src/domain/connector-template/template-descriptor'

const TEMPLATE_ICON_DIR = resolve(__dirname, '../connector-template-icons')
/** Több sablon osztozhat egy ikonfájlon. */
const TEMPLATE_ICON_FILE_BY_KEY: Record<string, string> = {
  'ostorosbor-crm-sales-delegated': 'ostorosbor-crm.svg',
  'ostorosbor-crm-service-insight': 'ostorosbor-crm.svg',
}

/** A sablon ikonfájlja data URL-ként, vagy undefined ha nincs / túl nagy. */
function iconDataUrlForKey(key: string): string | undefined {
  const file = TEMPLATE_ICON_FILE_BY_KEY[key] ?? `${key}.svg`
  const path = resolve(TEMPLATE_ICON_DIR, file)
  if (!existsSync(path)) return undefined
  const dataUrl = `data:image/svg+xml;base64,${readFileSync(path).toString('base64')}`
  if (dataUrl.length > MAX_TEMPLATE_ICON_DATA_URL_LENGTH) return undefined
  return dataUrl
}

/** A már feltöltött egyedi ikont nem írjuk felül — csak a hiányzót pótoljuk fájlból. */
export function withTemplateIcon(descriptor: TemplateDescriptor, existingDescriptor: unknown): TemplateDescriptor {
  const existingIcon = (existingDescriptor as { iconDataUrl?: unknown } | null)?.iconDataUrl
  const iconDataUrl =
    typeof existingIcon === 'string' && existingIcon.length > 0
      ? existingIcon
      : (descriptor.iconDataUrl ?? iconDataUrlForKey(descriptor.key))
  return iconDataUrl ? { ...descriptor, iconDataUrl } : descriptor
}

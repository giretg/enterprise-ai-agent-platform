import type { ComponentType } from 'react'
import type { AppLocale } from '@/i18n/config'
import { GtcEn } from './gtc-en'
import { GtcHu } from './gtc-hu'
import { PrivacyEn } from './privacy-en'
import { PrivacyHu } from './privacy-hu'

export const legalBodies = {
  privacy: { hu: PrivacyHu, en: PrivacyEn },
  gtc: { hu: GtcHu, en: GtcEn },
} as const satisfies Record<'privacy' | 'gtc', Record<AppLocale, ComponentType>>

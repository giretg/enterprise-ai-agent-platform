import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/shell'

export function RolloutStateBadge({
  mode,
  includedCount,
  excludedCount,
}: {
  mode: 'off' | 'selected' | 'all'
  includedCount: number
  excludedCount: number
}) {
  const t = useTranslations('PlatformRollouts.state')
  if (mode === 'off') return <Badge>{t('off')}</Badge>
  if (mode === 'selected') {
    return <Badge tone="warning">{includedCount > 0 ? t('selected', { count: includedCount }) : t('selectedNone')}</Badge>
  }
  return <Badge tone="success">{excludedCount > 0 ? t('allExcluded', { count: excludedCount }) : t('all')}</Badge>
}

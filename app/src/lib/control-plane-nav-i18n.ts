import type { NavEntry, NavLeaf } from '@/components/ui/shell'
import type { ControlPlaneNavEntry } from '@/lib/control-plane-nav'

/** next-intl treats `.` as a nested path, so nav keys use `_`. */
export function navMessageKey(key: string): string {
  return key.replaceAll('.', '_')
}

export function localizeControlPlaneNav(
  nav: ControlPlaneNavEntry[],
  t: (key: string) => string,
): NavEntry[] {
  return nav.map((entry) => {
    if ('children' in entry) {
      return {
        key: entry.key,
        label: t(navMessageKey(entry.key)),
        children: entry.children.map(
          (child): NavLeaf => ({
            ...child,
            label: t(navMessageKey(child.key)),
          }),
        ),
      }
    }
    return { ...entry, label: t(navMessageKey(entry.key)) }
  })
}

import { redirect } from 'next/navigation'

/** A korábbi külön menüpont kompatibilitási átirányítása. */
export default function SystemAgentsPage() {
  redirect('/control-plane/platform/settings')
}

import { redirect } from 'next/navigation'

/** A platform-adminisztráció belépője a tenant-registryre irányít (§9.2). */
export default function PlatformIndexPage() {
  redirect('/control-plane/platform/tenants')
}

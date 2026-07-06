import { listStepTemplatesAdmin } from '@/app/actions/step-template'
import { StepTemplateAdmin, type StepTemplateAdminView } from '@/components/playbooks/step-template-admin'

export default async function StepTemplatesPage() {
  const res = await listStepTemplatesAdmin()
  const templates: StepTemplateAdminView[] = res.success ? (res.data as StepTemplateAdminView[]) : []

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Governed Flow Builder</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Lépés-sablonok</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Újrahasznosítható, governance-safe lépés-legók a Playbook Canvas palettájához. A sablon egy
          előkitöltött lépés-fragment (ajánlott capability-kkel és opcionális jóváhagyó kapuval), de SOHA
          nem ad futásidejű tool-jogot — azt a Tool Broker dönti el. A globális sablonokat a rendszer
          karbantartja; a tenant-saját sablonokat itt hozhatod létre, szerkesztheted, publikálhatod.
        </p>
      </div>
      {!res.success && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          Nem sikerült betölteni: {res.error}
        </p>
      )}
      <StepTemplateAdmin templates={templates} />
    </div>
  )
}

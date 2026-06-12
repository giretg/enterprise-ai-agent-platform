import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import { useDemo } from '../../shared/context/DemoContext'
import { demoInvoiceFileName } from '../../shared/mock-data'

export function WorkspacePage() {
  const navigate = useNavigate()
  const { processingJobs, uploadInvoice, completeProcessing } = useDemo()
  const [activeJobId, setActiveJobId] = useState<string | null>(null)

  const handleUpload = () => {
    const jobId = uploadInvoice(demoInvoiceFileName)
    setActiveJobId(jobId)
  }

  useEffect(() => {
    if (!activeJobId) return
    const job = processingJobs.find((j) => j.id === activeJobId)
    if (job?.status === 'processing') {
      const timer = setTimeout(() => {
        const proposal = completeProcessing(activeJobId)
        navigate(`/sandbox/proposals/${proposal.id}`)
      }, 2200)
      return () => clearTimeout(timer)
    }
  }, [activeJobId, processingJobs, completeProcessing, navigate])

  const activeJobs = processingJobs.filter((j) => j.status === 'processing')

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-50">
          Könyvelő munkatér
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Beszállítói számlák feltöltése és agent által feldolgozott javaslatok
        </p>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <MiniStat label="Ma feldolgozva" value="3" />
        <MiniStat label="Jóváhagyásra vár" value="1" />
        <MiniStat label="Agent" value="Könyvelő v2.1" />
      </div>

      <Card
        title="Számla feltöltés"
        action={
          <button
            type="button"
            onClick={handleUpload}
            disabled={activeJobs.length > 0}
            className="rounded-md bg-teal-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + Számla feltöltése
          </button>
        }
      >
        <div className="rounded-lg border-2 border-dashed border-slate-600 bg-slate-900/40 p-8 text-center">
          <p className="text-sm text-slate-400">
            Húzd ide a PDF számlát, vagy kattints a feltöltés gombra
          </p>
          <p className="mt-2 font-mono text-xs text-slate-500">
            Demo fájl: {demoInvoiceFileName}
          </p>
        </div>
      </Card>

      {(activeJobs.length > 0 || processingJobs.length > 0) && (
        <Card title="Feldolgozás alatt" className="mt-6">
          <div className="space-y-3">
            {processingJobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center justify-between rounded-md border border-slate-700/60 bg-slate-900/50 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  {job.status === 'processing' ? (
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-teal-500 border-t-transparent" />
                  ) : (
                    <span className="text-emerald-400">✓</span>
                  )}
                  <div>
                    <p className="text-sm font-medium text-slate-200">
                      {job.fileName}
                    </p>
                    <p className="text-xs text-slate-500">
                      Könyvelő Agent feldolgozza…
                    </p>
                  </div>
                </div>
                <Badge
                  variant={
                    job.status === 'processing' ? 'warning' : 'success'
                  }
                >
                  {job.status === 'processing' ? 'feldolgozás alatt' : 'kész'}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Kész javaslatok" className="mt-6">
        <p className="text-sm text-slate-500">
          Az újonnan feldolgozott számlák javaslat-részlet oldalon jelennek meg.
          Küldés után ticket keletkezik a Control Plane boardon.
        </p>
      </Card>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-800/40 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-100">{value}</p>
    </div>
  )
}

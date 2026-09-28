import { requireTenantRole } from '@/auth/tenant-context'
import { getMcpParityReportAction } from '@/app/actions/mcp-parity'
import { Card } from '@/components/ui/shell'

function pct(v: number | null): string {
  return v === null ? '—' : `${v}%`
}

/**
 * MCP-agent paritás (#666): jól használja-e a külső AI az agentet.
 * Agent×kliens bontás + napi trend az audit napló munkamenet-összesítéséből.
 */
export default async function McpParityPage() {
  await requireTenantRole('approver')
  const res = await getMcpParityReportAction({ days: 30 })

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">MCP-paritás</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">
          Jól használja a külső AI az agentet?
        </h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Munkamenetenként mérjük: betöltötte-e a definíciót és a memóriát az első keresés
          előtt, elolvasta-e a belépő skillt, írt-e naplót vagy memóriát a végén — és hány
          hibája volt. A munkamenetet a kliens által küldött <code>mcp-session-id</code>{' '}
          fejléc határolja; fejléc nélkül a sorok &bdquo;unknown&rdquo; munkamenetbe
          kerülnek.
        </p>
      </div>

      {!res.success ? (
        <p className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {res.error}
        </p>
      ) : res.data.sessions === 0 ? (
        <Card>
          <p className="py-8 text-center text-ink-faint">
            Még nincs mérhető MCP-forgalom az elmúlt 30 napban. Amint egy kliens
            (Claude Desktop, Cursor, Codex) <code>mcp-session-id</code> fejlécet küld,
            itt megjelennek az arányok.
          </p>
        </Card>
      ) : (
        <>
          <Card>
            <p className="mb-3 text-sm text-ink-soft">
              Munkamenetek: <strong>{res.data.sessions}</strong>
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-ink-faint">
                    <th className="pb-2 pr-4 text-xs">Agent</th>
                    <th className="pb-2 pr-4 text-xs">Kliens</th>
                    <th className="pb-2 pr-4 text-xs">Munkamenet</th>
                    <th className="pb-2 pr-4 text-xs">Definíció időben</th>
                    <th className="pb-2 pr-4 text-xs">Memória időben</th>
                    <th className="pb-2 pr-4 text-xs">Skill olvasva</th>
                    <th className="pb-2 pr-4 text-xs">Napló/memória írva</th>
                    <th className="pb-2 text-xs">Hiba/munkamenet</th>
                  </tr>
                </thead>
                <tbody>
                  {res.data.cells.map((c: {
                    agentId: string
                    clientName: string
                    sessions: number
                    pctDefinition: number | null
                    pctMemory: number | null
                    pctSkill: number | null
                    pctLogOrMemory: number | null
                    errorsPerSession: number
                  }) => (
                    <tr key={`${c.agentId}-${c.clientName}`} className="border-b border-line/50">
                      <td className="py-2 pr-4 font-mono text-xs">{c.agentId.slice(0, 12)}</td>
                      <td className="py-2 pr-4 text-xs">{c.clientName}</td>
                      <td className="py-2 pr-4 text-xs">{c.sessions}</td>
                      <td className="py-2 pr-4 text-xs">{pct(c.pctDefinition)}</td>
                      <td className="py-2 pr-4 text-xs">{pct(c.pctMemory)}</td>
                      <td className="py-2 pr-4 text-xs">{pct(c.pctSkill)}</td>
                      <td className="py-2 pr-4 text-xs">{pct(c.pctLogOrMemory)}</td>
                      <td className="py-2 text-xs">{c.errorsPerSession}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 font-medium">Napi trend (jó munkamenetek aránya)</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-ink-faint">
                    <th className="pb-2 pr-4 text-xs">Nap</th>
                    <th className="pb-2 pr-4 text-xs">Munkamenet</th>
                    <th className="pb-2 text-xs">Jó arány</th>
                  </tr>
                </thead>
                <tbody>
                  {res.data.trend.map((t: { day: string; sessions: number; pctGood: number | null }) => (
                    <tr key={t.day} className="border-b border-line/50">
                      <td className="py-2 pr-4 font-mono text-xs">{t.day}</td>
                      <td className="py-2 pr-4 text-xs">{t.sessions}</td>
                      <td className="py-2 text-xs">{pct(t.pctGood)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-ink-faint">
              Jó munkamenet: belépő skill olvasva és napló vagy memória írva a végén.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}

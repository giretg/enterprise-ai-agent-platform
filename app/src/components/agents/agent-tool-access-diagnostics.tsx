/**
 * „Eszköz-hozzáférés ellenőrzése" panel (issue #194, WP-5).
 *
 * MIÉRT KELL: amikor egy agent nem csinálja meg a feladatot, a tünet mindig
 * ugyanaz — „nem történt semmi, és nem mondta meg, miért". A tulajdoni-lap
 * ügyben az ok egy hiányzó jogosultsági sor volt három eszközön. Ez a panel
 * pont ezt mutatja meg egy pillantás alatt, hétköznapi nyelven.
 */
import type {
  AgentToolAccessReport,
  ToolAccessDiagnosis,
} from '@/domain/tool-broker/tool-access-diagnostics'
import { Badge, Card } from '@/components/ui/shell'
import { formatToolUiName } from '@/lib/tool-ui-labels'

function ToolList({ items }: { items: ToolAccessDiagnosis[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {items.map((item) => (
        <li key={item.tool} className="atelier-soft px-2.5 py-1 text-xs text-ink">
          {formatToolUiName(item.tool)}
        </li>
      ))}
    </ul>
  )
}

export function AgentToolAccessDiagnostics({ report }: { report: AgentToolAccessReport }) {
  const { visibleWithoutGrant, handlerMissing } = report
  const usable = report.tools.filter((t) => t.visible && t.allowed && t.handlerResolvable)
  const healthy = visibleWithoutGrant.length === 0 && handlerMissing.length === 0

  return (
    <Card title="Eszköz-hozzáférés ellenőrzése">
      <div className="mb-4 rounded-lg border border-ink-faint/20 bg-ink-faint/5 px-3 py-2 text-xs text-ink-faint">
        Ez a doboz azt mutatja, hogy amit az agent <strong>lát</strong>, azt valóban{' '}
        <strong>használhatja</strong> is. Ha a kettő nem fedi egymást, az agent nekifog a
        feladatnak, elakad, és jellemzően nem tudja megmondani, mi hiányzik — a felhasználó
        felé ez &bdquo;nem működik&rdquo; tünetként jelenik meg.
      </div>

      <p className="text-sm text-ink">
        <strong>{usable.length}</strong> eszközt tud ténylegesen használni a beszélgetésekben.
      </p>

      {healthy && (
        <p className="mt-3 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          Nincs eltérés: minden felkínált beszélgetés-eszközhöz van jogosultság.
        </p>
      )}

      {visibleWithoutGrant.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center gap-2">
            <Badge tone="danger">Látja, de nincs joga</Badge>
            <span className="text-xs text-ink-faint">{visibleWithoutGrant.length} eszköz</span>
          </div>
          <p className="mt-2 text-xs text-ink-faint">
            Az agent felkínálva látja ezeket az eszközöket, de a rendszer visszautasítja a
            hívást, mert nincs rájuk kiadott jogosultság. Ha az agent feladatához kellenek,
            pipáld be őket alább az &bdquo;Eszközjogok szerkesztése&rdquo; résznél.
          </p>
          <ToolList items={visibleWithoutGrant} />
        </div>
      )}

      {handlerMissing.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center gap-2">
            <Badge tone="danger">Nincs végrehajtó</Badge>
            <span className="text-xs text-ink-faint">{handlerMissing.length} eszköz</span>
          </div>
          <p className="mt-2 text-xs text-ink-faint">
            Platformhiba: az eszköz felkínált és engedélyezett, de nincs mögötte végrehajtó
            kód — a hívás futásidőben hibára futna. Jelezd a platform csapatnak.
          </p>
          <ToolList items={handlerMissing} />
        </div>
      )}
    </Card>
  )
}

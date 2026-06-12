export function PrototypeBanner() {
  return (
    <div className="flex items-center justify-center gap-2 border-b border-amber-900/50 bg-amber-950/40 px-4 py-1.5 text-xs text-amber-200">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
      <span>
        <strong>Prototípus</strong> — mock adatok, szimulált logika, nincs valódi
        backend vagy LLM
      </span>
    </div>
  )
}

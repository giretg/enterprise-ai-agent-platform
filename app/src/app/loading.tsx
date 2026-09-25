import { LoadingState } from '@/components/ui/spinner'

/**
 * Első festés, amíg a gyökér-gyerek (pl. control-plane layout auth) készül.
 * `fallback={null}` nélkül is kell: a nested layout awaitje alatt különben
 * csak a krém háttér látszik — üres indítási képernyő.
 */
export default function RootLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-6">
      <LoadingState size="lg" />
    </div>
  )
}

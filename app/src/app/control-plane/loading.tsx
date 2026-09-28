import { LoadingState } from '@/components/ui/spinner'

/** A héj (layout) alatt, amíg az oldaladat megjön. */
export default function ControlPlaneLoading() {
  return <LoadingState className="min-h-[40vh]" />
}

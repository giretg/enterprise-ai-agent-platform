import type { GatewayPendingOperation } from '@/domain/gateway-operation'

export type PendingOperationRow = GatewayPendingOperation & {
  requesterName: string
  agentName: string
}

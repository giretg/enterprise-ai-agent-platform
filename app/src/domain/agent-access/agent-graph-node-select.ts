/**
 * Az agent-hozzáférési gráf döntéséhez és az org-ábrához szükséges MINIMÁLIS
 * agent-mezők (Access-Policy §agent-scope, #142).
 *
 * Szándékosan nem a teljes `Agent`: a gráf-döntés hot-path (minden lista-szűrés és
 * minden explicit célpróba lefuttatja), ezért nem overfetch-elünk prompt-szövegeket,
 * memóriát vagy modell-konfigot.
 */
export const AGENT_GRAPH_NODE_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
  personaNickname: true,
  personaTrait: true,
  role: true,
  systemRole: true,
  status: true,
  tenantId: true,
  hiddenFromOperators: true,
  inboundRestricted: true,
  outboundRestricted: true,
} as const

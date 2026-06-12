import { Navigate, Route, Routes } from 'react-router-dom'
import { ControlPlaneLayout } from './control-plane/ControlPlaneLayout'
import { AdminPage } from './control-plane/pages/AdminPage'
import { AgentDetailPage } from './control-plane/pages/AgentDetailPage'
import { AgentRegistryPage } from './control-plane/pages/AgentRegistryPage'
import { AgentWizardPage } from './control-plane/pages/AgentWizardPage'
import { AuditLogPage } from './control-plane/pages/AuditLogPage'
import { BoardPage } from './control-plane/pages/BoardPage'
import { DashboardPage } from './control-plane/pages/DashboardPage'
import { IamPage } from './control-plane/pages/IamPage'
import { ModelGatewayPage } from './control-plane/pages/ModelGatewayPage'
import { PlaybookPage } from './control-plane/pages/PlaybookPage'
import { ResourceCatalogPage } from './control-plane/pages/ResourceCatalogPage'
import { TicketDetailPage } from './control-plane/pages/TicketDetailPage'
import { SandboxLayout } from './sandbox/SandboxLayout'
import { ProposalDetailPage } from './sandbox/pages/ProposalDetailPage'
import { WorkspacePage } from './sandbox/pages/WorkspacePage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/control-plane" replace />} />
      <Route path="/control-plane" element={<ControlPlaneLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="board" element={<BoardPage />} />
        <Route path="tickets/:ticketId" element={<TicketDetailPage />} />
        <Route path="agents" element={<AgentRegistryPage />} />
        <Route path="agents/new" element={<AgentWizardPage />} />
        <Route path="agents/:agentId" element={<AgentDetailPage />} />
        <Route path="resources" element={<ResourceCatalogPage />} />
        <Route path="models" element={<ModelGatewayPage />} />
        <Route path="playbook" element={<PlaybookPage />} />
        <Route path="audit" element={<AuditLogPage />} />
        <Route path="iam" element={<IamPage />} />
        <Route path="admin" element={<AdminPage />} />
      </Route>
      <Route path="/sandbox" element={<SandboxLayout />}>
        <Route index element={<WorkspacePage />} />
        <Route path="proposals/:proposalId" element={<ProposalDetailPage />} />
      </Route>
    </Routes>
  )
}

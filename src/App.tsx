import { TopNavBar } from './components/TopNavBar';
import { ServiceCatalogSidebar } from './components/ServiceCatalogSidebar';
import { CloudCanvas } from './components/CloudCanvas';
import { RightWorkspaceDrawer } from './components/RightWorkspaceDrawer';
import { BlueprintModal } from './components/BlueprintModal';
import { ImportExportModal } from './components/ImportExportModal';
import { ExportModal } from './components/ExportModal';
import { CostAnalyticsView } from './components/CostAnalyticsView';
import { HistoryView } from './components/HistoryView';
import { useCloudStore } from './store/useCloudStore';
import { cn } from './components/ui';

export function App() {
  const view = useCloudStore((s) => s.view);
  return (
    <div className="h-screen w-screen flex flex-col bg-base text-fg overflow-hidden">
      <TopNavBar />
      {/* The canvas stays mounted behind the cost page so its viewport survives the switch */}
      <div className={cn('flex-1 flex min-h-0 overflow-hidden', view !== 'design' && 'hidden')}>
        <ServiceCatalogSidebar />
        <CloudCanvas />
        <RightWorkspaceDrawer />
      </div>
      {view === 'costs' && <CostAnalyticsView />}
      {view === 'history' && <HistoryView />}
      <BlueprintModal />
      <ImportExportModal />
      <ExportModal />
    </div>
  );
}

export default App;

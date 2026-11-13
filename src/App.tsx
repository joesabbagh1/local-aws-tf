import { TopNavBar } from './components/TopNavBar';
import { ServiceCatalogSidebar } from './components/ServiceCatalogSidebar';
import { CloudCanvas } from './components/CloudCanvas';
import { RightWorkspaceDrawer } from './components/RightWorkspaceDrawer';
import { BlueprintModal } from './components/BlueprintModal';
import { ImportExportModal } from './components/ImportExportModal';

export function App() {
  return (
    <div className="h-screen w-screen flex flex-col bg-base text-fg overflow-hidden">
      <TopNavBar />
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <ServiceCatalogSidebar />
        <CloudCanvas />
        <RightWorkspaceDrawer />
      </div>
      <BlueprintModal />
      <ImportExportModal />
    </div>
  );
}

export default App;

import { TopNavBar } from './components/TopNavBar';
import { ServiceCatalogSidebar } from './components/ServiceCatalogSidebar';
import { CloudCanvas } from './components/CloudCanvas';
import { RightWorkspaceDrawer } from './components/RightWorkspaceDrawer';
import { BlueprintModal } from './components/BlueprintModal';

export function App() {
  return (
    <div className="h-screen w-screen flex flex-col bg-[#090b10] text-slate-100 overflow-hidden">
      <TopNavBar />
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <ServiceCatalogSidebar />
        <CloudCanvas />
        <RightWorkspaceDrawer />
      </div>
      <BlueprintModal />
    </div>
  );
}

export default App;

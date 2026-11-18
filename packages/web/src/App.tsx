import { useEffect, useRef } from 'react';
import { connect, useStore } from './store.ts';
import { TopBar, Banners } from './components/TopBar.tsx';
import { UpdateBanner } from './components/UpdateBanner.tsx';
import { DroPanel } from './components/Dro.tsx';
import { JogPanel } from './components/Jog.tsx';
import { Visualizer } from './components/Visualizer.tsx';
import { ProgressPanel } from './components/Progress.tsx';
import { JobPanel } from './components/JobPanel.tsx';
import { LibraryPanel } from './components/Library.tsx';
import { ToolsPanel } from './components/Console.tsx';
import { StartDialog } from './components/StartDialog.tsx';
import { SettingsDialog } from './components/Settings.tsx';
import { ProbeDialog } from './components/ProbeDialog.tsx';
import { LibraryManager } from './components/LibraryManager.tsx';
import { Toasts } from './components/Toasts.tsx';
import { ColumnResizer } from './components/ColumnResizer.tsx';

export function App() {
  const state = useStore((s) => s.state);
  const socket = useStore((s) => s.socket);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    connect();
  }, []);

  if (!state) {
    return (
      <div className="offline">
        <div className="eyebrow">GCode Controller</div>
        <div>{socket === 'closed' ? 'Server unreachable. Retrying…' : 'Connecting…'}</div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar />
      <div>
        <UpdateBanner />
        <Banners />
      </div>
      <main className="main" ref={mainRef}>
        <div className="col left">
          <DroPanel />
          <JogPanel />
        </div>
        <div className="col center">
          <Visualizer />
          <ProgressPanel />
        </div>
        <ColumnResizer main={mainRef} />
        <div className="col right">
          <JobPanel />
          <LibraryPanel />
          <ToolsPanel />
        </div>
      </main>
      <StartDialog />
      <SettingsDialog />
      <LibraryManager />
      <ProbeDialog />
      <Toasts />
    </div>
  );
}

import { useEffect } from 'react';
import { connect, useStore } from './store.ts';
import { TopBar, Banners } from './components/TopBar.tsx';
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
import { Toasts } from './components/Toasts.tsx';

export function App() {
  const state = useStore((s) => s.state);
  const socket = useStore((s) => s.socket);

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
        <Banners />
      </div>
      <main className="main">
        <div className="col left">
          <DroPanel />
          <JogPanel />
        </div>
        <div className="col center">
          <Visualizer />
          <ProgressPanel />
        </div>
        <div className="col right">
          <JobPanel />
          <LibraryPanel />
          <ToolsPanel />
        </div>
      </main>
      <StartDialog />
      <SettingsDialog />
      <ProbeDialog />
      <Toasts />
    </div>
  );
}

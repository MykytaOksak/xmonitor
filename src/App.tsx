import { useEffect } from 'react';
import { AlertsView } from './components/AlertsView';
import { PortfolioView } from './components/PortfolioView';
import { QuotesView } from './components/QuotesView';
import { Rail } from './components/Rail';
import { SettingsView } from './components/SettingsView';
import { startEngine, stopEngine } from './engine/engine';
import { initTelegram } from './engine/telegram';
import { initPortfolioMonitor } from './portfolio/monitor';
import { useApp } from './state/store';
import { useIsNarrow } from './useResponsive';
import { C } from './theme';

export default function App() {
  const view = useApp((s) => s.view);
  const narrow = useIsNarrow();

  useEffect(() => {
    startEngine();
    void initTelegram(); // resolve the bot username for the deep link
    initPortfolioMonitor(); // resume position tracking if a wallet was saved
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
    return stopEngine;
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: narrow ? 'column' : 'row',
        height: '100vh',
        background: C.surface,
        color: C.text,
        overflow: 'hidden',
      }}
    >
      <Rail horizontal={narrow} />
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {view === 'quotes' && <QuotesView />}
        {view === 'alerts' && <AlertsView />}
        {view === 'portfolio' && <PortfolioView />}
        {view === 'settings' && <SettingsView />}
      </div>
    </div>
  );
}

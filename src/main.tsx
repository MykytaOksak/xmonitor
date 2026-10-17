import './net-timeout'; // install the global fetch timeout before anything runs
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalCrashLogging, installSessionWatch } from './crashlog';
import './styles.css';

installGlobalCrashLogging();
installSessionWatch();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Last resort, for a crash outside the views (e.g. the rail). The
        per-view boundaries in App are what keep the engine alive. */}
    <ErrorBoundary scope="app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

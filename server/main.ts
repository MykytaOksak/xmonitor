// XARB bot server: runs the quote engine 24/7, evaluates price alerts, and
// serves the Telegram bot plus the settings API the website syncs with.
//
//   npm run server        (reads .env.local; see .env.example)
import './polyfill';
import { onScanCycle, startEngine } from '../src/engine/engine';
import { useApp } from '../src/state/store';
import { evaluateAlerts } from './alerts';
import { notify, startBot } from './bot';
import { startHttp } from './http';
import { initSettings } from './settings';

const refresh = parseInt(process.env.SCAN_SECONDS ?? '', 10);
if (refresh >= 5) useApp.setState({ refresh });

initSettings();
onScanCycle(() => {
  for (const hit of evaluateAlerts()) void notify('price', hit.text, hit.pairId);
});
startEngine();
startHttp(parseInt(process.env.PORT ?? '8080', 10));
void startBot();

process.on('unhandledRejection', (e) => console.error('[server] unhandled rejection:', e));

// The copy of record of the shared settings, and the engine wiring that
// follows it: every change is saved, pushed into the quote engine's store, and
// narrows the scan to the pairs that actually have an alert to evaluate.
import { allPairs, setCustomPairs } from '../src/config/pairs';
import { PAIR_DEPENDS, scanPairNow } from '../src/engine/engine';
import { applyOps, emptySettings } from '../src/engine/settings';
import type { PairAlert, SettingsOp, SharedSettings } from '../src/engine/types';
import { useApp } from '../src/state/store';
import { kvGet, kvSet } from './db';

let settings: SharedSettings = { ...emptySettings(), ...kvGet<Partial<SharedSettings>>('settings', {}) };
let version = kvGet<number>('settingsVersion', 0);

export const getSettings = (): SharedSettings => settings;
export const getVersion = (): number => version;

export const alertIsActive = (a: PairAlert | undefined): boolean =>
  !!a && !a.paused && (a.buy.enabled || a.sell.enabled);

/** Pairs with an active alert, plus the pairs their pricing reads. */
export function watchedPairs(): string[] {
  const want = new Set<string>();
  for (const p of allPairs()) {
    if (!alertIsActive(settings.savedAlerts[p.id])) continue;
    want.add(p.id);
    for (const dep of PAIR_DEPENDS[p.id] ?? []) want.add(dep);
  }
  return [...want];
}

function pushToEngine(): void {
  setCustomPairs(settings.customPairs);
  const before = new Set(watchedPairsInStore());
  const watched = new Set(watchedPairs());
  const disabledPairs: Record<string, boolean> = {};
  for (const p of allPairs()) if (!watched.has(p.id)) disabledPairs[p.id] = true;
  useApp.setState({
    savedAlerts: settings.savedAlerts,
    amounts: settings.amounts,
    disabledNets: settings.disabledNets,
    customPairs: settings.customPairs,
    disabledPairs,
  });
  // Quote a newly watched pair now rather than at the next cycle, so the bot
  // can show its live price straight away.
  for (const id of watched) if (!before.has(id)) void scanPairNow(id);
}

const watchedPairsInStore = (): string[] => {
  const { disabledPairs } = useApp.getState();
  return allPairs()
    .map((p) => p.id)
    .filter((id) => !disabledPairs[id]);
};

export function initSettings(): void {
  // Start with nothing watched, then let pushToEngine enable what has alerts.
  const all: Record<string, boolean> = {};
  for (const p of allPairs()) all[p.id] = true;
  useApp.setState({ disabledPairs: all });
  pushToEngine();
}

export function patchSettings(ops: SettingsOp[]): number {
  if (ops.length === 0) return version;
  settings = applyOps(settings, ops);
  version++;
  kvSet('settings', settings);
  kvSet('settingsVersion', version);
  pushToEngine();
  return version;
}

/** Read-modify-write of one pair's alert (used by the bot). */
export function updateAlert(pairId: string, fn: (a: PairAlert) => PairAlert, base: () => PairAlert): PairAlert {
  const next = fn(structuredClone(settings.savedAlerts[pairId] ?? base()));
  patchSettings([{ section: 'savedAlerts', key: pairId, value: next }]);
  return next;
}

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NetworkId } from '../config/networks';
import { PAIRS, pairById, setCustomPairs, type CustomPairSpec } from '../config/pairs';
import { fmtPrice } from '../engine/format';
import type {
  NetQuote,
  PairAlert,
  PairSnapshot,
  SaveState,
  SyncState,
  TgState,
} from '../engine/types';

export type View = 'quotes' | 'alerts' | 'portfolio' | 'settings';
export type SortKey = 'buy' | 'sell';
export type SortDir = 'asc' | 'desc';
export type QuotesMode = 'single' | 'scroll' | 'parallel';
export type PaneCount = 2 | 3 | 4;

const genProfileId = () =>
  'usr_' + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');

export interface AppState {
  // navigation / UI
  view: View;
  sel: string; // selected pair id (quotes)
  alertSel: string; // selected pair id (alerts)
  feedCollapsed: boolean;
  settingsOpen: boolean;
  pairMenuOpen: boolean;
  sortKey: SortKey;
  sortDir: SortDir;

  // quotes view modes
  quotesMode: QuotesMode;
  paneCount: PaneCount;
  panePairs: string[]; // pair id per parallel pane
  viewMenuOpen: boolean;
  expandedPairs: Record<string, boolean>; // scroll mode: pairId -> expanded
  scrollSettingsFor: string | null; // scroll mode: pair whose drawer is open
  feedTouched: boolean; // user has collapsed/expanded the feed by hand

  // user-defined pairs
  customPairs: CustomPairSpec[];
  customPairOpen: boolean; // the "new pair" dialog

  // local overrides (persisted)
  amounts: Record<string, number>; // pairId -> notional override
  disabledPairs: Record<string, boolean>; // pairId -> true
  disabledNets: Record<string, boolean>; // `${pairId}:${netId}` -> true
  drafts: Record<string, PairAlert>; // alert drafts being edited
  savedAlerts: Record<string, PairAlert>; // committed alerts, used by the engine
  threshold: number; // global min profit %, filters the feed
  refresh: number; // seconds

  // engine
  snapshots: Record<string, PairSnapshot>;
  engineSync: SyncState;
  simulatedSync: SyncState | null; // Settings "simulate snapshot state"
  lastSync: string;
  lastSyncAt: number;

  // alerts / telegram
  saveState: SaveState;
  tgState: TgState;
  tgChatId: string | null;
  tgBot: string | null;
  profileId: string;

  // actions
  set: (p: Partial<AppState>) => void;
  setView: (v: View) => void;
  selectPair: (id: string, opts?: { openSettings?: boolean }) => void;
  toggleSort: (k: SortKey) => void;
  setQuotesMode: (m: QuotesMode) => void;
  setPaneCount: (n: PaneCount) => void;
  setPanePair: (index: number, pairId: string) => void;
  togglePairExpanded: (pairId: string) => void;
  toggleScrollSettings: (pairId: string) => void;
  setFeedCollapsed: (v: boolean) => void;
  addCustomPair: (spec: CustomPairSpec) => void;
  removeCustomPair: (id: string) => void;
  setAmount: (pairId: string, v: number) => void;
  togglePair: (pairId: string) => void;
  toggleNet: (pairId: string, netId: string) => void;
  resetPair: (pairId: string) => void;
  resetLocal: () => void;
  updateRow: (pairId: string, row: NetQuote) => void;
  setRefreshing: (pairId: string, netId: string, on: boolean) => void;
  finishPair: (pairId: string) => void;
  updateDraft: (pairId: string, side: 'buy' | 'sell', patch: Partial<PairAlert['buy']>) => void;
  toggleAlertNet: (pairId: string, side: 'buy' | 'sell', netName: string) => void;
  saveAlerts: () => void;
}

/** Effective sync state shown in the header (simulation wins). */
export const effectiveSync = (s: Pick<AppState, 'engineSync' | 'simulatedSync'>): SyncState =>
  s.simulatedSync ?? s.engineSync;

/**
 * Feed docking. The manual collapse/expand wins once the user has touched it;
 * until then the mode decides — parallel needs the width, so it gets the 44px
 * rail, while single and scroll stay docked at 360px.
 */
export const feedIsCollapsed = (
  s: Pick<AppState, 'feedCollapsed' | 'feedTouched' | 'quotesMode'>,
): boolean => (s.feedTouched ? s.feedCollapsed : s.quotesMode === 'parallel');

/** Default alert draft derived from the pair's current best prices. */
export function defaultAlert(pairId: string, snapshots: Record<string, PairSnapshot>): PairAlert {
  const pair = pairById(pairId);
  const rows = Object.values(snapshots[pairId]?.rows ?? {});
  const live = rows.filter((r) => r.status === 'live');
  const buy = live.length ? Math.min(...live.map((r) => r.buy ?? Infinity)) : null;
  const sell = live.length ? Math.max(...live.map((r) => r.sell ?? -Infinity)) : null;
  const p = (v: number | null) => (v != null && isFinite(v) ? fmtPrice(v, pair.dp) : '1.0000');
  // Both sides start disabled so an untouched pair reads OFF in the list and
  // shows OFF toggles in the editor — the two always agree. Enabling a side
  // creates a draft and flips the list badge to SET.
  return {
    buy: { enabled: false, op: 'below', price: p(buy), cooldown: '15', netMode: 'all', nets: {} },
    sell: { enabled: false, op: 'above', price: p(sell), cooldown: '30', netMode: 'all', nets: {} },
  };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      view: 'quotes',
      sel: PAIRS[0].id,
      alertSel: PAIRS[0].id,
      feedCollapsed: false,
      settingsOpen: false,
      pairMenuOpen: false,
      sortKey: 'buy',
      sortDir: 'asc',

      quotesMode: 'single',
      paneCount: 3,
      // Panes keep 4 slots so stepping 4 -> 2 -> 4 restores the same pairs.
      panePairs: PAIRS.slice(0, 4).map((p) => p.id),
      viewMenuOpen: true,
      expandedPairs: {},
      scrollSettingsFor: null,
      feedTouched: false,

      customPairs: [],
      customPairOpen: false,

      amounts: {},
      disabledPairs: {},
      disabledNets: {},
      drafts: {},
      savedAlerts: {},
      threshold: 0.05,
      refresh: 15,

      snapshots: {},
      engineSync: 'syncing',
      simulatedSync: null,
      lastSync: '—',
      lastSyncAt: 0,

      saveState: 'idle',
      tgState: 'disconnected',
      tgChatId: null,
      tgBot: null,
      profileId: genProfileId(),

      set: (p) => set(p),
      setView: (v) => set({ view: v }),
      selectPair: (id, opts) =>
        set({
          sel: id,
          pairMenuOpen: false,
          quotesMode: 'single',
          ...(opts?.openSettings ? { settingsOpen: true } : {}),
        }),
      toggleSort: (k) =>
        set((s) => ({
          sortKey: k,
          sortDir: s.sortKey === k && s.sortDir === 'asc' ? 'desc' : 'asc',
        })),
      setQuotesMode: (m) => set({ quotesMode: m }),
      setPaneCount: (n) => set({ quotesMode: 'parallel', paneCount: n }),
      setPanePair: (index, pairId) =>
        set((s) => {
          const panePairs = [...s.panePairs];
          panePairs[index] = pairId;
          return { panePairs, pairMenuOpen: false };
        }),
      togglePairExpanded: (pairId) =>
        set((s) => ({ expandedPairs: { ...s.expandedPairs, [pairId]: !s.expandedPairs[pairId] } })),
      toggleScrollSettings: (pairId) =>
        set((s) => ({ scrollSettingsFor: s.scrollSettingsFor === pairId ? null : pairId })),
      setFeedCollapsed: (v) => set({ feedCollapsed: v, feedTouched: true }),
      addCustomPair: (spec) =>
        set((s) => {
          const customPairs = [...s.customPairs.filter((c) => c.id !== spec.id), spec];
          // The module mirror backs every synchronous pairById() caller.
          setCustomPairs(customPairs);
          return { customPairs, customPairOpen: false, sel: spec.id, quotesMode: 'single' };
        }),
      removeCustomPair: (id) =>
        set((s) => {
          const customPairs = s.customPairs.filter((c) => c.id !== id);
          setCustomPairs(customPairs);
          const amounts = { ...s.amounts };
          delete amounts[id];
          const disabledPairs = { ...s.disabledPairs };
          delete disabledPairs[id];
          const drafts = { ...s.drafts };
          delete drafts[id];
          const savedAlerts = { ...s.savedAlerts };
          delete savedAlerts[id];
          const disabledNets = { ...s.disabledNets };
          for (const k of Object.keys(disabledNets)) if (k.startsWith(`${id}:`)) delete disabledNets[k];
          return {
            customPairs,
            amounts,
            disabledPairs,
            disabledNets,
            drafts,
            savedAlerts,
            sel: s.sel === id ? PAIRS[0].id : s.sel,
            alertSel: s.alertSel === id ? PAIRS[0].id : s.alertSel,
            panePairs: s.panePairs.map((p) => (p === id ? PAIRS[0].id : p)),
          };
        }),
      setAmount: (pairId, v) =>
        set((s) => ({ amounts: { ...s.amounts, [pairId]: v } })),
      togglePair: (pairId) =>
        set((s) => ({ disabledPairs: { ...s.disabledPairs, [pairId]: !s.disabledPairs[pairId] } })),
      toggleNet: (pairId, netId) =>
        set((s) => {
          const key = `${pairId}:${netId}`;
          return { disabledNets: { ...s.disabledNets, [key]: !s.disabledNets[key] } };
        }),
      resetPair: (pairId) =>
        set((s) => {
          const amounts = { ...s.amounts };
          delete amounts[pairId];
          const disabledPairs = { ...s.disabledPairs };
          delete disabledPairs[pairId];
          const disabledNets = { ...s.disabledNets };
          for (const k of Object.keys(disabledNets)) if (k.startsWith(`${pairId}:`)) delete disabledNets[k];
          return { amounts, disabledPairs, disabledNets };
        }),
      resetLocal: () => set({ amounts: {}, disabledPairs: {}, disabledNets: {}, drafts: {}, savedAlerts: {} }),

      updateRow: (pairId, row) =>
        set((s) => {
          const snap = s.snapshots[pairId] ?? { pairId, rows: {}, at: 0 };
          return {
            snapshots: {
              ...s.snapshots,
              [pairId]: { ...snap, rows: { ...snap.rows, [row.netId]: row } },
            },
          };
        }),
      setRefreshing: (pairId, netId, on) =>
        set((s) => {
          const snap = s.snapshots[pairId];
          const row = snap?.rows[netId as NetworkId];
          if (!snap || !row) return {};
          return {
            snapshots: {
              ...s.snapshots,
              [pairId]: { ...snap, rows: { ...snap.rows, [netId]: { ...row, refreshing: on } } },
            },
          };
        }),
      finishPair: (pairId) =>
        set((s) => {
          const snap = s.snapshots[pairId];
          if (!snap) return {};
          return { snapshots: { ...s.snapshots, [pairId]: { ...snap, at: Date.now() } } };
        }),

      updateDraft: (pairId, side, patch) =>
        set((s) => {
          const cur = s.drafts[pairId] ?? s.savedAlerts[pairId] ?? defaultAlert(pairId, s.snapshots);
          return {
            drafts: { ...s.drafts, [pairId]: { ...cur, [side]: { ...cur[side], ...patch } } },
            saveState: 'idle',
          };
        }),
      toggleAlertNet: (pairId, side, netName) =>
        set((s) => {
          const cur = s.drafts[pairId] ?? s.savedAlerts[pairId] ?? defaultAlert(pairId, s.snapshots);
          const sc = cur[side];
          const on = sc.nets[netName] === undefined ? true : sc.nets[netName];
          return {
            drafts: {
              ...s.drafts,
              [pairId]: { ...cur, [side]: { ...sc, nets: { ...sc.nets, [netName]: !on } } },
            },
            saveState: 'idle',
          };
        }),
      saveAlerts: () => {
        set({ saveState: 'saving' });
        clearTimeout(saveTimer);
        // Persistence itself is synchronous (localStorage); the short delay
        // keeps the Saving… → ✓ saved feedback from the design readable.
        saveTimer = setTimeout(() => {
          const cur = get();
          const draft = cur.drafts[cur.alertSel];
          if (draft) {
            set({
              savedAlerts: { ...cur.savedAlerts, [cur.alertSel]: draft },
              saveState: 'saved',
            });
          } else {
            set({ saveState: 'saved' });
          }
        }, 500);
      },
    }),
    {
      name: 'xmonitor',
      // Custom pairs must reach the module mirror before anything calls
      // pairById() — the engine starts scanning as soon as the app mounts.
      onRehydrateStorage: () => (state) => {
        if (state?.customPairs?.length) setCustomPairs(state.customPairs);
      },
      partialize: (s) => ({
        sel: s.sel,
        alertSel: s.alertSel,
        feedCollapsed: s.feedCollapsed,
        feedTouched: s.feedTouched,
        quotesMode: s.quotesMode,
        paneCount: s.paneCount,
        panePairs: s.panePairs,
        viewMenuOpen: s.viewMenuOpen,
        expandedPairs: s.expandedPairs,
        scrollSettingsFor: s.scrollSettingsFor,
        customPairs: s.customPairs,
        amounts: s.amounts,
        disabledPairs: s.disabledPairs,
        disabledNets: s.disabledNets,
        drafts: s.drafts,
        savedAlerts: s.savedAlerts,
        threshold: s.threshold,
        refresh: s.refresh,
        tgChatId: s.tgChatId,
        tgBot: s.tgBot,
        tgState: s.tgState === 'connected' ? ('connected' as TgState) : ('disconnected' as TgState),
        profileId: s.profileId,
      }),
    },
  ),
);

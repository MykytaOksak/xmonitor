import { useEffect, useMemo, useRef, useState } from 'react';
import { NET, type NetworkId } from '../config/networks';
import { allPairs, isCustomPair, pairName, type PairConfig } from '../config/pairs';
import { computeBest, tagFor } from '../engine/arb';
import { refreshNow } from '../engine/engine';
import { fmtAge, fmtClock, fmtNotional, fmtPrice, fmtProfit, fmtSpread } from '../engine/format';
import type { BestRoute, NetQuote } from '../engine/types';
import {
  effectiveSync,
  feedIsCollapsed,
  useApp,
  type AppState,
  type PaneCount,
  type QuotesMode,
} from '../state/store';
import { C, capsLabel, mono, sans } from '../theme';
import { useIsNarrow, useIsPhone } from '../useResponsive';
import { CustomPairDialog } from './CustomPairDialog';
import { NetChip, NetLogo, StatusDot, UnitInput, ViewModeMenu } from './ui';

interface PairVM {
  pair: PairConfig;
  name: string;
  best: BestRoute | null;
  bestBuy: number | null;
  notional: number;
  disabled: boolean;
  hasError: boolean;
  qualifies: boolean;
  /** When this pair's own scan last completed (0 = never). */
  at: number;
  /** True while any of its enabled networks is being fetched. */
  busy: boolean;
}

const useTick = (ms: number, active: boolean) => {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms, active]);
};

function opportunityTag(best: BestRoute): string {
  const buyActions: Partial<Record<NetworkId, string>> = {
    avalancheMint: 'MINT',
    fluentStake: 'STAKE',
  };
  const sellActions: Partial<Record<NetworkId, string>> = {
    avalancheMint: 'REDEEM',
    fluentStake: 'UNSTAKE',
  };
  const buyAction = buyActions[best.buyNet];
  const sellAction = sellActions[best.sellNet];

  if (buyAction && sellAction) return `${buyAction}/${sellAction}`;
  return buyAction ?? sellAction ?? tagFor(best);
}

function netRouteSuffix(id: NetworkId): string | undefined {
  const suffixes: Partial<Record<NetworkId, string>> = {
    avalancheMint: 'mint/redeem',
    fluentStake: 'stake/unstake',
  };
  return suffixes[id];
}

type SortState = Pick<AppState, 'snapshots' | 'disabledNets' | 'sortKey' | 'sortDir'>;

/** Enabled networks of a pair as quote rows, in the current sort order. */
function sortedRowsFor(pair: PairConfig, s: SortState): NetQuote[] {
  const snapRows = s.snapshots[pair.id]?.rows ?? {};
  const dir = s.sortDir === 'asc' ? 1 : -1;
  return pair.networks
    .filter((n) => !s.disabledNets[`${pair.id}:${n}`])
    .map(
      (n) =>
        snapRows[n] ?? { netId: n, buy: null, sell: null, router: '—', status: 'loading' as const, at: 0 },
    )
    .sort((a, b) => {
      const an = a[s.sortKey];
      const bn = b[s.sortKey];
      if (an == null && bn == null) return 0;
      if (an == null) return 1;
      if (bn == null) return -1;
      return (an - bn) * dir;
    });
}

const netGrid = (phone: boolean, narrow: boolean): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: phone ? '1.4fr 1fr 1fr' : '1.5fr 1fr 1fr 1.1fr .8fr',
  gap: narrow ? 8 : 14,
});

/**
 * Per-pair sync readout: the wall clock of *this pair's* last completed scan,
 * with the relative age on hover.
 *
 * A cycle-wide clock would lie here. `scanAll` launches every pair at once but
 * their network fetches queue through one shared concurrency pool, so pairs
 * finish minutes apart while `lastSync` only lands when the slowest one does.
 * `finishPair` stamps `snapshots[id].at` per pair, which is the honest number.
 */
function SyncClock({
  vm,
  showLabel = false,
  size = 10,
}: {
  vm: PairVM;
  /** One pair has room for the state word; panes show just the dot + clock. */
  showLabel?: boolean;
  size?: number;
}) {
  // The age is read on hover, so keep it honest between store updates.
  useTick(1000, vm.at > 0);

  // ERROR is reserved for a pair with nothing live at all. A single dead venue
  // among several is already flagged by that row's STATUS cell (and, in a pane,
  // by the header's own dot), so it must not colour the whole readout red.
  const nothingLive = vm.at > 0 && !vm.disabled && vm.bestBuy == null;
  const st = vm.busy
    ? { dot: C.body, word: 'SYNCING', color: '#9a9a9a', blink: true }
    : vm.at === 0
      ? { dot: C.body, word: 'IDLE', color: '#9a9a9a', blink: false }
      : nothingLive
        ? { dot: C.red, word: 'ERROR', color: C.red, blink: false }
        : { dot: C.green, word: 'SYNCED', color: '#9a9a9a', blink: false };

  const title = vm.busy
    ? `${vm.name} — syncing now`
    : vm.at > 0
      ? `${vm.name} — last synced ${fmtAge(Date.now() - vm.at)}`
      : `${vm.name} — not synced yet`;

  return (
    <span
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: showLabel ? 7 : 6,
        flex: 'none',
        ...mono(size, 500),
      }}
    >
      <StatusDot color={st.dot} blink={st.blink} />
      {showLabel && <span style={{ color: st.color }}>{st.word}</span>}
      <span className="tnum" style={{ color: showLabel ? C.text : C.secondary }}>
        {fmtClock(vm.at)}
      </span>
    </span>
  );
}

// ——————————————————————————— pair picker ———————————————————————————

/** Title button + the pair dropdown. Used by the main header and, scoped to a
 *  single pane, by each parallel pane header. */
function PairPicker({
  title,
  titleStyle,
  caretSize = 11,
  open,
  onOpenChange,
  vms,
  selId,
  onPick,
  onToggleEnabled,
  top = 26,
}: {
  title: string;
  titleStyle: React.CSSProperties;
  caretSize?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vms: PairVM[];
  selId: string;
  onPick: (pairId: string) => void;
  onToggleEnabled: (pairId: string) => void;
  top?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<string | null>(null);
  // Two-click removal: a stray click must not delete a pair the user configured.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const onRemoveCustom = (id: string) => {
    useApp.getState().removeCustomPair(id);
    setConfirmRemove(null);
  };

  useEffect(() => {
    if (!open) return;
    setConfirmRemove(null);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onOpenChange]);

  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 0 }}>
      <button
        onClick={() => onOpenChange(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          maxWidth: '100%',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: C.text,
        }}
      >
        <span
          style={{
            ...titleStyle,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </span>
        <span style={{ color: C.label, fontSize: caretSize, flex: 'none' }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top,
            left: 0,
            minWidth: 280,
            background: C.dropdown,
            border: '1px solid rgba(255,255,255,.14)',
            zIndex: 20,
            boxShadow: '0 12px 40px rgba(0,0,0,.6)',
            maxHeight: 420,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {vms.map((v) => (
            <button
              key={v.pair.id}
              onClick={() => {
                onPick(v.pair.id);
                onOpenChange(false);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                textAlign: 'left',
                padding: '10px 13px',
                background: v.pair.id === selId ? 'rgba(255,255,255,.05)' : 'transparent',
                border: 'none',
                borderBottom: `1px solid ${C.divider}`,
                cursor: 'pointer',
                opacity: v.disabled ? 0.78 : 1,
              }}
            >
              <StatusDot
                square
                size={6}
                color={v.disabled ? C.label : v.hasError ? C.red : C.green}
              />
              <span style={{ ...sans(12, 600), color: v.disabled ? C.label : C.text }}>{v.name}</span>
              <span
                className="tnum"
                style={{ marginLeft: 'auto', fontSize: 11, color: v.disabled ? C.label : C.secondary }}
              >
                {fmtPrice(v.bestBuy, v.pair.dp)}
              </span>
              {isCustomPair(v.pair.id) && (
                <span
                  role="button"
                  tabIndex={0}
                  title={confirmRemove === v.pair.id ? 'Click again to remove' : 'Remove custom pair'}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirmRemove === v.pair.id) onRemoveCustom(v.pair.id);
                    else setConfirmRemove(v.pair.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (confirmRemove === v.pair.id) onRemoveCustom(v.pair.id);
                    else setConfirmRemove(v.pair.id);
                  }}
                  style={{
                    ...mono(9, 500),
                    color: confirmRemove === v.pair.id ? C.red : C.label,
                    cursor: 'pointer',
                    flex: 'none',
                  }}
                >
                  {confirmRemove === v.pair.id ? 'remove?' : '✕'}
                </span>
              )}
              <span
                className="tnum"
                style={{
                  fontSize: 11,
                  color: C.secondary,
                  minWidth: 68,
                  textAlign: 'right',
                  textDecoration: 'underline',
                  textDecorationStyle: 'dashed',
                  textUnderlineOffset: 3,
                  cursor: 'pointer',
                }}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleEnabled(v.pair.id);
                  setHint(null);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleEnabled(v.pair.id);
                  setHint(null);
                }}
                onMouseEnter={() =>
                  setHint(v.disabled ? 'Click to enable' : 'Click to disable')
                }
                onMouseLeave={() => setHint(null)}
              >
                {v.disabled ? 'disabled' : 'enabled'}
              </span>
            </button>
          ))}
          </div>
          {/* One footer: the add button, with the enable/disable hint sharing
              the row so hovering a toggle does not add a second strip. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flex: 'none',
              background: C.dropdown,
              borderTop: `1px solid ${C.border}`,
            }}
          >
            <button
              className="hoverrow"
              onClick={() => {
                useApp.getState().set({ customPairOpen: true });
                onOpenChange(false);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                textAlign: 'left',
                padding: '10px 13px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                // The label must never wrap; the hint beside it gives way.
                flex: 'none',
                whiteSpace: 'nowrap',
                ...mono(11, 500),
                color: C.chipText,
              }}
            >
              <span style={{ fontSize: 13, lineHeight: 1 }}>+</span>
              <span style={{ letterSpacing: '.06em' }}>ADD CUSTOM PAIR</span>
            </button>
            {/* Zero intrinsic width (flex-basis 0, width 0): the hint only fills
                the space left beside the button and never widens the dropdown,
                which is sized by its content. Text that doesn't fit ellipsizes. */}
            <span
              style={{
                flex: '1 1 0',
                width: 0,
                minWidth: 0,
                padding: '0 13px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                textAlign: 'right',
                color: hint ? C.secondary : 'transparent',
                ...mono(9, 500),
              }}
            >
              {hint ?? ' '}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ——————————————————————— per-network quote table ———————————————————————

function NetTableHeader({
  phone,
  narrow,
  hpad,
  sortable,
  sortKey,
  sortDir,
  onSort,
}: {
  phone: boolean;
  narrow: boolean;
  hpad: number;
  sortable: boolean;
  sortKey: AppState['sortKey'];
  sortDir: AppState['sortDir'];
  onSort: (k: AppState['sortKey']) => void;
}) {
  const arrow = sortDir === 'asc' ? '▲' : '▼';
  return (
    <div
      style={{
        ...netGrid(phone, narrow),
        padding: `9px ${hpad}px`,
        borderBottom: `1px solid ${C.borderFaint}`,
      }}
    >
      <span style={capsLabel()}>NETWORK</span>
      {(['buy', 'sell'] as const).map((k) =>
        sortable ? (
          <button key={k} onClick={() => onSort(k)} style={sortBtn(sortKey === k)}>
            {k.toUpperCase()} {sortKey === k ? arrow : ''}
          </button>
        ) : (
          <span key={k} style={capsLabel()}>
            {k.toUpperCase()}
          </span>
        ),
      )}
      {!phone && <span style={capsLabel()}>ROUTER</span>}
      {!phone && <span style={capsLabel()}>STATUS</span>}
    </div>
  );
}

function NetTableRow({
  q,
  pair,
  phone,
  narrow,
  hpad,
}: {
  q: NetQuote;
  pair: PairConfig;
  phone: boolean;
  narrow: boolean;
  hpad: number;
}) {
  const refreshing = !!q.refreshing;
  const dot = q.status === 'live' ? C.green : q.status === 'error' ? C.red : C.body;
  const label = q.status === 'live' ? 'LIVE' : q.status === 'error' ? 'ERR' : 'LOADING';
  const priceColor = q.status === 'live' ? C.text : C.label;
  // Dim the (previous) price while this row is being re-fetched.
  const priceOpacity = refreshing && q.status !== 'loading' ? 0.5 : 1;
  return (
    <div
      className="hoverrow"
      title={q.err}
      style={{
        ...netGrid(phone, narrow),
        alignItems: 'center',
        padding: `9px ${hpad}px`,
        borderBottom: `1px solid ${C.dividerFaint}`,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
        <NetLogo id={q.netId} />
        <span
          style={{
            fontSize: 12.5,
            color: C.chipText,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {NET(q.netId).name}
        </span>
      </span>
      <span className="tnum" style={{ fontSize: 13, color: priceColor, opacity: priceOpacity }}>
        {fmtPrice(q.buy, pair.dp)}
      </span>
      <span className="tnum" style={{ fontSize: 13, color: priceColor, opacity: priceOpacity }}>
        {fmtPrice(q.sell, pair.dp)}
      </span>
      {!phone && (
        <span
          style={{
            fontSize: 12,
            color: C.secondary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {q.router}
        </span>
      )}
      {!phone && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <StatusDot color={refreshing ? C.secondary : dot} blink={q.status === 'loading' || refreshing} />
          <span style={{ ...mono(9.5, 500), letterSpacing: '.06em', color: refreshing ? C.secondary : dot }}>
            {refreshing && q.status !== 'loading' ? 'SYNC' : label}
          </span>
        </span>
      )}
    </div>
  );
}

// ————————————————————————— pair settings drawer —————————————————————————

function PairSettingsDrawer({
  pair,
  notional,
  stacked,
  hpad,
  onReset,
}: {
  pair: PairConfig;
  notional: number;
  /** Stack the two columns — narrow viewports and parallel panes. */
  stacked: boolean;
  hpad: number;
  onReset?: () => void;
}) {
  const s = useApp();
  return (
    <div
      style={{
        background: C.drawer,
        borderBottom: `1px solid ${C.border}`,
        padding: `12px ${hpad}px 16px`,
      }}
    >
      {onReset && (
        /* reset lives in its own row so it never overlaps the Networks label */
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button
            onClick={onReset}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              ...mono(10, 500),
              color: C.secondary,
              textDecoration: 'underline',
              textDecorationStyle: 'dashed',
              textUnderlineOffset: 3,
            }}
          >
            reset overrides
          </button>
        </div>
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: stacked ? 'column' : 'row',
          gap: stacked ? 16 : 28,
          alignItems: 'flex-start',
        }}
      >
        <div style={{ width: stacked ? '100%' : 220, flex: 'none', boxSizing: 'border-box' }}>
          <span style={{ fontSize: 11, color: C.secondary, display: 'block', marginBottom: 8 }}>
            Amount (trade size — priced at this volume)
          </span>
          <UnitInput
            prefix={pair.unit}
            value={String(notional)}
            onChange={(raw) => {
              const v = parseFloat(raw.replace(/[^0-9.]/g, ''));
              s.setAmount(pair.id, isNaN(v) ? 0 : v);
            }}
          />
        </div>
        <div style={{ flex: 1, width: stacked ? '100%' : undefined }}>
          <span style={{ fontSize: 11, color: C.secondary, display: 'block', marginBottom: 8 }}>
            Networks enabled for this pair
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {pair.networks.map((n) => (
              <NetChip
                key={n}
                id={n}
                suffix={netRouteSuffix(n)}
                on={!s.disabledNets[`${pair.id}:${n}`]}
                onToggle={() => s.toggleNet(pair.id, n)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ——————————————————————————— screen 2: all pairs ———————————————————————————

function ScrollMode({
  vms,
  phone,
  narrow,
  hpad,
}: {
  vms: PairVM[];
  phone: boolean;
  narrow: boolean;
  hpad: number;
}) {
  const s = useApp();

  // The 215px floor on PAIR fits the longest name plus its route tag.
  const cols = phone
    ? '12px minmax(0,1.5fr) minmax(88px,1fr) minmax(88px,1fr)'
    : narrow
      ? '12px minmax(200px,1.5fr) minmax(96px,1fr) minmax(96px,1fr) auto'
      : '12px minmax(215px,1.5fr) minmax(72px,.9fr) minmax(96px,1fr) minmax(96px,1fr) minmax(228px,auto)';
  const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: cols, gap: 14 };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div
        style={{
          ...row,
          position: 'sticky',
          top: 0,
          zIndex: 2,
          padding: `9px ${hpad}px 9px ${hpad - 3}px`,
          borderBottom: `1px solid ${C.borderFaint}`,
          background: C.surface,
        }}
      >
        <span />
        <span style={capsLabel()}>PAIR</span>
        {!narrow && <span style={capsLabel()}>NOTIONAL</span>}
        <span style={capsLabel()}>BEST BUY</span>
        <span style={capsLabel()}>BEST SELL</span>
        {!phone && <span />}
      </div>

      {vms.map((v) => {
        const expanded = !v.disabled && !!s.expandedPairs[v.pair.id];
        const settingsOpen = s.scrollSettingsFor === v.pair.id;
        const nameColor = v.disabled ? C.label : C.text;
        return (
          <div key={v.pair.id}>
            <div
              className="hoverrow"
              onClick={() => !v.disabled && s.togglePairExpanded(v.pair.id)}
              style={{
                ...row,
                alignItems: 'center',
                padding: `12px ${hpad}px 12px ${hpad - 3}px`,
                background: C.header,
                borderBottom: `1px solid ${C.border}`,
                borderLeft: `3px solid ${v.pair.id === s.sel ? C.green : 'transparent'}`,
                cursor: v.disabled ? 'default' : 'pointer',
              }}
            >
              <span style={{ ...mono(9, 500), color: expanded ? C.green : C.label }}>
                {v.disabled ? '·' : expanded ? '▾' : '▸'}
              </span>

              <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                <StatusDot
                  square
                  size={6}
                  color={v.disabled ? C.label : v.hasError ? C.red : C.green}
                />
                <span
                  style={{
                    ...sans(16, 600),
                    color: nameColor,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {v.name}
                </span>
                {v.best && (
                  <span
                    style={{
                      ...mono(8.5, 500),
                      color: C.secondary,
                      background: 'rgba(255,255,255,.05)',
                      padding: '2px 5px',
                      flex: 'none',
                    }}
                  >
                    {opportunityTag(v.best)}
                  </span>
                )}
              </span>

              {!narrow && (
                <span className="tnum" style={{ fontSize: 14, color: v.disabled ? C.label : C.text }}>
                  {fmtNotional(v.notional, v.pair.unit)}
                </span>
              )}

              {(['buy', 'sell'] as const).map((side) => {
                const net = side === 'buy' ? v.best?.buyNet : v.best?.sellNet;
                const price = side === 'buy' ? v.best?.buy : v.best?.sell;
                return (
                  <span
                    key={side}
                    style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}
                  >
                    {net && <NetLogo id={net} size={15} />}
                    <span
                      className="tnum"
                      style={{ fontSize: 14, color: v.best ? C.text : C.label }}
                    >
                      {fmtPrice(price ?? null, v.pair.dp)}
                    </span>
                  </span>
                );
              })}

              {!phone && (
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 14,
                  }}
                >
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      s.togglePair(v.pair.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      e.stopPropagation();
                      s.togglePair(v.pair.id);
                    }}
                    style={{
                      ...mono(11, 500),
                      color: C.secondary,
                      textDecoration: 'underline',
                      textDecorationStyle: 'dashed',
                      textUnderlineOffset: 3,
                      cursor: 'pointer',
                    }}
                  >
                    {v.disabled ? 'disabled' : 'enabled'}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      s.toggleScrollSettings(v.pair.id);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 11px',
                      background: settingsOpen ? C.greenBg14 : 'rgba(255,255,255,.04)',
                      border: `1px solid ${settingsOpen ? C.greenBorder45 : C.borderMid}`,
                      color: settingsOpen ? C.green : '#bcbcbc',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      ...mono(11, 500),
                    }}
                  >
                    ⚙ Pair settings
                  </button>
                  <button
                    title="Open in One pair"
                    onClick={(e) => {
                      e.stopPropagation();
                      s.selectPair(v.pair.id);
                    }}
                    style={{ ...collapseBtn, flex: 'none' }}
                  >
                    ⤢
                  </button>
                </span>
              )}
            </div>

            {settingsOpen && (
              <PairSettingsDrawer
                pair={v.pair}
                notional={v.notional}
                stacked={narrow}
                hpad={hpad}
                onReset={() => s.resetPair(v.pair.id)}
              />
            )}

            {expanded && (
              <>
                <NetTableHeader
                  phone={phone}
                  narrow={narrow}
                  hpad={hpad}
                  sortable={false}
                  sortKey={s.sortKey}
                  sortDir={s.sortDir}
                  onSort={s.toggleSort}
                />
                {sortedRowsFor(v.pair, s).map((q) => (
                  <NetTableRow
                    key={q.netId}
                    q={q}
                    pair={v.pair}
                    phone={phone}
                    narrow={narrow}
                    hpad={hpad}
                  />
                ))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ——————————————————————————— screen 3: parallel ———————————————————————————

function ParallelPane({
  vm,
  index,
  vms,
  spanTwo,
  lastCol,
  lastRow,
}: {
  vm: PairVM;
  index: number;
  vms: PairVM[];
  /** The odd third pane runs the full width beneath the top row. */
  spanTwo: boolean;
  /** Edge panes drop their border so it can't double up with the shell's. */
  lastCol: boolean;
  lastRow: boolean;
}) {
  const s = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rows = sortedRowsFor(vm.pair, s);
  const arrow = s.sortDir === 'asc' ? '▲' : '▼';
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 8 };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        background: C.surface,
        ...(lastCol ? {} : { borderRight: `1px solid ${C.border}` }),
        ...(lastRow ? {} : { borderBottom: `1px solid ${C.border}` }),
        ...(spanTwo ? { gridColumn: 'span 2' } : {}),
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '10px 13px',
          background: C.header,
          borderBottom: `1px solid ${C.borderFaint}`,
        }}
      >
        <StatusDot square size={6} color={vm.disabled ? C.label : vm.hasError ? C.red : C.green} />
        <PairPicker
          title={vm.name}
          titleStyle={sans(13, 600)}
          caretSize={10}
          top={20}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          vms={vms}
          selId={vm.pair.id}
          onPick={(id) => s.setPanePair(index, id)}
          onToggleEnabled={s.togglePair}
        />
        {/* Sized via longhand, not mono()'s `font` shorthand, which would
            reset the tabular-nums `.tnum` contributes. */}
        <span
          title="Trade size"
          className="tnum"
          style={{ fontSize: 10, fontWeight: 500, color: C.secondary, flex: 'none' }}
        >
          {fmtNotional(vm.notional, vm.pair.unit)}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', flex: 'none' }}>
          <SyncClock vm={vm} />
        </span>
        <button
          title="Pair settings"
          onClick={() => setSettingsOpen((o) => !o)}
          style={iconBtn(settingsOpen)}
        >
          ⚙
        </button>
        <button
          title="Remove pane"
          onClick={() => s.setPaneCount(Math.max(2, s.paneCount - 1) as PaneCount)}
          style={iconBtn(false)}
        >
          ✕
        </button>
      </div>

      {settingsOpen && (
        <PairSettingsDrawer pair={vm.pair} notional={vm.notional} stacked hpad={13} />
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ ...grid, padding: '8px 13px 4px' }}>
          <span style={capsLabel(9)}>NETWORK</span>
          {(['buy', 'sell'] as const).map((k) => (
            <button key={k} onClick={() => s.toggleSort(k)} style={sortBtn(s.sortKey === k, 9)}>
              {k.toUpperCase()} {s.sortKey === k ? arrow : ''}
            </button>
          ))}
        </div>
        {vm.disabled ? (
          <div style={{ padding: '8px 13px', color: C.secondary, ...sans(11) }}>Pair is disabled.</div>
        ) : (
          rows.map((q) => {
            // No STATUS column at this width — the price colour carries it.
            const refreshing = !!q.refreshing;
            const priceColor = q.status === 'live' ? C.text : C.label;
            const priceOpacity = refreshing && q.status !== 'loading' ? 0.5 : 1;
            return (
              <div key={q.netId} className="hoverrow" style={{ ...grid, alignItems: 'center', padding: '8px 13px' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <NetLogo id={q.netId} size={13} />
                  <span
                    style={{
                      fontSize: 11.5,
                      color: C.chipText,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {NET(q.netId).name}
                  </span>
                </span>
                <span
                  className="tnum"
                  style={{ fontSize: 12, color: priceColor, opacity: priceOpacity }}
                >
                  {fmtPrice(q.buy, vm.pair.dp)}
                </span>
                <span
                  className="tnum"
                  style={{ fontSize: 12, color: priceColor, opacity: priceOpacity }}
                >
                  {fmtPrice(q.sell, vm.pair.dp)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function ParallelMode({
  vms,
  paneVms,
  paneCount,
  narrow,
}: {
  vms: PairVM[];
  paneVms: PairVM[];
  paneCount: number;
  narrow: boolean;
}) {
  // 3 panes read as two across with one full-width beneath.
  const layout: React.CSSProperties = narrow
    ? { gridTemplateColumns: '1fr', gridAutoRows: 'minmax(220px, 1fr)' }
    : paneCount === 2
      ? { gridTemplateColumns: '1fr 1fr', gridAutoRows: 'minmax(0, 1fr)' }
      : { gridTemplateColumns: '1fr 1fr', gridTemplateRows: 'minmax(0, 1fr) minmax(0, 1fr)' };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', ...layout }}>
      {paneVms.map((vm, i) => {
        const spanTwo = !narrow && paneCount === 3 && i === 2;
        // One column when narrow, otherwise two — and the spanning third pane
        // reaches the right edge on its own.
        const lastCol = narrow || spanTwo || i % 2 === 1;
        const lastRow = narrow ? i === paneCount - 1 : i >= (paneCount === 2 ? 0 : 2);
        return (
          <ParallelPane
            key={i}
            vm={vm}
            index={i}
            vms={vms}
            spanTwo={spanTwo}
            lastCol={lastCol}
            lastRow={lastRow}
          />
        );
      })}
    </div>
  );
}

// ——————————————————————————————— the view ———————————————————————————————

export function QuotesView() {
  const s = useApp();
  const sync = effectiveSync(s);
  const narrow = useIsNarrow();
  const phone = useIsPhone();
  useTick(1000, sync === 'stale');

  // Phones have no room for panes; narrow viewports cap parallel at 2 stacked.
  const mode: QuotesMode = phone && s.quotesMode === 'parallel' ? 'single' : s.quotesMode;
  const maxPanes = narrow ? 2 : 4;
  const paneCount = Math.min(s.paneCount, maxPanes);
  const feedCollapsed = feedIsCollapsed({ ...s, quotesMode: mode });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const st = useApp.getState();
      if (e.key === '1') st.setQuotesMode('single');
      else if (e.key === '2') st.setQuotesMode('scroll');
      // Phones don't offer parallel, so its keys stay inert there too.
      else if (phone) return;
      else if (e.key === '3') st.setQuotesMode('parallel');
      else if (e.key === '4') st.setPaneCount(4);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [phone]);

  const vms: PairVM[] = useMemo(
    () =>
      allPairs().map((pair) => {
        const disabled = !!s.disabledPairs[pair.id];
        const snap = s.snapshots[pair.id];
        const rows = Object.values(snap?.rows ?? {}) as NetQuote[];
        const hasError =
          !disabled &&
          pair.networks.some((n) => !s.disabledNets[`${pair.id}:${n}`] && snap?.rows[n]?.status === 'error');
        // Quote age is judged against the pair's scan completion, so the
        // 20s rule prunes slow networks without emptying the feed between
        // refresh cycles.
        const best = !disabled && snap && snap.at > 0 ? computeBest(pair, rows, snap.at) : null;
        const liveBuys = disabled
          ? []
          : rows
              .filter((r) => r.status === 'live' && r.buy != null)
              .map((r) => r.buy as number);
        const bestBuy = liveBuys.length > 0 ? Math.min(...liveBuys) : null;
        const notional = s.amounts[pair.id] ?? pair.defaultNotional;
        const busy =
          !disabled &&
          pair.networks.some((n) => {
            if (s.disabledNets[`${pair.id}:${n}`]) return false;
            const r = snap?.rows[n];
            return !!r?.refreshing || r?.status === 'loading';
          });
        return {
          pair,
          name: pairName(pair),
          best,
          bestBuy,
          notional,
          disabled,
          hasError,
          qualifies: !disabled && best != null && best.spreadPct >= s.threshold,
          at: snap?.at ?? 0,
          busy,
        };
      }),
    [s.snapshots, s.amounts, s.disabledPairs, s.disabledNets, s.threshold, s.customPairs],
  );

  const byId = useMemo(() => new Map(vms.map((v) => [v.pair.id, v])), [vms]);
  const current = byId.get(s.sel) ?? vms[0];
  const pairMenuVms = [...vms].sort((a, b) => Number(a.disabled) - Number(b.disabled));
  const opps = vms.filter((v) => v.qualifies).sort((a, b) => b.best!.spreadPct - a.best!.spreadPct);

  // Panes fall back to the first pairs that aren't disabled when the stored
  // list is short (pane count raised) or names a pair that no longer exists.
  const paneVms = useMemo(() => {
    const fallback = vms.filter((v) => !v.disabled);
    return Array.from({ length: paneCount }, (_, i) => {
      const stored = s.panePairs[i];
      return (stored ? byId.get(stored) : undefined) ?? fallback[i] ?? vms[i % vms.length];
    });
  }, [vms, byId, s.panePairs, paneCount]);

  const staleAgo = s.lastSyncAt > 0 ? Math.max(0, Math.round((Date.now() - s.lastSyncAt) / 1000)) : 0;
  const hpad = narrow ? 12 : 18;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: narrow ? 'column' : 'row',
        position: 'relative',
      }}
    >
      {/* ——— quotes column ——— */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* header bar — All pairs names every pair, so it has none */}
        {mode === 'single' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 14,
              rowGap: 8,
              padding: `12px ${hpad}px`,
              borderBottom: `1px solid ${C.border}`,
              background: C.header,
              position: 'relative',
              zIndex: 5,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ ...capsLabel(9), letterSpacing: '.1em' }}>LIVE QUOTES</span>
              <PairPicker
                title={current.name}
                titleStyle={sans(17, 600)}
                open={s.pairMenuOpen}
                onOpenChange={(o) => s.set({ pairMenuOpen: o })}
                vms={pairMenuVms}
                selId={s.sel}
                onPick={(id) => s.selectPair(id)}
                onToggleEnabled={s.togglePair}
              />
            </div>

            {/* Only phone-width headers drop to just the pair picker + settings. */}
            {!phone && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  paddingLeft: 16,
                  borderLeft: `1px solid ${C.border}`,
                }}
              >
                <span style={{ ...capsLabel(9), letterSpacing: '.1em' }}>NOTIONAL</span>
                <span className="tnum" style={{ fontSize: 15, color: C.text }}>
                  {fmtNotional(current.notional, current.pair.unit)}
                </span>
              </div>
            )}

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
              {!phone && <SyncClock vm={current} showLabel />}
              <button
                title="Pair settings"
                onClick={() => s.set({ settingsOpen: !s.settingsOpen })}
                style={iconBtn(s.settingsOpen)}
              >
                ⚙
              </button>
            </div>
          </div>
        )}

        {/* sync banners */}
        {sync === 'stale' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '9px 18px',
              background: C.redBg08,
              borderBottom: `1px solid ${C.redBorder25}`,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: C.red,
                animation: 'blink 1.2s infinite',
              }}
            />
            <span style={{ ...mono(10, 600), color: C.red, letterSpacing: '.05em' }}>SNAPSHOT STALE</span>
            <span style={{ ...sans(11), color: C.secondary }}>
              Shared quote engine last updated {staleAgo}s ago — prices may have drifted.
            </span>
            <button onClick={refreshNow} style={bannerBtn}>
              ↻ Refresh now
            </button>
          </div>
        )}
        {sync === 'error' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '9px 18px',
              background: C.redBg10,
              borderBottom: `1px solid ${C.redBorder30}`,
            }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                display: 'grid',
                placeItems: 'center',
                ...mono(9, 600),
                color: C.red,
                border: `1px solid ${C.red}`,
              }}
            >
              !
            </span>
            <span style={{ ...mono(10, 600), color: C.red, letterSpacing: '.05em' }}>SNAPSHOT ERROR</span>
            <span style={{ ...sans(11), color: C.secondary }}>
              Could not reach quote endpoints — showing last known data.
            </span>
            <button onClick={refreshNow} style={bannerBtn}>
              ↻ Retry
            </button>
          </div>
        )}

        {/* pair settings drawer (the header's ⚙, so not in All pairs) */}
        {mode === 'single' && s.settingsOpen && (
          <PairSettingsDrawer
            pair={current.pair}
            notional={current.notional}
            stacked={narrow}
            hpad={hpad}
            onReset={() => s.resetPair(current.pair.id)}
          />
        )}

        {mode === 'single' && (
          <>
            <NetTableHeader
              phone={phone}
              narrow={narrow}
              hpad={hpad}
              sortable
              sortKey={s.sortKey}
              sortDir={s.sortDir}
              onSort={s.toggleSort}
            />
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {current.disabled ? (
                <div style={{ padding: '18px', color: C.secondary, ...sans(12) }}>Pair is disabled.</div>
              ) : (
                sortedRowsFor(current.pair, s).map((q) => (
                  <NetTableRow
                    key={q.netId}
                    q={q}
                    pair={current.pair}
                    phone={phone}
                    narrow={narrow}
                    hpad={hpad}
                  />
                ))
              )}
            </div>
          </>
        )}

        {mode === 'scroll' && <ScrollMode vms={vms} phone={phone} narrow={narrow} hpad={hpad} />}

        {mode === 'parallel' && (
          <ParallelMode
            vms={pairMenuVms}
            paneVms={paneVms}
            paneCount={paneCount}
            narrow={narrow}
          />
        )}
      </div>

      {/* ——— opportunities feed (docked right on wide, bottom on narrow) ——— */}
      {!feedCollapsed ? (
        <div
          style={{
            flex: 'none',
            display: 'flex',
            flexDirection: 'column',
            background: C.panel,
            ...(narrow
              ? { width: '100%', maxHeight: '42vh', borderTop: `1px solid ${C.border}` }
              : { width: 360, borderLeft: `1px solid ${C.border}` }),
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              borderBottom: `1px solid ${C.borderFaint}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={sans(12, 600)}>Opportunities</span>
              <span style={{ ...mono(10, 500), color: opps.length > 0 ? C.green : C.label }}>
                {opps.length} &gt; {s.threshold}%
              </span>
            </div>
            <button onClick={() => s.setFeedCollapsed(true)} title="Collapse" style={collapseBtn}>
              {narrow ? '▾' : '›'}
            </button>
          </div>

          {opps.length > 0 ? (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {opps.map((v) => {
                const b = v.best!;
                const selected = v.pair.id === s.sel;
                return (
                  <div
                    key={v.pair.id}
                    className="opprow"
                    onClick={() => s.selectPair(v.pair.id)}
                    style={{
                      padding: '13px 16px 13px 13px',
                      borderBottom: `1px solid ${C.divider}`,
                      borderLeft: `3px solid ${selected ? C.green : 'transparent'}`,
                      background: selected ? C.greenBg06 : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 9,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 7, height: 7, background: C.green, display: 'block' }} />
                        <span style={sans(13, 600)}>{v.name}</span>
                        <span
                          style={{
                            ...mono(8.5, 500),
                            color: C.secondary,
                            background: 'rgba(255,255,255,.05)',
                            padding: '2px 5px',
                          }}
                        >
                          {opportunityTag(b)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="tnum" style={{ fontSize: 13, fontWeight: 600, color: C.green }}>
                          {fmtSpread(b.spreadPct)}
                        </span>
                        <button
                          className="gearbtn"
                          title="Pair settings"
                          onClick={(e) => {
                            e.stopPropagation();
                            s.selectPair(v.pair.id, { openSettings: true });
                          }}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            color: C.label,
                            fontSize: 12,
                            padding: 0,
                          }}
                        >
                          ⚙
                        </button>
                      </div>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                        fontSize: 11,
                        color: C.secondary,
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <NetLogo id={b.buyNet} size={14} />
                        {fmtPrice(b.buy, v.pair.dp)}
                      </span>
                      <span style={{ color: '#4a4a4a' }}>→</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <NetLogo id={b.sellNet} size={14} />
                        {fmtPrice(b.sell, v.pair.dp)}
                      </span>
                      <span className="tnum" style={{ marginLeft: 'auto' }}>
                        {fmtNotional(v.notional, v.pair.unit)} ·{' '}
                        <span style={{ color: C.green }}>
                          {fmtProfit(b.spreadPct, v.notional, v.pair.unit)}
                        </span>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 11,
                textAlign: 'center',
                padding: 24,
              }}
            >
              <span style={{ width: 24, height: 24, border: '1px solid rgba(255,255,255,.14)' }} />
              <span style={{ ...sans(12, 600), color: C.chipText }}>No opportunities &gt; threshold</span>
              <span style={{ ...sans(11), color: C.label, maxWidth: 220 }}>
                All monitored pairs are below the {s.threshold}% min spread. Lower it in Settings to see
                more.
              </span>
            </div>
          )}
        </div>
      ) : narrow ? (
        // Collapsed on narrow: a full-width bottom bar; toggle stays on the right.
        <div
          style={{
            width: '100%',
            boxSizing: 'border-box',
            flex: 'none',
            borderTop: `1px solid ${C.border}`,
            background: C.panel,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 16px',
          }}
        >
          <span style={{ ...mono(10, 600), color: C.label, letterSpacing: '.1em' }}>
            <span style={{ color: opps.length > 0 ? C.green : C.label }}>{opps.length}</span>{' '}
            OPPORTUNITIES
          </span>
          <button
            onClick={() => s.setFeedCollapsed(false)}
            title="Expand"
            style={{ ...collapseBtn, marginLeft: 'auto' }}
          >
            ▴
          </button>
        </div>
      ) : (
        // Collapsed on wide: a slim vertical rail.
        <div
          style={{
            width: 44,
            flex: 'none',
            borderLeft: `1px solid ${C.border}`,
            background: C.panel,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: 12,
            gap: 14,
          }}
        >
          <button onClick={() => s.setFeedCollapsed(false)} title="Expand" style={collapseBtn}>
            ‹
          </button>
          <span
            style={{ ...mono(10, 600), color: C.label, writingMode: 'vertical-rl', letterSpacing: '.1em' }}
          >
            <span style={{ color: opps.length > 0 ? C.green : C.label }}>{opps.length}</span>{' '}
            OPPORTUNITIES
          </span>
        </div>
      )}

      {s.customPairOpen && <CustomPairDialog />}

      <ViewModeMenu
        open={s.viewMenuOpen}
        mode={mode}
        paneCount={paneCount as PaneCount}
        maxPanes={maxPanes}
        phone={phone}
        onToggleOpen={() => s.set({ viewMenuOpen: !s.viewMenuOpen })}
        onMode={s.setQuotesMode}
        onPaneCount={s.setPaneCount}
      />
    </div>
  );
}

const bannerBtn: React.CSSProperties = {
  marginLeft: 'auto',
  background: 'transparent',
  border: `1px solid ${C.borderInput}`,
  color: C.text,
  cursor: 'pointer',
  ...mono(10, 500),
  padding: '5px 11px',
};

const collapseBtn: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid rgba(255,255,255,.12)`,
  color: C.secondary,
  cursor: 'pointer',
  width: 24,
  height: 24,
  display: 'grid',
  placeItems: 'center',
  fontSize: 13,
  lineHeight: 1,
  padding: 0,
};

const sortBtn = (active: boolean, size = 10): React.CSSProperties => ({
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  ...capsLabel(size, active ? C.text : C.label),
  padding: 0,
});

/** Bare glyph button — the pane ⚙ / ✕ and the One-pair settings toggle. */
const iconBtn = (active: boolean): React.CSSProperties => ({
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  padding: '0 3px',
  ...mono(15, 500),
  lineHeight: 1,
  color: active ? C.green : C.label,
});

import type React from 'react';

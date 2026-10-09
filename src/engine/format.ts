import type { Unit } from '../config/pairs';

export const fmtNotional = (n: number, unit: Unit): string =>
  unit === 'ETH' ? `${Math.round(n * 1000) / 1000} ETH` : `$${n.toLocaleString('en-US')}`;

export const fmtPrice = (n: number | null | undefined, dp: number): string =>
  n == null || !isFinite(n) ? '—' : n.toFixed(dp);

export const fmtSpread = (pct: number | null | undefined): string => {
  if (pct == null || !isFinite(pct)) return '—';
  const dp = Math.abs(pct) >= 0.1 ? 2 : 3;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(dp)}%`;
};

export const fmtProfit = (pct: number | null | undefined, notional: number, unit: Unit): string => {
  if (pct == null || !isFinite(pct)) return '—';
  const v = (notional * pct) / 100;
  const sign = v >= 0 ? '+' : '−';
  const abs = Math.abs(v);
  return unit === 'ETH'
    ? `${sign}${abs.toFixed(3)} ETH`
    : `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** Wall clock of an epoch-ms instant; '—' for "never". */
export const fmtClock = (ms: number): string =>
  ms > 0 ? new Date(ms).toLocaleTimeString('en-GB') : '—';

/** Coarse relative age, for the sync readout's hover text. */
export const fmtAge = (ms: number): string => {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
};

export const nowTime = (): string => fmtClock(Date.now());

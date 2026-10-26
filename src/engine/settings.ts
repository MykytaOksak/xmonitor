// Key-level edits to the settings the website and the bot server share.
//
// Both sides apply the same ops, so an edit made in Telegram and one made on
// the site merge per key (one pair's alert, one pair's notional) instead of
// one whole copy overwriting the other.
import type { CustomPairSpec } from '../config/pairs';
import type { SettingsOp, SharedSettings } from './types';

export const SHARED_SECTIONS = ['savedAlerts', 'amounts', 'disabledNets', 'customPairs'] as const;

export const emptySettings = (): SharedSettings => ({
  savedAlerts: {},
  amounts: {},
  disabledNets: {},
  customPairs: [],
});

export function applyOps(cur: SharedSettings, ops: SettingsOp[]): SharedSettings {
  const next: SharedSettings = {
    savedAlerts: { ...cur.savedAlerts },
    amounts: { ...cur.amounts },
    disabledNets: { ...cur.disabledNets },
    customPairs: [...cur.customPairs],
  };
  for (const op of ops) {
    if (op.section === 'customPairs') {
      next.customPairs = next.customPairs.filter((c) => c.id !== op.key);
      if (op.value) next.customPairs.push(op.value);
      continue;
    }
    const map = next[op.section] as Record<string, unknown>;
    if (op.value === null) delete map[op.key];
    else map[op.key] = op.value;
  }
  return next;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function diffMap<S extends 'savedAlerts' | 'amounts' | 'disabledNets'>(
  section: S,
  prev: SharedSettings[S],
  next: SharedSettings[S],
): SettingsOp[] {
  const ops: SettingsOp[] = [];
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const a = (prev as Record<string, unknown>)[key];
    const b = (next as Record<string, unknown>)[key];
    if (!same(a, b)) ops.push({ section, key, value: (b ?? null) as never });
  }
  return ops;
}

/** The ops that turn `prev` into `next`. */
export function diffSettings(prev: SharedSettings, next: SharedSettings): SettingsOp[] {
  const ops = [
    ...diffMap('savedAlerts', prev.savedAlerts, next.savedAlerts),
    ...diffMap('amounts', prev.amounts, next.amounts),
    ...diffMap('disabledNets', prev.disabledNets, next.disabledNets),
  ];
  const byId = (list: CustomPairSpec[]) => new Map(list.map((c) => [c.id, c]));
  const a = byId(prev.customPairs);
  const b = byId(next.customPairs);
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    if (!same(a.get(id), b.get(id))) ops.push({ section: 'customPairs', key: id, value: b.get(id) ?? null });
  }
  return ops;
}

export const pickShared = (s: SharedSettings): SharedSettings => ({
  savedAlerts: s.savedAlerts,
  amounts: s.amounts,
  disabledNets: s.disabledNets,
  customPairs: s.customPairs,
});

/** Shape check for ops arriving over the network; drops anything malformed. */
export function validOps(raw: unknown): SettingsOp[] | null {
  if (!Array.isArray(raw) || raw.length > 500) return null;
  const ops: SettingsOp[] = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') return null;
    const { section, key, value } = o as Record<string, unknown>;
    if (!SHARED_SECTIONS.includes(section as never)) return null;
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) return null;
    const ok =
      value === null ||
      (section === 'amounts' && typeof value === 'number' && isFinite(value) && value > 0) ||
      (section === 'disabledNets' && typeof value === 'boolean') ||
      (section === 'savedAlerts' && isPairAlert(value)) ||
      (section === 'customPairs' && isCustomPair(value, key));
    if (!ok) return null;
    ops.push(o as SettingsOp);
  }
  return ops;
}

const isSide = (v: unknown): boolean => {
  const s = v as Record<string, unknown> | null;
  return (
    !!s &&
    typeof s.enabled === 'boolean' &&
    (s.op === 'above' || s.op === 'below') &&
    typeof s.price === 'string' &&
    typeof s.cooldown === 'string' &&
    (s.netMode === 'all' || s.netMode === 'selected') &&
    !!s.nets &&
    typeof s.nets === 'object'
  );
};

const isPairAlert = (v: unknown): boolean => {
  const a = v as Record<string, unknown> | null;
  return !!a && isSide(a.buy) && isSide(a.sell) && (a.paused === undefined || typeof a.paused === 'boolean');
};

const isCustomPair = (v: unknown, key: string): boolean => {
  const c = v as Record<string, unknown> | null;
  return (
    !!c &&
    c.id === key &&
    typeof c.t0 === 'string' &&
    typeof c.t1 === 'string' &&
    typeof c.notional === 'number' &&
    typeof c.dp === 'number' &&
    Array.isArray(c.networks) &&
    !!c.legs &&
    typeof c.legs === 'object'
  );
};

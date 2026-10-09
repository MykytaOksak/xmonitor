import type { CSSProperties } from 'react';
import { NET, type NetworkId } from '../config/networks';
import type { PaneCount, QuotesMode } from '../state/store';
import { C, chip, mono, sans, seg } from '../theme';

/** Placeholder network logo: solid-color square + monogram (per handoff,
 *  swap for real brand SVGs later — the only colored elements allowed). */
export function NetLogo({ id, size = 16, dim = false }: { id: NetworkId; size?: number; dim?: boolean }) {
  const n = NET(id);
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: 'none',
        display: 'grid',
        placeItems: 'center',
        ...mono(Math.max(6, Math.round(size / 2)), 600),
        color: '#fff',
        background: n.color,
        opacity: dim ? 0.4 : 1,
      }}
    >
      {n.mono}
    </span>
  );
}

export function StatusDot({
  color,
  blink,
  size = 5,
  square = false,
}: {
  color: string;
  blink?: boolean;
  size?: number;
  square?: boolean;
}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: square ? 0 : '50%',
        background: color,
        animation: blink ? 'blink 1s infinite' : 'none',
        display: 'block',
      }}
    />
  );
}

/** Segmented-control button. */
export function SegBtn({
  active,
  label,
  onClick,
  size = 11,
  style,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  size?: number;
  style?: CSSProperties;
}) {
  const s = active
    ? { background: C.greenBg14, border: `1px solid ${C.greenBorder45}`, color: C.green }
    : { background: 'transparent', border: `1px solid ${C.borderMid}`, color: C.secondary };
  return (
    <button
      onClick={onClick}
      style={{ flex: 1, padding: '7px 0', cursor: 'pointer', ...mono(size, 500), ...s, ...style }}
    >
      {label}
    </button>
  );
}

/** Network toggle chip (pair settings drawer + alert network scope). */
export function NetChip({
  id,
  on,
  onToggle,
  small = false,
  suffix,
}: {
  id: NetworkId;
  on: boolean;
  onToggle: () => void;
  small?: boolean;
  suffix?: string;
}) {
  const st = chip(on);
  return (
    <button
      onClick={onToggle}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: small ? 5 : 6,
        fontSize: small ? 10 : 11,
        fontFamily: "'IBM Plex Sans', sans-serif",
        padding: small ? '4px 7px' : '5px 9px',
        background: st.background,
        border: st.border,
        color: st.color,
        cursor: 'pointer',
      }}
    >
      <NetLogo id={id} size={small ? 11 : 13} dim={!on} />
      <span>
        {NET(id).name}
        {suffix && <span style={{ color: on ? C.secondary : C.label }}> ({suffix})</span>}
      </span>
    </button>
  );
}

/** Bordered input with an optional unit prefix/suffix, per the design. */
export function UnitInput({
  value,
  onChange,
  prefix,
  suffix,
  width,
  fontSize = 14,
}: {
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
  width?: number | string;
  fontSize?: number;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        border: `1px solid ${C.borderInput}`,
        background: C.header,
        width,
        boxSizing: 'border-box',
      }}
    >
      {prefix && <span style={{ padding: '0 10px', color: C.label, fontSize: 12 }}>{prefix}</span>}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          color: C.text,
          fontSize,
          padding: prefix ? '9px 0' : '8px 10px',
        }}
      />
      {suffix && <span style={{ padding: '0 9px', color: C.label, fontSize: 11 }}>{suffix}</span>}
    </div>
  );
}

/** Wireframe glyph for the view-mode menu: `count` cells laid over `cols`
 *  columns, opacity stepping down so the block reads as stacked depth. */
function Glyph({
  w,
  h,
  cols,
  count,
  color,
  gap,
}: {
  w: number;
  h: number;
  cols: number;
  count: number;
  color: string;
  gap: number;
}) {
  return (
    <span
      style={{
        width: w,
        height: h,
        flex: 'none',
        boxSizing: 'border-box',
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap,
        padding: 1,
        border: `1px solid ${color}`,
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        <span key={i} style={{ background: color, opacity: [0.9, 0.7, 0.5][Math.min(i, 2)] }} />
      ))}
    </span>
  );
}

const MODE_ROWS = [
  { mode: 'single', title: 'ONE PAIR', sub: () => 'Full network table', key: '1', cols: 1, count: 3, gap: 1.5 },
  {
    mode: 'scroll',
    title: 'ALL PAIRS',
    sub: () => 'One scroll, best route each',
    key: '2',
    cols: 1,
    count: 4,
    gap: 1,
  },
  {
    mode: 'parallel',
    title: 'PARALLEL',
    sub: (n: number) => `Watch ${n} pairs at once`,
    key: '3',
    cols: 2,
    count: 2,
    gap: 1.5,
  },
] as const;

/** Floating view-mode switcher, docked bottom-right over the quotes view. */
export function ViewModeMenu({
  open,
  mode,
  paneCount,
  maxPanes,
  phone,
  onToggleOpen,
  onMode,
  onPaneCount,
}: {
  open: boolean;
  mode: QuotesMode;
  paneCount: PaneCount;
  /** Panes the viewport can carry — narrow caps at 2, hiding the segment. */
  maxPanes: number;
  /** Phones drop parallel entirely and tuck the menu into the corner. */
  phone: boolean;
  onToggleOpen: () => void;
  onMode: (m: QuotesMode) => void;
  onPaneCount: (n: PaneCount) => void;
}) {
  const rows = MODE_ROWS.filter((r) => !(phone && r.mode === 'parallel'));
  const triggerCells = mode === 'single' ? 1 : mode === 'scroll' ? 3 : Math.min(paneCount, 3);
  const triggerLabel =
    mode === 'single' ? 'ONE PAIR' : mode === 'scroll' ? 'ALL PAIRS' : `PARALLEL ×${paneCount}`;

  return (
    <div
      style={{
        position: 'absolute',
        right: phone ? 12 : 18,
        bottom: phone ? 12 : 18,
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 8,
      }}
    >
      {open && (
        <div
          style={{
            width: 246,
            background: C.dropdown,
            border: '1px solid rgba(255,255,255,.14)',
            boxShadow: '0 18px 50px rgba(0,0,0,.7)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 11px',
              borderBottom: `1px solid ${C.borderFaint}`,
              ...mono(9, 500),
              color: C.label,
            }}
          >
            <span>VIEW MODE</span>
            <span>⌥ 1–3</span>
          </div>

          {rows.map((r) => {
            const active = mode === r.mode;
            const showSeg = r.mode === 'parallel' && maxPanes >= 3;
            return (
              <div key={r.mode} style={{ background: active ? C.greenBg08 : 'transparent' }}>
                <button
                  className={active ? undefined : 'moderow'}
                  onClick={() => onMode(r.mode)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 11px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: showSeg ? 'none' : `1px solid ${C.divider}`,
                    cursor: 'pointer',
                  }}
                >
                  <Glyph
                    w={20}
                    h={14}
                    cols={r.cols}
                    count={r.count}
                    gap={r.gap}
                    color={active ? C.green : C.body}
                  />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <span
                      style={{
                        ...mono(11, 500),
                        letterSpacing: '.06em',
                        color: active ? C.green : C.chipText,
                      }}
                    >
                      {r.title}
                    </span>
                    <span style={{ ...sans(10), color: C.label }}>{r.sub(paneCount)}</span>
                  </span>
                  <span style={{ marginLeft: 'auto', ...mono(9, 500), color: C.label }}>{r.key}</span>
                </button>

                {showSeg && (
                  <div
                    style={{
                      display: 'flex',
                      gap: 6,
                      padding: '0 11px 10px 41px',
                      borderBottom: `1px solid ${C.divider}`,
                    }}
                  >
                    {([2, 3, 4] as const).map((n) => (
                      <button
                        key={n}
                        onClick={() => onPaneCount(n)}
                        style={{
                          flex: 1,
                          padding: '5px 0',
                          cursor: 'pointer',
                          ...mono(10, 500),
                          ...seg(mode === 'parallel' && paneCount === n),
                        }}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <button
        onClick={onToggleOpen}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '9px 12px',
          background: C.dropdown,
          border: `1px solid ${open ? C.greenBorder45 : 'rgba(255,255,255,.14)'}`,
          boxShadow: '0 10px 30px rgba(0,0,0,.6)',
          cursor: 'pointer',
        }}
      >
        <Glyph w={16} h={12} cols={triggerCells} count={triggerCells} gap={1.5} color={C.green} />
        <span style={{ ...mono(10, 500), letterSpacing: '.1em', color: C.chipText }}>{triggerLabel}</span>
        <span style={{ fontSize: 9, color: C.label }}>{open ? '▾' : '▴'}</span>
      </button>
    </div>
  );
}

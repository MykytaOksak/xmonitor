import { useEffect, useMemo, useState } from 'react';
import { NET, type NetworkId } from '../config/networks';
import {
  CUSTOM_PREFIX,
  customPairNetworks,
  isCexNet,
  type CustomLeg,
  type CustomPairSpec,
} from '../config/pairs';
import { CUSTOM_STABLES, tokenOn } from '../config/tokens';
import { scanPairNow } from '../engine/engine';
import { canReadVault } from '../engine/rates';
import { loadTickers, searchTickers, type Ticker } from '../engine/tickers';
import { useApp } from '../state/store';
import { C, capsLabel, mono, sans } from '../theme';
import { NetLogo, UnitInput } from './ui';

type LegDraft = CustomLeg;
interface NetDraft {
  t0: LegDraft;
  t1: LegDraft;
  usdcAdjust?: boolean;
}

const blankLeg = (): LegDraft => ({ symbol: '', address: '', decimals: 6 });
const CUSTOM = '__custom__';

/** Stablecoins from the shortlist that actually exist on this network. */
const stablesOn = (net: NetworkId): string[] =>
  CUSTOM_STABLES.filter((sym) => tokenOn(sym, net) !== null);

// ——————————————————————— on-chain leg selector ———————————————————————

function LegPicker({
  label,
  net,
  leg,
  onChange,
}: {
  label: string;
  net: NetworkId;
  leg: LegDraft;
  onChange: (l: LegDraft) => void;
}) {
  const stables = stablesOn(net);
  const value = leg.symbol || CUSTOM;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
      <span style={capsLabel(9)}>{label}</span>
      <select
        value={value}
        onChange={(e) =>
          onChange(
            e.target.value === CUSTOM
              ? { ...leg, symbol: '' }
              : { symbol: e.target.value, address: '', decimals: 6 },
          )
        }
        style={selectStyle}
      >
        {stables.map((sym) => (
          <option key={sym} value={sym}>
            {sym}
          </option>
        ))}
        <option value={CUSTOM}>Custom address…</option>
      </select>
      {!leg.symbol && (
        <>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={leg.address}
              onChange={(e) => onChange({ ...leg, address: e.target.value.trim() })}
              placeholder={
                NET(net).kind === 'solana' ? 'mint address' : leg.wrapped ? 'vault address' : '0x…'
              }
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            />
            <input
              value={String(leg.decimals)}
              onChange={(e) => {
                const v = parseInt(e.target.value.replace(/[^0-9]/g, ''), 10);
                onChange({ ...leg, decimals: isNaN(v) ? 0 : Math.min(36, v) });
              }}
              title="Token decimals"
              style={{ ...inputStyle, width: 46, textAlign: 'center', flex: 'none' }}
            />
          </div>
          {canReadVault(net) && (
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 7,
                ...sans(10),
                color: C.secondary,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={!!leg.wrapped}
                onChange={(e) => onChange({ ...leg, wrapped: e.target.checked })}
                style={{ marginTop: 2 }}
              />
              <span>
                Liquidity is in an ERC-4626 wrapper — paste the vault address (e.g. wSPYx on
                X&nbsp;Layer); prices convert to the underlying at its live rate.
              </span>
            </label>
          )}
        </>
      )}
    </div>
  );
}

// ——————————————————————— CEX instrument search ———————————————————————

function TickerPicker({
  net,
  draft,
  onChange,
}: {
  net: NetworkId;
  draft: NetDraft;
  onChange: (d: NetDraft) => void;
}) {
  const [query, setQuery] = useState('');
  const [all, setAll] = useState<Ticker[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const chosen = draft.t0.address && draft.t1.address ? `${draft.t0.address}/${draft.t1.address}` : '';

  useEffect(() => {
    let live = true;
    loadTickers(net).then(
      (t) => live && setAll(t),
      (e) => live && setErr(String(e?.message ?? e)),
    );
    return () => {
      live = false;
    };
  }, [net]);

  const hits = useMemo(() => searchTickers(all, query), [all, query]);
  // Only the venue's own quote currency can be converted, and only from USDT.
  const canAdjust = draft.t1.address === 'USDT';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
      <span style={capsLabel(9)}>INSTRUMENT</span>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={chosen ? `${chosen}  —  type to change` : 'search ticker, e.g. SPY'}
        style={inputStyle}
      />
      {err && <span style={{ ...sans(10), color: C.red }}>Could not load instruments: {err}</span>}
      {query.trim() !== '' && (
        <div style={{ maxHeight: 132, overflowY: 'auto', border: `1px solid ${C.borderFaint}` }}>
          {hits.length === 0 && (
            <div style={{ padding: '7px 9px', ...sans(11), color: C.label }}>
              {all.length === 0 ? 'loading instruments…' : 'no match'}
            </div>
          )}
          {hits.map((t) => {
            const active = draft.t0.address === t.base && draft.t1.address === t.quote;
            return (
              <button
                key={t.instId}
                onClick={() => {
                  onChange({
                    t0: { symbol: '', address: t.base, decimals: 8 },
                    t1: { symbol: '', address: t.quote, decimals: 8 },
                    usdcAdjust: t.quote === 'USDT' ? draft.usdcAdjust : false,
                  });
                  setQuery('');
                }}
                style={{
                  display: 'flex',
                  width: '100%',
                  gap: 8,
                  textAlign: 'left',
                  padding: '7px 9px',
                  background: active ? C.greenBg08 : 'transparent',
                  border: 'none',
                  borderBottom: `1px solid ${C.divider}`,
                  cursor: 'pointer',
                  ...mono(11, 500),
                  color: active ? C.green : C.chipText,
                }}
              >
                <span>{t.instId}</span>
                <span style={{ marginLeft: 'auto', color: C.label }}>{t.quote}</span>
              </button>
            );
          })}
        </div>
      )}
      {chosen && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            ...sans(10),
            color: canAdjust ? C.secondary : C.label,
            cursor: canAdjust ? 'pointer' : 'default',
          }}
        >
          <input
            type="checkbox"
            disabled={!canAdjust}
            checked={!!draft.usdcAdjust && canAdjust}
            onChange={(e) => onChange({ ...draft, usdcAdjust: e.target.checked })}
          />
          Convert USDT quote to USDC (live Ethereum rate)
        </label>
      )}
    </div>
  );
}

// ————————————————————————————— the dialog —————————————————————————————

export function CustomPairDialog() {
  const s = useApp();
  const nets = useMemo(customPairNetworks, []);
  const [t0, setT0] = useState('');
  const [t1, setT1] = useState('USDC');
  const [notional, setNotional] = useState('50000');
  const [dp, setDp] = useState('5');
  const [drafts, setDrafts] = useState<Partial<Record<NetworkId, NetDraft>>>({});

  const toggleNet = (n: NetworkId) =>
    setDrafts((d) => {
      const next = { ...d };
      if (next[n]) delete next[n];
      else {
        const stables = stablesOn(n);
        next[n] = isCexNet(n)
          ? { t0: blankLeg(), t1: blankLeg() }
          : {
              t0: blankLeg(),
              // Default the quote leg to whatever stable this network actually
              // has — the reason a network may offer only USDT.
              t1: stables.length ? { symbol: stables[0], address: '', decimals: 6 } : blankLeg(),
            };
      }
      return next;
    });

  const legReady = (l: LegDraft) => (l.symbol ? true : l.address.trim().length > 0);
  const readyNets = (Object.keys(drafts) as NetworkId[]).filter(
    (n) => legReady(drafts[n]!.t0) && legReady(drafts[n]!.t1),
  );
  const amount = parseFloat(notional.replace(/[^0-9.]/g, ''));
  const symbolsOk = t0.trim() !== '' && t1.trim() !== '' && t0.trim() !== t1.trim();
  const valid = symbolsOk && amount > 0 && readyNets.length > 0;

  const save = () => {
    if (!valid) return;
    const legs: CustomPairSpec['legs'] = {};
    for (const n of readyNets) legs[n] = drafts[n]!;
    const id = `${CUSTOM_PREFIX}${t0.trim()}-${t1.trim()}-${Date.now().toString(36)}`;
    s.addCustomPair({
      id,
      t0: t0.trim(),
      t1: t1.trim(),
      notional: amount,
      dp: Math.max(0, Math.min(8, parseInt(dp, 10) || 5)),
      networks: readyNets,
      legs,
    });
    // Quote it straight away rather than waiting for the next full sweep.
    void scanPairNow(id);
  };

  return (
    <div
      onClick={() => s.set({ customPairOpen: false })}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(0,0,0,.6)',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '86vh',
          display: 'flex',
          flexDirection: 'column',
          background: C.dropdown,
          border: '1px solid rgba(255,255,255,.14)',
          boxShadow: '0 24px 70px rgba(0,0,0,.7)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '11px 14px',
            borderBottom: `1px solid ${C.borderFaint}`,
          }}
        >
          <span style={{ ...capsLabel(9), letterSpacing: '.1em' }}>NEW CUSTOM PAIR</span>
          <button
            onClick={() => s.set({ customPairOpen: false })}
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '0 3px',
              ...mono(15, 500),
              lineHeight: 1,
              color: C.label,
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 132 }}>
              <span style={capsLabel(9)}>BASE SYMBOL</span>
              <input
                value={t0}
                onChange={(e) => setT0(e.target.value.trim())}
                placeholder="MYUSD"
                style={inputStyle}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 132 }}>
              <span style={capsLabel(9)}>QUOTE SYMBOL</span>
              <input
                value={t1}
                onChange={(e) => setT1(e.target.value.trim())}
                placeholder="USDC"
                style={inputStyle}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 168 }}>
              <span style={capsLabel(9)}>VOLUME</span>
              <UnitInput prefix="$" value={notional} onChange={setNotional} fontSize={13} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 86 }}>
              <span style={capsLabel(9)}>DECIMALS</span>
              <input
                value={dp}
                onChange={(e) => setDp(e.target.value.replace(/[^0-9]/g, ''))}
                title="Price decimal places in the table"
                style={inputStyle}
              />
            </div>
          </div>
          <span style={{ ...sans(10), color: C.label, display: 'block', marginTop: 8 }}>
            Symbols are labels for the table. The tokens actually quoted come from each
            network below, so the quote leg may differ per network.
          </span>

          <div style={{ ...capsLabel(9), margin: '18px 0 8px' }}>NETWORKS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {nets.map((n) => {
              const draft = drafts[n];
              const on = !!draft;
              return (
                <div key={n} style={{ background: on ? C.drawer : 'transparent' }}>
                  <button
                    onClick={() => toggleNet(n)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      background: 'transparent',
                      border: 'none',
                      borderBottom: `1px solid ${C.divider}`,
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        flex: 'none',
                        display: 'grid',
                        placeItems: 'center',
                        border: `1px solid ${on ? C.greenBorder45 : C.borderMid}`,
                        background: on ? C.greenBg14 : 'transparent',
                        ...mono(9, 500),
                        color: C.green,
                      }}
                    >
                      {on ? '✓' : ''}
                    </span>
                    <NetLogo id={n} size={14} dim={!on} />
                    <span style={{ ...sans(12), color: on ? C.text : C.secondary }}>
                      {NET(n).name}
                    </span>
                    {isCexNet(n) && (
                      <span style={{ ...mono(8.5, 500), color: C.label, background: 'rgba(255,255,255,.05)', padding: '2px 5px' }}>
                        CEX
                      </span>
                    )}
                  </button>
                  {on && (
                    <div style={{ display: 'flex', gap: 12, padding: '10px 10px 14px 31px' }}>
                      {isCexNet(n) ? (
                        <TickerPicker
                          net={n}
                          draft={draft!}
                          onChange={(d) => setDrafts((prev) => ({ ...prev, [n]: d }))}
                        />
                      ) : (
                        <>
                          <LegPicker
                            label={`${t0 || 'BASE'} ON ${NET(n).name.toUpperCase()}`}
                            net={n}
                            leg={draft!.t0}
                            onChange={(l) => setDrafts((p) => ({ ...p, [n]: { ...draft!, t0: l } }))}
                          />
                          <LegPicker
                            label={`${t1 || 'QUOTE'} ON ${NET(n).name.toUpperCase()}`}
                            net={n}
                            leg={draft!.t1}
                            onChange={(l) => setDrafts((p) => ({ ...p, [n]: { ...draft!, t1: l } }))}
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '11px 14px',
            borderTop: `1px solid ${C.borderFaint}`,
          }}
        >
          <span style={{ ...sans(11), color: C.label }}>
            {readyNets.length} network{readyNets.length === 1 ? '' : 's'} ready
            {!symbolsOk && t0 && t1 && t0 === t1 ? ' · symbols must differ' : ''}
          </span>
          <button
            onClick={() => s.set({ customPairOpen: false })}
            style={{ ...btn, marginLeft: 'auto', color: C.secondary, border: `1px solid ${C.borderMid}` }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!valid}
            style={{
              ...btn,
              background: valid ? C.greenBg14 : 'transparent',
              border: `1px solid ${valid ? C.greenBorder45 : C.borderMid}`,
              color: valid ? C.green : C.label,
              cursor: valid ? 'pointer' : 'default',
            }}
          >
            Add pair
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: C.header,
  border: `1px solid ${C.borderInput}`,
  color: C.text,
  padding: '7px 9px',
  fontSize: 12,
  fontFamily: "'IBM Plex Mono', monospace",
  boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
  width: '100%',
};

const btn: React.CSSProperties = {
  padding: '7px 14px',
  background: 'transparent',
  cursor: 'pointer',
  ...mono(11, 500),
};

import type React from 'react';

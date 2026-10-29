import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NetworkId } from '../config/networks';
import type { Position } from '../portfolio/reader';
import {
  addWallet,
  clearEvents,
  getSnapshot,
  refreshNow,
  removeWallet,
  setAlertsOn,
  subscribe,
  type RangeEvent,
} from '../portfolio/monitor';
import { useApp } from '../state/store';
import { C, capsLabel, mono, sans } from '../theme';
import { NetLogo } from './ui';

const usd = (n: number) =>
  n >= 0.005
    ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '$0.00';
const amt = (n: number) => {
  if (n === 0) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumSignificantDigits: 6 });
};
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function PortfolioView() {
  const m = useSyncExternalStore(subscribe, getSnapshot);
  const botOnline = useApp((s) => s.botState === 'online');
  const [input, setInput] = useState('');
  const [now, setNow] = useState(Date.now());

  const loading = m.status === 'scanning';
  const refreshing = m.status === 'refreshing';
  const positions = m.positions;
  const hasWallets = m.wallets.length > 0;
  const multi = m.wallets.length > 1;

  // 1s clock drives the "next refresh" countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const add = () => {
    const err = addWallet(input);
    if (!err) setInput('');
  };

  // A Monad v4 entry is tracked by position id (owner isn't the tracked string).
  const v4Id = (w: string) => w.match(/^monad(?:-v4)?:(\d+)$/i)?.[1];
  const labelFor = (w: string) => {
    const id = v4Id(w);
    return id ? `Monad v4 #${id}` : short(w);
  };
  const statFor = (w: string) => {
    const id = v4Id(w);
    const rows = (positions ?? []).filter((p) =>
      id ? p.chain === 'monad' && p.tokenId === id : p.owner.toLowerCase() === w.toLowerCase(),
    );
    return { count: rows.length, usd: rows.reduce((a, p) => a + p.usd, 0) };
  };

  const total = positions?.reduce((a, p) => a + p.usd, 0) ?? 0;
  const secsLeft = hasWallets && m.nextRefreshAt ? Math.max(0, Math.round((m.nextRefreshAt - now) / 1000)) : 0;
  const countdown = `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}`;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, background: C.header }}>
        <span style={sans(16, 600)}>Portfolio</span>
      </div>

      <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 860 }}>
        {/* add wallet */}
        <div>
          <span style={{ ...capsLabel(9), letterSpacing: '.1em', display: 'block', marginBottom: 8 }}>
            WALLETS
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Add an EVM / Movement address, or a Monad v4 position id"
              value={input}
              spellCheck={false}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              style={{
                flex: '1 1 320px',
                minWidth: 0,
                background: C.header,
                border: `1px solid ${C.borderInput}`,
                color: C.text,
                fontSize: 13,
                padding: '9px 11px',
                boxSizing: 'border-box',
              }}
            />
            <button
              onClick={add}
              style={{
                padding: '9px 18px',
                cursor: 'pointer',
                ...mono(11, 600),
                background: C.greenBg12,
                border: `1px solid ${C.greenBorder45}`,
                color: C.green,
              }}
            >
              Add wallet
            </button>
          </div>
          {m.status === 'error' && m.error && (
            <span style={{ ...mono(10, 500), color: C.red, display: 'block', marginTop: 8 }}>{m.error}</span>
          )}
        </div>

        {/* tracked wallet list */}
        {hasWallets && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {m.wallets.map((w) => {
              const stat = statFor(w);
              return (
                <div
                  key={w}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    background: C.header,
                    border: `1px solid ${C.borderFaint}`,
                    padding: '7px 11px',
                  }}
                >
                  <span className="tnum" style={{ ...mono(11, 500), color: C.chipText }}>{labelFor(w)}</span>
                  <span style={{ ...mono(9, 500), color: C.label }}>
                    {loading && stat.count === 0 ? 'scanning…' : `${stat.count} position${stat.count === 1 ? '' : 's'}`}
                  </span>
                  {stat.usd > 0 && (
                    <span className="tnum" style={{ ...mono(10, 500), color: C.secondary }}>{usd(stat.usd)}</span>
                  )}
                  <button
                    onClick={() => removeWallet(w)}
                    title="Remove wallet"
                    style={{
                      marginLeft: 'auto',
                      ...mono(12, 600),
                      background: 'transparent',
                      border: 'none',
                      color: C.label,
                      cursor: 'pointer',
                      padding: '0 4px',
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* summary + controls */}
        {positions && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              flexWrap: 'wrap',
              paddingTop: 4,
              borderTop: `1px solid ${C.borderFaint}`,
              marginTop: 2,
            }}
          >
            <span style={{ ...capsLabel(9), letterSpacing: '.1em' }}>TOTAL VALUE</span>
            <span className="tnum" style={{ fontSize: 22, color: C.text, fontFamily: "'IBM Plex Mono', monospace" }}>
              {usd(total)}
            </span>
            <span style={{ ...mono(10, 500), color: C.label }}>
              {positions.length} position{positions.length === 1 ? '' : 's'}
              {multi ? ` · ${m.wallets.length} wallets` : ''}
            </span>

            <span style={{ ...mono(9.5, 500), color: C.secondary, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {refreshing ? (
                <>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.green, animation: 'blink 1s infinite' }} />
                  REFRESHING
                </>
              ) : (
                <>auto-refresh in {countdown}</>
              )}
            </span>
            <button
              onClick={refreshNow}
              disabled={refreshing}
              style={{
                ...mono(9.5, 600),
                letterSpacing: '.06em',
                background: 'transparent',
                border: `1px solid ${C.borderInput}`,
                color: C.secondary,
                padding: '4px 9px',
                cursor: refreshing ? 'default' : 'pointer',
              }}
            >
              REFRESH NOW
            </button>

            <button
              onClick={() => setAlertsOn(!m.alertsOn)}
              style={{
                marginLeft: 'auto',
                ...mono(9.5, 600),
                letterSpacing: '.06em',
                background: m.alertsOn ? C.greenBg12 : 'transparent',
                border: `1px solid ${m.alertsOn ? C.greenBorder45 : C.borderInput}`,
                color: m.alertsOn ? C.green : C.secondary,
                padding: '4px 10px',
                cursor: 'pointer',
              }}
            >
              RANGE ALERTS: {m.alertsOn ? 'ON' : 'OFF'}
            </button>
          </div>
        )}

        {positions && m.alertsOn && (
          <span style={{ ...mono(9, 400), color: C.label, marginTop: -8 }}>
            Alerts fire when a position flips in/out of range — shown below
            {typeof Notification !== 'undefined' && Notification.permission === 'granted' ? ', as browser notifications' : ''}
            {botOnline ? ', and sent to Telegram by your bot' : ' (link your bot in the Alerts tab to also receive them in Telegram)'}.
          </span>
        )}

        {/* range-change events feed */}
        {positions && m.events.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ ...capsLabel(9), letterSpacing: '.1em' }}>RANGE ALERTS</span>
              <button
                onClick={clearEvents}
                style={{ ...mono(9, 500), background: 'transparent', border: 'none', color: C.label, cursor: 'pointer', padding: 0 }}
              >
                clear
              </button>
            </div>
            {m.events.map((e) => (
              <EventRow key={`${e.id}:${e.at}`} e={e} />
            ))}
          </div>
        )}

        {/* loading skeleton (first scan, nothing yet) */}
        {loading && !positions && (
          <div style={{ ...sans(12), color: C.secondary, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.green, animation: 'blink 1s infinite' }} />
            Scanning DeFi positions…
          </div>
        )}

        {positions && positions.length === 0 && (
          <div style={{ ...sans(12), color: C.label, padding: '24px 0' }}>
            No tracked positions found for {multi ? 'these wallets' : 'this wallet'}.
          </div>
        )}

        {positions && positions.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {positions.map((p) => (
              <PositionCard key={p.id} p={p} showOwner={multi} />
            ))}
          </div>
        )}

        {!hasWallets && !loading && (
          <div style={{ ...sans(12), lineHeight: 1.6, color: C.body, maxWidth: 480, paddingTop: 4 }}>
            Add one or more wallets to load their DeFi liquidity positions — Uniswap v3 on Plasma and
            Uniswap v4 on Monad (EVM address), and Yuzu on Movement (Movement address). A Monad v4
            position can also be added directly by its id (e.g. <code>monad:599441</code>). Positions
            are read on-chain, refresh automatically every 3 minutes, and can alert you when they move
            in or out of range.
          </div>
        )}
      </div>
    </div>
  );
}

function EventRow({ e }: { e: RangeEvent }) {
  const when = new Date(e.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: C.panel,
        border: `1px solid ${e.inRange ? C.greenBorder40 : C.redBorder40}`,
        padding: '6px 10px',
      }}
    >
      <span style={{ ...mono(9, 700), letterSpacing: '.06em', color: e.inRange ? C.green : C.red }}>
        {e.inRange ? 'IN RANGE' : 'OUT OF RANGE'}
      </span>
      <span style={{ ...mono(10, 500), color: C.chipText }}>{e.label}</span>
      <span style={{ ...mono(9, 400), color: C.label, marginLeft: 'auto' }}>{when}</span>
    </div>
  );
}

function PositionCard({ p, showOwner }: { p: Position; showOwner: boolean }) {
  const chainId = p.chain as NetworkId;
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, padding: '13px 15px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11, flexWrap: 'wrap' }}>
        <NetLogo id={chainId} size={16} />
        <span style={sans(13, 600)}>{p.protocol}</span>
        <span style={{ ...mono(9, 500), color: C.label }}>#{p.tokenId}</span>
        <span
          style={{
            ...mono(8.5, 500),
            color: C.secondary,
            background: 'rgba(255,255,255,.05)',
            padding: '2px 5px',
            letterSpacing: '.04em',
          }}
        >
          {(p.feeBps / 10000).toString()}%
        </span>
        <span
          style={{
            ...mono(8.5, 600),
            letterSpacing: '.06em',
            color: p.inRange ? C.green : C.red,
            border: `1px solid ${p.inRange ? C.greenBorder40 : C.redBorder40}`,
            padding: '2px 6px',
          }}
        >
          {p.inRange ? 'IN RANGE' : 'OUT OF RANGE'}
        </span>
        {p.staked && (
          <span style={{ ...mono(8.5, 600), letterSpacing: '.06em', color: C.secondary, padding: '2px 0' }}>
            STAKED
          </span>
        )}
        {showOwner && (
          <span className="tnum" style={{ ...mono(8.5, 500), color: C.label }} title={p.owner}>
            {short(p.owner)}
          </span>
        )}
        <span
          className="tnum"
          style={{ marginLeft: 'auto', fontSize: 15, color: C.text, fontFamily: "'IBM Plex Mono', monospace" }}
        >
          {usd(p.usd)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {[p.token0, p.token1].map((t) => (
          <div key={t.address} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="tnum" style={{ fontSize: 12.5, color: C.chipText }}>
              {amt(t.amount)} <span style={{ color: C.secondary }}>{t.symbol}</span>
            </span>
            <span className="tnum" style={{ ...mono(10, 400), color: C.label }}>
              {t.price > 0 ? usd(t.usd) : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

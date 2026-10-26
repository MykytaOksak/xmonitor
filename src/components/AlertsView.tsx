import { useState } from 'react';
import { NET } from '../config/networks';
import { allPairs, pairById, pairName } from '../config/pairs';
import { connectBot, disconnectBot } from '../engine/bot';
import { fmtAge } from '../engine/format';
import type { PairAlert } from '../engine/types';
import { defaultAlert, useApp } from '../state/store';
import { C, mono, sans } from '../theme';
import { useIsNarrow } from '../useResponsive';
import { NetChip, SegBtn, StatusDot } from './ui';

export function AlertsView() {
  const s = useApp();
  const narrow = useIsNarrow();
  const pair = pairById(s.alertSel);
  const alert: PairAlert =
    s.drafts[s.alertSel] ?? s.savedAlerts[s.alertSel] ?? defaultAlert(s.alertSel, s.snapshots);

  const saveVM = {
    idle: { label: '', color: C.secondary, blink: false },
    saving: { label: 'Saving…', color: C.secondary, blink: true },
    saved: { label: '✓ Alerts saved', color: C.green, blink: false },
    error: { label: '✕ Save failed', color: C.red, blink: false },
  }[s.saveState];

  const sideCard = (side: 'buy' | 'sell', title: string) => {
    const cfg = alert[side];
    return (
      <div
        key={side}
        style={{ flex: 1, minWidth: 0, background: C.panel, border: `1px solid ${C.border}`, padding: 15 }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 14,
          }}
        >
          <span style={{ ...mono(10, 600), letterSpacing: '.08em', color: C.chipText }}>{title}</span>
          {/* sharp-corner switch */}
          <button
            onClick={() => s.updateDraft(s.alertSel, side, { enabled: !cfg.enabled })}
            style={{
              width: 34,
              height: 18,
              padding: 2,
              border: 'none',
              cursor: 'pointer',
              background: cfg.enabled ? C.green : 'rgba(255,255,255,.14)',
              display: 'flex',
              justifyContent: cfg.enabled ? 'flex-end' : 'flex-start',
              alignItems: 'center',
              boxSizing: 'border-box',
            }}
          >
            <span style={{ width: 14, height: 14, background: C.surface, display: 'block' }} />
          </button>
        </div>

        <div style={{ opacity: cfg.enabled ? 1 : 0.4, display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div>
            <span style={fieldLabel}>Operator</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <SegBtn
                active={cfg.op === 'above'}
                label="above"
                onClick={() => s.updateDraft(s.alertSel, side, { op: 'above' })}
              />
              <SegBtn
                active={cfg.op === 'below'}
                label="below"
                onClick={() => s.updateDraft(s.alertSel, side, { op: 'below' })}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <span style={fieldLabel}>Target price</span>
              <input
                type="text"
                value={cfg.price}
                onChange={(e) => s.updateDraft(s.alertSel, side, { price: e.target.value })}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  background: C.header,
                  border: `1px solid ${C.borderInput}`,
                  color: C.text,
                  fontSize: 13,
                  padding: '7px 9px',
                }}
              />
            </div>
            <div style={{ width: 96, flex: 'none' }}>
              <span style={fieldLabel}>Cooldown</span>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  background: C.header,
                  border: `1px solid ${C.borderInput}`,
                }}
              >
                <input
                  type="text"
                  value={cfg.cooldown}
                  onChange={(e) =>
                    s.updateDraft(s.alertSel, side, { cooldown: e.target.value.replace(/[^0-9]/g, '') })
                  }
                  style={{
                    width: '100%',
                    minWidth: 0,
                    background: 'transparent',
                    border: 'none',
                    color: C.text,
                    fontSize: 13,
                    padding: '7px 9px',
                  }}
                />
                <span style={{ padding: '0 8px', color: C.label, fontSize: 10 }}>min</span>
              </div>
            </div>
          </div>

          <div>
            <span style={fieldLabel}>Networks</span>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <SegBtn
                active={cfg.netMode === 'all'}
                label="All active"
                size={10}
                style={{ padding: '6px 0' }}
                onClick={() => s.updateDraft(s.alertSel, side, { netMode: 'all' })}
              />
              <SegBtn
                active={cfg.netMode === 'selected'}
                label="Selected"
                size={10}
                style={{ padding: '6px 0' }}
                onClick={() => s.updateDraft(s.alertSel, side, { netMode: 'selected' })}
              />
            </div>
            {cfg.netMode === 'selected' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {pair.networks.map((n) => {
                  const name = NET(n).name;
                  const on = cfg.nets[name] === undefined ? true : cfg.nets[name];
                  return (
                    <NetChip
                      key={n}
                      id={n}
                      small
                      on={on}
                      onToggle={() => s.toggleAlertNet(s.alertSel, side, name)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: narrow ? 'column' : 'row' }}>
      {/* pair list */}
      <div
        style={{
          flex: 'none',
          background: C.panel,
          display: 'flex',
          flexDirection: 'column',
          ...(narrow
            ? { width: '100%', maxHeight: '30vh', borderBottom: `1px solid ${C.border}` }
            : { width: 240, borderRight: `1px solid ${C.border}` }),
        }}
      >
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.borderFaint}` }}>
          <span style={sans(12, 600)}>Price alerts</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {allPairs().map((p) => {
            const selected = p.id === s.alertSel;
            // SET only when an alert actually has an enabled side, so the badge
            // matches the editor's toggles (an untouched pair reads OFF).
            const draft = s.drafts[p.id] ?? s.savedAlerts[p.id];
            const hasAlert = !!draft && (draft.buy.enabled || draft.sell.enabled);
            const paused = hasAlert && !!s.savedAlerts[p.id]?.paused;
            return (
              <button
                key={p.id}
                onClick={() => s.set({ alertSel: p.id, saveState: 'idle' })}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 14px',
                  border: 'none',
                  borderBottom: `1px solid ${C.divider}`,
                  borderLeft: `3px solid ${selected ? C.green : 'transparent'}`,
                  background: selected ? C.greenBg06 : 'transparent',
                  cursor: 'pointer',
                  boxSizing: 'border-box',
                }}
              >
                <span style={{ ...sans(12, 600), color: C.text }}>{pairName(p)}</span>
                <span
                  style={{
                    marginLeft: 'auto',
                    ...mono(9, 500),
                    color: paused ? C.secondary : hasAlert ? C.green : C.label,
                  }}
                >
                  {paused ? 'PAUSED' : hasAlert ? 'SET' : 'OFF'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* editor */}
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 18px',
            borderBottom: `1px solid ${C.border}`,
            background: C.header,
          }}
        >
          <span style={sans(16, 600)}>{pairName(pair)}</span>
          {s.savedAlerts[s.alertSel]?.paused && (
            <>
              <span style={{ ...mono(10, 500), color: C.secondary }}>PAUSED</span>
              <button
                onClick={() => s.setAlertPaused(s.alertSel, false)}
                style={{
                  marginLeft: 'auto',
                  padding: '5px 11px',
                  cursor: 'pointer',
                  ...mono(10, 500),
                  background: 'transparent',
                  border: `1px solid ${C.borderMid}`,
                  color: C.chipText,
                }}
              >
                Resume
              </button>
            </>
          )}
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: 14 }}>
            {sideCard('buy', 'BUY PRICE ALERT')}
            {sideCard('sell', 'SELL PRICE ALERT')}
          </div>

          <BotPanel />

          {/* save bar */}
          <div
            style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14, rowGap: 8, paddingTop: 4 }}
          >
            <span style={{ ...mono(10, 400), color: C.label }}>
              {s.botToken
                ? 'Saved to your bot server — checked around the clock'
                : 'Kept in this browser only until a bot is linked'}
            </span>
            <span
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                ...mono(11, 500),
                color: saveVM.color,
                animation: saveVM.blink ? 'blink 1s infinite' : 'none',
              }}
            >
              {saveVM.label}
            </span>
            <button
              onClick={() => {
                // make sure a draft exists so Save commits something
                if (!s.drafts[s.alertSel]) s.updateDraft(s.alertSel, 'buy', {});
                useApp.getState().saveAlerts();
              }}
              style={{
                padding: '8px 16px',
                cursor: 'pointer',
                ...mono(11, 600),
                background: C.greenBg12,
                border: `1px solid ${C.greenBorder45}`,
                color: C.green,
              }}
            >
              Save alerts
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The link to the bot server: paste its access key once, then alerts and
 * sizes are shared with it and its recent notifications are listed here.
 */
function BotPanel() {
  const s = useApp();
  const [key, setKey] = useState('');
  const vm = {
    off: { dot: C.body, color: C.secondary, label: 'NOT LINKED', blink: false },
    connecting: { dot: C.body, color: C.secondary, label: 'LINKING', blink: true },
    online: { dot: C.green, color: C.green, label: 'ONLINE', blink: false },
    offline: { dot: C.red, color: C.red, label: 'UNREACHABLE', blink: false },
    unauthorized: { dot: C.red, color: C.red, label: 'WRONG KEY', blink: false },
  }[s.botState];
  const st = s.botStatus;
  const detail = !s.botToken
    ? 'Alerts are checked and sent by your bot server. Paste its access key to link this site.'
    : st
      ? [
          st.botUsername ? `@${st.botUsername}` : 'bot token not set',
          `watching ${st.watching.length} pair${st.watching.length === 1 ? '' : 's'}`,
          st.lastScanAt ? `last check ${fmtAge(Date.now() - st.lastScanAt)}` : 'no check yet',
          ...(st.ownerLinked ? [] : ['no owner chat set']),
        ].join(' · ')
      : s.botState === 'unauthorized'
        ? 'The server rejected this key.'
        : 'Waiting for the bot server…';

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}` }}>
      <div
        style={{
          padding: '14px 15px',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          rowGap: 10,
        }}
      >
        <span
          style={{
            width: 20,
            height: 20,
            flex: 'none',
            display: 'grid',
            placeItems: 'center',
            ...mono(10, 600),
            color: '#fff',
            background: C.tgBlue,
          }}
        >
          T
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 220px' }}>
          <span style={{ ...sans(12, 500), color: C.text }}>Telegram bot</span>
          <span style={{ ...mono(10, 400), color: C.label }}>{detail}</span>
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <StatusDot color={vm.dot} blink={vm.blink} />
          <span style={{ ...mono(10, 500), color: vm.color }}>{vm.label}</span>
        </span>
        {s.botToken ? (
          <button onClick={disconnectBot} style={botBtn(false)}>
            Unlink
          </button>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) void connectBot(key).then(() => setKey(''));
            }}
            style={{ display: 'flex', gap: 8 }}
          >
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Access key"
              autoComplete="off"
              style={{
                width: 150,
                background: C.header,
                border: `1px solid ${C.borderInput}`,
                color: C.text,
                fontSize: 12,
                padding: '6px 9px',
              }}
            />
            <button type="submit" style={botBtn(true)}>
              Link
            </button>
          </form>
        )}
      </div>

      {s.botToken && s.botHistory.length > 0 && (
        <div style={{ borderTop: `1px solid ${C.borderFaint}`, padding: '10px 15px 12px' }}>
          <span style={{ ...fieldLabel, marginBottom: 8 }}>Recent notifications</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 180, overflowY: 'auto' }}>
            {s.botHistory.map((n) => (
              <div key={n.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <span style={{ ...mono(10, 400), color: C.label, flex: 'none' }}>
                  {new Date(n.at).toLocaleString('en-GB', {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span style={{ ...mono(10, 400), color: n.delivered ? C.secondary : C.red, minWidth: 0 }}>
                  {n.text}
                  {n.delivered ? '' : ' (not delivered)'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const botBtn = (primary: boolean): React.CSSProperties => ({
  padding: '7px 13px',
  cursor: 'pointer',
  ...mono(11, 500),
  background: primary ? 'rgba(42,163,224,.12)' : 'transparent',
  border: `1px solid ${primary ? 'rgba(42,163,224,.45)' : 'rgba(255,255,255,.14)'}`,
  color: primary ? C.tgBlueText : C.secondary,
});

const fieldLabel: React.CSSProperties = {
  fontSize: 10,
  color: C.secondary,
  display: 'block',
  marginBottom: 6,
  fontFamily: "'IBM Plex Sans', sans-serif",
};

import type React from 'react';

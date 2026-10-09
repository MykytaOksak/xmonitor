import { NET } from '../config/networks';
import { allPairs, pairById, pairName } from '../config/pairs';
import { connectTelegram, deepLink, disconnectTelegram } from '../engine/telegram';
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

  const tgVM = {
    connected: { dot: C.green, color: C.green, label: 'CONNECTED', blink: false },
    connecting: { dot: C.body, color: C.secondary, label: 'CONNECTING', blink: true },
    disconnected: { dot: C.body, color: C.secondary, label: 'DISCONNECTED', blink: false },
    error: { dot: C.red, color: C.red, label: 'ERROR', blink: false },
  }[s.tgState];

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
                  style={{ marginLeft: 'auto', ...mono(9, 500), color: hasAlert ? C.green : C.label }}
                >
                  {hasAlert ? 'SET' : 'OFF'}
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
          <span style={{ ...mono(10, 400), color: C.label }}>profile {s.profileId}</span>
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: 14 }}>
            {sideCard('buy', 'BUY PRICE ALERT')}
            {sideCard('sell', 'SELL PRICE ALERT')}
          </div>

          {/* telegram row */}
          <div
            style={{
              background: C.panel,
              border: `1px solid ${C.border}`,
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ ...sans(12, 500), color: C.text }}>Telegram alerts</span>
              <span style={{ ...mono(10, 400), color: C.label }}>{deepLink(s.tgBot, s.profileId)}</span>
            </div>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <StatusDot color={tgVM.dot} blink={tgVM.blink} />
              <span style={{ ...mono(10, 500), color: tgVM.color }}>{tgVM.label}</span>
            </span>
            <button
              onClick={() => (s.tgState === 'connected' ? disconnectTelegram() : void connectTelegram())}
              disabled={s.tgState === 'connecting'}
              style={{
                padding: '7px 13px',
                cursor: 'pointer',
                ...mono(11, 500),
                background: s.tgState === 'connected' ? 'transparent' : 'rgba(42,163,224,.12)',
                border: `1px solid ${
                  s.tgState === 'connected' ? 'rgba(255,255,255,.14)' : 'rgba(42,163,224,.45)'
                }`,
                color: s.tgState === 'connected' ? C.secondary : C.tgBlueText,
              }}
            >
              {s.tgState === 'connected'
                ? 'Disconnect'
                : s.tgState === 'connecting'
                  ? 'Connecting…'
                  : 'Connect Telegram'}
            </button>
          </div>

          {/* save bar */}
          <div
            style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14, rowGap: 8, paddingTop: 4 }}
          >
            <span style={{ ...mono(10, 400), color: C.label }}>
              Alerts bound to hosted profile {s.profileId}
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

const fieldLabel: React.CSSProperties = {
  fontSize: 10,
  color: C.secondary,
  display: 'block',
  marginBottom: 6,
  fontFamily: "'IBM Plex Sans', sans-serif",
};

import type React from 'react';

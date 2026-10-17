import { useState } from 'react';
import { RULES_DISPLAY } from '../config/pairs';
import { clearCrashes, readCrashes } from '../crashlog';
import { refreshNow } from '../engine/engine';
import { effectiveSync, useApp } from '../state/store';
import { C, capsLabel, mono, sans } from '../theme';
import { SegBtn, UnitInput } from './ui';

export function SettingsView() {
  const s = useApp();
  const sync = effectiveSync(s);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, background: C.header }}>
        <span style={sans(16, 600)}>Global settings</span>
      </div>

      <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 720 }}>
        {/* DATA & SYNC */}
        <div>
          <span style={{ ...capsLabel(10, C.sectionLabel), display: 'block', marginBottom: 12 }}>
            DATA &amp; SYNC
          </span>
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ width: 150 }}>
              <span style={fieldLabel}>Refresh interval</span>
              <UnitInput
                suffix="sec"
                value={String(s.refresh)}
                onChange={(raw) => {
                  const v = parseInt(raw.replace(/[^0-9]/g, ''), 10);
                  s.set({ refresh: isNaN(v) ? 0 : v });
                }}
              />
            </div>
            <div>
              <span style={fieldLabel}>Last sync</span>
              <span className="tnum" style={{ fontSize: 14, color: C.text }}>
                {s.lastSync}
              </span>
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <span style={fieldLabel}>Simulate snapshot state</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <SegBtn
                  active={sync === 'synced'}
                  label="SYNCED"
                  size={10}
                  onClick={() => s.set({ simulatedSync: null, engineSync: 'synced' })}
                />
                <SegBtn active={sync === 'syncing'} label="SYNCING" size={10} onClick={refreshNow} />
                <SegBtn
                  active={sync === 'stale'}
                  label="STALE"
                  size={10}
                  onClick={() => s.set({ simulatedSync: 'stale' })}
                />
                <SegBtn
                  active={sync === 'error'}
                  label="ERROR"
                  size={10}
                  onClick={() => s.set({ simulatedSync: 'error' })}
                />
              </div>
            </div>
          </div>
        </div>

        {/* ARBITRAGE */}
        <div style={{ borderTop: `1px solid ${C.borderFaint}`, paddingTop: 20 }}>
          <span style={{ ...capsLabel(10, C.sectionLabel), display: 'block', marginBottom: 12 }}>
            ARBITRAGE
          </span>
          <div style={{ width: 180, marginBottom: 16 }}>
            <span style={fieldLabel}>Global min profit threshold</span>
            <UnitInput
              suffix="%"
              value={String(s.threshold)}
              onChange={(raw) => {
                // negative thresholds are allowed — useful to inspect
                // near-zero spreads that are still below profitability
                const v = parseFloat(raw.replace(/[^0-9.-]/g, ''));
                s.set({ threshold: isNaN(v) ? 0 : v });
              }}
            />
          </div>
          <span style={{ ...fieldLabel, marginBottom: 9 }}>Arbitrage rules</span>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              background: C.borderFaint,
              border: `1px solid ${C.border}`,
            }}
          >
            {RULES_DISPLAY.map((r) => (
              <div
                key={r.text}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 13px',
                  background: C.surface,
                }}
              >
                <span
                  style={{
                    width: 5,
                    height: 5,
                    background: r.green ? C.green : C.secondary,
                    flex: 'none',
                  }}
                />
                <span style={{ ...sans(11.5), color: C.chipText }}>{r.text}</span>
                <span
                  style={{ marginLeft: 'auto', ...mono(9, 500), color: r.green ? C.green : C.secondary }}
                >
                  {r.badge}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* DIAGNOSTICS */}
        <Diagnostics />

        {/* LOCAL DATA */}
        <div style={{ borderTop: `1px solid ${C.borderFaint}`, paddingTop: 20 }}>
          <span style={{ ...capsLabel(10, C.sectionLabel), display: 'block', marginBottom: 6 }}>
            LOCAL DATA
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ ...sans(11), color: C.body, maxWidth: 420 }}>
              Clears all local overrides — pair amounts, per-pair network toggles and alert drafts stored
              in this browser.
            </span>
            <button
              onClick={() => s.resetLocal()}
              style={{
                marginLeft: 'auto',
                padding: '8px 15px',
                cursor: 'pointer',
                ...mono(11, 500),
                background: 'transparent',
                border: `1px solid ${C.redBorder40}`,
                color: C.red,
              }}
            >
              Reset local changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Runtime crashes caught by the error boundaries and global handlers. */
function Diagnostics() {
  const [crashes, setCrashes] = useState(readCrashes);
  const [copied, setCopied] = useState(false);
  const recent = [...crashes].reverse();

  return (
    <div style={{ borderTop: `1px solid ${C.borderFaint}`, paddingTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <span style={capsLabel(10, C.sectionLabel)}>DIAGNOSTICS</span>
        <span style={{ ...mono(10, 500), color: crashes.length ? C.red : C.label }}>
          {crashes.length} recorded
        </span>
        {crashes.length > 0 && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(JSON.stringify(crashes, null, 2));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              style={smallBtn}
            >
              {copied ? 'Copied' : 'Copy log'}
            </button>
            <button
              onClick={() => {
                clearCrashes();
                setCrashes([]);
              }}
              style={smallBtn}
            >
              Clear
            </button>
          </span>
        )}
      </div>
      {crashes.length === 0 ? (
        <span style={{ ...sans(11), color: C.body }}>No crashes recorded in this browser.</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {recent.slice(0, 8).map((c) => (
            <div
              key={`${c.at}-${c.scope}`}
              style={{ display: 'flex', gap: 10, ...mono(10, 500), alignItems: 'baseline' }}
            >
              <span className="tnum" style={{ color: C.label, flex: 'none' }}>
                {new Date(c.at).toLocaleString('en-GB')}
              </span>
              <span style={{ color: C.secondary, flex: 'none' }}>{c.scope}</span>
              <span style={{ color: C.red, wordBreak: 'break-word' }}>{c.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const smallBtn: React.CSSProperties = {
  padding: '5px 10px',
  background: 'transparent',
  border: `1px solid ${C.borderMid}`,
  color: C.chipText,
  cursor: 'pointer',
  ...mono(10, 500),
};

const fieldLabel: React.CSSProperties = {
  fontSize: 11,
  color: C.secondary,
  display: 'block',
  marginBottom: 7,
  fontFamily: "'IBM Plex Sans', sans-serif",
};

import type React from 'react';

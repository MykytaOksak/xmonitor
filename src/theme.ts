// Design tokens from the handoff — see design_handoff README.
export const C = {
  page: '#070707',
  surface: '#0B0B0B',
  header: '#0D0D0D',
  panel: '#0A0A0A',
  drawer: '#090909',
  dropdown: '#111111',

  text: '#EAEAEA',
  chipText: '#CFCFCF',
  secondary: '#8A8A8A',
  body: '#6A6A6A',
  label: '#565656',
  navIdle: '#5C5C5C',
  sectionLabel: '#7C7C7C',

  green: '#46B27B',
  red: '#D25A5F',
  tgBlue: '#2AA3E0',
  tgBlueText: '#5CC0EC',

  border: 'rgba(255,255,255,.08)',
  borderFaint: 'rgba(255,255,255,.06)',
  borderInput: 'rgba(255,255,255,.16)',
  borderMid: 'rgba(255,255,255,.1)',
  divider: 'rgba(255,255,255,.05)',
  dividerFaint: 'rgba(255,255,255,.04)',

  greenBg06: 'rgba(70,178,123,.06)',
  greenBg08: 'rgba(70,178,123,.08)',
  greenBg10: 'rgba(70,178,123,.1)',
  greenBg12: 'rgba(70,178,123,.12)',
  greenBg14: 'rgba(70,178,123,.14)',
  greenBorder40: 'rgba(70,178,123,.4)',
  greenBorder45: 'rgba(70,178,123,.45)',

  redBg08: 'rgba(210,90,95,.08)',
  redBg10: 'rgba(210,90,95,.1)',
  redBorder25: 'rgba(210,90,95,.25)',
  redBorder30: 'rgba(210,90,95,.3)',
  redBorder40: 'rgba(210,90,95,.4)',
} as const;

export const mono = (size: number, weight = 500): React.CSSProperties => ({
  font: `${weight} ${size}px 'IBM Plex Mono', monospace`,
});

export const sans = (size: number, weight = 400): React.CSSProperties => ({
  font: `${weight} ${size}px 'IBM Plex Sans', sans-serif`,
});

// Tiny mono ALL-CAPS column/status label.
export const capsLabel = (size = 10, color: string = C.label): React.CSSProperties => ({
  ...mono(size, 500),
  letterSpacing: '.08em',
  color,
  textTransform: 'uppercase',
});

// Segmented-control button styling (active = green tint), from the prototype.
export const seg = (active: boolean) =>
  active
    ? { background: C.greenBg14, border: `1px solid ${C.greenBorder45}`, color: C.green }
    : { background: 'transparent', border: `1px solid ${C.borderMid}`, color: C.secondary };

// Network toggle chip styling (enabled = green tint).
export const chip = (on: boolean) => ({
  background: on ? C.greenBg08 : 'transparent',
  border: `1px solid ${on ? C.greenBorder40 : C.borderMid}`,
  color: on ? C.chipText : C.label,
  dotOpacity: on ? 1 : 0.4,
});

import type React from 'react';

import { C, mono } from '../theme';
import { useApp, type View } from '../state/store';
import { Logo } from './Logo';

const ITEMS: { view: View; label: string }[] = [
  { view: 'quotes', label: 'QUOTES' },
  { view: 'alerts', label: 'ALERTS' },
  { view: 'portfolio', label: 'PORTFOLIO' },
  { view: 'settings', label: 'SETTINGS' },
];

export function Rail({ horizontal = false }: { horizontal?: boolean }) {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);

  return (
    <div
      style={{
        flex: 'none',
        background: C.header,
        display: 'flex',
        ...(horizontal
          ? { flexDirection: 'row', width: '100%', borderBottom: `1px solid ${C.border}`, alignItems: 'stretch' }
          : { flexDirection: 'column', width: 52, borderRight: `1px solid ${C.border}`, alignItems: 'stretch', paddingTop: 14 }),
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          ...(horizontal ? { padding: '0 16px' } : { marginBottom: 22 }),
        }}
      >
        <Logo size={32} />
      </div>
      {ITEMS.map((it) => (
        <button
          key={it.view}
          onClick={() => setView(it.view)}
          style={{
            border: 'none',
            cursor: 'pointer',
            background: view === it.view ? 'rgba(255,255,255,.06)' : 'transparent',
            color: view === it.view ? C.text : C.navIdle,
            ...mono(10, 600),
            letterSpacing: '.1em',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            ...(horizontal
              ? { flex: 1, padding: '13px 0' }
              : { padding: '16px 0', writingMode: 'vertical-rl' }),
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

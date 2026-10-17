import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logCrash } from '../crashlog';
import { C, capsLabel, mono, sans } from '../theme';

const RETRY_MS = 2_000;
// More than this many crashes inside the window means the failure isn't a
// one-off: back off to a slow retry instead of remounting in a tight loop.
const MAX_AUTO_RETRIES = 3;
const RETRY_WINDOW_MS = 60_000;
// The app is left running unattended for hours, and the usual cause is bad
// data that the next scan overwrites — so never stop retrying, just slowly.
const SLOW_RETRY_MS = 30_000;

interface Props {
  /** Recorded with each crash — which part of the app failed. */
  scope: string;
  /** Changing this (e.g. switching views) clears a caught error. */
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Bumped on every recovery so the subtree remounts from scratch. */
  generation: number;
  givenUp: boolean;
}

/**
 * Without a boundary, one exception thrown while rendering unmounts the whole
 * React tree: the page goes blank, and App's cleanup stops the quote engine and
 * its alerts with it. This contains the failure to the subtree it wraps, logs
 * it, and remounts the subtree after a short pause.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, generation: 0, givenUp: false };
  private crashTimes: number[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logCrash({
      scope: this.props.scope,
      message: `${error.name}: ${error.message}`,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
    const now = Date.now();
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < RETRY_WINDOW_MS), now];
    const backingOff = this.crashTimes.length > MAX_AUTO_RETRIES;
    if (backingOff) this.setState({ givenUp: true });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.recover(), backingOff ? SLOW_RETRY_MS : RETRY_MS);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.recover(true);
  }

  componentWillUnmount(): void {
    clearTimeout(this.timer);
  }

  private recover(manual = false): void {
    clearTimeout(this.timer);
    if (manual) this.crashTimes = [];
    // givenUp is left as-is: if the view throws again straight away, the
    // backoff continues rather than restarting the fast retries.
    this.setState((s) => ({ error: null, generation: s.generation + 1 }));
  }

  render(): ReactNode {
    const { error, generation, givenUp } = this.state;
    if (!error) return <Frag key={generation}>{this.props.children}</Frag>;

    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: C.surface,
        }}
      >
        <div style={{ maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span style={{ ...capsLabel(9), letterSpacing: '.1em' }}>
            {givenUp ? 'RETRYING EVERY 30s' : 'RECOVERING'}
          </span>
          <span style={{ ...sans(14, 600), color: C.text }}>
            {givenUp
              ? 'This view keeps failing, so it is retrying slowly.'
              : 'This view hit an error and is restarting.'}
          </span>
          <span style={{ ...mono(11, 500), color: C.red, wordBreak: 'break-word' }}>
            {error.name}: {error.message}
          </span>
          <span style={{ ...sans(11), color: C.label }}>
            Quotes and alerts keep running in the background. The error is saved under Settings →
            Diagnostics.
          </span>
          {givenUp && (
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button onClick={() => this.recover(true)} style={btn(C.borderMid, C.chipText)}>
                Try again
              </button>
              <button onClick={() => location.reload()} style={btn(C.borderInput, C.text)}>
                Reload page
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
}

// A keyed wrapper so a recovery remounts the children instead of reusing them.
function Frag({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

const btn = (border: string, color: string): React.CSSProperties => ({
  padding: '7px 14px',
  background: 'transparent',
  border: `1px solid ${border}`,
  color,
  cursor: 'pointer',
  ...mono(11, 500),
});

import type React from 'react';

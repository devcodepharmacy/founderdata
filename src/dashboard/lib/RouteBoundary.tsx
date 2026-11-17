import { Component, type ReactNode } from 'react';

/**
 * Catches a page that fails to load or render. A chunk that cannot load (the deploy replaced it, or the network
 * dropped) reloads the tab once; any other error shows a plain message with a Reload button, where before the
 * whole app went blank.
 */
const CHUNK_ERROR = /dynamically imported module|importing a module script|failed to fetch dynamically|loading chunk/i;

export class RouteBoundary extends Component<{ children: ReactNode; /** The page being shown: a change clears an earlier failure. */ path?: string }, { failed: boolean }> {
  state = { failed: false };

  // One page failing must not take the next one down with it: the boundary outlives navigation, so it resets here.
  componentDidUpdate(prev: { path?: string }) {
    if (this.state.failed && prev.path !== this.props.path) this.setState({ failed: false });
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    if (!CHUNK_ERROR.test(String(error?.message))) return;
    try {
      const at = Number(sessionStorage.getItem('fd-reload') || 0);
      if (Date.now() - at < 15_000) return;
      sessionStorage.setItem('fd-reload', String(Date.now()));
    } catch {
      return;
    }
    window.location.reload();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-sm text-stone-500">This page did not load.</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

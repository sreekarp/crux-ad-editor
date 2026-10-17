import { Component, type ReactNode } from 'react';

/** Keeps one broken render (e.g. an unexpected layer shape) from blanking the whole editor. */
export class SafeBoundary extends Component<{ children: ReactNode; fallback?: ReactNode; resetKey?: unknown }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[render error]', error);
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      return this.props.fallback ?? <div className="p-3 text-xs text-rose-600">Render error: {this.state.error.message}</div>;
    }
    return this.props.children;
  }
}

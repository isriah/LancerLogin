import { Component, type ErrorInfo, type ReactNode } from "react";

type FallbackProps = { error: Error; retry: () => void };

/**
 * Contain a render error to one region so the rest of the dashboard keeps working. `resetKey` clears the error when it
 * changes (for example on navigation), and the fallback's retry renders the region again.
 */
export class ErrorBoundary extends Component<{ fallback: (props: FallbackProps) => ReactNode; resetKey?: unknown; children: ReactNode }, { error?: Error; resetKey?: unknown }> {
  state: { error?: Error; resetKey?: unknown } = { resetKey: this.props.resetKey };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error?: Error; resetKey?: unknown }) {
    return Object.is(props.resetKey, state.resetKey) ? null : { error: undefined, resetKey: props.resetKey };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error("Dashboard region failed to render", error, info.componentStack); }
  render() {
    const { error } = this.state;
    return error ? this.props.fallback({ error, retry: () => this.setState({ error: undefined }) }) : this.props.children;
  }
}

/** Whole-application fallback: nothing else could render, so offer a reload. */
export function AppErrorFallback() {
  return <main className="centered-state" role="alert"><div className="brand-mark" aria-hidden="true">L</div><p className="kicker">LancerLogin dashboard</p><h1>Something went wrong</h1><p>The dashboard hit an unexpected error. Reload the page to continue. Saved work is not affected.</p><button className="primary-button" type="button" onClick={() => window.location.reload()}>Reload dashboard</button></main>;
}

/** Page fallback inside the dashboard shell: navigation stays available. */
export function PageErrorFallback({ retry, onHome }: { retry: () => void; onHome: () => void }) {
  return <section className="ui-card unavailable-page" role="alert" aria-labelledby="page-error-title"><h1 id="page-error-title">This page could not be displayed</h1><p>An unexpected error stopped this page from rendering. The rest of the dashboard still works.</p><div className="module-actions"><button className="primary-button" type="button" onClick={retry}>Try again</button><button type="button" onClick={onHome}>Return to Dashboard</button></div></section>;
}

/** Module fallback for a contributed page or slot, so one module cannot take down Core or other modules. */
export function ModuleErrorFallback({ retry, inline }: { retry: () => void; inline: boolean }) {
  if (inline) return <span className="ui-status" data-tone="error" role="status">Module content unavailable</span>;
  return <section className="ui-card unavailable-page" role="alert"><h2>This module failed to render</h2><p>Other parts of LancerLogin keep working. Try again, or reload the page if the problem continues.</p><button type="button" onClick={retry}>Try again</button></section>;
}

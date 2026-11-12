import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

// A safety net under every screen. When nothing catches an error thrown while
// a screen draws, React unmounts the whole app and leaves a blank page. With
// this boundary, only the screen's own area is replaced: by a short
// explanation, a reload button, and the error's own message for whoever is
// asked to fix it. The console gets the full details. PageTransition holds
// one inside its path-keyed wrapper, so moving to another screen starts a
// fresh one, and the sidebar around it stays usable.

// Anything that wants to know when a screen crashes — a crash reporter, say.
// It is told the error, and may hand back lines to show under the crash
// screen's details. Nothing here knows who listens: with no listener at all,
// the crash screen is the same.
export type ScreenCrashListener = (
  error: unknown,
  componentStack: string | null | undefined,
) => string[] | void;

const screenCrashListeners = new Set<ScreenCrashListener>();

// Returns the function that stops listening.
export function onScreenCrash(listener: ScreenCrashListener): () => void {
  screenCrashListeners.add(listener);
  return () => {
    screenCrashListeners.delete(listener);
  };
}

// Tells every listener, and collects what they want shown. A listener that
// throws is skipped: reporting a crash must never break the crash screen.
export function notifyScreenCrash(error: unknown, componentStack: string | null | undefined): string[] {
  const lines: string[] = [];
  for (const listener of screenCrashListeners) {
    try {
      lines.push(...(listener(error, componentStack) ?? []));
    } catch {
      // See above.
    }
  }
  return lines;
}

export class ScreenErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown; lines: string[] }
> {
  override state: { error: unknown; lines: string[] } = { error: null, lines: [] };

  // `throw null` is possible too: kept as an error, or the boundary would
  // render the same children again.
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error: error ?? new Error("unknown error") };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[screen crashed]", error, info.componentStack);
    const lines = notifyScreenCrash(error ?? new Error("unknown error"), info.componentStack);
    if (lines.length > 0) this.setState({ lines });
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return <ScreenCrashed error={this.state.error} lines={this.state.lines} />;
  }
}

export function screenErrorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export function ScreenCrashed({ error, lines = [] }: { error: unknown; lines?: string[] }) {
  return (
    <div
      role="alert"
      className="mx-auto mt-10 flex max-w-lg flex-col items-start gap-3 rounded-xl border border-border bg-surface p-5 text-ink"
    >
      <p className="text-base font-semibold">משהו השתבש במסך הזה</p>
      <p className="text-sm text-ink-muted">
        שינויים שלא נשמרו במסך הזה לא נשמרו. טענו את הדף מחדש ונסו שוב.
      </p>
      <Button type="button" onClick={() => window.location.reload()}>
        טעינה מחדש
      </Button>
      <p className="text-xs text-ink-subtle">
        פרטים לתמיכה: <bdi dir="ltr" className="break-all font-mono">{screenErrorText(error)}</bdi>
      </p>
      {lines.length > 0 && (
        <details className="w-full text-xs text-ink-subtle">
          <summary className="cursor-pointer">פרטים נוספים</summary>
          <ol className="mt-2 flex flex-col gap-0.5 break-all font-mono">
            {lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

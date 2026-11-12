import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

// A safety net under every screen. When nothing catches an error thrown while
// a screen draws, React unmounts the whole app and leaves a blank page. With
// this boundary, only the screen's own area is replaced: by a short
// explanation, a reload button, and the error's own message for whoever is
// asked to fix it. The console gets the full details. PageTransition holds
// one inside its path-keyed wrapper, so moving to another screen starts a
// fresh one, and the sidebar around it stays usable.
export class ScreenErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  // `throw null` is possible too: kept as an error, or the boundary would
  // render the same children again.
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error: error ?? new Error("unknown error") };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[screen crashed]", error, info.componentStack);
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return <ScreenCrashed error={this.state.error} />;
  }
}

export function screenErrorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export function ScreenCrashed({ error }: { error: unknown }) {
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
    </div>
  );
}

import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";

// CRASH TRAIL — a temporary debugging aid (2026-11-12). To remove it, ask for
// "remove Crash Trail": this file, <CrashTrail /> in main.tsx, the two
// CRASH TRAIL lines in components/shell/screen-error-boundary.tsx, the
// crash_trail entry in packages/db/src/supabase-types.ts, VITE_APP_VERSION in
// scripts/build-vercel.mjs, and a migration that drops public.crash_trail
// (0096 created it).
//
// It keeps the last 20 things the person did — the screens they opened and
// the controls they clicked — and when a screen crashes, saves them with the
// error and who it happened to as one crash_trail row, so a blank screen can
// be traced and reproduced. In a plain list outside React on purpose: as
// React state every click would redraw the app, and a crash throws that
// state away at the very moment it is needed.
//
// Actions only, never data: a click is recorded by the control's own label,
// and a field by its name — never by what was typed into it.

export const CRASH_TRAIL_STEPS = 20;
const LABEL_LIMIT = 120;

export type CrashStep = { at: string; what: string };
export type CrashPerson = { id: string; name: string | null; role: string | null };

const steps: CrashStep[] = [];
let person: CrashPerson | null = null;

export function recordStep(what: string, at: Date = new Date()): void {
  steps.push({ at: at.toISOString(), what: what.slice(0, 300) });
  if (steps.length > CRASH_TRAIL_STEPS) steps.splice(0, steps.length - CRASH_TRAIL_STEPS);
}

export function crashSteps(): CrashStep[] {
  return steps.map((step) => ({ ...step }));
}

// For tests.
export function forgetCrashSteps(): void {
  steps.length = 0;
}

const CONTROLS =
  'button, a, summary, label, select, textarea, input, [role="button"], [role="option"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"]';
const FIELDS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

// What a click is called in the trail: the control's own name — its
// aria-label or title, else its visible text. A field is named by its label
// alone (a ticked box by the row it sits in), never by what is in it.
export function describeClick(target: EventTarget | null): string | null {
  if (!target || typeof (target as Element).closest !== "function") return null;
  const control = (target as Element).closest(CONTROLS);
  if (!control) return null;
  const type = control.getAttribute("type");
  const box = control.tagName === "INPUT" && (type === "checkbox" || type === "radio");
  const named = control.getAttribute("aria-label") || control.getAttribute("title");
  const raw =
    named ||
    (box
      ? (control.closest("label")?.textContent ?? "")
      : FIELDS.has(control.tagName)
        ? control.getAttribute("name") || control.getAttribute("placeholder") || ""
        : (control.textContent ?? ""));
  const label = raw.replace(/\s+/g, " ").trim().slice(0, LABEL_LIMIT);
  const kind = control.getAttribute("role") || (box ? type! : control.tagName.toLowerCase());
  return label ? `clicked ${kind} "${label}"` : `clicked ${kind}`;
}

export type CrashRow = {
  user_id: string | null;
  user_name: string | null;
  role: string | null;
  screen: string;
  error: string;
  stack: string | null;
  breadcrumbs: CrashStep[];
  browser: string;
  app_version: string | null;
};

// One crash, as its crash_trail row — each field cut to the table's limit.
export function crashRow(
  error: unknown,
  componentStack: string | null | undefined,
  context: { person: CrashPerson | null; screen: string; browser: string; version: string | null; steps: CrashStep[] },
): CrashRow {
  const message = error instanceof Error ? error.message || error.name : String(error);
  const stack = [error instanceof Error ? error.stack : undefined, componentStack ? `component stack:${componentStack}` : undefined]
    .filter(Boolean)
    .join("\n\n");
  return {
    user_id: context.person?.id ?? null,
    user_name: context.person?.name?.slice(0, 200) ?? null,
    role: context.person?.role?.slice(0, 40) ?? null,
    screen: context.screen.slice(0, 500),
    error: message.slice(0, 2000),
    stack: stack ? stack.slice(0, 20000) : null,
    breadcrumbs: context.steps.slice(-CRASH_TRAIL_STEPS),
    browser: context.browser.slice(0, 500),
    app_version: context.version ? context.version.slice(0, 40) : null,
  };
}

// Saves the crash, and never throws: the record of a crash must not cause
// another. A save that fails (offline, or before migration 0096 is applied)
// only loses the record.
export async function saveCrash(error: unknown, componentStack?: string | null): Promise<void> {
  try {
    const row = crashRow(error, componentStack, {
      person,
      screen: `${window.location.pathname}${window.location.search}`,
      browser: navigator.userAgent,
      version: (import.meta.env.VITE_APP_VERSION as string | undefined) || null,
      steps: crashSteps(),
    });
    await createClient().from("crash_trail").insert(row);
  } catch {
    // Nothing more to do; see above.
  }
}

// Listens for the whole app: mounted once, in main.tsx.
export function CrashTrail() {
  const { pathname, search } = useLocation();
  const { user, profile } = useAuth();

  useEffect(() => {
    recordStep(`opened ${pathname}${search}`);
  }, [pathname, search]);

  useEffect(() => {
    person = user ? { id: user.id, name: profile?.displayName ?? null, role: profile?.role ?? null } : null;
  }, [user, profile]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const what = describeClick(event.target);
      if (what) recordStep(what);
    };
    // Capture, so a control that stops its click from bubbling still counts.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return null;
}

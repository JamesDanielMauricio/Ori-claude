import type { KeyboardEvent, WheelEvent } from "react";

// For the grower's pick boxes, which take whole pallets only, and so should
// not accept a decimal point at all. Orders and arrangements take one
// decimal place since workbook Task 35 — their boxes use pallet-input.ts —
// and picks stay whole until the client says otherwise (decision D18).
//
// `step="1"` on its own doesn't do this: a browser's number input still
// lets someone type "8.5" while focused, and only flags it as :invalid on
// blur/submit (which this app doesn't check). Blocking the separator key
// itself is what actually stops it from being typed in the first place.
// The sign and exponent keys too: a number input takes "-5", "1e3" and
// "2e-1" as valid numbers, and none of them is a whole count of pallets.
const NON_DIGIT_KEYS = new Set([".", ",", "-", "+", "e", "E"]);

export function blockDecimalKey(event: KeyboardEvent<HTMLInputElement>) {
  // Not with Ctrl/Cmd/Alt held: those are the browser's shortcuts (Ctrl+-
  // and Ctrl++ zoom), which type nothing. Shift still counts — Shift+= is "+".
  // Whatever a modified key could still insert, stripDecimal below cleans.
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (NON_DIGIT_KEYS.has(event.key)) {
    event.preventDefault();
  }
}

// Second line of defense for however a decimal could still land in the
// field without a keystroke `blockDecimalKey` would see — a paste, or
// autofill. Keeps only the digits before the first non-digit, so "8.5"
// pasted in becomes "8" rather than being accepted whole, "1e3" becomes "1"
// rather than 1,000 pallets, and "-5" becomes empty.
export function stripDecimal(value: string): string {
  return /^\d*/.exec(value.trim())?.[0] ?? "";
}

// Chrome, Firefox and Edge all change a focused number input's value on
// mouse-wheel scroll — and this app hides the spinner buttons that would
// normally hint at that (globals.css), so there's no visible affordance
// telling anyone the field even responds to scrolling. A cursor that happens
// to rest on a price or quantity field while the page (or a long list, or a
// dialog) scrolls past it silently edits that field's value.
//
// Blurring on wheel is the fix, not `preventDefault`: the browser's
// scroll-to-increment isn't reliably stopped by it (Chrome applies it before
// a non-passive listener would run), but an unfocused input has nothing for
// the wheel to increment, and the scroll then falls through to the page like
// it would over any other element. Shared by every number input in the app,
// price fields included — this has nothing to do with the decimal-blocking
// above, which only applies to whole-pallet counts.
export function blockWheel(event: WheelEvent<HTMLInputElement>) {
  event.currentTarget.blur();
}

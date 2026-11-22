import { useRef, useState, type ChangeEvent, type KeyboardEvent, type WheelEvent } from "react";

// For the boxes that take whole pallets only — the grower's pick boxes and
// the office's stock dialog on the arrangement board — and so should not
// accept a decimal point at all. Orders and arrangements take one decimal
// place since workbook Task 35 — their boxes use pallet-input.ts — and picks
// stay whole until the client says otherwise (decision D18).
//
// `step="1"` on its own doesn't do this: a browser's number input still
// lets someone type "8.5" while focused, and only flags it as :invalid on
// blur/submit (which this app doesn't check). Stopping the key itself is
// what actually keeps it from being typed in the first place.
//
// A point, a comma or an exponent ENDS the number: it is not typed, and
// neither are the digits straight after it, so "2.5" leaves 2. Swallowing
// only the point turned "2.5" into 25 — ten times the stock, saved without
// a word (found in testing, 2026-11-20). The box shows "מספר שלם בלבד" when
// this happens (useWholeNumberInput below), so the person knows why.
// A sign is only swallowed: "+3" means 3, and a minus never makes sense for
// a count of pallets.
const CUT_KEYS = new Set([".", ",", "e", "E"]);
const SIGN_KEYS = new Set(["-", "+"]);
const DIGIT = /^\d$/;

export interface WholeNumberKeyResult {
  // "allow": the key does what it normally does. "block": it types nothing.
  // "cut": it types nothing and ended the number.
  action: "allow" | "block" | "cut";
  // Whether the digits typed next are still part of the number that was cut.
  cutting: boolean;
}

// What one key press does in a whole-pallet box. Pure, so the rule can be
// tested on its own: `cutting` is what the previous key left behind.
export function wholeNumberKey(
  key: string,
  modified: boolean,
  cutting: boolean,
): WholeNumberKeyResult {
  // Not with Ctrl/Cmd/Alt held: those are the browser's shortcuts (Ctrl+-
  // and Ctrl++ zoom), which type nothing. Shift still counts — Shift+= is "+".
  // Whatever a modified key could still insert (a paste), stripDecimal cleans.
  if (modified) return { action: "allow", cutting: false };
  if (CUT_KEYS.has(key)) return { action: "cut", cutting: true };
  if (SIGN_KEYS.has(key)) return { action: "block", cutting };
  if (DIGIT.test(key) && cutting) return { action: "block", cutting: true };
  // A digit of a number that wasn't cut, or any other key — Backspace, an
  // arrow, Tab — which also ends the cut: typing goes back to normal.
  return { action: "allow", cutting: false };
}

// Everything a whole-pallet <input type="number"> needs: its key, blur and
// change handlers, and `cutNote` — true when the last thing typed or pasted
// had a fraction that was cut off, for the box to show "מספר שלם בלבד" beside
// it. `onChange` receives the box's new text, digits only.
export function useWholeNumberInput(onChange: (next: string) => void) {
  const cutting = useRef(false);
  const [cutNote, setCutNote] = useState(false);
  return {
    cutNote,
    onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      const result = wholeNumberKey(
        event.key,
        event.ctrlKey || event.metaKey || event.altKey,
        cutting.current,
      );
      cutting.current = result.cutting;
      if (result.action !== "allow") event.preventDefault();
      if (result.action === "cut") setCutNote(true);
    },
    onBlur() {
      cutting.current = false;
    },
    onChange(event: ChangeEvent<HTMLInputElement>) {
      const typed = event.target.value;
      // A fraction pasted or autofilled in is cut by stripDecimal; say so,
      // as for a typed one. Any other edit means the note has been seen.
      setCutNote(/[.,eE]/.test(typed));
      onChange(stripDecimal(typed));
    },
  };
}

// Second line of defense for however a decimal could still land in the
// field without a keystroke `wholeNumberKey` would see — a paste, or
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

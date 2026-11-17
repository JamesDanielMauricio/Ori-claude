import type { ReactNode } from "react";

import { Button } from "../ui/button";

// Pinned, the bar is drawn as a floating toolbar rather than as the
// full-bleed strip the in-flow version is. Two reasons, both visual:
//
// `self-start` shrinks it to its own buttons. Stretched to the content
// width it was a wide empty band carrying one small control, and on a page
// whose every other element is a rounded card floating on ivory, a flat
// edge-to-edge slab under a hairline read as an unfinished wireframe rather
// than a deliberate object.
//
// The edge is `border-strong`, not the usual hairline, and it is doing the
// work the shadow can't. This bar floats over a card that is itself
// near-white, so a white panel with a soft warm shadow — which reads
// perfectly against the ivory canvas everywhere else in the app — turned
// into a ghost the moment it crossed the catalogue: same value, same hue,
// no boundary. `border-strong` is the token meant for exactly this ("edges
// that carry meaning on their own"), and it is what keeps the bar legible
// on white card and ivory page alike. Translucency was tried here and is
// deliberately absent for the same reason: blurred white over flat white
// buys no depth cue and costs contrast.
//
// This also retires the old `after:` background extender — a strip painting
// over the scrollport's bottom padding only made sense while the bar was
// pretending to BE the bottom edge of the page; something that visibly
// floats is allowed to have content under it.
const STICKY_CLASSES =
  "sticky bottom-4 z-10 mt-3 rounded-xl bg-surface p-3 shadow-float ring-1 ring-inset ring-border-strong";

// The "discard & save" bar under the two produce editors (OrderLinesEditor,
// PickLinesEditor) — one real component instead of near-identical Bubble
// copies (R1). It once also carried the management screens' browse mode
// (ערוך / מחק); those screens moved to RecordTable, and neither editor has a
// browse mode: each renders this bar only while its order or pick is
// editable at all.
export function ActionBar({
  saving = false,
  dirty = true,
  canSaveUnchanged = false,
  sticky = false,
  onDiscard,
  onSave,
  extra,
}: {
  saving?: boolean;
  // Whether the draft actually differs from what the server holds. Both
  // buttons act on that difference, so with nothing
  // changed there is nothing for either to do: "שמור" would write the values
  // already stored, "בטל שינויים" would restore the ones already on screen.
  // Greying them out says so before the click, instead of after — and on the
  // produce editors, where a save re-submits an entire order or pick, a
  // no-op save is not free: it re-stamps submitted_at and can fire a
  // notification for a change nobody made.
  //
  // Defaults to true — i.e. to the always-clickable behaviour every one of
  // these bars had before — so a future screen that forgets to pass it gets
  // a harmless extra save rather than a permanently dead save button.
  dirty?: boolean;
  // Keeps "שמור" clickable when nothing has been edited, for the hosts whose
  // save does more than write the draft back: the grower's own picking screen
  // and the distributor's "בשם מגדל" popup, where "שמור" is also what sends a
  // draft pick. A pick whose saved numbers are already right still needs a
  // button that sends them. "בטל שינויים" is unaffected — with no edits there
  // is still nothing to discard. Defaults to false, so every other bar is
  // unchanged.
  canSaveUnchanged?: boolean;
  // Pins the bar to the bottom of whatever is scrolling it, instead of
  // leaving it at the end of the content. The reference-data screens are
  // short forms where the bar is on screen anyway; the two produce editors
  // are not — a customer's order is the whole day's catalogue, several
  // hundred rows, and "save" sitting under all of it meant scrolling past
  // everything to commit a change made at the top. See STICKY_CLASSES for
  // why pinning also changes how the bar is drawn.
  sticky?: boolean;
  onDiscard: () => void;
  onSave: () => void;
  extra?: ReactNode | undefined;
}) {
  return (
    <div
      className={`animate-rise-in flex flex-wrap items-center gap-2 ${
        sticky ? STICKY_CLASSES : "mt-1 border-t border-border pt-4"
      }`}
    >
      <Button type="button" onClick={onSave} disabled={saving || (!dirty && !canSaveUnchanged)}>
        {/* A spinning ring during the save, not just the word "שומר…".
            The text alone changes by two characters and is easy to miss;
            a moving element is unambiguous proof the click registered. */}
        {saving && (
          <span
            aria-hidden
            className="animate-spin-loop h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent"
          />
        )}
        {/* The word is a <span> of its own, for Chrome's "Translate this
            page". The translator swaps every bit of text on the page for
            its own <font> tags, while React still points at the text it
            wrote. As bare text, "שמור" was what the spinner above had to be
            put in front of — text no longer on the page — so pressing save
            crashed a translated screen, even though the save itself still
            went through. A whole <span> is something the translator leaves
            in place, and one holding a single string gets "שומר…" written
            in whole. See the grower card's count line
            (grower-supply-column.tsx) for the longer story. */}
        <span>{saving ? "שומר…" : "שמור"}</span>
      </Button>
      {/* Greyed out with nothing to discard. */}
      <Button type="button" variant="secondary" onClick={onDiscard} disabled={saving || !dirty}>
        בטל שינויים
      </Button>
      {extra}
    </div>
  );
}

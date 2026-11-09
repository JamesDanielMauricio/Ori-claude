// Where CellPopover's panel goes vertically — below its trigger, or above it
// when it doesn't fit below and there's more room above. Kept apart from the
// component so the arithmetic can be tested without a DOM.
//
// Always opening downward ran the panel off the bottom of the screen for the
// lower rows of a table — the same fault ui/select.tsx fixed for its list,
// and fixed the same way. Fixed-position, so scrolling the page could never
// bring the cut-off part into view.

// Between the trigger and the panel.
export const CELL_POPOVER_GAP = 6;
// Kept free between the panel and the viewport's top or bottom edge.
const VIEWPORT_MARGIN = 8;
// The panel's own cap (`max-h-[60dvh]`), as a fraction of the viewport.
const MAX_HEIGHT_RATIO = 0.6;

export interface CellPopoverVerticalPlacement {
  // Exactly one of `top` / `bottom` is set: a panel opened upward is pinned
  // by its bottom edge, so it stays against the trigger as its content
  // shrinks (a search narrowing the list).
  top: number | null;
  bottom: number | null;
  maxHeight: number;
  upward: boolean;
}

export function placeCellPopoverVertically({
  triggerTop,
  triggerBottom,
  viewportHeight,
  panelHeight,
}: {
  triggerTop: number;
  triggerBottom: number;
  viewportHeight: number;
  // The panel's full height with nothing cutting it short.
  panelHeight: number;
}): CellPopoverVerticalPlacement {
  const cap = viewportHeight * MAX_HEIGHT_RATIO;
  const naturalHeight = Math.min(panelHeight, cap);
  const spaceBelow = viewportHeight - triggerBottom - CELL_POPOVER_GAP - VIEWPORT_MARGIN;
  const spaceAbove = triggerTop - CELL_POPOVER_GAP - VIEWPORT_MARGIN;
  const upward = naturalHeight > spaceBelow && spaceAbove > spaceBelow;
  // Neither side fits: the panel takes the roomier one and scrolls inside.
  const maxHeight = Math.max(0, Math.min(cap, upward ? spaceAbove : spaceBelow));
  return upward
    ? {
        top: null,
        bottom: viewportHeight - triggerTop + CELL_POPOVER_GAP,
        maxHeight,
        upward,
      }
    : { top: triggerBottom + CELL_POPOVER_GAP, bottom: null, maxHeight, upward };
}

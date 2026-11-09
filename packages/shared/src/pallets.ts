// Pallet quantities on orders and arrangements (workbook Task 35, the
// client's request of 4 November): a number of pallets with at most one
// decimal place. 0.4 and 2.5 are quantities; 0.14 is not. Picks and
// leftovers are not covered — they stay whole pallets until the client says
// otherwise (decision D18).
//
// The rule exists twice, because two runtimes need it:
//   - here, for the order screen, the arrangement board, auto-arrange
//     ("הצע סידור") and the zod schemas every save goes through
//     (packages/domain);
//   - SQL public.refuse_pallets_finer_than_tenths (migration 0085), which
//     refuses the same values when an order line or an arrangement is saved,
//     so a request sent straight to the database cannot store 0.14 either.

/** The smallest step an order or arrangement quantity can take: a tenth of a pallet. */
export const PALLET_STEP = 0.1;

/** What a person is told when a quantity has more than one decimal place. */
export const PALLET_QUANTITY_MESSAGE =
  "כמות משטחים יכולה לכלול ספרה אחת לכל היותר אחרי הנקודה (למשל 0.4).";

/**
 * Whether `value` is a quantity an order line or an arrangement may hold:
 * finite, not negative, and at most one decimal place.
 *
 * Decided on tenths with a tolerance rather than on the number's text,
 * because a quantity worked out on the screen is often a sum, and in
 * JavaScript 0.1 + 0.2 is 0.30000000000000004 — which is still 0.3.
 */
export function isPalletQuantity(value: number): boolean {
  if (!Number.isFinite(value) || value < 0) return false;
  const tenths = value * 10;
  return Math.abs(tenths - Math.round(tenths)) < 1e-6;
}

/**
 * A pallet count with JavaScript's rounding noise taken out: rounded to two
 * decimal places, the precision the database keeps (numeric(10,2)), so it
 * never changes a stored value. For sums and differences of quantities —
 * 1 − 0.7 − 0.3 is 5.6e-17 in JavaScript, which would read as stock left
 * over — and for a quantity about to be sent, so the server compares 0.3,
 * not 0.30000000000000004, against its limits.
 */
export function roundPallets(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  // -0 would print as "-0".
  return rounded === 0 ? 0 : rounded;
}

/**
 * The largest quantity on the 0.1 grid that is not above `value`: what can
 * actually be entered against a limit. A limit is normally on the grid
 * already; a stored 2.65 (older data could hold one) allows 2.6.
 */
export function floorToPalletStep(value: number): number {
  const floored = Math.floor(value * 10 + 1e-6) / 10;
  return floored === 0 ? 0 : floored;
}

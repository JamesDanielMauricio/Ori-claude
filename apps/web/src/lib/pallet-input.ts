// The boxes an order or an arrangement quantity is typed into take one
// decimal place (workbook Task 35): a customer's order screen, the
// distributor's on-behalf-of order editor, and every arranging box on the
// arrangement screens. Grower picks still take whole pallets only
// (integer-input.ts) until the client says otherwise (decision D18).
//
// The rule itself — at most one decimal place — is @ori/shared/pallets,
// which the save schemas and the database (migration 0085) also apply. This
// is only what keeps a box from ever holding more than that: what a
// keystroke, a paste or autofill puts in it is cut back to one decimal place,
// so typing 0.45 leaves 0.4 and a pasted 2.55 becomes 2.5.

/**
 * `value` cut back to a pallet quantity as it is being typed: digits, then at
 * most a point and one digit after it. A comma counts as the point (some
 * phone keyboards put one on the decimal key). Anything else — a minus sign,
 * an exponent, letters — ends the number there. A trailing point is kept,
 * so "2." can still become "2.5".
 */
export function limitToOneDecimal(value: string): string {
  const match = /^(\d*)(\.\d?)?/.exec(value.trim().replace(",", "."));
  return match ? match[1]! + (match[2] ?? "") : "";
}

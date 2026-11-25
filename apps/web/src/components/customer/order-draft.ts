import { floorToPalletStep } from "@ori/shared/pallets";

import type { CatalogRow } from "./catalog-grouping";

// The order editor's draft — what the inputs hold, as text — and the pure
// rules for turning it into what submit_order receives. Kept apart from the
// component so the rules can be tested on their own.

export interface DraftLine {
  pallets: string;
  comment: string;
}

export function toDraft(rows: CatalogRow[]): Record<string, DraftLine> {
  const draft: Record<string, DraftLine> = {};
  for (const row of rows) {
    draft[row.variety_id] = {
      pallets: row.pallets_ordered ? String(row.pallets_ordered) : "",
      comment: row.comment ?? "",
    };
  }
  return draft;
}

// The draft as submit_order would actually receive it. Used for both the
// submission itself and the "is there anything to save?" comparison behind
// the ActionBar's buttons, so that question is answered by the payload
// rather than by the state of the controls.
//
// Which matters most for an untouched row: toDraft leaves a variety nobody
// ordered as "", so typing "0" (or "0.0") into such a row writes it into the
// draft and a textual comparison would call that an edit. Both sides go
// through Number(... || 0) here, so 0 === 0 and the order correctly reads as
// unchanged.
export function toSubmittedLines(rows: CatalogRow[], draft: Record<string, DraftLine>) {
  return rows.map((row) => ({
    productVarietyId: row.variety_id,
    palletsOrdered: Number(draft[row.variety_id]?.pallets || 0),
    comment: draft[row.variety_id]?.comment || null,
  }));
}

// What a send tells submit_order its screen was based on (migration 0111,
// workbook Task 09): the saved number of every product the screen shows, as
// last read from the server — the catalog rows, never the draft. The database
// refuses the send when any of them has changed since, so a screen that missed
// a live update cannot erase someone else's change by sending its old copy.
export function savedQuantities(rows: readonly CatalogRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.variety_id, Number(row.pallets_ordered) || 0]));
}

// The most a customer can have on a line at the moment — the number shown
// beside the box on their own order screen (workbook Task 35). What the stock
// still allows them (max_orderable_for_customer: the product's per-customer
// cap, or what other customers' orders leave of the stock, whichever is
// lower), cut down to the 0.1 steps a box can hold; or what they already have
// saved, if that is more. A saved quantity stays theirs when stock drops
// below it: submit_order holds only an increase to the limit (migration
// 0068), so lowering it, or sending it unchanged, is always accepted.
export function orderLimit(
  row: Pick<CatalogRow, "max_orderable_for_customer" | "pallets_ordered">,
): number {
  const free = Number(row.max_orderable_for_customer);
  const saved = Number(row.pallets_ordered) || 0;
  return Math.max(Number.isFinite(free) ? floorToPalletStep(Math.max(0, free)) : 0, saved);
}

// The lines a customer's draft asks more of than orderLimit allows. Checked
// before the order is sent, so the customer is told which lines to lower,
// rather than the server refusing the whole send for one of them.
export function linesOverLimit(rows: CatalogRow[], draft: Record<string, DraftLine>): CatalogRow[] {
  return rows.filter((row) => Number(draft[row.variety_id]?.pallets || 0) > orderLimit(row));
}

// The draft after the order changed on the server while this screen was
// open (the live updates refetch the catalog): every line this person has
// NOT edited takes the server's current value, and the lines they HAVE
// edited keep what they typed.
//
// It used to freeze the whole draft at the first keystroke. Because
// submit_order replaces the whole order — a line it is not sent, or is sent
// as 0, is dropped — the frozen copy then overwrote everything that changed
// meanwhile: a line the distributor added on the customer's behalf went out
// as 0 and was deleted, and their changes to other lines were reverted.
// Bubble only ever wrote the lines the customer changed. Two people
// changing the SAME line still ends with the last one sent.
export function mergeServerRows(
  draft: Record<string, DraftLine>,
  rows: CatalogRow[],
  editedIds: ReadonlySet<string>,
): Record<string, DraftLine> {
  const next = toDraft(rows);
  for (const id of editedIds) {
    const mine = draft[id];
    if (mine) next[id] = mine;
  }
  return next;
}

// The last catalog row this screen saw for every variety, kept after the
// product leaves the shop — what withVanishedTypedLines below draws a row
// from. Only ever adds or refreshes, so a product that disappeared is still
// here.
export function rememberRows(
  known: ReadonlyMap<string, CatalogRow>,
  rows: CatalogRow[],
): Map<string, CatalogRow> {
  const next = new Map(known);
  for (const row of rows) next.set(row.variety_id, row);
  return next;
}

// The rows the order editor works from: the shop's rows as fetched, plus one
// for every line this person typed a quantity into whose product has since
// left their shop. Another customer bought the rest of it, or its picking
// fell to 0, and the live update dropped it from the catalog
// (get_orderable_catalog_for_customer lists only what can still be ordered).
//
// The typed line used to vanish with it — off the screen, out of the
// confirmation and out of the send — and "ההזמנה נשלחה." then reported the
// rest of the order as sent, so the customer believed they had ordered it.
// Now it stays where it was, marked sold out with nothing left to order
// (is_orderable false, a limit of 0): on the customer's own screen the limit
// check stops the send and names it, and the customer clears the box, which
// lets the row go. On the backoffice on-behalf-of screens, which hold no
// limit, it is sent as typed and the server decides.
//
// Returns `rows` itself when nothing typed has left the shop, so a memo that
// depends on the result doesn't recompute for nothing.
export function withVanishedTypedLines(
  rows: CatalogRow[],
  draft: Record<string, DraftLine>,
  known: ReadonlyMap<string, CatalogRow>,
): CatalogRow[] {
  const inShop = new Set(rows.map((row) => row.variety_id));
  const vanished: CatalogRow[] = [];
  for (const [varietyId, line] of Object.entries(draft)) {
    if (inShop.has(varietyId) || !(Number(line.pallets || 0) > 0)) continue;
    const lastSeen = known.get(varietyId);
    if (!lastSeen) continue;
    vanished.push({
      ...lastSeen,
      is_orderable: false,
      max_orderable_for_customer: 0,
      pallets_ordered: 0,
      comment: null,
    });
  }
  return vanished.length === 0 ? rows : [...rows, ...vanished];
}

// The order comment ("הערה כללית", migration 0093) as submit_order should
// receive it. submit_order keeps the stored comment when p_comment is not
// sent at all, so a screen whose comment read never arrived sends nothing
// (undefined) rather than an empty draft that would wipe it. Once loaded, the
// draft is sent trimmed — "" included, which is how a comment is cleared.
export function orderCommentToSend(loaded: boolean, draft: string): string | undefined {
  return loaded ? draft.trim() : undefined;
}

// Whether the comment in the box differs from the stored one — part of
// "is there anything to save?". Spaces around it don't count, and an unset
// comment is the same as an empty box.
export function orderCommentChanged(saved: string | null | undefined, draft: string): boolean {
  return (saved ?? "").trim() !== draft.trim();
}

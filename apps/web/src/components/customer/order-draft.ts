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

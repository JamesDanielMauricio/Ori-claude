// The products grid's UNSAVED changes — no React, no Supabase.
//
// Nothing typed into the grid is written as it is typed, and nothing is
// written when "הצע סידור" fills it with a suggestion for the whole day. Both
// are unsaved changes: the distributor reads them in the grid, corrects what
// they disagree with, and then saves them all — or throws them away — as one
// decision. This file is the part of that which can be read and tested on its
// own: landing the changes in the cells of the day as last read, changing one
// of them, and saying which cells a refused save named.
//
// Where a suggestion COMES from is deliberately not this file's business. It
// arrives as `ProposalLine`s — whose lot, which product, which customer, how
// many pallets — and everything here treats it the same whoever produced it
// (today, arrangement-engine.ts). Saving is one database function,
// save_arrangement_changes (migration 0103): all or nothing, and refusing —
// rather than overwriting — a cell that changed since it was changed here.
import { ARRANGEMENT_ERROR_CODES } from "@ori/domain/arrangement";
import { floorToPalletStep, isPalletQuantity, roundPallets } from "@ori/shared/pallets";

import { formatVarietyName } from "@/lib/variety-label";

import {
  canArrangeFrom,
  parsePallets,
  type BoardOrder,
  type BoardPick,
  type BoardRecord,
  type BoardSubmissionTime,
} from "./board-data";
import type { ProposedAllocation } from "./matrix-data";

/**
 * One unsaved change, in the day's own terms rather than in row ids: a line
 * of a suggestion, or a number typed into the grid.
 */
export interface ProposalLine {
  growerId: string;
  varietyId: string;
  customerId: string;
  /** What the cell is to hold. 0 only together with `expected`: remove the saved allocation. */
  quantity: number;
  /**
   * Whether the line is meant to fill the customer's order — and whose number
   * it is:
   *
   *   suggested  worked out by the engine, which only ever fills an order.
   *   typed      typed by the distributor for a customer who, on the day as
   *              read at that moment, had ordered that product.
   *
   * A suggestion is held to the order each time the day is read again (see
   * resolveProposal): dropped once the order is withdrawn, and cut to what is
   * left of it once the numbers typed have taken theirs. A typed number is
   * never cut, and no read drops it: it stays for the order, and the save
   * refuses it (P0006) if the order has gone by then.
   *
   * A line without it is a push — a number typed for a customer with no order
   * for the product — and is left as typed. Saving tells the database which
   * cells were for an order (`forOrder`), so it can refuse one whose order
   * went after it was typed rather than save it as a push.
   */
  forOrder?: "suggested" | "typed";
  /**
   * The saved allocation this line was typed over, as it stood then. Absent
   * when the cell was empty then, and on every suggestion. Kept as first
   * recorded when the cell is typed again: the save refuses the cell (P0006),
   * rather than overwrite it, once it no longer holds this — somebody saved,
   * changed or cleared it in the meantime.
   */
  expected?: { recordId: string; quantity: number };
}

export interface ResolvedProposal {
  /**
   * What is still to be saved: one entry per cell. A quantity of 0 removes the
   * saved allocation; `expected` is what the cell's line was typed over — an
   * empty cell for a number typed into one, and for a suggestion.
   */
  allocations: ProposedAllocation[];
  /**
   * Suggestions left out because their cell already holds a saved allocation.
   * A number typed lands there all the same (see resolveProposal).
   */
  alreadyArranged: number;
  /**
   * Lines left out because the day has nowhere to put them: that grower has
   * no lot of that product or its pick is closed, that customer is not
   * trading, or the quantity is not a number of pallets with at most one
   * decimal place — above zero, unless the line clears a saved allocation.
   */
  unplaceable: number;
  /**
   * Suggestions dropped or cut so as not to go over what the customer has on
   * order: those for an order that has since been withdrawn, and those cut
   * because less of it is left than they proposed — reduced, arranged
   * elsewhere, or taken by numbers the distributor typed. A typed number is
   * never held to the order.
   */
  heldToOrder: number;
  /**
   * Lines left out because their cell already holds their number — a cleared
   * one, nothing: there is nothing left to save (see pruneSaved).
   */
  alreadySaved: number;
  /**
   * The cells holding a suggestion once the suggestions are held to the
   * orders, and the pallets suggested in them: what "הצע סידור" put among the
   * unsaved changes.
   */
  suggestedCells: number;
  suggestedPallets: number;
}

/** The rows of a day that unsaved changes are read against. */
export type DayRows = {
  picks: BoardPick[];
  orders: readonly BoardOrder<BoardSubmissionTime>[];
  records: readonly BoardRecord[];
};

// Same separator, for the same reason, as matrix-data.ts.
const SEP = "\u0000";

/**
 * Pallets each customer has on order of each product, keyed customer and
 * product — order lines above zero only, as the grid and the save count an
 * order. A line for no pallets (a push leaves one behind) is no order.
 */
function orderedPallets(orders: readonly BoardOrder<BoardSubmissionTime>[]): Map<string, number> {
  const ordered = new Map<string, number>();
  for (const order of orders) {
    for (const line of order.daily_order_products) {
      const pallets = parsePallets(line.pallets_ordered);
      if (!(pallets > 0)) continue;
      const key = `${order.customer_company_id}${SEP}${line.product_varieties?.id ?? line.product_variety_id}`;
      ordered.set(key, roundPallets((ordered.get(key) ?? 0) + pallets));
    }
  }
  return ordered;
}

/** The pick line of every lot a line can land on, keyed grower and product. */
function arrangeableLots(picks: readonly BoardPick[]): Map<string, string> {
  const pickLineByGrowerVariety = new Map<string, string>();
  for (const pick of picks) {
    // Not a closed pick's lot: the grid shows it read-only and the save would
    // be refused (0089), with no way to correct the cell but to throw every
    // unsaved change away. Its records still count (see resolveProposal).
    if (!canArrangeFrom(pick)) continue;
    for (const line of pick.daily_pick_products) {
      // A lot whose product did not come back has no row on the grid —
      // buildMatrix skips it — so nothing may land on it here either: it
      // would be counted, and saved, without ever having been shown.
      const variety = line.product_varieties;
      if (!variety) continue;
      pickLineByGrowerVariety.set(`${pick.grower_company_id}${SEP}${variety.id}`, line.id);
    }
  }
  return pickLineByGrowerVariety;
}

/** The customer each of the day's order lines is for. */
function orderLineOwners(orders: readonly BoardOrder<BoardSubmissionTime>[]): Map<string, string> {
  const ownerOf = new Map<string, string>();
  for (const order of orders) {
    for (const line of order.daily_order_products) ownerOf.set(line.id, order.customer_company_id);
  }
  return ownerOf;
}

/**
 * What each box holds saved, keyed pick line and customer — as the grid shows
 * it. A record is read the way buildMatrix reads it, under ONE customer: the
 * one its order line names, with the record's own copy as the fallback for a
 * line this read of the orders does not carry.
 *
 * One name, not both, because this is what a number typed into a box is
 * judged against: what it was typed over, whether the box already holds it,
 * what it gives back of the order. A record shown in another customer's box
 * is never what this one held. Should a record's two names ever differ (they
 * never do in real data), emptying the box that looks empty must not remove
 * it. A suggestion, though, stays out of a cell under either name (see
 * resolveProposal).
 */
function savedCells(
  records: readonly BoardRecord[],
  orderLineOwner: ReadonlyMap<string, string>,
): Map<string, { recordId: string; quantity: number }> {
  const saved = new Map<string, { recordId: string; quantity: number }>();
  for (const record of records) {
    const ownerId = orderLineOwner.get(record.daily_order_product_id) ?? record.customer_company_id;
    const cell = `${record.daily_pick_product_id}${SEP}${ownerId}`;
    // One record to a box in real data. Should two ever claim one, the first
    // stands: the save finds one too, and refuses a change typed over a record
    // that is not the one it finds.
    if (saved.has(cell)) continue;
    // As stored, to the database's two decimals. Never held to the tenths a
    // new quantity is: older data can hold 2.65, and the save compares what a
    // box held exactly.
    saved.set(cell, { recordId: record.id, quantity: parsePallets(record.quantity_pallets) });
  }
  return saved;
}

/**
 * Whether a cell already holds `quantity` — an empty one, 0: a line for it has
 * nothing left to save.
 */
function cellHolds(
  savedByCell: ReadonlyMap<string, { quantity: number }>,
  cell: string,
  quantity: number,
): boolean {
  return (savedByCell.get(cell)?.quantity ?? 0) === roundPallets(quantity);
}

/**
 * Lands the unsaved changes on the day as it was last read.
 *
 * A suggestion never goes into a cell that already has an allocation saved in
 * it: that number is a decision somebody made, and a suggestion has no
 * business replacing it. The same rule is what lets the screen re-resolve the
 * suggestions against every new read of the day — one drops out once its cell
 * is filled, so nothing is shown, or offered for saving, twice.
 *
 * A number the distributor typed IS such a decision, and lands whatever the
 * read says: over a saved allocation, in a cell somebody has filled since, or
 * for an order since withdrawn. No read drops it; the save judges it.
 * save_arrangement_changes (0103) refuses, rather than overwrites, a cell
 * that no longer holds what the line was typed over (`expected`), and one for
 * an order that has gone — and the screen then drops those cells' lines (see
 * dropCells).
 *
 * A line whose cell already holds its number lands nothing, and is counted as
 * already saved. That is how a saved change leaves the grid once the day is
 * read back, and what keeps a retry after a lost answer from being refused as
 * a conflict with itself (see pruneSaved).
 *
 * Supply and demand ceilings are NOT applied here. arrange_to_customer
 * enforces both (check_arrangement_allocation, as migration 0050 leaves it),
 * and a second copy of that arithmetic on the client would be a second thing
 * to keep right; a line that breaks one comes back from the save as a refusal.
 */
export function resolveProposal({
  lines,
  picks,
  orders,
  records,
}: {
  lines: ProposalLine[];
  picks: BoardPick[];
  orders: BoardOrder<BoardSubmissionTime>[];
  records: BoardRecord[];
}): ResolvedProposal {
  const pickLineByGrowerVariety = arrangeableLots(picks);

  // An order header is what arrange_to_customer requires of a customer, and
  // so what makes a cell writable for them — see matrix-data.ts's columns.
  const tradingCustomers = new Set(orders.map((order) => order.customer_company_id));

  const orderLineOwner = orderLineOwners(orders);
  // What each box holds now, as the grid shows it: what a number typed is
  // judged against (see savedCells). Built once for every line below.
  const savedByCell = savedCells(records, orderLineOwner);
  // Which cells a suggestion stays out of. A record takes its cell for the
  // customer its order line names AND for the one its own copy names, should
  // the two ever differ: that is how the save judges a cell filled
  // (save_arrangement_changes, as save_arrangement_proposal before it), and a
  // preview that judged it differently would offer, again and again, a
  // suggestion the save refuses.
  const arrangedCells = new Set<string>();

  // What each customer already has of each product, against which a
  // suggested line is held to their order.
  const varietyOfPickLine = new Map<string, string>();
  for (const pick of picks) {
    for (const line of pick.daily_pick_products) {
      if (line.product_varieties) varietyOfPickLine.set(line.id, line.product_varieties.id);
    }
  }
  const owed = orderedPallets(orders);
  // Who has an order at all for a product — what every suggestion needs.
  const hasOrder = new Set(owed.keys());
  for (const record of records) {
    const ownerId = orderLineOwner.get(record.daily_order_product_id) ?? record.customer_company_id;
    arrangedCells.add(`${record.daily_pick_product_id}${SEP}${ownerId}`);
    arrangedCells.add(`${record.daily_pick_product_id}${SEP}${record.customer_company_id}`);
    const varietyId = varietyOfPickLine.get(record.daily_pick_product_id);
    const pallets = parsePallets(record.quantity_pallets);
    if (varietyId && pallets > 0) {
      const key = `${ownerId}${SEP}${varietyId}`;
      if (owed.has(key)) owed.set(key, roundPallets((owed.get(key) ?? 0) - pallets));
    }
  }

  let alreadyArranged = 0;
  let unplaceable = 0;
  let heldToOrder = 0;
  let alreadySaved = 0;

  // Where each line lands — or why it lands nowhere.
  const landed: Array<{
    line: ProposalLine;
    pickLineId: string;
    cell: string;
    key: string;
    quantity: number;
    /** What the cell holds saved now; 0 while it is empty. */
    saved: number;
  }> = [];
  for (const line of lines) {
    const pickLineId = pickLineByGrowerVariety.get(`${line.growerId}${SEP}${line.varietyId}`);
    // 0 is a change only where it clears a saved allocation.
    const placeable =
      isPalletQuantity(line.quantity) && (line.quantity > 0 || line.expected !== undefined);
    if (!pickLineId || !tradingCustomers.has(line.customerId) || !placeable) {
      unplaceable += 1;
      continue;
    }

    const cell = `${pickLineId}${SEP}${line.customerId}`;
    const key = `${line.customerId}${SEP}${line.varietyId}`;
    if (line.forOrder === "suggested") {
      if (arrangedCells.has(cell)) {
        alreadyArranged += 1;
        continue;
      }
      if (!hasOrder.has(key)) {
        heldToOrder += 1;
        continue;
      }
    }
    // A number typed goes on to land even in a filled cell, and for an order
    // that has gone: the save, not a read, says whether it still may.

    if (cellHolds(savedByCell, cell, line.quantity)) {
      alreadySaved += 1;
      continue;
    }
    landed.push({
      line,
      pickLineId,
      cell,
      key,
      quantity: roundPallets(line.quantity),
      saved: savedByCell.get(cell)?.quantity ?? 0,
    });
  }

  // Held to the order: every number the distributor typed for the customer
  // and product is taken off it first, as typed and wherever it stands among
  // the lines — a push included, which counts against an order placed after
  // it was typed — and the suggestions get what is left, in the order they
  // came. A number typed over a saved allocation REPLACES it, and what is
  // saved is off the order already, so the number takes only what it changes
  // the cell by. Without all that, the save would carry more than the order,
  // and be refused for it until someone found the cell.
  for (const entry of landed) {
    if (entry.line.forOrder !== "suggested") {
      owed.set(
        entry.key,
        roundPallets((owed.get(entry.key) ?? 0) - (entry.quantity - entry.saved)),
      );
    }
  }
  for (const entry of landed) {
    if (entry.line.forOrder !== "suggested") continue;
    // To the tenth, as every quantity is (workbook Task 35).
    const left = Math.max(0, floorToPalletStep(owed.get(entry.key) ?? 0));
    if (left < entry.quantity) {
      heldToOrder += 1;
      entry.quantity = left;
    }
    owed.set(entry.key, roundPallets(left - entry.quantity));
  }

  // Keyed by cell so two lines for the same one become a single write. Saved
  // separately, the second would simply overwrite the first.
  const byCell = new Map<string, ProposedAllocation>();
  const suggestedCells = new Set<string>();
  let suggestedPallets = 0;
  for (const entry of landed) {
    if (entry.line.forOrder === "suggested") {
      // Cut to nothing, a suggestion is no change. A number typed as 0 is
      // one: it clears the cell.
      if (entry.quantity <= 0) continue;
      suggestedCells.add(entry.cell);
      suggestedPallets = roundPallets(suggestedPallets + entry.quantity);
    }
    const existing = byCell.get(entry.cell);
    const forOrder = entry.line.forOrder !== undefined || existing?.forOrder === true;
    byCell.set(entry.cell, {
      pickLineId: entry.pickLineId,
      customerId: entry.line.customerId,
      quantity: roundPallets((existing?.quantity ?? 0) + entry.quantity),
      // What the save is to find in the cell. Of two lines in one cell, one
      // typed over a saved allocation says what; a suggestion, or a number
      // typed into an empty cell, expects it empty.
      expected: existing?.expected.recordId
        ? existing.expected
        : (entry.line.expected ?? { recordId: null, quantity: 0 }),
      ...(forOrder ? { forOrder: true } : {}),
    });
  }

  return {
    allocations: [...byCell.values()],
    alreadyArranged,
    unplaceable,
    heldToOrder,
    alreadySaved,
    suggestedCells: suggestedCells.size,
    suggestedPallets,
  };
}

/**
 * Whose lot a pick line is, and of which product — the terms a ProposalLine
 * is written in. The way back from a cell on the grid, which is addressed by
 * pick line, to the proposal it shows.
 *
 * Null for a lot whose product did not come back with it, exactly as
 * resolveProposal lands nothing there: it has no row to have been typed into.
 * One grower has one lot of a product on a day (daily_picks is unique per day
 * and grower, daily_pick_products per pick and variety), so this and
 * resolveProposal's own lookup are each other's inverse on every pick that
 * is not closed.
 */
export function lotOfPickLine(
  picks: BoardPick[],
  pickLineId: string,
): { growerId: string; varietyId: string } | null {
  for (const pick of picks) {
    for (const line of pick.daily_pick_products) {
      if (line.id !== pickLineId) continue;
      const variety = line.product_varieties;
      return variety ? { growerId: pick.grower_company_id, varietyId: variety.id } : null;
    }
  }
  return null;
}

/**
 * A proposal with one cell set to the quantity that was typed into it.
 *
 * SET, not added: the number in the box is the whole of what that cell is to
 * hold, so every line the proposal had for the cell is replaced by one — and
 * by none when the cell was emptied, which is how a suggestion the
 * distributor disagrees with stops being part of what gets saved. A cell the
 * proposal had nothing in is added to it: while a proposal is open, a number
 * typed into an empty cell waits for the same save as the rest.
 *
 * The line keeps the place of the one it replaces. The order of the lines is
 * the order they are saved in, and which of two cells is refused when a lot
 * runs short should not depend on which of them was last corrected.
 *
 * A quantity that is not a number of pallets with at most one decimal place
 * changes nothing. The grid cannot send one (see parseMatrixQuantity); this is
 * what keeps a caller that could from writing a line resolveProposal would
 * only count as unplaceable.
 *
 * `forOrder` is whether the customer has ordered the product — the caller's
 * to say (see typeIntoProposal), and the only thing that decides it. What
 * stood in the cell before does not: a suggestion there may have gone with
 * its order, or been moved here from another grower's lot.
 */
export function setProposalCell(
  lines: ProposalLine[],
  cell: { growerId: string; varietyId: string; customerId: string },
  quantity: number,
  forOrder: boolean,
): ProposalLine[] {
  if (!isPalletQuantity(quantity)) return lines;

  const isCell = (line: ProposalLine) =>
    line.growerId === cell.growerId &&
    line.varietyId === cell.varietyId &&
    line.customerId === cell.customerId;
  const typed: ProposalLine[] =
    quantity > 0
      ? [
          {
            growerId: cell.growerId,
            varietyId: cell.varietyId,
            customerId: cell.customerId,
            quantity: roundPallets(quantity),
            ...(forOrder ? { forOrder: "typed" as const } : {}),
          },
        ]
      : [];

  const place = lines.findIndex(isCell);
  if (place === -1) return [...lines, ...typed];
  return [
    ...lines.slice(0, place),
    ...typed,
    ...lines.slice(place + 1).filter((line) => !isCell(line)),
  ];
}

/**
 * A number typed into the grid while a proposal is open: the proposal's lines
 * once it is applied, and whether it is also to be written to the database
 * now.
 *
 * A cell with nothing saved in it is the proposal's. The number is a change to
 * it — see setProposalCell — and waits for "שמור לסידור" with the rest. It is
 * for the customer's order when, on the day as read now, they have ordered
 * that product; otherwise it is a push.
 *
 * A cell with an allocation saved in it is never the proposal's, so the number
 * is written at once, as it always is. The proposal lets go of the cell too: a
 * suggestion for it sits hidden behind the record (resolveProposal lands
 * nothing on a filled cell), and emptying the cell must leave it empty rather
 * than bring that suggestion back.
 *
 * Null when the number has nowhere to go: a lot with nothing saved in it whose
 * product did not come back, which has no row to have been typed into (see
 * lotOfPickLine).
 */
export function typeIntoProposal(
  lines: ProposalLine[],
  day: { picks: BoardPick[]; orders: readonly BoardOrder<BoardSubmissionTime>[] },
  write: { pickLineId: string; customerId: string; quantity: number; recordId: string | null },
): { lines: ProposalLine[]; saveNow: boolean } | null {
  const lot = lotOfPickLine(day.picks, write.pickLineId);
  if (write.recordId) {
    return {
      lines: lot
        ? setProposalCell(lines, { ...lot, customerId: write.customerId }, 0, false)
        : lines,
      saveNow: true,
    };
  }
  if (!lot) return null;
  const forOrder = orderedPallets(day.orders).has(`${write.customerId}${SEP}${lot.varietyId}`);
  return {
    lines: setProposalCell(
      lines,
      { ...lot, customerId: write.customerId },
      write.quantity,
      forOrder,
    ),
    saveNow: false,
  };
}

/**
 * The allocation saved in a box — what a number typed into it is typed over
 * — or null while the box shows none. Found as the grid shows it (see
 * savedCells): the record on that pick line under its order line's customer,
 * or under its own copy of the customer for a line this read does not carry.
 */
export function savedAllocation(
  day: Pick<DayRows, "orders" | "records">,
  pickLineId: string,
  customerId: string,
): { recordId: string; quantity: number } | null {
  const saved = savedCells(day.records, orderLineOwners(day.orders));
  return saved.get(`${pickLineId}${SEP}${customerId}`) ?? null;
}

/**
 * The unsaved changes with one cell set to the quantity typed into it.
 *
 * SET, not added: the number in the box is the whole of what that cell is to
 * hold, so every line the changes had for the cell is replaced by one. It
 * keeps the place of the first: the order of the lines is the order they are
 * saved in, and which of two cells is refused when a lot runs short should
 * not depend on which of them was last corrected.
 *
 * The line remembers the saved allocation it was typed over (`expected`),
 * as it stood when the cell was FIRST typed over, however often it is typed
 * again — that is what the save checks is still there. `context.saved`, what
 * the cell holds on the day as read now, counts only that first time. A
 * suggestion remembers nothing (it is made for an empty cell, and left out
 * once that cell is filled), so typing over one is typing over the cell as it
 * is read now.
 *
 * Typed back to that saved number — or a cell that held nothing emptied — the
 * cell has no change left, and its lines go. Emptying a cell that holds a
 * saved allocation IS a change: a line for 0, which removes it.
 *
 * A quantity that is not a number of pallets with at most one decimal place
 * changes nothing. The grid cannot send one (see parseMatrixQuantity); this is
 * what keeps a caller that could from writing a line resolveProposal would
 * only count as unplaceable. What a cell held is not held to that rule: older
 * data can hold 2.65.
 *
 * `context.forOrder` is whether the customer has ordered the product — the
 * caller's to say (see typeIntoUnsaved), and the only thing that decides it.
 * What stood in the cell before does not: a suggestion there may have gone
 * with its order, or been moved here from another grower's lot.
 */
export function setUnsavedCell(
  lines: ProposalLine[],
  cell: { growerId: string; varietyId: string; customerId: string },
  quantity: number,
  context: { forOrder: boolean; saved: { recordId: string; quantity: number } | null },
): ProposalLine[] {
  if (!isPalletQuantity(quantity)) return lines;

  const isCell = (line: ProposalLine) =>
    line.growerId === cell.growerId &&
    line.varietyId === cell.varietyId &&
    line.customerId === cell.customerId;
  const typedBefore = lines.find((line) => isCell(line) && line.forOrder !== "suggested");
  const savedNow = context.saved && {
    recordId: context.saved.recordId,
    quantity: context.saved.quantity,
  };
  const expected = typedBefore ? typedBefore.expected : (savedNow ?? undefined);

  const pallets = roundPallets(quantity);
  if (pallets === (expected?.quantity ?? 0)) return lines.filter((line) => !isCell(line));

  const changed: ProposalLine = {
    growerId: cell.growerId,
    varietyId: cell.varietyId,
    customerId: cell.customerId,
    quantity: pallets,
    ...(context.forOrder ? { forOrder: "typed" as const } : {}),
    ...(expected ? { expected } : {}),
  };
  const place = lines.findIndex(isCell);
  if (place === -1) return [...lines, changed];
  return [
    ...lines.slice(0, place),
    changed,
    ...lines.slice(place + 1).filter((line) => !isCell(line)),
  ];
}

/**
 * A number typed into the grid: the unsaved changes with its cell set to it
 * (see setUnsavedCell). Nothing is written, whether or not the cell holds a
 * saved allocation; every change waits for the one save.
 *
 * It is for the customer's order when, on the day as read now, they have
 * ordered that product (an order line above zero); otherwise it is a push.
 * It is typed over whatever that read has saved in the cell.
 *
 * Null when the number has nowhere to go: a lot whose product did not come
 * back, which has no row to have been typed into (see lotOfPickLine).
 */
export function typeIntoUnsaved(
  lines: ProposalLine[],
  day: DayRows,
  write: { pickLineId: string; customerId: string; quantity: number },
): ProposalLine[] | null {
  const lot = lotOfPickLine(day.picks, write.pickLineId);
  if (!lot) return null;
  return setUnsavedCell(lines, { ...lot, customerId: write.customerId }, write.quantity, {
    forOrder: orderedPallets(day.orders).has(`${write.customerId}${SEP}${lot.varietyId}`),
    saved: savedAllocation(day, write.pickLineId, write.customerId),
  });
}

/**
 * The unsaved changes without a line for any of the cells named, as a refused
 * save names them (by pick line and customer). A conflict (P0006) names cells
 * that changed since they were changed here: the numbers typed in them go, so
 * they show what is saved, and the rest can be saved again.
 */
export function dropCells(
  lines: ProposalLine[],
  picks: BoardPick[],
  cells: ReadonlyArray<{ pickLineId: string; customerId: string }>,
): ProposalLine[] {
  const dropped = new Set<string>();
  for (const cell of cells) {
    const lot = lotOfPickLine(picks, cell.pickLineId);
    if (lot) dropped.add(`${lot.growerId}${SEP}${lot.varietyId}${SEP}${cell.customerId}`);
  }
  return lines.filter(
    (line) => !dropped.has(`${line.growerId}${SEP}${line.varietyId}${SEP}${line.customerId}`),
  );
}

/**
 * The unsaved changes without those whose cell already holds their number —
 * a cleared one, nothing — on the day as read after a save that failed,
 * however it failed. A change that was saved after all, its answer lost on
 * the way back, has nothing left to save, and sent again it would be refused
 * as a conflict with itself.
 *
 * Cells are found as resolveProposal finds them, so a line on a closed pick's
 * lot, which lands nowhere, stays.
 */
export function pruneSaved(lines: ProposalLine[], day: DayRows): ProposalLine[] {
  const pickLineByGrowerVariety = arrangeableLots(day.picks);
  const savedByCell = savedCells(day.records, orderLineOwners(day.orders));
  return lines.filter((line) => {
    const pickLineId = pickLineByGrowerVariety.get(`${line.growerId}${SEP}${line.varietyId}`);
    return (
      !pickLineId || !cellHolds(savedByCell, `${pickLineId}${SEP}${line.customerId}`, line.quantity)
    );
  });
}

/**
 * The cells a refused save names. save_arrangement_changes (migration 0103),
 * like save_arrangement_proposal (0068) before it, puts them in the error's
 * DETAIL, as JSON: the one change that failed, or — when cells changed since
 * they were changed here — every one of them under `cells`. Anything else
 * names no cell.
 */
export function refusedCells(
  details: string | null | undefined,
): Array<{ pickLineId: string; customerId: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(details ?? "");
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const detail = parsed as { cells?: unknown };
  const entries: unknown[] = Array.isArray(detail.cells) ? detail.cells : [parsed];
  const cells: Array<{ pickLineId: string; customerId: string }> = [];
  for (const entry of entries) {
    const cell = entry as { dailyPickProductId?: unknown; customerCompanyId?: unknown } | null;
    if (
      typeof cell?.dailyPickProductId === "string" &&
      typeof cell.customerCompanyId === "string"
    ) {
      cells.push({ pickLineId: cell.dailyPickProductId, customerId: cell.customerCompanyId });
    }
  }
  return cells;
}

/**
 * A cell in the distributor's words — "product (grower) ← customer" — for
 * saying which one a save refused. Falls back to what it was given for a lot
 * or a customer it cannot name, rather than to nothing.
 */
export function cellLabel(
  cell: { pickLineId: string; customerId: string },
  picks: readonly BoardPick[],
  names: ReadonlyMap<string, string>,
): string {
  const customer = names.get(cell.customerId) ?? cell.customerId;
  for (const pick of picks) {
    for (const line of pick.daily_pick_products) {
      if (line.id !== cell.pickLineId) continue;
      const product = line.product_varieties
        ? formatVarietyName(line.product_varieties.name, line.product_varieties.sizes)
        : line.product_variety_id;
      const grower = names.get(pick.grower_company_id) ?? pick.grower_company_id;
      return `${product} (${grower}) ← ${customer}`;
    }
  }
  return `שורה שאינה ביום זה ← ${customer}`;
}

/**
 * What the banner says when a save was refused: nothing was saved, and why —
 * naming the cells the refusal named. `reason` is the screen's own wording of
 * the error's code (new-arrangement.tsx's describeRpcError).
 *
 * A conflict (P0006) is the one refusal that mends itself. It names cells that
 * changed since they were changed here — somebody saved, changed or cleared
 * them, or the order a cell was for was withdrawn. The screen drops the
 * unsaved numbers in those cells (see dropCells), so they show what is saved,
 * and the message says the rest can simply be saved again.
 */
export function saveRefusalMessage({
  error,
  picks,
  names,
  reason,
}: {
  error: { code?: string; details?: string | null };
  picks: readonly BoardPick[];
  names: ReadonlyMap<string, string>;
  reason: string;
}): string {
  const cells = refusedCells(error.details)
    .map((cell) => cellLabel(cell, picks, names))
    .join(", ");
  if (error.code === ARRANGEMENT_ERROR_CODES.CONFLICT) {
    return cells
      ? `לא נשמר דבר: תאים אלה השתנו בינתיים — שובצו או שונו, או שההזמנה שלהם בוטלה — והמספרים שלך בהם הוסרו: ${cells}. אפשר לשמור שוב.`
      : "לא נשמר דבר: חלק מהתאים השתנו בינתיים, והמספרים שלך בהם הוסרו. אפשר לשמור שוב.";
  }
  return cells ? `לא נשמר דבר. ${cells}: ${reason}` : `לא נשמר דבר. ${reason}`;
}

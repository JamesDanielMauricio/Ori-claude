// The id a repeat import gives each Bubble record it imported before
// (workbook Task 20): the one the previous import gave it, read from
// _bubble_migration_id_map, so what points at that row from outside the
// import still finds it. Customer scores point at a company's id, and a
// product code is its variety's id, copied from the products screen into
// picking upload files. A record new in Bubble since then gets a new id.
//
// An earlier id is kept only when it is certainly that record's: written as
// Postgres writes a uuid, and held by no other record. If two records had it,
// either one could be the product a copied code meant, and giving it to the
// other would make that code name a different product without anyone
// noticing; two planned rows with one id would also stop the insert. Such a
// record gets a new id instead, and the reason comes back for the import
// report.

import { randomUUID } from "node:crypto";

// How Postgres writes a uuid as text, and the one form the products screen
// shows a product code in (apps/web/src/lib/picking-import.ts).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface IdChoice {
  id: string;
  // Why the record does not keep the id it had, for the import report. Only
  // there when it had one.
  notKept?: string;
}

// `earlier` is the previous import's id of each Bubble record, by Bubble id,
// for every table whose rows must not share an id. Returns what the import
// asks once for each row it plans.
export function keepEarlierIds(
  earlier: ReadonlyMap<string, string>,
  newId: () => string = randomUUID,
): (bubbleId: string) => IdChoice {
  const holders = new Map<string, number>();
  for (const id of earlier.values()) holders.set(id.toLowerCase(), (holders.get(id.toLowerCase()) ?? 0) + 1);
  const handedOut = new Set<string>();

  return (bubbleId) => {
    const earlierId = earlier.get(bubbleId);
    if (earlierId === undefined) return { id: newId() };
    const id = earlierId.toLowerCase();
    if (!UUID.test(id)) return { id: newId(), notKept: `its id from the previous import (${earlierId}) is not a uuid` };
    // Held by another record too, or asked for twice: one Bubble record
    // planned twice keeps it once.
    if ((holders.get(id) ?? 0) > 1 || handedOut.has(id)) {
      return { id: newId(), notKept: `its id from the previous import (${earlierId}) is shared with another record` };
    }
    handedOut.add(id);
    return { id };
  };
}

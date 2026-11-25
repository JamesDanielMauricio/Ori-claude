import { describe, expect, it } from "vitest";

import type { CatalogRow } from "./catalog-grouping";
import {
  linesOverLimit,
  mergeServerRows,
  orderCommentChanged,
  orderCommentToSend,
  orderLimit,
  rememberRows,
  savedQuantities,
  toDraft,
  toSubmittedLines,
  withVanishedTypedLines,
} from "./order-draft";

// The situation behind these tests: a customer has their order screen open
// and has started changing one line, while the distributor — ordering on
// their behalf from "בשם לקוח" or the arrangement board — changes or adds
// OTHER lines of the same order. The screen hears about it through the live
// updates (a fresh catalog), and whatever the customer then sends replaces
// the whole order (submit_order drops lines it is not sent).

const row = (varietyId: string, pallets: number, comment: string | null = null): CatalogRow => ({
  family_id: "family",
  family_name: "בננה",
  variety_id: varietyId,
  variety_name: varietyId,
  sizes: null,
  pack_type: "pallets",
  price: null,
  price_range_from: null,
  price_range_to: null,
  price_type: null,
  is_orderable: true,
  pallets_ordered: pallets,
  comment,
  image_url: null,
  variety_image_url: null,
  max_orderable_for_customer: 20,
});

describe("mergeServerRows", () => {
  const loaded = [row("X", 2), row("Y", 0), row("Z", 5)];

  it("keeps the line the customer is editing, and takes the distributor's line added meanwhile", () => {
    const draft = { ...toDraft(loaded), X: { pallets: "3", comment: "" } };
    const fresh = [row("X", 2), row("Y", 4), row("Z", 5)];
    const merged = mergeServerRows(draft, fresh, new Set(["X"]));
    expect(toSubmittedLines(fresh, merged)).toEqual([
      { productVarietyId: "X", palletsOrdered: 3, comment: null },
      { productVarietyId: "Y", palletsOrdered: 4, comment: null },
      { productVarietyId: "Z", palletsOrdered: 5, comment: null },
    ]);
  });

  it("takes a change the distributor made to a line the customer has not touched", () => {
    const draft = { ...toDraft(loaded), X: { pallets: "3", comment: "" } };
    const fresh = [row("X", 2), row("Y", 0), row("Z", 1, "דחוף")];
    const merged = mergeServerRows(draft, fresh, new Set(["X"]));
    expect(merged.Z).toEqual({ pallets: "1", comment: "דחוף" });
  });

  it("takes a product that newly appeared in the shop", () => {
    const draft = { ...toDraft(loaded), X: { pallets: "3", comment: "" } };
    const fresh = [...loaded, row("W", 6)];
    expect(mergeServerRows(draft, fresh, new Set(["X"])).W).toEqual({ pallets: "6", comment: "" });
  });

  it("keeps the customer's own edit even when the same line changed on the server", () => {
    const draft = { ...toDraft(loaded), X: { pallets: "3", comment: "" } };
    const fresh = [row("X", 7), row("Y", 0), row("Z", 5)];
    expect(mergeServerRows(draft, fresh, new Set(["X"])).X).toEqual({ pallets: "3", comment: "" });
  });

  it("with nothing edited, is simply the server's order", () => {
    const fresh = [row("X", 1), row("Y", 4), row("Z", 0)];
    expect(mergeServerRows(toDraft(loaded), fresh, new Set())).toEqual(toDraft(fresh));
  });
});

// Workbook Task 35: the customer types a quantity, in steps of 0.1, and is
// shown the most they can have on the line beside the box.
describe("orderLimit", () => {
  const limited = (max: number, saved: number): CatalogRow => ({
    ...row("X", saved),
    max_orderable_for_customer: max,
  });

  it("is what the stock still allows the customer", () => {
    expect(orderLimit(limited(2.6, 0))).toBe(2.6);
    expect(orderLimit(limited(6, 1))).toBe(6);
  });

  it("is cut down to the 0.1 steps a box can hold", () => {
    expect(orderLimit(limited(2.65, 0))).toBe(2.6);
  });

  it("never drops below what the customer already has saved", () => {
    // Stock fell to 1 after they saved 3: they may keep 3, or lower it.
    expect(orderLimit(limited(1, 3))).toBe(3);
  });

  it("is zero, not negative, when nothing is left", () => {
    expect(orderLimit(limited(-2, 0))).toBe(0);
  });
});

describe("linesOverLimit", () => {
  const rows = [
    { ...row("X", 0), max_orderable_for_customer: 2.6 },
    { ...row("Y", 3), max_orderable_for_customer: 1 },
  ];

  it("finds a line typed above its limit", () => {
    const draft = { ...toDraft(rows), X: { pallets: "2.7", comment: "" } };
    expect(linesOverLimit(rows, draft).map((r) => r.variety_id)).toEqual(["X"]);
  });

  it("lets a line sit exactly on its limit, and a saved line above the stock stay", () => {
    const draft = { ...toDraft(rows), X: { pallets: "2.6", comment: "" } };
    expect(linesOverLimit(rows, draft)).toEqual([]);
  });

  it("holds a saved line above the stock to what was saved", () => {
    const draft = { ...toDraft(rows), Y: { pallets: "3.1", comment: "" } };
    expect(linesOverLimit(rows, draft).map((r) => r.variety_id)).toEqual(["Y"]);
  });
});

// The race found in testing (2026-11-13 and again 2026-11-20): a customer
// types a quantity for a product without saving yet, another customer buys
// the rest of it, and the live update drops that product from the first
// customer's shop. The typed line used to vanish from the screen, the
// confirmation and the send, and "ההזמנה נשלחה." reported the rest as sent.
describe("withVanishedTypedLines", () => {
  const seen = [row("X", 0), row("Y", 0)];
  const known = rememberRows(new Map(), seen);
  // The shop after another customer bought the rest of X.
  const fresh = [row("Y", 0)];

  it("keeps a typed line whose product left the shop, as sold out with nothing left to order", () => {
    const draft = { ...toDraft(fresh), X: { pallets: "5", comment: "" } };
    const x = withVanishedTypedLines(fresh, draft, known).find((r) => r.variety_id === "X");
    expect(x).toMatchObject({
      variety_id: "X",
      is_orderable: false,
      max_orderable_for_customer: 0,
      pallets_ordered: 0,
    });
  });

  it("so the customer's send stops on it instead of leaving it out", () => {
    const draft = { ...toDraft(fresh), X: { pallets: "5", comment: "" } };
    const rows = withVanishedTypedLines(fresh, draft, known);
    expect(linesOverLimit(rows, draft).map((r) => r.variety_id)).toEqual(["X"]);
    expect(toSubmittedLines(rows, draft)).toContainEqual({
      productVarietyId: "X",
      palletsOrdered: 5,
      comment: null,
    });
  });

  it("lets the row go once its quantity is cleared", () => {
    for (const pallets of ["", "0"]) {
      const draft = { ...toDraft(fresh), X: { pallets, comment: "" } };
      expect(withVanishedTypedLines(fresh, draft, known).map((r) => r.variety_id)).toEqual(["Y"]);
    }
  });

  it("adds nothing for a product this screen never showed", () => {
    const draft = { ...toDraft(fresh), Q: { pallets: "2", comment: "" } };
    expect(withVanishedTypedLines(fresh, draft, known).map((r) => r.variety_id)).toEqual(["Y"]);
  });

  it("hands back the shop's own rows, untouched, when nothing typed has left it", () => {
    const draft = { ...toDraft(fresh), Y: { pallets: "1", comment: "" } };
    expect(withVanishedTypedLines(fresh, draft, known)).toBe(fresh);
  });
});

describe("rememberRows", () => {
  it("keeps the latest row seen for every variety, including ones that later left the shop", () => {
    const first = rememberRows(new Map(), [row("X", 0), row("Y", 0)]);
    const second = rememberRows(first, [row("Y", 3)]);
    expect(second.get("X")).toEqual(row("X", 0));
    expect(second.get("Y")).toEqual(row("Y", 3));
  });
});

describe("toSubmittedLines with tenths", () => {
  it("sends what was typed, a trailing point included", () => {
    const rows = [row("X", 0), row("Y", 0)];
    const draft = { X: { pallets: "0.4", comment: "" }, Y: { pallets: "2.", comment: "" } };
    expect(toSubmittedLines(rows, draft).map((l) => l.palletsOrdered)).toEqual([0.4, 2]);
  });
});

// The order comment, "הערה כללית" (migration 0093). submit_order keeps the
// stored comment when it is not sent, so a screen that never managed to load
// it must not send one — or it would send "" and wipe it.
describe("orderCommentToSend", () => {
  it("sends nothing when the stored comment never loaded", () => {
    expect(orderCommentToSend(false, "abc")).toBeUndefined();
  });

  it("sends the draft trimmed once the stored comment has loaded", () => {
    expect(orderCommentToSend(true, "  abc ")).toBe("abc");
  });

  it("sends an emptied comment as empty text, which clears it", () => {
    expect(orderCommentToSend(true, "")).toBe("");
  });
});

describe("orderCommentChanged", () => {
  it("is unchanged when nothing was stored and nothing (or only spaces) was typed", () => {
    expect(orderCommentChanged(null, "  ")).toBe(false);
  });

  it("ignores spaces around the same comment", () => {
    expect(orderCommentChanged("abc", " abc ")).toBe(false);
  });

  it("sees a cleared comment as a change", () => {
    expect(orderCommentChanged("abc", "")).toBe(true);
  });

  it("sees a comment typed before the stored one loaded as a change", () => {
    expect(orderCommentChanged(undefined, "x")).toBe(true);
  });
});

// What a send tells submit_order its screen was based on (migration 0111,
// workbook Task 09): the saved number of every product the screen shows, as
// last read from the server — never the draft. The database refuses the send
// if any of them has changed since.
describe("savedQuantities", () => {
  it("is the saved number of every product the screen shows, 0 where there is no line", () => {
    expect(savedQuantities([row("a", 2), row("b", 0), row("c", 0.4)])).toEqual({
      a: 2,
      b: 0,
      c: 0.4,
    });
  });

  it("is an empty object for a screen that shows nothing", () => {
    expect(savedQuantities([])).toEqual({});
  });
});

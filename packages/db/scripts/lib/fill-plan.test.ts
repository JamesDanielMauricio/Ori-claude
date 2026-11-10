import { describe, expect, it } from "vitest";

import type { BubbleRecord } from "./bubble-extras";
import { planFill, type FillExport, type IdMaps, type OriSnapshot } from "./fill-plan";

const ORI_STORAGE = "https://abc.supabase.co/storage/v1/object/public/product-photos/";

const noDetails = { phone: null, address_line: null, city: null, tax_id: null, accounting_id: null, contact_person_id: null };

function world(overrides: { data?: Partial<FillExport>; ids?: Partial<Record<keyof IdMaps, Array<[string, string]>>>; ori?: Partial<OriSnapshot> } = {}) {
  const data: FillExport = { company: [], productvarieties: [], productfamily: [], dailyorder: [], ...overrides.data };
  const pairs = overrides.ids ?? {};
  const ids: IdMaps = {
    company: new Map(pairs.company ?? []),
    user: new Map(pairs.user ?? []),
    productfamily: new Map(pairs.productfamily ?? []),
    productvarieties: new Map(pairs.productvarieties ?? []),
    dailyorder: new Map(pairs.dailyorder ?? []),
  };
  const ori: OriSnapshot = {
    companies: new Map(),
    varieties: new Map(),
    families: new Map(),
    orders: new Map(),
    profileIds: new Set(),
    ...overrides.ori,
  };
  return planFill(data, ids, ori);
}
const company = (fields: Record<string, unknown>): BubbleRecord => ({ _id: "bubble-c1", ...fields });

describe("planFill", () => {
  it("fills only empty company fields; a value already in Ori counts as already set", () => {
    const plan = world({
      data: { company: [company({ "Phone no.": " 050-1 ", City: "חדרה", "Tax ID": "514" })] },
      ids: { company: [["bubble-c1", "ori-c1"]] },
      ori: { companies: new Map([["ori-c1", { ...noDetails, city: "עפולה" }]]) },
    });
    expect(plan.companies).toEqual([{ id: "ori-c1", phone: "050-1", tax_id: "514" }]);
    expect(plan.report.phone).toMatchObject({ filled: 1, alreadySet: 0 });
    expect(plan.report.city).toMatchObject({ filled: 0, alreadySet: 1 });
  });

  it("a Bubble company with no Ori row counts as noOriRow, and plans nothing", () => {
    const plan = world({ data: { company: [company({ "Phone no.": "050" })] } });
    expect(plan.companies).toEqual([]);
    expect(plan.report.phone).toMatchObject({ filled: 0, noOriRow: 1 });
  });

  it("Main Contact becomes the Ori login; a contact whose login isn't in Ori is a problem, not guessed", () => {
    const ok = world({
      data: { company: [company({ "Main Contact": "bubble-u1" })] },
      ids: { company: [["bubble-c1", "ori-c1"]], user: [["bubble-u1", "ori-u1"]] },
      ori: { companies: new Map([["ori-c1", noDetails]]), profileIds: new Set(["ori-u1"]) },
    });
    expect(ok.companies).toEqual([{ id: "ori-c1", contact_person_id: "ori-u1" }]);

    const missing = world({
      data: { company: [company({ "Main Contact": "bubble-u2" })] },
      ids: { company: [["bubble-c1", "ori-c1"]], user: [["bubble-u2", "ori-u2"]] },
      ori: { companies: new Map([["ori-c1", noDetails]]), profileIds: new Set() },
    });
    expect(missing.companies).toEqual([]);
    expect(missing.report.contact_person_id.problems).toEqual([{ oriId: "ori-c1", reason: "contact login not in Ori" }]);
  });

  it("variety picture: planned when Ori has none, already set when it has one", () => {
    const plan = world({
      data: {
        productvarieties: [
          { _id: "bv1", Image: "//x.cdn.bubble.io/v1.jpg" },
          { _id: "bv2", Image: "//x.cdn.bubble.io/v2.jpg" },
        ],
      },
      ids: { productvarieties: [["bv1", "ov1"], ["bv2", "ov2"]] },
      ori: { varieties: new Map([["ov1", null], ["ov2", `${ORI_STORAGE}kept.jpg`]]) },
    });
    expect(plan.varietyPictures).toEqual([{ id: "ov1", source: "https://x.cdn.bubble.io/v1.jpg" }]);
    expect(plan.report.variety_picture).toMatchObject({ filled: 1, alreadySet: 1 });
  });

  it("family picture: a Bubble link in Ori is copied from that link; an empty one from the export; an Ori upload is left alone", () => {
    const plan = world({
      data: {
        productfamily: [
          { _id: "bf1", image: "//x.cdn.bubble.io/new-f1.jpg" },
          { _id: "bf2", image: "//x.cdn.bubble.io/f2.jpg" },
          { _id: "bf3", image: "//x.cdn.bubble.io/f3.jpg" },
        ],
      },
      ids: { productfamily: [["bf1", "of1"], ["bf2", "of2"], ["bf3", "of3"]] },
      ori: {
        families: new Map([
          ["of1", "https://x.cdn.bubble.io/old-f1.jpg"],
          ["of2", null],
          ["of3", `${ORI_STORAGE}mine.png`],
        ]),
      },
    });
    expect(plan.familyPictures).toEqual([
      { id: "of1", source: "https://x.cdn.bubble.io/old-f1.jpg", current: "https://x.cdn.bubble.io/old-f1.jpg" },
      { id: "of2", source: "https://x.cdn.bubble.io/f2.jpg", current: null },
    ]);
    expect(plan.report.family_picture).toMatchObject({ filled: 2, alreadySet: 1 });
  });

  it("order comment: filled only when Ori's is empty", () => {
    const plan = world({
      data: {
        dailyorder: [
          { _id: "bo1", comment: " לפני 6 " },
          { _id: "bo2", comment: "שער 3" },
          { _id: "bo3", comment: "" },
        ],
      },
      ids: { dailyorder: [["bo1", "oo1"], ["bo2", "oo2"], ["bo3", "oo3"]] },
      ori: { orders: new Map([["oo1", null], ["oo2", "כבר יש"], ["oo3", null]]) },
    });
    expect(plan.orderComments).toEqual([{ id: "oo1", comment: "לפני 6" }]);
    expect(plan.report.order_comment).toMatchObject({ filled: 1, alreadySet: 1 });
  });
});

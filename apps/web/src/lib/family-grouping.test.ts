import { describe, expect, it } from "vitest";

import { groupLinesByFamily, type FamilyGroupableLine } from "./family-grouping";

type Line = FamilyGroupableLine & { pallets: number };

function line(
  id: string,
  name: string,
  familyId: string,
  familyName: string,
  pallets: number,
  extra: { sizes?: string | null; comment?: string | null } = {},
): Line {
  return {
    id,
    pallets,
    comment: extra.comment ?? null,
    product_varieties: {
      name,
      sizes: extra.sizes ?? null,
      family_id: familyId,
      product_families: { name: familyName, image_url: null },
    },
  };
}

const quantity = (row: Line) => row.pallets;

// The read view behind both oversight screens' expand chevrons — one function,
// so "בשם מגדל" and "בשם לקוח" list a family's lines in the same order with
// the same labels.
describe("groupLinesByFamily", () => {
  it("groups by family and sorts families and lines by their Hebrew names", () => {
    const families = groupLinesByFamily(
      [
        line("1", "שרי", "f-tomato", "עגבניה", 2),
        line("2", "חסה רומית", "f-lettuce", "חסה", 1),
        line("3", "אשכולות", "f-tomato", "עגבניה", 0),
      ],
      quantity,
    );
    expect(families.map((family) => family.familyName)).toEqual(["חסה", "עגבניה"]);
    expect(families[1]!.lines.map((row) => row.varietyName)).toEqual(["אשכולות", "שרי"]);
  });

  it("takes the quantity from the caller and marks the lines that have one", () => {
    const [family] = groupLinesByFamily(
      [line("1", "שרי", "f", "עגבניה", 5.5), line("2", "תמר", "f", "עגבניה", 0)],
      (row) => row.pallets * 2,
    );
    expect(family!.lines).toEqual([
      { id: "1", varietyName: "שרי", quantityLabel: "11", hasQuantity: true, comment: null },
      { id: "2", varietyName: "תמר", quantityLabel: "0", hasQuantity: false, comment: null },
    ]);
  });

  it("labels a variety with its size and keeps the line's comment", () => {
    const [family] = groupLinesByFamily(
      [line("1", "שרי", "f", "עגבניה", 1, { sizes: "5", comment: "בדחיפות" })],
      quantity,
    );
    expect(family!.lines[0]).toMatchObject({ varietyName: "שרי 5", comment: "בדחיפות" });
  });

  it("skips a line whose variety did not come back", () => {
    const orphan: Line = { id: "x", pallets: 3, comment: null, product_varieties: null };
    expect(groupLinesByFamily([orphan], quantity)).toEqual([]);
  });
});

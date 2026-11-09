import { describe, expect, it } from "vitest";

import { catalogOptionLabel } from "./use-catalog-options";

describe("catalogOptionLabel", () => {
  it("leads with the family, then the name and size", () => {
    expect(
      catalogOptionLabel({
        id: "v1",
        name: "גאלה",
        sizes: "5",
        product_families: { name: "תפוח" },
      }),
    ).toBe("תפוח — גאלה 5");
  });

  it("leaves out a blank size", () => {
    expect(
      catalogOptionLabel({
        id: "v1",
        name: "גאלה",
        sizes: null,
        product_families: { name: "תפוח" },
      }),
    ).toBe("תפוח — גאלה");
  });

  it("is the variety alone when it has no family", () => {
    expect(catalogOptionLabel({ id: "v1", name: "גאלה", sizes: "5", product_families: null })).toBe(
      "גאלה 5",
    );
  });
});

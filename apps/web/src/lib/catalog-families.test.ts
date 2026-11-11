import { describe, expect, it } from "vitest";

import {
  NO_FAMILY_KEY,
  NO_FAMILY_NAME,
  familiesHoldingSelection,
  familySelectionCounts,
  filterCatalogFamilies,
  groupCatalogByFamily,
  type CatalogFamilyGroup,
} from "./catalog-families";
import type { CatalogVariety } from "./queries/reference-data";

function variety(
  id: string,
  name: string,
  family: { id: string; name: string } | null,
  sizes: string | null = null,
): CatalogVariety {
  return {
    id,
    family_id: family?.id ?? "",
    name,
    sizes,
    product_families: family ? { name: family.name } : null,
  };
}

const APPLE = { id: "f-apple", name: "תפוח" };
const PEAR = { id: "f-pear", name: "אגס" };
const KIWI = { id: "f-kiwi", name: "Kiwi" };
const GRAPE = { id: "f-grape", name: "ענב" };

// The catalog as productCatalog() returns it: ordered by variety name, so
// families come interleaved.
const CATALOG: CatalogVariety[] = [
  variety("v-gala", "גאלה", APPLE, "5"),
  variety("v-hayward", "הייוורד", KIWI),
  variety("v-coscia", "קושיה", PEAR),
  variety("v-pink", "Pink Lady", APPLE),
  variety("v-grand", "גרנד", APPLE),
  variety("v-muscat", "מוסקט", GRAPE),
  variety("v-spadona", "ספדונה", PEAR),
];

const names = (families: readonly CatalogFamilyGroup[]) => families.map((family) => family.name);
const labels = (family: CatalogFamilyGroup | undefined) =>
  family?.products.map((product) => product.label);

describe("groupCatalogByFamily", () => {
  it("lists the families by name in Hebrew order, Hebrew before Latin", () => {
    // Code-point or English order would put "Kiwi" first.
    expect(names(groupCatalogByFamily(CATALOG))).toEqual(["אגס", "ענב", "תפוח", "Kiwi"]);
  });

  it("lists each family's varieties by their own label in Hebrew order, with no family prefix", () => {
    const apple = groupCatalogByFamily(CATALOG).find((family) => family.key === APPLE.id);
    expect(labels(apple)).toEqual(["גאלה 5", "גרנד", "Pink Lady"]);
    expect(apple?.products.map((product) => product.id)).toEqual(["v-gala", "v-grand", "v-pink"]);
  });

  it("orders same-labelled varieties by id, whatever order they came back in", () => {
    const families = groupCatalogByFamily([
      variety("v2", "שרי", APPLE, "5"),
      variety("v1", "שרי", APPLE, "5"),
    ]);
    expect(families[0]?.products.map((product) => product.id)).toEqual(["v1", "v2"]);
  });

  it("keeps two families that share a name apart, in a stable order", () => {
    const first = { id: "f-a", name: "עגבניה" };
    const second = { id: "f-b", name: "עגבניה" };
    const families = groupCatalogByFamily([
      variety("v1", "שרי", second),
      variety("v2", "תמר", first),
    ]);
    expect(families.map((family) => [family.key, labels(family)])).toEqual([
      ["f-a", ["תמר"]],
      ["f-b", ["שרי"]],
    ]);
  });

  it("puts varieties whose family is missing in a last group, labelled ללא משפחה", () => {
    const families = groupCatalogByFamily([
      // No embedded family (as a read the family row was hidden from would be).
      variety("v1", "שרי", null),
      { ...variety("v2", "אשכולות", APPLE), product_families: null },
      // No family id at all.
      { ...variety("v3", "בלאדי", APPLE), family_id: null } as unknown as CatalogVariety,
      variety("v4", "גאלה", APPLE),
      variety("v5", "סנטה רוזה", { id: "f-plum", name: "שזיף" }),
    ]);
    // Last, though by name ל would come before both ש and ת.
    expect(names(families)).toEqual(["שזיף", "תפוח", NO_FAMILY_NAME]);
    expect(families.at(-1)).toMatchObject({ key: NO_FAMILY_KEY, name: "ללא משפחה" });
    expect(labels(families.at(-1))).toEqual(["אשכולות", "בלאדי", "שרי"]);
  });

  it("survives a variety with no name rather than throwing while a screen renders", () => {
    const nameless = { ...variety("v0", "", APPLE), name: null } as unknown as CatalogVariety;
    const families = groupCatalogByFamily([variety("v1", "גאלה", APPLE), nameless]);
    expect(labels(families[0])).toEqual(["", "גאלה"]);
    expect(names(filterCatalogFamilies(families, "גא"))).toEqual(["תפוח"]);
  });

  it("is empty for an empty catalog", () => {
    expect(groupCatalogByFamily([])).toEqual([]);
  });
});

describe("filterCatalogFamilies", () => {
  const families = groupCatalogByFamily(CATALOG);

  it("returns the same list for an empty or blank search", () => {
    expect(filterCatalogFamilies(families, "")).toBe(families);
    expect(filterCatalogFamilies(families, "   ")).toBe(families);
  });

  it("keeps every variety of a family whose own name matches", () => {
    const shown = filterCatalogFamilies(families, "תפו");
    expect(names(shown)).toEqual(["תפוח"]);
    expect(labels(shown[0])).toEqual(["גאלה 5", "גרנד", "Pink Lady"]);
  });

  it("otherwise keeps only the matching varieties, and drops families left with none", () => {
    const shown = filterCatalogFamilies(families, "ג");
    // אגס holds no ג variety but its own name has one; ענב has neither.
    expect(names(shown)).toEqual(["אגס", "תפוח"]);
    expect(labels(shown[0])).toEqual(["ספדונה", "קושיה"]);
    expect(labels(shown[1])).toEqual(["גאלה 5", "גרנד"]);
  });

  it("matches a variety's size as part of its label", () => {
    expect(filterCatalogFamilies(families, "לה 5").map(labels)).toEqual([["גאלה 5"]]);
  });

  it("ignores case and surrounding space", () => {
    const shown = filterCatalogFamilies(families, "  pINK ");
    expect(names(shown)).toEqual(["תפוח"]);
    expect(labels(shown[0])).toEqual(["Pink Lady"]);
    expect(names(filterCatalogFamilies(families, " KIWI"))).toEqual(["Kiwi"]);
  });

  it("is empty when nothing matches", () => {
    expect(filterCatalogFamilies(families, "אבוקדו")).toEqual([]);
  });

  it("leaves the list it was given untouched", () => {
    filterCatalogFamilies(families, "ג");
    expect(labels(families.find((family) => family.key === APPLE.id))).toEqual([
      "גאלה 5",
      "גרנד",
      "Pink Lady",
    ]);
  });
});

describe("familiesHoldingSelection", () => {
  it("is the families with at least one selected variety", () => {
    const families = groupCatalogByFamily(CATALOG);
    expect(
      familiesHoldingSelection(
        families,
        new Set(["v-grand", "v-pink", "v-muscat", "not-in-catalog"]),
      ),
    ).toEqual(new Set([APPLE.id, GRAPE.id]));
    expect(familiesHoldingSelection(families, new Set())).toEqual(new Set());
  });
});

describe("familySelectionCounts", () => {
  it("counts selected and total varieties over each whole family", () => {
    const counts = familySelectionCounts(
      groupCatalogByFamily(CATALOG),
      new Set(["v-grand", "v-pink"]),
    );
    expect(counts.get(APPLE.id)).toEqual({ selected: 2, total: 3 });
    expect(counts.get(PEAR.id)).toEqual({ selected: 0, total: 2 });
    expect(counts.get(KIWI.id)).toEqual({ selected: 0, total: 1 });
  });
});

import type { CatalogVariety } from "@/lib/queries/reference-data";
import { formatVarietyName } from "@/lib/variety-label";

// The product catalog the way the family-grouped picker lists it
// (ProductFamilyPicker: a grower's in-season products, a user's blocked
// products, "בשם מגדל"'s products dialog). Pure, so the order, the labels and
// what a search leaves standing are tested without rendering anything, and
// derived once per read of the catalog (useCatalogOptions), not per render.

export interface CatalogFamilyProduct {
  id: string;
  // The variety and its size alone. The chips' label (catalogOptionLabel)
  // leads with the family; here the family's header is right above the row,
  // so repeating it on every row would only push the variety's own name out
  // of a narrow panel.
  label: string;
}

export interface CatalogFamilyGroup {
  // The family's id, or NO_FAMILY_KEY. By id rather than by name, so two
  // families that happen to share a name stay two families.
  key: string;
  name: string;
  products: CatalogFamilyProduct[];
}

// Where a variety goes when its family did not come back with it. The
// database can't produce one today: product_varieties.family_id is a NOT NULL
// foreign key (migration 0005) and every signed-in user may read
// product_families (0006). But a variety listed under this header still gets
// picked, where one missing from the list, or a list that fails to draw,
// would not.
export const NO_FAMILY_KEY = "__no_family__";
export const NO_FAMILY_NAME = "ללא משפחה";

function familyOf(variety: CatalogVariety): { key: string; name: string } {
  const family = variety.product_families;
  if (variety.family_id && family && typeof family.name === "string") {
    return { key: variety.family_id, name: family.name };
  }
  return { key: NO_FAMILY_KEY, name: NO_FAMILY_NAME };
}

// Only for ties, so the order never depends on the order rows came back in.
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Families by name and each family's varieties by their own label, both in
// Hebrew order; the varieties with no family come last, whatever their
// header would sort as.
export function groupCatalogByFamily(catalog: readonly CatalogVariety[]): CatalogFamilyGroup[] {
  const byKey = new Map<string, CatalogFamilyGroup>();
  for (const variety of catalog) {
    const { key, name } = familyOf(variety);
    let group = byKey.get(key);
    if (!group) {
      group = { key, name, products: [] };
      byKey.set(key, group);
    }
    group.products.push({
      id: variety.id,
      // `?? ""` though the column is NOT NULL: this runs while the three
      // screens render, even with no picker open, and they have no error
      // boundary. One malformed row must not take a whole screen down when
      // the labels are sorted below.
      label: formatVarietyName(variety.name ?? "", variety.sizes),
    });
  }

  const groups = [...byKey.values()];
  for (const group of groups) {
    group.products.sort((a, b) => a.label.localeCompare(b.label, "he") || compareIds(a.id, b.id));
  }
  const named = groups
    .filter((group) => group.key !== NO_FAMILY_KEY)
    .sort((a, b) => a.name.localeCompare(b.name, "he") || compareIds(a.key, b.key));
  const unnamed = byKey.get(NO_FAMILY_KEY);
  return unnamed ? [...named, unnamed] : named;
}

// What the search box compares, as every other search in the app does it:
// trimmed, and lower-cased for the odd Latin letter in a name.
export function catalogSearchNeedle(query: string): string {
  return query.trim().toLocaleLowerCase("he");
}

// Searching a tree, as the Products screen's table does: a family whose own
// name matches keeps every one of its varieties, because the user asked for
// the family. Any other family keeps only the varieties that match, and one
// left with none is dropped. A blank search returns the list it was given.
export function filterCatalogFamilies(
  families: readonly CatalogFamilyGroup[],
  query: string,
): readonly CatalogFamilyGroup[] {
  const needle = catalogSearchNeedle(query);
  if (needle === "") return families;
  const shown: CatalogFamilyGroup[] = [];
  for (const family of families) {
    if (family.name.toLocaleLowerCase("he").includes(needle)) {
      shown.push(family);
      continue;
    }
    const products = family.products.filter((product) =>
      product.label.toLocaleLowerCase("he").includes(needle),
    );
    if (products.length > 0) shown.push({ ...family, products });
  }
  return shown;
}

// The families holding at least one of the selected varieties — the ones the
// picker opens on.
export function familiesHoldingSelection(
  families: readonly CatalogFamilyGroup[],
  selectedIds: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const family of families) {
    if (family.products.some((product) => selectedIds.has(product.id))) keys.add(family.key);
  }
  return keys;
}

// Each family's selected and total varieties, over the WHOLE family. Taken
// before the search box has its say, as the Products screen's header count
// is: a header reading "2 נבחרו" must still say so while a search hides the
// two rows that were ticked.
export function familySelectionCounts(
  families: readonly CatalogFamilyGroup[],
  selectedIds: ReadonlySet<string>,
): Map<string, { selected: number; total: number }> {
  const counts = new Map<string, { selected: number; total: number }>();
  for (const family of families) {
    let selected = 0;
    for (const product of family.products) {
      if (selectedIds.has(product.id)) selected += 1;
    }
    counts.set(family.key, { selected, total: family.products.length });
  }
  return counts;
}

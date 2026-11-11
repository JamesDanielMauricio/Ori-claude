import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { groupCatalogByFamily } from "@/lib/catalog-families";
import { referenceDataQueries, type CatalogVariety } from "@/lib/queries/reference-data";
import { formatVarietyName } from "@/lib/variety-label";

// How a catalog variety reads in every chip: family first, so same-named
// varieties of different families stay apart. The picker itself lists them
// under a family header instead, so its rows leave the family off
// (lib/catalog-families.ts).
export function catalogOptionLabel(product: CatalogVariety): string {
  const name = formatVarietyName(product.name, product.sizes);
  return product.product_families?.name ? `${product.product_families.name} — ${name}` : name;
}

// The whole catalog for the product pickers and their chips — the Growers
// screen's in-season list, the Users screen's blocked products and "בשם
// מגדל"'s products dialog. One derivation over the one cache entry
// (referenceDataQueries.productCatalog), so the three can't label or group a
// variety differently: `families` for the picker (ProductFamilyPicker), and
// `labelById` for the read-only chips.
export function useCatalogOptions() {
  const catalogQuery = useQuery(referenceDataQueries.productCatalog());

  // Grouped and sorted once per read of the catalog, not on every render: the
  // screens holding a picker re-render on every tick and keystroke.
  const families = useMemo(
    () => groupCatalogByFamily(catalogQuery.data ?? []),
    [catalogQuery.data],
  );

  const labelById = useMemo(
    () =>
      new Map(
        (catalogQuery.data ?? []).map((product) => [product.id, catalogOptionLabel(product)]),
      ),
    [catalogQuery.data],
  );

  return { catalogQuery, families, labelById };
}

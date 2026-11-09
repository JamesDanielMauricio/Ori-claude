import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { referenceDataQueries, type CatalogVariety } from "@/lib/queries/reference-data";
import { formatVarietyName } from "@/lib/variety-label";

// How a catalog variety reads in every pick-list and chip: family first, so
// same-named varieties of different families stay apart.
export function catalogOptionLabel(product: CatalogVariety): string {
  const name = formatVarietyName(product.name, product.sizes);
  return product.product_families?.name ? `${product.product_families.name} — ${name}` : name;
}

// The whole catalog as picker options — the Growers screen's in-season list,
// the Users screen's blocked products and "בשם מגדל"'s products dialog. One
// derivation over the one cache entry (referenceDataQueries.productCatalog),
// so the three can't label a variety differently.
export function useCatalogOptions() {
  const catalogQuery = useQuery(referenceDataQueries.productCatalog());

  const options = useMemo(
    () =>
      (catalogQuery.data ?? []).map((product) => ({
        id: product.id,
        label: catalogOptionLabel(product),
      })),
    [catalogQuery.data],
  );

  const labelById = useMemo(
    () => new Map(options.map((option) => [option.id, option.label])),
    [options],
  );

  return { catalogQuery, options, labelById };
}

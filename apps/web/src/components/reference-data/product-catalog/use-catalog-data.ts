import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { referenceDataQueries } from "@/lib/queries/reference-data";

// Everything the Products screen reads: families and varieties — plus the
// family lookup. Both definitions live in lib/queries/reference-data.
export function useCatalogData() {
  const familiesQuery = useQuery(referenceDataQueries.productFamilies());
  const familyById = useMemo(
    () => new Map((familiesQuery.data ?? []).map((family) => [family.id, family])),
    [familiesQuery.data],
  );

  // Without families embedded: each family's name, category and photo come
  // from familiesQuery via `familyById` (see referenceDataQueries.products).
  const productsQuery = useQuery(referenceDataQueries.products());

  return { familiesQuery, familyById, productsQuery };
}

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { referenceDataQueries, type CatalogVariety } from "./queries/reference-data";
import { catalogOptionLabel, useCatalogOptions } from "./use-catalog-options";

// The catalog read, faked at the client: records the columns asked for.
const fake = vi.hoisted(() => ({ selects: [] as string[], rows: [] as unknown[] }));
vi.mock("./supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const query = {
        select: (columns: string) => {
          fake.selects.push(columns);
          return query;
        },
        order: () => query,
        range: async () => ({ data: fake.rows, error: null }),
      };
      return query;
    },
  }),
}));

const CATALOG: CatalogVariety[] = [
  {
    id: "v-gala",
    family_id: "f-apple",
    name: "גאלה",
    sizes: "5",
    product_families: { name: "תפוח" },
  },
  {
    id: "v-coscia",
    family_id: "f-pear",
    name: "קושיה",
    sizes: null,
    product_families: { name: "אגס" },
  },
  {
    id: "v-grand",
    family_id: "f-apple",
    name: "גרנד",
    sizes: null,
    product_families: { name: "תפוח" },
  },
];

describe("catalogOptionLabel", () => {
  it("leads with the family, then the name and size", () => {
    expect(
      catalogOptionLabel({
        id: "v1",
        family_id: "f1",
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
        family_id: "f1",
        name: "גאלה",
        sizes: null,
        product_families: { name: "תפוח" },
      }),
    ).toBe("תפוח — גאלה");
  });

  it("is the variety alone when it has no family", () => {
    expect(
      catalogOptionLabel({
        id: "v1",
        family_id: "f1",
        name: "גאלה",
        sizes: "5",
        product_families: null,
      }),
    ).toBe("גאלה 5");
  });
});

describe("referenceDataQueries.productCatalog", () => {
  it("reads each variety's family id, which the pickers group by", async () => {
    fake.selects.length = 0;
    fake.rows = CATALOG;
    const read = referenceDataQueries.productCatalog().queryFn as () => Promise<CatalogVariety[]>;
    expect(await read()).toEqual(CATALOG);
    expect(fake.selects).toHaveLength(1);
    expect(fake.selects[0]!.split(",").map((column) => column.trim())).toEqual(
      expect.arrayContaining(["id", "family_id", "name", "sizes", "product_families(name)"]),
    );
  });
});

describe("useCatalogOptions", () => {
  it("groups the cached catalog for the pickers, and keeps the chips' labels family-first", () => {
    const client = new QueryClient();
    client.setQueryData(referenceDataQueries.productCatalog().queryKey, CATALOG);
    let seen: ReturnType<typeof useCatalogOptions> | undefined;
    function Probe() {
      seen = useCatalogOptions();
      return null;
    }
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
    expect(
      seen?.families.map((family) => [
        family.name,
        family.products.map((product) => product.label),
      ]),
    ).toEqual([
      ["אגס", ["קושיה"]],
      ["תפוח", ["גאלה 5", "גרנד"]],
    ]);
    expect(seen?.labelById.get("v-gala")).toBe("תפוח — גאלה 5");
    expect(seen?.labelById.get("v-coscia")).toBe("אגס — קושיה");
  });

  it("has no families before the catalog has arrived", () => {
    let seen: ReturnType<typeof useCatalogOptions> | undefined;
    function Probe() {
      seen = useCatalogOptions();
      return null;
    }
    renderToStaticMarkup(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)),
    );
    expect(seen?.families).toEqual([]);
    expect(seen?.labelById.size).toBe(0);
  });
});

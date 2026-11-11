import { describe, expect, it, vi } from "vitest";

// get_pick_lines (migration 0086), as the database answers it.
const database = vi.hoisted(() => ({ calls: [] as unknown[][], rows: [] as unknown[] }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async (name: string, args: unknown) => {
      database.calls.push([name, args]);
      return { data: database.rows, error: null };
    },
  }),
}));

const { fetchPickLines } = await import("./grower");

describe("fetchPickLines", () => {
  it("keeps each line's variety id, which the picking upload matches a file's product codes against", async () => {
    database.rows = [
      {
        id: "line-1",
        pallets_picked: 3,
        leftover_pallets: 1,
        comment: "בדיקה",
        product_variety_id: "6f1c2b9e-3d4a-4e8b-9a71-0c5d2e8f4b13",
        variety_name: "רד-דיימונד",
        variety_sizes: "גדול",
        family_id: "family-1",
        family_name: "תפוח",
        family_image_url: null,
      },
    ];
    expect(await fetchPickLines("pick-1")).toEqual([
      {
        id: "line-1",
        pallets_picked: 3,
        leftover_pallets: 1,
        comment: "בדיקה",
        product_variety_id: "6f1c2b9e-3d4a-4e8b-9a71-0c5d2e8f4b13",
        product_varieties: {
          name: "רד-דיימונד",
          sizes: "גדול",
          family_id: "family-1",
          product_families: { name: "תפוח", image_url: null },
        },
      },
    ]);
    expect(database.calls).toEqual([["get_pick_lines", { p_daily_pick_id: "pick-1" }]]);
  });
});

import { roundPallets } from "@ori/shared/pallets";
import { queryOptions } from "@tanstack/react-query";

import { fetchAllRows } from "@/lib/fetch-all-rows";
import { createClient } from "@/lib/supabase/client";

// Server reads behind the two "on behalf of" oversight screens —
// /backoffice/distributor-grower ("בשם מגדל") and
// /backoffice/distributor-customer ("בשם לקוח") — each defined once, key +
// fetch together; see lib/queries/trading-day.ts for why the keys matter.

export const growerOversightKeys = {
  // Every read below keyed under "grower-oversight" — what a grower save made
  // elsewhere (the Growers screen) invalidates, so this screen re-reads it.
  all: ["grower-oversight"] as const,
  growerProductsAll: ["grower-oversight", "grower-products"] as const,
};

// ---------------------------------------------------------------- growers

export interface OversightGrower {
  id: string;
  name: string;
  status: "active" | "inactive";
  default_pickup_time: string | null;
  whatsapp_group_id: string | null;
  transporter_company_id: string | null;
  // Not shown on this screen — loaded only so the products dialog can send it
  // back unchanged (see lib/grower-products-save-input.ts).
  contact_person_id: string | null;
}

export interface PickLineRow {
  id: string;
  pallets_picked: number;
  leftover_pallets: number;
  comment: string | null;
  product_varieties: {
    id: string;
    name: string;
    sizes: string | null;
    family_id: string;
    product_families: { id: string; name: string; image_url: string | null } | null;
  } | null;
}

export interface DailyPickForDay {
  id: string;
  grower_company_id: string;
  status: "draft" | "submitted" | "closed";
  submitted_at: string | null;
  pickup_time: string | null;
  reminder_sent_at: string | null;
  daily_pick_products: PickLineRow[];
}

// ---------------------------------------------------------------- customers

export interface OversightCustomer {
  id: string;
  name: string;
  status: "active" | "inactive";
}

export interface OrderLineRow {
  id: string;
  pallets_ordered: number;
  comment: string | null;
  product_varieties: {
    id: string;
    name: string;
    sizes: string | null;
    family_id: string;
    product_families: { id: string; name: string; image_url: string | null } | null;
  } | null;
}

export interface DailyOrderForDay {
  id: string;
  customer_company_id: string;
  status: "open" | "submitted";
  submitted_at: string | null;
  reminder_sent_at: string | null;
  // הערה כללית — the comment on the whole order (migration 0093).
  comment: string | null;
  daily_order_products: OrderLineRow[];
}

// ------------------------------------------------------- arranged supply

// How many pallets of each of one pick's lines are already arranged to
// customers — arrangement_records' quantity_pallets summed per pick line,
// keyed by the line's id (a line with nothing arranged is absent). The
// "בשם מגדל" picking upload checks a file against it before anything is
// saved: save_pick_lines refuses a line whose picked + leftover would drop
// below this (P0006, migration 0076), but only for the whole save and without
// saying which line, so the preview names the row first. The server's check
// stays the authority.
//
// Read fresh every time, never cached: it is asked at the moment a file is
// read and again at the moment it is saved. Filtered through the pick line's
// own pick (an inner join), so the request stays short however many lines the
// pick has, and paged, because one record per (line, customer) can pass
// Supabase's 1,000-row cap for a grower supplying many customers.
export async function fetchArrangedPalletsByLine(dailyPickId: string): Promise<Map<string, number>> {
  const rows = await fetchAllRows<{ daily_pick_product_id: string; quantity_pallets: number }>(
    (from, to) =>
      createClient()
        .from("arrangement_records")
        .select("id, daily_pick_product_id, quantity_pallets, daily_pick_products!inner(daily_pick_id)")
        .eq("daily_pick_products.daily_pick_id", dailyPickId)
        .order("id")
        .range(from, to),
  );
  const arranged = new Map<string, number>();
  for (const row of rows) {
    const sum = (arranged.get(row.daily_pick_product_id) ?? 0) + (Number(row.quantity_pallets) || 0);
    arranged.set(row.daily_pick_product_id, roundPallets(sum));
  }
  return arranged;
}

export const oversightQueries = {
  // Active growers, one row each on the "בשם מגדל" screen.
  activeGrowers() {
    return queryOptions({
      queryKey: ["grower-oversight", "growers"],
      queryFn: async (): Promise<OversightGrower[]> => {
        const { data, error } = await createClient()
          .from("companies")
          .select(
            "id, name, status, default_pickup_time, whatsapp_group_id, transporter_company_id, contact_person_id",
          )
          .eq("type", "grower")
          .eq("status", "active")
          .order("name");
        if (error) throw error;
        return data;
      },
    });
  },

  // Picks AND their lines in one request — embedding daily_pick_products
  // rather than a second query per expanded row, so opening a tenth grower's
  // chevron costs nothing this screen hasn't already paid for the first.
  picksForDay(dayId: string | undefined) {
    return queryOptions({
      queryKey: ["grower-oversight", "picks-for-day", dayId],
      enabled: !!dayId,
      queryFn: async (): Promise<DailyPickForDay[]> => {
        const { data, error } = await createClient()
          .from("daily_picks")
          .select(
            `id, grower_company_id, status, submitted_at, pickup_time, reminder_sent_at,
           daily_pick_products(id, pallets_picked, leftover_pallets, comment, product_varieties(id, name, sizes, family_id, product_families(id, name, image_url)))`,
          )
          .eq("trading_day_id", dayId!);
        if (error) throw error;
        return data;
      },
    });
  },

  // Which growers have an in-season list at all — see
  // routes/backoffice/distributor-grower.tsx for why "no pick yet" needs
  // this to be told apart from "nothing in season".
  //
  // Paged (fetchAllRows) because grower_products is the table that outgrows
  // PostgREST's 1000-row cap, which truncates silently: past it, the growers
  // whose rows fell off the end would read as "no products in season".
  growersWithProducts() {
    return queryOptions({
      queryKey: ["grower-oversight", "growers-with-products"],
      queryFn: async () => {
        const rows = await fetchAllRows<{ company_id: string }>((from, to) =>
          createClient()
            .from("grower_products")
            .select("company_id")
            .order("company_id")
            .order("product_variety_id")
            .range(from, to),
        );
        return new Set(rows.map((row) => row.company_id));
      },
    });
  },

  // One grower's in-season list, for the products dialog opened on them —
  // with the grower's own row read in the same go. save_grower rewrites the
  // whole company row as well as the whole list, so the dialog sends back
  // what THIS read returned, not the screen's list row: that one can predate
  // an edit made on the Growers screen, and writing it back would undo it.
  //
  // staleTime 0, so every opening re-reads both rather than seeding from a
  // cached copy (the dialog waits for the read; see distributor-grower.tsx).
  // Paged like growersWithProducts(): a list cut short at PostgREST's row
  // cap would be saved back short.
  growerProducts(growerId: string | null) {
    return queryOptions({
      queryKey: ["grower-oversight", "grower-products", growerId],
      enabled: !!growerId,
      staleTime: 0,
      queryFn: async (): Promise<{ grower: OversightGrower; productVarietyIds: string[] }> => {
        const supabase = createClient();
        const [growerResult, rows] = await Promise.all([
          supabase
            .from("companies")
            .select(
              "id, name, status, default_pickup_time, whatsapp_group_id, transporter_company_id, contact_person_id",
            )
            .eq("id", growerId!)
            .eq("type", "grower")
            .single(),
          fetchAllRows<{ product_variety_id: string }>((from, to) =>
            supabase
              .from("grower_products")
              .select("product_variety_id")
              .eq("company_id", growerId!)
              .order("product_variety_id")
              .range(from, to),
          ),
        ]);
        if (growerResult.error) throw growerResult.error;
        return {
          grower: growerResult.data,
          productVarietyIds: rows.map((row) => row.product_variety_id),
        };
      },
    });
  },

  // Active customers, one row each on the "בשם לקוח" screen.
  activeCustomers() {
    return queryOptions({
      queryKey: ["customer-oversight", "customers"],
      queryFn: async (): Promise<OversightCustomer[]> => {
        const { data, error } = await createClient()
          .from("companies")
          .select("id, name, status")
          .eq("type", "customer")
          .eq("status", "active")
          .order("name");
        if (error) throw error;
        return data;
      },
    });
  },

  // Orders AND their lines in one request — same reasoning as picksForDay():
  // embedding daily_order_products is what makes expanding any row free.
  ordersForDay(dayId: string | undefined) {
    return queryOptions({
      queryKey: ["customer-oversight", "orders-for-day", dayId],
      enabled: !!dayId,
      queryFn: async (): Promise<DailyOrderForDay[]> => {
        const { data, error } = await createClient()
          .from("daily_orders")
          .select(
            `id, customer_company_id, status, submitted_at, reminder_sent_at, comment,
           daily_order_products(id, pallets_ordered, comment, product_varieties(id, name, sizes, family_id, product_families(id, name, image_url)))`,
          )
          .eq("trading_day_id", dayId!);
        if (error) throw error;
        return data;
      },
    });
  },
};

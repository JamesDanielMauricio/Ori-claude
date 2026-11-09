import type { Database } from "@ori/db/supabase-types";

// A product family's category, and a customer user's (migration 0090):
// Bubble's "Product Categories" option set, with Bubble's own wording. A
// customer user set to fruit or vegetable sees only that category's products
// and the "both" ones; a user with none sees everything.
export type ProduceCategory = Database["public"]["Enums"]["produce_category"];

export const PRODUCE_CATEGORIES: readonly ProduceCategory[] = ["fruit", "vegetable", "both"];

export const PRODUCE_CATEGORY_LABEL: Record<ProduceCategory, string> = {
  fruit: "פרי",
  vegetable: "ירק",
  both: "פרי / ירק",
};

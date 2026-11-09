import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { produceCategoryEnum } from "./enums";

// The catalog's high-level grouping ("בננות"/Bananas, "תפוחים"/Apples).
// `category` was free text until migration 0090: the PRD gave only examples,
// and a closed set would have been guessed. Bubble's own option set settled
// it (2026-11-09): fruit, vegetable or both — and a customer user set to one
// of them sees only that category's families and the "both" ones.
export const productFamilies = pgTable("product_families", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  category: produceCategoryEnum("category"),
  // The family's catalog photo, shown on the customer order screen and the
  // backoffice Products table. Added by migration 0036 and live in the
  // database since; this declaration was simply never brought across, so
  // Drizzle's view of the table drifted from the real one.
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

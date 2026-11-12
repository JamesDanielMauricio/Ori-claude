import { boolean, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { packTypeEnum, priceTypeEnum } from "./enums";
import { productFamilies } from "./product-family";

// The sellable catalog item — the PRD's `produce` entity. `priceType` is
// Bubble's Price Types list (migration 0100, enums.ts) and decides which
// price is shown: fixed the price, range the range, a תקליט type its own
// name. `version` backs optimistic concurrency on saves (R7) — see
// the `save_product` function in the reference-data migration; every
// update increments it in the same statement that writes the row.
export const productVarieties = pgTable("product_varieties", {
  id: uuid("id").primaryKey().defaultRandom(),
  familyId: uuid("family_id")
    .notNull()
    .references(() => productFamilies.id),
  name: text("name").notNull(),
  sizes: text("sizes"),
  packType: packTypeEnum("pack_type"),
  price: numeric("price", { precision: 10, scale: 2 }),
  priceRangeFrom: numeric("price_range_from", { precision: 10, scale: 2 }),
  priceRangeTo: numeric("price_range_to", { precision: 10, scale: 2 }),
  priceType: priceTypeEnum("price_type"),
  noOverbooking: numeric("no_overbooking", { precision: 10, scale: 2 }).notNull().default("0"),
  highlightPriceFluctuations: boolean("highlight_price_fluctuations").notNull().default(false),
  // Catalog-level "orderable at all this season" flag — distinct from a
  // grower's own products_in_season_list (grower-product.ts), which
  // selects a subset of whichever varieties are seasonally available.
  isSeasonalAvailable: boolean("is_seasonal_available").notNull().default(true),
  // The customer-facing order screen's per-line ceiling (migration 0042) —
  // the most pallets ANY one customer may put on a single order line for
  // this variety, independent of stock. Null means no variety-level cap
  // (the customer's limit is then the remaining stock alone). The only
  // per-customer limit — a separate cap for one customer was removed
  // (migrations 0087, 0091). Never consulted for a backoffice on-behalf-of
  // edit — see max_orderable_for_customer's own comment.
  numberOfOrdersPerCustomer: integer("number_of_orders_per_customer"),
  // The variety's own picture (migration 0094; Bubble "Image"): a link into
  // the product-photos bucket. The family's photo is product_families.image_url.
  imageUrl: text("image_url"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

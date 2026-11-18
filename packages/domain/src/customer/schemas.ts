import { isPalletQuantity, PALLET_QUANTITY_MESSAGE, roundPallets } from "@ori/shared/pallets";
import { z } from "zod";

// One schema + `toRpcArgs` mapper per customer-ordering Postgres function
// (packages/db/migrations/0018_customer-order-functions.sql), mirroring
// the grower module's pattern.

// customerCompanyId is omitted for a customer reading their own catalog;
// backoffice supplies it to read a specific customer's catalog+cart on
// the Customer Order Status screen (`/backoffice/distributor-customer`)
// — get_orderable_catalog_for_customer rejects a non-null value from any
// caller that isn't backoffice, so this isn't a spoofing surface.
export const orderableCatalogInputSchema = z.object({
  tradingDayId: z.string().uuid(),
  customerCompanyId: z.string().uuid().optional(),
});
export type OrderableCatalogInput = z.infer<typeof orderableCatalogInputSchema>;

export function toOrderableCatalogRpcArgs(input: OrderableCatalogInput) {
  return {
    p_trading_day_id: input.tradingDayId,
    p_customer_company_id: input.customerCompanyId ?? null,
  };
}

// One line the customer is submitting. `comment` is nullable/omittable —
// an absent or empty comment is stored as null (see submit_order's
// `nullif(..., '')`). Only lines with a positive pallet count need to be
// included; anything already on the order but absent from this array is
// pruned by submit_order — the same upsert-and-prune shape as
// bootstrap_grower_pick (R3), never a per-line dash-packed call. The one
// exception: on a customer's own send, a line for a product on their own
// blocked list is never pruned (nor changed, if sent) — migration 0072.
export const orderLineInputSchema = z.object({
  productVarietyId: z.string().uuid(),
  // At most one decimal place — 0.4, not 0.14 (workbook Task 35; the
  // database refuses the same, migration 0085). Rounded on the way out so
  // the server compares 0.3 and not 0.30000000000000004 with its limits.
  palletsOrdered: z
    .number()
    .nonnegative()
    .refine(isPalletQuantity, PALLET_QUANTITY_MESSAGE)
    .transform(roundPallets),
  comment: z.string().nullable().optional(),
});
export type OrderLineInput = z.infer<typeof orderLineInputSchema>;

// customerCompanyId is omitted for a customer submitting their own order;
// backoffice supplies it to create/edit an order on a customer's behalf
// — same on-behalf-of pattern as orderableCatalogInputSchema above, and
// the same function (submit_order) either way, never a second write path.
export const submitOrderInputSchema = z.object({
  tradingDayId: z.string().uuid(),
  lines: z.array(orderLineInputSchema),
  customerCompanyId: z.string().uuid().optional(),
  // The comment on the whole order, "הערה כללית" (migration 0093). Trimmed;
  // an empty string is sent and clears the stored comment; left out
  // (undefined) it is not sent at all, and submit_order keeps what is stored
  // — which is what the order screen sends when it couldn't load the comment.
  comment: z.string().trim().optional(),
});
export type SubmitOrderInput = z.infer<typeof submitOrderInputSchema>;

export function toSubmitOrderRpcArgs(input: SubmitOrderInput) {
  return {
    p_trading_day_id: input.tradingDayId,
    p_lines: input.lines.map((line) => ({
      productVarietyId: line.productVarietyId,
      palletsOrdered: line.palletsOrdered,
      comment: line.comment ?? null,
    })),
    p_customer_company_id: input.customerCompanyId ?? null,
    ...(input.comment === undefined ? {} : { p_comment: input.comment }),
  };
}

// send_order_reminder — the distributor's "remind this customer" action
// on the Customer Order Status screen. Lives here (customer module), not
// in the backoffice/notifications modules, because it operates on a
// daily_orders (customer-domain) entity — same placement logic as
// sendPickReminderInputSchema living in the grower module despite being
// backoffice-triggered.
//
// recipientUserIds (migration 0104) names which of the customer's people get
// it; left out, the company's usual routing applies.
export const sendOrderReminderInputSchema = z.object({
  dailyOrderId: z.string().uuid(),
  recipientUserIds: z
    .array(z.string().uuid())
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, { message: "no duplicates" })
    .optional(),
});
export type SendOrderReminderInput = z.infer<typeof sendOrderReminderInputSchema>;

export function toSendOrderReminderRpcArgs(input: SendOrderReminderInput) {
  return {
    p_daily_order_id: input.dailyOrderId,
    // Sent only when a list is given, so a call without one is exactly
    // today's call.
    ...(input.recipientUserIds === undefined ? {} : { p_recipient_user_ids: input.recipientUserIds }),
  };
}

// See packages/domain/src/lifecycle-engine/schemas.ts's LIFECYCLE_ERROR_CODES
// for the full convention this mirrors — these are just the subset this
// module's own functions (0018/0028's submit_order, get_orderable_catalog_for_customer,
// send_order_reminder) actually raise.
export const CUSTOMER_ERROR_CODES = {
  /** No trading day/order matched (submit_order), or the target order doesn't exist (send_order_reminder). */
  NOT_FOUND: "P0002",
  /** current_role() <> 'customer' with no company id supplied, or a non-backoffice caller supplied one. */
  FORBIDDEN: "42501",
  /** submit_order called once the trading day is closed — or, for a customer's own order, once the shop is no longer open (migration 0071); send_order_reminder called on an already-submitted order. */
  INVALID_STATE: "P0007",
  /** A line's pallet count is negative, references a variety not in that day's shop, or (direct customer submissions only) exceeds max_orderable_for_customer(). */
  INVALID_INPUT: "P0008",
} as const;

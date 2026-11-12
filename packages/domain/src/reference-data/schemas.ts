import { userRoleSchema } from "@ori/shared/roles";
import { z } from "zod";

// Shared with the two real, PRD-confirmed enums (company_status, pack_type
// — see packages/db/src/schema/enums.ts for why price_type/category are
// left as free text instead of guessed enums).
export const companyStatusSchema = z.enum(["active", "inactive"]);
export const packTypeSchema = z.enum(["pallets", "crates"]);

// One schema + one `toRpcArgs` mapper per `save_*` Postgres function
// (packages/db/migrations/0007_reference-data-functions.sql). Validating
// here, client-side, before the `supabase.rpc()` call is a UX nicety
// (fail fast with field-level errors) — the actual authorization and
// data-integrity boundary is the function + RLS, not this schema.

// A company's WhatsApp group id is stored bare: whatsapp-dispatch appends
// Green API's "@g.us" itself, so a full chat id pasted in — the form Bubble
// stored it in — would go out as "...@g.us@g.us" and never arrive. Every
// company screen saves through one of the three schemas below, which makes
// this the one place to strip it. A blank field means no group.
const whatsappGroupIdSchema = z
  .string()
  .nullable()
  .transform((value) => value?.trim().replace(/@g\.us$/, "") || null);

// A company's own contact and accounting details (migration 0092): טלפון,
// כתובת, יישוב, and הנה״ח's ח.פ. and מספר בהנה״ח. Free text for people to
// read — nothing sends messages to these phones, so there is no format check.
// Trimmed; an empty string is sent, and the save function clears the stored
// value; a detail left out (undefined) is not sent at all, and the save
// function keeps what is stored — so a screen that doesn't know a field can
// never wipe it.
export const COMPANY_DETAIL_MAX_LENGTH = {
  phone: 30,
  addressLine: 200,
  city: 100,
  taxId: 30,
  accountingId: 30,
} as const;

const companyDetail = (max: number) => z.string().trim().max(max).optional();

export const companyDetailsSchema = z.object({
  phone: companyDetail(COMPANY_DETAIL_MAX_LENGTH.phone),
  addressLine: companyDetail(COMPANY_DETAIL_MAX_LENGTH.addressLine),
  city: companyDetail(COMPANY_DETAIL_MAX_LENGTH.city),
  taxId: companyDetail(COMPANY_DETAIL_MAX_LENGTH.taxId),
  accountingId: companyDetail(COMPANY_DETAIL_MAX_LENGTH.accountingId),
});
export type CompanyDetailsInput = z.infer<typeof companyDetailsSchema>;

export function toCompanyDetailsRpcArgs(input: CompanyDetailsInput): {
  p_phone?: string;
  p_address_line?: string;
  p_city?: string;
  p_tax_id?: string;
  p_accounting_id?: string;
} {
  return {
    ...(input.phone === undefined ? {} : { p_phone: input.phone }),
    ...(input.addressLine === undefined ? {} : { p_address_line: input.addressLine }),
    ...(input.city === undefined ? {} : { p_city: input.city }),
    ...(input.taxId === undefined ? {} : { p_tax_id: input.taxId }),
    ...(input.accountingId === undefined ? {} : { p_accounting_id: input.accountingId }),
  };
}

export const saveGrowerInputSchema = z.object({
  id: z.string().uuid().nullable(),
  name: z.string().min(1),
  status: companyStatusSchema,
  defaultPickupTime: z.string().nullable(),
  whatsappGroupId: whatsappGroupIdSchema,
  productVarietyIds: z.array(z.string().uuid()),
  // The transporter assigned to move this grower's arranged produce —
  // id 8's cc target on arrangement finalization (see
  // packages/db/migrations/0031/0033). Nullable: most growers may have no
  // transporter assigned.
  transporterCompanyId: z.string().uuid().nullable(),
  // The distributor's point of contact for this company — any profile in
  // the system (see packages/db/migrations/0057). Nullable: most companies
  // have none set.
  contactPersonId: z.string().uuid().nullable(),
  // Bubble's "Should not receive arrangement?" (migrations 0081/0082): true =
  // this grower is not sent the arrangement sale message. Optional: a save
  // that leaves it out (the "בשם מגדל" products dialog) keeps the current
  // setting — save_grower treats a missing value as "unchanged".
  noArrangementMessage: z.boolean().optional(),
  ...companyDetailsSchema.shape,
});
export type SaveGrowerInput = z.infer<typeof saveGrowerInputSchema>;

export function toSaveGrowerRpcArgs(input: SaveGrowerInput) {
  return {
    p_id: input.id,
    p_name: input.name,
    p_status: input.status,
    p_default_pickup_time: input.defaultPickupTime,
    p_whatsapp_group_id: input.whatsappGroupId,
    p_product_variety_ids: input.productVarietyIds,
    p_transporter_company_id: input.transporterCompanyId,
    p_contact_person_id: input.contactPersonId,
    // Left out of the request when not given, so the database keeps the
    // grower's current setting.
    ...(input.noArrangementMessage === undefined ? {} : { p_no_arrangement_message: input.noArrangementMessage }),
    ...toCompanyDetailsRpcArgs(input),
  };
}

export const saveCustomerInputSchema = z.object({
  id: z.string().uuid().nullable(),
  name: z.string().min(1),
  status: companyStatusSchema,
  canSeeProductPrices: z.boolean().nullable(),
  whatsappGroupId: whatsappGroupIdSchema,
  contactPersonId: z.string().uuid().nullable(),
  ...companyDetailsSchema.shape,
});
export type SaveCustomerInput = z.infer<typeof saveCustomerInputSchema>;

export function toSaveCustomerRpcArgs(input: SaveCustomerInput) {
  return {
    p_id: input.id,
    p_name: input.name,
    p_status: input.status,
    p_can_see_product_prices: input.canSeeProductPrices,
    p_whatsapp_group_id: input.whatsappGroupId,
    p_contact_person_id: input.contactPersonId,
    ...toCompanyDetailsRpcArgs(input),
  };
}

export const saveTransporterInputSchema = z.object({
  id: z.string().uuid().nullable(),
  name: z.string().min(1),
  status: companyStatusSchema,
  whatsappGroupId: whatsappGroupIdSchema,
  contactPersonId: z.string().uuid().nullable(),
  ...companyDetailsSchema.shape,
});
export type SaveTransporterInput = z.infer<typeof saveTransporterInputSchema>;

export function toSaveTransporterRpcArgs(input: SaveTransporterInput) {
  return {
    p_id: input.id,
    p_name: input.name,
    p_status: input.status,
    p_whatsapp_group_id: input.whatsappGroupId,
    p_contact_person_id: input.contactPersonId,
    ...toCompanyDetailsRpcArgs(input),
  };
}

export const saveProductInputSchema = z.object({
  id: z.string().uuid().nullable(),
  familyId: z.string().uuid(),
  name: z.string().min(1),
  sizes: z.string().nullable(),
  packType: packTypeSchema.nullable(),
  price: z.number().nullable(),
  priceRangeFrom: z.number().nullable(),
  priceRangeTo: z.number().nullable(),
  priceType: z.string().nullable(),
  // Pallets are always whole units — never a fractional pallet.
  noOverbooking: z.number().int(),
  highlightPriceFluctuations: z.boolean(),
  isSeasonalAvailable: z.boolean(),
  // The customer order screen's per-line ceiling (migration 0042). Null
  // means no cap. The only per-customer limit: a separate cap for one
  // customer was removed (migration 0087).
  numberOfOrdersPerCustomer: z.number().int().positive().nullable(),
  // Required when updating (the version the client last read); ignored by
  // the function on create. Null only ever legitimately occurs on create.
  expectedVersion: z.number().int().nullable(),
  // The variety's own picture (migration 0094): a link into the
  // product-photos bucket. Trimmed; an empty string is sent and removes the
  // stored picture; left out (undefined) it is not sent, and save_product
  // keeps what is stored.
  imageUrl: z.string().trim().optional(),
});
export type SaveProductInput = z.infer<typeof saveProductInputSchema>;

export function toSaveProductRpcArgs(input: SaveProductInput) {
  return {
    p_id: input.id,
    p_family_id: input.familyId,
    p_name: input.name,
    p_sizes: input.sizes,
    p_pack_type: input.packType,
    p_price: input.price,
    p_price_range_from: input.priceRangeFrom,
    p_price_range_to: input.priceRangeTo,
    p_price_type: input.priceType,
    p_no_overbooking: input.noOverbooking,
    p_highlight_price_fluctuations: input.highlightPriceFluctuations,
    p_is_seasonal_available: input.isSeasonalAvailable,
    p_number_of_orders_per_customer: input.numberOfOrdersPerCustomer,
    p_expected_version: input.expectedVersion,
    ...(input.imageUrl === undefined ? {} : { p_image_url: input.imageUrl }),
  };
}

// A product family's category, and a customer user's (migration 0090).
export const produceCategorySchema = z.enum(["fruit", "vegetable", "both"]);

export const saveUserInputSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().min(1),
  role: userRoleSchema,
  companyId: z.string().uuid(),
  blockedProductVarietyIds: z.array(z.string().uuid()),
  // A customer user's category (Bubble's "default product category"): they
  // see only that category's products and "both" ones. Optional: left out,
  // save_user keeps the user's current category (migration 0090).
  productCategory: produceCategorySchema.optional(),
});
export type SaveUserInput = z.infer<typeof saveUserInputSchema>;

export function toSaveUserRpcArgs(input: SaveUserInput) {
  return {
    p_user_id: input.userId,
    p_display_name: input.displayName,
    p_role: input.role,
    p_company_id: input.companyId,
    p_blocked_product_variety_ids: input.blockedProductVarietyIds,
    // Left out of the request when not given, so the user keeps their category.
    ...(input.productCategory === undefined ? {} : { p_product_category: input.productCategory }),
  };
}

// PostgREST surfaces a `raise exception ... using errcode = 'P0003'` as a
// PostgrestError with this code — the one distinguishing signal between
// "someone else saved first" (recoverable: reload and retry) and every
// other failure. Deliberately NOT `40001` (Postgres's own
// `serialization_failure` code): the connection-pooling layer between
// PostgREST and Postgres treats that code as a transient, auto-retried
// failure, which turned a legitimate, immediate conflict into a
// many-second hang before it finally surfaced (see
// packages/db/migrations/0008_product-conflict-errcode-fix.sql). Kept here,
// next to the schemas that build the RPC calls, so the client and the
// tests agree on what a conflict looks like without each re-deriving the
// Postgres error code by hand.
export const PRODUCT_VERSION_CONFLICT_ERROR_CODE = "P0003";

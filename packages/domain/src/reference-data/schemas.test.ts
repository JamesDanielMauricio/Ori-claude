import { describe, expect, it } from "vitest";

import {
  saveCustomerInputSchema,
  saveGrowerInputSchema,
  saveProductInputSchema,
  saveTransporterInputSchema,
  setCustomerScoreInputSchema,
  toSaveCustomerRpcArgs,
  toSaveGrowerRpcArgs,
  toSaveProductRpcArgs,
  toSaveTransporterRpcArgs,
  toSetCustomerScoreRpcArgs,
} from "./schemas";

const company = { id: null, name: "חברת בדיקה", status: "active" as const };

// Each company screen saves through its own schema, so each one is checked:
// a schema that skipped the normalization would let that screen store a
// suffixed id that dispatch then doubles.
const parseGroupId = {
  grower: (whatsappGroupId: string | null) =>
    saveGrowerInputSchema.parse({
      ...company,
      defaultPickupTime: null,
      productVarietyIds: [],
      transporterCompanyId: null,
      contactPersonId: null,
      whatsappGroupId,
    }).whatsappGroupId,
  customer: (whatsappGroupId: string | null) =>
    saveCustomerInputSchema.parse({
      ...company,
      canSeeProductPrices: null,
      contactPersonId: null,
      whatsappGroupId,
    }).whatsappGroupId,
  transporter: (whatsappGroupId: string | null) =>
    saveTransporterInputSchema.parse({ ...company, contactPersonId: null, whatsappGroupId })
      .whatsappGroupId,
};

describe.each(Object.entries(parseGroupId))("%s whatsappGroupId", (_, parse) => {
  it("strips a pasted @g.us suffix", () => {
    expect(parse("120363417140195112@g.us")).toBe("120363417140195112");
  });

  it("trims surrounding whitespace, including around a suffix", () => {
    expect(parse(" 120363417140195112@g.us ")).toBe("120363417140195112");
  });

  it("keeps a bare id as it is", () => {
    expect(parse("120363417140195112")).toBe("120363417140195112");
  });

  it("stores a blank field as no group", () => {
    expect(parse(null)).toBeNull();
    expect(parse("")).toBeNull();
    expect(parse("   ")).toBeNull();
    expect(parse("@g.us")).toBeNull();
  });
});

// The distributor's ranking score for a customer, kept for the arrangement
// suggestion to order customers by when a product is short. The scale is the
// distributor's own: 1 (lowest) to 5, to two decimal places.
describe("setCustomerScoreInputSchema", () => {
  const customerCompanyId = "0b0e7c1e-3f0d-4f8e-9a51-2f6d1c0a9e11";
  const parse = (generalScore: unknown) =>
    setCustomerScoreInputSchema.parse({ customerCompanyId, generalScore }).generalScore;

  it.each([1, 3.85, 5])("accepts %s, a score on the 1-to-5 scale", (score) => {
    expect(parse(score)).toBe(score);
  });

  it("accepts no score, which is how a customer's ranking is cleared", () => {
    expect(parse(null)).toBeNull();
  });

  it.each([0, 0.99, 5.01, 6, -1, Number.NaN])("refuses %s, which is off the scale", (score) => {
    expect(() => parse(score)).toThrow();
  });

  it("keeps two decimal places, as the database column does", () => {
    // A spreadsheet's weighted average arrives like this.
    expect(parse(4.349999999999999)).toBe(4.35);
    expect(parse(3.999999999999999)).toBe(4);
    expect(parse(4.3449)).toBe(4.34);
    expect(parse(4.3451)).toBe(4.35);
  });

  it("rounds an exact half upwards, as numeric(3,2) does", () => {
    // 1.005 is stored in binary a hair BELOW 1.005, so multiplying by 100 and
    // rounding gives 1.00 — while Postgres, reading the decimal text, stores
    // 1.01. The screen would then show a score the database does not hold.
    expect(parse(1.005)).toBe(1.01);
    expect(parse(1.015)).toBe(1.02);
    expect(parse(1.255)).toBe(1.26);
    expect(parse(2.675)).toBe(2.68);
  });

  it.each([0.996, 5.004])("refuses %s before rounding could bring it onto the scale", (score) => {
    // set_customer_score checks the range on the number it is given, not on
    // what the column would round it to. The two must agree.
    expect(() => parse(score)).toThrow();
  });

  it.each([undefined, "3", true])(
    "refuses %j, which is not a score or a deliberate null",
    (score) => {
      expect(() => parse(score)).toThrow();
    },
  );

  it.each(["not-an-id", null, undefined])("refuses a score for the company id %j", (id) => {
    expect(() =>
      setCustomerScoreInputSchema.parse({ customerCompanyId: id, generalScore: 3 }),
    ).toThrow();
  });

  it("maps to the database function's own parameter names", () => {
    expect(toSetCustomerScoreRpcArgs({ customerCompanyId, generalScore: 4.35 })).toEqual({
      p_customer_company_id: customerCompanyId,
      p_general_score: 4.35,
    });
  });

  it("sends a cleared score as an explicit null, which is what the function clears on", () => {
    expect(toSetCustomerScoreRpcArgs({ customerCompanyId, generalScore: null })).toEqual({
      p_customer_company_id: customerCompanyId,
      p_general_score: null,
    });
  });
});

// A company's טלפון, כתובת, יישוב and הנה״ח (migration 0092). The save
// functions keep a stored detail when its argument is left out and clear it
// when sent empty, so what reaches the call decides which of the two happens.
describe("company details (migration 0092)", () => {
  const grower = {
    ...company,
    defaultPickupTime: null,
    whatsappGroupId: null,
    productVarietyIds: [],
    transporterCompanyId: null,
    contactPersonId: null,
  };

  it("are sent trimmed, an empty string is kept so it clears, and a detail not given is left out of the call", () => {
    const args = toSaveGrowerRpcArgs(
      saveGrowerInputSchema.parse({ ...grower, phone: "  050-1234567 ", city: "   " }),
    );
    expect(args.p_phone).toBe("050-1234567");
    expect(args.p_city).toBe("");
    expect("p_address_line" in args).toBe(false);
    expect("p_tax_id" in args).toBe(false);
    expect("p_accounting_id" in args).toBe(false);
  });

  it("refuse a value longer than its limit", () => {
    const accepts = (details: Record<string, string>) =>
      saveGrowerInputSchema.safeParse({ ...grower, ...details }).success;
    expect(accepts({ phone: "1".repeat(30) })).toBe(true);
    expect(accepts({ phone: "1".repeat(31) })).toBe(false);
    expect(accepts({ addressLine: "א".repeat(200) })).toBe(true);
    expect(accepts({ addressLine: "א".repeat(201) })).toBe(false);
    expect(accepts({ city: "א".repeat(100) })).toBe(true);
    expect(accepts({ city: "א".repeat(101) })).toBe(false);
    expect(accepts({ taxId: "1".repeat(31) })).toBe(false);
    expect(accepts({ accountingId: "1".repeat(31) })).toBe(false);
  });

  it("are sent the same way by the customer and transporter saves", () => {
    const customerArgs = toSaveCustomerRpcArgs(
      saveCustomerInputSchema.parse({
        ...company,
        canSeeProductPrices: null,
        whatsappGroupId: null,
        contactPersonId: null,
        taxId: "123456789",
        accountingId: "4321",
      }),
    );
    expect(customerArgs.p_tax_id).toBe("123456789");
    expect(customerArgs.p_accounting_id).toBe("4321");

    const transporterArgs = toSaveTransporterRpcArgs(
      saveTransporterInputSchema.parse({
        ...company,
        whatsappGroupId: null,
        contactPersonId: null,
        phone: "03-5000000",
      }),
    );
    expect(transporterArgs.p_phone).toBe("03-5000000");
  });
});

// A variety's own picture (migration 0094). save_product keeps the stored
// picture when p_image_url is left out and removes it when sent empty.
describe("save_product args: the variety picture (migration 0094)", () => {
  const product = {
    id: null,
    familyId: "00000000-0000-4000-8000-000000000201",
    name: "קוונדיש",
    sizes: null,
    packType: null,
    price: null,
    priceRangeFrom: null,
    priceRangeTo: null,
    priceType: null,
    noOverbooking: 0,
    highlightPriceFluctuations: false,
    isSeasonalAvailable: true,
    numberOfOrdersPerCustomer: null,
    expectedVersion: null,
  };
  const argsFor = (extra: Record<string, unknown>) =>
    toSaveProductRpcArgs(saveProductInputSchema.parse({ ...product, ...extra }));

  it("a picture link is sent trimmed, an empty one is sent to remove it, and when left out it is not sent", () => {
    expect(argsFor({ imageUrl: " https://x.test/a.jpg " }).p_image_url).toBe("https://x.test/a.jpg");
    expect(argsFor({ imageUrl: "" }).p_image_url).toBe("");
    expect("p_image_url" in argsFor({})).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  ARRANGEMENT_ERROR_CODES,
  arrangeToCustomerInputSchema,
  saveArrangementChangesInputSchema,
  saveArrangementProposalInputSchema,
  toSaveArrangementChangesRpcArgs,
  toSaveArrangementProposalRpcArgs,
  updateArrangementRecordInputSchema,
} from "./schemas";

// Pure: no database. The function itself is exercised in arrangement.test.ts.
const DAY = "a779ebca-c1a4-4281-a18c-7177d3a88531";
const LOT = "27614702-0b6e-4115-aaa8-78a4fc13510f";
const CUSTOMER = "3bd16d29-d09f-4f9f-9105-79f276ca6921";
const OTHER_CUSTOMER = "01d1f248-eeb8-4ee2-8ab8-a260e32d562f";

describe("saveArrangementProposalInputSchema", () => {
  it("accepts a day and its cells, in pallets above zero", () => {
    const parsed = saveArrangementProposalInputSchema.parse({
      tradingDayId: DAY,
      allocations: [
        { dailyPickProductId: LOT, customerCompanyId: CUSTOMER, quantityPallets: 2 },
        { dailyPickProductId: LOT, customerCompanyId: OTHER_CUSTOMER, quantityPallets: 1 },
      ],
    });

    expect(parsed.allocations).toHaveLength(2);
  });

  it("accepts a proposal with nothing in it", () => {
    expect(
      saveArrangementProposalInputSchema.parse({ tradingDayId: DAY, allocations: [] }),
    ).toEqual({
      tradingDayId: DAY,
      allocations: [],
    });
  });

  // Task 35: a tenth of a pallet is a quantity; a hundredth is not.
  it.each([0.1, 0.4, 2.5])("accepts %s pallets", (quantityPallets) => {
    const parsed = saveArrangementProposalInputSchema.parse({
      tradingDayId: DAY,
      allocations: [{ dailyPickProductId: LOT, customerCompanyId: CUSTOMER, quantityPallets }],
    });

    expect(parsed.allocations[0]?.quantityPallets).toBe(quantityPallets);
  });

  it("sends a sum of tenths without its rounding noise", () => {
    const parsed = saveArrangementProposalInputSchema.parse({
      tradingDayId: DAY,
      allocations: [
        { dailyPickProductId: LOT, customerCompanyId: CUSTOMER, quantityPallets: 0.1 + 0.2 },
      ],
    });

    expect(parsed.allocations[0]?.quantityPallets).toBe(0.3);
  });

  it.each([0, -1, 0.15, 1.55])("refuses %s pallets", (quantityPallets) => {
    const result = saveArrangementProposalInputSchema.safeParse({
      tradingDayId: DAY,
      allocations: [{ dailyPickProductId: LOT, customerCompanyId: CUSTOMER, quantityPallets }],
    });

    expect(result.success).toBe(false);
  });

  it("refuses the same cell twice, as the function would", () => {
    const result = saveArrangementProposalInputSchema.safeParse({
      tradingDayId: DAY,
      allocations: [
        { dailyPickProductId: LOT, customerCompanyId: CUSTOMER, quantityPallets: 1 },
        { dailyPickProductId: LOT, customerCompanyId: CUSTOMER, quantityPallets: 2 },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("refuses ids that are not uuids", () => {
    const result = saveArrangementProposalInputSchema.safeParse({
      tradingDayId: "today",
      allocations: [{ dailyPickProductId: LOT, customerCompanyId: CUSTOMER, quantityPallets: 1 }],
    });

    expect(result.success).toBe(false);
  });
});

describe("saveArrangementProposalInputSchema — the for-an-order mark", () => {
  it("accepts a cell marked as filling an order, and one without the mark", () => {
    const parsed = saveArrangementProposalInputSchema.parse({
      tradingDayId: DAY,
      allocations: [
        {
          dailyPickProductId: LOT,
          customerCompanyId: CUSTOMER,
          quantityPallets: 1,
          forOrder: true,
        },
        { dailyPickProductId: LOT, customerCompanyId: OTHER_CUSTOMER, quantityPallets: 1 },
      ],
    });

    expect(parsed.allocations.map((cell) => cell.forOrder)).toEqual([true, undefined]);
  });

  it("refuses a mark that is not true or false", () => {
    const result = saveArrangementProposalInputSchema.safeParse({
      tradingDayId: DAY,
      allocations: [
        {
          dailyPickProductId: LOT,
          customerCompanyId: CUSTOMER,
          quantityPallets: 1,
          forOrder: "yes",
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe("toSaveArrangementProposalRpcArgs", () => {
  it("hands the cells over in the keys the function reads", () => {
    const allocations = [
      { dailyPickProductId: LOT, customerCompanyId: CUSTOMER, quantityPallets: 2, forOrder: true },
    ];

    expect(toSaveArrangementProposalRpcArgs({ tradingDayId: DAY, allocations })).toEqual({
      p_trading_day_id: DAY,
      p_allocations: allocations,
    });
  });
});

describe("ARRANGEMENT_ERROR_CODES", () => {
  it("names the code a filled cell is refused with", () => {
    expect(ARRANGEMENT_ERROR_CODES.CONFLICT).toBe("P0006");
  });
});

// A record's own price type (migration 0100): one of the codes, or none.
describe("a record's price type", () => {
  const RECORD = "5a0f8a8e-4a5b-4c35-9a3e-2f6f1d1f7c11";

  it("is one of Bubble's types as its code, or none", () => {
    for (const priceType of ["fixed", "range", "record_plus_1", null, undefined]) {
      expect(
        updateArrangementRecordInputSchema.safeParse({ id: RECORD, quantityPallets: 1, priceType }).success,
        String(priceType),
      ).toBe(true);
    }
  });

  it("is never free text", () => {
    for (const priceType of ["לפי גודל", "מספר", ""]) {
      expect(
        arrangeToCustomerInputSchema.safeParse({
          dailyPickProductId: LOT,
          customerCompanyId: CUSTOMER,
          quantityPallets: 1,
          priceType,
        }).success,
        priceType,
      ).toBe(false);
    }
  });
});

describe("saveArrangementChangesInputSchema", () => {
  const GDAY = "00000000-0000-4000-8000-000000000001";
  const LINE = "00000000-0000-4000-8000-000000000002";
  const C1 = "00000000-0000-4000-8000-000000000003";
  const C2 = "00000000-0000-4000-8000-000000000004";
  const C3 = "00000000-0000-4000-8000-000000000005";
  const R2 = "00000000-0000-4000-8000-000000000006";
  const R3 = "00000000-0000-4000-8000-000000000007";
  const EMPTY = { recordId: null, quantityPallets: 0 };
  const change = (over: Record<string, unknown> = {}) => ({
    dailyPickProductId: LINE,
    customerCompanyId: C1,
    quantityPallets: 3,
    expected: EMPTY,
    ...over,
  });
  const parse = (changes: unknown[]) =>
    saveArrangementChangesInputSchema.safeParse({ tradingDayId: GDAY, changes });

  it("accepts a new, a changed and a cleared cell", () => {
    expect(
      parse([
        change(),
        change({ customerCompanyId: C2, quantityPallets: 5, expected: { recordId: R2, quantityPallets: 2 } }),
        change({ customerCompanyId: C3, quantityPallets: 0, expected: { recordId: R3, quantityPallets: 1 } }),
      ]).success,
    ).toBe(true);
  });

  it("refuses a cell that appears twice", () => {
    expect(parse([change(), change({ quantityPallets: 4 })]).success).toBe(false);
  });

  it("refuses clearing a cell that held nothing", () => {
    expect(parse([change({ quantityPallets: 0 })]).success).toBe(false);
  });

  it("takes tenths of a pallet and nothing finer, and no negatives", () => {
    expect(parse([change({ quantityPallets: 0.5 })]).success).toBe(true);
    expect(parse([change({ quantityPallets: 0.55 })]).success).toBe(false);
    expect(parse([change({ quantityPallets: -1 })]).success).toBe(false);
    expect(parse([change({ expected: { recordId: R2, quantityPallets: 0.55 } })]).success).toBe(false);
  });

  it("maps to the function's argument names", () => {
    const input = saveArrangementChangesInputSchema.parse({
      tradingDayId: GDAY,
      changes: [change({ forOrder: true })],
    });
    expect(toSaveArrangementChangesRpcArgs(input)).toEqual({
      p_trading_day_id: GDAY,
      p_changes: input.changes,
    });
  });
});

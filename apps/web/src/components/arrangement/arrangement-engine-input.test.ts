import { describe, expect, it } from "vitest";

import { setPreferredGrower } from "@/components/customer/preferred-grower";

import {
  customerFactsFrom,
  dayToPropose,
  historyFromRows,
  proposeForDay,
  readAllPages,
  type HistoryRows,
} from "./arrangement-engine-input";
import type { BoardOrder, BoardPick, BoardRecord } from "./board-data";

const LEMON = "variety-lemon";
const LIME = "variety-lime";
const CITRUS = "family-citrus";
const CITRUS_ROW = { family_id: CITRUS };

function variety(id: string) {
  return { id, name: id, family_id: CITRUS, product_families: { name: "הדרים", image_url: null } };
}

describe("historyFromRows", () => {
  // Two days: 2.10 has been closed, 3.10 is still open.
  const rows: HistoryRows = {
    days: [
      { id: "day-3", trade_date: "2026-10-03" },
      { id: "day-2", trade_date: "2026-10-02" },
      { id: "day-1", trade_date: "2026-10-01" },
    ],
    pickLines: [
      // Closed day: 6 picked, nothing carried in, 5 arranged and 1 left at the
      // end. leftover_pallets is what was CARRIED IN on every day since
      // migration 0070 — what was left is end_of_day_leftover_pallets, which
      // this read does not need.
      {
        product_variety_id: LEMON,
        pallets_picked: 4,
        leftover_pallets: 0,
        daily_picks: { trading_day_id: "day-2" },
        product_varieties: CITRUS_ROW,
      },
      {
        product_variety_id: LEMON,
        pallets_picked: 2,
        leftover_pallets: 0,
        daily_picks: { trading_day_id: "day-2" },
        product_varieties: CITRUS_ROW,
      },
      // Open day: leftover_pallets is what was CARRIED IN from the day before.
      {
        product_variety_id: LIME,
        pallets_picked: 3,
        leftover_pallets: 2,
        daily_picks: { trading_day_id: "day-3" },
        product_varieties: CITRUS_ROW,
      },
    ],
    orderLines: [
      {
        product_variety_id: LEMON,
        pallets_ordered: 9,
        daily_orders: { trading_day_id: "day-2", customer_company_id: "gabbai" },
        product_varieties: CITRUS_ROW,
      },
      {
        product_variety_id: LIME,
        pallets_ordered: 0,
        daily_orders: { trading_day_id: "day-2", customer_company_id: "gabbai" },
        product_varieties: CITRUS_ROW,
      },
    ],
    records: [
      {
        quantity_pallets: "4",
        customer_company_id: "stale-copy",
        daily_arrangements: { trading_day_id: "day-2" },
        daily_pick_products: { product_variety_id: LEMON, product_varieties: CITRUS_ROW },
        daily_order_products: { daily_orders: { customer_company_id: "gabbai" } },
      },
      {
        quantity_pallets: "1",
        customer_company_id: "atara",
        daily_arrangements: { trading_day_id: "day-2" },
        daily_pick_products: { product_variety_id: LEMON, product_varieties: CITRUS_ROW },
        daily_order_products: null,
      },
    ],
  };
  const { history, familyOf } = historyFromRows(rows);
  const dayOf = (date: string) => history.find((day) => day.date === date);

  it("counts a closed day's stock as picked plus what was carried into it, as for an open day (0070)", () => {
    // 4 + 2 picked, nothing carried in: the 6 the day started with.
    expect(dayOf("2026-10-02")?.supply).toEqual({ [LEMON]: 6 });
  });

  it("does not add a closed day's allocations to its stock either: they are inside picked + carried in", () => {
    // The 5 arranged on 2.10 (above) are part of its 6, not on top of them —
    // before 0070 they were added back to what was left; now nothing is.
    expect(dayOf("2026-10-02")?.supply[LEMON]).toBe(6);
    const moreArranged = historyFromRows({
      ...rows,
      records: [
        ...rows.records,
        {
          quantity_pallets: "1",
          customer_company_id: "gabbai",
          daily_arrangements: { trading_day_id: "day-2" },
          daily_pick_products: { product_variety_id: LEMON, product_varieties: CITRUS_ROW },
          daily_order_products: null,
        },
      ],
    });
    expect(moreArranged.history.find((day) => day.date === "2026-10-02")?.supply).toEqual({
      [LEMON]: 6,
    });
  });

  it("counts an open day's stock as picked plus what was carried into it", () => {
    expect(dayOf("2026-10-03")?.supply).toEqual({ [LIME]: 5 });
  });

  it("does not add an open day's allocations to its stock: they are already inside picked + leftover", () => {
    const withRecord = historyFromRows({
      ...rows,
      records: [
        ...rows.records,
        {
          quantity_pallets: "2",
          customer_company_id: "gabbai",
          daily_arrangements: { trading_day_id: "day-3" },
          daily_pick_products: { product_variety_id: LIME, product_varieties: CITRUS_ROW },
          daily_order_products: null,
        },
      ],
    });

    expect(withRecord.history.find((day) => day.date === "2026-10-03")?.supply).toEqual({
      [LIME]: 5,
    });
  });

  it("keeps only order lines and allocations above zero", () => {
    expect(dayOf("2026-10-02")?.orders).toEqual({ [LEMON]: { gabbai: 9 } });
  });

  it("reads whose an allocation was off its order line, and off the record's own copy only without one", () => {
    expect(dayOf("2026-10-02")?.recorded).toEqual({ [LEMON]: { gabbai: 4, atara: 1 } });
  });

  it("puts the days in date order, keeping a day with nothing on it", () => {
    expect(history.map((day) => day.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("collects each product's family as it goes", () => {
    expect(familyOf).toEqual({ [LEMON]: CITRUS, [LIME]: CITRUS });
  });

  describe("on the rows of one day", () => {
    // 2026-10-05, to which each test adds only what it is about.
    const closedDay: HistoryRows["days"] = [{ id: "day-5", trade_date: "2026-10-05" }];
    const none = { pickLines: [], orderLines: [], records: [] };
    const record = (
      overrides: Partial<HistoryRows["records"][number]> = {},
    ): HistoryRows["records"][number] => ({
      quantity_pallets: "2",
      customer_company_id: "atara",
      daily_arrangements: { trading_day_id: "day-5" },
      daily_pick_products: { product_variety_id: LEMON, product_varieties: CITRUS_ROW },
      daily_order_products: null,
      ...overrides,
    });

    it("ignores lots, order lines and allocations of a day that is not in the window", () => {
      const elsewhere = { trading_day_id: "day-elsewhere" };
      const stray = historyFromRows({
        days: closedDay,
        pickLines: [
          {
            product_variety_id: LEMON,
            pallets_picked: 4,
            leftover_pallets: 1,
            daily_picks: elsewhere,
            product_varieties: CITRUS_ROW,
          },
        ],
        orderLines: [
          {
            product_variety_id: LEMON,
            pallets_ordered: 3,
            daily_orders: { ...elsewhere, customer_company_id: "gabbai" },
            product_varieties: CITRUS_ROW,
          },
        ],
        records: [record({ daily_arrangements: elsewhere })],
      });

      expect(stray.history).toEqual([{ date: "2026-10-05", supply: {}, orders: {}, recorded: {} }]);
    });

    it("learns a product's family from an order line even when nothing of it was picked or arranged", () => {
      const ordered = historyFromRows({
        days: closedDay,
        ...none,
        orderLines: [
          {
            product_variety_id: LIME,
            pallets_ordered: 2,
            daily_orders: { trading_day_id: "day-5", customer_company_id: "gabbai" },
            product_varieties: CITRUS_ROW,
          },
        ],
      });

      expect(ordered.familyOf).toEqual({ [LIME]: CITRUS });
    });

    it("learns a product's family from an allocation even when nothing of it was picked or ordered", () => {
      const arranged = historyFromRows({ days: closedDay, ...none, records: [record()] });

      expect(arranged.familyOf).toEqual({ [LEMON]: CITRUS });
    });

    it("counts a row whose product did not come back, and notes no family for it", () => {
      const unknown = historyFromRows({
        days: closedDay,
        pickLines: [
          {
            product_variety_id: LEMON,
            pallets_picked: 4,
            leftover_pallets: 1,
            daily_picks: { trading_day_id: "day-5" },
            product_varieties: null,
          },
        ],
        orderLines: [
          {
            product_variety_id: LEMON,
            pallets_ordered: 3,
            daily_orders: { trading_day_id: "day-5", customer_company_id: "gabbai" },
            product_varieties: null,
          },
        ],
        records: [
          record({ daily_pick_products: { product_variety_id: LEMON, product_varieties: null } }),
        ],
      });

      expect(unknown.familyOf).toStrictEqual({});
      // 4 picked + 1 carried in; the order line and the allocation count all
      // the same.
      expect(unknown.history[0]).toEqual({
        date: "2026-10-05",
        supply: { [LEMON]: 5 },
        orders: { [LEMON]: { gabbai: 3 } },
        recorded: { [LEMON]: { atara: 2 } },
      });
    });

    it("adds up what one customer was given of one product from different lots", () => {
      const twoLots = historyFromRows({
        days: closedDay,
        ...none,
        records: [record({ quantity_pallets: "2" }), record({ quantity_pallets: "3" })],
      });

      expect(twoLots.history[0]?.recorded).toEqual({ [LEMON]: { atara: 5 } });
    });

    it("leaves an allocation of zero pallets out of the day", () => {
      const empty = historyFromRows({
        days: closedDay,
        ...none,
        records: [record({ quantity_pallets: "0" })],
      });

      expect(empty.history[0]).toEqual({
        date: "2026-10-05",
        supply: {},
        orders: {},
        recorded: {},
      });
    });

    it("ignores an allocation whose lot did not come back", () => {
      const lotless = historyFromRows({
        days: closedDay,
        ...none,
        records: [record({ daily_pick_products: null })],
      });

      expect(lotless.history[0]).toEqual({
        date: "2026-10-05",
        supply: {},
        orders: {},
        recorded: {},
      });
    });

    it("reads an allocation's customer off its own copy when its order line came back without its order", () => {
      const orderless = historyFromRows({
        days: closedDay,
        ...none,
        records: [record({ daily_order_products: { daily_orders: null } })],
      });

      expect(orderless.history[0]?.recorded).toEqual({ [LEMON]: { atara: 2 } });
    });
  });
});

describe("readAllPages", () => {
  const rows = Array.from({ length: 7 }, (_, index) => index);

  it("reads on until a page comes back empty, even when the server returns fewer rows than asked", async () => {
    const asked: Array<[number, number]> = [];
    const read = await readAllPages(async (from, to) => {
      asked.push([from, to]);
      // A server capped at 2 rows a page, whatever the range asked for.
      return rows.slice(from, Math.min(to + 1, from + 2));
    }, 5);

    expect(read).toEqual(rows);
    expect(asked.map(([from]) => from)).toEqual([0, 2, 4, 6, 7]);
  });

  it("asks for each page as a range of exactly the page size, both ends included", async () => {
    const asked: Array<[number, number]> = [];
    const read = await readAllPages(async (from, to) => {
      asked.push([from, to]);
      return rows.slice(from, to + 1);
    }, 3);

    expect(read).toEqual(rows);
    expect(asked).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
      [7, 9],
    ]);
  });

  it("reads pages of 1000 rows unless told otherwise", async () => {
    const many = Array.from({ length: 2500 }, (_, index) => index);
    const asked: Array<[number, number]> = [];
    const read = await readAllPages(async (from, to) => {
      asked.push([from, to]);
      return many.slice(from, to + 1);
    });

    expect(read).toEqual(many);
    expect(asked).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [2500, 3499],
    ]);
  });

  it("asks once when there is nothing", async () => {
    let calls = 0;
    const read = await readAllPages(async () => {
      calls += 1;
      return [];
    });

    expect(read).toEqual([]);
    expect(calls).toBe(1);
  });
});

describe("dayToPropose", () => {
  const picks: BoardPick[] = [
    {
      id: "pick-a",
      grower_company_id: "grower-a",
      status: "submitted",
      pickup_time: null,
      daily_pick_products: [
        {
          id: "line-a-lemon",
          daily_pick_id: "pick-a",
          product_variety_id: LEMON,
          pallets_picked: 5,
          leftover_pallets: 4,
          comment: null,
          product_varieties: variety(LEMON),
        },
        {
          id: "line-a-orphan",
          daily_pick_id: "pick-a",
          product_variety_id: "variety-gone",
          pallets_picked: 9,
          leftover_pallets: 0,
          comment: null,
          product_varieties: null,
        },
      ],
    },
    {
      id: "pick-b",
      grower_company_id: "grower-b",
      status: "submitted",
      pickup_time: null,
      daily_pick_products: [
        {
          id: "line-b-lemon",
          daily_pick_id: "pick-b",
          product_variety_id: LEMON,
          pallets_picked: 1,
          leftover_pallets: 0,
          comment: null,
          product_varieties: variety(LEMON),
        },
      ],
    },
  ];
  const orders: BoardOrder[] = [
    {
      id: "order-gabbai",
      customer_company_id: "gabbai",
      status: "submitted",
      // Submitted twice: the time that counts is the first.
      submitted_at: "2026-10-12T09:00:00+00:00",
      order_submission_logs: [
        { id: "log-2", created_at: "2026-10-12T09:00:00+00:00", snapshot: [] },
        { id: "log-1", created_at: "2026-10-12T06:00:00+00:00", snapshot: [] },
      ],
      daily_order_products: [
        {
          id: "ol-gabbai-lemon",
          daily_order_id: "order-gabbai",
          product_variety_id: LEMON,
          pallets_ordered: 3,
          comment: null,
          created_at: "2026-10-12T05:00:00+00:00",
          product_varieties: variety(LEMON),
        },
        {
          id: "ol-gabbai-lime",
          daily_order_id: "order-gabbai",
          product_variety_id: LIME,
          pallets_ordered: 0,
          comment: null,
          created_at: "2026-10-12T05:00:00+00:00",
          product_varieties: variety(LIME),
        },
      ],
    },
    {
      id: "order-atara",
      customer_company_id: "atara",
      status: "submitted",
      submitted_at: "2026-10-12T07:00:00+00:00",
      order_submission_logs: [],
      daily_order_products: [
        {
          id: "ol-atara-lemon",
          daily_order_id: "order-atara",
          product_variety_id: LEMON,
          pallets_ordered: 1,
          comment: null,
          created_at: "2026-10-12T04:00:00+00:00",
          product_varieties: variety(LEMON),
        },
      ],
    },
    {
      id: "order-kahlon",
      customer_company_id: "kahlon",
      status: "open",
      submitted_at: null,
      order_submission_logs: [],
      daily_order_products: [
        {
          id: "ol-kahlon-lemon",
          daily_order_id: "order-kahlon",
          product_variety_id: LEMON,
          pallets_ordered: 2,
          comment: null,
          created_at: "2026-10-12T03:00:00+00:00",
          product_varieties: variety(LEMON),
        },
      ],
    },
  ];
  // One of grower A's pallets already went to Gabbai.
  const records: BoardRecord[] = [
    {
      id: "record-1",
      daily_pick_product_id: "line-a-lemon",
      daily_order_product_id: "ol-gabbai-lemon",
      customer_company_id: "gabbai",
      quantity_pallets: 1,
      price: null,
      price_type: null,
    },
  ];
  const day = dayToPropose({ tradeDate: "2026-10-12", picks, orders, records });

  // Migration 0089: a closed pick (the truck icon) is not arranged from, so
  // its lots offer nothing to a proposal.
  it("offers nothing off a closed pick's lots, and everything off an open one's", () => {
    const day = dayToPropose({
      tradeDate: "2026-10-12",
      picks: picks.map((pick, index) => (index === 0 ? { ...pick, status: "closed" } : pick)),
      orders,
      records: [],
    });
    const closedLines = new Set(
      picks[0]!.daily_pick_products.map((line) => line.product_varieties?.id),
    );
    const fromClosed = day.lots.filter((lot) => lot.growerId === picks[0]!.grower_company_id);
    expect(fromClosed.length).toBeGreaterThan(0);
    expect(fromClosed.every((lot) => lot.available === 0)).toBe(true);
    expect(closedLines.size).toBeGreaterThan(0);
    const open = dayToPropose({ tradeDate: "2026-10-12", picks, orders, records: [] });
    expect(
      open.lots
        .filter((lot) => lot.growerId === picks[0]!.grower_company_id)
        .some((lot) => lot.available > 0),
    ).toBe(true);
  });

  it("offers what is free on each lot — picked plus carried-in leftover, less what is arranged — as the grid's זמין does", () => {
    expect(day.lots).toEqual([
      { growerId: "grower-a", varietyId: LEMON, available: 8 },
      { growerId: "grower-b", varietyId: LEMON, available: 1 },
    ]);
  });

  it("never offers less than nothing", () => {
    const over = dayToPropose({
      tradeDate: "2026-10-12",
      picks,
      orders,
      records: [{ ...records[0]!, quantity_pallets: 20 }],
    });

    expect(over.lots[0]).toEqual({ growerId: "grower-a", varietyId: LEMON, available: 0 });
  });

  it("dates an order by its first submission, then its last, then the time its line was written", () => {
    expect(day.orders).toEqual([
      {
        customerId: "gabbai",
        varietyId: LEMON,
        quantity: 3,
        orderedAt: "2026-10-12T06:00:00+00:00",
      },
      {
        customerId: "atara",
        varietyId: LEMON,
        quantity: 1,
        orderedAt: "2026-10-12T07:00:00+00:00",
      },
      {
        customerId: "kahlon",
        varietyId: LEMON,
        quantity: 2,
        orderedAt: "2026-10-12T03:00:00+00:00",
      },
    ]);
  });

  it("names the lot, product and customer of every saved allocation", () => {
    expect(day.arranged).toEqual([
      { growerId: "grower-a", varietyId: LEMON, customerId: "gabbai", quantity: 1 },
    ]);
  });

  it("reads a saved allocation's customer off its order line, not off the record's own copy", () => {
    const copyDisagrees = dayToPropose({
      tradeDate: "2026-10-12",
      picks,
      orders,
      records: [{ ...records[0]!, customer_company_id: "someone-else" }],
    });

    expect(copyDisagrees.arranged[0]?.customerId).toBe("gabbai");
  });

  it("lists a saved cell of zero pallets too: it is taken all the same", () => {
    const empty = dayToPropose({
      tradeDate: "2026-10-12",
      picks,
      orders,
      records: [{ ...records[0]!, quantity_pallets: 0 }],
    });

    expect(empty.arranged).toEqual([
      { growerId: "grower-a", varietyId: LEMON, customerId: "gabbai", quantity: 0 },
    ]);
  });

  it("carries the day's date", () => {
    expect(day.date).toBe("2026-10-12");
  });

  it("takes every allocation on a lot off what is free on it, not only the last", () => {
    const two = dayToPropose({
      tradeDate: "2026-10-12",
      picks,
      orders,
      records: [
        records[0]!,
        {
          ...records[0]!,
          id: "record-2",
          daily_order_product_id: "ol-atara-lemon",
          customer_company_id: "atara",
          quantity_pallets: 2,
        },
      ],
    });

    // 5 picked + 4 carried in, less 1 and 2 arranged.
    expect(two.lots[0]).toEqual({ growerId: "grower-a", varietyId: LEMON, available: 6 });
  });

  it("lists no saved allocation on a lot that is not offered", () => {
    const offNoLot = dayToPropose({
      tradeDate: "2026-10-12",
      picks,
      orders,
      records: [
        { ...records[0]!, id: "record-orphan", daily_pick_product_id: "line-a-orphan" },
        { ...records[0]!, id: "record-nobody", daily_pick_product_id: "line-nobody" },
      ],
    });

    expect(offNoLot.arranged).toEqual([]);
  });

  it("reads a saved allocation's customer off the record's own copy when its order line is not among the orders", () => {
    const withdrawn = dayToPropose({
      tradeDate: "2026-10-12",
      picks,
      orders,
      records: [
        { ...records[0]!, daily_order_product_id: "ol-withdrawn", customer_company_id: "dana" },
      ],
    });

    expect(withdrawn.arranged).toEqual([
      { growerId: "grower-a", varietyId: LEMON, customerId: "dana", quantity: 1 },
    ]);
  });

  it("counts an order line whose product did not come back under the line's own product id, as the grid does", () => {
    const productless: BoardOrder = {
      id: "order-dana",
      customer_company_id: "dana",
      status: "submitted",
      submitted_at: "2026-10-12T08:00:00+00:00",
      order_submission_logs: [],
      daily_order_products: [
        {
          id: "ol-dana-lemon",
          daily_order_id: "order-dana",
          product_variety_id: LEMON,
          pallets_ordered: 2,
          comment: null,
          product_varieties: null,
        },
      ],
    };

    const unknown = dayToPropose({
      tradeDate: "2026-10-12",
      picks,
      orders: [productless],
      records: [],
    });

    expect(unknown.orders).toEqual([
      { customerId: "dana", varietyId: LEMON, quantity: 2, orderedAt: "2026-10-12T08:00:00+00:00" },
    ]);
  });

  describe("the date of an order", () => {
    // One order of dana's for lemons, submitted at each of `times`, in the
    // order the rows arrive in.
    const submittedAt = (...times: string[]): BoardOrder => ({
      id: "order-dana",
      customer_company_id: "dana",
      status: "submitted",
      submitted_at: "2026-10-12T12:00:00+00:00",
      order_submission_logs: times.map((created_at, index) => ({
        id: `log-${index}`,
        created_at,
        snapshot: [],
      })),
      daily_order_products: [
        {
          id: "ol-dana-lemon",
          daily_order_id: "order-dana",
          product_variety_id: LEMON,
          pallets_ordered: 1,
          comment: null,
          product_varieties: variety(LEMON),
        },
      ],
    });
    const orderedAtOf = (order: BoardOrder) =>
      dayToPropose({ tradeDate: "2026-10-12", picks, orders: [order], records: [] }).orders[0]
        ?.orderedAt;

    it("is its first submission, by the moment and not the text, when the logs are in different time zones", () => {
      // 09:00 at +03:00 is 06:00 UTC: earlier than 07:00Z, though "09" sorts after "07".
      const early = "2026-10-12T09:00:00+03:00";
      const late = "2026-10-12T07:00:00Z";

      expect(orderedAtOf(submittedAt(early, late))).toBe(early);
      expect(orderedAtOf(submittedAt(late, early))).toBe(early);
    });

    it("stays a readable time when a later log's time cannot be read", () => {
      expect(orderedAtOf(submittedAt("2026-10-12T06:00:00+00:00", "not a time"))).toBe(
        "2026-10-12T06:00:00+00:00",
      );
    });

    it("is a readable time even when a log whose time cannot be read comes first", () => {
      expect(orderedAtOf(submittedAt("not a time", "2026-10-12T06:00:00+00:00"))).toBe(
        "2026-10-12T06:00:00+00:00",
      );
    });

    it("is when it was last submitted when no log's time can be read", () => {
      expect(orderedAtOf(submittedAt("not a time", "nor this"))).toBe("2026-10-12T12:00:00+00:00");
    });
  });
});

describe("customerFactsFrom", () => {
  it("gives every customer the day they were created", () => {
    const facts = customerFactsFrom({
      customers: [
        { id: "gabbai", created_at: "2025-03-01T10:00:00+00:00" },
        { id: "atara", created_at: "2026-10-01T23:30:00+00:00" },
      ],
    });

    expect(facts).toEqual({
      gabbai: { since: "2025-03-01" },
      atara: { since: "2026-10-01" },
    });
  });
});

describe("proposeForDay", () => {
  // Kumquats are new today — in no day of the history — and one pallet came
  // in for two orders. Gabbai has bought citrus on every day it sold; Atara
  // never has, but ordered first.
  const KUMQUAT = "variety-kumquat";
  const tradeDate = "2026-10-12";
  const picks: BoardPick[] = [
    {
      id: "pick-a",
      grower_company_id: "grower-a",
      status: "submitted",
      pickup_time: null,
      daily_pick_products: [
        {
          id: "line-a-kumquat",
          daily_pick_id: "pick-a",
          product_variety_id: KUMQUAT,
          pallets_picked: 1,
          leftover_pallets: 0,
          comment: null,
          product_varieties: variety(KUMQUAT),
        },
      ],
    },
  ];
  const orderFor = (customer: string, at: string): BoardOrder => ({
    id: `order-${customer}`,
    customer_company_id: customer,
    status: "submitted",
    submitted_at: at,
    order_submission_logs: [],
    daily_order_products: [
      {
        id: `ol-${customer}-kumquat`,
        daily_order_id: `order-${customer}`,
        product_variety_id: KUMQUAT,
        pallets_ordered: 1,
        comment: null,
        product_varieties: variety(KUMQUAT),
      },
    ],
  });
  const orders = [
    orderFor("atara", "2026-10-12T06:00:00+00:00"),
    orderFor("gabbai", "2026-10-12T09:00:00+00:00"),
  ];
  const learnedFrom = {
    history: [
      {
        date: "2026-10-01",
        supply: { [LEMON]: 1 },
        orders: { [LEMON]: { gabbai: 1 } },
        recorded: { [LEMON]: { gabbai: 1 } },
      },
    ],
    familyOf: { [LEMON]: CITRUS },
    customers: {
      atara: { since: null },
      gabbai: { since: null },
    },
  };

  it("judges a product first sold today by its family, from the day's own lots", () => {
    expect(proposeForDay({ tradeDate, picks, orders, records: [], learnedFrom })).toEqual([
      {
        growerId: "grower-a",
        varietyId: KUMQUAT,
        customerId: "gabbai",
        quantity: 1,
        forOrder: "suggested",
      },
    ]);
  });

  it("proposes nothing onto a cell that is already arranged", () => {
    const saved: BoardRecord = {
      id: "record-atara",
      daily_pick_product_id: "line-a-kumquat",
      daily_order_product_id: "ol-atara-kumquat",
      customer_company_id: "atara",
      quantity_pallets: 1,
      price: null,
      price_type: null,
    };

    expect(proposeForDay({ tradeDate, picks, orders, records: [saved], learnedFrom })).toEqual([]);
  });

  it("works around a lot whose product did not come back", () => {
    const withOrphan: BoardPick[] = [
      {
        ...picks[0]!,
        daily_pick_products: [
          ...picks[0]!.daily_pick_products,
          {
            id: "line-a-orphan",
            daily_pick_id: "pick-a",
            product_variety_id: "variety-gone",
            pallets_picked: 9,
            leftover_pallets: 0,
            comment: null,
            product_varieties: null,
          },
        ],
      },
    ];

    expect(
      proposeForDay({ tradeDate, picks: withOrphan, orders, records: [], learnedFrom }),
    ).toEqual(proposeForDay({ tradeDate, picks, orders, records: [], learnedFrom }));
  });

  it("marks every line it proposes as suggested", () => {
    const plenty: BoardPick[] = [
      {
        ...picks[0]!,
        daily_pick_products: [{ ...picks[0]!.daily_pick_products[0]!, pallets_picked: 5 }],
      },
    ];
    const lines = proposeForDay({ tradeDate, picks: plenty, orders, records: [], learnedFrom });

    expect(lines.map((line) => line.customerId).sort()).toEqual(["atara", "gabbai"]);
    expect(lines.map((line) => line.forOrder)).toEqual(["suggested", "suggested"]);
  });

  // Workbook Task 35: the half pallet is proposed too, now that an
  // arrangement may be part of a pallet — and still nothing beyond the lot.
  it("proposes all a lot holds and no more when what it holds is part of a pallet", () => {
    const partOfAPallet: BoardPick[] = [
      {
        ...picks[0]!,
        daily_pick_products: [{ ...picks[0]!.daily_pick_products[0]!, pallets_picked: 2.5 }],
      },
    ];
    const twoEach = orders.map((order) => ({
      ...order,
      daily_order_products: order.daily_order_products.map((line) => ({
        ...line,
        pallets_ordered: 2,
      })),
    }));
    const lines = proposeForDay({
      tradeDate,
      picks: partOfAPallet,
      orders: twoEach,
      records: [],
      learnedFrom,
    });

    expect(lines.reduce((sum, line) => sum + line.quantity, 0)).toBe(2.5);
  });

  it("judges who is a newcomer as of the day's trade date", () => {
    const customers = {
      gabbai: { since: "2025-01-01" },
      // Created 11 days before the day: no habits yet, so the lowest product
      // score — level with Gabbai, who has none — and not the 5 that ordering
      // citrus on its one day below would give.
      atara: { since: "2026-10-01" },
    };
    const history = [
      {
        date: "2026-10-02",
        supply: { [LEMON]: 1 },
        orders: { [LEMON]: { atara: 1 } },
        recorded: {},
      },
    ];
    const gabbaiFirst = [
      orderFor("gabbai", "2026-10-12T06:00:00+00:00"),
      orderFor("atara", "2026-10-12T09:00:00+00:00"),
    ];

    expect(
      proposeForDay({
        tradeDate,
        picks,
        orders: gabbaiFirst,
        records: [],
        learnedFrom: { history, familyOf: { [LEMON]: CITRUS }, customers },
      }).map((line) => line.customerId),
    ).toEqual(["gabbai"]);
  });

  it("serves an order with no time at all after an equal one that has a time", () => {
    // "a-untimed" would come first on its id alone.
    const untimed: BoardOrder = { ...orderFor("a-untimed", ""), submitted_at: null };
    const timed = orderFor("z-timed", "2026-10-12T09:00:00+00:00");

    expect(
      proposeForDay({
        tradeDate,
        picks,
        orders: [untimed, timed],
        records: [],
        learnedFrom: { history: [], familyOf: {}, customers: {} },
      }).map((line) => line.customerId),
    ).toEqual(["z-timed"]);
  });
});

// Workbook Task 36: a customer's preferred grower is only words in the order
// line's comment ("מגדל מועדף: …", written by the order screen's chooser —
// components/customer/preferred-grower.ts), and the client asked that it not
// affect allocation. So the same day with and without one must reach the
// engine as the same day, and come out as the same proposal. (The history the
// engine learns from reads no comments at all: HistoryRows has none.)
describe("a preferred grower in an order line's comment (workbook Task 36)", () => {
  const tradeDate = "2026-11-11";
  // Two growers have lemons: A has 5, B has 2.
  const picks: BoardPick[] = [
    {
      id: "pick-a",
      grower_company_id: "grower-a",
      status: "submitted",
      pickup_time: null,
      daily_pick_products: [
        {
          id: "line-a-lemon",
          daily_pick_id: "pick-a",
          product_variety_id: LEMON,
          pallets_picked: 5,
          leftover_pallets: 0,
          comment: null,
          product_varieties: variety(LEMON),
        },
      ],
    },
    {
      id: "pick-b",
      grower_company_id: "grower-b",
      status: "submitted",
      pickup_time: null,
      daily_pick_products: [
        {
          id: "line-b-lemon",
          daily_pick_id: "pick-b",
          product_variety_id: LEMON,
          pallets_picked: 2,
          leftover_pallets: 0,
          comment: null,
          product_varieties: variety(LEMON),
        },
      ],
    },
  ];
  const orderFor = (customer: string, pallets: number, comment: string | null): BoardOrder => ({
    id: `order-${customer}`,
    customer_company_id: customer,
    status: "submitted",
    submitted_at: "2026-11-11T06:00:00+00:00",
    order_submission_logs: [],
    daily_order_products: [
      {
        id: `ol-${customer}-lemon`,
        daily_order_id: `order-${customer}`,
        product_variety_id: LEMON,
        pallets_ordered: pallets,
        comment,
        product_varieties: variety(LEMON),
      },
    ],
  });
  const withoutPreference = [orderFor("gabbai", 2, "דחוף")];
  // Gabbai would rather have grower B's lemons, chosen from the two that have
  // them.
  const withPreference = [
    orderFor("gabbai", 2, setPreferredGrower("דחוף", "grower-b", ["grower-a", "grower-b"])),
  ];
  const learnedFrom = {
    history: [],
    familyOf: {},
    customers: { gabbai: { since: null } },
  };

  it("carries the preference in the line's comment, as the order screen writes it", () => {
    expect(withPreference[0]!.daily_order_products[0]!.comment).toBe(
      "דחוף · מגדל מועדף: grower-b",
    );
  });

  it("gives the engine the same day with the preference as without it", () => {
    expect(dayToPropose({ tradeDate, picks, orders: withPreference, records: [] })).toEqual(
      dayToPropose({ tradeDate, picks, orders: withoutPreference, records: [] }),
    );
  });

  it("proposes the same arrangement: the lemons still come from the grower with the most", () => {
    const expected = [
      {
        growerId: "grower-a",
        varietyId: LEMON,
        customerId: "gabbai",
        quantity: 2,
        forOrder: "suggested",
      },
    ];
    expect(
      proposeForDay({ tradeDate, picks, orders: withoutPreference, records: [], learnedFrom }),
    ).toEqual(expected);
    expect(
      proposeForDay({ tradeDate, picks, orders: withPreference, records: [], learnedFrom }),
    ).toEqual(expected);
  });
});

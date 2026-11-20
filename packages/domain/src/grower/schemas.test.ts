import { randomUUID } from "node:crypto";

import {
  COMMENT_LENGTH_MESSAGE,
  LEFTOVER_PALLETS_MESSAGE,
  PICKED_PALLETS_MESSAGE,
} from "@ori/shared/limits";
import { describe, expect, it } from "vitest";

import {
  savePickLinesInputSchema,
  setPickPickupTimeInputSchema,
  toSetPickPickupTimeRpcArgs,
} from "./schemas";

// The database's own limits on a pick line (migration 0109), checked by the
// schema every pick save goes through, so the screen answers in Hebrew before
// sending. Found in testing: 4.5, 99,999,999 and a 10,000-character comment
// were all accepted.
describe("savePickLinesInputSchema: the database's limits, told first", () => {
  const messages = (line: Record<string, unknown>) => {
    const result = savePickLinesInputSchema.safeParse({
      dailyPickId: randomUUID(),
      lines: [
        {
          dailyPickProductId: randomUUID(),
          palletsPicked: 3,
          leftoverPallets: 0,
          comment: null,
          ...line,
        },
      ],
    });
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it("takes whole pallets from 0 to 9,999", () => {
    for (const palletsPicked of [0, 1, 128, 9999]) expect(messages({ palletsPicked })).toEqual([]);
  });

  it("refuses a half pallet, a negative and anything above 9,999, in Hebrew", () => {
    for (const palletsPicked of [4.5, -1, 10000, 99999999]) {
      expect(messages({ palletsPicked })).toContain(PICKED_PALLETS_MESSAGE);
    }
  });

  it("takes a leftover up to 99,999 — a tenth too, as a carry-over can be — and refuses above it", () => {
    for (const leftoverPallets of [0, 2.5, 99999])
      expect(messages({ leftoverPallets })).toEqual([]);
    for (const leftoverPallets of [-1, 100000]) {
      expect(messages({ leftoverPallets })).toContain(LEFTOVER_PALLETS_MESSAGE);
    }
  });

  it("takes a comment of 500 characters, and refuses 501", () => {
    expect(messages({ comment: "א".repeat(500) })).toEqual([]);
    expect(messages({ comment: "א".repeat(501) })).toContain(COMMENT_LENGTH_MESSAGE);
  });
});

// The pickup time a grower types is a clock time "HH:MM" (24 hours), the same
// shape a browser's <input type="time"> gives. These tests pin down which
// strings the schema lets through to the database function (0105).
describe("setPickPickupTimeInputSchema", () => {
  const dailyPickId = randomUUID();
  const parse = (pickupTime: string) =>
    setPickPickupTimeInputSchema.safeParse({ dailyPickId, pickupTime });

  it('accepts "07:05" and "23:59"', () => {
    expect(parse("07:05").success).toBe(true);
    expect(parse("23:59").success).toBe(true);
  });

  it('refuses "24:00", "7:5", "" and "14:00:00"', () => {
    for (const bad of ["24:00", "7:5", "", "14:00:00"]) {
      expect(parse(bad).success, bad).toBe(false);
    }
  });

  it("maps to p_daily_pick_id / p_pickup_time", () => {
    expect(toSetPickPickupTimeRpcArgs({ dailyPickId, pickupTime: "06:30" })).toEqual({
      p_daily_pick_id: dailyPickId,
      p_pickup_time: "06:30",
    });
  });
});

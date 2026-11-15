import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { setPickPickupTimeInputSchema, toSetPickPickupTimeRpcArgs } from "./schemas";

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

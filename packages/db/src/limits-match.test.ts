import { readFileSync } from "node:fs";

import {
  MAX_COMMENT_LENGTH,
  MAX_LEFTOVER_PALLETS,
  MAX_ORDERED_PALLETS,
  MAX_PICKED_PALLETS,
} from "@ori/shared/limits";
import { describe, expect, it } from "vitest";

// The limits exist twice: in the database (migration 0109, which refuses a
// row however it is written) and in packages/shared/src/limits.ts (which the
// screens and the zod schemas check first, to answer in Hebrew). If the two
// drift, a screen lets through what the database then refuses with an English
// error — or refuses what the database would take. This reads the migration's
// own text and holds every number in it to the shared one.
const sql = readFileSync(
  new URL("../migrations/0109_pick-and-order-limits.sql", import.meta.url),
  "utf8",
);

// The CHECK expression of one constraint, as the migration writes it.
function checkOf(name: string): string {
  const match = new RegExp(`add constraint ${name}\\s+check \\(([^;]*?)\\)(?:,|;)`, "s").exec(sql);
  if (!match) throw new Error(`constraint ${name} not found in 0109`);
  return match[1]!.replace(/\s+/g, " ");
}

describe("the database's limits (0109) match the screens' (packages/shared/src/limits.ts)", () => {
  it("picked pallets: whole, from 0 to MAX_PICKED_PALLETS", () => {
    expect(checkOf("daily_pick_products_pallets_picked_whole")).toBe(
      "pallets_picked = trunc(pallets_picked)",
    );
    expect(checkOf("daily_pick_products_pallets_picked_range")).toBe(
      `pallets_picked >= 0 and pallets_picked <= ${MAX_PICKED_PALLETS}`,
    );
  });

  it("leftover pallets: a changed leftover is tenths, from 0 to MAX_LEFTOVER_PALLETS", () => {
    const body =
      /create or replace function public\.refuse_leftover_out_of_range\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/.exec(
        sql,
      )?.[1];
    if (!body) throw new Error("refuse_leftover_out_of_range not found in 0109");
    const rule = body.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
    expect(rule).toContain("if new.leftover_pallets is distinct from old.leftover_pallets and (");
    expect(rule).toContain("new.leftover_pallets < 0");
    expect(rule).toContain(`new.leftover_pallets > ${MAX_LEFTOVER_PALLETS}`);
    expect(rule).toContain("new.leftover_pallets <> trunc(new.leftover_pallets, 1)");
  });

  // Opening a day inserts each line with the last day's picked + leftover −
  // arranged, which can pass any limit. A CHECK on leftover_pallets — or a
  // trigger that also fires on INSERT — would refuse that, and with it the
  // opening of the whole day.
  it("never holds a carried-over leftover to the limit: no CHECK on it, and the trigger fires on UPDATE only", () => {
    const leftoverChecks = [...sql.matchAll(/add constraint (\w+)\s+check \(([^;]*?)\)(?:,|;)/gs)]
      .filter(([, , expression]) => /leftover/.test(expression!))
      .map(([, name]) => name);
    expect(leftoverChecks).toEqual([]);
    const trigger = /create trigger daily_pick_products_leftover_range\s+([\s\S]*?);/
      .exec(sql)?.[1]
      ?.replace(/\s+/g, " ");
    expect(trigger).toBe(
      "before update of leftover_pallets on public.daily_pick_products for each row execute function public.refuse_leftover_out_of_range()",
    );
  });

  it("ordered pallets: from 0 to MAX_ORDERED_PALLETS", () => {
    expect(checkOf("daily_order_products_pallets_ordered_range")).toBe(
      `pallets_ordered >= 0 and pallets_ordered <= ${MAX_ORDERED_PALLETS}`,
    );
  });

  it("every comment: up to MAX_COMMENT_LENGTH characters", () => {
    for (const name of [
      "daily_pick_products_comment_length",
      "daily_order_products_comment_length",
      "daily_orders_comment_length",
    ]) {
      expect(checkOf(name)).toBe(`char_length(comment) <= ${MAX_COMMENT_LENGTH}`);
    }
  });
});

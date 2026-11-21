import { COMMENT_LENGTH_MESSAGE, ORDERED_PALLETS_MESSAGE } from "@ori/shared/limits";
import { describe, expect, it } from "vitest";

import {
  sendOrderReminderInputSchema,
  submitOrderInputSchema,
  toSendOrderReminderRpcArgs,
  toSubmitOrderRpcArgs,
} from "./schemas";

const tradingDayId = "00000000-0000-4000-8000-000000000001";

// The database's own limits on an order (migration 0109), checked by the
// schema every order save goes through — the customer's screen and staff's.
describe("submitOrderInputSchema: the database's limits, told first", () => {
  const varietyId = "00000000-0000-4000-8000-000000000002";
  const messages = (input: { pallets?: number; lineComment?: string | null; comment?: string }) => {
    const result = submitOrderInputSchema.safeParse({
      tradingDayId,
      lines: [{ productVarietyId: varietyId, palletsOrdered: input.pallets ?? 1, comment: input.lineComment ?? null }],
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    });
    return result.success ? [] : result.error.issues.map((issue) => issue.message);
  };

  it("takes up to 9,999 pallets on a line, and refuses more", () => {
    expect(messages({ pallets: 9999 })).toEqual([]);
    expect(messages({ pallets: 10000 })).toContain(ORDERED_PALLETS_MESSAGE);
  });

  it("takes line and order comments of 500 characters, and refuses 501", () => {
    expect(messages({ lineComment: "א".repeat(500), comment: "ב".repeat(500) })).toEqual([]);
    expect(messages({ lineComment: "א".repeat(501) })).toContain(COMMENT_LENGTH_MESSAGE);
    expect(messages({ comment: "ב".repeat(501) })).toContain(COMMENT_LENGTH_MESSAGE);
  });
});

// The order comment, "הערה כללית" (migration 0093). submit_order keeps the
// stored comment when p_comment is left out and clears it when sent empty,
// so whether the argument is sent at all is the decision under test.
describe("submit_order args: the order comment (migration 0093)", () => {
  it("sends a comment trimmed", () => {
    const args = toSubmitOrderRpcArgs(
      submitOrderInputSchema.parse({ tradingDayId, lines: [], comment: "  להביא לפני 6 " }),
    );
    expect(args.p_comment).toBe("להביא לפני 6");
  });

  it("left out, does not send p_comment at all, so the stored comment is kept", () => {
    const args = toSubmitOrderRpcArgs(submitOrderInputSchema.parse({ tradingDayId, lines: [] }));
    expect("p_comment" in args).toBe(false);
  });

  it("sends an empty comment, so the stored one is cleared", () => {
    const args = toSubmitOrderRpcArgs(submitOrderInputSchema.parse({ tradingDayId, lines: [], comment: "   " }));
    expect(args.p_comment).toBe("");
  });
});

// The reminder can name the people it goes to (migration 0104). Whether
// p_recipient_user_ids is sent at all is the decision under test: left out,
// the call is today's, and the database uses the company's usual routing.
describe("send_order_reminder args: chosen people (migration 0104)", () => {
  const ID = "00000000-0000-4000-8000-0000000000aa";
  const A = "00000000-0000-4000-8000-0000000000a1";
  const B = "00000000-0000-4000-8000-0000000000b2";

  it("without a list, sends only p_daily_order_id", () => {
    const args = toSendOrderReminderRpcArgs(sendOrderReminderInputSchema.parse({ dailyOrderId: ID }));
    expect(args).toEqual({ p_daily_order_id: ID });
  });

  it("with a list, sends it as p_recipient_user_ids", () => {
    const args = toSendOrderReminderRpcArgs(
      sendOrderReminderInputSchema.parse({ dailyOrderId: ID, recipientUserIds: [A, B] }),
    );
    expect(args).toEqual({ p_daily_order_id: ID, p_recipient_user_ids: [A, B] });
  });

  it("refuses an empty list, a duplicate and a non-uuid", () => {
    expect(sendOrderReminderInputSchema.safeParse({ dailyOrderId: ID, recipientUserIds: [] }).success).toBe(false);
    expect(sendOrderReminderInputSchema.safeParse({ dailyOrderId: ID, recipientUserIds: [A, A] }).success).toBe(false);
    expect(sendOrderReminderInputSchema.safeParse({ dailyOrderId: ID, recipientUserIds: ["nope"] }).success).toBe(false);
  });
});

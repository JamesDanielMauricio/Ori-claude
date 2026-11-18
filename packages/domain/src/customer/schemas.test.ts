import { describe, expect, it } from "vitest";

import {
  sendOrderReminderInputSchema,
  submitOrderInputSchema,
  toSendOrderReminderRpcArgs,
  toSubmitOrderRpcArgs,
} from "./schemas";

const tradingDayId = "00000000-0000-4000-8000-000000000001";

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

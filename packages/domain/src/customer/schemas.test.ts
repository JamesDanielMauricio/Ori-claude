import { describe, expect, it } from "vitest";

import { submitOrderInputSchema, toSubmitOrderRpcArgs } from "./schemas";

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

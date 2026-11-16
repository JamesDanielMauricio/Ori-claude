import { describe, expect, it } from "vitest";

import { canSendAgain, DELIVERY_STATUS, templateLabel, type DeliveryStatus } from "./delivery-labels";

describe("delivery labels", () => {
  it("names every state outbox_delivery_status can return", () => {
    const states: DeliveryStatus[] = ["sent", "skipped", "failed", "expired", "sending", "retrying", "waiting"];
    for (const state of states) expect(DELIVERY_STATUS[state].label).toBeTruthy();
  });

  it("offers 'send again' only for unsent messages that are not being sent and were not skipped", () => {
    expect(canSendAgain("failed")).toBe(true);
    expect(canSendAgain("expired")).toBe(true);
    expect(canSendAgain("retrying")).toBe(true);
    expect(canSendAgain("waiting")).toBe(true);
    expect(canSendAgain("sent")).toBe(false);
    expect(canSendAgain("sending")).toBe(false);
    expect(canSendAgain("skipped")).toBe(false);
  });

  it("names the customer's private copy of a new order (0106)", () => {
    expect(templateLabel("order_submitted_copy", "customer")).toBe("העתק ללקוח ששלח הזמנה");
  });

  it("tells the transporter's copy of the grower message apart, and falls back to the key", () => {
    expect(templateLabel("close_arrangement_grower", "grower")).toBe("סגירת סידור — למגדל");
    expect(templateLabel("close_arrangement_grower", "transporter")).toBe("סגירת סידור — למוביל");
    // 0081: the transporter's own template.
    expect(templateLabel("close_arrangement_grower_transporter", "transporter")).toBe("סגירת סידור — למוביל");
    expect(templateLabel("something_new", "customer")).toBe("something_new");
  });
});

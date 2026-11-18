import { updateArrangementRecordInputSchema } from "@ori/domain/arrangement";
import { saveCustomerInputSchema, saveProductInputSchema } from "@ori/domain/reference-data";
import { describe, expect, it } from "vitest";

import { errorMessage } from "./error-message";

// The errors here are REAL ones, thrown by the same schemas the save buttons
// parse their forms with — so a change in how zod shapes its issues shows up
// here rather than as English JSON in a toast.
function thrownBy(parse: () => unknown): unknown {
  try {
    parse();
  } catch (error) {
    return error;
  }
  throw new Error("expected the schema to reject this input");
}

const validProduct = {
  id: null,
  familyId: "11111111-1111-4111-8111-111111111111",
  name: "זן",
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

describe("errorMessage", () => {
  it("says which price a price type needs (migration 0100)", () => {
    expect(errorMessage(thrownBy(() => saveProductInputSchema.parse({ ...validProduct, priceType: "fixed" })))).toBe(
      'לסוג המחיר "מספר" יש להזין מחיר.',
    );
    expect(
      errorMessage(
        thrownBy(() => saveProductInputSchema.parse({ ...validProduct, priceType: "range", priceRangeFrom: 12, priceRangeTo: 10 })),
      ),
    ).toBe('בטווח המחירים, "מ-" לא יכול להיות גבוה מ"עד".');
  });

  it("says what to fix for a blank required name, instead of the ZodError's JSON", () => {
    const error = thrownBy(() =>
      saveCustomerInputSchema.parse({
        id: null,
        name: "",
        status: "active",
        canSeeProductPrices: false,
        whatsappGroupId: null,
      }),
    );
    expect(errorMessage(error)).toBe("יש למלא את כל שדות החובה.");
  });

  it("explains number problems in words", () => {
    expect(
      errorMessage(thrownBy(() => saveProductInputSchema.parse({ ...validProduct, noOverbooking: 1.5 }))),
    ).toBe("יש להזין מספר שלם.");
    expect(
      errorMessage(
        thrownBy(() => saveProductInputSchema.parse({ ...validProduct, numberOfOrdersPerCustomer: 0 })),
      ),
    ).toBe("המספר שהוזן קטן מדי.");
    expect(
      errorMessage(thrownBy(() => saveProductInputSchema.parse({ ...validProduct, price: Number("x") }))),
    ).toBe("יש להזין מספר.");
    expect(
      errorMessage(
        thrownBy(() =>
          updateArrangementRecordInputSchema.parse({
            id: "11111111-1111-4111-8111-111111111111",
            quantityPallets: 0,
          }),
        ),
      ),
    ).toBe("המספר שהוזן קטן מדי.");
  });

  it("says a quantity takes one decimal place at most (Task 35)", () => {
    expect(
      errorMessage(
        thrownBy(() =>
          updateArrangementRecordInputSchema.parse({
            id: "11111111-1111-4111-8111-111111111111",
            quantityPallets: 0.14,
          }),
        ),
      ),
    ).toBe("כמות משטחים יכולה לכלול ספרה אחת לכל היותר אחרי הנקודה (למשל 0.4).");
  });

  it("asks for a choice when an id is missing", () => {
    expect(errorMessage(thrownBy(() => saveProductInputSchema.parse({ ...validProduct, familyId: "" })))).toBe(
      "יש לבחור ערך מהרשימה.",
    );
  });

  it("passes other errors' own messages through, and never returns an empty string", () => {
    expect(errorMessage({ code: "P0009", message: "OVER_ALLOCATION: too many" })).toBe(
      "OVER_ALLOCATION: too many",
    );
    expect(errorMessage(new Error("network down"))).toBe("network down");
    expect(errorMessage({ message: "" })).toBe("שגיאה לא ידועה");
    expect(errorMessage(null)).toBe("שגיאה לא ידועה");
    expect(errorMessage("text")).toBe("שגיאה לא ידועה");
  });

  it("explains save_pick_lines' refusals, from the function's own messages (migration 0076)", () => {
    expect(
      errorMessage({
        code: "P0006",
        message:
          "CONFLICT: cannot reduce pallets picked + leftover to 3 — 5.00 pallets already arranged to customers for this line",
      }),
    ).toBe("כבר סודרו 5 משטחים מאחד המוצרים ללקוחות, ואי אפשר להוריד את מה שנקטף ואת העודף שלו מתחת לזה.");
    expect(
      errorMessage({ code: "P0007", message: "INVALID_STATE: this pick is closed — no further edits are permitted" }),
    ).toBe("הליקוט סגור, ואי אפשר לשנות אותו.");
    expect(
      errorMessage({
        code: "P0002",
        message: "NOT_FOUND: pick product line 11111111-1111-4111-8111-111111111111 does not exist",
      }),
    ).toBe("אחד המוצרים כבר לא בליקוט. רעננו את הדף ונסו שוב.");
    expect(errorMessage({ code: "42501", message: "FORBIDDEN: not this pick's grower" })).toBe(
      "אין הרשאה לשנות את הליקוט הזה.",
    );
  });

  it("leaves the same codes alone when another function raised them", () => {
    const proposal = "CONFLICT: 2 cell(s) of this proposal were filled after it was read";
    expect(errorMessage({ code: "P0006", message: proposal })).toBe(proposal);
    const submit = "INVALID_STATE: pick 1 is submitted — can only submit from draft";
    expect(errorMessage({ code: "P0007", message: submit })).toBe(submit);
  });

  it("explains a delete refused because the record is in use, and only a delete", () => {
    expect(
      errorMessage({
        code: "23503",
        message: 'update or delete on table "companies" violates foreign key constraint "daily_orders_customer_company_id_fkey" on table "daily_orders"',
      }),
    ).toMatch(/^אי אפשר למחוק — הרשומה כבר בשימוש/);
    const insert = 'insert or update on table "daily_orders" violates foreign key constraint "daily_orders_customer_company_id_fkey"';
    expect(errorMessage({ code: "23503", message: insert })).toBe(insert);
  });

  it("maps the recipient refusals", () => {
    expect(
      errorMessage({ code: "P0008", message: "INVALID_INPUT: choose at least one recipient" }),
    ).toBe("יש לבחור לפחות אדם אחד.");
    expect(
      errorMessage({
        code: "P0008",
        message: "INVALID_INPUT: a recipient is not a user of this customer",
      }),
    ).toBe("אחד המקבלים כבר לא משויך ללקוח הזה. סגרו את החלון ופתחו אותו שוב.");
    const other = "INVALID_INPUT: something else";
    expect(errorMessage({ code: "P0008", message: other })).toBe(other);
  });

  it("maps the reminder refusal for an order the customer already sent, and only that one", () => {
    expect(
      errorMessage({
        code: "P0007",
        message: "INVALID_STATE: cannot send a reminder about an order that's already been submitted",
      }),
    ).toBe("הלקוח כבר שלח את ההזמנה, ואין צורך בתזכורת.");
    const other = "INVALID_STATE: cannot send a reminder about something else";
    expect(errorMessage({ code: "P0007", message: other })).toBe(other);
  });
});

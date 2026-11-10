import { describe, expect, it } from "vitest";

import { taxAccountingLines, toCompanyDetailsForm, toCompanyDetailsRow } from "./company-details";

// What the הנה״ח cell shows — Bubble's two labelled lines.
describe("taxAccountingLines", () => {
  it("shows both numbers, each under its Bubble label", () => {
    expect(taxAccountingLines({ tax_id: "514000000", accounting_id: "77" })).toEqual([
      "ח.פ.: 514000000",
      "מספר בהנה״ח: 77",
    ]);
  });

  it("shows only the number that is set, trimmed", () => {
    expect(taxAccountingLines({ tax_id: null, accounting_id: " 77 " })).toEqual(["מספר בהנה״ח: 77"]);
  });

  it("shows nothing when neither is set", () => {
    expect(taxAccountingLines({ tax_id: "", accounting_id: null })).toEqual([]);
    expect(taxAccountingLines({ tax_id: "   ", accounting_id: "  " })).toEqual([]);
  });
});

// What the row holds while a save is in flight: the same trimming and
// "empty is null" the save function applies, so the cell doesn't flicker.
describe("toCompanyDetailsRow", () => {
  it("trims each field and holds an empty one as null", () => {
    expect(
      toCompanyDetailsRow({ phone: " 050 ", addressLine: "", city: "חדרה", taxId: "  ", accountingId: "9" }),
    ).toEqual({ phone: "050", address_line: null, city: "חדרה", tax_id: null, accounting_id: "9" });
  });
});

describe("toCompanyDetailsForm", () => {
  it("turns unset fields into empty boxes", () => {
    expect(
      toCompanyDetailsForm({ phone: null, address_line: "רחוב הדקל 1", city: null, tax_id: null, accounting_id: "77" }),
    ).toEqual({ phone: "", addressLine: "רחוב הדקל 1", city: "", taxId: "", accountingId: "77" });
  });
});

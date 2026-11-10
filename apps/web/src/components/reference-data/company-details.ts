// A company's own contact and accounting details (migration 0092) — the
// טלפון, כתובת, יישוב and הנה״ח columns the Growers, Customers and Transporters
// screens share. The rules live here, apart from the cells, so they can be
// tested on their own.

// The five columns as a row carries them.
export interface CompanyDetailsRow {
  phone: string | null;
  address_line: string | null;
  city: string | null;
  tax_id: string | null;
  accounting_id: string | null;
}

// The five boxes as an edit form holds them: always text, "" for unset.
export interface CompanyDetailsForm {
  phone: string;
  addressLine: string;
  city: string;
  taxId: string;
  accountingId: string;
}

export const BLANK_COMPANY_DETAILS: CompanyDetailsForm = {
  phone: "",
  addressLine: "",
  city: "",
  taxId: "",
  accountingId: "",
};

export function toCompanyDetailsForm(row: CompanyDetailsRow): CompanyDetailsForm {
  return {
    phone: row.phone ?? "",
    addressLine: row.address_line ?? "",
    city: row.city ?? "",
    taxId: row.tax_id ?? "",
    accountingId: row.accounting_id ?? "",
  };
}

// What the save function will store from these boxes: trimmed, and an empty
// box as null. Used for the optimistic patch, so the row shows exactly what
// the server is about to hold.
export function toCompanyDetailsRow(form: CompanyDetailsForm): CompanyDetailsRow {
  const stored = (value: string) => value.trim() || null;
  return {
    phone: stored(form.phone),
    address_line: stored(form.addressLine),
    city: stored(form.city),
    tax_id: stored(form.taxId),
    accounting_id: stored(form.accountingId),
  };
}

// The הנה״ח cell: Bubble's two labelled lines, each shown only when it has a
// value. An empty list means the cell shows "—".
export function taxAccountingLines(row: Pick<CompanyDetailsRow, "tax_id" | "accounting_id">): string[] {
  const lines: string[] = [];
  const taxId = row.tax_id?.trim();
  const accountingId = row.accounting_id?.trim();
  if (taxId) lines.push(`ח.פ.: ${taxId}`);
  if (accountingId) lines.push(`מספר בהנה״ח: ${accountingId}`);
  return lines;
}

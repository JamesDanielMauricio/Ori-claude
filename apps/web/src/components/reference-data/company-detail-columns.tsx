import { COMPANY_DETAIL_MAX_LENGTH } from "@ori/domain/reference-data";

import { inputClassName } from "@/components/reference-data/form-field";
import type { RecordTableColumn } from "@/components/reference-data/record-table";

import { taxAccountingLines, type CompanyDetailsForm, type CompanyDetailsRow } from "./company-details";

// The טלפון, כתובת, יישוב and הנה״ח columns (migration 0092) — one definition
// for the Growers, Customers and Transporters screens, the way
// contact-person-cell.tsx is one איש קשר cell for all three. Split around
// איש קשר the way Bubble groups them: the three contact columns just before
// it, הנה״ח just after.
export function buildCompanyDetailColumns<Row extends CompanyDetailsRow>({
  details,
  onChange,
}: {
  details: CompanyDetailsForm;
  onChange: (patch: Partial<CompanyDetailsForm>) => void;
}): { beforeContact: RecordTableColumn<Row>[]; afterContact: RecordTableColumn<Row>[] } {
  // Phones and ID numbers are digits and dashes: left-to-right, so "050-1234567"
  // isn't reordered inside the right-to-left table.
  const box = (
    label: string,
    field: keyof CompanyDetailsForm,
    { width, ltr = false, tel = false }: { width: string; ltr?: boolean; tel?: boolean },
  ) => (
    <input
      aria-label={label}
      dir={ltr ? "ltr" : undefined}
      inputMode={tel ? "tel" : undefined}
      maxLength={COMPANY_DETAIL_MAX_LENGTH[field]}
      className={`${inputClassName} ${width}`}
      value={details[field]}
      onChange={(event) => onChange({ [field]: event.target.value })}
    />
  );

  return {
    beforeContact: [
      {
        key: "phone",
        label: "טלפון",
        render: (row) => (row.phone ? <span dir="ltr">{row.phone}</span> : "—"),
        renderEdit: () => box("טלפון", "phone", { width: "w-36", ltr: true, tel: true }),
      },
      {
        key: "address",
        label: "כתובת",
        render: (row) => row.address_line || "—",
        renderEdit: () => box("כתובת", "addressLine", { width: "w-full min-w-[12rem]" }),
      },
      {
        key: "city",
        label: "יישוב",
        render: (row) => row.city || "—",
        renderEdit: () => box("יישוב", "city", { width: "w-32" }),
      },
    ],
    afterContact: [
      {
        key: "taxAccounting",
        label: "הנה״ח",
        render: (row) => {
          const lines = taxAccountingLines(row);
          return lines.length === 0 ? (
            "—"
          ) : (
            <span className="flex flex-col gap-0.5 whitespace-nowrap">
              {lines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </span>
          );
        },
        renderEdit: () => (
          <div className="flex flex-col gap-1.5">
            {box("ח.פ.", "taxId", { width: "w-32", ltr: true })}
            {box("מספר בהנה״ח", "accountingId", { width: "w-32", ltr: true })}
          </div>
        ),
      },
    ],
  };
}

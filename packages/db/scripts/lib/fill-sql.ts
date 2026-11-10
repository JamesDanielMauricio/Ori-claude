// The fill script's writes (spec §8.2), as plain parameterised statements:
// one bulk UPDATE per table, its rows passed as one jsonb parameter ($1).
// The rows are handed over as plain objects: each driver encodes the
// parameter its own way (postgres.js: tx.json(rows) — a pre-stringified
// string would be JSON-encoded a second time and arrive as one jsonb
// string).
//
// Each statement re-checks "still empty" at the moment it writes, so a value
// someone typed in Ori after the script read it is never overwritten, and
// returns the ids it actually wrote. The runner executes them all in ONE
// transaction.

import type { FillPlan } from "./fill-plan";

export interface FillWrites {
  companies: FillPlan["companies"];
  varietyPictures: Array<{ id: string; image_url: string }>;
  // Written only while the family still holds `current` — Ori's link when the
  // plan was made (null: it had none).
  familyPictures: Array<{ id: string; image_url: string; current: string | null }>;
  orderComments: FillPlan["orderComments"];
}

export interface FillStatement {
  label: "companies" | "variety_pictures" | "family_pictures" | "order_comments";
  text: string;
  rows: readonly object[];
}

// A missing key in a row reads as NULL from jsonb_to_recordset, and
// coalesce(stored, NULL) keeps what is stored — so a company row only ever
// fills the fields it carries, and only where they are still empty. The
// contact is set only if that login's profile still exists.
const COMPANIES = `update public.companies c set
  phone = coalesce(c.phone, x.phone),
  address_line = coalesce(c.address_line, x.address_line),
  city = coalesce(c.city, x.city),
  tax_id = coalesce(c.tax_id, x.tax_id),
  accounting_id = coalesce(c.accounting_id, x.accounting_id),
  contact_person_id = coalesce(c.contact_person_id, (select p.user_id from public.profiles p where p.user_id = x.contact_person_id))
from jsonb_to_recordset($1::jsonb) as x(id uuid, phone text, address_line text, city text, tax_id text, accounting_id text, contact_person_id uuid)
where c.id = x.id
returning c.id`;

// The version goes up with the picture, so a products form opened before the
// run gets the normal "changed by someone else" message instead of saving
// the picture away. Nothing else on the row changes.
const VARIETY_PICTURES = `update public.product_varieties v set image_url = x.image_url, version = v.version + 1
from jsonb_to_recordset($1::jsonb) as x(id uuid, image_url text)
where v.id = x.id and v.image_url is null
returning v.id`;

const FAMILY_PICTURES = `update public.product_families f set image_url = x.image_url
from jsonb_to_recordset($1::jsonb) as x(id uuid, image_url text, current text)
where f.id = x.id and f.image_url is not distinct from x.current
returning f.id`;

const ORDER_COMMENTS = `update public.daily_orders o set comment = x.comment
from jsonb_to_recordset($1::jsonb) as x(id uuid, comment text)
where o.id = x.id and o.comment is null
returning o.id`;

export function fillStatements(writes: FillWrites): FillStatement[] {
  const statements: FillStatement[] = [];
  const add = (label: FillStatement["label"], text: string, rows: readonly object[]) => {
    if (rows.length > 0) statements.push({ label, text, rows });
  };
  add("companies", COMPANIES, writes.companies);
  add("variety_pictures", VARIETY_PICTURES, writes.varietyPictures);
  add("family_pictures", FAMILY_PICTURES, writes.familyPictures);
  add("order_comments", ORDER_COMMENTS, writes.orderComments);
  return statements;
}

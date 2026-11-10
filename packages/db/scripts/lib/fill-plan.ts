// What the fill script would write, decided up front from three things it has
// read — a Bubble export, the import's id record (_bubble_migration_id_map)
// and Ori's current values — without touching anything. Spec §8.2.
//
// The rules:
// - Only empty fields are filled. A value already in Ori was put there in
//   Ori, and Ori wins.
// - The one exception: a family picture whose link still points at Bubble's
//   CDN is replaced by Ori's own copy of that same picture.
// - A contact must be a login that exists in Ori; one that doesn't is
//   reported, never guessed.

import {
  companyDetailsFromBubble,
  familyPictureFromBubble,
  isBubblePictureUrl,
  mainContactBubbleId,
  orderCommentFromBubble,
  varietyPictureFromBubble,
  type BubbleRecord,
  type CompanyDetailColumn,
} from "./bubble-extras";

// Bubble id -> Ori id, per entity type in _bubble_migration_id_map.
export interface IdMaps {
  company: ReadonlyMap<string, string>;
  user: ReadonlyMap<string, string>;
  productfamily: ReadonlyMap<string, string>;
  productvarieties: ReadonlyMap<string, string>;
  dailyorder: ReadonlyMap<string, string>;
}

// Ori's current values, keyed by Ori id.
export interface OriSnapshot {
  companies: ReadonlyMap<string, Record<CompanyDetailColumn | "contact_person_id", string | null>>;
  varieties: ReadonlyMap<string, string | null>; // image_url
  families: ReadonlyMap<string, string | null>; // image_url
  orders: ReadonlyMap<string, string | null>; // comment
  profileIds: ReadonlySet<string>;
}

export type FillField = CompanyDetailColumn | "contact_person_id" | "variety_picture" | "family_picture" | "order_comment";

export const FILL_FIELDS: readonly FillField[] = [
  "phone",
  "address_line",
  "city",
  "tax_id",
  "accounting_id",
  "contact_person_id",
  "variety_picture",
  "family_picture",
  "order_comment",
];

export interface FieldReport {
  filled: number;
  alreadySet: number;
  noOriRow: number;
  problems: Array<{ oriId: string | null; reason: string }>;
}

export interface FillExport {
  company: BubbleRecord[];
  productvarieties: BubbleRecord[];
  productfamily: BubbleRecord[];
  dailyorder: BubbleRecord[];
}

export interface FillPlan {
  companies: Array<{ id: string } & Partial<Record<CompanyDetailColumn | "contact_person_id", string>>>;
  varietyPictures: Array<{ id: string; source: string }>;
  // `current` is Ori's link when the plan was made — the write happens only
  // while the family still holds it (a stale form may have changed it since).
  familyPictures: Array<{ id: string; source: string; current: string | null }>;
  orderComments: Array<{ id: string; comment: string }>;
  report: Record<FillField, FieldReport>;
}

const DETAIL_COLUMNS: readonly CompanyDetailColumn[] = ["phone", "address_line", "city", "tax_id", "accounting_id"];

export function emptyReport(): Record<FillField, FieldReport> {
  const report = {} as Record<FillField, FieldReport>;
  for (const field of FILL_FIELDS) report[field] = { filled: 0, alreadySet: 0, noOriRow: 0, problems: [] };
  return report;
}

export function planFill(data: FillExport, ids: IdMaps, ori: OriSnapshot): FillPlan {
  const report = emptyReport();
  const plan: FillPlan = { companies: [], varietyPictures: [], familyPictures: [], orderComments: [], report };

  // ---- companies: the five details and the contact
  for (const record of data.company) {
    const oriId = ids.company.get(record._id);
    const current = oriId ? ori.companies.get(oriId) : undefined;
    const details = companyDetailsFromBubble(record);
    const contactBubbleId = mainContactBubbleId(record);
    const row: FillPlan["companies"][number] = { id: oriId ?? "" };

    for (const column of DETAIL_COLUMNS) {
      const value = details[column];
      if (value === null) continue;
      if (!oriId || !current) report[column].noOriRow += 1;
      else if (current[column] !== null) report[column].alreadySet += 1;
      else {
        row[column] = value;
        report[column].filled += 1;
      }
    }

    if (contactBubbleId) {
      const contact = report.contact_person_id;
      if (!oriId || !current) contact.noOriRow += 1;
      else if (current.contact_person_id !== null) contact.alreadySet += 1;
      else {
        const login = ids.user.get(contactBubbleId);
        if (!login || !ori.profileIds.has(login)) contact.problems.push({ oriId, reason: "contact login not in Ori" });
        else {
          row.contact_person_id = login;
          contact.filled += 1;
        }
      }
    }

    if (oriId && Object.keys(row).length > 1) plan.companies.push(row);
  }

  // ---- variety pictures
  for (const record of data.productvarieties) {
    const picture = varietyPictureFromBubble(record);
    if (!picture) continue;
    const oriId = ids.productvarieties.get(record._id);
    if (!oriId || !ori.varieties.has(oriId)) report.variety_picture.noOriRow += 1;
    else if (ori.varieties.get(oriId) !== null) report.variety_picture.alreadySet += 1;
    else {
      plan.varietyPictures.push({ id: oriId, source: picture });
      report.variety_picture.filled += 1;
    }
  }

  // ---- family pictures: walked over Ori's families, so a family whose
  // Bubble record has since gone still loses its Bubble link.
  const bubbleFamilyByOriId = new Map<string, BubbleRecord>();
  for (const record of data.productfamily) {
    const oriId = ids.productfamily.get(record._id);
    if (oriId && ori.families.has(oriId)) bubbleFamilyByOriId.set(oriId, record);
    else if (familyPictureFromBubble(record)) report.family_picture.noOriRow += 1;
  }
  for (const [oriId, current] of ori.families) {
    if (current !== null && isBubblePictureUrl(current)) {
      plan.familyPictures.push({ id: oriId, source: current, current });
      report.family_picture.filled += 1;
    } else if (current === null) {
      const record = bubbleFamilyByOriId.get(oriId);
      const picture = record ? familyPictureFromBubble(record) : null;
      if (picture) {
        plan.familyPictures.push({ id: oriId, source: picture, current: null });
        report.family_picture.filled += 1;
      }
    } else {
      report.family_picture.alreadySet += 1;
    }
  }

  // ---- order comments
  for (const record of data.dailyorder) {
    const comment = orderCommentFromBubble(record);
    if (!comment) continue;
    const oriId = ids.dailyorder.get(record._id);
    if (!oriId || !ori.orders.has(oriId)) report.order_comment.noOriRow += 1;
    else if (ori.orders.get(oriId) !== null) report.order_comment.alreadySet += 1;
    else {
      plan.orderComments.push({ id: oriId, comment });
      report.order_comment.filled += 1;
    }
  }

  return plan;
}

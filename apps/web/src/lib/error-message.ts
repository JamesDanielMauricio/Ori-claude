// The sentence a failed action's toast shows, from whatever the action threw.
//
// Most failures already carry a readable message — a PostgREST error, one of
// the API's Hebrew tRPC errors. The exception is input validation: every save
// runs its form through a zod schema (packages/domain) before calling the
// server, and a ZodError's `message` is a JSON dump of its issues in English —
// which is what saving a blank name used to put in front of the user. It is
// recognised by `name` rather than `instanceof` because apps/web doesn't
// depend on zod directly.

import { PALLET_QUANTITY_MESSAGE } from "@ori/shared/pallets";
import { PRICE_TYPE_MESSAGES } from "@ori/shared/price-type";

interface ValidationIssue {
  code?: unknown;
  type?: unknown;
  expected?: unknown;
  validation?: unknown;
  message?: unknown;
}

function validationMessage(issue: ValidationIssue | undefined): string {
  // A quantity with a second decimal place (workbook Task 35) — the order and
  // arrangement schemas' own Hebrew message.
  if (issue?.code === "custom" && issue.message === PALLET_QUANTITY_MESSAGE) return PALLET_QUANTITY_MESSAGE;
  // A product's price that its price type needs (migration 0100) — the
  // product schema's own Hebrew messages.
  if (issue?.code === "custom" && typeof issue.message === "string" && PRICE_TYPE_MESSAGES.includes(issue.message)) {
    return issue.message;
  }
  if (issue?.code === "too_small" && issue.type === "string") return "יש למלא את כל שדות החובה.";
  if (issue?.code === "invalid_string" && issue.validation === "uuid") return "יש לבחור ערך מהרשימה.";
  if (issue?.code === "invalid_type" && issue.expected === "integer") return "יש להזין מספר שלם.";
  if (issue?.code === "invalid_type" && issue.expected === "number") return "יש להזין מספר.";
  if (issue?.code === "too_small" && issue.type === "number") return "המספר שהוזן קטן מדי.";
  if (issue?.code === "too_big" && issue.type === "number") return "המספר שהוזן גדול מדי.";
  return "הנתונים שהוזנו אינם תקינים — בדוק את השדות ונסה שוב.";
}

// Deleting a record that other records still point to (a customer with
// orders, a grower with picks, a product that was sold) is refused by the
// database with Postgres's own English text (workbook Task 32). Only the
// delete case is translated: the same code on an insert or update means a
// missing reference, and keeps its own message.
const IN_USE_ON_DELETE = "אי אפשר למחוק — הרשומה כבר בשימוש (בהזמנות, בליקוטים או בסידורים). אפשר להפוך אותה ללא פעילה במקום.";

// save_pick_lines' refusals (migration 0076), which used to reach the toast in
// the function's own English — the pick editor's "שמור" and the "בשם מגדל"
// picking upload both call it. Each is recognised by its message as well as
// its code, because the codes are shared: P0006 is also a proposal cell
// filled while it was being saved (0085), P0007 every forward-only status
// check, P0002 any missing row.
//
// Worded for everyone who saves a pick: the grower on their own screen reads
// these too (the same editor, routes/grower/picks.tsx), so nothing here
// points at a control only the office has, such as the arrangement board's
// truck icon — the upload dialog says that part itself.
//
// The floor's message names the number already arranged but not the line it
// was on, so neither does this (the upload's preview names the row itself
// before saving, lib/picking-import.ts).
const PICK_BELOW_ARRANGED =
  /^CONFLICT: cannot reduce pallets picked(?: \+ leftover)? to \S+ — (\S+) pallets already arranged/;

function pickSaveRefusal(code: unknown, message: string): string | null {
  if (code === "P0006") {
    const arranged = PICK_BELOW_ARRANGED.exec(message)?.[1];
    if (arranged !== undefined) {
      return `כבר סודרו ${Number(arranged)} משטחים מאחד המוצרים ללקוחות, ואי אפשר להוריד את מה שנקטף ואת העודף שלו מתחת לזה.`;
    }
  }
  if (code === "P0007" && message.startsWith("INVALID_STATE: this pick is closed")) {
    return "הליקוט סגור, ואי אפשר לשנות אותו.";
  }
  if (code === "P0002" && message.startsWith("NOT_FOUND: pick product line")) {
    return "אחד המוצרים כבר לא בליקוט. רעננו את הדף ונסו שוב.";
  }
  if (code === "42501" && message.startsWith("FORBIDDEN: not this pick's grower")) {
    return "אין הרשאה לשנות את הליקוט הזה.";
  }
  return null;
}

// send_order_reminder's two refusals about the chosen recipients (P0008, the
// code every INVALID_INPUT shares — hence the message check as well).
function reminderRecipientRefusal(code: unknown, message: string): string | null {
  if (code !== "P0008") return null;
  if (message.startsWith("INVALID_INPUT: choose at least one recipient")) {
    return "יש לבחור לפחות אדם אחד.";
  }
  if (message.startsWith("INVALID_INPUT: a recipient is not a user of this customer")) {
    return "אחד המקבלים כבר לא משויך ללקוח הזה. סגרו את החלון ופתחו אותו שוב.";
  }
  return null;
}

// send_order_reminder when the customer submitted while the window was open
// (P0007). Matched on the message too: other P0007 refusals mean other things
// and keep showing as they are.
function reminderAlreadySubmittedRefusal(code: unknown, message: string): string | null {
  if (
    code === "P0007" &&
    message.startsWith("INVALID_STATE: cannot send a reminder about an order that's already been submitted")
  ) {
    return "הלקוח כבר שלח את ההזמנה, ואין צורך בתזכורת.";
  }
  return null;
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const { name, issues, message, code } = error as { name?: unknown; issues?: unknown; message?: unknown; code?: unknown };
    if (name === "ZodError" && Array.isArray(issues)) {
      return validationMessage(issues[0] as ValidationIssue | undefined);
    }
    if (code === "23503" && typeof message === "string" && message.startsWith("update or delete on table")) {
      return IN_USE_ON_DELETE;
    }
    if (typeof message === "string") {
      const refusal = pickSaveRefusal(code, message);
      if (refusal) return refusal;
      const recipientRefusal = reminderRecipientRefusal(code, message);
      if (recipientRefusal) return recipientRefusal;
      const submittedRefusal = reminderAlreadySubmittedRefusal(code, message);
      if (submittedRefusal) return submittedRefusal;
    }
    if (typeof message === "string" && message) return message;
  }
  return "שגיאה לא ידועה";
}

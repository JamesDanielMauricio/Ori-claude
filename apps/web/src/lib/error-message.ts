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

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const { name, issues, message, code } = error as { name?: unknown; issues?: unknown; message?: unknown; code?: unknown };
    if (name === "ZodError" && Array.isArray(issues)) {
      return validationMessage(issues[0] as ValidationIssue | undefined);
    }
    if (code === "23503" && typeof message === "string" && message.startsWith("update or delete on table")) {
      return IN_USE_ON_DELETE;
    }
    if (typeof message === "string" && message) return message;
  }
  return "שגיאה לא ידועה";
}

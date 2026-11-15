import type { SelectOption } from "@/components/ui/select";

// The status filter and counter on the two "on behalf of" office screens
// (בשם מגדל / בשם לקוח). Kept as plain functions so the screens only wire
// them up and the rules can be tested without rendering anything.

// "none" is a company with no pick / order at all today — a state of its own
// so it can be filtered for, and left out of the counter's total.
export type GrowerPickState = "draft" | "submitted" | "closed" | "none";
export type CustomerOrderState = "open" | "submitted" | "none";

export function growerPickState(
  pick: { status: "draft" | "submitted" | "closed" } | null,
): GrowerPickState {
  return pick ? pick.status : "none";
}

export function customerOrderState(
  order: { status: "open" | "submitted" } | null,
): CustomerOrderState {
  return order ? order.status : "none";
}

export type StatusFilter<S extends string> = "all" | S;

export function matchesFilter<S extends string>(state: S, filter: StatusFilter<S>): boolean {
  return filter === "all" || state === filter;
}

// "X of Y": Y counts every company that has a pick / order (so not "none"),
// X those already in a finished state.
export function progressCount<S extends string>(
  states: readonly S[],
  done: readonly S[],
): { done: number; total: number } {
  let doneCount = 0;
  let total = 0;
  for (const state of states) {
    if ((state as string) === "none") continue;
    total += 1;
    if (done.includes(state)) doneCount += 1;
  }
  return { done: doneCount, total };
}

export const GROWER_FILTER_OPTIONS: readonly SelectOption<StatusFilter<GrowerPickState>>[] = [
  { value: "all", label: "הכול" },
  { value: "draft", label: "טיוטה" },
  { value: "submitted", label: "נשלח" },
  { value: "closed", label: "סגור" },
  { value: "none", label: "ללא ליקוט" },
];

export const CUSTOMER_FILTER_OPTIONS: readonly SelectOption<StatusFilter<CustomerOrderState>>[] = [
  { value: "all", label: "הכול" },
  { value: "open", label: "פתוחה" },
  { value: "submitted", label: "נשלחה" },
  { value: "none", label: "ללא הזמנה" },
];

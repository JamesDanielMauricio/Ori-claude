import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { ProposalLine } from "./arrangement-proposal";

// The products grid's unsaved changes, held per trading day, in memory only
// (spec 4.4): nothing is written to localStorage or sessionStorage.
//
// Why it lives here and what empties it:
//  - It is mounted in the backoffice layout, above the routed page, so it
//    outlives each screen: leaving the grid and coming back finds the changes.
//  - lib/providers.tsx remounts everything below its keyed ToastProvider
//    whenever the account changes (see lib/account-scope.ts), so this store
//    starts empty again on sign-out or an account switch. No sign-out
//    handling is needed here.
//  - A page reload empties it, because it is only React state. That is
//    deliberate.
export interface UnsavedDay {
  lines: ProposalLine[];
  refusal: string | null;
}

// Frozen so no caller can mutate the shared empty value by accident. The
// array inside stays a plain (unfrozen) ProposalLine[] to match the type;
// nothing may ever push to it.
export const EMPTY_UNSAVED_DAY: UnsavedDay = Object.freeze({ lines: [], refusal: null });

// Pure so it can be unit-tested without React. Returns the same map when the
// update changes nothing (so React skips a re-render), removes the day when it
// ends up with no lines and no message, and otherwise returns a new map.
export function updateUnsavedDay(
  all: ReadonlyMap<string, UnsavedDay>,
  tradingDayId: string,
  update: (current: UnsavedDay) => UnsavedDay,
): ReadonlyMap<string, UnsavedDay> {
  const current = all.get(tradingDayId) ?? EMPTY_UNSAVED_DAY;
  const next = update(current);
  if (next === current) return all;
  const result = new Map(all);
  if (next.lines.length === 0 && next.refusal === null) result.delete(tradingDayId);
  else result.set(tradingDayId, next);
  return result;
}

interface UnsavedChangesState {
  dayOf: (tradingDayId: string) => UnsavedDay;
  updateDay: (tradingDayId: string, update: (current: UnsavedDay) => UnsavedDay) => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesState | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [all, setAll] = useState<ReadonlyMap<string, UnsavedDay>>(new Map());
  // A functional setState inside a useCallback: the identity never changes,
  // and the save's callbacks can call it after the grid has unmounted without
  // reading a stale map.
  const updateDay = useCallback(
    (tradingDayId: string, update: (current: UnsavedDay) => UnsavedDay) => {
      setAll((previous) => updateUnsavedDay(previous, tradingDayId, update));
    },
    [],
  );
  const value = useMemo<UnsavedChangesState>(
    () => ({ dayOf: (tradingDayId) => all.get(tradingDayId) ?? EMPTY_UNSAVED_DAY, updateDay }),
    [all, updateDay],
  );
  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>;
}

export function useUnsavedChanges(): UnsavedChangesState {
  const context = useContext(UnsavedChangesContext);
  if (!context) {
    throw new Error("useUnsavedChanges must be used inside UnsavedChangesProvider");
  }
  return context;
}

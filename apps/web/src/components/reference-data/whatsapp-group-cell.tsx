import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { CellPopover } from "@/components/reference-data/cell-popover";
import { inputClassName } from "@/components/reference-data/form-field";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  WhatsAppGroupsError,
  whatsAppGroupsQueries,
  type WhatsAppGroup,
  type WhatsAppGroupList,
  type WhatsAppGroupsErrorKind,
} from "@/lib/queries/whatsapp-groups";

// The "קבוצת WhatsApp" cell of the Growers, Customers and Transporters
// screens. A company's group is picked from the WhatsApp groups of the
// connected number (lib/queries/whatsapp-groups.ts) instead of typed — the old
// Bubble app's "group IDs (whatsapp)" popup. What the form holds, and what a
// save sends, is unchanged: the bare group id, "" for none.

const NO_GROUP = "ללא קבוצה";

// The words for each reason the list is missing. Short, and saying who can fix
// it: the office can retry, but only whoever runs the system can connect or
// deploy anything.
export const WHATSAPP_GROUPS_ERROR_TEXT: Record<WhatsAppGroupsErrorKind, string> = {
  not_configured: "WhatsApp עוד לא חובר בשרת. פנו למנהל המערכת.",
  channel: "WhatsApp דחה את החיבור — ייתכן שהמספר התנתק. פנו למנהל המערכת.",
  unavailable: "לא הצלחנו לקבל את רשימת הקבוצות כרגע. נסו שוב בעוד רגע.",
  refused: "אין הרשאה לרשימת הקבוצות. התחברו מחדש ונסו שוב.",
  not_deployed: "רשימת הקבוצות עוד לא הופעלה בשרת. פנו למנהל המערכת.",
};

// ------------------------------------------------------------------ reading

// How each group is named outside the picker (the read views and the closed
// cell), by id: its name — and when another of the number's groups has the
// same name, the name with its id. Two groups can share a name, and anyone
// can add the office's number to a group named like a company's own; shown
// by name alone, a company set to the wrong one would look exactly like one
// set to the right one, on every screen, from then on. The id is isolated
// left to right, as everywhere else it is shown.
export function groupDisplayNames(groups: readonly WhatsAppGroup[]): Map<string, string> {
  const key = (name: string) => name.trim().toLocaleLowerCase("he");
  const holders = new Map<string, number>();
  for (const group of groups) holders.set(key(group.name), (holders.get(key(group.name)) ?? 0) + 1);
  return new Map(
    groups.map((group) => [
      group.id,
      (holders.get(key(group.name)) ?? 0) > 1 ? `${group.name} (⁦${group.id}⁩)` : group.name,
    ]),
  );
}

// The group names by id, for the read views and the table search. Empty until
// the list arrives — and for good if it never does: a missing or failing list
// shows on these screens only as the stored ids, never as an error, and never
// holds the table back.
export function useWhatsAppGroupNames(): ReadonlyMap<string, string> {
  const { data } = useQuery(whatsAppGroupsQueries.list());
  return useMemo(() => groupDisplayNames(data?.groups ?? []), [data]);
}

// The read-only cell: the group's name when the list knows the id, else the id
// itself as it was always shown, else "—". A long name wraps at the width the
// other list columns keep to (ContactPersonSummary, CellChipList) rather than
// stretching the table. The id is isolated left-to-right, so an old-style
// "972…-160…" id keeps its order inside the RTL table.
export function WhatsAppGroupSummary({
  id,
  names,
}: {
  id: string | null;
  names: ReadonlyMap<string, string>;
}) {
  if (!id) return "—";
  const name = names.get(id);
  return name ? (
    <span className="block max-w-[14rem] break-words">{name}</span>
  ) : (
    <bdi dir="ltr">{id}</bdi>
  );
}

// What the table search matches a row's group by: its id, as before, and its
// name once the list knows it.
export function whatsAppGroupSearchText(
  id: string | null,
  names: ReadonlyMap<string, string>,
): string {
  if (!id) return "";
  const name = names.get(id);
  return name ? `${id} ${name}` : id;
}

// ------------------------------------------------------------------ picking

export type WhatsAppGroupPanelState =
  | { status: "loading" }
  | { status: "error"; kind: WhatsAppGroupsErrorKind; retrying: boolean; onRetry: () => void }
  | { status: "ready"; list: WhatsAppGroupList };

// A list already on screen stays usable when a later refresh fails; the error
// is shown only when there is no list at all.
function panelStateOf(query: UseQueryResult<WhatsAppGroupList>): WhatsAppGroupPanelState {
  if (query.data) return { status: "ready", list: query.data };
  if (query.isError) {
    return {
      status: "error",
      kind: query.error instanceof WhatsAppGroupsError ? query.error.kind : "unavailable",
      retrying: query.isFetching,
      onRetry: () => void query.refetch(),
    };
  }
  return { status: "loading" };
}

// The groups a search keeps: by name or by id, ignoring case and the spaces
// around what was typed.
export function filterWhatsAppGroups(
  groups: readonly WhatsAppGroup[],
  search: string,
): WhatsAppGroup[] {
  const needle = search.trim().toLocaleLowerCase("he");
  if (!needle) return [...groups];
  return groups.filter(
    (group) =>
      group.name.toLocaleLowerCase("he").includes(needle) ||
      group.id.toLocaleLowerCase("he").includes(needle),
  );
}

// One row of the picker:
//   - none:    "ללא קבוצה" — always first, and always there, so a group can
//              be cleared whatever state the list is in;
//   - current: the saved id when it is not one of the listed groups — before
//              the list has arrived, when it could not be read, or when it is
//              not on it (the number has left that group, or the test number
//              is connected). Shown selected, so it is kept unless changed;
//   - group:   one of the number's groups.
export type WhatsAppGroupOption =
  | { kind: "none"; id: "" }
  | { kind: "current"; id: string; missing: boolean }
  | { kind: "group"; id: string; name: string };

export function whatsAppGroupOptions(
  value: string,
  state: WhatsAppGroupPanelState,
  search: string,
): WhatsAppGroupOption[] {
  const groups = state.status === "ready" ? state.list.groups : [];
  const options: WhatsAppGroupOption[] = [{ kind: "none", id: "" }];
  if (value && !groups.some((group) => group.id === value)) {
    // "Not on the list" only once there is a list to be missing from.
    options.push({ kind: "current", id: value, missing: state.status === "ready" });
  }
  for (const group of filterWhatsAppGroups(groups, search))
    options.push({ kind: "group", ...group });
  return options;
}

// The row Enter would pick (-1 = none): the one the arrow keys or the pointer
// are on, while it is still listed; else the first match while searching;
// else the selected row.
export function activeOptionIndex(
  options: readonly WhatsAppGroupOption[],
  pointedId: string | null,
  search: string,
  value: string,
): number {
  const pointed = options.findIndex((option) => option.id === pointedId);
  if (pointed !== -1) return pointed;
  if (search.trim()) return options.findIndex((option) => option.kind === "group");
  return options.findIndex((option) => option.id === value);
}

// Where an arrow key goes from `from` (-1 = no row yet): round the list, as
// ui/select.tsx's arrows do.
export function stepOptionIndex(from: number, step: 1 | -1, length: number): number {
  if (length === 0) return -1;
  if (from === -1) return step > 0 ? 0 : length - 1;
  return (from + step + length) % length;
}

function OptionRow({
  option,
  domId,
  selected,
  active,
  onPick,
  onHover,
}: {
  option: WhatsAppGroupOption;
  domId: string;
  selected: boolean;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const title =
    option.kind === "none"
      ? NO_GROUP
      : option.kind === "group"
        ? option.name
        : option.missing
          ? "הקבוצה הנוכחית לא נמצאה ברשימה"
          : "הקבוצה הנוכחית";
  return (
    // An option of the listbox, not a button: the search box above keeps the
    // focus, and the arrow keys move `active` (aria-activedescendant) — the
    // same model as ui/select.tsx. A click or tap picks it.
    <div
      id={domId}
      role="option"
      aria-selected={selected}
      onClick={onPick}
      onMouseEnter={onHover}
      // `active` is the row the arrow keys are on: a ring, so it reads on a
      // selected (tinted) row as well as on a plain one.
      className={`flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-start text-sm transition-colors ${
        selected ? "bg-accent-soft font-medium text-accent" : "text-ink hover:bg-surface"
      }${active ? " ring-1 ring-inset ring-accent/40" : ""}`}
    >
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-border">
        {selected && <Icon name="check" className="h-3 w-3" />}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="break-words">{title}</span>
        {/* Isolated left-to-right inside a line that still sits on the RTL
            side, under the name. */}
        {option.kind !== "none" && (
          <span className="truncate text-xs font-normal text-ink-subtle">
            <bdi dir="ltr">{option.id}</bdi>
          </span>
        )}
      </span>
    </div>
  );
}

// The open picker: a search box, a muted note when the list is the test
// number's, and the groups as one single-choice list. Exported on its own so
// each of its states can be drawn without opening a popover.
//
// Keyboard: the search box takes the focus when the panel opens, the arrow
// keys move through the list, Enter picks; Escape closes without picking
// (CellPopover). A screen reader hears the search box as a combobox and the
// highlighted row as its active option.
export function WhatsAppGroupPanel({
  value,
  state,
  onPick,
}: {
  value: string;
  state: WhatsAppGroupPanelState;
  onPick: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  // Which row the arrow keys or the pointer are on, by id; null = the default
  // below.
  const [activeId, setActiveId] = useState<string | null>(null);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const options = whatsAppGroupOptions(value, state, search);
  const activeIndex = activeOptionIndex(options, activeId, search, value);
  const domId = (index: number) => `${listId}-${index}`;

  // After CellPopover has placed the panel (a layout effect), and without
  // scrolling the page: the panel is portaled to the end of <body>, out of
  // the keyboard's reach until something moves the focus into it.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Keeps the active row in view as the arrow keys pass the list's edge.
  // Scrolls the list only, as ui/select.tsx does: scrollIntoView() would also
  // move the page and the panel around it.
  useEffect(() => {
    const box = scrollRef.current;
    const row = activeIndex === -1 ? null : document.getElementById(`${listId}-${activeIndex}`);
    if (!box || !row) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
    }
  }, [activeIndex, listId]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = stepOptionIndex(activeIndex, event.key === "ArrowDown" ? 1 : -1, options.length);
      setActiveId(options[next]?.id ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) onPick(option.id);
    }
  }

  let message: ReactNode = null;
  if (state.status === "loading") {
    message = <p role="status">טוען את הקבוצות…</p>;
  } else if (state.status === "ready" && state.list.groups.length === 0) {
    message = <p>אין קבוצות WhatsApp במספר המחובר.</p>;
  } else if (
    state.status === "ready" &&
    search.trim() &&
    !options.some((option) => option.kind === "group")
  ) {
    message = <p>{`אין תוצאות עבור "${search.trim()}"`}</p>;
  }

  return (
    <>
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex === -1 ? undefined : domId(activeIndex)}
        aria-label="חיפוש קבוצת WhatsApp"
        placeholder="חיפוש קבוצה"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setActiveId(null);
        }}
        onKeyDown={handleKeyDown}
        className={`${inputClassName} mb-2 w-full`}
      />
      {state.status === "ready" && state.list.env === "dev" && (
        <p className="mb-2 text-xs text-ink-muted">
          המערכת במצב פיתוח: אלה הקבוצות של מספר הבדיקה.
        </p>
      )}
      {state.status === "error" && (
        <div
          role="alert"
          className="mb-2 flex flex-col items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger ring-1 ring-inset ring-danger/20"
        >
          <p className="font-semibold">טעינת הקבוצות נכשלה</p>
          <p className="text-ink">{WHATSAPP_GROUPS_ERROR_TEXT[state.kind]}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={state.onRetry}
            disabled={state.retrying}
          >
            {state.retrying ? "טוען…" : "נסו שוב"}
          </Button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="relative flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-lg bg-surface-muted/60 p-2 ring-1 ring-inset ring-border"
      >
        <div
          id={listId}
          role="listbox"
          aria-label="קבוצות WhatsApp"
          className="flex flex-col gap-0.5"
        >
          {options.map((option, index) => (
            <OptionRow
              key={`${option.kind}:${option.id}`}
              option={option}
              domId={domId(index)}
              selected={option.id === value}
              active={index === activeIndex}
              onPick={() => onPick(option.id)}
              onHover={() => setActiveId(option.id)}
            />
          ))}
        </div>
        {message && <div className="px-2.5 py-2 text-sm text-ink-muted">{message}</div>}
      </div>
    </>
  );
}

// What the closed cell shows: the chosen group's name (with its id when
// another group shares the name — groupDisplayNames), its id while the name
// is not known, or "ללא קבוצה".
export function whatsAppGroupSummary(
  value: string,
  list: WhatsAppGroupList | undefined,
): ReactNode {
  if (!value) return NO_GROUP;
  return (list ? groupDisplayNames(list.groups).get(value) : undefined) ?? <bdi dir="ltr">{value}</bdi>;
}

// The editable cell. Picking a row sets the form's id and closes the panel.
export function WhatsAppGroupEditCell({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const query = useQuery(whatsAppGroupsQueries.list());
  return (
    <CellPopover
      label="קבוצת WhatsApp"
      summary={whatsAppGroupSummary(value, query.data)}
      panelClassName="w-80"
    >
      {(close) => (
        <WhatsAppGroupPanel
          value={value}
          state={panelStateOf(query)}
          onPick={(id) => {
            onChange(id);
            close();
          }}
        />
      )}
    </CellPopover>
  );
}

import { useId, useMemo, useState } from "react";

import { checkboxClassName, inputClassName } from "@/components/reference-data/form-field";
import { varietyCountLabel } from "@/components/reference-data/product-catalog/catalog-form";
import { Icon } from "@/components/ui/icon";
import {
  catalogSearchNeedle,
  familiesHoldingSelection,
  familySelectionCounts,
  filterCatalogFamilies,
  type CatalogFamilyGroup,
  type CatalogFamilyProduct,
} from "@/lib/catalog-families";

// The shared shape behind business rules that are, mechanically, "pick a
// subset of the product catalog": a grower's in-season selection (the Growers
// screen, and "בשם מגדל"'s products dialog) and a user's product blacklist
// (the Users screen). One component for all three, so they can't drift apart
// in how they group, order, search or count.
//
// The catalog runs to ~900 varieties in ~78 families, and as one flat list it
// was a wall of near-identical names. So each family is a header that opens
// onto its varieties, as on the Products screen. The picker opens with the
// families that already hold a selection open and every other family
// closed; each header's "נבחרו" count says where the picks are, even for a
// family scrolled out of view. A closed family draws no rows at all:
// opening the picker draws ~78 headers, not ~900 checkboxes.

// What the user has done to the list: the search text, and the families they
// opened or closed.
//
// `chosen` holds only the user's own clicks, laid over the starting layout
// (`startsOpen`: the families holding a selection when the picker opened)
// rather than seeded from it once. "בשם מגדל"'s dialog can open before the
// catalog has arrived, and the families its grower picked must still open
// when the catalog does.
//
// While the search box has text, every family it found is shown open, so a
// match is never hidden behind a closed header. A family closed during a
// search goes in `folded` instead, which the next change to the search
// empties. `chosen` is left alone, so clearing the search brings back the
// layout from before it.
export interface FamilyPickerState {
  query: string;
  chosen: ReadonlyMap<string, boolean>;
  folded: ReadonlySet<string>;
}

export const INITIAL_FAMILY_PICKER_STATE: FamilyPickerState = {
  query: "",
  chosen: new Map(),
  folded: new Set(),
};

export function pickerWithQuery(state: FamilyPickerState, query: string): FamilyPickerState {
  if (catalogSearchNeedle(query) === catalogSearchNeedle(state.query)) return { ...state, query };
  return { ...state, query, folded: new Set() };
}

export function isFamilyOpen(
  state: FamilyPickerState,
  key: string,
  startsOpen: ReadonlySet<string>,
): boolean {
  if (catalogSearchNeedle(state.query) !== "") return !state.folded.has(key);
  return state.chosen.get(key) ?? startsOpen.has(key);
}

export function toggleFamilyOpen(
  state: FamilyPickerState,
  key: string,
  startsOpen: ReadonlySet<string>,
): FamilyPickerState {
  const open = isFamilyOpen(state, key, startsOpen);
  if (catalogSearchNeedle(state.query) !== "") {
    const folded = new Set(state.folded);
    if (open) folded.add(key);
    else folded.delete(key);
    return { ...state, folded };
  }
  const chosen = new Map(state.chosen);
  chosen.set(key, !open);
  return { ...state, chosen };
}

// The ticked count on a family's header, beside its size and only when it is
// above zero. Like varietyCountLabel for the size: Hebrew takes no bare
// numeral before a plural for one.
export function selectedCountLabel(count: number): string {
  return count === 1 ? "נבחר אחד" : `${count} נבחרו`;
}

// The search box ("סינון") and the grouped list under it — what each of the
// three screens mounts. Its host mounts it afresh each time it opens (the
// cell's popover, the dialog once its grower's list is in), and that is
// what makes it start from the layout above every time.
export function ProductFamilyPicker({
  label,
  families,
  selectedIds,
  onToggle,
  disabled = false,
  listClassName = "",
}: {
  // What is being picked, e.g. "מוצרים בעונה". Names the search box.
  label: string;
  families: readonly CatalogFamilyGroup[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  disabled?: boolean;
  // See ProductFamilyList.
  listClassName?: string;
}) {
  const [state, setState] = useState(INITIAL_FAMILY_PICKER_STATE);
  // The selection as it stood when the picker opened. The starting layout is
  // drawn from this rather than from the live selection, so unticking a
  // family's last variety doesn't fold the family shut under the pointer.
  const [startingSelection] = useState(() => new Set(selectedIds));
  const startsOpen = useMemo(
    () => familiesHoldingSelection(families, startingSelection),
    [families, startingSelection],
  );

  return (
    <div className="flex min-h-0 flex-col">
      <input
        type="search"
        value={state.query}
        onChange={(event) => {
          const query = event.target.value;
          setState((current) => pickerWithQuery(current, query));
        }}
        placeholder="סינון"
        aria-label={`סינון ${label}`}
        className={`${inputClassName} mb-2 w-full shrink-0`}
      />
      <ProductFamilyList
        families={families}
        state={state}
        startsOpen={startsOpen}
        selectedIds={selectedIds}
        onToggle={onToggle}
        onToggleFamily={(key) => setState((current) => toggleFamilyOpen(current, key, startsOpen))}
        disabled={disabled}
        listClassName={listClassName}
      />
    </div>
  );
}

// The list half, drawn from the picker's state. Split out so it can be drawn
// mid-search in a test; the picker itself only ever starts with an empty box.
export function ProductFamilyList({
  families,
  state,
  startsOpen,
  selectedIds,
  onToggle,
  onToggleFamily,
  disabled = false,
  listClassName = "",
}: {
  families: readonly CatalogFamilyGroup[];
  state: FamilyPickerState;
  startsOpen: ReadonlySet<string>;
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleFamily: (key: string) => void;
  disabled?: boolean;
  // A height cap, for a host that can't bound the list itself. The cell's
  // popover needs none: its panel is a flex column, so its own cap squeezes
  // the list. "בשם מגדל"'s dialog scrolls its whole body instead, so it caps
  // the list to what its body has room for, keeping the search box and its
  // save button in view either way.
  listClassName?: string;
}) {
  const needle = catalogSearchNeedle(state.query);
  const shown = useMemo(() => filterCatalogFamilies(families, needle), [families, needle]);
  const counts = useMemo(
    () => familySelectionCounts(families, selectedIds),
    [families, selectedIds],
  );
  const idPrefix = useId();

  if (families.length === 0) {
    return <p className="text-sm text-ink-muted">אין פריטים זמינים.</p>;
  }
  if (shown.length === 0) {
    return <p className="text-sm text-ink-muted">{`אין תוצאות עבור "${state.query.trim()}"`}</p>;
  }

  return (
    // The one part that scrolls, under a search box that stays put. A scroll
    // that runs past either end is handed on to whatever holds the list —
    // "בשם מגדל"'s dialog body needs that on a phone held sideways, where its
    // buttons sit below the list. The cell's popover stops it instead (its
    // listClassName), so the page behind the popover doesn't move.
    <div
      className={`flex min-h-0 flex-col gap-0.5 overflow-y-auto rounded-lg bg-surface-muted/60 p-2 ring-1 ring-inset ring-border ${listClassName}`}
    >
      {shown.map((family) => {
        const count = counts.get(family.key) ?? { selected: 0, total: family.products.length };
        return (
          <FamilySection
            key={family.key}
            family={family}
            open={isFamilyOpen(state, family.key, startsOpen)}
            selectedCount={count.selected}
            totalCount={count.total}
            selectedIds={selectedIds}
            onToggle={onToggle}
            onToggleFamily={onToggleFamily}
            disabled={disabled}
            idPrefix={`${idPrefix}-${family.key}`}
          />
        );
      })}
    </div>
  );
}

function FamilySection({
  family,
  open,
  selectedCount,
  totalCount,
  selectedIds,
  onToggle,
  onToggleFamily,
  disabled,
  idPrefix,
}: {
  // Mid-search, only the varieties the search left standing.
  family: CatalogFamilyGroup;
  open: boolean;
  // Over the whole family, whatever the search left (familySelectionCounts).
  selectedCount: number;
  totalCount: number;
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleFamily: (key: string) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  const panelId = `${idPrefix}-products`;
  const countsId = `${idPrefix}-counts`;
  return (
    <div>
      {/* The whole header is the toggle, counts included, so it is one wide
          target on a phone. Its name is "הרחב/כווץ <family>", as on the
          Products screen; the counts inside it reach a screen reader as its
          description, since a labelled button's own text is not read. */}
      <button
        type="button"
        onClick={() => onToggleFamily(family.key)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${open ? "כווץ" : "הרחב"} ${family.name}`}
        aria-describedby={countsId}
        className="group flex w-full items-center gap-2 rounded-md px-2.5 py-2.5 text-start text-sm text-ink transition-colors hover:bg-surface"
      >
        <Icon
          name="chevronDown"
          className={`h-4 w-4 shrink-0 transition-[transform,color] duration-300 ease-[cubic-bezier(0.22,0.61,0.36,1)] ${
            open ? "rotate-180 text-accent" : "text-ink-muted group-hover:text-accent"
          }`}
        />
        <span className="min-w-0 flex-1 truncate font-semibold">{family.name}</span>
        <span id={countsId} className="flex shrink-0 items-center gap-1.5">
          {selectedCount > 0 && (
            <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-xs font-semibold text-accent ring-1 ring-inset ring-accent/25">
              {selectedCountLabel(selectedCount)}
            </span>
          )}
          <span className="text-xs text-ink-muted">{varietyCountLabel(totalCount)}</span>
        </span>
      </button>
      {/* Always in the page, so the toggle's aria-controls has something to
          point at, but empty while closed: a closed family draws no rows.
          Indented by the chevron and its gap (`ps-6`), which puts each
          checkbox under the first letter of the family's name. */}
      <div
        id={panelId}
        role="group"
        aria-label={family.name}
        hidden={!open}
        className="flex flex-col gap-0.5 ps-6"
      >
        {open &&
          family.products.map((product) => (
            <CheckboxRow
              key={product.id}
              product={product}
              checked={selectedIds.has(product.id)}
              disabled={disabled}
              onToggle={onToggle}
            />
          ))}
      </div>
    </div>
  );
}

function CheckboxRow({
  product,
  checked,
  disabled,
  onToggle,
}: {
  product: CatalogFamilyProduct;
  checked: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <label
      // The whole row tints when checked, not just the box. In a list
      // of a dozen near-identical product names, a 16px tick at the
      // start of the line is very easy to lose; a tinted row is not.
      // `cursor-default` while disabled so the row doesn't advertise
      // itself as clickable when it isn't.
      className={`flex items-center gap-2.5 rounded-md px-2.5 py-2.5 text-sm transition-colors ${
        disabled ? "cursor-default" : "cursor-pointer"
      } ${checked ? "bg-accent-soft font-medium text-accent" : "text-ink hover:bg-surface"}`}
    >
      <input
        type="checkbox"
        className={checkboxClassName}
        checked={checked}
        disabled={disabled}
        onChange={() => onToggle(product.id)}
      />
      <span className="min-w-0 truncate">{product.label}</span>
    </label>
  );
}

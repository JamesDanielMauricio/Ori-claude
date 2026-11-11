import { CellPopover } from "@/components/reference-data/cell-popover";
import { ProductFamilyPicker } from "@/components/reference-data/product-family-picker";
import type { CatalogFamilyGroup } from "@/lib/catalog-families";

// The editable half of a "pick varieties from the catalog" cell — a
// grower's in-season list, a user's blocked-product list. Both are a subset
// of the same ~900-variety catalog, picked from the family-grouped list with
// its own search box (ProductFamilyPicker), which "בשם מגדל"'s products
// dialog uses too.
//
// The picker is only mounted while the popover is open (see CellPopover), so
// its rows aren't in the DOM for every table row — only for the one cell
// being edited, while it's open. It is mounted afresh on every opening, so
// each one starts with the search box empty and only the families holding a
// selection open.
export function ProductMultiSelectCell({
  label,
  families,
  selectedIds,
  onToggle,
}: {
  label: string;
  families: readonly CatalogFamilyGroup[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <CellPopover
      label={label}
      summary={`${selectedIds.size} נבחרו`}
      // A flex column, so the panel's height cap squeezes the list (the one
      // part that scrolls) instead of scrolling the whole panel, search box
      // and all, around a list that scrolls as well.
      panelClassName="flex w-80 flex-col"
    >
      <ProductFamilyPicker
        label={label}
        families={families}
        selectedIds={selectedIds}
        onToggle={onToggle}
        // The popover floats over the page: a scroll that runs past the
        // list's end must stop at the list, not move the table behind it.
        listClassName="overscroll-contain"
      />
    </CellPopover>
  );
}

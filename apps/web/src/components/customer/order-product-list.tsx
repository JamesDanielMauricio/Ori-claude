import { useState } from "react";

import { inputClassName } from "@/components/reference-data/form-field";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { ProductThumbnail } from "@/components/ui/product-thumbnail";
import { blockWheel } from "@/lib/integer-input";
import { limitToOneDecimal } from "@/lib/pallet-input";

export interface OrderVarietyRow {
  varietyId: string;
  varietyName: string;
  priceLabel: string | null;
  packType: "pallets" | "crates" | null;
  pallets: string;
  comment: string;
  outOfStock?: boolean;
  // The most this customer can have on this line right now (order-draft.ts's
  // orderLimit), shown beside the quantity box as "מקסימום". Given only on
  // the customer's own order screen: staff ordering on a customer's behalf
  // may deliberately go past it (submit_order never holds them to it), and
  // the read-only historical view builds its rows from already-submitted
  // lines, which carry no live stock figure.
  limit?: number;
}

const PACK_TYPE_LABEL: Record<"pallets" | "crates", string> = {
  pallets: "משטחים",
  crates: "ארגזים",
};

export interface OrderFamilyRow {
  familyId: string;
  familyName: string;
  // product_families.image_url (migration 0036, applied 2026-09-08) — null
  // until a real photo is set per family; ProductThumbnail falls back to a
  // generic icon either way.
  imageUrl?: string | null;
  varieties: OrderVarietyRow[];
}

// The reference design's shop screen: a collapsed row per product FAMILY
// (photo + name + chevron), expanding to that family's individual
// varieties — each with its own price/quantity/comment. One shared
// presentation for both the live order screen (editable) and the
// read-only historical order view (past, closed trading days);
// `onChangePallets`/`onOpenComment` are omitted in the read-only case.
//
// The quantity is one typed number box everywhere, in steps of 0.1 (workbook
// Task 35: a fraction of a pallet can be ordered). It replaced a dropdown on
// the customer's own screen, which would have needed ten options per pallet.
// What the dropdown did there — keep a customer from asking for more than
// they may have — is now the row's `limit`: shown beside the box, the box
// turned red when it is passed, and the send stopped until it is lowered
// (OrderLinesEditor). A row without a `limit` has no ceiling to show.
export function OrderProductList({
  families,
  editable,
  onChangePallets,
  onOpenComment,
}: {
  families: OrderFamilyRow[];
  editable: boolean;
  onChangePallets?: (varietyId: string, value: string) => void;
  onOpenComment?: (varietyId: string) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggle(familyId: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(familyId)) {
        next.delete(familyId);
      } else {
        next.add(familyId);
      }
      return next;
    });
  }

  return (
    // `@container`: the variety rows inside switch layout on THIS list's
    // width, not the viewport's — the two diverge. The viewport gains a
    // 256px sidebar at `md`, so a 768px screen leaves this list narrower
    // than a 767px one does, and the same component also mounts inside the
    // arrangement board's order dialog, where the viewport says nothing
    // about the room available. See the row's own note for the threshold.
    <ul className="@container">
      {families.map((family, familyIndex) => {
        const isOpen = expandedIds.has(family.familyId);
        // How many varieties in this family already carry a quantity. Shown
        // as a chip on the collapsed row so a user scrolling a long catalog
        // can see what they've already filled in without opening every
        // family to check — previously the only way to find your own entries
        // was to expand each one in turn.
        const filledCount = family.varieties.filter(
          (variety) => Number(variety.pallets) > 0,
        ).length;

        return (
          <li
            key={family.familyId}
            className="animate-stagger-in border-b border-border last:border-b-0"
            // Capped at 8 so a long catalog's last rows don't arrive after
            // the user has already started scrolling (see globals.css).
            style={{ "--stagger-index": Math.min(familyIndex, 8) } as React.CSSProperties}
          >
            <button
              type="button"
              onClick={() => toggle(family.familyId)}
              aria-expanded={isOpen}
              className={`group flex w-full items-center gap-3 px-4 py-3 text-start transition-colors duration-200 ${
                isOpen ? "bg-accent-soft/40" : "hover:bg-surface-muted"
              }`}
            >
              <ProductThumbnail imageUrl={family.imageUrl ?? null} />
              <Icon
                name="chevronDown"
                className={`h-4 w-4 shrink-0 transition-[transform,color] duration-300 ease-[cubic-bezier(0.22,0.61,0.36,1)] ${
                  isOpen ? "rotate-180 text-accent" : "text-ink-muted group-hover:text-accent"
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                {family.familyName}
              </span>

              {filledCount > 0 && (
                <span className="animate-pop-in shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-accent-ink">
                  {filledCount}
                </span>
              )}
            </button>

            {/* Always rendered, height-animated by the CSS grid technique in
                globals.css (`.accordion-panel`) rather than mounted and
                unmounted. Two reasons: a collapse can animate closed at all
                only if the content still exists on the way out, and keeping
                the inputs mounted preserves anything typed into a family the
                user collapses and reopens before saving.
                `inert` keeps the hidden subtree out of the tab order and off
                the accessibility tree while it's closed — without it, tabbing
                past a collapsed family walks through invisible inputs. */}
            <div className="accordion-panel" data-open={isOpen}>
              <div>
                <ul className="border-t border-border bg-surface-muted/60" inert={!isOpen}>
                  {family.varieties.map((variety) => {
                    const limit = variety.limit;
                    // More than this customer may have on the line now: the
                    // box and the limit beside it turn red, and the send
                    // stops until it is lowered (OrderLinesEditor).
                    const overLimit = limit !== undefined && Number(variety.pallets || 0) > limit;
                    const limitId = `order-limit-${variety.varietyId}`;
                    return (
                    <li
                      key={variety.varietyId}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/70 px-4 py-3 transition-colors duration-150 last:border-b-0 hover:bg-surface"
                    >
                      {/* `w-full` in the narrow layout takes a whole flex
                          line, so the quantity control and comment button
                          drop underneath the name instead of competing with
                          it for the row. Neither of those two can shrink —
                          the quantity pill is a fixed `w-32` and the button
                          is `shrink-0` — so in a narrow container the name
                          was the only flexible thing left and absorbed the
                          entire shortfall. Measured across the real 133-row
                          catalogue: this column came out 34px wide at 320px
                          (46 rows overflowing their own box, names breaking
                          into four and five lines) and 89px at 375px.

                          `@md` (a 448px list) rather than the grower row's
                          `@2xl`, because this row's controls are smaller:
                          128 of quantity + 62 of button + 24 of gaps = 214,
                          against the pick row's 388. At 448 this name still
                          gets 202px, which is what it already had on a 768px
                          tablet and reads fine — so the threshold is each
                          row's own arithmetic, not a shared guess.

                          A row that shows its limit ("מקסימום 2.6", 72px
                          wide plus an 8px gap) waits for `@lg` (a 512px
                          list) instead: 294 of controls leaves this name
                          186px there, where `@md` would have left it 122. */}
                      <div
                        className={
                          limit === undefined
                            ? "w-full min-w-0 @md:w-auto @md:flex-1"
                            : "w-full min-w-0 @lg:w-auto @lg:flex-1"
                        }
                      >
                        {/* A wrapping flex row, not an inline badge after the
                            name. Inline, a narrow row broke the badge's two
                            words across lines and turned the pill into a
                            two-line blob; as its own flex item it stays whole
                            and drops under the name instead. */}
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                          <span>{variety.varietyName}</span>
                          {variety.outOfStock && <StatusPill tone="danger">אזל מהמלאי</StatusPill>}
                        </p>
                        {variety.priceLabel && (
                          <p className="mt-0.5 text-xs font-medium text-ink-muted">
                            {variety.priceLabel}
                          </p>
                        )}
                      </div>
                      {editable ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          // `min-h-10` lifts this one button from `sm`'s 36px
                          // to 40px without touching the shared size scale.
                          // Every other `sm` button in the app is an
                          // occasional inline action; this one repeats once
                          // per catalogue row — nine or more on screen at a
                          // time on a phone — so it is the size that gets
                          // mis-tapped. Width is fine at 62px: the miss that
                          // matters here is vertical, between two stacked
                          // rows.
                          className="min-h-10"
                          onClick={() => onOpenComment?.(variety.varietyId)}
                        >
                          {variety.comment ? "✎ הערה" : "+ הערה"}
                        </Button>
                      ) : (
                        variety.comment && (
                          <p className="w-full rounded-md bg-surface px-2.5 py-1.5 text-xs text-ink-muted ring-1 ring-inset ring-border">
                            הערה: {variety.comment}
                          </p>
                        )
                      )}
                      {/* Quantity + pack type together, matching the reference
                          design's single pill-shaped control, and — on the
                          customer's own screen — the most they can have on
                          the line beside it, tied to the box for screen
                          readers. The box itself takes one decimal place:
                          limitToOneDecimal cuts anything finer as it is
                          typed or pasted. */}
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            inputMode="decimal"
                            {...(limit === undefined ? {} : { max: limit })}
                            disabled={!editable}
                            aria-label={`כמות ${variety.packType ? PACK_TYPE_LABEL[variety.packType] : "פלטות"} — ${variety.varietyName}`}
                            aria-describedby={limit === undefined ? undefined : limitId}
                            aria-invalid={overLimit || undefined}
                            className={`${inputClassName} w-32 ps-3 pe-14 font-semibold ${
                              overLimit ? "ring-danger focus:ring-danger" : ""
                            }`}
                            value={variety.pallets}
                            onWheel={blockWheel}
                            onChange={(event) =>
                              onChangePallets?.(variety.varietyId, limitToOneDecimal(event.target.value))
                            }
                          />
                          {variety.packType && (
                            <span className="pointer-events-none absolute inset-y-0 end-3 my-auto flex items-center text-xs font-medium text-ink-subtle">
                              {PACK_TYPE_LABEL[variety.packType]}
                            </span>
                          )}
                        </div>
                        {limit !== undefined && (
                          <span
                            id={limitId}
                            // A fixed width, so the box sits in the same place
                          // on every row whatever the number's length.
                          className={`min-w-[4.5rem] shrink-0 text-xs font-medium ${overLimit ? "text-danger" : "text-ink-muted"}`}
                          >
                            מקסימום {limit}
                          </span>
                        )}
                      </div>
                    </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

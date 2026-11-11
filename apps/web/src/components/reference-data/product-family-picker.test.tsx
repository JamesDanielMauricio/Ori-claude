import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  NO_FAMILY_KEY,
  familiesHoldingSelection,
  groupCatalogByFamily,
  type CatalogFamilyGroup,
} from "@/lib/catalog-families";
import type { CatalogVariety } from "@/lib/queries/reference-data";

import {
  INITIAL_FAMILY_PICKER_STATE,
  ProductFamilyList,
  ProductFamilyPicker,
  isFamilyOpen,
  pickerWithQuery,
  selectedCountLabel,
  toggleFamilyOpen,
  type FamilyPickerState,
} from "./product-family-picker";

function variety(
  id: string,
  name: string,
  family: { id: string; name: string } | null,
  sizes: string | null = null,
): CatalogVariety {
  return {
    id,
    family_id: family?.id ?? "",
    name,
    sizes,
    product_families: family ? { name: family.name } : null,
  };
}

const APPLE = { id: "f-apple", name: "תפוח" };
const PEAR = { id: "f-pear", name: "אגס" };
const GRAPE = { id: "f-grape", name: "ענב" };
const KIWI = { id: "f-kiwi", name: "Kiwi" };

const FAMILIES = groupCatalogByFamily([
  variety("v-gala", "גאלה", APPLE, "5"),
  variety("v-grand", "גרנד", APPLE),
  variety("v-pink", "Pink Lady", APPLE),
  variety("v-coscia", "קושיה", PEAR),
  variety("v-spadona", "ספדונה", PEAR),
  variety("v-muscat", "מוסקט", GRAPE),
  variety("v-hayward", "הייוורד", KIWI),
  variety("v-cherry", "שרי", null),
]);

// Two of תפוח's three, and ענב's only one.
const SELECTED: ReadonlySet<string> = new Set(["v-grand", "v-pink", "v-muscat"]);

const noop = () => undefined;

// ------------------------------------------------------------ reading markup

// Server-rendered, which needs no DOM: what the browser is given to draw.
function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/\s([^\s=>]+)(?:="([^"]*)")?/g)) {
    found[match[1]!] = match[2] ?? "";
  }
  return found;
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Each family's header toggle, in the order drawn.
function headers(html: string) {
  return [...html.matchAll(/<button[^>]*>/g)].map((match) => attributes(match[0]));
}

function header(html: string, familyName: string) {
  const found = headers(html).filter((attrs) =>
    [`הרחב ${familyName}`, `כווץ ${familyName}`].includes(attrs["aria-label"] ?? ""),
  );
  expect(found).toHaveLength(1);
  return found[0]!;
}

// A family's role="group" (its tag's attributes) and what is inside it. A
// group holds rows of <label>, never a <div>, so it ends at the first </div>.
function group(html: string, familyName: string) {
  const matches = [...html.matchAll(/<div[^>]*role="group"[^>]*>/g)].filter(
    (match) => attributes(match[0])["aria-label"] === familyName,
  );
  expect(matches).toHaveLength(1);
  const match = matches[0]!;
  const start = match.index! + match[0].length;
  return { attrs: attributes(match[0]), inner: html.slice(start, html.indexOf("</div>", start)) };
}

function rowLabels(inner: string): string[] {
  return [...inner.matchAll(/<span class="min-w-0 truncate">([^<]*)<\/span>/g)].map(
    (match) => match[1]!,
  );
}

function checkboxes(html: string) {
  return [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) =>
    attributes(match[0]),
  );
}

// The counts a header's aria-describedby points at: a <span> holding the
// selected chip (when there is one) and the size, so it ends at the first
// "</span></span>" after its id.
function describedBy(html: string, familyName: string): string {
  const id = header(html, familyName)["aria-describedby"];
  const start = html.indexOf(`id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</span></span>", start) + "</span></span>".length;
  return textOf(html.slice(html.lastIndexOf("<", start), end));
}

function renderPicker(selectedIds: ReadonlySet<string> = SELECTED, families = FAMILIES) {
  return renderToStaticMarkup(
    <ProductFamilyPicker
      label="מוצרים בעונה"
      families={families}
      selectedIds={selectedIds}
      onToggle={noop}
    />,
  );
}

function renderList(
  state: FamilyPickerState,
  startsOpen = familiesHoldingSelection(FAMILIES, SELECTED),
) {
  return renderToStaticMarkup(
    <ProductFamilyList
      families={FAMILIES}
      state={state}
      startsOpen={startsOpen}
      selectedIds={SELECTED}
      onToggle={noop}
      onToggleFamily={noop}
    />,
  );
}

// ------------------------------------------------------------ open / closed

describe("which families are open", () => {
  const startsOpen: ReadonlySet<string> = new Set(["a"]);

  it("starts with the families holding a selection open and every other one closed", () => {
    expect(familiesHoldingSelection(FAMILIES, SELECTED)).toEqual(new Set([APPLE.id, GRAPE.id]));
    expect(isFamilyOpen(INITIAL_FAMILY_PICKER_STATE, "a", startsOpen)).toBe(true);
    expect(isFamilyOpen(INITIAL_FAMILY_PICKER_STATE, "b", startsOpen)).toBe(false);
  });

  it("lays the user's own clicks over that start", () => {
    const closedA = toggleFamilyOpen(INITIAL_FAMILY_PICKER_STATE, "a", startsOpen);
    expect(isFamilyOpen(closedA, "a", startsOpen)).toBe(false);
    const openedB = toggleFamilyOpen(closedA, "b", startsOpen);
    expect(isFamilyOpen(openedB, "b", startsOpen)).toBe(true);
    expect(isFamilyOpen(toggleFamilyOpen(openedB, "a", startsOpen), "a", startsOpen)).toBe(true);
  });

  it("opens every family while the search box has text, whatever the user chose", () => {
    const chosen = toggleFamilyOpen(INITIAL_FAMILY_PICKER_STATE, "a", startsOpen);
    const searching = pickerWithQuery(chosen, "ג");
    expect(isFamilyOpen(searching, "a", startsOpen)).toBe(true);
    expect(isFamilyOpen(searching, "b", startsOpen)).toBe(true);
    // Blank is no search.
    expect(isFamilyOpen(pickerWithQuery(chosen, "   "), "a", startsOpen)).toBe(false);
  });

  it("brings the user's own choices back when the search is cleared", () => {
    let state = toggleFamilyOpen(INITIAL_FAMILY_PICKER_STATE, "a", startsOpen); // a closed
    state = toggleFamilyOpen(state, "b", startsOpen); // b opened
    state = pickerWithQuery(state, "ג");
    // Folding both away mid-search is not a choice about the unsearched list.
    state = toggleFamilyOpen(state, "a", startsOpen);
    state = toggleFamilyOpen(state, "b", startsOpen);
    expect(isFamilyOpen(state, "a", startsOpen)).toBe(false);
    expect(isFamilyOpen(state, "b", startsOpen)).toBe(false);
    state = pickerWithQuery(state, "");
    expect(isFamilyOpen(state, "a", startsOpen)).toBe(false);
    expect(isFamilyOpen(state, "b", startsOpen)).toBe(true);
    expect(isFamilyOpen(state, "c", startsOpen)).toBe(false);
  });

  it("keeps a family folded mid-search only until the search changes", () => {
    const folded = toggleFamilyOpen(
      pickerWithQuery(INITIAL_FAMILY_PICKER_STATE, "גר"),
      "a",
      startsOpen,
    );
    expect(isFamilyOpen(folded, "a", startsOpen)).toBe(false);
    // The same search, spaced or cased differently, is not a change.
    expect(isFamilyOpen(pickerWithQuery(folded, " גר "), "a", startsOpen)).toBe(false);
    expect(isFamilyOpen(pickerWithQuery(folded, "גרנ"), "a", startsOpen)).toBe(true);
    // Nor does typing the same search again later bring the fold back.
    const retyped = pickerWithQuery(pickerWithQuery(folded, ""), "גר");
    expect(isFamilyOpen(retyped, "a", startsOpen)).toBe(true);
  });
});

describe("selectedCountLabel", () => {
  it("counts in words for one and in figures above it", () => {
    expect(selectedCountLabel(1)).toBe("נבחר אחד");
    expect(selectedCountLabel(2)).toBe("2 נבחרו");
    expect(selectedCountLabel(14)).toBe("14 נבחרו");
  });
});

// ------------------------------------------------------------ markup

describe("ProductFamilyPicker's markup", () => {
  it("draws a search box named for what is being picked", () => {
    const html = renderPicker();
    const search = attributes(html.match(/<input[^>]*type="search"[^>]*>/)![0]);
    expect(search).toMatchObject({
      placeholder: "סינון",
      "aria-label": "סינון מוצרים בעונה",
      value: "",
    });
  });

  it("lists the families in order, ללא משפחה last", () => {
    const html = renderPicker();
    expect(headers(html).map((attrs) => attrs["aria-label"])).toEqual([
      "הרחב אגס",
      "כווץ ענב",
      "כווץ תפוח",
      "הרחב Kiwi",
      "הרחב ללא משפחה",
    ]);
  });

  it("opens the families holding a selection, with their varieties' rows", () => {
    const html = renderPicker();
    expect(header(html, "תפוח")).toMatchObject({ type: "button", "aria-expanded": "true" });
    const apple = group(html, "תפוח");
    expect(apple.attrs.hidden).toBeUndefined();
    // Their own names only: the family is the header above them.
    expect(rowLabels(apple.inner)).toEqual(["גאלה 5", "גרנד", "Pink Lady"]);
    expect(checkboxes(apple.inner).map((box) => "checked" in box)).toEqual([false, true, true]);
    expect(rowLabels(group(html, "ענב").inner)).toEqual(["מוסקט"]);
  });

  it("draws no rows at all for a closed family", () => {
    const html = renderPicker();
    for (const name of ["אגס", "Kiwi", "ללא משפחה"]) {
      expect(header(html, name)["aria-expanded"]).toBe("false");
      const closed = group(html, name);
      expect(closed.attrs.hidden).toBe("");
      expect(closed.inner).toBe("");
    }
    // תפוח's three and ענב's one, and nothing else in the page.
    expect(checkboxes(html)).toHaveLength(4);
  });

  it("points each toggle at its own family's group, labelled by the family's name", () => {
    const html = renderPicker();
    for (const family of FAMILIES) {
      const controls = header(html, family.name)["aria-controls"];
      expect(group(html, family.name).attrs.id).toBe(controls);
    }
    const ids = headers(html).map((attrs) => attrs["aria-controls"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows how many of each family are picked, and only when some are", () => {
    const html = renderPicker();
    expect(describedBy(html, "תפוח")).toBe("2 נבחרו 3 זנים");
    expect(describedBy(html, "ענב")).toBe("נבחר אחד זן אחד");
    expect(describedBy(html, "אגס")).toBe("2 זנים");
    expect(describedBy(html, "Kiwi")).toBe("זן אחד");
  });

  it("tints a ticked row, as the old flat list did", () => {
    const apple = group(renderPicker(), "תפוח").inner;
    const rows = [...apple.matchAll(/<label class="([^"]*)"/g)].map((match) => match[1]!);
    expect(rows.map((classes) => classes.includes("bg-accent-soft"))).toEqual([false, true, true]);
    expect(rows.every((classes) => classes.includes("cursor-pointer"))).toBe(true);
  });

  it("can be drawn disabled", () => {
    const html = renderToStaticMarkup(
      <ProductFamilyPicker
        label="מוצרים חסומים"
        families={FAMILIES}
        selectedIds={SELECTED}
        onToggle={noop}
        disabled
      />,
    );
    expect(checkboxes(html).every((box) => "disabled" in box)).toBe(true);
    expect(html).toContain("cursor-default");
    expect(html).not.toContain("cursor-pointer");
  });

  it("opens on headers alone when nothing is picked, however big the catalog", () => {
    const catalog: CatalogVariety[] = [];
    for (let family = 0; family < 78; family += 1) {
      for (let row = 0; row < 12; row += 1) {
        catalog.push(
          variety(`v-${family}-${row}`, `זן ${row}`, {
            id: `f-${family}`,
            name: `משפחה ${family}`,
          }),
        );
      }
    }
    const big = groupCatalogByFamily(catalog);
    const none = renderPicker(new Set(), big);
    expect(headers(none)).toHaveLength(78);
    expect(checkboxes(none)).toHaveLength(0);
    // One pick opens its own family only.
    expect(checkboxes(renderPicker(new Set(["v-40-3"]), big))).toHaveLength(12);
  });

  it("says so when the catalog is empty", () => {
    expect(textOf(renderPicker(new Set(), []))).toBe("אין פריטים זמינים.");
  });
});

describe("ProductFamilyList's markup mid-search", () => {
  // The user had closed תפוח, which started open, before searching.
  const closedApple = toggleFamilyOpen(
    INITIAL_FAMILY_PICKER_STATE,
    APPLE.id,
    familiesHoldingSelection(FAMILIES, SELECTED),
  );

  it("shows every family with a match, open, and only what matched", () => {
    const html = renderList(pickerWithQuery(closedApple, " ג "));
    expect(headers(html).map((attrs) => attrs["aria-label"])).toEqual(["כווץ אגס", "כווץ תפוח"]);
    // אגס matched by its own name, so it keeps all of its varieties.
    expect(rowLabels(group(html, "אגס").inner)).toEqual(["ספדונה", "קושיה"]);
    expect(rowLabels(group(html, "תפוח").inner)).toEqual(["גאלה 5", "גרנד"]);
  });

  it("counts the whole family, not what the search left", () => {
    const html = renderList(pickerWithQuery(closedApple, "ג"));
    // Pink Lady is ticked but hidden by the search; the header still counts it.
    expect(describedBy(html, "תפוח")).toBe("2 נבחרו 3 זנים");
  });

  it("closes a family folded during the search", () => {
    const searching = pickerWithQuery(closedApple, "ג");
    const html = renderList(toggleFamilyOpen(searching, PEAR.id, new Set()));
    expect(header(html, "אגס")["aria-expanded"]).toBe("false");
    expect(group(html, "אגס").inner).toBe("");
    expect(header(html, "תפוח")["aria-expanded"]).toBe("true");
  });

  it("is back to the user's own layout once the search is cleared", () => {
    const html = renderList(pickerWithQuery(pickerWithQuery(closedApple, "ג"), ""));
    expect(header(html, "תפוח")["aria-expanded"]).toBe("false");
    expect(header(html, "ענב")["aria-expanded"]).toBe("true");
    expect(header(html, "ללא משפחה")["aria-expanded"]).toBe("false");
  });

  it("finds a variety with no family under ללא משפחה", () => {
    const html = renderList(pickerWithQuery(INITIAL_FAMILY_PICKER_STATE, "שרי"));
    expect(headers(html).map((attrs) => attrs["aria-label"])).toEqual(["כווץ ללא משפחה"]);
    expect(rowLabels(group(html, "ללא משפחה").inner)).toEqual(["שרי"]);
    expect(FAMILIES.at(-1)!.key).toBe(NO_FAMILY_KEY);
  });

  it("says nothing matched, quoting the trimmed search", () => {
    const html = renderList(pickerWithQuery(INITIAL_FAMILY_PICKER_STATE, "  אבוקדו "));
    expect(textOf(html)).toBe('אין תוצאות עבור "אבוקדו"');
    expect(checkboxes(html)).toHaveLength(0);
  });

  it("still says the catalog is empty while searching an empty catalog", () => {
    const html = renderToStaticMarkup(
      <ProductFamilyList
        families={[] as CatalogFamilyGroup[]}
        state={pickerWithQuery(INITIAL_FAMILY_PICKER_STATE, "ג")}
        startsOpen={new Set()}
        selectedIds={new Set()}
        onToggle={noop}
        onToggleFamily={noop}
      />,
    );
    expect(textOf(html)).toBe("אין פריטים זמינים.");
  });
});

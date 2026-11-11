import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CellPopover } from "@/components/reference-data/cell-popover";
import { whatsAppGroupsQueries, type WhatsAppGroupList } from "@/lib/queries/whatsapp-groups";

import {
  activeOptionIndex,
  filterWhatsAppGroups,
  groupDisplayNames,
  stepOptionIndex,
  WHATSAPP_GROUPS_ERROR_TEXT,
  WhatsAppGroupEditCell,
  whatsAppGroupOptions,
  WhatsAppGroupPanel,
  whatsAppGroupSearchText,
  WhatsAppGroupSummary,
  whatsAppGroupSummary,
  type WhatsAppGroupPanelState,
} from "./whatsapp-group-cell";

const AVOCADO = { id: "120363000000000001", name: "אבוקדו" };
const APPLES = { id: "120363000000000002", name: "Apples — Orders" };
const BANANAS = { id: "972509999999-1600000000", name: "בננות" };
const LIVE: WhatsAppGroupList = { env: "live", groups: [AVOCADO, APPLES, BANANAS] };
const ready = (list: WhatsAppGroupList = LIVE): WhatsAppGroupPanelState => ({
  status: "ready",
  list,
});
const NAMES = new Map(LIVE.groups.map((group) => [group.id, group.name]));

// Server-rendered, which needs no DOM: what the browser is given to draw.
const markup = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const panel = (value: string, state: WhatsAppGroupPanelState) =>
  markup(<WhatsAppGroupPanel value={value} state={state} onPick={() => undefined} />);

// Each option row of the list: whether it is the selected one, and its text.
function optionsIn(html: string) {
  return [
    ...html.matchAll(
      /<div id="[^"]*" role="option" aria-selected="(true|false)"[^>]*>(.*?)<\/div>/g,
    ),
  ].map(([, selected, inner]) => ({
    selected: selected === "true",
    text: (inner ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  }));
}

describe("searching the groups", () => {
  it("matches the name or the id, ignoring case and the spaces around the search", () => {
    expect(filterWhatsAppGroups(LIVE.groups, "")).toEqual(LIVE.groups);
    expect(filterWhatsAppGroups(LIVE.groups, "   ")).toEqual(LIVE.groups);
    expect(filterWhatsAppGroups(LIVE.groups, "  apples ")).toEqual([APPLES]);
    expect(filterWhatsAppGroups(LIVE.groups, "ORDERS")).toEqual([APPLES]);
    expect(filterWhatsAppGroups(LIVE.groups, "בננ")).toEqual([BANANAS]);
    expect(filterWhatsAppGroups(LIVE.groups, "1600000000")).toEqual([BANANAS]);
    expect(filterWhatsAppGroups(LIVE.groups, "120363")).toEqual([AVOCADO, APPLES]);
    expect(filterWhatsAppGroups(LIVE.groups, "ענבים")).toEqual([]);
  });
});

describe("the picker's rows", () => {
  it("always starts with ללא קבוצה, and a search narrows only the groups", () => {
    expect(whatsAppGroupOptions("", ready(), "")).toEqual([
      { kind: "none", id: "" },
      { kind: "group", ...AVOCADO },
      { kind: "group", ...APPLES },
      { kind: "group", ...BANANAS },
    ]);
    expect(whatsAppGroupOptions(AVOCADO.id, ready(), "בננות")).toEqual([
      { kind: "none", id: "" },
      { kind: "group", ...BANANAS },
    ]);
  });

  it("keeps a saved id that is not on the list as its own row, said to be missing only once there is a list", () => {
    expect(whatsAppGroupOptions("120363999999999999", ready(), "zzz")).toEqual([
      { kind: "none", id: "" },
      { kind: "current", id: "120363999999999999", missing: true },
    ]);
    for (const state of [
      { status: "loading" },
      { status: "error", kind: "unavailable", retrying: false, onRetry: () => undefined },
    ] satisfies WhatsAppGroupPanelState[]) {
      expect(whatsAppGroupOptions(AVOCADO.id, state, "")).toEqual([
        { kind: "none", id: "" },
        { kind: "current", id: AVOCADO.id, missing: false },
      ]);
    }
    expect(whatsAppGroupOptions("", { status: "loading" }, "")).toEqual([{ kind: "none", id: "" }]);
  });

  it("puts Enter on the selected row, on the first match while searching, or on the row pointed at", () => {
    const all = whatsAppGroupOptions(APPLES.id, ready(), "");
    expect(activeOptionIndex(all, null, "", APPLES.id)).toBe(2);
    expect(activeOptionIndex(all, null, "", "")).toBe(0);
    expect(activeOptionIndex(all, BANANAS.id, "", APPLES.id)).toBe(3);
    const searched = whatsAppGroupOptions(APPLES.id, ready(), "בננות");
    expect(activeOptionIndex(searched, null, "בננות", APPLES.id)).toBe(1);
    // The row pointed at was searched away: back to the first match.
    expect(activeOptionIndex(searched, AVOCADO.id, "בננות", APPLES.id)).toBe(1);
    expect(activeOptionIndex(whatsAppGroupOptions("", ready(), "zzz"), null, "zzz", "")).toBe(-1);
  });

  it("moves round the list with the arrow keys", () => {
    expect(stepOptionIndex(-1, 1, 4)).toBe(0);
    expect(stepOptionIndex(-1, -1, 4)).toBe(3);
    expect(stepOptionIndex(1, 1, 4)).toBe(2);
    expect(stepOptionIndex(3, 1, 4)).toBe(0);
    expect(stepOptionIndex(0, -1, 4)).toBe(3);
    expect(stepOptionIndex(-1, 1, 0)).toBe(-1);
  });
});

describe("the open picker", () => {
  it("lists the groups as one single-choice list behind a search box: the name, and the id small and left-to-right", () => {
    const html = panel(AVOCADO.id, ready());
    expect(html).toMatch(
      /<input type="search" role="combobox" aria-expanded="true" aria-controls="([^"]+)" aria-autocomplete="list" aria-activedescendant="\1-1" aria-label="חיפוש קבוצת WhatsApp" placeholder="חיפוש קבוצה"/,
    );
    expect(html).toMatch(/<div id="[^"]+" role="listbox" aria-label="קבוצות WhatsApp"/);
    expect(optionsIn(html)).toEqual([
      { selected: false, text: "ללא קבוצה" },
      { selected: true, text: `${AVOCADO.name} ${AVOCADO.id}` },
      { selected: false, text: `${APPLES.name} ${APPLES.id}` },
      { selected: false, text: `${BANANAS.name} ${BANANAS.id}` },
    ]);
    expect(html).toContain(
      `<span class="truncate text-xs font-normal text-ink-subtle"><bdi dir="ltr">${BANANAS.id}</bdi></span>`,
    );
    expect(html).not.toContain("מספר הבדיקה");
    expect(html).not.toContain('role="alert"');
  });

  it("selects ללא קבוצה when there is no group", () => {
    expect(optionsIn(panel("", ready()))[0]).toEqual({ selected: true, text: "ללא קבוצה" });
  });

  it("keeps a saved group that is not on the list, selected, saying so, with its id", () => {
    const html = panel("120363999999999999", ready());
    expect(optionsIn(html).slice(0, 2)).toEqual([
      { selected: false, text: "ללא קבוצה" },
      { selected: true, text: "הקבוצה הנוכחית לא נמצאה ברשימה 120363999999999999" },
    ]);
    expect(optionsIn(html).filter((option) => option.selected)).toHaveLength(1);
  });

  it("says when the list is the test number's", () => {
    expect(panel("", ready({ env: "dev", groups: [AVOCADO] }))).toContain(
      "המערכת במצב פיתוח: אלה הקבוצות של מספר הבדיקה.",
    );
  });

  it("says when the number is in no group", () => {
    const html = panel("", ready({ env: "live", groups: [] }));
    expect(html).toContain("אין קבוצות WhatsApp במספר המחובר.");
    expect(optionsIn(html)).toEqual([{ selected: true, text: "ללא קבוצה" }]);
  });

  it("while loading: says so, and still offers ללא קבוצה and the saved group", () => {
    const html = panel(AVOCADO.id, { status: "loading" });
    expect(html).toContain('<p role="status">טוען את הקבוצות…</p>');
    expect(optionsIn(html)).toEqual([
      { selected: false, text: "ללא קבוצה" },
      { selected: true, text: `הקבוצה הנוכחית ${AVOCADO.id}` },
    ]);
  });

  it.each(Object.entries(WHATSAPP_GROUPS_ERROR_TEXT))(
    "on a failure (%s): says why, with a retry button",
    (kind, text) => {
      const state = {
        status: "error",
        kind,
        retrying: false,
        onRetry: () => undefined,
      } as WhatsAppGroupPanelState;
      const html = panel("", state);
      expect(html).toMatch(
        /<div role="alert"[^>]*><p class="font-semibold">טעינת הקבוצות נכשלה<\/p>/,
      );
      expect(html).toContain(`<p class="text-ink">${text}</p>`);
      expect(html).toMatch(/<button[^>]*type="button"[^>]*>נסו שוב<\/button>/);
      expect(optionsIn(html)).toEqual([{ selected: true, text: "ללא קבוצה" }]);

      const retrying = panel("", { ...state, retrying: true } as WhatsAppGroupPanelState);
      expect(retrying).toMatch(/<button[^>]*type="button"[^>]*disabled=""[^>]*>טוען…<\/button>/);
    },
  );

  it("has a different explanation for each reason", () => {
    expect(new Set(Object.values(WHATSAPP_GROUPS_ERROR_TEXT)).size).toBe(5);
    expect(Object.keys(WHATSAPP_GROUPS_ERROR_TEXT).sort()).toEqual([
      "channel",
      "not_configured",
      "not_deployed",
      "refused",
      "unavailable",
    ]);
  });
});

describe("the closed cell", () => {
  const withList = (list: WhatsAppGroupList | undefined, node: ReactNode) => {
    const client = new QueryClient();
    if (list) client.setQueryData(whatsAppGroupsQueries.list().queryKey, list);
    return markup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  };

  it("is a field-like button named קבוצת WhatsApp that opens the picker, showing the group's name", () => {
    const html = withList(
      LIVE,
      <WhatsAppGroupEditCell value={APPLES.id} onChange={() => undefined} />,
    );
    expect(html).toMatch(
      /^<button type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="קבוצת WhatsApp"/,
    );
    expect(html).toContain(`<span class="truncate">${APPLES.name}</span>`);
  });

  it("shows ללא קבוצה, or the id itself while its name is not known", () => {
    expect(withList(LIVE, <WhatsAppGroupEditCell value="" onChange={() => undefined} />)).toContain(
      '<span class="truncate">ללא קבוצה</span>',
    );
    expect(
      withList(undefined, <WhatsAppGroupEditCell value={APPLES.id} onChange={() => undefined} />),
    ).toContain(`<span class="truncate"><bdi dir="ltr">${APPLES.id}</bdi></span>`);
    expect(markup(whatsAppGroupSummary("120363999999999999", LIVE))).toBe(
      '<bdi dir="ltr">120363999999999999</bdi>',
    );
  });

  it("draws the panel only once opened", () => {
    const children = vi.fn(() => <p>panel</p>);
    const html = markup(
      <CellPopover label="קבוצת WhatsApp" summary="x">
        {children}
      </CellPopover>,
    );
    expect(children).not.toHaveBeenCalled();
    expect(html).not.toContain("panel");
  });
});

describe("the read view and the search", () => {
  it("shows the group's name when it is known, else the stored id, else —", () => {
    expect(markup(<WhatsAppGroupSummary id={AVOCADO.id} names={NAMES} />)).toBe(
      `<span class="block max-w-[14rem] break-words">${AVOCADO.name}</span>`,
    );
    expect(markup(<WhatsAppGroupSummary id="120363999999999999" names={NAMES} />)).toBe(
      '<bdi dir="ltr">120363999999999999</bdi>',
    );
    expect(markup(<WhatsAppGroupSummary id={AVOCADO.id} names={new Map()} />)).toBe(
      `<bdi dir="ltr">${AVOCADO.id}</bdi>`,
    );
    expect(markup(<WhatsAppGroupSummary id={null} names={NAMES} />)).toBe("—");
    expect(markup(<WhatsAppGroupSummary id="" names={NAMES} />)).toBe("—");
  });

  it("finds a row by its group's id, and by its name once known", () => {
    expect(whatsAppGroupSearchText(AVOCADO.id, NAMES)).toBe(`${AVOCADO.id} ${AVOCADO.name}`);
    expect(whatsAppGroupSearchText(AVOCADO.id, new Map())).toBe(AVOCADO.id);
    expect(whatsAppGroupSearchText(null, NAMES)).toBe("");
  });
});

describe("two groups with one name", () => {
  // A look-alike: another group named like a company's own (here differing
  // only in case and spaces, as the comparison ignores both).
  const LOOK_ALIKE = { id: "120363000000000009", name: " apples — orders " };
  const SHARED: WhatsAppGroupList = { env: "live", groups: [AVOCADO, APPLES, LOOK_ALIKE] };

  it("name each with its id, wherever the picker is closed; a name nobody shares stays plain", () => {
    const names = groupDisplayNames(SHARED.groups);
    expect(names.get(APPLES.id)).toBe(`${APPLES.name} (⁦${APPLES.id}⁩)`);
    expect(names.get(LOOK_ALIKE.id)).toBe(`${LOOK_ALIKE.name} (⁦${LOOK_ALIKE.id}⁩)`);
    expect(names.get(AVOCADO.id)).toBe(AVOCADO.name);
    expect(groupDisplayNames(LIVE.groups)).toEqual(NAMES);

    expect(markup(whatsAppGroupSummary(APPLES.id, SHARED))).toContain(APPLES.id);
    expect(markup(whatsAppGroupSummary(AVOCADO.id, SHARED))).toBe(AVOCADO.name);
    expect(markup(<WhatsAppGroupSummary id={LOOK_ALIKE.id} names={names} />)).toContain(LOOK_ALIKE.id);
  });
});

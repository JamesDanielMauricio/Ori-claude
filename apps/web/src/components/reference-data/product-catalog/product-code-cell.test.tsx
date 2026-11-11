import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import type { ProductVariety } from "@/lib/queries/reference-data";

import { blankForm, blankRow, NEW_ROW_ID } from "./catalog-form";
import { copyProductCode, ProductCodeCell } from "./product-code-cell";
import { buildVarietyColumns, type VarietyColumnsContext } from "./variety-columns";

const CODE = "6f1c2b9e-3d4a-4e8b-9a71-0c5d2e8f4b13";

// Server-rendered, which needs no DOM: what the browser is given to draw.
const markup = (cell: ReactNode) => renderToStaticMarkup(<ToastProvider>{cell}</ToastProvider>);

describe("ProductCodeCell", () => {
  it("shows the whole code, left to right in its own isolate, monospace and selectable, beside its copy button", () => {
    const html = markup(<ProductCodeCell code={CODE} />);
    expect(html).toContain(
      `<bdi dir="ltr" class="select-all whitespace-nowrap font-mono text-xs text-ink-muted">${CODE}</bdi>`,
    );
    expect(html).toMatch(/<button type="button" aria-label="העתקת קוד המוצר" title="העתקת קוד המוצר"/);
    // Isolated by the element, not by direction marks a copy by hand would carry.
    expect(html).not.toMatch(/[‎‏⁦-⁩]/);
  });
});

describe("copyProductCode", () => {
  it("copies the whole code and says so", async () => {
    const writeText = vi.fn(async () => undefined);
    const showToast = vi.fn();
    await copyProductCode(CODE, showToast, { writeText });
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(showToast.mock.calls).toEqual([["הקוד הועתק.", "success"]]);
  });

  it("says to copy it by hand when there is no clipboard, or it refuses", async () => {
    const byHand = ["לא ניתן היה להעתיק את הקוד. סמנו אותו והעתיקו ידנית.", "error"];
    const noClipboard = vi.fn();
    await copyProductCode(CODE, noClipboard, undefined);
    expect(noClipboard.mock.calls).toEqual([byHand]);

    const refused = vi.fn();
    const writeText = vi.fn(async () => {
      throw new DOMException("Write permission denied.", "NotAllowedError");
    });
    await copyProductCode(CODE, refused, { writeText });
    expect(refused.mock.calls).toEqual([byHand]);
  });
});

describe("the products table's קוד מוצר column", () => {
  const columns = buildVarietyColumns({
    form: blankForm("F"),
    setForm: () => undefined,
    familyById: new Map(),
    familiesQuery: {} as VarietyColumnsContext["familiesQuery"],
    openFamily: () => undefined,
    photo: {} as VarietyColumnsContext["photo"],
    saving: false,
  });
  const code = columns.at(-1);
  const variety: ProductVariety = { ...blankRow("F"), id: CODE, name: "רד-דיימונד", sizes: "גדול" };

  it("is the last column, read-only — nothing to edit, so nothing in the form or the save", () => {
    expect(code?.key).toBe("code");
    expect(code?.label).toBe("קוד מוצר");
    expect(code?.renderEdit).toBeUndefined();
  });

  it("shows each variety's id in full, and nothing for a draft not saved yet", () => {
    expect(markup(code?.render(variety))).toContain(`>${CODE}</bdi>`);
    const draft = blankRow("F");
    expect(draft.id).toBe(NEW_ROW_ID);
    expect(code?.render(draft)).toBeNull();
  });
});

import { readFileSync } from "node:fs";

import { savePickLinesInputSchema } from "@ori/domain/grower";
import { describe, expect, it } from "vitest";

import type { PickProductLineRow } from "@/lib/queries/grower";

import {
  mostlyNotInPick,
  NOT_IN_PICK,
  normalizeLabel,
  pickFileProblem,
  pickFileReadErrorMessage,
  planChangedSince,
  planPickImport,
  readPickFileRows,
  toImportLines,
  toSavePickLines,
  type PickFileRow,
  type PickLineForImport,
} from "./picking-import";
import { readXlsxSheet, XlsxError, type XlsxCellValue, type XlsxSheet } from "./xlsx-reader";

const line = (
  id: string,
  name: string,
  sizes: string | null,
  palletsPicked = 0,
  leftoverPallets = 0,
  comment: string | null = null,
): PickLineForImport => ({ id, name, sizes, palletsPicked, leftoverPallets, comment });

// One grower's pick for the day.
const LINES = [
  line("L1", "רד-דיימונד", "גדול", 3, 1, "בדיקה"),
  line("L2", "עגבניה שרי", null, 5),
  line("L3", "מלפפון", null, 2),
  line("L4", "Cherry", "L", 0, 2, "קר"),
  line("L5", "פלפל", "אדום", 1),
];
const NOTHING_ARRANGED = new Map<string, number>();

function sheetOf(...rows: XlsxCellValue[][]): XlsxSheet {
  return { name: "ליקוט", isFallback: false, rows: rows.map((cells, index) => ({ rowNumber: index + 1, cells })) };
}

// A sheet with the template's header on row 1, so the first data row is row 2.
function fileRows(...data: Array<[XlsxCellValue, XlsxCellValue]>): PickFileRow[] {
  const rows = readPickFileRows(sheetOf(["מוצר", "משטחים שנקטפו"], ...data));
  if (!rows) throw new Error("expected the header to be found");
  return rows;
}

function plan(...data: Array<[XlsxCellValue, XlsxCellValue]>) {
  return planPickImport(fileRows(...data), LINES, NOTHING_ARRANGED);
}

// Messages wrap the file's own values in direction isolates (so "-1" is not
// shown as "1-"); compared here without them.
const plain = (text: string) => text.replace(/[\u2066-\u2069]/g, "");

function fixture(name: string): Uint8Array {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
}

describe("readPickFileRows", () => {
  it("finds the header on the template's first row and leaves the legend beside it alone", async () => {
    const empty = await readXlsxSheet(fixture("template-empty.xlsx"), { sheetName: "ליקוט" });
    expect(readPickFileRows(empty)).toEqual([]);

    const filled = await readXlsxSheet(fixture("filled.xlsx"), { sheetName: "ליקוט" });
    const rows = readPickFileRows(filled);
    expect(rows?.map((row) => row.rowNumber)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(rows?.[0]).toEqual({ rowNumber: 2, product: "רד-דיימונד גדול", quantity: 12 });
    // Spaces collapsed for showing back; the quantity exactly as read.
    expect(rows?.[3]).toEqual({ rowNumber: 5, product: "פלפל אדום", quantity: "7" });
    expect(rows?.[9]).toEqual({ rowNumber: 11, product: "", quantity: 5 });
  });

  it("finds the header under a few lines of notes, in whatever columns it is in", () => {
    const rows = readPickFileRows(
      sheetOf(["ליקוט של יום שלישי"], [], [null, "משטחים שנקטפו", "מוצר"], [null, 4, "מלפפון"]),
    );
    expect(rows).toEqual([{ rowNumber: 4, product: "מלפפון", quantity: 4 }]);
  });

  it("recognises the headers with stray spaces around and inside them", () => {
    expect(readPickFileRows(sheetOf([" מוצר ", "משטחים  שנקטפו"], ["מלפפון", 1]))).toHaveLength(1);
  });

  it("finds no header without both titles, or below the first rows", () => {
    expect(readPickFileRows(sheetOf(["מוצר", "עודף"], ["מלפפון", 1]))).toBeNull();
    expect(readPickFileRows(sheetOf(["מוצר"], ["משטחים שנקטפו"]))).toBeNull();
    const late = Array.from({ length: 10 }, (_, index): XlsxCellValue[] => [`הערה ${index}`]);
    expect(readPickFileRows(sheetOf(...late, ["מוצר", "משטחים שנקטפו"], ["מלפפון", 1]))).toBeNull();
  });

  it("leaves out rows with neither a product nor a quantity", () => {
    expect(fileRows(["", null], ["   ", "  "], [null, null])).toEqual([]);
  });

  // A workbook stores a text once and lets any number of cells point to it,
  // which is exactly what readXlsxSheet hands over: one string, many cells.
  it("cuts a long text to 200 characters before reading it, however many rows repeat it", () => {
    const long = "א".repeat(100_000);
    const rows = fileRows(...Array.from({ length: 200 }, (): [XlsxCellValue, XlsxCellValue] => [long, long]));
    const shown = `${"א".repeat(200)}…`;
    expect(rows).toHaveLength(200);
    expect(rows[0]).toEqual({ rowNumber: 2, product: shown, quantity: shown });
    expect(rows.every((row) => row.product === shown && row.quantity === shown)).toBe(true);

    // Cut, it names no product of the pick — and is shown, and kept, cut.
    const result = planPickImport(rows, LINES, NOTHING_ARRANGED);
    expect(result.notImported).toHaveLength(200);
    expect(result.notImported.every((skip) => skip.product === shown && skip.quantity === shown)).toBe(true);
  });

  it("puts a long quantity into its error message cut", () => {
    const [error] = plan(["מלפפון", "7".repeat(100_000)]).errors;
    expect(plain(error?.message ?? "")).toBe(
      `"${"7".repeat(200)}…" אינו מספר. יש להזין מספר שלם של משטחים, 0 ומעלה, או להשאיר ריק.`,
    );
  });

  it("looks past rows of huge text for the header without reading all of it", () => {
    // Up to a hundred cells in each row the header is looked for in, every
    // one the same 2,000,000 characters: normalized in full, that was seconds.
    const huge = "א".repeat(2_000_000);
    const notes = Array.from({ length: 9 }, () => Array.from({ length: 100 }, (): XlsxCellValue => huge));
    const started = performance.now();
    const rows = readPickFileRows(sheetOf(...notes, ["מוצר", "משטחים שנקטפו"], ["מלפפון", 4]));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(rows).toEqual([{ rowNumber: 11, product: "מלפפון", quantity: 4 }]);
  });
});

describe("normalizeLabel", () => {
  it("treats a geresh, a curly quote and an apostrophe as one", () => {
    expect(normalizeLabel("ג׳מבו")).toBe(normalizeLabel("ג'מבו"));
    expect(normalizeLabel("ג’מבו")).toBe(normalizeLabel("ג'מבו"));
  });

  it("treats gershayim, curly double quotes and two apostrophes as a double quote", () => {
    for (const written of ["ת״א", "ת“א", "ת”א", "ת''א", "ת׳׳א"]) {
      expect(normalizeLabel(written)).toBe(normalizeLabel('ת"א'));
    }
  });

  it("treats a maqaf and the dashes as a hyphen", () => {
    for (const written of ["רד־דיימונד", "רד–דיימונד", "רד—דיימונד", "רד‑דיימונד"]) {
      expect(normalizeLabel(written)).toBe("רד-דיימונד");
    }
  });

  it("trims, collapses every kind of space, and drops direction marks", () => {
    expect(normalizeLabel("  פלפל \u00A0 אדום\t")).toBe("פלפל אדום");
    expect(normalizeLabel("\u200Fעגבניה\u200E\u2069")).toBe("עגבניה");
  });

  it("compares Latin names without case, and composed accents with decomposed ones", () => {
    expect(normalizeLabel("Cherry L")).toBe(normalizeLabel("cherry l"));
    expect(normalizeLabel("Cafe\u0301")).toBe(normalizeLabel("Caf\u00E9"));
  });
});

describe("planPickImport", () => {
  it("turns a different number into a change, from the current picked count to the file's", () => {
    expect(plan(["רד-דיימונד גדול", 7])).toEqual({
      rowCount: 1,
      changes: [{ rowNumber: 2, lineId: "L1", product: "רד-דיימונד גדול", from: 3, to: 7 }],
      unchanged: 0,
      notImported: [],
      errors: [],
    });
  });

  it("leaves a line as it is for a blank cell, and for the number it already has", () => {
    const result = plan(["רד-דיימונד גדול", null], ["עגבניה שרי", 5], ["מלפפון", "  "]);
    expect(result.changes).toEqual([]);
    expect(result.unchanged).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it("sets a line to zero for a 0", () => {
    expect(plan(["עגבניה שרי", 0]).changes).toEqual([
      { rowNumber: 2, lineId: "L2", product: "עגבניה שרי", from: 5, to: 0 },
    ]);
  });

  it("reads a number typed as text", () => {
    const result = plan(["מלפפון", "7"], ["פלפל אדום", " 4 "], ["Cherry L", "6.0"]);
    expect(result.changes.map((change) => [change.lineId, change.to])).toEqual([
      ["L3", 7],
      ["L5", 4],
      ["L4", 6],
    ]);
    expect(result.errors).toEqual([]);
  });

  it("refuses decimals, negatives and text, citing the spreadsheet row", () => {
    const result = plan(
      ["רד-דיימונד גדול", 2.5],
      ["עגבניה שרי", -1],
      ["מלפפון", "שבע"],
      ["פלפל אדום", "2,5"],
      ["Cherry L", true],
    );
    expect(result.changes).toEqual([]);
    expect(result.errors.map((error) => [error.rowNumber, error.product, plain(error.message)])).toEqual([
      [2, "רד-דיימונד גדול", "2.5 אינו מספר שלם — הליקוט נקלט במשטחים שלמים. יש להזין מספר שלם של משטחים, 0 ומעלה, או להשאיר ריק."],
      [3, "עגבניה שרי", "-1 הוא מספר שלילי. יש להזין מספר שלם של משטחים, 0 ומעלה, או להשאיר ריק."],
      [4, "מלפפון", '"שבע" אינו מספר. יש להזין מספר שלם של משטחים, 0 ומעלה, או להשאיר ריק.'],
      [5, "פלפל אדום", "2,5 אינו מספר שלם — הליקוט נקלט במשטחים שלמים. יש להזין מספר שלם של משטחים, 0 ומעלה, או להשאיר ריק."],
      [6, "Cherry L", '"TRUE" אינו מספר. יש להזין מספר שלם של משטחים, 0 ומעלה, או להשאיר ריק.'],
    ]);
    // The minus stays on the left of its number in a right-to-left line.
    expect(result.errors[1]?.message).toContain("\u2068-1\u2069");
  });

  it("reads a decimal comma, but never takes a thousands comma for one", () => {
    // "1,000" read as a decimal comma would quietly have become 1 pallet.
    const result = plan(["מלפפון", "1,000"], ["עגבניה שרי", "12,000"], ["פלפל אדום", "2,00"]);
    expect(result.errors.map((error) => [error.rowNumber, plain(error.message)])).toEqual([
      [2, '"1,000" אינו מספר. יש להזין מספר שלם של משטחים, 0 ומעלה, או להשאיר ריק.'],
      [3, '"12,000" אינו מספר. יש להזין מספר שלם של משטחים, 0 ומעלה, או להשאיר ריק.'],
    ]);
    expect(result.changes.map((change) => [change.lineId, change.to])).toEqual([["L5", 2]]);
  });

  it("refuses a number too large to be stored", () => {
    expect(plain(plan(["מלפפון", 100_000_000]).errors[0]?.message ?? "")).toMatch(/^100000000 גדול מדי\./);
  });

  it("lists a product the grower has no line for, and still imports the rest", () => {
    const result = plan(["לא קיים", 4], ["רד-דיימונד גדול", 9]);
    expect(result.notImported).toEqual([
      { rowNumber: 2, product: "לא קיים", quantity: "4", reason: NOT_IN_PICK, suggestions: [] },
    ]);
    expect(result.changes).toEqual([
      { rowNumber: 3, lineId: "L1", product: "רד-דיימונד גדול", from: 3, to: 9 },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("does not check the quantity of a product it is not importing", () => {
    const result = plan(["לא קיים", "שבע"], ["גם לא קיים", null]);
    expect(result.errors).toEqual([]);
    expect(result.notImported.map((skip) => [skip.rowNumber, skip.quantity])).toEqual([
      [2, "שבע"],
      [3, ""],
    ]);
  });

  it("suggests the label with its size for a name written without one", () => {
    expect(plan(["רד-דיימונד", 4]).notImported[0]?.suggestions).toEqual(["רד-דיימונד גדול"]);
  });

  it("lists a quantity that has no product beside it", () => {
    expect(plan([null, 5]).notImported).toEqual([
      { rowNumber: 2, product: "", quantity: "5", reason: "חסר שם מוצר", suggestions: [] },
    ]);
  });

  it("matches a product however its name was typed", () => {
    const lines = [line("Q1", "ג'מבו", null), line("Q2", 'ת"א', "גדול"), line("Q3", "רד-דיימונד", "קטן")];
    const result = planPickImport(
      fileRows(["ג׳מבו", 1], ["ת״א  גדול", 2], ["\u200Fרד־דיימונד קטן\u200F", 3]),
      lines,
      NOTHING_ARRANGED,
    );
    expect(result.changes.map((change) => [change.lineId, change.product, change.to])).toEqual([
      ["Q1", "ג'מבו", 1],
      ["Q2", 'ת"א גדול', 2],
      ["Q3", "רד-דיימונד קטן", 3],
    ]);
  });

  it("refuses the same product listed twice, whatever the numbers, without picking one", () => {
    const result = plan(["רד-דיימונד גדול", 7], ["מלפפון", 4], ["רד-דיימונד  גדול", 7]);
    expect(result.errors).toEqual([
      {
        rowNumber: 4,
        product: "רד-דיימונד גדול",
        message: "המוצר מופיע בקובץ יותר מפעם אחת (גם בשורה 2). השאירו שורה אחת לכל מוצר.",
      },
    ]);
    // The duplicated product is neither changed nor counted as unchanged.
    expect(result.changes.map((change) => change.lineId)).toEqual(["L3"]);
    expect(result.unchanged).toBe(0);
  });

  it("refuses a name that two of the grower's lines share", () => {
    const lines = [line("P1", "שזיף", null, 1), line("P2", "שזיף", null, 2)];
    const result = planPickImport(fileRows(["שזיף", 4]), lines, NOTHING_ARRANGED);
    expect(result.changes).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/^השם מתאים ליותר ממוצר אחד/);
  });

  it("refuses a number that would leave less than is already arranged, counting the leftover", () => {
    // Line L1: 3 picked + 1 leftover, 5 already arranged.
    const arranged = new Map([["L1", 5]]);
    const below = planPickImport(fileRows(["רד-דיימונד גדול", 2]), LINES, arranged);
    expect(below.changes).toEqual([]);
    expect(below.errors.map((error) => [error.rowNumber, error.message])).toEqual([
      [2, "כבר סודרו 5 משטחים מהמוצר הזה ללקוחות, אבל בקובץ נקטפו 2 (ועם העודף 3). יש להזין לפחות 4, או לשנות קודם את הסידור."],
    ]);
    // 4 + 1 leftover covers the 5 arranged exactly.
    expect(planPickImport(fileRows(["רד-דיימונד גדול", 4]), LINES, arranged).changes).toHaveLength(1);
    // Not changed at all: no check, as on the server.
    expect(planPickImport(fileRows(["רד-דיימונד גדול", 3]), LINES, arranged).errors).toEqual([]);
  });

  it("rounds the smallest allowed count up to a whole pallet when arranged in tenths", () => {
    const arranged = new Map([["L2", 2.5]]);
    expect(planPickImport(fileRows(["עגבניה שרי", 2]), LINES, arranged).errors[0]?.message).toBe(
      "כבר סודרו 2.5 משטחים מהמוצר הזה ללקוחות, אבל בקובץ נקטפו 2. יש להזין לפחות 3, או לשנות קודם את הסידור.",
    );
    expect(planPickImport(fileRows(["עגבניה שרי", 3]), LINES, arranged).errors).toEqual([]);
  });

  it("leaves out of the plan every line the file does not mention", () => {
    const result = plan(["מלפפון", 9]);
    expect(result.changes.map((change) => change.lineId)).toEqual(["L3"]);
    expect(result.unchanged).toBe(0);
  });

  it("plans nothing for the template as downloaded, header and legend only", async () => {
    const sheet = await readXlsxSheet(fixture("template-empty.xlsx"), { sheetName: "ליקוט" });
    expect(planPickImport(readPickFileRows(sheet) ?? [], LINES, NOTHING_ARRANGED)).toEqual({
      rowCount: 0,
      changes: [],
      unchanged: 0,
      notImported: [],
      errors: [],
    });
  });

  it("reads a filled-in template end to end", async () => {
    const sheet = await readXlsxSheet(fixture("filled.xlsx"), { sheetName: "ליקוט" });
    const lines = [
      line("L1", "רד-דיימונד", "גדול", 3, 1),
      line("L2", "עגבניה שרי", null, 5),
      line("L3", "מלפפון", null, 2),
      line("L5", "פלפל", "אדום", 1),
      line("L6", "בננה", null),
      line("L7", "אבטיח", null),
      line("L8", "Cherry", "Tomato"),
    ];
    const result = planPickImport(readPickFileRows(sheet) ?? [], lines, NOTHING_ARRANGED);
    expect(result.rowCount).toBe(10);
    expect(result.changes).toEqual([
      { rowNumber: 3, lineId: "L2", product: "עגבניה שרי", from: 5, to: 0 },
      { rowNumber: 5, lineId: "L5", product: "פלפל אדום", from: 1, to: 7 },
    ]);
    // מלפפון, left blank.
    expect(result.unchanged).toBe(1);
    expect(result.notImported.map((skip) => [skip.rowNumber, skip.reason])).toEqual([
      [8, NOT_IN_PICK],
      [11, "חסר שם מוצר"],
    ]);
    // 2.5, -1, the second רד-דיימונד גדול, and "שבע".
    expect(result.errors.map((error) => error.rowNumber)).toEqual([6, 7, 9, 10]);
  });
});

describe("toSavePickLines", () => {
  it("sends the file's picked count with each line's leftover and comment as they are NOW", () => {
    const previewed = plan(["רד-דיימונד גדול", 7], ["מלפפון", 0]);
    // Since the preview was read, someone changed L1's leftover and comment.
    const fresh = LINES.map((pickLine) =>
      pickLine.id === "L1" ? { ...pickLine, leftoverPallets: 4, comment: "עודכן" } : pickLine,
    );
    expect(toSavePickLines(previewed, fresh)).toEqual([
      { dailyPickProductId: "L1", palletsPicked: 7, leftoverPallets: 4, comment: "עודכן" },
      { dailyPickProductId: "L3", palletsPicked: 0, leftoverPallets: 0, comment: null },
    ]);
  });

  it("does not send a line that already holds the file's number", () => {
    const previewed = plan(["רד-דיימונד גדול", 7], ["מלפפון", 0]);
    const fresh = LINES.map((pickLine) => (pickLine.id === "L1" ? { ...pickLine, palletsPicked: 7 } : pickLine));
    expect(toSavePickLines(previewed, fresh).map((sent) => sent.dailyPickProductId)).toEqual(["L3"]);
  });

  it("sends nothing for unchanged rows, skipped rows, or lines the file leaves out", () => {
    const previewed = plan(["רד-דיימונד גדול", null], ["עגבניה שרי", 5], ["לא קיים", 3], ["פלפל אדום", 6]);
    expect(toSavePickLines(previewed, LINES)).toEqual([
      { dailyPickProductId: "L5", palletsPicked: 6, leftoverPallets: 0, comment: null },
    ]);
  });

  it("refuses a change for a line that has left the pick", () => {
    const previewed = plan(["מלפפון", 9]);
    expect(() => toSavePickLines(previewed, LINES.filter((pickLine) => pickLine.id !== "L3"))).toThrow(
      /כבר לא בליקוט/,
    );
  });

  it("builds lines the save schema accepts", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const lines = [line(id, "מלפפון", null, 2, 1.5, "הערה")];
    const previewed = planPickImport(fileRows(["מלפפון", 3]), lines, NOTHING_ARRANGED);
    const input = savePickLinesInputSchema.parse({
      dailyPickId: "22222222-2222-4222-8222-222222222222",
      lines: toSavePickLines(previewed, lines),
    });
    expect(input.lines).toEqual([{ dailyPickProductId: id, palletsPicked: 3, leftoverPallets: 1.5, comment: "הערה" }]);
  });
});

describe("mostlyNotInPick", () => {
  it("is true when most of the products the file names are not in the grower's pick", () => {
    expect(mostlyNotInPick(plan(["לא קיים", 1], ["גם לא קיים", 2], ["מלפפון", 3]))).toBe(true);
    // Rows that name no product are not counted either way.
    expect(mostlyNotInPick(plan(["לא קיים", 1], [null, 2]))).toBe(true);
  });

  it("is false at half or fewer, and for a file with nothing to judge by", () => {
    expect(mostlyNotInPick(plan(["לא קיים", 1], ["מלפפון", 3]))).toBe(false);
    expect(mostlyNotInPick(plan(["מלפפון", 3], ["עגבניה שרי", null]))).toBe(false);
    expect(mostlyNotInPick(plan([null, 2]))).toBe(false);
    expect(mostlyNotInPick(plan())).toBe(false);
  });
});

describe("planChangedSince", () => {
  const rows = fileRows(["רד-דיימונד גדול", 7], ["מלפפון", 2], ["לא קיים", 1]);
  const previewed = planPickImport(rows, LINES, NOTHING_ARRANGED);
  const replan = (lines: PickLineForImport[], arranged = NOTHING_ARRANGED) =>
    planPickImport(rows, lines, arranged);
  const withLine = (id: string, patch: Partial<PickLineForImport>) =>
    LINES.map((pickLine) => (pickLine.id === id ? { ...pickLine, ...patch } : pickLine));

  it("is false when nothing changed, or only a number the preview was about to set anyway", () => {
    expect(planChangedSince(previewed, replan(LINES))).toBe(false);
    // Someone already set L1 to the file's 7: one change fewer, nothing new.
    expect(planChangedSince(previewed, replan(withLine("L1", { palletsPicked: 7 })))).toBe(false);
    // L1 moved from 3 to 4 meanwhile; the file still sets it to the 7 shown.
    expect(planChangedSince(previewed, replan(withLine("L1", { palletsPicked: 4 })))).toBe(false);
  });

  it("is true when the file would now change a line the preview showed as unchanged", () => {
    // מלפפון was 2, as in the file; someone made it 5.
    expect(planChangedSince(previewed, replan(withLine("L3", { palletsPicked: 5 })))).toBe(true);
  });

  it("is true when something arranged meanwhile now refuses a change", () => {
    expect(planChangedSince(previewed, replan(LINES, new Map([["L1", 9]])))).toBe(true);
  });

  it("is true when a line the preview was changing has left the pick", () => {
    expect(planChangedSince(previewed, replan(LINES.filter((pickLine) => pickLine.id !== "L1")))).toBe(true);
  });
});

describe("toImportLines", () => {
  it("takes the pick editor's rows as plain numbers", () => {
    const row: PickProductLineRow = {
      id: "A",
      pallets_picked: 8,
      leftover_pallets: 0.5,
      comment: null,
      product_varieties: {
        name: "רד-דיימונד",
        sizes: "גדול",
        family_id: "F",
        product_families: { name: "תפוח", image_url: null },
      },
    };
    expect(toImportLines([row])).toEqual([
      { id: "A", name: "רד-דיימונד", sizes: "גדול", palletsPicked: 8, leftoverPallets: 0.5, comment: null },
    ]);
  });
});

describe("file problems", () => {
  it("refuses anything but an .xlsx, and a file over 2 MB, before reading it", () => {
    expect(pickFileProblem({ name: "ליקוט.xlsx", size: 8000 })).toBeNull();
    expect(pickFileProblem({ name: "ליקוט.XLSX", size: 8000 })).toBeNull();
    expect(pickFileProblem({ name: "ליקוט.xls", size: 8000 })).toMatch(/אינו קובץ אקסל/);
    expect(pickFileProblem({ name: "ליקוט.csv", size: 8000 })).toMatch(/הורדת תבנית/);
    expect(pickFileProblem({ name: "ליקוט.xlsx", size: 3 * 1024 * 1024 })).toMatch(/גדול מדי/);
  });

  it("explains each way a file can fail to read, and names the template", () => {
    expect(pickFileReadErrorMessage(new XlsxError("not_zip", ""))).toMatch(/הורדת תבנית/);
    expect(pickFileReadErrorMessage(new XlsxError("corrupt", ""))).toMatch(/לא ניתן לקרוא את הקובץ כקובץ אקסל/);
    expect(pickFileReadErrorMessage(new XlsxError("legacy_or_encrypted", ""))).toMatch(/בלי סיסמה/);
    expect(pickFileReadErrorMessage(new XlsxError("too_large", ""))).toMatch(/גדול מדי/);
    expect(pickFileReadErrorMessage(new XlsxError("unsupported_runtime", ""))).toMatch(/הדפדפן/);
    expect(pickFileReadErrorMessage(new Error("NotReadableError"))).toBe("לא ניתן היה לקרוא את הקובץ. בחרו אותו שוב.");
  });
});

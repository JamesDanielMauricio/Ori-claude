import { readFileSync } from "node:fs";

import { savePickLinesInputSchema } from "@ori/domain/grower";
import { describe, expect, it } from "vitest";

import type { PickProductLineRow } from "@/lib/queries/grower";

import {
  HIDDEN_ROW,
  mostlyNotInPick,
  NOT_IN_PICK,
  normalizeLabel,
  PICK_UPLOAD_INSTRUCTIONS_SHEET,
  PickFileError,
  pickFileProblem,
  pickFileReadErrorMessage,
  planChangedSince,
  planPickImport,
  readPickFileRows,
  sheetLabel,
  toImportLines,
  toSavePickLines,
  type PickFileRow,
  type PickImportPlan,
  type PickLineForImport,
} from "./picking-import";
import { readXlsxSheet, XlsxError, type XlsxCellValue, type XlsxRow, type XlsxSheet } from "./xlsx-reader";

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
  return { name: "ליקוט", rows: rows.map((cells, index) => ({ rowNumber: index + 1, cells })) };
}

// The template's header on row 1, then rows as the reader gives them —
// hidden, or with numbers shown as dates.
function sheetWith(...rows: XlsxRow[]): XlsxSheet {
  return { name: "ליקוט", rows: [{ rowNumber: 1, cells: ["מוצר", "משטחים שנקטפו"] }, ...rows] };
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

// What the dialog asks of the reader: the template's instructions set aside.
const UPLOAD = { ignoreSheets: [PICK_UPLOAD_INSTRUCTIONS_SHEET] };

// The plan for a fixture, as the dialog makes it.
async function planFile(name: string, lines: readonly PickLineForImport[] = LINES) {
  const sheet = await readXlsxSheet(fixture(name), UPLOAD);
  return { sheet, plan: planPickImport(readPickFileRows(sheet) ?? [], lines, NOTHING_ARRANGED) };
}

// The message a header row is refused with, as the dialog shows it (without
// the isolates).
function headerRefusal(sheet: XlsxSheet): string {
  try {
    readPickFileRows(sheet);
  } catch (error) {
    if (error instanceof PickFileError) return plain(pickFileReadErrorMessage(error));
    throw error;
  }
  throw new Error("expected the header row to be refused");
}

async function readFailure(name: string): Promise<XlsxError> {
  try {
    await readXlsxSheet(fixture(name), UPLOAD);
  } catch (error) {
    if (error instanceof XlsxError) return error;
    throw error;
  }
  throw new Error(`expected ${name} to be refused`);
}

describe("readPickFileRows", () => {
  it("finds the header on the template's first row and leaves the legend beside it alone", async () => {
    const empty = await readXlsxSheet(fixture("template-empty.xlsx"), UPLOAD);
    expect(readPickFileRows(empty)).toEqual([]);

    const filled = await readXlsxSheet(fixture("filled.xlsx"), UPLOAD);
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

  it("refuses a header row that gives either title to more than one column, naming the columns", () => {
    expect(headerRefusal(sheetOf(["מוצר", "משטחים שנקטפו", null, " משטחים  שנקטפו "], ["מלפפון", 1, null, 2]))).toBe(
      'בשורת הכותרות יש יותר מעמודה אחת בשם "משטחים שנקטפו" (עמודות B, D), ואי אפשר לדעת מאיזו מהן לקרוא. השאירו עמודה אחת בשם הזה ונסו שוב. אם אחת העמודות מוסתרת, הציגו אותה ב-Excel.',
    );
    expect(headerRefusal(sheetOf(["מוצר", "משטחים שנקטפו", "מוצר"], ["מלפפון", 1, "עגבניה שרי"]))).toContain(
      'בשם "מוצר" (עמודות A, C)',
    );
    // Lettered as Excel letters them, past Z.
    const wide: XlsxCellValue[] = Array.from({ length: 53 }, () => null);
    wide[0] = "מוצר";
    wide[25] = "משטחים שנקטפו";
    wide[26] = "משטחים שנקטפו";
    wide[52] = "משטחים שנקטפו";
    expect(headerRefusal(sheetOf(wide))).toContain("(עמודות Z, AA, BA)");
  });

  it("refuses the template reused with yesterday's column hidden and today's beside it, end to end", async () => {
    // openpyxl: column B, hidden, still holds yesterday's 11 and 21; today's
    // 99 and 98 are in a new column C under the same title. Read from the
    // first column with the title, yesterday's numbers would be saved as
    // today's.
    const sheet = await readXlsxSheet(fixture("columns-hidden-repeat.xlsx"), UPLOAD);
    expect(sheet.rows[1]?.cells.slice(0, 3)).toEqual(["מלפפון", 11, 99]);
    expect(headerRefusal(sheet)).toContain('בשם "משטחים שנקטפו" (עמודות B, C)');
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
    const sheet = await readXlsxSheet(fixture("template-empty.xlsx"), UPLOAD);
    expect(planPickImport(readPickFileRows(sheet) ?? [], LINES, NOTHING_ARRANGED)).toEqual({
      rowCount: 0,
      changes: [],
      unchanged: 0,
      notImported: [],
      errors: [],
    });
  });

  it("reads a filled-in template end to end", async () => {
    const sheet = await readXlsxSheet(fixture("filled.xlsx"), UPLOAD);
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
    expect(pickFileReadErrorMessage(new PickFileError("העמודות כפולות"))).toBe("העמודות כפולות");
    expect(pickFileReadErrorMessage(new Error("NotReadableError"))).toBe("לא ניתן היה לקרוא את הקובץ. בחרו אותו שוב.");
  });
});

// The pre-release review's three findings, end to end through the reader: a
// copy of the picking tab read in place of the one meant, rows hidden in the
// file imported, and a quantity Excel had made a date imported as its day
// count.
describe("which tab is read", () => {
  const SEVERAL_ENDING = "השאירו בקובץ גיליון ליקוט אחד — קובץ אחד לכל מגדל — ונסו שוב.";

  it("refuses a workbook with a copy of the picking tab, or a tab per grower, naming the tabs", async () => {
    const message = async (name: string) => plain(pickFileReadErrorMessage(await readFailure(name)));
    expect(await message("tabs-excel-copy.xlsx")).toBe(`בקובץ יש כמה גיליונות: "ליקוט (2)", "ליקוט". ${SEVERAL_ENDING}`);
    expect(await message("tabs-google-copy.xlsx")).toBe(
      `בקובץ יש כמה גיליונות: "ליקוט", "עותק של ליקוט". ${SEVERAL_ENDING}`,
    );
    expect(await message("tabs-libreoffice-copy.xlsx")).toBe(`בקובץ יש כמה גיליונות: "ליקוט", "ליקוט_2". ${SEVERAL_ENDING}`);
    expect(await message("tabs-per-grower.xlsx")).toBe(`בקובץ יש כמה גיליונות: "משה", "דוד". ${SEVERAL_ENDING}`);
  });

  it("isolates each tab's name, and lists five at most", () => {
    const message = pickFileReadErrorMessage(
      new XlsxError("several_sheets", "", ["Sheet1", "ליקוט (2)", "3", "4", "5", "6", "7"]),
    );
    expect(message).toContain('"⁨Sheet1⁩", "⁨ליקוט (2)⁩"');
    expect(plain(message)).toBe(`בקובץ יש כמה גיליונות: "Sheet1", "ליקוט (2)", "3", "4", "5" ועוד 2. ${SEVERAL_ENDING}`);
  });

  it("refuses a workbook whose only visible tab is the instructions, saying hidden tabs are not read", async () => {
    expect(pickFileReadErrorMessage(await readFailure("tabs-instructions-only.xlsx"))).toBe(
      'בקובץ אין גיליון ליקוט גלוי: הגיליון "הוראות" וגיליונות מוסתרים לא נקראים. אם גיליון הליקוט מוסתר, הציגו אותו ב-Excel ונסו שוב. יש להעלות את תבנית הליקוט של אורי ("הורדת תבנית") אחרי שמילאתם אותה.',
    );
  });

  it("plans the visible copy's numbers when the original is hidden", async () => {
    // Grower B's 99 and 98 from "ליקוט (2)"; grower A's, in the hidden
    // "ליקוט", are never read.
    const { sheet, plan: result } = await planFile("tabs-hidden-original.xlsx");
    expect(sheet.name).toBe("ליקוט (2)");
    expect(result.changes.map((change) => [change.rowNumber, change.lineId, change.to])).toEqual([
      [2, "L3", 99],
      [3, "L1", 98],
    ]);
  });

  it("plans the one tab besides the instructions, renamed and moved after them", async () => {
    const { sheet, plan: result } = await planFile("tabs-renamed-moved.xlsx");
    expect(sheet.name).toBe("נתונים");
    expect(result.changes.map((change) => [change.lineId, change.to])).toEqual([
      ["L3", 11],
      ["L1", 21],
    ]);
  });

  it("shows a tab's name cut, its spaces collapsed and its invisible marks dropped", () => {
    expect(sheetLabel("‏ליקוט  (2)‏")).toBe("ליקוט (2)");
    expect(sheetLabel("א".repeat(300))).toBe(`${"א".repeat(200)}…`);
  });
});

describe("hidden rows", () => {
  it("keeps a hidden row only when it names a product, marked hidden", () => {
    expect(
      readPickFileRows(
        sheetWith(
          { rowNumber: 2, cells: ["מלפפון", 4], hidden: true },
          // No quantity: kept for its product alone, which the warning about
          // another grower's file counts.
          { rowNumber: 3, cells: ["עגבניה שרי", null], hidden: true },
          { rowNumber: 4, cells: [null, 6], hidden: true },
          { rowNumber: 5, cells: ["פלפל אדום", "  "], hidden: true },
          { rowNumber: 6, cells: ["Cherry L", 0], hidden: true },
        ),
      ),
    ).toEqual([
      { rowNumber: 2, product: "מלפפון", quantity: 4, hidden: true },
      { rowNumber: 3, product: "עגבניה שרי", quantity: null, hidden: true },
      { rowNumber: 5, product: "פלפל אדום", quantity: "  ", hidden: true },
      { rowNumber: 6, product: "Cherry L", quantity: 0, hidden: true },
    ]);
  });

  it("finds the header in a hidden row, as before", () => {
    const sheet: XlsxSheet = {
      name: "ליקוט",
      rows: [
        { rowNumber: 1, cells: ["מוצר", "משטחים שנקטפו"], hidden: true },
        { rowNumber: 2, cells: ["מלפפון", 4] },
      ],
    };
    expect(readPickFileRows(sheet)).toEqual([{ rowNumber: 2, product: "מלפפון", quantity: 4 }]);
  });

  it("lists a hidden row as not imported, without matching it, checking it, or calling it a duplicate", () => {
    const rows = readPickFileRows(
      sheetWith(
        { rowNumber: 2, cells: ["מלפפון", 9] },
        // The same product as row 2.
        { rowNumber: 3, cells: ["מלפפון", 4], hidden: true },
        // Not a number; a number shown as a date.
        { rowNumber: 4, cells: ["עגבניה שרי", "שבע"], hidden: true },
        { rowNumber: 5, cells: ["פלפל אדום", 46054], hidden: true, dateColumns: [1] },
        // Not in the pick.
        { rowNumber: 6, cells: ["לא קיים", 1], hidden: true },
      ),
    );
    const result = planPickImport(rows ?? [], LINES, NOTHING_ARRANGED);
    expect(result.changes).toEqual([{ rowNumber: 2, lineId: "L3", product: "מלפפון", from: 2, to: 9 }]);
    expect(result.errors).toEqual([]);
    expect(result.unchanged).toBe(0);
    expect(result.notImported).toEqual([
      { rowNumber: 3, product: "מלפפון", quantity: "4", reason: HIDDEN_ROW, suggestions: [] },
      { rowNumber: 4, product: "עגבניה שרי", quantity: "שבע", reason: HIDDEN_ROW, suggestions: [] },
      // Named as a date, not shown as its day count.
      { rowNumber: 5, product: "פלפל אדום", quantity: "תאריך או שעה", reason: HIDDEN_ROW, suggestions: [] },
      { rowNumber: 6, product: "לא קיים", quantity: "1", reason: HIDDEN_ROW, suggestions: [] },
    ]);
    expect(HIDDEN_ROW).toBe("השורה מוסתרת בקובץ ולא תיקלט. הציגו אותה ב-Excel והעלו שוב אם צריך");
  });

  it("counts the product of every hidden row, and lists only those with a quantity", () => {
    const rows = readPickFileRows(
      sheetWith(
        { rowNumber: 2, cells: ["מלפפון", 9] },
        { rowNumber: 3, cells: ["עגבניה שרי", null], hidden: true },
        { rowNumber: 4, cells: ["לא קיים", null], hidden: true },
        { rowNumber: 5, cells: ["גם לא קיים", 3], hidden: true },
        // No product: nothing to count, nothing to import.
        { rowNumber: 6, cells: [null, 6], hidden: true },
      ),
    );
    const result = planPickImport(rows ?? [], LINES, NOTHING_ARRANGED);
    expect(result.changes).toEqual([{ rowNumber: 2, lineId: "L3", product: "מלפפון", from: 2, to: 9 }]);
    expect(result.unchanged).toBe(0);
    expect(result.errors).toEqual([]);
    // Rows 3 and 4 hold nothing to import, so the preview shows nothing of them.
    expect(result.notImported.map((skip) => [skip.rowNumber, skip.reason])).toEqual([[5, HIDDEN_ROW]]);
    expect(result.rowCount).toBe(2);
    expect(result.hiddenProducts).toEqual({ count: 3, notInPick: 2 });
    // A file that hides nothing says nothing of hidden rows.
    expect(plan(["מלפפון", 9])).not.toHaveProperty("hiddenProducts");
  });

  it("weighs hidden rows in the warning about another grower's file, listed or not", () => {
    const hidden = (rowNumber: number, product: string | null, quantity: XlsxCellValue): XlsxRow => ({
      rowNumber,
      cells: [product, quantity],
      hidden: true,
    });
    const warns = (...rows: XlsxRow[]) =>
      mostlyNotInPick(planPickImport(readPickFileRows(sheetWith(...rows)) ?? [], LINES, NOTHING_ARRANGED));
    // Strangers to this pick, hidden — one with a quantity, so listed, and
    // one without, so not shown at all — raise it...
    expect(warns({ rowNumber: 2, cells: ["מלפפון", 1] }, hidden(3, "לא קיים", 1), hidden(4, "גם לא קיים", null))).toBe(
      true,
    );
    expect(warns({ rowNumber: 2, cells: ["מלפפון", 1] }, hidden(3, "לא קיים", null), hidden(4, "גם לא קיים", null))).toBe(
      true,
    );
    // ...and the pick's own products, hidden, weigh against it.
    expect(warns({ rowNumber: 2, cells: ["לא קיים", 1] }, hidden(3, "מלפפון", 1), hidden(4, "עגבניה שרי", null))).toBe(
      false,
    );
    // A hidden row that names no product is not counted either way — by the
    // plan either, whatever rows it is given.
    expect(warns({ rowNumber: 2, cells: ["לא קיים", 1] }, hidden(3, null, 4))).toBe(true);
    expect(warns({ rowNumber: 2, cells: ["מלפפון", 1] }, hidden(3, null, 4), hidden(4, "  ", 5))).toBe(false);
    const nameless: PickFileRow = { rowNumber: 3, product: "", quantity: 4, hidden: true };
    const given = planPickImport([...fileRows(["מלפפון", 1]), nameless, { ...nameless, rowNumber: 4 }], LINES, NOTHING_ARRANGED);
    expect(given.hiddenProducts).toBeUndefined();
    expect(mostlyNotInPick(given)).toBe(false);
  });

  // The warning is about whose file this is, which hiding a row does not
  // change: it comes out as it did before hidden rows were told apart.
  it("warns exactly as it would if no row were hidden", () => {
    const visible = (row: XlsxRow): XlsxRow => ({ rowNumber: row.rowNumber, cells: row.cells });
    const warns = (rows: XlsxRow[]) =>
      mostlyNotInPick(planPickImport(readPickFileRows(sheetWith(...rows)) ?? [], LINES, NOTHING_ARRANGED));
    const files: XlsxRow[][] = [
      [
        { rowNumber: 2, cells: ["מלפפון", 11] },
        { rowNumber: 3, cells: ["לא קיים", null], hidden: true },
        { rowNumber: 4, cells: ["גם לא קיים", null], hidden: true },
      ],
      [
        { rowNumber: 2, cells: ["לא קיים", 1] },
        { rowNumber: 3, cells: ["מלפפון", null], hidden: true },
        { rowNumber: 4, cells: ["עגבניה שרי", 4], hidden: true },
      ],
      [
        { rowNumber: 2, cells: ["מלפפון", 1] },
        { rowNumber: 3, cells: ["לא קיים", 2], hidden: true },
        // The same product twice, and a quantity with no product, hidden.
        { rowNumber: 4, cells: ["לא קיים", 3], hidden: true },
        { rowNumber: 5, cells: [null, 6], hidden: true },
      ],
      [
        { rowNumber: 2, cells: ["רד-דיימונד גדול", 1], hidden: true },
        { rowNumber: 3, cells: ["Cherry L", null], hidden: true },
        { rowNumber: 4, cells: ["לא קיים", 46054], hidden: true, dateColumns: [1] },
        { rowNumber: 5, cells: [null, 2] },
      ],
    ];
    expect(files.map(warns)).toEqual([true, false, true, false]);
    expect(files.map(warns)).toEqual(files.map((rows) => warns(rows.map(visible))));
  });

  it("reads rows hidden by a filter, a collapsed group, or by hand, end to end", async () => {
    const filtered = (await planFile("hidden-rows-filter.xlsx")).plan;
    expect(filtered.changes.map((change) => [change.rowNumber, change.to])).toEqual([
      [2, 11],
      [4, 31],
    ]);
    // Row 6, hidden with a product and no quantity, has nothing to list.
    expect(filtered.notImported.map((skip) => [skip.rowNumber, skip.reason, skip.quantity])).toEqual([
      [3, HIDDEN_ROW, "21"],
      [5, HIDDEN_ROW, "41"],
    ]);
    expect(filtered.rowCount).toBe(4);
    // Its product is counted all the same, with those of rows 3 and 5.
    expect(filtered.hiddenProducts).toEqual({ count: 3, notInPick: 0 });

    const grouped = (await planFile("hidden-rows-group.xlsx")).plan;
    expect(grouped.changes.map((change) => [change.rowNumber, change.to])).toEqual([
      [2, 11],
      [5, 41],
    ]);
    expect(grouped.notImported.map((skip) => skip.rowNumber)).toEqual([3, 4]);

    const manual = (await planFile("hidden-rows-manual.xlsx")).plan;
    // Rows 7 and 8 are marked visible ("0", "false").
    expect(manual.changes.map((change) => [change.rowNumber, change.lineId, change.to])).toEqual([
      [2, "L3", 11],
      [7, "L5", 0],
      [8, "L4", 4],
    ]);
    // Row 5 repeats row 2's product and row 9 holds "שבע", both hidden: no
    // errors. Row 6, a hidden quantity with no product, is not listed.
    expect(manual.errors).toEqual([]);
    expect(manual.notImported.map((skip) => skip.rowNumber)).toEqual([3, 4, 5, 9]);
  });

  // Grower A's file uploaded from grower B's row, filtered the way people
  // look over a file. Of A's products B grows only מלפפון and רד-דיימונד
  // גדול, and A's numbers for those two would be saved into B's pick.
  it("warns of another grower's file however a filter has left its rows out, end to end", async () => {
    const growerB = [line("B1", "רד-דיימונד", "גדול", 3, 1), line("B2", "מלפפון", null, 2)];
    const savedIntoB = [
      [2, "B2", 2, 11],
      [3, "B1", 3, 21],
    ];
    const changes = (result: PickImportPlan) =>
      result.changes.map((change) => [change.rowNumber, change.lineId, change.from, change.to]);

    // A filter on "משטחים שנקטפו" leaving out the blank rows: A's seven
    // products with nothing picked today are hidden, and not listed.
    const blanks = (await planFile("hidden-rows-other-grower-blanks.xlsx", growerB)).plan;
    expect(changes(blanks)).toEqual(savedIntoB);
    expect(blanks.notImported.map((skip) => [skip.rowNumber, skip.product, skip.reason])).toEqual([
      [4, "חציל", NOT_IN_PICK],
    ]);
    expect(blanks.hiddenProducts).toEqual({ count: 7, notInPick: 7 });
    expect(mostlyNotInPick(blanks)).toBe(true);

    // A filter on "מוצר" showing only the two products the growers share:
    // A's four others, each with its number, are hidden and listed.
    const products = (await planFile("hidden-rows-other-grower-products.xlsx", growerB)).plan;
    expect(changes(products)).toEqual(savedIntoB);
    expect(products.notImported.map((skip) => [skip.rowNumber, skip.product, skip.reason])).toEqual([
      [4, "חציל", HIDDEN_ROW],
      [5, "פלפל אדום", HIDDEN_ROW],
      [6, "קישוא", HIDDEN_ROW],
      [7, "בצל", HIDDEN_ROW],
    ]);
    expect(mostlyNotInPick(products)).toBe(true);
  });
});

describe("quantities shown as dates or times", () => {
  const DATE_MESSAGE =
    "בעמודת המשטחים יש תאריך או שעה, לא מספר — כנראה Excel הפך את מה שהוקלד לתאריך. החזירו את התא לעיצוב מספר רגיל והזינו בו מספר שלם של משטחים.";

  it("marks a quantity the file shows as a date: a number, in the quantity's own column", () => {
    expect(
      readPickFileRows(
        sheetWith(
          { rowNumber: 2, cells: ["מלפפון", 46054], dateColumns: [1] },
          { rowNumber: 3, cells: ["עגבניה שרי", 5] },
          // A date beside the table is none of the upload's business.
          { rowNumber: 4, cells: ["פלפל אדום", 6, null, 46054], dateColumns: [3] },
        ),
      ),
    ).toEqual([
      { rowNumber: 2, product: "מלפפון", quantity: 46054, quantityIsDate: true },
      { rowNumber: 3, product: "עגבניה שרי", quantity: 5 },
      { rowNumber: 4, product: "פלפל אדום", quantity: 6 },
    ]);
  });

  it("refuses a date or a time as a quantity, whatever number is under it, and says what to do", () => {
    const rows = readPickFileRows(
      sheetWith(
        { rowNumber: 2, cells: ["מלפפון", 46054], dateColumns: [1] },
        // 12:00, half a day.
        { rowNumber: 3, cells: ["עגבניה שרי", 0.5], dateColumns: [1] },
        // A whole number that could be a count — but the cell shows a date.
        { rowNumber: 4, cells: ["פלפל אדום", 3], dateColumns: [1] },
        { rowNumber: 5, cells: ["Cherry L", 6] },
      ),
    );
    const result = planPickImport(rows ?? [], LINES, NOTHING_ARRANGED);
    expect(result.errors).toEqual([
      { rowNumber: 2, product: "מלפפון", message: DATE_MESSAGE },
      { rowNumber: 3, product: "עגבניה שרי", message: DATE_MESSAGE },
      { rowNumber: 4, product: "פלפל אדום", message: DATE_MESSAGE },
    ]);
    expect(result.changes.map((change) => change.lineId)).toEqual(["L4"]);
  });

  it("does not check the date of a product it is not importing", () => {
    const rows = readPickFileRows(sheetWith({ rowNumber: 2, cells: ["לא קיים", 46054], dateColumns: [1] }));
    const result = planPickImport(rows ?? [], LINES, NOTHING_ARRANGED);
    expect(result.errors).toEqual([]);
    expect(result.notImported.map((skip) => skip.reason)).toEqual([NOT_IN_PICK]);
  });

  it("names a date as one beside a row it skips, rather than showing its day count", () => {
    const rows = readPickFileRows(
      sheetWith(
        { rowNumber: 2, cells: ["לא קיים", 46054], dateColumns: [1] },
        { rowNumber: 3, cells: ["מלפפון", 0.5], dateColumns: [1], hidden: true },
        { rowNumber: 4, cells: ["גם לא קיים", 7] },
      ),
    );
    const result = planPickImport(rows ?? [], LINES, NOTHING_ARRANGED);
    expect(result.notImported.map((skip) => [skip.rowNumber, skip.reason, skip.quantity])).toEqual([
      [2, NOT_IN_PICK, "תאריך או שעה"],
      [3, HIDDEN_ROW, "תאריך או שעה"],
      [4, NOT_IN_PICK, "7"],
    ]);
    expect(result.errors).toEqual([]);
  });

  it("refuses the dates of built-in and custom formats end to end, and imports the numbers", async () => {
    const lines = [
      ...LINES,
      ...["אבטיח", "בננה", "שזיף", "תות", "ענבים", "תמר", "אפרסק", "משמש"].map((name, index) =>
        line(`M${index}`, name, null),
      ),
    ];
    const builtIn = (await planFile("dates-builtin.xlsx", lines)).plan;
    expect(builtIn.errors.map((error) => [error.rowNumber, error.message])).toEqual(
      [2, 3, 4, 7, 8, 9, 10].map((rowNumber) => [rowNumber, DATE_MESSAGE]),
    );
    // General, "0", #,##0, 0.00E+00 and text formats hold numbers; the date-styled cell of row 14 is blank.
    expect(builtIn.changes.map((change) => [change.rowNumber, change.to])).toEqual([
      [5, 7],
      [6, 3],
      [11, 1200],
      [12, 1000],
      [13, 4],
    ]);
    expect(builtIn.unchanged).toBe(1);

    const custom = (await planFile("dates-custom.xlsx", lines)).plan;
    expect(custom.errors.map((error) => error.rowNumber)).toEqual([2, 3, 4, 5, 13]);
    expect(custom.changes.map((change) => [change.rowNumber, change.to])).toEqual([
      [6, 12],
      [7, 3],
      [8, 4],
      [9, 5],
      [10, 6],
      [11, 7],
      [12, 8],
    ]);
  });
});

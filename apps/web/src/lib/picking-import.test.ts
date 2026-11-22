import { readFileSync } from "node:fs";

import { savePickLinesInputSchema } from "@ori/domain/grower";
import { describe, expect, it } from "vitest";

import type { PickProductLineRow } from "@/lib/queries/grower";

import {
  CODE_NOT_IN_PICK,
  HIDDEN_ROW,
  INVALID_CODE,
  INVALID_CODE_WITHOUT_NAME,
  mostlyNotInPick,
  NAME_IN_CODE_COLUMN,
  NO_HEADER_MESSAGE,
  NOT_IN_PICK,
  normalizeLabel,
  normalizeProductCode,
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

// The variety behind each line of LINES below: its id, the code the products
// screen shows for it and a file's "קוד מוצר" names it by. The same codes
// fill the code-*.xlsx fixtures.
const CODE = {
  L1: "6f1c2b9e-3d4a-4e8b-9a71-0c5d2e8f4b13",
  L2: "a3e9d0c4-7b21-4f6e-8d35-91b4c7e2a058",
  L3: "1d8b4f72-e05c-4a93-b6d1-3f27a9c8e604",
  L4: "c7a05e3b-92d4-41f8-a3e6-58d1b0f9c27a",
  L5: "4b62e8d1-a37f-4c05-9e18-d2f6c0b7a395",
} as const;
// Two of another grower's varieties: in no line of LINES.
const OTHER_GROWER = {
  A: "e85f13a7-6c2b-4d90-81fa-7b3e9d4c0216",
  B: "9c4d27b0-f318-4e6a-a5d2-60e1b8c3f947",
} as const;

const line = (
  id: string,
  name: string,
  sizes: string | null,
  palletsPicked = 0,
  leftoverPallets = 0,
  comment: string | null = null,
  // A line of LINES has its code above; any other line a variety of its own.
  varietyId: string = (CODE as Record<string, string>)[id] ?? `variety-${id}`,
  familyName: string | null = null,
): PickLineForImport => ({ id, varietyId, name, sizes, familyName, palletsPicked, leftoverPallets, comment });

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

// The template's header since the code column: the code first (column A,
// on the sheet's right), then the name and the quantity.
const CODE_HEADER: XlsxCellValue[] = ["קוד מוצר", "מוצר", "משטחים שנקטפו"];

// A sheet with that header on row 1: each row a code, a name and a quantity.
function codeRows(...data: Array<[XlsxCellValue, XlsxCellValue, XlsxCellValue]>): PickFileRow[] {
  const rows = readPickFileRows(sheetOf(CODE_HEADER, ...data));
  if (!rows) throw new Error("expected the header to be found");
  return rows;
}

function codePlan(...data: Array<[XlsxCellValue, XlsxCellValue, XlsxCellValue]>) {
  return planPickImport(codeRows(...data), LINES, NOTHING_ARRANGED);
}

// That header on row 1, then rows as the reader gives them.
function codeSheetWith(...rows: XlsxRow[]): XlsxSheet {
  return { name: "ליקוט", rows: [{ rowNumber: 1, cells: CODE_HEADER }, ...rows] };
}

// A sheet as the reader gives it when the file hides those columns (A = 0).
function hiding(sheet: XlsxSheet, ...hiddenColumns: number[]): XlsxSheet {
  return { ...sheet, hiddenColumns };
}

// What a file whose code column is A, hidden, is refused with (without the isolates).
const HIDDEN_CODE_COLUMN_A =
  'העמודה "קוד מוצר" (עמודה A) מוסתרת בקובץ, ואי אפשר לבדוק מה כתוב בה — וכשיש בשורה קוד, הקוד קובע איזה מוצר זה. הציגו את העמודה ב-Excel ונסו שוב.';

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
  // The two-column template the screen offered before the code column, which
  // files filled in from it still are (the one offered now: "product codes").
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

  // The database's own limit on a pick line (migration 0109): 9,999 pallets.
  it("refuses more than 9,999 pallets on a line, as the database does, naming the limit", () => {
    expect(plain(plan(["מלפפון", 10_000]).errors[0]?.message ?? "")).toBe(
      "10000 גדול מדי — אפשר לכל היותר 9,999 משטחים בשורה.",
    );
    expect(plain(plan(["מלפפון", 100_000_000]).errors[0]?.message ?? "")).toMatch(/^100000000 גדול מדי/);
    expect(plan(["מלפפון", 9_999]).errors).toEqual([]);
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

  // The two-column template, as it was downloaded before the code column.
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
  it("takes the pick editor's rows as plain numbers, each with its variety's id and family", () => {
    const row: PickProductLineRow = {
      id: "A",
      pallets_picked: 8,
      leftover_pallets: 0.5,
      comment: null,
      product_variety_id: CODE.L1,
      product_varieties: {
        name: "רד-דיימונד",
        sizes: "גדול",
        family_id: "F",
        product_families: { name: "תפוח", image_url: null },
      },
    };
    const withoutFamily: PickProductLineRow = {
      ...row,
      id: "B",
      product_varieties: { ...row.product_varieties!, product_families: null },
    };
    expect(toImportLines([row, withoutFamily])).toEqual([
      {
        id: "A",
        varietyId: CODE.L1,
        name: "רד-דיימונד",
        sizes: "גדול",
        familyName: "תפוח",
        palletsPicked: 8,
        leftoverPallets: 0.5,
        comment: null,
      },
      {
        id: "B",
        varietyId: CODE.L1,
        name: "רד-דיימונד",
        sizes: "גדול",
        familyName: null,
        palletsPicked: 8,
        leftoverPallets: 0.5,
        comment: null,
      },
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

// The product code (workbook Task 38, follow-up): a file's "קוד מוצר" names a
// product by its variety's id, which the products screen shows and copies.

describe("normalizeProductCode", () => {
  it("reads a code as the products screen copies it", () => {
    expect(normalizeProductCode(CODE.L1)).toBe(CODE.L1);
  });

  it("reads it in capitals, in braces, without hyphens, with spaces and invisible marks around or inside it", () => {
    const written = [
      CODE.L1.toUpperCase(),
      `{${CODE.L1}}`,
      `{${CODE.L1.toUpperCase()}}`,
      CODE.L1.replaceAll("-", ""),
      CODE.L1.replaceAll("-", "").toUpperCase(),
      `  ${CODE.L1}\t`,
      `\u00A0${CODE.L1}\u00A0\n`,
      `\u200F${CODE.L1}\u200E`,
      `\u2068${CODE.L1}\u2069`,
      `\uFEFF${CODE.L1}`,
      `${CODE.L1.slice(0, 9)}\u200B${CODE.L1.slice(9)}`,
      `${CODE.L1.slice(0, 4)}\u00AD${CODE.L1.slice(4)}`,
      ` \u200F {${CODE.L1.toUpperCase()}} \u200E `,
    ];
    for (const text of written) expect([text, normalizeProductCode(text)]).toEqual([text, CODE.L1]);
  });

  it("is no code for anything else in the cell, a number or TRUE among them", () => {
    const notCodes: XlsxCellValue[] = [
      null,
      "",
      "   ",
      "\u200F",
      // A character short, or one too many.
      CODE.L1.slice(0, -1),
      `${CODE.L1}0`,
      // Not hex.
      CODE.L1.replace("6f1c", "6g1c"),
      // Braces only around the hyphenated form; braces and parentheses not closed or not braces.
      `{${CODE.L1.replaceAll("-", "")}}`,
      `{${CODE.L1}`,
      `(${CODE.L1})`,
      `{ ${CODE.L1} }`,
      // Spaces inside, dashes for hyphens, hyphens out of place.
      CODE.L1.replace("-", " - "),
      CODE.L1.replaceAll("-", "\u2013"),
      CODE.L1.replaceAll("-", "\u05BE"),
      "6f1c2b9e3-d4a-4e8b-9a71-0c5d2e8f4b13",
      `urn:uuid:${CODE.L1}`,
      `${CODE.L1} ${CODE.L2}`,
      "רד-דיימונד גדול",
      // A long text, cut.
      `${"a".repeat(200)}…`,
      12345,
      612_920_000_000_000,
      true,
      false,
    ];
    for (const cell of notCodes) expect([cell, normalizeProductCode(cell)]).toEqual([cell, null]);
  });
});

describe("readPickFileRows — the code column", () => {
  it("reads the code beside the name and the quantity, as the file holds it, in whatever columns they are", () => {
    const rows = readPickFileRows(
      sheetOf(
        ["ליקוט של יום שלישי"],
        [null, "משטחים שנקטפו", " קוד  מוצר ", "מוצר"],
        [null, 4, ` {${CODE.L3.toUpperCase()}} `, "מלפפון"],
        [null, 7, CODE.L1, null],
        [null, null, null, "פלפל אדום"],
      ),
    );
    expect(rows).toEqual([
      // As written — spaces, braces, capitals: what it means is the plan's to say.
      { rowNumber: 3, product: "מלפפון", quantity: 4, code: ` {${CODE.L3.toUpperCase()}} ` },
      { rowNumber: 4, product: "", quantity: 7, code: CODE.L1 },
      // The column is there, its cell empty.
      { rowNumber: 5, product: "פלפל אדום", quantity: null, code: null },
    ]);
  });

  it("keeps a number or TRUE in the code's cell as it is, and cuts a long text there like any other", () => {
    expect(codeRows([12345, "מלפפון", 1], [true, null, 2], ["א".repeat(100_000), null, 3])).toEqual([
      { rowNumber: 2, product: "מלפפון", quantity: 1, code: 12345 },
      { rowNumber: 3, product: "", quantity: 2, code: true },
      { rowNumber: 4, product: "", quantity: 3, code: `${"א".repeat(200)}…` },
    ]);
  });

  it("finds a header with the code and no name, and reads every row's product as empty", () => {
    expect(readPickFileRows(sheetOf(["קוד מוצר", "משטחים שנקטפו"], [CODE.L3, 11], [null, 3]))).toEqual([
      { rowNumber: 2, product: "", quantity: 11, code: CODE.L3 },
      { rowNumber: 3, product: "", quantity: 3, code: null },
    ]);
  });

  it("reads a file without the code column exactly as before: no row has a code", () => {
    const rows = readPickFileRows(sheetOf(["מוצר", "משטחים שנקטפו"], ["מלפפון", 4], [null, 5]));
    expect(rows).toEqual([
      { rowNumber: 2, product: "מלפפון", quantity: 4 },
      { rowNumber: 3, product: "", quantity: 5 },
    ]);
    expect(rows?.some((row) => "code" in row)).toBe(false);
  });

  it("needs the quantity's column, and the code's or the name's beside it", () => {
    expect(readPickFileRows(sheetOf(["קוד מוצר", "מוצר"], [CODE.L3, "מלפפון"]))).toBeNull();
    expect(readPickFileRows(sheetOf(["קוד מוצר"], [CODE.L3]))).toBeNull();
    expect(readPickFileRows(sheetOf(["משטחים שנקטפו"], [4]))).toBeNull();
    // Near the title is not the title.
    expect(readPickFileRows(sheetOf(["קוד", "משטחים שנקטפו"], [CODE.L3, 4]))).toBeNull();
    expect(readPickFileRows(sheetOf(["קוד המוצר", "משטחים שנקטפו"], [CODE.L3, 4]))).toBeNull();
  });

  it("says which columns it looks for when it finds none", () => {
    expect(NO_HEADER_MESSAGE).toBe(
      'לא נמצאו בקובץ העמודות של תבנית הליקוט: עמודה בשם "משטחים שנקטפו", ולצידה עמודה בשם "קוד מוצר" או "מוצר" (או שתיהן). יש להעלות את תבנית הליקוט של אורי ("הורדת תבנית") אחרי שמילאתם אותה. הכותרות נמצאות בשורה הראשונה של הגיליון "ליקוט".',
    );
  });

  it("leaves out a row with no code, no name and no quantity, and keeps one with only a code", () => {
    expect(codeRows([null, null, null], ["  ", " ", "  "], ["\u200F", null, null], [CODE.L1, null, null])).toEqual([
      { rowNumber: 5, product: "", quantity: null, code: CODE.L1 },
    ]);
  });

  it("refuses a header row that gives the code's title to more than one column, naming the columns", () => {
    expect(
      headerRefusal(sheetOf(["קוד מוצר", "מוצר", "משטחים שנקטפו", " קוד  מוצר "], [CODE.L1, "מלפפון", 1, CODE.L3])),
    ).toBe(
      'בשורת הכותרות יש יותר מעמודה אחת בשם "קוד מוצר" (עמודות A, D), ואי אפשר לדעת מאיזו מהן לקרוא. השאירו עמודה אחת בשם הזה ונסו שוב. אם אחת העמודות מוסתרת, הציגו אותה ב-Excel.',
    );
    // In a file without the name's column too.
    expect(headerRefusal(sheetOf(["קוד מוצר", "משטחים שנקטפו", "קוד מוצר"], [CODE.L1, 1, CODE.L3]))).toContain(
      'בשם "קוד מוצר" (עמודות A, C)',
    );
  });

  // The review that found the codes deciding from a hidden column A: a name
  // in view retyped, its row saved into the product of the code beside it,
  // and a name the pick has skipped for a code the screen does not show.
  it("refuses a code column the file hides once a row in view holds anything in it, naming the column", () => {
    // A code beside a name it does not agree with; a cell that is no code.
    expect(headerRefusal(hiding(sheetOf(CODE_HEADER, [CODE.L5, "פלפל ירוק", 9]), 0))).toBe(HIDDEN_CODE_COLUMN_A);
    expect(headerRefusal(hiding(sheetOf(CODE_HEADER, ["לא קוד", "מלפפון", 1]), 0))).toBe(HIDDEN_CODE_COLUMN_A);
    // A code in view, alone in its row, among rows the file hides as well.
    expect(
      headerRefusal(
        hiding(
          codeSheetWith(
            { rowNumber: 2, cells: [OTHER_GROWER.A, null, null], hidden: true },
            { rowNumber: 3, cells: [CODE.L3, null, null] },
            { rowNumber: 4, cells: [CODE.L1, "רד-דיימונד גדול", 4], hidden: true },
          ),
          0,
        ),
      ),
    ).toBe(HIDDEN_CODE_COLUMN_A);
    // Wherever the column is, by its own letter, and in a file without the name's column.
    expect(
      headerRefusal(hiding(sheetOf(["משטחים שנקטפו", "מוצר", "קוד מוצר"], [9, "פלפל ירוק", CODE.L5]), 2)),
    ).toContain('העמודה "קוד מוצר" (עמודה C) מוסתרת בקובץ');
    expect(headerRefusal(hiding(sheetOf(["קוד מוצר", "משטחים שנקטפו"], [CODE.L3, 4]), 0))).toBe(HIDDEN_CODE_COLUMN_A);
  });

  it("reads a hidden code column that holds nothing as if it were in view", () => {
    // Blank, or nothing but spaces and a direction mark.
    const sheet = sheetOf(CODE_HEADER, [null, "מלפפון", 4], ["  ‏", "פלפל אדום", 2]);
    expect(readPickFileRows(hiding(sheet, 0))).toEqual([
      { rowNumber: 2, product: "מלפפון", quantity: 4, code: null },
      { rowNumber: 3, product: "פלפל אדום", quantity: 2, code: "  ‏" },
    ]);
    expect(readPickFileRows(hiding(sheetOf(CODE_HEADER), 0))).toEqual([]);
  });

  // The final review: a code column hidden, its only codes in rows the file
  // hides too. Refused, the person shown the column found no code in view
  // to say why — and the file, uploaded again, read just as it would have.
  it("reads a hidden code column whose codes are all in hidden rows as if in view, still counting them", () => {
    const sheet = codeSheetWith(
      { rowNumber: 2, cells: [null, "רד-דיימונד גדול", 7] },
      { rowNumber: 3, cells: [CODE.L3, "מלפפון", 4], hidden: true },
      // Spaces and a direction mark, in view: nothing.
      { rowNumber: 4, cells: ["  \u200F", "עגבניה שרי", 2] },
      { rowNumber: 5, cells: [OTHER_GROWER.A, null, null], hidden: true },
    );
    const rows = readPickFileRows(hiding(sheet, 0));
    expect(rows).toEqual([
      { rowNumber: 2, product: "רד-דיימונד גדול", quantity: 7, code: null },
      { rowNumber: 3, product: "מלפפון", quantity: 4, code: CODE.L3, hidden: true },
      { rowNumber: 4, product: "עגבניה שרי", quantity: 2, code: "  \u200F" },
      { rowNumber: 5, product: "", quantity: null, code: OTHER_GROWER.A, hidden: true },
    ]);
    expect(rows).toEqual(readPickFileRows(sheet));
    const result = planPickImport(rows ?? [], LINES, NOTHING_ARRANGED);
    expect(result.changes.map((change) => [change.rowNumber, change.lineId, change.to])).toEqual([
      [2, "L1", 7],
      [4, "L2", 2],
    ]);
    expect(result.notImported).toEqual([
      { rowNumber: 3, product: "מלפפון", quantity: "4", reason: HIDDEN_ROW, suggestions: [] },
    ]);
    expect(result.errors).toEqual([]);
    // Both hidden rows counted, by their codes: מלפפון's is this pick's, the other grower's is not.
    expect(result.hiddenProducts).toEqual({ count: 2, notInPick: 1 });

    // Another grower's codes, hidden in a hidden column, still warn.
    const otherGrowers = codeSheetWith(
      { rowNumber: 2, cells: [null, "מלפפון", 1] },
      { rowNumber: 3, cells: [OTHER_GROWER.A, null, null], hidden: true },
      { rowNumber: 4, cells: [OTHER_GROWER.B, null, 2], hidden: true },
    );
    const warned = planPickImport(readPickFileRows(hiding(otherGrowers, 0)) ?? [], LINES, NOTHING_ARRANGED);
    expect(warned.hiddenProducts).toEqual({ count: 2, notInPick: 2 });
    expect(mostlyNotInPick(warned)).toBe(true);
  });

  it("reads past every other hidden column as it always did, the name's and the quantity's among them", () => {
    // Neither overrules a column in view, as a hidden code would the name.
    const withCodes = sheetOf(CODE_HEADER, [CODE.L3, "מלפפון", 4], [CODE.L1, "פלפל ירוק", 2]);
    expect(readPickFileRows(hiding(withCodes, 1, 2, 3, 4, 5))).toEqual(readPickFileRows(withCodes));
    const twoColumn = sheetOf(["מוצר", "משטחים שנקטפו"], ["מלפפון", 4]);
    expect(readPickFileRows(hiding(twoColumn, 0, 1))).toEqual(readPickFileRows(twoColumn));
  });

  it("refuses a code title over two columns, one of them hidden, as a title repeated", () => {
    const sheet = sheetOf(["קוד מוצר", "מוצר", "משטחים שנקטפו", "קוד מוצר"], [CODE.L1, "מלפפון", 1, CODE.L3]);
    expect(headerRefusal(hiding(sheet, 0))).toContain('בשם "קוד מוצר" (עמודות A, D)');
  });

  it("keeps a hidden row that has a code, with or without a name, and drops one with neither", () => {
    expect(
      readPickFileRows(
        codeSheetWith(
          { rowNumber: 2, cells: [CODE.L3, null, 4], hidden: true },
          { rowNumber: 3, cells: [OTHER_GROWER.A, null, null], hidden: true },
          { rowNumber: 4, cells: ["לא קוד", "מלפפון", null], hidden: true },
          { rowNumber: 5, cells: [null, null, 6], hidden: true },
          { rowNumber: 6, cells: ["\u200F", "  ", 7], hidden: true },
        ),
      ),
    ).toEqual([
      { rowNumber: 2, product: "", quantity: 4, code: CODE.L3, hidden: true },
      { rowNumber: 3, product: "", quantity: null, code: OTHER_GROWER.A, hidden: true },
      { rowNumber: 4, product: "מלפפון", quantity: null, code: "לא קוד", hidden: true },
    ]);
  });
});

describe("planPickImport — by code", () => {
  const CONFLICT = (code: string, name: string) =>
    `הקוד והשם בשורה מתאימים לשני מוצרים שונים בליקוט של המגדל: הקוד הוא של "${code}", והשם של "${name}". תקנו את השורה כך שהקוד והשם יהיו של אותו מוצר, או מחקו אחד מהם.`;

  it("matches a row by its code: alone, beside its own name, or beside a name the pick does not have", () => {
    const result = codePlan(
      [CODE.L1, null, 7],
      [CODE.L2, "עגבניה שרי", 0],
      // The grower's own name for Cherry L.
      [CODE.L4, "שרי צהוב", 4],
    );
    expect(result).toEqual({
      rowCount: 3,
      changes: [
        // Ori's own label for each line, whatever the file calls it.
        { rowNumber: 2, lineId: "L1", product: "רד-דיימונד גדול", from: 3, to: 7 },
        { rowNumber: 3, lineId: "L2", product: "עגבניה שרי", from: 5, to: 0 },
        { rowNumber: 4, lineId: "L4", product: "Cherry L", from: 0, to: 4 },
      ],
      unchanged: 0,
      notImported: [],
      errors: [],
    });
  });

  it("matches a code however the cell holds it", () => {
    const result = codePlan(
      [CODE.L1.toUpperCase(), null, 1],
      [`{${CODE.L2}}`, null, 2],
      [CODE.L3.replaceAll("-", ""), null, 3],
      [`  \u200F${CODE.L4}\u200E\u00A0`, null, 4],
      [`{${CODE.L5.toUpperCase()}}`, null, 5],
    );
    expect(result.changes.map((change) => [change.rowNumber, change.lineId, change.to])).toEqual([
      [2, "L1", 1],
      [3, "L2", 2],
      [4, "L3", 3],
      [5, "L4", 4],
      [6, "L5", 5],
    ]);
    expect(result.notImported).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("lets the code decide between two lines that share a name", () => {
    const plum1 = "11111111-1111-4111-8111-111111111111";
    const plum2 = "22222222-2222-4222-8222-222222222222";
    const lines = [line("P1", "שזיף", null, 1, 0, null, plum1), line("P2", "שזיף", null, 2, 0, null, plum2)];
    const result = planPickImport(codeRows([plum2, "שזיף", 4]), lines, NOTHING_ARRANGED);
    expect(result.changes).toEqual([{ rowNumber: 2, lineId: "P2", product: "שזיף", from: 2, to: 4 }]);
    expect(result.errors).toEqual([]);
    // Without its code, the same row is the shared name it always was.
    expect(planPickImport(codeRows([null, "שזיף", 4]), lines, NOTHING_ARRANGED).errors[0]?.message).toMatch(
      /^השם מתאים ליותר ממוצר אחד/,
    );
  });

  // The final review: nothing makes a variety's name and size unique, and a
  // row whose code was the neighbouring variety's showed in the preview
  // exactly as the right one would.
  it("shows a change to a line that shares its label with its family's name", () => {
    const ids = {
      romaine: "11111111-1111-4111-8111-1111111111a1",
      iceberg: "22222222-2222-4222-8222-2222222222b2",
    };
    const lettuce = (id: string, varietyId: string, familyName: string | null) =>
      line(id, "חסה", "גדול", 0, 0, null, varietyId, familyName);
    const changes = (lines: PickLineForImport[], ...varietyIds: string[]) =>
      planPickImport(
        codeRows(...varietyIds.map((code, index): [XlsxCellValue, XlsxCellValue, XlsxCellValue] => [code, "חסה גדול", index + 1])),
        lines,
        NOTHING_ARRANGED,
      ).changes.map((change) => [change.lineId, plain(change.product)]);

    // Each line by its family, as the pick editor groups them.
    const twoFamilies = [lettuce("A", ids.romaine, "חסות"), lettuce("B", ids.iceberg, "עלים")];
    expect(changes(twoFamilies, ids.romaine, ids.iceberg)).toEqual([
      ["A", "חסות — חסה גדול"],
      ["B", "עלים — חסה גדול"],
    ]);
    // A line that came without its family is shown by its label.
    expect(changes([lettuce("A", ids.romaine, null), lettuce("B", ids.iceberg, null)], ids.iceberg)).toEqual([
      ["B", "חסה גדול"],
    ]);
    // A label no other line shares is the label alone, as it always was.
    expect(planPickImport(codeRows([CODE.L1, null, 7]), [...LINES, ...twoFamilies], NOTHING_ARRANGED).changes).toEqual([
      { rowNumber: 2, lineId: "L1", product: "רד-דיימונד גדול", from: 3, to: 7 },
    ]);
    // What blocks the upload is called by the label alone: nothing of it is saved.
    expect(planPickImport(codeRows([ids.romaine, null, 2.5]), twoFamilies, NOTHING_ARRANGED).errors[0]?.product).toBe(
      "חסה גדול",
    );
  });

  it("refuses a row whose code and name are two different products of the pick, naming both", () => {
    const result = codePlan(
      [CODE.L1, "מלפפון", 5],
      // However the name is typed.
      [CODE.L3, "רד־דיימונד  גדול", 6],
      [CODE.L2, "עגבניה שרי", 6],
    );
    expect(result.errors.map((error) => [error.rowNumber, error.product, plain(error.message)])).toEqual([
      [2, "מלפפון", CONFLICT("רד-דיימונד גדול", "מלפפון")],
      [3, "רד־דיימונד גדול", CONFLICT("מלפפון", "רד-דיימונד גדול")],
    ]);
    // Each label isolated, as an English name keeps its own direction.
    expect(result.errors[0]?.message).toContain('"\u2068רד-דיימונד גדול\u2069"');
    // Neither of the two lines is touched by a row that contradicts itself;
    // and any error stops the whole upload, the good row with it.
    expect(result.changes.map((change) => change.lineId)).toEqual(["L2"]);
    expect(result.unchanged).toBe(0);
  });

  it("skips a code no line of the pick has, even beside a name the pick has", () => {
    const result = codePlan([OTHER_GROWER.A, "מלפפון", 4], [OTHER_GROWER.B, null, 2], [CODE.L1, null, 7]);
    expect(result.notImported).toEqual([
      { rowNumber: 2, product: "מלפפון", quantity: "4", reason: CODE_NOT_IN_PICK, suggestions: [] },
      // No name: shown by its code.
      { rowNumber: 3, product: OTHER_GROWER.B, quantity: "2", reason: CODE_NOT_IN_PICK, suggestions: [] },
    ]);
    // מלפפון, the name in row 2, is not touched.
    expect(result.changes).toEqual([{ rowNumber: 4, lineId: "L1", product: "רד-דיימונד גדול", from: 3, to: 7 }]);
    expect(result.errors).toEqual([]);
    expect(CODE_NOT_IN_PICK).toBe("קוד המוצר לא נמצא בליקוט של המגדל. כשיש בשורה קוד, הקוד קובע איזה מוצר זה");
  });

  it("skips a cell that is no code, never reading the row by its name instead", () => {
    const result = codePlan(
      [CODE.L3.slice(0, -1), "מלפפון", 9],
      [12345, null, 6],
      [true, "עגבניה שרי", 7],
      // מלפפון by name: no duplicate of row 2, which was never read by its name.
      [null, "מלפפון", 3],
    );
    expect(result.notImported).toEqual([
      { rowNumber: 2, product: "מלפפון", quantity: "9", reason: INVALID_CODE, suggestions: [] },
      // No name to read it by: told only to copy the code again (next test).
      { rowNumber: 3, product: "12345", quantity: "6", reason: INVALID_CODE_WITHOUT_NAME, suggestions: [] },
      { rowNumber: 4, product: "עגבניה שרי", quantity: "7", reason: INVALID_CODE, suggestions: [] },
    ]);
    expect(result.changes).toEqual([{ rowNumber: 5, lineId: "L3", product: "מלפפון", from: 2, to: 3 }]);
    expect(result.errors).toEqual([]);
    expect(INVALID_CODE).toBe(
      'קוד המוצר לא תקין. העתיקו אותו שוב מעמודת "קוד מוצר" במסך המוצרים, או מחקו אותו כדי שהשורה תיקרא לפי שם המוצר',
    );
  });

  // Deleting the code, in a row without a name, only leads to the next skip:
  // "אין בשורה קוד מוצר או שם מוצר".
  it("tells a row without a name only to copy its code again, never to delete it and be read by a name", () => {
    const withName = codePlan(["לא קוד", "מלפפון", 1]);
    const withoutName = codePlan(["לא קוד", null, 1], ["לא קוד", "  ‏ ", 2]);
    const onlyCodes = planPickImport(
      readPickFileRows(sheetOf(["קוד מוצר", "משטחים שנקטפו"], ["לא קוד", 3])) ?? [],
      LINES,
      NOTHING_ARRANGED,
    );
    expect(withName.notImported.map((skip) => skip.reason)).toEqual([INVALID_CODE]);
    expect(withoutName.notImported.map((skip) => skip.reason)).toEqual([
      INVALID_CODE_WITHOUT_NAME,
      INVALID_CODE_WITHOUT_NAME,
    ]);
    expect(onlyCodes.notImported.map((skip) => skip.reason)).toEqual([INVALID_CODE_WITHOUT_NAME]);
    expect(INVALID_CODE_WITHOUT_NAME).toBe('קוד המוצר לא תקין. העתיקו אותו שוב מעמודת "קוד מוצר" במסך המוצרים');
    // Either way a row that named something, and never a sign of another
    // grower: beside one row of another grower's, neither tips the warning.
    expect(mostlyNotInPick(codePlan(["לא קוד", null, 1], [OTHER_GROWER.A, null, 2]))).toBe(false);
    expect(mostlyNotInPick(codePlan(["לא קוד", null, 1], ["לא קוד", null, 2], [OTHER_GROWER.A, null, 3]))).toBe(false);
  });

  // The final review: the template before the code column began with
  // "מוצר", and a name typed into the first column of this one was told to
  // copy its code again — or, from an old file's rows pasted at A2, to
  // delete it and be read by the quantity beside it.
  it("says a name of the pick's in the code's column is a name, not a code, and never reads the row by it", () => {
    const result = codePlan(
      ["רד-דיימונד גדול", null, 7],
      // Typed another way, as a name is matched: a maqaf, two spaces, capitals.
      ["רד־דיימונד  גדול ", null, 3],
      ["CHERRY L", null, 2],
      // Beside a name: the same one, or another of the pick's.
      ["מלפפון", "מלפפון", 4],
      ["עגבניה שרי", "פלפל אדום", 6],
      // A name the pick does not have, or a name without its size: no code, as before.
      ["חציל", null, 1],
      ["רד-דיימונד", null, 1],
      // מלפפון by name: no duplicate of row 5, which was never read by its name.
      [null, "מלפפון", 9],
    );
    expect(result.notImported).toEqual([
      { rowNumber: 2, product: "רד-דיימונד גדול", quantity: "7", reason: NAME_IN_CODE_COLUMN, suggestions: [] },
      { rowNumber: 3, product: "רד־דיימונד גדול", quantity: "3", reason: NAME_IN_CODE_COLUMN, suggestions: [] },
      { rowNumber: 4, product: "CHERRY L", quantity: "2", reason: NAME_IN_CODE_COLUMN, suggestions: [] },
      { rowNumber: 5, product: "מלפפון", quantity: "4", reason: NAME_IN_CODE_COLUMN, suggestions: [] },
      { rowNumber: 6, product: "פלפל אדום", quantity: "6", reason: NAME_IN_CODE_COLUMN, suggestions: [] },
      { rowNumber: 7, product: "חציל", quantity: "1", reason: INVALID_CODE_WITHOUT_NAME, suggestions: [] },
      { rowNumber: 8, product: "רד-דיימונד", quantity: "1", reason: INVALID_CODE_WITHOUT_NAME, suggestions: [] },
    ]);
    expect(result.changes).toEqual([{ rowNumber: 9, lineId: "L3", product: "מלפפון", from: 2, to: 9 }]);
    expect(result.errors).toEqual([]);
    expect(NAME_IN_CODE_COLUMN).toBe(
      'בעמודה "קוד מוצר" כתוב שם של מוצר ולא קוד. העבירו אותו לעמודה "מוצר", או העתיקו את הקוד ממסך המוצרים',
    );
    // Hidden, it is a hidden row like any other.
    const hidden = planPickImport(
      readPickFileRows(codeSheetWith({ rowNumber: 2, cells: ["מלפפון", null, 4], hidden: true })) ?? [],
      LINES,
      NOTHING_ARRANGED,
    );
    expect(hidden.notImported.map((skip) => skip.reason)).toEqual([HIDDEN_ROW]);
    expect(hidden.hiddenProducts).toEqual({ count: 1, notInPick: 0 });
  });

  it("weighs a name in the code's column in the warning about another grower's file exactly as a mistyped code", () => {
    const files: Array<Array<[XlsxCellValue, XlsxCellValue, XlsxCellValue]>> = [
      [
        ["מלפפון", null, 1],
        [OTHER_GROWER.A, null, 2],
      ],
      [
        ["מלפפון", null, 1],
        ["עגבניה שרי", null, 2],
        [OTHER_GROWER.A, null, 3],
      ],
      [
        ["Cherry L", "מלפפון", 1],
        [OTHER_GROWER.A, null, 2],
        [OTHER_GROWER.B, "פלפל אדום", 3],
      ],
      [["רד-דיימונד גדול", null, 1]],
    ];
    const warns = (rows: Array<[XlsxCellValue, XlsxCellValue, XlsxCellValue]>) => mostlyNotInPick(codePlan(...rows));
    const mistyped = (rows: Array<[XlsxCellValue, XlsxCellValue, XlsxCellValue]>) =>
      rows.map(([code, name, quantity]): [XlsxCellValue, XlsxCellValue, XlsxCellValue] => [
        normalizeProductCode(code) === null ? "לא קוד" : code,
        name,
        quantity,
      ]);
    expect(files.map(warns)).toEqual([false, false, true, false]);
    expect(files.map(warns)).toEqual(files.map((rows) => warns(mistyped(rows))));
  });

  it("does not check the quantity of a row it skips for its code", () => {
    const result = codePlan([OTHER_GROWER.A, null, "שבע"], ["לא קוד", null, -1]);
    expect(result.errors).toEqual([]);
    expect(result.notImported.map((skip) => [skip.rowNumber, skip.reason, skip.quantity])).toEqual([
      [2, CODE_NOT_IN_PICK, "שבע"],
      [3, INVALID_CODE_WITHOUT_NAME, "-1"],
    ]);
  });

  it("matches a row without a code by its name, exactly as before", () => {
    const result = codePlan(
      [null, "מלפפון", 7],
      ["   ", "פלפל אדום", 4],
      ["\u200F", "Cherry L", 6],
      [null, "לא קיים", 1],
      [null, "רד-דיימונד", 2],
    );
    expect(result.changes.map((change) => [change.rowNumber, change.lineId, change.to])).toEqual([
      [2, "L3", 7],
      [3, "L5", 4],
      [4, "L4", 6],
    ]);
    expect(result.notImported).toEqual([
      { rowNumber: 5, product: "לא קיים", quantity: "1", reason: NOT_IN_PICK, suggestions: [] },
      { rowNumber: 6, product: "רד-דיימונד", quantity: "2", reason: NOT_IN_PICK, suggestions: ["רד-דיימונד גדול"] },
    ]);
  });

  it("says a row with only a quantity has neither a code nor a name, in a file with the code column", () => {
    expect(codePlan([null, null, 5]).notImported).toEqual([
      { rowNumber: 2, product: "", quantity: "5", reason: "אין בשורה קוד מוצר או שם מוצר", suggestions: [] },
    ]);
    // Without the column, the name is all it lacks — as before.
    expect(plan([null, 5]).notImported[0]?.reason).toBe("חסר שם מוצר");
  });

  it("refuses two rows that come to one line, however each of them names it", () => {
    const duplicate = "המוצר מופיע בקובץ יותר מפעם אחת (גם בשורה 2). השאירו שורה אחת לכל מוצר.";
    const errors = (result: PickImportPlan) => result.errors.map((error) => [error.rowNumber, error.product, error.message]);
    // Two codes, written two ways.
    const byCodes = codePlan([CODE.L1, null, 7], [CODE.L1.toUpperCase(), null, 7]);
    expect(errors(byCodes)).toEqual([[3, "רד-דיימונד גדול", duplicate]]);
    expect(byCodes.changes).toEqual([]);
    expect(byCodes.unchanged).toBe(0);
    // A code, then a name.
    expect(errors(codePlan([CODE.L3, null, 1], [null, "מלפפון", 1]))).toEqual([[3, "מלפפון", duplicate]]);
    // A name, then a code: the repeat, which has no name, called by Ori's label.
    expect(errors(codePlan([null, "עגבניה שרי", 1], [`{${CODE.L2}}`, null, 2]))).toEqual([[3, "עגבניה שרי", duplicate]]);
    // A code beside its own name, then the name alone.
    expect(errors(codePlan([CODE.L5, "פלפל אדום", 1], [null, "פלפל  אדום", 1]))).toEqual([[3, "פלפל אדום", duplicate]]);
  });

  it("calls a row known only by its code by Ori's label in what it refuses, and by the code where it skips it", () => {
    // L1: 3 picked + 1 leftover, 5 arranged.
    const result = planPickImport(
      codeRows([CODE.L1, null, 2], [CODE.L2, null, 2.5], [OTHER_GROWER.A.toUpperCase(), null, 1]),
      LINES,
      new Map([["L1", 5]]),
    );
    expect(result.errors.map((error) => [error.rowNumber, error.product])).toEqual([
      [2, "רד-דיימונד גדול"],
      [3, "עגבניה שרי"],
    ]);
    // As written, capitals and all: what to look for in the file.
    expect(result.notImported.map((skip) => [skip.rowNumber, skip.product])).toEqual([[4, OTHER_GROWER.A.toUpperCase()]]);
  });

  it("refuses a code two lines of the pick share, rather than choose one", () => {
    // One line per variety is the database's rule, so no real pick is like this.
    const lines = [line("P1", "שזיף", null, 1, 0, null, CODE.L1), line("P2", "שזיף אדום", null, 2, 0, null, CODE.L1)];
    const result = planPickImport(codeRows([CODE.L1, null, 4]), lines, NOTHING_ARRANGED);
    expect(result.changes).toEqual([]);
    expect(result.errors.map((error) => [error.rowNumber, error.product])).toEqual([[2, CODE.L1]]);
    expect(result.errors[0]?.message).toMatch(/^הקוד מתאים ליותר משורה אחת בליקוט של המגדל/);
  });

  it("matches a line whose variety id arrives in capitals", () => {
    // Postgres writes a uuid in lower case; read here in whichever case it comes.
    const lines = [line("L1", "רד-דיימונד", "גדול", 3, 1, null, CODE.L1.toUpperCase())];
    expect(planPickImport(codeRows([CODE.L1, null, 7]), lines, NOTHING_ARRANGED).changes).toEqual([
      { rowNumber: 2, lineId: "L1", product: "רד-דיימונד גדול", from: 3, to: 7 },
    ]);
  });

  it("saves a change made by code to its pick line, with the line's own leftover and comment", () => {
    const result = codePlan([CODE.L1, null, 7]);
    expect(result.changes[0]?.lineId).toBe("L1");
    expect(toSavePickLines(result, LINES)).toEqual([
      { dailyPickProductId: "L1", palletsPicked: 7, leftoverPallets: 1, comment: "בדיקה" },
    ]);
  });
});

describe("hidden rows with a code", () => {
  it("never imports one, lists it by its code when it has no name, and counts it by its code", () => {
    const rows = readPickFileRows(
      codeSheetWith(
        { rowNumber: 2, cells: [CODE.L3, null, 9] },
        // The same line as row 2: not a duplicate of it.
        { rowNumber: 3, cells: [CODE.L3, null, 4], hidden: true },
        // Another grower's code beside a name of this pick: counted as not in it.
        { rowNumber: 4, cells: [OTHER_GROWER.A, "מלפפון", null], hidden: true },
        // No code at all: no sign of whose file, whatever the name.
        { rowNumber: 5, cells: ["לא קוד", "לא קיים", null], hidden: true },
        // Its code and name disagree: hidden, it is not refused, and is counted by its code.
        { rowNumber: 6, cells: [CODE.L1, "מלפפון", 3], hidden: true },
        // A name and no code, as before.
        { rowNumber: 7, cells: [null, "גם לא קיים", null], hidden: true },
      ),
    );
    const result = planPickImport(rows ?? [], LINES, NOTHING_ARRANGED);
    expect(result.changes).toEqual([{ rowNumber: 2, lineId: "L3", product: "מלפפון", from: 2, to: 9 }]);
    expect(result.errors).toEqual([]);
    expect(result.notImported).toEqual([
      { rowNumber: 3, product: CODE.L3, quantity: "4", reason: HIDDEN_ROW, suggestions: [] },
      { rowNumber: 6, product: "מלפפון", quantity: "3", reason: HIDDEN_ROW, suggestions: [] },
    ]);
    expect(result.rowCount).toBe(3);
    expect(result.hiddenProducts).toEqual({ count: 5, notInPick: 2 });
  });

  // As with names: hiding a row does not change whose file it is.
  it("warns exactly as it would if no row were hidden", () => {
    const visible = (row: XlsxRow): XlsxRow => ({ rowNumber: row.rowNumber, cells: row.cells });
    const warns = (rows: XlsxRow[]) =>
      mostlyNotInPick(planPickImport(readPickFileRows(codeSheetWith(...rows)) ?? [], LINES, NOTHING_ARRANGED));
    const files: XlsxRow[][] = [
      [
        { rowNumber: 2, cells: [CODE.L3, null, 11] },
        { rowNumber: 3, cells: [OTHER_GROWER.A, null, null], hidden: true },
        { rowNumber: 4, cells: [OTHER_GROWER.B, "מלפפון", null], hidden: true },
      ],
      [
        { rowNumber: 2, cells: [OTHER_GROWER.A, null, 1] },
        { rowNumber: 3, cells: [CODE.L3, null, null], hidden: true },
        { rowNumber: 4, cells: ["לא קוד", "לא קיים", 4], hidden: true },
      ],
      [
        { rowNumber: 2, cells: [CODE.L1, "רד-דיימונד גדול", 1] },
        { rowNumber: 3, cells: [CODE.L1, "מלפפון", 2], hidden: true },
        { rowNumber: 4, cells: [OTHER_GROWER.A, null, 3], hidden: true },
      ],
      [
        { rowNumber: 2, cells: [OTHER_GROWER.A, null, 1] },
        { rowNumber: 3, cells: [OTHER_GROWER.B, null, null], hidden: true },
        { rowNumber: 4, cells: [CODE.L2, null, null], hidden: true },
      ],
    ];
    expect(files.map(warns)).toEqual([true, false, false, true]);
    expect(files.map(warns)).toEqual(files.map((rows) => warns(rows.map(visible))));
  });
});

describe("mostlyNotInPick — codes", () => {
  it("counts a code no line has like a name no line has, whatever name is beside it", () => {
    expect(mostlyNotInPick(codePlan([OTHER_GROWER.A, "מלפפון", 1], [OTHER_GROWER.B, null, 2], [CODE.L1, null, 3]))).toBe(
      true,
    );
    // Half is not most.
    expect(mostlyNotInPick(codePlan([OTHER_GROWER.A, "מלפפון", 1], [CODE.L1, null, 3]))).toBe(false);
  });

  it("counts a cell that is no code among the rows that name something, never as a sign of another grower", () => {
    // One code another grower's, one mistyped: half.
    expect(mostlyNotInPick(codePlan([OTHER_GROWER.A, null, 1], ["לא קוד", null, 2]))).toBe(false);
    // Mistyped codes beside names the pick lacks are no sign either way.
    expect(
      mostlyNotInPick(codePlan(["לא קוד", "לא קיים", 1], ["גם לא", "גם לא קיים", 2], [CODE.L1, null, 3])),
    ).toBe(false);
  });

  it("counts a row whose code and name disagree by its code, which is this pick's", () => {
    expect(mostlyNotInPick(codePlan([CODE.L1, "מלפפון", 1], [OTHER_GROWER.A, null, 2]))).toBe(false);
  });

  it("does not count a row with neither a code nor a name", () => {
    expect(mostlyNotInPick(codePlan([OTHER_GROWER.A, null, 1], [null, null, 2]))).toBe(true);
  });
});

describe("planChangedSince — codes", () => {
  const rows = codeRows([CODE.L1, null, 7], [CODE.L3, "מלפפון", 2], [OTHER_GROWER.A, null, 1]);
  const previewed = planPickImport(rows, LINES, NOTHING_ARRANGED);
  const replan = (lines: PickLineForImport[]) => planPickImport(rows, lines, NOTHING_ARRANGED);

  it("is false when nothing changed, or only a number the preview was about to set anyway", () => {
    expect(previewed.changes.map((change) => [change.lineId, change.to])).toEqual([["L1", 7]]);
    expect(planChangedSince(previewed, replan(LINES))).toBe(false);
    const alreadySet = LINES.map((pickLine) => (pickLine.id === "L1" ? { ...pickLine, palletsPicked: 7 } : pickLine));
    expect(planChangedSince(previewed, replan(alreadySet))).toBe(false);
  });

  it("is true when the line a code found has left the pick", () => {
    expect(planChangedSince(previewed, replan(LINES.filter((pickLine) => pickLine.id !== "L1")))).toBe(true);
  });

  it("is true when a code the pick did not have is one of its lines now", () => {
    const joined = [...LINES, line("L9", "חציל", null, 0, 0, null, OTHER_GROWER.A)];
    expect(planChangedSince(previewed, replan(joined))).toBe(true);
  });

  it("is true when a line added meanwhile is the one a row's name says, against its code", () => {
    // Row 2's name meant nothing in the pick when the preview was made.
    const named = codeRows([CODE.L1, "חציל", 7]);
    const before = planPickImport(named, LINES, NOTHING_ARRANGED);
    expect(before.errors).toEqual([]);
    const after = planPickImport(named, [...LINES, line("L9", "חציל", null)], NOTHING_ARRANGED);
    expect(after.errors.map((error) => error.rowNumber)).toEqual([2]);
    expect(planChangedSince(before, after)).toBe(true);
  });

  it("compares a change by the pick line it saves to, so the same variety on another line is news", () => {
    // L1 removed from the pick, and a line for its variety made again under a new id.
    const remade = LINES.map((pickLine) => (pickLine.id === "L1" ? { ...pickLine, id: "L1-again" } : pickLine));
    const current = replan(remade);
    expect(current.changes.map((change) => [change.lineId, change.to])).toEqual([["L1-again", 7]]);
    expect(planChangedSince(previewed, current)).toBe(true);
  });
});

describe("product codes, end to end", () => {
  const SHIPPED = new URL("../../public/templates/ori-picking-upload-template.xlsx", import.meta.url);

  it("reads the template the screen offers for download: its header found, no rows", async () => {
    const sheet = await readXlsxSheet(readFileSync(SHIPPED), UPLOAD);
    expect(sheet.name).toBe("ליקוט");
    expect(sheet.rows[0]?.cells.slice(0, 3)).toEqual(CODE_HEADER);
    expect(readPickFileRows(sheet)).toEqual([]);
    expect(planPickImport(readPickFileRows(sheet) ?? [], LINES, NOTHING_ARRANGED)).toEqual({
      rowCount: 0,
      changes: [],
      unchanged: 0,
      notImported: [],
      errors: [],
    });
  });

  it("reads the template filled in with codes and names", async () => {
    const { sheet, plan: result } = await planFile("code-template-filled.xlsx");
    expect(readPickFileRows(sheet)).toEqual([
      { rowNumber: 2, product: "רד-דיימונד גדול", quantity: 12, code: CODE.L1 },
      { rowNumber: 3, product: "", quantity: 0, code: CODE.L2 },
      { rowNumber: 4, product: "מלפפון", quantity: null, code: CODE.L3 },
      { rowNumber: 5, product: "פלפל אדום", quantity: "7", code: null },
      { rowNumber: 6, product: "שרי צהוב", quantity: 4, code: CODE.L4 },
    ]);
    expect(result).toEqual({
      rowCount: 5,
      changes: [
        { rowNumber: 2, lineId: "L1", product: "רד-דיימונד גדול", from: 3, to: 12 },
        { rowNumber: 3, lineId: "L2", product: "עגבניה שרי", from: 5, to: 0 },
        { rowNumber: 5, lineId: "L5", product: "פלפל אדום", from: 1, to: 7 },
        { rowNumber: 6, lineId: "L4", product: "Cherry L", from: 0, to: 4 },
      ],
      // מלפפון, its quantity left blank.
      unchanged: 1,
      notImported: [],
      errors: [],
    });
  });

  it("reads the codes however they were written, and skips the cells that hold none", async () => {
    const { sheet, plan: result } = await planFile("code-forms.xlsx");
    // As the file holds them: capitals, braces, marks and all.
    expect(sheet.rows.slice(1, 9).map((row) => row.cells[0])).toEqual([
      CODE.L1.toUpperCase(),
      `{${CODE.L2}}`,
      CODE.L3.replaceAll("-", ""),
      `  \uFEFF\u200F${CODE.L4.slice(0, 19)}\u200B${CODE.L4.slice(19)}\u200E\u00A0 `,
      `{${CODE.L5.toUpperCase()}}`,
      CODE.L3.slice(0, -1),
      12345,
      true,
    ]);
    expect(result.changes.map((change) => [change.rowNumber, change.lineId, change.to])).toEqual([
      [2, "L1", 1],
      [3, "L2", 2],
      [4, "L3", 3],
      [5, "L4", 4],
      [6, "L5", 5],
    ]);
    // Row 7 names מלפפון too, by a code a character short: skipped, not a second מלפפון.
    expect(result.notImported).toEqual([
      { rowNumber: 7, product: "מלפפון", quantity: "9", reason: INVALID_CODE, suggestions: [] },
      { rowNumber: 8, product: "12345", quantity: "6", reason: INVALID_CODE_WITHOUT_NAME, suggestions: [] },
      { rowNumber: 9, product: "עגבניה שרי", quantity: "7", reason: INVALID_CODE, suggestions: [] },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("refuses a row whose code and name are two products, which stops the whole file", async () => {
    const { plan: result } = await planFile("code-name-conflict.xlsx");
    expect(result.errors.map((error) => [error.rowNumber, error.product, plain(error.message)])).toEqual([
      [
        2,
        "מלפפון",
        'הקוד והשם בשורה מתאימים לשני מוצרים שונים בליקוט של המגדל: הקוד הוא של "רד-דיימונד גדול", והשם של "מלפפון". תקנו את השורה כך שהקוד והשם יהיו של אותו מוצר, או מחקו אחד מהם.',
      ],
    ]);
    // Planned, and not saved while the error stands.
    expect(result.changes.map((change) => [change.rowNumber, change.lineId, change.to])).toEqual([
      [3, "L2", 6],
      [4, "L5", 2],
    ]);
  });

  it("skips another grower's codes, even beside a name this pick has, and warns of whose file it is", async () => {
    const { plan: result } = await planFile("code-other-grower.xlsx");
    expect(result.notImported).toEqual([
      { rowNumber: 2, product: "מלפפון", quantity: "4", reason: CODE_NOT_IN_PICK, suggestions: [] },
      { rowNumber: 3, product: OTHER_GROWER.B, quantity: "2", reason: CODE_NOT_IN_PICK, suggestions: [] },
    ]);
    expect(result.changes).toEqual([{ rowNumber: 4, lineId: "L1", product: "רד-דיימונד גדול", from: 3, to: 7 }]);
    expect(result.errors).toEqual([]);
    expect(mostlyNotInPick(result)).toBe(true);
  });

  it("reads a file with the code's column and no name's", async () => {
    const { sheet, plan: result } = await planFile("code-only.xlsx");
    expect(sheet.rows[0]?.cells.slice(0, 3)).toEqual(["קוד מוצר", "משטחים שנקטפו", null]);
    expect(readPickFileRows(sheet)?.map((row) => [row.rowNumber, row.product, row.code, row.quantity])).toEqual([
      [2, "", CODE.L3, 11],
      [3, "", CODE.L1, 21],
      [4, "", OTHER_GROWER.A, 5],
      [5, "", null, 3],
      [6, "", "לא קוד", 1],
    ]);
    expect(result.changes.map((change) => [change.rowNumber, change.lineId, change.product, change.to])).toEqual([
      [2, "L3", "מלפפון", 11],
      [3, "L1", "רד-דיימונד גדול", 21],
    ]);
    expect(result.notImported).toEqual([
      { rowNumber: 4, product: OTHER_GROWER.A, quantity: "5", reason: CODE_NOT_IN_PICK, suggestions: [] },
      { rowNumber: 5, product: "", quantity: "3", reason: "אין בשורה קוד מוצר או שם מוצר", suggestions: [] },
      { rowNumber: 6, product: "לא קוד", quantity: "1", reason: INVALID_CODE_WITHOUT_NAME, suggestions: [] },
    ]);
    expect(result.errors).toEqual([]);
    expect(mostlyNotInPick(result)).toBe(false);
  });

  it("tells names typed into the code's column, as the template before it had them, from codes", async () => {
    // openpyxl: names in column A (קוד מוצר), B (מוצר) empty, quantities in C.
    const { plan: typed } = await planFile("code-column-names.xlsx");
    expect(typed.notImported).toEqual([
      { rowNumber: 2, product: "רד-דיימונד גדול", quantity: "7", reason: NAME_IN_CODE_COLUMN, suggestions: [] },
      { rowNumber: 3, product: "מלפפון", quantity: "4", reason: NAME_IN_CODE_COLUMN, suggestions: [] },
      { rowNumber: 4, product: "רד־דיימונד גדול", quantity: "3", reason: NAME_IN_CODE_COLUMN, suggestions: [] },
      { rowNumber: 5, product: "Cherry L", quantity: "2", reason: NAME_IN_CODE_COLUMN, suggestions: [] },
      // No product of this pick: a cell that is no code, as before.
      { rowNumber: 6, product: "חציל", quantity: "1", reason: INVALID_CODE_WITHOUT_NAME, suggestions: [] },
    ]);
    expect(typed.changes).toEqual([]);
    expect(typed.errors).toEqual([]);
    expect(mostlyNotInPick(typed)).toBe(false);

    // A two-column file's rows pasted at A2: names in A, quantities in B
    // (מוצר), C empty. Each row is called by what its name's cell holds.
    const { plan: pasted } = await planFile("code-column-old-rows-pasted.xlsx");
    expect(pasted.notImported).toEqual([
      { rowNumber: 2, product: "7", quantity: "", reason: NAME_IN_CODE_COLUMN, suggestions: [] },
      { rowNumber: 3, product: "4", quantity: "", reason: NAME_IN_CODE_COLUMN, suggestions: [] },
      { rowNumber: 4, product: "6", quantity: "", reason: NAME_IN_CODE_COLUMN, suggestions: [] },
    ]);
    expect(pasted.changes).toEqual([]);
    expect(pasted.errors).toEqual([]);
    expect(mostlyNotInPick(pasted)).toBe(false);
  });

  it("refuses the template with its code column hidden, rather than let codes nobody sees decide", async () => {
    // openpyxl, column A hidden as Excel's Hide writes it. Read, row 3's code
    // (פלפל אדום's) would save its 9 into פלפל אדום under the name פלפל ירוק,
    // and row 4's (another grower's) would skip the מלפפון in view.
    const sheet = await readXlsxSheet(fixture("code-column-hidden.xlsx"), UPLOAD);
    expect(sheet.hiddenColumns).toEqual([0]);
    expect(sheet.rows.slice(1, 4).map((row) => row.cells.slice(0, 3))).toEqual([
      [CODE.L1, "רד-דיימונד גדול", 5],
      [CODE.L5, "פלפל ירוק", 9],
      [OTHER_GROWER.A, "מלפפון", 6],
    ]);
    expect(headerRefusal(sheet)).toBe(HIDDEN_CODE_COLUMN_A);
    // The same rows, column A hidden as LibreOffice writes it ("true"), among
    // columns hidden and shown every other way.
    expect(headerRefusal(await readXlsxSheet(fixture("hidden-columns.xlsx"), UPLOAD))).toBe(HIDDEN_CODE_COLUMN_A);
    // And narrowed to a width of zero with no hidden flag, which Excel draws
    // as hidden: read, row 3 would have saved 9 into פלפל אדום unseen.
    const narrowed = await readXlsxSheet(fixture("code-column-zero-width.xlsx"), UPLOAD);
    expect(narrowed.hiddenColumns).toEqual([0]);
    expect(headerRefusal(narrowed)).toBe(HIDDEN_CODE_COLUMN_A);
  });

  it("reads the template with its code column hidden and codes only in hidden rows, as if the column were in view", async () => {
    // openpyxl: column A hidden; rows 3 (מלפפון's code, its name and 4) and 5
    // (another grower's code alone) hidden by hand; rows 2 and 4 in view,
    // named, with no code.
    const { sheet, plan: result } = await planFile("code-column-hidden-codes-in-hidden-rows.xlsx");
    expect(sheet.hiddenColumns).toEqual([0]);
    expect(sheet.rows.filter((row) => row.hidden).map((row) => row.rowNumber)).toEqual([3, 5]);
    expect(result.changes).toEqual([
      { rowNumber: 2, lineId: "L1", product: "רד-דיימונד גדול", from: 3, to: 7 },
      { rowNumber: 4, lineId: "L2", product: "עגבניה שרי", from: 5, to: 2 },
    ]);
    expect(result.notImported).toEqual([
      { rowNumber: 3, product: "מלפפון", quantity: "4", reason: HIDDEN_ROW, suggestions: [] },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.hiddenProducts).toEqual({ count: 2, notInPick: 1 });
    expect(mostlyNotInPick(result)).toBe(false);
  });

  it("reads the template with its empty code column hidden by name, as if it were in view", async () => {
    // Someone who uses no codes, tidying the template.
    const { sheet, plan: result } = await planFile("code-column-hidden-empty.xlsx");
    expect(sheet.hiddenColumns).toEqual([0]);
    expect(result.changes).toEqual([
      { rowNumber: 2, lineId: "L1", product: "רד-דיימונד גדול", from: 3, to: 5 },
      { rowNumber: 3, lineId: "L3", product: "מלפפון", from: 2, to: 6 },
    ]);
    expect(result.notImported).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  // The template states the plan's rules in words (picking-import.ts' header),
  // and what it says of a name beside a code is a promise: one that said more
  // than the plan checks had staff trusting the name to catch a wrong code.
  it("says in its instructions exactly what the plan checks of a row with a code", async () => {
    const instructions = await readXlsxSheet(readFileSync(SHIPPED), { ignoreSheets: ["ליקוט"] });
    expect(instructions.name).toBe(PICK_UPLOAD_INSTRUCTIONS_SHEET);
    const rules = instructions.rows.flatMap((row) => {
      const [text] = row.cells;
      return typeof text === "string" && text.startsWith("• ") ? [text] : [];
    });
    // The rules that speak of a code, as a word ("קודמים" is not one).
    expect(rules.filter((rule) => /(?:^|\s)קוד(?:\s|$)/.test(rule))).toEqual([
      "• כשיש בשורה קוד מוצר, הקוד קובע איזה מוצר זה. ההעלאה נעצרת רק אם השם שלידו הוא בדיוק שם של מוצר אחר בליקוט של המגדל — לכן בדקו בתצוגה המקדימה איזה מוצר ייקלט.",
      "• קוד לא תקין, או קוד של מוצר שאינו בליקוט של המגדל, יוצג בתצוגה המקדימה ולא ייקלט — גם אם השם שלידו נכון.",
    ]);
    // As the plan applies them: the name of another line of the pick stops
    // its row. Another grower's product, or this one typed another way (a
    // space for the hyphen), is no line of the pick, and the code decides —
    // which the preview shows by Ori's own label. A code not in the pick is
    // skipped beside a name that is.
    const result = codePlan(
      [CODE.L1, "מלפפון", 4],
      [CODE.L2, "חציל בלאדי", 6],
      [CODE.L5, "רד דיימונד גדול", 3],
      [OTHER_GROWER.A, "Cherry L", 2],
    );
    expect(result.errors.map((error) => error.rowNumber)).toEqual([2]);
    expect(result.changes.map((change) => [change.rowNumber, change.product, change.to])).toEqual([
      [3, "עגבניה שרי", 6],
      [4, "פלפל אדום", 3],
    ]);
    expect(result.notImported.map((skip) => [skip.rowNumber, skip.reason])).toEqual([[5, CODE_NOT_IN_PICK]]);
  });

  it("reads every two-column file exactly as before: no row carries a code", async () => {
    const twoColumn = [
      "template-empty.xlsx",
      "filled.xlsx",
      "hidden-rows-filter.xlsx",
      "dates-builtin.xlsx",
      "tabs-renamed-moved.xlsx",
    ];
    for (const name of twoColumn) {
      const rows = readPickFileRows(await readXlsxSheet(fixture(name), UPLOAD));
      expect([name, rows !== null, rows?.filter((row) => "code" in row)]).toEqual([name, true, []]);
    }
    // And a row without a name lacks only its name, as it did.
    expect((await planFile("filled.xlsx")).plan.notImported.at(-1)).toEqual({
      rowNumber: 11,
      product: "",
      quantity: "5",
      reason: "חסר שם מוצר",
      suggestions: [],
    });
  });
});

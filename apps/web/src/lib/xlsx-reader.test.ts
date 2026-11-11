import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  isDateFormatCode,
  isDateNumberFormat,
  readXlsxSheet,
  XlsxError,
  type XlsxErrorCode,
  type XlsxSheet,
} from "./xlsx-reader";

// Real files, not hand-built byte arrays: the shipped template itself (read
// from public/), the two-column template it replaced (template-empty.xlsx,
// a byte copy of it) and that template filled in by openpyxl, and parts
// written the way Excel and other generators write them (shared strings,
// rich text, prefixes, stored entries). They are built by scripts kept
// outside the repo; what each one holds is spelled out in the test that
// reads it.
function fixture(name: string): Uint8Array {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
}

// What the upload passes for the template: its instructions are never the data.
const TEMPLATE = { ignoreSheets: ["הוראות"] };

// A private copy, for the tests that damage a file on purpose.
function copyOf(name: string): Uint8Array {
  return new Uint8Array(fixture(name));
}

async function failureOf(read: Promise<unknown>): Promise<XlsxError> {
  try {
    await read;
  } catch (error) {
    if (error instanceof XlsxError) return error;
    throw error;
  }
  throw new Error("expected the read to fail");
}

async function codeOf(read: Promise<unknown>): Promise<XlsxErrorCode> {
  return (await failureOf(read)).code;
}

// The central directory's entries, so a test can change one field of one
// entry: the end record says where the directory starts and how many entries
// it lists; each entry is 46 bytes plus its name, extra field and comment.
function centralEntries(bytes: Uint8Array): Array<{ offset: number; name: string }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries = [];
  for (let index = 0; index < count; index++) {
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ offset, name });
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return entries;
}

function patchEntry(bytes: Uint8Array, entryName: string, field: number, value: number): Uint8Array {
  const entry = centralEntries(bytes).find((candidate) => candidate.name === entryName);
  if (!entry) throw new Error(`no entry ${entryName}`);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(entry.offset + field, value, true);
  return bytes;
}

const CENTRAL = { flags: 8, crc32: 16, compressedSize: 20, uncompressedSize: 24 } as const;

// The size the archive declares an entry decompresses to.
function declaredSize(bytes: Uint8Array, entryName: string): number {
  const entry = centralEntries(bytes).find((candidate) => candidate.name === entryName);
  if (!entry) throw new Error(`no entry ${entryName}`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    entry.offset + CENTRAL.uncompressedSize,
    true,
  );
}

// An entry's name in the central directory, which is where the reader looks
// parts up, changed to another of the same length.
function renameEntry(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const name = new TextEncoder().encode(to);
  const entry = centralEntries(bytes).find((candidate) => candidate.name === from);
  if (!entry || name.length !== new TextEncoder().encode(from).length) throw new Error(`cannot rename ${from}`);
  bytes.set(name, entry.offset + 46);
  return bytes;
}

const LEGEND = [
  "ממלאים את התאים הצהובים — שורה לכל מוצר.",
  "קובץ אחד לכל מגדל; מעלים אותו מהשורה שלו במסך 'בשם מגדל'.",
  "תא ריק משאיר את הכמות כפי שהיא באורי; 0 מאפס.",
  "כמויות במשטחים שלמים. העודף לא משתנה בהעלאה.",
  "הסבר מלא ושורה לדוגמה בגיליון 'הוראות'.",
];

// The legend of the template offered since the code column, in column E.
const CODE_LEGEND = [
  "ממלאים את התאים הצהובים — שורה לכל מוצר.",
  "את הקוד מעתיקים ממסך המוצרים: עמודת 'קוד מוצר', כפתור ההעתקה.",
  "כשיש בשורה קוד, הקוד קובע איזה מוצר זה; בלי קוד — לפי השם.",
  "קובץ אחד לכל מגדל; מעלים אותו מהשורה שלו במסך 'בשם מגדל'.",
  "תא ריק משאיר את הכמות כפי שהיא באורי; 0 מאפס.",
  "כמויות במשטחים שלמים. העודף לא משתנה בהעלאה.",
  "הסבר מלא ושורה לדוגמה בגיליון 'הוראות'.",
];

// Two growers' numbers for the same two products, each filled into a copy of
// the template's ליקוט sheet (rows 2 and 3, beside the legend) in the files
// that hold more than one tab.
const GROWER_A = [
  { rowNumber: 2, cells: ["מלפפון", 11, null, LEGEND[1]] },
  { rowNumber: 3, cells: ["רד-דיימונד גדול", 21, null, LEGEND[2]] },
];
const GROWER_B = [
  { rowNumber: 2, cells: ["מלפפון", 99, null, LEGEND[1]] },
  { rowNumber: 3, cells: ["רד-דיימונד גדול", 98, null, LEGEND[2]] },
];
const filledRows = (sheet: XlsxSheet) => sheet.rows.filter((row) => row.rowNumber === 2 || row.rowNumber === 3);

describe("readXlsxSheet — the picking template", () => {
  // The two-column template, as the screen offered it before the code column.
  it("reads the empty template: the header row and the legend beside it, and no empty rows", async () => {
    const sheet = await readXlsxSheet(fixture("template-empty.xlsx"), TEMPLATE);
    expect(sheet.name).toBe("ליקוט");
    // Rows 6-61 are styled (yellow) but empty, and so are left out.
    expect(sheet.rows).toEqual([
      { rowNumber: 1, cells: ["מוצר", "משטחים שנקטפו", null, LEGEND[0]] },
      { rowNumber: 2, cells: [null, null, null, LEGEND[1]] },
      { rowNumber: 3, cells: [null, null, null, LEGEND[2]] },
      { rowNumber: 4, cells: [null, null, null, LEGEND[3]] },
      { rowNumber: 5, cells: [null, null, null, LEGEND[4]] },
    ]);
  });

  // The very file the screen offers for download, read where it is shipped
  // from. template-empty.xlsx was a byte copy of it until the code column;
  // it is kept as the two-column template, which files filled in before
  // then still are, and they are read as they always were.
  it("reads the template the screen offers for download now: the code first, the legend a column further out", async () => {
    const shipped = readFileSync(new URL("../../public/templates/ori-picking-upload-template.xlsx", import.meta.url));
    const sheet = await readXlsxSheet(shipped, TEMPLATE);
    expect(sheet.name).toBe("ליקוט");
    // Rows 2-61 are styled (yellow) but empty: only the legend's rows are left.
    expect(sheet.rows).toEqual(
      CODE_LEGEND.map((legend, index) => ({
        rowNumber: index + 1,
        cells: index === 0 ? ["קוד מוצר", "מוצר", "משטחים שנקטפו", null, legend] : [null, null, null, null, legend],
      })),
    );
  });

  it("reads a filled-in template: Hebrew text, numbers, numeric text, blank cells, the legend", async () => {
    const sheet = await readXlsxSheet(fixture("filled.xlsx"), TEMPLATE);
    expect(sheet.rows).toEqual([
      { rowNumber: 1, cells: ["מוצר", "משטחים שנקטפו", null, LEGEND[0]] },
      { rowNumber: 2, cells: ["רד-דיימונד גדול", 12, null, LEGEND[1]] },
      { rowNumber: 3, cells: ["עגבניה שרי", 0, null, LEGEND[2]] },
      // A blank quantity is a self-closing cell: null, not 0.
      { rowNumber: 4, cells: ["מלפפון", null, null, LEGEND[3]] },
      // Text is returned as written — trimming is the caller's business.
      { rowNumber: 5, cells: ["  פלפל   אדום ", "7", null, LEGEND[4]] },
      { rowNumber: 6, cells: ["בננה", 2.5] },
      { rowNumber: 7, cells: ["אבטיח", -1] },
      { rowNumber: 8, cells: ["לא קיים", 4] },
      { rowNumber: 9, cells: ["רד-דיימונד גדול", 3] },
      { rowNumber: 10, cells: ["Cherry Tomato", "שבע"] },
      { rowNumber: 11, cells: [null, 5] },
    ]);
  });

  it("accepts an ArrayBuffer as well as bytes", async () => {
    const bytes = copyOf("template-empty.xlsx");
    const sheet = await readXlsxSheet(bytes.buffer as ArrayBuffer, TEMPLATE);
    expect(sheet.rows).toHaveLength(5);
  });
});

describe("readXlsxSheet — what other programs write", () => {
  it("reads Excel's way of storing text: shared strings, rich text, entities and escapes", async () => {
    // The instructions sheet comes first in this file: set aside, it is
    // never the one read, wherever it sits.
    const sheet = await readXlsxSheet(fixture("excel-style.xlsx"), TEMPLATE);
    expect(sheet.name).toBe("ליקוט");
    expect(sheet.rows).toEqual([
      { rowNumber: 1, cells: ["מוצר", "משטחים שנקטפו", null, LEGEND[0]] },
      // Two rich-text runs, one string. C2's empty <v> is no value at all.
      { rowNumber: 2, cells: ["רד-דיימונד גדול", 12] },
      // The phonetic run is not part of the text; a formula gives its cached value.
      { rowNumber: 3, cells: ["עגבניה", 6] },
      { rowNumber: 4, cells: ['תפוח & אגס <1> "ירוק" \'זן\'', true] },
      // Numeric character references (decimal and hex); an error cell's text.
      { rowNumber: 5, cells: ["אבג", "#N/A"] },
      { rowNumber: 6, cells: ["  פלפל  ", 1.5] },
      // An inline rich string; a formula's text result.
      { rowNumber: 7, cells: ["שוק", "7"] },
      // Excel's _x000D_ escape; a number in exponent form.
      { rowNumber: 8, cells: ["שורה\rשנייה", 1000] },
      // Row 9 holds only an empty string and an empty cell, so it is left out.
      // Row 10's cells carry no reference: they take the next column along.
      { rowNumber: 10, cells: ["ללא הפניה", 4] },
      // A row without a number is the one after the previous row.
      { rowNumber: 11, cells: ["שורה בלי מספר"] },
      { rowNumber: 13, cells: ["רחוק", ...Array.from({ length: 24 }, () => null), 99] },
    ]);
  });

  it("reads stored entries, prefixed elements, CDATA, a byte-order mark and '../' targets", async () => {
    const sheet = await readXlsxSheet(fixture("prefixed-stored.xlsx"), TEMPLATE);
    // Its only sheet is called נתונים: the one tab, read whatever its name.
    expect(sheet.name).toBe("נתונים");
    expect(sheet.rows).toEqual([
      { rowNumber: 1, cells: ["מוצר", "משטחים שנקטפו"] },
      { rowNumber: 2, cells: ["תות & <שדה>", 3] },
    ]);
  });

  it("reads the one tab besides the instructions, whatever it is called", async () => {
    const sheet = await readXlsxSheet(fixture("first-sheet-fallback.xlsx"), TEMPLATE);
    expect(sheet.name).toBe("Sheet1");
    expect(sheet.rows.map((row) => row.cells)).toEqual([
      ["מוצר", "משטחים שנקטפו"],
      ["רד-דיימונד גדול", 8],
      ["עגבניה שרי", 1],
    ]);
  });

  it("refuses two tabs that could each be the data, rather than reading the first", async () => {
    // Nothing set aside: the instructions are a tab like any other.
    const failure = await failureOf(readXlsxSheet(fixture("excel-style.xlsx")));
    expect(failure.code).toBe("several_sheets");
    expect(failure.sheetNames).toEqual(["הוראות", "ליקוט"]);
  });

  it("sets a tab aside by its name whatever its case, and without surrounding spaces", async () => {
    expect((await readXlsxSheet(fixture("template-empty.xlsx"), { ignoreSheets: [" הוראות "] })).name).toBe("ליקוט");
    // Sheet1 set aside, the instructions are the one tab left.
    expect((await readXlsxSheet(fixture("first-sheet-fallback.xlsx"), { ignoreSheets: ["SHEET1"] })).name).toBe(
      "הוראות",
    );
  });
});

// The review that found a copy of the picking tab read in place of the one
// meant: grower A's numbers in "ליקוט", grower B's in its copy, and A's
// planned and saved into B's pick, with nothing on the screen to say which
// tab had been read.
describe("readXlsxSheet — which tab is read", () => {
  it("refuses a copy of the picking tab beside it, or a tab per grower, naming the tabs in order", async () => {
    const cases: Array<[string, string[]]> = [
      // Excel's "Move or Copy" puts the copy before the original.
      ["tabs-excel-copy.xlsx", ["ליקוט (2)", "ליקוט"]],
      ["tabs-google-copy.xlsx", ["ליקוט", "עותק של ליקוט"]],
      ["tabs-libreoffice-copy.xlsx", ["ליקוט", "ליקוט_2"]],
      ["tabs-per-grower.xlsx", ["משה", "דוד"]],
    ];
    for (const [name, tabs] of cases) {
      const failure = await failureOf(readXlsxSheet(fixture(name), TEMPLATE));
      expect({ name, code: failure.code, tabs: failure.sheetNames }).toEqual({ name, code: "several_sheets", tabs });
    }
  });

  it("reads the visible copy when the original is hidden: a hidden tab is no candidate", async () => {
    const sheet = await readXlsxSheet(fixture("tabs-hidden-original.xlsx"), TEMPLATE);
    expect(sheet.name).toBe("ליקוט (2)");
    expect(filledRows(sheet)).toEqual(GROWER_B);
  });

  it("never counts a very hidden tab, a hidden one, or a chart sheet", async () => {
    // Saved by openpyxl: ליקוט, its very hidden copy, a hidden list, a chart
    // sheet, and the instructions.
    const sheet = await readXlsxSheet(fixture("tabs-ignored-kinds.xlsx"), TEMPLATE);
    expect(sheet.name).toBe("ליקוט");
    expect(filledRows(sheet)).toEqual(GROWER_A);
  });

  it("never opens a tab it does not read", async () => {
    // The hidden original's part, damaged: never decompressed, never noticed.
    const damaged = patchEntry(copyOf("tabs-hidden-original.xlsx"), "xl/worksheets/sheet1.xml", CENTRAL.crc32, 12345);
    expect((await readXlsxSheet(damaged, TEMPLATE)).name).toBe("ליקוט (2)");
  });

  it("reads the one tab besides the instructions: renamed and moved after them, or on its own", async () => {
    const renamed = await readXlsxSheet(fixture("tabs-renamed-moved.xlsx"), TEMPLATE);
    expect(renamed.name).toBe("נתונים");
    expect(filledRows(renamed)).toEqual(GROWER_A);

    const alone = await readXlsxSheet(fixture("tabs-likut-only.xlsx"), TEMPLATE);
    expect(alone.name).toBe("ליקוט");
    expect(filledRows(alone)).toEqual(GROWER_A);
  });

  it("refuses a workbook whose only visible tab is the instructions", async () => {
    const failure = await failureOf(readXlsxSheet(fixture("tabs-instructions-only.xlsx"), TEMPLATE));
    expect(failure.code).toBe("no_sheets");
    expect(failure.sheetNames).toEqual([]);
  });

  it("refuses a workbook with no worksheet it can find as damaged, not as one hiding its tab", async () => {
    // The workbook still lists ליקוט and הוראות, but without its
    // relationships nothing says which part holds either.
    const bytes = renameEntry(copyOf("template-empty.xlsx"), "xl/_rels/workbook.xml.rels", "xl/_rels/workbook.xml.relz");
    expect(await codeOf(readXlsxSheet(bytes, TEMPLATE))).toBe("corrupt");
  });
});

describe("readXlsxSheet — hidden rows", () => {
  const hiddenRows = (sheet: XlsxSheet) => sheet.rows.filter((row) => row.hidden).map((row) => row.rowNumber);

  it("marks the rows a filter leaves out, and reads them like any other", async () => {
    const sheet = await readXlsxSheet(fixture("hidden-rows-filter.xlsx"), TEMPLATE);
    expect(hiddenRows(sheet)).toEqual([3, 5, 6]);
    expect(sheet.rows.slice(1, 3)).toEqual([
      { rowNumber: 2, cells: ["מלפפון", 11, null, LEGEND[1]] },
      { rowNumber: 3, cells: ["רד-דיימונד גדול", 21, null, LEGEND[2]], hidden: true },
    ]);
  });

  it("marks the rows of a collapsed group, and not the summary row below it", async () => {
    expect(hiddenRows(await readXlsxSheet(fixture("hidden-rows-group.xlsx"), TEMPLATE))).toEqual([3, 4]);
  });

  it('marks rows hidden by hand, written "1" or "true", and not those written "0" or "false"', async () => {
    expect(hiddenRows(await readXlsxSheet(fixture("hidden-rows-manual.xlsx"), TEMPLATE))).toEqual([3, 4, 5, 6, 9]);
  });
});

describe("readXlsxSheet — hidden columns", () => {
  it("names the columns the file hides, and reads their cells like any other", async () => {
    // openpyxl, the template's code column (A) hidden as Excel's Hide writes
    // it: <col hidden="1" min="1" max="1">.
    const sheet = await readXlsxSheet(fixture("code-column-hidden.xlsx"), TEMPLATE);
    expect(sheet.hiddenColumns).toEqual([0]);
    expect(sheet.rows[1]).toEqual({
      rowNumber: 2,
      cells: ["6f1c2b9e-3d4a-4e8b-9a71-0c5d2e8f4b13", "רד-דיימונד גדול", 5, null, CODE_LEGEND[1]],
    });
    // Yesterday's quantities, hidden beside today's.
    expect((await readXlsxSheet(fixture("columns-hidden-repeat.xlsx"), TEMPLATE)).hiddenColumns).toEqual([1]);
  });

  it('tells hidden "1" or "true" from "0" or "false", and a range, as far as columns are read', async () => {
    // A hidden="true" (LibreOffice's spelling); B "false" and C "0", both in
    // view; D:E as one range; and G to the sheet's last column, as hiding
    // "the rest" writes it — as far as the 100 columns read.
    const sheet = await readXlsxSheet(fixture("hidden-columns.xlsx"), TEMPLATE);
    expect(sheet.hiddenColumns).toEqual([0, 3, 4, ...Array.from({ length: 94 }, (_, index) => index + 6)]);
    expect(sheet.rows[0]?.cells.slice(0, 3)).toEqual(["קוד מוצר", "מוצר", "משטחים שנקטפו"]);
    const narrow = await readXlsxSheet(fixture("hidden-columns.xlsx"), { ...TEMPLATE, maxColumns: 4 });
    expect(narrow.hiddenColumns).toEqual([0, 3]);
  });

  it("says nothing of columns in a sheet that hides none", async () => {
    const shipped = readFileSync(new URL("../../public/templates/ori-picking-upload-template.xlsx", import.meta.url));
    const sheets = [
      await readXlsxSheet(shipped, TEMPLATE),
      ...(await Promise.all(
        ["template-empty.xlsx", "filled.xlsx", "excel-style.xlsx", "hidden-rows-filter.xlsx"].map((name) =>
          readXlsxSheet(fixture(name), TEMPLATE),
        ),
      )),
    ];
    expect(sheets.map((sheet) => "hiddenColumns" in sheet)).toEqual([false, false, false, false, false]);
  });
});

describe("readXlsxSheet — numbers shown as dates or times", () => {
  // Each row's quantity (column B) under the header, and its columns read as dates.
  const quantities = (sheet: XlsxSheet) =>
    sheet.rows.slice(1).map((row) => [row.rowNumber, row.cells[1] ?? null, row.dateColumns ?? []]);

  it("tells a date or a time from a number by the cell's built-in format", async () => {
    expect(quantities(await readXlsxSheet(fixture("dates-builtin.xlsx"), TEMPLATE))).toEqual([
      [2, 46054, [1]], // 14: "1/2" typed, so 1 February
      [3, 46178, [1]], // 16, d-mmm: "5-6" typed, so 5 June
      [4, 0.5, [1]], // 20, h:mm
      [5, 7, []], // the template's own style: General
      [6, 3, []], // 1, "0"
      [7, 46054.5, [1]], // 22, a date and a time
      [8, 46054, [1]], // 27, an East Asian edition's date
      [9, 1.25, [1]], // 46, [h]:mm:ss
      [10, 0.01, [1]], // 47, mmss.0
      [11, 1200, []], // 3, #,##0
      [12, 1000, []], // 11, 0.00E+00
      [13, 4, []], // 49, text
      // Date-styled but blank: no number, so no date.
      [14, null, []],
    ]);
  });

  it("tells them apart by a custom format's code", async () => {
    expect(quantities(await readXlsxSheet(fixture("dates-custom.xlsx"), TEMPLATE))).toEqual([
      [2, 46054, [1]], // d/m
      [3, 46178, [1]], // DD/MM/YY
      [4, 46054, [1]], // [$-40D]dd/mm/yyyy
      [5, 1.5, [1]], // [h]:mm
      [6, 12, []], // 0" משטחים"
      [7, 3, []], // #,##0 "ק\"ג"
      [8, 4, []], // [$₪-40D] #,##0
      [9, 5, []], // [Red]0
      [10, 6, []], // General
      [11, 7, []], // 0\d
      [12, 8, []], // "יום "0
      [13, 0.75, [1]], // h:mm AM/PM
    ]);
  });

  it("finds the styles part by its relationship, in Strict OOXML with prefixed elements", async () => {
    // xl/styles.xml, where the styles usually are, has no date format here:
    // the workbook's relationship points to xl/look/cell-formats.xml instead.
    const sheet = await readXlsxSheet(fixture("dates-strict-prefixed.xlsx"));
    expect(quantities(sheet)).toEqual([
      [2, 46054, [1]], // its custom d/m/yyyy
      [3, 0.5, [1]], // 20, h:mm
      // 165 is a conditional format's (a dxf's), no cell style's.
      [4, 5, []],
      // No `s`: style 0, General — not cellStyleXfs' first, which is a date.
      [5, 6, []],
      [6, 7, [1]],
    ]);
    expect(sheet.rows.at(-1)?.hidden).toBe(true);
  });

  it("calls nothing a date when the styles part is missing, not XML, or has no such style", async () => {
    const dates = (sheet: XlsxSheet) => sheet.rows.flatMap((row) => row.dateColumns ?? []);
    expect(dates(await readXlsxSheet(fixture("dates-no-styles.xlsx")))).toEqual([]);
    expect(dates(await readXlsxSheet(fixture("dates-styles-malformed.xlsx")))).toEqual([]);
    // Two styles, the second a date: only s="1" is one. 2 and 99 are past
    // the end, and -1, x, "" and 1e0 are not style numbers at all.
    expect(quantities(await readXlsxSheet(fixture("dates-style-out-of-range.xlsx")))).toEqual([
      [2, 46054, [1]],
      [3, 46054, []],
      [4, 46054, []],
      [5, 46054, []],
      [6, 46054, []],
      [7, 46054, []],
      [8, 46054, []],
    ]);
  });

  it("still reads a file whose styles part is damaged, without telling its dates", async () => {
    const damaged = patchEntry(copyOf("dates-builtin.xlsx"), "xl/styles.xml", CENTRAL.crc32, 12345);
    const sheet = await readXlsxSheet(damaged, TEMPLATE);
    expect(sheet.rows.flatMap((row) => row.dateColumns ?? [])).toEqual([]);
    expect(sheet.rows[1]).toEqual({ rowNumber: 2, cells: ["מלפפון", 46054, null, LEGEND[1]] });
  });
});

describe("isDateFormatCode", () => {
  it("calls a code with a day, month, year, hour or second in it a date or a time", () => {
    const dates = [
      "dd/mm/yyyy",
      "d/m",
      "DD/MM/YY",
      "d-mmm",
      "mmm-yy",
      "yyyy",
      "dddd",
      "h:mm",
      "hh:mm:ss",
      "mm:ss.0",
      "h:mm AM/PM",
      "h:mm a/p",
      "AM/PM",
      "A/P",
      // Elapsed time: the one bracket that is a time.
      "[h]:mm:ss",
      "[mm]:ss",
      "[h]",
      "[hh]",
      "[m]",
      "[MM]",
      "[s]",
      "[ss]",
      // Beside text, a locale or a color, what is outside them is a date.
      "[$-40D]dd/mm/yyyy",
      "[$-x-sysdate]dddd, mmmm dd, yyyy",
      '"נקטף ב-"dd/mm',
      "[Red]d/m",
      "dd\\/mm",
    ];
    for (const code of dates) expect([code, isDateFormatCode(code)]).toEqual([code, true]);
  });

  it("calls a number a number, whatever text, color, currency or condition it carries", () => {
    const numbers = [
      "General",
      "general",
      "GENERAL",
      "0",
      "0.00",
      "#,##0",
      "#,##0.00",
      "0%",
      "# ?/?",
      // Scientific notation's E is no date.
      "0.00E+00",
      "##0.0E-0",
      "0.00e+00",
      "0.0e-0",
      "@",
      "[Red]0",
      "[Blue]#,##0",
      "[$₪-40D] #,##0",
      '0" משטחים"',
      '#,##0 "ק\\"ג"',
      '"יום "0',
      '"dd/mm/yyyy"0',
      // Escaped, a letter is shown as itself.
      "0\\d",
      "\\h\\h0",
      "[>=100][Red]0;0",
      '[=1]"משטח";0" משטחים"',
      '_-* #,##0_-;-* #,##0_-;_-* "-"_-;_-@_-',
      // A quote or a bracket never closed: the rest is text.
      '0"d',
      "0[h",
      "",
    ];
    for (const code of numbers) expect([code, isDateFormatCode(code)]).toEqual([code, false]);
  });
});

describe("isDateNumberFormat", () => {
  it("calls the built-in date and time formats dates by their id alone, and no other built-in one", () => {
    const dates = [
      ...[14, 15, 16, 17, 18, 19, 20, 21, 22],
      ...[27, 28, 29, 30, 31, 32, 33, 34, 35, 36],
      ...[45, 46, 47],
      ...[50, 51, 52, 53, 54, 55, 56, 57, 58],
    ];
    for (let id = 0; id < 164; id++) expect([id, isDateNumberFormat(id)]).toEqual([id, dates.includes(id)]);
  });

  it("judges a custom format by its code, and one the file never wrote out as no date", () => {
    expect(isDateNumberFormat(164, "dd/mm/yyyy")).toBe(true);
    expect(isDateNumberFormat(164, '0" משטחים"')).toBe(false);
    expect(isDateNumberFormat(164)).toBe(false);
    // A built-in date stays one, whatever code a file writes beside its id.
    expect(isDateNumberFormat(14, "0")).toBe(true);
  });
});

describe("readXlsxSheet — files it refuses", () => {
  it("refuses a file that is not a ZIP: a CSV with an .xlsx name, an empty file", async () => {
    expect(await codeOf(readXlsxSheet(fixture("not-a-zip.xlsx")))).toBe("not_zip");
    expect(await codeOf(readXlsxSheet(new Uint8Array(0)))).toBe("not_zip");
  });

  it("refuses an old .xls or a password-protected workbook, which are not ZIPs either", async () => {
    const compoundFile = new Uint8Array(512);
    compoundFile.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(await codeOf(readXlsxSheet(compoundFile))).toBe("legacy_or_encrypted");
  });

  it("refuses encrypted entries", async () => {
    const bytes = copyOf("template-empty.xlsx");
    const view = new DataView(bytes.buffer);
    const entry = centralEntries(bytes)[0]!;
    view.setUint16(entry.offset + CENTRAL.flags, view.getUint16(entry.offset + CENTRAL.flags, true) | 1, true);
    expect(await codeOf(readXlsxSheet(bytes))).toBe("encrypted");
  });

  it("refuses ZIP64 archives", async () => {
    const bytes = copyOf("template-empty.xlsx");
    const end = bytes.length - 22;
    new DataView(bytes.buffer).setUint16(end + 10, 0xffff, true);
    expect(await codeOf(readXlsxSheet(bytes))).toBe("zip64");

    const entrySizes = patchEntry(copyOf("template-empty.xlsx"), "xl/workbook.xml", CENTRAL.uncompressedSize, 0xffffffff);
    expect(await codeOf(readXlsxSheet(entrySizes))).toBe("zip64");
  });

  it("refuses a damaged file: an entry past the end, a wrong checksum, a cut-off file", async () => {
    const pastTheEnd = patchEntry(copyOf("template-empty.xlsx"), "xl/worksheets/sheet1.xml", CENTRAL.compressedSize, 10_000_000);
    expect(await codeOf(readXlsxSheet(pastTheEnd, TEMPLATE))).toBe("corrupt");

    const badChecksum = patchEntry(copyOf("template-empty.xlsx"), "xl/worksheets/sheet1.xml", CENTRAL.crc32, 12345);
    expect((await failureOf(readXlsxSheet(badChecksum, TEMPLATE))).message).toMatch(/checksum/);

    // Deflate data that is not deflate data.
    const garbled = copyOf("template-empty.xlsx");
    const view = new DataView(garbled.buffer);
    const sheetEntry = centralEntries(garbled).find((entry) => entry.name === "xl/worksheets/sheet1.xml")!;
    const header = view.getUint32(sheetEntry.offset + 42, true);
    const data = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
    for (let index = data + 10; index < data + 60; index++) garbled[index]! ^= 0xff;
    expect((await failureOf(readXlsxSheet(garbled, TEMPLATE))).message).toMatch(/could not be decompressed/);

    // Cut off before its end record, the file no longer reads as a ZIP at all.
    expect(await codeOf(readXlsxSheet(copyOf("template-empty.xlsx").slice(0, 4000)))).toBe("not_zip");
  });

  it("refuses a zip bomb before decompressing it: a 25 MB part in a 26 KB file", async () => {
    expect(fixture("bomb.xlsx").length).toBeLessThan(30_000);
    expect(await codeOf(readXlsxSheet(fixture("bomb.xlsx")))).toBe("too_large");
  });

  it("reads a part decompressed over several slices whole, when the budget allows it", async () => {
    // The same bomb, honest about its 25 MB, read with room for it: its 25 KB
    // of deflate goes in as two slices and comes out as many chunks.
    const sheet = await readXlsxSheet(fixture("bomb.xlsx"), { maxUncompressedBytes: 30 * 1024 * 1024 });
    expect(sheet.rows).toEqual([{ rowNumber: 1, cells: ["מוצר"] }]);
  });

  it("stops decompressing a part the moment it grows past the size the archive declared", async () => {
    // The same bomb, now claiming its sheet holds 1,000 bytes: the claim
    // passes the size check, and decompression is what has to catch it.
    const lying = patchEntry(copyOf("bomb.xlsx"), "xl/worksheets/sheet1.xml", CENTRAL.uncompressedSize, 1000);
    const failure = await failureOf(readXlsxSheet(lying));
    expect(failure.code).toBe("corrupt");
    expect(failure.message).toMatch(/larger than the archive says/);
  });

  it("refuses a styles part that decompresses past the cap, before decompressing it, like any part", async () => {
    // 25 MB of styles in a 27 KB file.
    expect(fixture("styles-bomb.xlsx").length).toBeLessThan(30_000);
    expect(await codeOf(readXlsxSheet(fixture("styles-bomb.xlsx")))).toBe("too_large");
  });

  it("gives up on a styles part that grows past its declared size, and reads the sheet without it", async () => {
    // The same bomb, now claiming its styles hold 1,000 bytes: caught after
    // one slice, the damage costs the file only its dates.
    const lying = patchEntry(copyOf("styles-bomb.xlsx"), "xl/styles.xml", CENTRAL.uncompressedSize, 1000);
    expect((await readXlsxSheet(lying)).rows).toEqual([
      { rowNumber: 1, cells: ["מוצר", "משטחים שנקטפו"] },
      { rowNumber: 2, cells: ["מלפפון", 46054] },
    ]);
  });

  it("counts a damaged styles part against the budget, though the read goes on without it", async () => {
    // The parts this read opens, at the sizes the archive declares for them.
    const bytes = fixture("dates-builtin.xlsx");
    const opened = ["_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"];
    const exact = opened.reduce((sum, name) => sum + declaredSize(bytes, name), 0);
    const hasDates = (sheet: XlsxSheet) => sheet.rows.some((row) => row.dateColumns !== undefined);
    // Room for exactly those parts is enough, and a byte less is not.
    expect(hasDates(await readXlsxSheet(bytes, { ...TEMPLATE, maxUncompressedBytes: exact }))).toBe(true);
    expect(await codeOf(readXlsxSheet(bytes, { ...TEMPLATE, maxUncompressedBytes: exact - 1 }))).toBe("too_large");

    // The styles part's checksum wrong: decompressed whole before that shows,
    // it has spent its share of the budget all the same...
    const damaged = patchEntry(copyOf("dates-builtin.xlsx"), "xl/styles.xml", CENTRAL.crc32, 12345);
    expect(await codeOf(readXlsxSheet(damaged, { ...TEMPLATE, maxUncompressedBytes: exact - 1 }))).toBe("too_large");
    // ...and given the room, the sheet is read without its dates.
    expect(hasDates(await readXlsxSheet(damaged, { ...TEMPLATE, maxUncompressedBytes: exact }))).toBe(false);
  });

  it("caps the total it decompresses, the entries, the rows and the columns", async () => {
    expect(
      await codeOf(readXlsxSheet(fixture("template-empty.xlsx"), { ...TEMPLATE, maxUncompressedBytes: 4000 })),
    ).toBe("too_large");
    expect(await codeOf(readXlsxSheet(fixture("template-empty.xlsx"), { maxEntries: 3 }))).toBe("too_large");
    expect(await codeOf(readXlsxSheet(fixture("filled.xlsx"), { ...TEMPLATE, maxRows: 5 }))).toBe("too_large");
    const narrow = await readXlsxSheet(fixture("excel-style.xlsx"), { ...TEMPLATE, maxColumns: 2 });
    expect(narrow.rows.at(-1)).toEqual({ rowNumber: 13, cells: ["רחוק"] });
    expect(narrow.rows[0]).toEqual({ rowNumber: 1, cells: ["מוצר", "משטחים שנקטפו"] });
  });
});

// Files of a few kilobytes, well inside every cap, built so that a lookup
// which runs on to the end of the text — once for every one of 400,000
// repeats — turns them into many seconds of a frozen tab (6.7 s and 10.7 s,
// before the tokenizer bounded its lookups; tens of milliseconds after). The
// time limit is far from both.
describe("readXlsxSheet — files built to be slow", () => {
  async function timed(name: string) {
    const started = performance.now();
    const sheet = await readXlsxSheet(fixture(name));
    return { sheet, milliseconds: performance.now() - started };
  }

  it("reads 400,000 bare ampersands in one pass: in text, in an attribute, and before a far ';'", async () => {
    const { sheet, milliseconds } = await timed("ampersands.xlsx");
    expect(milliseconds).toBeLessThan(2000);
    // None of them is an entity, so the text keeps every one as written.
    expect(sheet.rows).toEqual([
      { rowNumber: 1, cells: ["מוצר", "משטחים שנקטפו"] },
      { rowNumber: 2, cells: ["&".repeat(400_000)] },
      { rowNumber: 3, cells: [`${"&".repeat(400_000)};`, 1] },
    ]);
  });

  it("skips 400,000 '<!x>' declarations in one pass, and still reads the row after them", async () => {
    const { sheet, milliseconds } = await timed("declarations.xlsx");
    expect(milliseconds).toBeLessThan(2000);
    expect(sheet.rows).toEqual([
      { rowNumber: 1, cells: ["מוצר", "משטחים שנקטפו"] },
      { rowNumber: 2, cells: ["מלפפון", 4] },
    ]);
  });

  it("judges 100,000 cell styles that share a 400,000-character format code once, in one pass", async () => {
    // The shared code is 400,000 digits, walked a character at a time; the
    // others open a bracket a million times and never close one, or are
    // 400,000 backslashes, or quotes. Judged once per style, the digits
    // alone are 4 * 10^10 steps (96 seconds, tried); with a search for "]"
    // from every "[", the brackets are 5 * 10^11 characters searched.
    const { sheet, milliseconds } = await timed("styles-slow.xlsx");
    expect(milliseconds).toBeLessThan(2000);
    // None of them is a date; the plain date style after them still is.
    expect(sheet.rows.map((row) => [row.rowNumber, row.dateColumns ?? []])).toEqual([
      [1, []],
      [2, []],
      [3, []],
      [4, []],
      [5, []],
      [6, [1]],
    ]);
  });
});

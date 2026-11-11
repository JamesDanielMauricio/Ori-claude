import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readXlsxSheet, XlsxError, type XlsxErrorCode } from "./xlsx-reader";

// Real files, not hand-built byte arrays: the shipped template itself, the
// template filled in by openpyxl, and parts written the way Excel and other
// generators write them (shared strings, rich text, prefixes, stored entries).
// They are built by a script kept outside the repo; what each one holds is
// spelled out in the test that reads it.
function fixture(name: string): Uint8Array {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
}

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

const LEGEND = [
  "ממלאים את התאים הצהובים — שורה לכל מוצר.",
  "קובץ אחד לכל מגדל; מעלים אותו מהשורה שלו במסך 'בשם מגדל'.",
  "תא ריק משאיר את הכמות כפי שהיא באורי; 0 מאפס.",
  "כמויות במשטחים שלמים. העודף לא משתנה בהעלאה.",
  "הסבר מלא ושורה לדוגמה בגיליון 'הוראות'.",
];

describe("readXlsxSheet — the picking template", () => {
  it("reads the empty template: the header row and the legend beside it, and no empty rows", async () => {
    const sheet = await readXlsxSheet(fixture("template-empty.xlsx"), { sheetName: "ליקוט" });
    expect(sheet.name).toBe("ליקוט");
    expect(sheet.isFallback).toBe(false);
    // Rows 6-61 are styled (yellow) but empty, and so are left out.
    expect(sheet.rows).toEqual([
      { rowNumber: 1, cells: ["מוצר", "משטחים שנקטפו", null, LEGEND[0]] },
      { rowNumber: 2, cells: [null, null, null, LEGEND[1]] },
      { rowNumber: 3, cells: [null, null, null, LEGEND[2]] },
      { rowNumber: 4, cells: [null, null, null, LEGEND[3]] },
      { rowNumber: 5, cells: [null, null, null, LEGEND[4]] },
    ]);
  });

  it("is reading the very file the screen offers for download", () => {
    const shipped = readFileSync(new URL("../../public/templates/ori-picking-upload-template.xlsx", import.meta.url));
    expect(Buffer.compare(Buffer.from(fixture("template-empty.xlsx")), shipped)).toBe(0);
  });

  it("reads a filled-in template: Hebrew text, numbers, numeric text, blank cells, the legend", async () => {
    const sheet = await readXlsxSheet(fixture("filled.xlsx"), { sheetName: "ליקוט" });
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
    const sheet = await readXlsxSheet(bytes.buffer as ArrayBuffer, { sheetName: "ליקוט" });
    expect(sheet.rows).toHaveLength(5);
  });
});

describe("readXlsxSheet — what other programs write", () => {
  it("reads Excel's way of storing text: shared strings, rich text, entities and escapes", async () => {
    // The instructions sheet comes first in this file, so only finding the
    // sheet by its name gets the right one.
    const sheet = await readXlsxSheet(fixture("excel-style.xlsx"), { sheetName: "ליקוט" });
    expect(sheet.name).toBe("ליקוט");
    expect(sheet.isFallback).toBe(false);
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
    const sheet = await readXlsxSheet(fixture("prefixed-stored.xlsx"), { sheetName: "ליקוט" });
    // Its only sheet is called נתונים, so it is read in place of ליקוט.
    expect(sheet.name).toBe("נתונים");
    expect(sheet.isFallback).toBe(true);
    expect(sheet.rows).toEqual([
      { rowNumber: 1, cells: ["מוצר", "משטחים שנקטפו"] },
      { rowNumber: 2, cells: ["תות & <שדה>", 3] },
    ]);
  });

  it("falls back to the first sheet when no sheet has the name asked for", async () => {
    const sheet = await readXlsxSheet(fixture("first-sheet-fallback.xlsx"), { sheetName: "ליקוט" });
    expect(sheet.name).toBe("Sheet1");
    expect(sheet.isFallback).toBe(true);
    expect(sheet.rows.map((row) => row.cells)).toEqual([
      ["מוצר", "משטחים שנקטפו"],
      ["רד-דיימונד גדול", 8],
      ["עגבניה שרי", 1],
    ]);
  });

  it("reads the first sheet when no name is asked for, and that is not a fallback", async () => {
    const sheet = await readXlsxSheet(fixture("excel-style.xlsx"));
    expect(sheet.name).toBe("הוראות");
    expect(sheet.isFallback).toBe(false);
  });

  it("matches the sheet name without regard to surrounding spaces", async () => {
    const sheet = await readXlsxSheet(fixture("template-empty.xlsx"), { sheetName: " ליקוט " });
    expect(sheet.isFallback).toBe(false);
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
    expect(await codeOf(readXlsxSheet(pastTheEnd))).toBe("corrupt");

    const badChecksum = patchEntry(copyOf("template-empty.xlsx"), "xl/worksheets/sheet1.xml", CENTRAL.crc32, 12345);
    expect((await failureOf(readXlsxSheet(badChecksum))).message).toMatch(/checksum/);

    // Deflate data that is not deflate data.
    const garbled = copyOf("template-empty.xlsx");
    const view = new DataView(garbled.buffer);
    const sheetEntry = centralEntries(garbled).find((entry) => entry.name === "xl/worksheets/sheet1.xml")!;
    const header = view.getUint32(sheetEntry.offset + 42, true);
    const data = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
    for (let index = data + 10; index < data + 60; index++) garbled[index]! ^= 0xff;
    expect((await failureOf(readXlsxSheet(garbled))).message).toMatch(/could not be decompressed/);

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

  it("caps the total it decompresses, the entries, the rows and the columns", async () => {
    expect(await codeOf(readXlsxSheet(fixture("template-empty.xlsx"), { maxUncompressedBytes: 4000 }))).toBe(
      "too_large",
    );
    expect(await codeOf(readXlsxSheet(fixture("template-empty.xlsx"), { maxEntries: 3 }))).toBe("too_large");
    expect(await codeOf(readXlsxSheet(fixture("filled.xlsx"), { sheetName: "ליקוט", maxRows: 5 }))).toBe(
      "too_large",
    );
    const narrow = await readXlsxSheet(fixture("excel-style.xlsx"), { sheetName: "ליקוט", maxColumns: 2 });
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
    const sheet = await readXlsxSheet(fixture(name), { sheetName: "ליקוט" });
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
});

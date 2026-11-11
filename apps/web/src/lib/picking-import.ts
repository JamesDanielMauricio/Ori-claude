import type { PickLineInput } from "@ori/domain/grower";
import { roundPallets } from "@ori/shared/pallets";

import type { PickProductLineRow } from "@/lib/queries/grower";
import { formatVarietyName } from "@/lib/variety-label";
import { XlsxError, type XlsxCellValue, type XlsxSheet } from "@/lib/xlsx-reader";

// The rules of the "בשם מגדל" picking upload (workbook Task 38), kept apart
// from its dialog (components/arrangement/pick-upload-dialog.tsx) so they can
// be tested on their own: how a filled-in template is read, how each of its
// rows is matched to one of the grower's pick lines, what stops the upload,
// and exactly what save_pick_lines is sent in the end.
//
// The template (public/templates/ori-picking-upload-template.xlsx) states the
// same rules in its "הוראות" sheet, in words a grower reads — a change here
// belongs there too, and the reverse:
//   - "קוד מוצר" names a product by its code: the variety's own id
//     (product_varieties.id), which the products screen shows in its "קוד
//     מוצר" column, with a button that copies it. The id is the code, rather
//     than a new field, by the product owner's decision: it is unique already,
//     the Bubble importer keeps it across its re-imports, and every pick line
//     carries it. The column is optional — a file without it (the template
//     before it, and every file filled in from that one) reads exactly as it
//     did — and so is each of its cells.
//   - When a row has a code, the code decides which product it is. A name can
//     be typed in many ways, be the grower's own name for a product, or be
//     shared by two of the pick's lines; a code is one product. The name is
//     then only a check: a name that is a DIFFERENT line of the pick stops
//     the upload, as one of the two is wrong and only the person knows which.
//     A code that is not one, or names no line of this grower's pick, is
//     listed and skipped — never read by the name beside it instead, which
//     would be the upload choosing between two things the row says.
//   - "מוצר" names a product the way Ori shows it: formatVarietyName(name,
//     sizes), e.g. "רד-דיימונד גדול". It decides only in a row without a code.
//   - "משטחים שנקטפו" is whole pallets, 0 or more — picks stay whole until the
//     client decides otherwise (decision D18), as the pick editor's own box
//     does (lib/integer-input.ts). A blank cell leaves the line as it is; 0
//     sets it to zero.
//   - A product the file leaves out is left as it is: it is not sent at all.
//   - A product that is not one of this grower's pick lines for the day, by
//     its code or by its name, is listed in the preview and skipped. It does
//     not stop the rest.
//   - Leftovers (עודף) and comments are never changed: every line sent carries
//     its own current leftover and comment back unchanged.
//   - Nothing is saved before the preview is confirmed.
// One file per grower, so there is no grower column: the upload runs from the
// grower's own row, and that row decides whose pick it is.
//
// Four more rules are about what a spreadsheet program can do to the file,
// not what a grower fills in, and the template does not state them; the
// preview explains each one where it applies:
//   - The tab read is the file's one visible sheet besides "הוראות", whatever
//     its name, and the preview names it. A file with more than one is
//     refused, naming them: a copy of the tab ("ליקוט (2)") or a tab per
//     grower is another grower's numbers waiting to be saved into this pick.
//   - A row hidden in the file (by a filter, a collapsed group, or by hand) is
//     not imported: nobody checked a row they could not see, and one can
//     still hold yesterday's numbers. One that would have imported something
//     is listed as skipped. Listed or not, the product it names — by its code
//     when it has one — still counts toward the warning that the file may be
//     another grower's.
//   - A "קוד מוצר" column hidden in the file is refused, naming it, when a
//     row in view holds anything in it. The code decides over the name
//     beside it, so a hidden one would save a row into a product nobody
//     looking at the sheet saw named — and 36-character codes are just what
//     someone tidying the sheet hides. Reading past it instead would drop
//     the codes the person filled in, without a word. A hidden column that
//     holds nothing in the rows in view hides nothing: it is read as if it
//     were in view, so a code in a hidden row still counts toward the
//     warning, as it would. A hidden "מוצר" or "משטחים שנקטפו" column is
//     still read, as it was before there were codes: neither overrules a
//     column in view.
//   - A quantity the file shows as a date or a time is refused: what is
//     stored is the date's day count (46054), not pallets.

export const PICK_UPLOAD_SHEET = "ליקוט";
// The template's instructions: never the tab that is read (lib/xlsx-reader.ts).
export const PICK_UPLOAD_INSTRUCTIONS_SHEET = "הוראות";
// In the template's order — column A, on the sheet's right, is the code.
export const PICK_UPLOAD_HEADERS = { code: "קוד מוצר", product: "מוצר", picked: "משטחים שנקטפו" } as const;
export const PICK_UPLOAD_TEMPLATE_URL = "/templates/ori-picking-upload-template.xlsx";
// A filled-in template is a few kilobytes; 2 MB leaves room for one with
// pictures pasted into it and still refuses a wrong file before it is read.
export const PICK_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

// How far down the header row is looked for: the template has it on row 1,
// and a few rows of notes above it should not make the file unreadable.
const HEADER_SEARCH_ROWS = 10;

// daily_pick_products.pallets_picked is numeric(10, 2): anything from 10^8 up
// would be refused by the database as an overflow, so it is refused here, in
// words, first.
const MAX_PALLETS = 99_999_999;

// --------------------------------------------------------------- matching

// Text the file and Ori agree on only up to how it was typed. Hebrew is often
// typed with a geresh (׳) where Ori has an apostrophe, pasted with direction
// marks around it, or written with a maqaf (־) or an en dash for a hyphen.
// None of that makes it a different product, so both the file's text and
// Ori's labels go through this before they are compared.
const INVISIBLE = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const SINGLE_QUOTES = /[`\u00B4\u05F3\u2018\u2019\u201A\u201B\u2032]/g;
const DOUBLE_QUOTES = /[\u05F4\u201C\u201D\u201E\u201F\u2033]/g;
const DASHES = /[\u05BE\u2010-\u2015\u2212]/g;

export function normalizeLabel(text: string): string {
  return (
    text
      .normalize("NFC")
      .replace(INVISIBLE, "")
      .replace(SINGLE_QUOTES, "'")
      .replace(DOUBLE_QUOTES, '"')
      // Gershayim typed as two apostrophes (or two gereshes).
      .replaceAll("''", '"')
      .replace(DASHES, "-")
      .replace(/\s+/g, " ")
      .trim()
      // Latin names ("Cherry") in whatever case; Hebrew has none.
      .toLowerCase()
  );
}

// The file's own text, for showing back to the person who wrote it.
function displayText(text: string): string {
  return text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

// A value from the file inside a Hebrew sentence. First-strong isolation, so
// "-3" is not shown as "3-" and an English name keeps its own direction.
function isolate(text: string): string {
  return `\u2068${text}\u2069`;
}

// Left-to-right isolation, for ".xlsx" — whose leading dot would otherwise
// jump to the far side of the word in a right-to-left line.
const XLSX = "\u2066.xlsx\u2069";

// ---------------------------------------------------------------- codes

// A product's code is its variety's id, which Ori writes in one form: 36
// characters, lower case, in five hyphenated groups — and the products
// screen's copy button copies exactly that. On its way into a cell a code
// can still pick up what is not part of it: spaces, and the direction marks
// a copy from a right-to-left page carries; capitals, retyped or from
// another program; the braces ({…}) or the missing hyphens other tools write
// an id with. None of that makes it another product, so all of it reads as
// the one form. Anything else in the cell is not a code. A number or TRUE
// in it is not one either: no code reads as one, so it is another column's
// value, or a cell Excel turned into something else.
const CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_WITHOUT_HYPHENS = /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/;

/** A "קוד מוצר" cell as the variety id it names (lower case, hyphenated), or null when it holds no code. */
export function normalizeProductCode(cell: XlsxCellValue): string | null {
  if (typeof cell !== "string") return null;
  const text = cell.replace(INVISIBLE, "").trim().toLowerCase();
  // Braces only around the hyphenated form, the way ids are written in them.
  const code =
    text.startsWith("{") && text.endsWith("}")
      ? text.slice(1, -1)
      : text.replace(CODE_WITHOUT_HYPHENS, "$1-$2-$3-$4-$5");
  return CODE.test(code) ? code : null;
}

// ------------------------------------------------------------- the file

export interface PickFileRow {
  /** The row's number in the spreadsheet, as Excel shows it — what every message cites. */
  rowNumber: number;
  /** The product as the file writes it: trimmed, inner spaces collapsed, cut to MAX_CELL_TEXT. "" when blank, or when the file has no "מוצר" column. */
  product: string;
  /** The "משטחים שנקטפו" cell, as read — text cut to MAX_CELL_TEXT. */
  quantity: XlsxCellValue;
  /**
   * The "קוד מוצר" cell, as read — text cut to MAX_CELL_TEXT, null when
   * empty. Present only when the file has that column; a file without it is
   * matched by name alone, as it always was. Whether it holds a code is the
   * plan's to decide (normalizeProductCode).
   */
  code?: XlsxCellValue;
  /**
   * Present, and true, when the file hides the row: it is never imported.
   * Only rows that name a product or have a code are kept then — listed as
   * not imported when they hold a quantity too, and otherwise only counted,
   * as their product still says whose file this is (mostlyNotInPick).
   */
  hidden?: true;
  /** Present, and true, when the quantity is a number the file shows as a date or a time. */
  quantityIsDate?: true;
}

// The most of one cell's text the upload looks at. A label is a name and a
// size, and a quantity a few digits, so nothing real comes near it. It is
// here because one text can fill any number of cells: a workbook stores each
// distinct text once (xl/sharedStrings.xml) and every cell holding it points
// to that one copy, so the reader's 20 MB cap counts a megabyte-long text
// once — while trimming, matching, keeping and showing it would cost its
// whole length again for every row, enough to run the tab out of memory from
// a file of a few kilobytes. Longer text is cut to this, ending in "…",
// before anything else is done with it: it then names no product in the
// pick, and is not a number.
const MAX_CELL_TEXT = 200;

function cutText(text: string): string {
  return text.length > MAX_CELL_TEXT ? `${text.slice(0, MAX_CELL_TEXT)}…` : text;
}

function cut(cell: XlsxCellValue): XlsxCellValue {
  return typeof cell === "string" ? cutText(cell) : cell;
}

/** A tab's name from the file, for showing back: cut, its spaces collapsed, invisible marks dropped. */
export function sheetLabel(name: string): string {
  return displayText(cutText(name));
}

function isBlank(cell: XlsxCellValue): boolean {
  return cell === null || (typeof cell === "string" && displayText(cell) === "");
}

/** A file refused for how its picking tab is laid out. The message is for the person uploading it. */
export class PickFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PickFileError";
  }
}

// A column as Excel letters it: 0 is A, 25 is Z, 26 is AA.
function columnName(column: number): string {
  let name = "";
  for (let rest = column + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(0x41 + ((rest - 1) % 26)) + name;
  }
  return name;
}

function repeatedHeaderMessage(title: string, columns: readonly number[]): string {
  return `בשורת הכותרות יש יותר מעמודה אחת בשם "${title}" (עמודות ${isolate(columns.map(columnName).join(", "))}), ואי אפשר לדעת מאיזו מהן לקרוא. השאירו עמודה אחת בשם הזה ונסו שוב. אם אחת העמודות מוסתרת, הציגו אותה ב-Excel.`;
}

// Said with the reason, as hiding a column is no mistake in itself: the code
// decides which product a row is, and what decides must be in view.
function hiddenCodeColumnMessage(column: number): string {
  return `העמודה "${PICK_UPLOAD_HEADERS.code}" (עמודה ${isolate(columnName(column))}) מוסתרת בקובץ, ואי אפשר לבדוק מה כתוב בה — וכשיש בשורה קוד, הקוד קובע איזה מוצר זה. הציגו את העמודה ב-Excel ונסו שוב.`;
}

// The rows under the template's header, by the header's own columns rather
// than by fixed letters — so a sheet with the columns moved, or a column
// added, still reads. The legend beside the table (column E; D in the
// template before the code column) is never looked at. The header is the
// first of the first few rows to hold "משטחים שנקטפו" and something that
// says which product: "מוצר", "קוד מוצר", or both — looked for in hidden
// rows too, as before. Null when none does. A header row that gives any of
// the three titles to more than one column throws a PickFileError naming
// the columns, and so does a code column the file hides, once a row in view
// is known to hold anything in it. Rows with no product, no code and no
// quantity are left out, and so are hidden rows with neither a product nor
// a code: never imported, a hidden row is kept only for the product it
// names, which still says whose file this is.
export function readPickFileRows(sheet: XlsxSheet): PickFileRow[] | null {
  const codeHeader = normalizeLabel(PICK_UPLOAD_HEADERS.code);
  const productHeader = normalizeLabel(PICK_UPLOAD_HEADERS.product);
  const pickedHeader = normalizeLabel(PICK_UPLOAD_HEADERS.picked);
  for (const header of sheet.rows.slice(0, HEADER_SEARCH_ROWS)) {
    // A cell too long to be any title is not even normalized: up to a
    // hundred of them in each of the rows looked through could be that one
    // huge text (MAX_CELL_TEXT).
    const titles = header.cells.map((cell) =>
      typeof cell === "string" && cell.length <= MAX_CELL_TEXT ? normalizeLabel(cell) : null,
    );
    const codeColumn = titles.indexOf(codeHeader);
    const productColumn = titles.indexOf(productHeader);
    const pickedColumn = titles.indexOf(pickedHeader);
    if (pickedColumn === -1 || (productColumn === -1 && codeColumn === -1)) continue;
    // A title over more than one column is refused, never read from the
    // first: that is how a hidden column of yesterday's numbers, kept beside
    // today's under the same title, would be saved as today's. Which column
    // is meant is the person's to say.
    for (const [title, normalized] of [
      [PICK_UPLOAD_HEADERS.code, codeHeader],
      [PICK_UPLOAD_HEADERS.product, productHeader],
      [PICK_UPLOAD_HEADERS.picked, pickedHeader],
    ] as const) {
      const columns = titles.flatMap((cell, column) => (cell === normalized ? [column] : []));
      if (columns.length > 1) throw new PickFileError(repeatedHeaderMessage(title, columns));
    }
    const rows = sheet.rows
      .filter((row) => row.rowNumber > header.rowNumber)
      .flatMap((row) => {
        const product = productColumn === -1 ? null : cut(row.cells[productColumn] ?? null);
        const code = codeColumn === -1 ? null : cut(row.cells[codeColumn] ?? null);
        const quantity = cut(row.cells[pickedColumn] ?? null);
        const named = !isBlank(product) || !isBlank(code);
        if (!named && isBlank(quantity)) return [];
        if (row.hidden && !named) return [];
        const fileRow: PickFileRow = {
          rowNumber: row.rowNumber,
          product: product === null ? "" : displayText(String(product)),
          quantity,
        };
        if (codeColumn !== -1) fileRow.code = code;
        if (row.hidden) fileRow.hidden = true;
        if (typeof quantity === "number" && row.dateColumns?.includes(pickedColumn)) fileRow.quantityIsDate = true;
        return [fileRow];
      });
    // A hidden code column would decide what nobody looking at the sheet
    // can see: a row saved into whichever product its code names while the
    // name in view says another, or skipped for a code the screen does not
    // show. Refused, not read past: its codes are how the person named the
    // products, and reading the rows by name instead would drop them
    // unsaid. Only once a row in view holds anything in it. An empty one,
    // hidden as clutter by someone who uses no codes, decides nothing — and
    // nor do codes in rows the file hides as well, which are never imported:
    // the person shown the column would find no code in view to explain the
    // refusal. Read as if in view, those codes still say whose file this is
    // (mostlyNotInPick), as a hidden row's code always does.
    if (codeColumn !== -1 && sheet.hiddenColumns?.includes(codeColumn) && rows.some((row) => !row.hidden && !isBlank(row.code ?? null))) {
      throw new PickFileError(hiddenCodeColumnMessage(codeColumn));
    }
    return rows;
  }
  return null;
}

// ------------------------------------------------------------ quantities

type Quantity =
  | { kind: "blank" }
  | { kind: "value"; value: number }
  | { kind: "invalid"; message: string };

// The same sentence the template's own cell validation shows.
const QUANTITY_RULE = "יש להזין מספר שלם של משטחים, 0 ומעלה, או להשאיר ריק.";

// Digits, with an optional minus (so a negative gets its own message rather
// than "not a number") and an optional decimal part: after a point, or after
// a comma followed by one or two digits ("2,5"). A comma before three digits
// is a thousands separator ("1,000"), which read as a decimal comma would
// quietly have become 1 — so that is not a number this reads at all.
const NUMERIC_TEXT = /^-?\d+(?:\.\d+|,\d{1,2})?$/;

function invalid(problem: string): Quantity {
  return { kind: "invalid", message: `${problem} ${QUANTITY_RULE}` };
}

function writtenAs(cell: XlsxCellValue): string {
  if (cell === null) return "";
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  return typeof cell === "number" ? String(cell) : displayText(cell);
}

// A skipped row's quantity, shown beside the reason it is skipped: as the
// file holds it, except a number the file shows as a date or a time, which
// is named as one. Its day count (46054) would read as that many pallets.
function skippedQuantity(row: PickFileRow): string {
  return row.quantityIsDate ? "תאריך או שעה" : writtenAs(row.quantity);
}

// A date or a time where the count should be. Excel turns "1/2" or "5-6"
// typed into a cell into a date, kept under a date format as a day count
// (46054 is 1 February 2026) — which the template's whole-number check lets
// through, a day count being a whole number. Typing the count again does not
// undo it, as the cell keeps its date format; hence the advice.
const DATE_QUANTITY =
  "בעמודת המשטחים יש תאריך או שעה, לא מספר — כנראה Excel הפך את מה שהוקלד לתאריך. החזירו את התא לעיצוב מספר רגיל והזינו בו מספר שלם של משטחים.";

// A number cell, or text that is a number ("7" typed into a cell formatted as
// text). Decimals are refused, never rounded: 2.5 pallets is a mistake to fix
// in the file, and rounding it either way would be the upload guessing. So is
// a number shown as a date or a time, whatever it is.
function parseQuantity(cell: XlsxCellValue, shownAsDate: boolean): Quantity {
  if (isBlank(cell)) return { kind: "blank" };
  if (shownAsDate) return { kind: "invalid", message: DATE_QUANTITY };
  const written = writtenAs(cell);
  let value: number;
  if (typeof cell === "number") {
    value = cell;
  } else if (typeof cell === "string" && NUMERIC_TEXT.test(written)) {
    value = Number(written.replace(",", "."));
  } else {
    return invalid(`"${isolate(written)}" אינו מספר.`);
  }
  if (!Number.isFinite(value)) return invalid(`"${isolate(written)}" אינו מספר.`);
  if (value < 0) return invalid(`${isolate(written)} הוא מספר שלילי.`);
  if (!Number.isInteger(value)) return invalid(`${isolate(written)} אינו מספר שלם — הליקוט נקלט במשטחים שלמים.`);
  if (value > MAX_PALLETS) return invalid(`${isolate(written)} גדול מדי.`);
  // -0 (typed as "-0") is just 0.
  return { kind: "value", value: value === 0 ? 0 : value };
}

// ------------------------------------------------------------- the plan

/** One of the grower's pick lines, as the upload needs it. */
export interface PickLineForImport {
  /** The pick line's own id (daily_pick_products.id): what is saved, and what a change is known by. */
  id: string;
  /** Its variety's id (product_varieties.id): the code a file's "קוד מוצר" names it by. */
  varietyId: string;
  name: string;
  sizes: string | null;
  /** Its variety's family's name (product_families.name); null when the line came without its family. */
  familyName: string | null;
  palletsPicked: number;
  leftoverPallets: number;
  comment: string | null;
}

// growerQueries.pickLines' rows (get_pick_lines), as plain numbers.
export function toImportLines(rows: readonly PickProductLineRow[]): PickLineForImport[] {
  return rows.flatMap((row) =>
    row.product_varieties
      ? [
          {
            id: row.id,
            varietyId: row.product_variety_id,
            name: row.product_varieties.name,
            sizes: row.product_varieties.sizes,
            familyName: row.product_varieties.product_families?.name ?? null,
            palletsPicked: Number(row.pallets_picked) || 0,
            leftoverPallets: Number(row.leftover_pallets) || 0,
            comment: row.comment,
          },
        ]
      : [],
  );
}

export interface PickImportChange {
  rowNumber: number;
  lineId: string;
  /** Ori's own label for the line — with what tells it apart, when another line of the pick has the same label (changeLabel). */
  product: string;
  from: number;
  to: number;
}

export interface PickImportSkipped {
  rowNumber: number;
  /** The product as the file names it; the code as written when the row has no name (rowProduct). */
  product: string;
  /** The quantity as written, "" when blank. */
  quantity: string;
  reason: string;
  /** Ori's labels this might have meant — the same name, with its size. */
  suggestions: string[];
}

export interface PickImportError {
  rowNumber: number;
  /**
   * The product as the file names it. A row without a name is named by its
   * code: as Ori's label for the line the code found, or as written (rowProduct).
   */
  product: string;
  message: string;
}

export interface PickImportPlan {
  /** Rows under the header that hold anything at all — of the hidden ones, those listed in notImported. */
  rowCount: number;
  /** Lines whose picked count the file changes — the only lines saved. */
  changes: PickImportChange[];
  /** Rows that leave their line as it is: a blank quantity, or the number already there. */
  unchanged: number;
  /** Rows that name no line of this pick. Shown, skipped, and they block nothing. */
  notImported: PickImportSkipped[];
  /** What must be fixed in the file first. Any one of them blocks the whole upload. */
  errors: PickImportError[];
  /**
   * Present when the file hides rows that name a product or have a code: how
   * many, listed in notImported or not (one with no quantity is not shown at
   * all), and how many of them name no line of this pick — by their code
   * when it is one, and by their name when they have no code. None of them
   * is imported, but their products still say whose file this is
   * (mostlyNotInPick).
   */
  hiddenProducts?: { count: number; notInPick: number };
}

// No closing period on any skip reason: the preview follows a reason with
// the row's quantity.
export const NOT_IN_PICK = "לא נמצא בליקוט של המגדל";
export const HIDDEN_ROW = "השורה מוסתרת בקובץ ולא תיקלט. הציגו אותה ב-Excel והעלו שוב אם צריך";
// Skipped even when the name beside it is one of the pick's: the code is
// what the row says the product is, and whichever of the two is wrong, the
// upload does not choose between them. Said in the reason, as a name the
// pick has looks like it should have been enough.
export const CODE_NOT_IN_PICK = "קוד המוצר לא נמצא בליקוט של המגדל. כשיש בשורה קוד, הקוד קובע איזה מוצר זה";
// Not read by the name instead, for the same reason — the row still says
// it names a product by its code. Deleting the code is how to say it does not.
export const INVALID_CODE =
  'קוד המוצר לא תקין. העתיקו אותו שוב מעמודת "קוד מוצר" במסך המוצרים, או מחקו אותו כדי שהשורה תיקרא לפי שם המוצר';
// The same for a row without a name, where deleting the code would leave
// nothing to read the row by: only copying it again is any help.
export const INVALID_CODE_WITHOUT_NAME = 'קוד המוצר לא תקין. העתיקו אותו שוב מעמודת "קוד מוצר" במסך המוצרים';
// A name of one of the pick's lines where the code belongs. The template
// before the code column began with "מוצר", so hands used to it type the
// name into the first column, or paste the old file's rows there — and to
// be told to copy the code again sends them looking for a code they never
// meant to give. Still not read by that name: a row shifted a column over
// has its other cells shifted too (the old file's quantity under "מוצר"),
// and which cell means what is the person's to say, not the upload's to
// guess.
export const NAME_IN_CODE_COLUMN = `בעמודה "${PICK_UPLOAD_HEADERS.code}" כתוב שם של מוצר ולא קוד. העבירו אותו לעמודה "${PICK_UPLOAD_HEADERS.product}", או העתיקו את הקוד ממסך המוצרים`;
const NO_PRODUCT = "חסר שם מוצר";
// The same, in a file with the code column: either one would name it.
const NO_PRODUCT_OR_CODE = "אין בשורה קוד מוצר או שם מוצר";
const AMBIGUOUS =
  "השם מתאים ליותר ממוצר אחד בליקוט של המגדל, ואי אפשר לדעת לאיזה מהם הכוונה. עדכנו את המוצר הזה בעריכת הליקוט (העיפרון).";
// A pick holds one line per variety (migration 0009's unique constraint),
// so this cannot happen today. Should it, the code is refused like a shared
// name, rather than read as whichever of the lines came first.
const AMBIGUOUS_CODE =
  "הקוד מתאים ליותר משורה אחת בליקוט של המגדל, ואי אפשר לדעת לאיזו מהן הכוונה. עדכנו את המוצר הזה בעריכת הליקוט (העיפרון).";

/** Ori's own label for a pick line, as the pick editor shows it. */
function labelOf(line: PickLineForImport): string {
  return formatVarietyName(line.name, line.sizes);
}

// A code's last group, the part of it that differs most at a glance.
function codeEnding(varietyId: string): string {
  const code = varietyId.toLowerCase();
  return code.slice(code.lastIndexOf("-") + 1);
}

// What the preview shows a change as: Ori's label for its line — and when
// other lines of the pick share that label (`sameLabel`, the line among
// them), what tells this one apart. Nothing makes a variety's name and size
// unique: its family and its pack type tell varieties apart too. A row's
// code chooses between such lines with nothing from the name to check it,
// so the label alone would show a row with the neighbouring variety's code
// exactly as it shows the right one. The family, as the pick editor groups
// its lines by family; where that is shared too, the end of the code,
// which the products screen shows in full — or the whole code, should even
// that be shared. The code is set left to right in its own isolate, so the
// ellipsis stays on the left of it, where its cut-off start is.
function changeLabel(line: PickLineForImport, sameLabel: readonly PickLineForImport[]): string {
  const label = labelOf(line);
  const others = sameLabel.filter((other) => other !== line);
  if (others.length === 0) return label;
  const family = normalizeLabel(line.familyName ?? "");
  if (family !== "" && others.every((other) => normalizeLabel(other.familyName ?? "") !== family)) {
    return `${line.familyName} — ${label}`;
  }
  const ending = codeEnding(line.varietyId);
  const code = others.some((other) => codeEnding(other.varietyId) === ending)
    ? line.varietyId.toLowerCase()
    : `…${ending}`;
  return `${label} (קוד \u2066${code}\u2069)`;
}

// The row's code and its name say two different lines of the pick. One of
// them is wrong, and which one only the person knows: the upload stops
// until the row says one thing. Both labels are Ori's own, isolated, as an
// English name keeps its own direction.
function codeNameConflictMessage(codeLine: PickLineForImport, nameLine: PickLineForImport): string {
  return `הקוד והשם בשורה מתאימים לשני מוצרים שונים בליקוט של המגדל: הקוד הוא של "${isolate(labelOf(codeLine))}", והשם של "${isolate(labelOf(nameLine))}". תקנו את השורה כך שהקוד והשם יהיו של אותו מוצר, או מחקו אחד מהם.`;
}

// What a row's "קוד מוצר" cell says: nothing (the file has no such column,
// or the cell is empty), a code, or something that is not one.
type RowCode = { kind: "none" } | { kind: "code"; code: string } | { kind: "invalid" };

function codeOf(row: PickFileRow): RowCode {
  if (row.code === undefined || isBlank(row.code)) return { kind: "none" };
  const code = normalizeProductCode(row.code);
  return code === null ? { kind: "invalid" } : { kind: "code", code };
}

// What the preview calls a row: the file's own name for its product. A row
// without one is called by its code — Ori's label, once the code has found
// its line, and otherwise the code as the file writes it, the one thing
// left there that says which row it is.
function rowProduct(row: PickFileRow, line?: PickLineForImport): string {
  if (row.product !== "") return row.product;
  if (line) return labelOf(line);
  return row.code === undefined ? "" : writtenAs(row.code);
}

// save_pick_lines' own floor (P0006, migration 0076), checked here first so
// the preview can name the row: picked + leftover may not drop below what is
// already arranged to customers from the line. Picks are whole, so the
// smallest number the file could hold instead is rounded up.
function belowArrangedMessage(arranged: number, leftover: number, picked: number): string {
  const minimum = Math.max(0, Math.ceil(roundPallets(arranged - leftover)));
  const withLeftover = leftover > 0 ? ` (ועם העודף ${roundPallets(picked + leftover)})` : "";
  return `כבר סודרו ${arranged} משטחים מהמוצר הזה ללקוחות, אבל בקובץ נקטפו ${picked}${withLeftover}. יש להזין לפחות ${minimum}, או לשנות קודם את הסידור.`;
}

function byRow<T extends { rowNumber: number }>(a: T, b: T): number {
  return a.rowNumber - b.rowNumber;
}

// What the upload would do with the file's rows, against the pick's lines as
// they are now and what is already arranged from each (arrangement_records'
// quantity_pallets summed per line; a line with none can be left out).
//
// Duplicates and ambiguous names block rather than pick a winner: the file
// saying two things about one product is the person's to settle, not the
// upload's to guess. Two rows are two things about one product however each
// names it — by code, by name, or one of each — as both are saved to one line.
export function planPickImport(
  rows: readonly PickFileRow[],
  lines: readonly PickLineForImport[],
  arrangedByLineId: ReadonlyMap<string, number>,
): PickImportPlan {
  const linesByLabel = new Map<string, PickLineForImport[]>();
  const labelsByName = new Map<string, string[]>();
  // By the variety's id, in the form normalizeProductCode reads a code into.
  const linesByCode = new Map<string, PickLineForImport[]>();
  for (const line of lines) {
    const label = labelOf(line);
    const key = normalizeLabel(label);
    linesByLabel.set(key, [...(linesByLabel.get(key) ?? []), line]);
    if (line.sizes) {
      const name = normalizeLabel(line.name);
      labelsByName.set(name, [...(labelsByName.get(name) ?? []), label]);
    }
    const code = line.varietyId.toLowerCase();
    linesByCode.set(code, [...(linesByCode.get(code) ?? []), line]);
  }

  const plan: PickImportPlan = { rowCount: 0, changes: [], unchanged: 0, notImported: [], errors: [] };
  const rowsByLine = new Map<string, { line: PickLineForImport; rows: PickFileRow[] }>();
  const skip = (row: PickFileRow, reason: string, suggestions: string[] = []) => {
    plan.notImported.push({
      rowNumber: row.rowNumber,
      product: rowProduct(row),
      quantity: skippedQuantity(row),
      reason,
      suggestions,
    });
  };

  for (const row of rows) {
    const key = normalizeLabel(row.product);
    const byName = key === "" ? [] : (linesByLabel.get(key) ?? []);
    const code = codeOf(row);
    const byCode = code.kind === "code" ? (linesByCode.get(code.code) ?? []) : [];
    // Hidden in the file: never imported — no change, its quantity not
    // checked, its name not checked against its code, and no duplicate of a
    // visible row that names the same product. Its product is looked up only
    // to be counted (hiddenProducts) — by its code when it has one, as a
    // visible row would be matched — and the row is listed only if it held a
    // quantity: one with none has nothing to show.
    if (row.hidden) {
      if (key !== "" || code.kind !== "none") {
        const hidden = (plan.hiddenProducts ??= { count: 0, notInPick: 0 });
        hidden.count++;
        // A cell that is no code was mistyped, which says nothing of whose
        // file this is — exactly as for a visible row (mostlyNotInPick).
        const notInPick = code.kind === "code" ? byCode.length === 0 : code.kind === "none" && byName.length === 0;
        if (notInPick) hidden.notInPick++;
      }
      if (isBlank(row.quantity)) continue;
      plan.rowCount++;
      skip(row, HIDDEN_ROW);
      continue;
    }
    plan.rowCount++;
    let line: PickLineForImport;
    if (code.kind === "invalid") {
      // Its text compared as a name would be: a label of the pick is a
      // name typed where the code belongs (NAME_IN_CODE_COLUMN).
      const nameInCode = linesByLabel.has(normalizeLabel(writtenAs(row.code ?? null)));
      skip(row, nameInCode ? NAME_IN_CODE_COLUMN : row.product === "" ? INVALID_CODE_WITHOUT_NAME : INVALID_CODE);
      continue;
    }
    if (code.kind === "code") {
      const [codeLine, ...others] = byCode;
      if (!codeLine) {
        skip(row, CODE_NOT_IN_PICK);
        continue;
      }
      if (others.length > 0) {
        plan.errors.push({ rowNumber: row.rowNumber, product: rowProduct(row), message: AMBIGUOUS_CODE });
        continue;
      }
      // The name only checks the code. No name, a name the pick does not
      // have (the grower's own, or misspelled), or one this line answers to
      // — alone, or with another line that shares it — agrees with the code.
      // A name only other lines answer to is the row contradicting itself.
      const [nameLine] = byName;
      if (nameLine && !byName.includes(codeLine)) {
        plan.errors.push({
          rowNumber: row.rowNumber,
          product: row.product,
          message: codeNameConflictMessage(codeLine, nameLine),
        });
        continue;
      }
      line = codeLine;
    } else {
      const [nameLine, ...others] = byName;
      if (!nameLine) {
        // The file's own words for a row that names nothing, in a file that
        // offered a code column as well as the name.
        const nothing = row.code === undefined ? NO_PRODUCT : NO_PRODUCT_OR_CODE;
        skip(row, key === "" ? nothing : NOT_IN_PICK, key === "" ? [] : (labelsByName.get(key) ?? []));
        continue;
      }
      if (others.length > 0) {
        plan.errors.push({ rowNumber: row.rowNumber, product: row.product, message: AMBIGUOUS });
        continue;
      }
      line = nameLine;
    }
    const entry = rowsByLine.get(line.id);
    if (entry) entry.rows.push(row);
    else rowsByLine.set(line.id, { line, rows: [row] });
  }

  for (const { line, rows: lineRows } of rowsByLine.values()) {
    const [first, ...repeats] = lineRows;
    if (!first) continue;
    if (repeats.length > 0) {
      for (const repeat of repeats) {
        plan.errors.push({
          rowNumber: repeat.rowNumber,
          product: rowProduct(repeat, line),
          message: `המוצר מופיע בקובץ יותר מפעם אחת (גם בשורה ${first.rowNumber}). השאירו שורה אחת לכל מוצר.`,
        });
      }
      continue;
    }
    const quantity = parseQuantity(first.quantity, first.quantityIsDate === true);
    if (quantity.kind === "invalid") {
      plan.errors.push({ rowNumber: first.rowNumber, product: rowProduct(first, line), message: quantity.message });
      continue;
    }
    if (quantity.kind === "blank" || quantity.value === line.palletsPicked) {
      plan.unchanged++;
      continue;
    }
    const arranged = roundPallets(arrangedByLineId.get(line.id) ?? 0);
    if (roundPallets(quantity.value + line.leftoverPallets) < arranged) {
      plan.errors.push({
        rowNumber: first.rowNumber,
        product: rowProduct(first, line),
        message: belowArrangedMessage(arranged, line.leftoverPallets, quantity.value),
      });
      continue;
    }
    plan.changes.push({
      rowNumber: first.rowNumber,
      lineId: line.id,
      product: changeLabel(line, linesByLabel.get(normalizeLabel(labelOf(line))) ?? []),
      from: line.palletsPicked,
      to: quantity.value,
    });
  }

  plan.changes.sort(byRow);
  plan.notImported.sort(byRow);
  plan.errors.sort(byRow);
  return plan;
}

// Whether most of the products the file names are not in this grower's pick:
// what a file filled in for ANOTHER grower looks like when it is uploaded
// from the wrong row — and the products the two growers share would still be
// saved into this one's pick. A product the pick doesn't have never blocks
// the upload, so neither does this; the dialog warns by the grower's name.
// A hidden row counts like any other, listed or not: it is saved into no
// pick, but the product it names is still the file's. A filter showing only
// the rows filled in today would otherwise hide most of the evidence.
//
// A code counts as its product does, whatever the name beside it: a code
// no line of this pick has is evidence just like a name none has — most of
// all the codes of the other grower's own products. A cell that is no code
// at all was mistyped, which says nothing of whose file this is, so it is
// no evidence; but the row did name something, so it is counted among the
// rows that do, as a row with a name in the pick is. A name of the pick's
// typed where the code belongs (NAME_IN_CODE_COLUMN) is no code either, and
// counts exactly as a mistyped one.
export function mostlyNotInPick(plan: PickImportPlan): boolean {
  const listed = (...reasons: string[]) => plan.notImported.filter((skip) => reasons.includes(skip.reason)).length;
  const hidden = plan.hiddenProducts ?? { count: 0, notInPick: 0 };
  // The visible rows that name a product, by name or by code: every row
  // shown, less those that name none and the hidden ones, which
  // hiddenProducts counts listed or not.
  const visibleNamed = plan.rowCount - listed(NO_PRODUCT, NO_PRODUCT_OR_CODE, HIDDEN_ROW);
  return (listed(NOT_IN_PICK, CODE_NOT_IN_PICK) + hidden.notInPick) * 2 > visibleNamed + hidden.count;
}

// Whether the plan made again from the lines as they are NOW (re-read when
// "אישור וקליטה" is pressed) would do anything the preview did not show —
// in which case nothing is saved, and the new plan is shown to be confirmed
// instead. A change the preview listed, now made by someone else already,
// simply drops out; that is not news. A line changed by someone else in the
// meantime is fine too, as long as the file's number for it is the one the
// preview showed being saved. Changes are compared by the pick line they
// save to, however the row named it (code or name), and skipped rows by the
// row: like with like on both sides.
export function planChangedSince(previewed: PickImportPlan, current: PickImportPlan): boolean {
  if (current.errors.length > 0) return true;
  const previewedChanges = new Map(previewed.changes.map((change) => [change.lineId, change.to]));
  if (current.changes.some((change) => previewedChanges.get(change.lineId) !== change.to)) return true;
  const previewedSkips = new Set(previewed.notImported.map((skip) => skip.rowNumber));
  return current.notImported.some((skip) => !previewedSkips.has(skip.rowNumber));
}

// What save_pick_lines is sent: the plan's changes, built over the lines as
// they are at the moment of saving (`freshLines`, re-read just before).
// save_pick_lines overwrites a line's picked count, leftover AND comment
// together, so each line sent carries its CURRENT leftover and comment — a
// leftover or comment edited since the preview was read stays as it was
// edited. Only lines whose picked count really changes are sent; every other
// line is not touched at all.
export function toSavePickLines(
  plan: PickImportPlan,
  freshLines: readonly PickLineForImport[],
): PickLineInput[] {
  const linesById = new Map(freshLines.map((line) => [line.id, line]));
  return plan.changes.flatMap((change) => {
    const line = linesById.get(change.lineId);
    // The dialog plans on the same fresh lines it saves with, so this would
    // be a line it never saw — refused rather than skipped in silence.
    if (!line) throw new Error("אחד המוצרים כבר לא בליקוט של המגדל. בחרו את הקובץ שוב.");
    if (line.palletsPicked === change.to) return [];
    return [
      {
        dailyPickProductId: line.id,
        palletsPicked: change.to,
        leftoverPallets: line.leftoverPallets,
        comment: line.comment,
      },
    ];
  });
}

// --------------------------------------------------------- file problems

const USE_TEMPLATE = 'יש להעלות את תבנית הליקוט של אורי ("הורדת תבנית") אחרי שמילאתם אותה.';

// What readPickFileRows looks for: the quantity's column, and a column that
// says which product — the code's, the name's, or both.
export const NO_HEADER_MESSAGE = `לא נמצאו בקובץ העמודות של תבנית הליקוט: עמודה בשם "${PICK_UPLOAD_HEADERS.picked}", ולצידה עמודה בשם "${PICK_UPLOAD_HEADERS.code}" או "${PICK_UPLOAD_HEADERS.product}" (או שתיהן). ${USE_TEMPLATE} הכותרות נמצאות בשורה הראשונה של הגיליון "${PICK_UPLOAD_SHEET}".`;

/** Why a chosen file is refused before it is even opened, or null. */
export function pickFileProblem(file: { name: string; size: number }): string | null {
  if (!file.name.trim().toLowerCase().endsWith(".xlsx")) {
    return `הקובץ "${isolate(file.name)}" אינו קובץ אקסל מסוג ${XLSX}. ${USE_TEMPLATE}`;
  }
  if (file.size > PICK_UPLOAD_MAX_BYTES) {
    return `הקובץ גדול מדי (מעל 2MB), ותבנית הליקוט שוקלת קילובייטים בודדים — ודאו שבחרתם את הקובץ הנכון. ${USE_TEMPLATE}`;
  }
  return null;
}

// The most tab names a message lists: a workbook can hold hundreds.
const MAX_LISTED_SHEETS = 5;

// Tab names in a sentence, each quoted and isolated (a name may be English,
// or end in "(2)"), and any past the first few counted rather than listed.
function sheetList(names: readonly string[]): string {
  const listed = names.slice(0, MAX_LISTED_SHEETS).map((name) => `"${isolate(sheetLabel(name))}"`);
  const more = names.length - listed.length;
  return more > 0 ? `${listed.join(", ")} ועוד ${more}` : listed.join(", ");
}

const NO_SHEET_MESSAGE = `בקובץ אין גיליון ליקוט גלוי: הגיליון "${PICK_UPLOAD_INSTRUCTIONS_SHEET}" וגיליונות מוסתרים לא נקראים. אם גיליון הליקוט מוסתר, הציגו אותו ב-Excel ונסו שוב. ${USE_TEMPLATE}`;

/** A failure to read the chosen file (readXlsxSheet's, readPickFileRows', or the browser's), in words. */
export function pickFileReadErrorMessage(error: unknown): string {
  if (error instanceof PickFileError) return error.message;
  if (!(error instanceof XlsxError)) return "לא ניתן היה לקרוא את הקובץ. בחרו אותו שוב.";
  switch (error.code) {
    // Which tab to read is the person's to say: reading one of several is
    // how one grower's numbers were saved into another's pick.
    case "several_sheets":
      return `בקובץ יש כמה גיליונות: ${sheetList(error.sheetNames)}. השאירו בקובץ גיליון ליקוט אחד — קובץ אחד לכל מגדל — ונסו שוב.`;
    case "no_sheets":
      return NO_SHEET_MESSAGE;
    case "legacy_or_encrypted":
    case "encrypted":
      return `זה קובץ אקסל בפורמט ישן או קובץ מוגן בסיסמה. שמרו אותו כקובץ ${XLSX} רגיל, בלי סיסמה. ${USE_TEMPLATE}`;
    case "too_large":
    case "zip64":
      return `הקובץ גדול מדי לקריאה — ודאו שבחרתם את הקובץ הנכון. ${USE_TEMPLATE}`;
    case "unsupported_runtime":
      return "הדפדפן הזה לא יכול לקרוא קבצי אקסל. עדכנו אותו, או פתחו את המסך בדפדפן אחר.";
    default:
      return `לא ניתן לקרוא את הקובץ כקובץ אקסל ${XLSX}. ${USE_TEMPLATE}`;
  }
}

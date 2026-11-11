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
//   - "מוצר" names a product the way Ori shows it: formatVarietyName(name,
//     sizes), e.g. "רד-דיימונד גדול".
//   - "משטחים שנקטפו" is whole pallets, 0 or more — picks stay whole until the
//     client decides otherwise (decision D18), as the pick editor's own box
//     does (lib/integer-input.ts). A blank cell leaves the line as it is; 0
//     sets it to zero.
//   - A product the file leaves out is left as it is: it is not sent at all.
//   - A product that is not one of this grower's pick lines for the day is
//     listed in the preview and skipped. It does not stop the rest.
//   - Leftovers (עודף) and comments are never changed: every line sent carries
//     its own current leftover and comment back unchanged.
//   - Nothing is saved before the preview is confirmed.
// One file per grower, so there is no grower column: the upload runs from the
// grower's own row, and that row decides whose pick it is.
//
// Three more rules are about what a spreadsheet program can do to the file,
// not what a grower fills in, and the template does not state them; the
// preview explains each one where it applies:
//   - The tab read is the file's one visible sheet besides "הוראות", whatever
//     its name, and the preview names it. A file with more than one is
//     refused, naming them: a copy of the tab ("ליקוט (2)") or a tab per
//     grower is another grower's numbers waiting to be saved into this pick.
//   - A row hidden in the file (by a filter, a collapsed group, or by hand) is
//     not imported: nobody checked a row they could not see, and one can
//     still hold yesterday's numbers. One that would have imported something
//     is listed as skipped. Listed or not, the product it names still counts
//     toward the warning that the file may be another grower's.
//   - A quantity the file shows as a date or a time is refused: what is
//     stored is the date's day count (46054), not pallets.

export const PICK_UPLOAD_SHEET = "ליקוט";
// The template's instructions: never the tab that is read (lib/xlsx-reader.ts).
export const PICK_UPLOAD_INSTRUCTIONS_SHEET = "הוראות";
export const PICK_UPLOAD_HEADERS = { product: "מוצר", picked: "משטחים שנקטפו" } as const;
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

// ------------------------------------------------------------- the file

export interface PickFileRow {
  /** The row's number in the spreadsheet, as Excel shows it — what every message cites. */
  rowNumber: number;
  /** The product as the file writes it: trimmed, inner spaces collapsed, cut to MAX_CELL_TEXT. "" when blank. */
  product: string;
  /** The "משטחים שנקטפו" cell, as read — text cut to MAX_CELL_TEXT. */
  quantity: XlsxCellValue;
  /**
   * Present, and true, when the file hides the row: it is never imported.
   * Only rows that name a product are kept then — listed as not imported when
   * they hold a quantity too, and otherwise only counted, as their product
   * still says whose file this is (mostlyNotInPick).
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

// The rows under the template's header, by the header's own columns rather
// than by fixed letters — so a sheet with the columns moved, or a column
// added, still reads. The legend beside the table (column D) is never looked
// at. Rows with neither a product nor a quantity are left out, and so are
// hidden rows without a product: never imported, a hidden row is kept only
// for the product it names, which still says whose file this is. Null when
// no row in the first few holds both headers — looked for in hidden rows
// too, as before. A header row that gives either title to more than one
// column throws a PickFileError naming the columns.
export function readPickFileRows(sheet: XlsxSheet): PickFileRow[] | null {
  const productHeader = normalizeLabel(PICK_UPLOAD_HEADERS.product);
  const pickedHeader = normalizeLabel(PICK_UPLOAD_HEADERS.picked);
  for (const header of sheet.rows.slice(0, HEADER_SEARCH_ROWS)) {
    // A cell too long to be either title is not even normalized: up to a
    // hundred of them in each of the rows looked through could be that one
    // huge text (MAX_CELL_TEXT).
    const titles = header.cells.map((cell) =>
      typeof cell === "string" && cell.length <= MAX_CELL_TEXT ? normalizeLabel(cell) : null,
    );
    const productColumn = titles.indexOf(productHeader);
    const pickedColumn = titles.indexOf(pickedHeader);
    if (productColumn === -1 || pickedColumn === -1) continue;
    // A title over more than one column is refused, never read from the
    // first: that is how a hidden column of yesterday's numbers, kept beside
    // today's under the same title, would be saved as today's. Which column
    // is meant is the person's to say.
    for (const [title, normalized] of [
      [PICK_UPLOAD_HEADERS.product, productHeader],
      [PICK_UPLOAD_HEADERS.picked, pickedHeader],
    ] as const) {
      const columns = titles.flatMap((cell, column) => (cell === normalized ? [column] : []));
      if (columns.length > 1) throw new PickFileError(repeatedHeaderMessage(title, columns));
    }
    return sheet.rows
      .filter((row) => row.rowNumber > header.rowNumber)
      .flatMap((row) => {
        const product = cut(row.cells[productColumn] ?? null);
        const quantity = cut(row.cells[pickedColumn] ?? null);
        if (isBlank(product) && isBlank(quantity)) return [];
        if (row.hidden && isBlank(product)) return [];
        const fileRow: PickFileRow = {
          rowNumber: row.rowNumber,
          product: product === null ? "" : displayText(String(product)),
          quantity,
        };
        if (row.hidden) fileRow.hidden = true;
        if (typeof quantity === "number" && row.dateColumns?.includes(pickedColumn)) fileRow.quantityIsDate = true;
        return [fileRow];
      });
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
  id: string;
  name: string;
  sizes: string | null;
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
            name: row.product_varieties.name,
            sizes: row.product_varieties.sizes,
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
  /** Ori's own label for the line. */
  product: string;
  from: number;
  to: number;
}

export interface PickImportSkipped {
  rowNumber: number;
  product: string;
  /** The quantity as written, "" when blank. */
  quantity: string;
  reason: string;
  /** Ori's labels this might have meant — the same name, with its size. */
  suggestions: string[];
}

export interface PickImportError {
  rowNumber: number;
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
   * Present when the file hides rows that name a product: how many, listed in
   * notImported or not (one with no quantity is not shown at all), and how
   * many of them name no line of this pick. None of them is imported, but
   * their products still say whose file this is (mostlyNotInPick).
   */
  hiddenProducts?: { count: number; notInPick: number };
}

export const NOT_IN_PICK = "לא נמצא בליקוט של המגדל";
// No closing period: the preview follows a reason with the row's quantity.
export const HIDDEN_ROW = "השורה מוסתרת בקובץ ולא תיקלט. הציגו אותה ב-Excel והעלו שוב אם צריך";
const NO_PRODUCT = "חסר שם מוצר";
const AMBIGUOUS =
  "השם מתאים ליותר ממוצר אחד בליקוט של המגדל, ואי אפשר לדעת לאיזה מהם הכוונה. עדכנו את המוצר הזה בעריכת הליקוט (העיפרון).";

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
// upload's to guess.
export function planPickImport(
  rows: readonly PickFileRow[],
  lines: readonly PickLineForImport[],
  arrangedByLineId: ReadonlyMap<string, number>,
): PickImportPlan {
  const linesByLabel = new Map<string, PickLineForImport[]>();
  const labelsByName = new Map<string, string[]>();
  for (const line of lines) {
    const label = formatVarietyName(line.name, line.sizes);
    const key = normalizeLabel(label);
    linesByLabel.set(key, [...(linesByLabel.get(key) ?? []), line]);
    if (line.sizes) {
      const name = normalizeLabel(line.name);
      labelsByName.set(name, [...(labelsByName.get(name) ?? []), label]);
    }
  }

  const plan: PickImportPlan = { rowCount: 0, changes: [], unchanged: 0, notImported: [], errors: [] };
  const rowsByLine = new Map<string, { line: PickLineForImport; rows: PickFileRow[] }>();

  for (const row of rows) {
    const key = normalizeLabel(row.product);
    const matches = key === "" ? [] : (linesByLabel.get(key) ?? []);
    // Hidden in the file: never imported — no change, its quantity not
    // checked, and no duplicate of a visible row that names the same
    // product. Its product is looked up only to be counted (hiddenProducts),
    // and the row is listed only if it held a quantity: one with none has
    // nothing to show.
    if (row.hidden) {
      if (key !== "") {
        const hidden = (plan.hiddenProducts ??= { count: 0, notInPick: 0 });
        hidden.count++;
        if (matches.length === 0) hidden.notInPick++;
      }
      if (isBlank(row.quantity)) continue;
      plan.rowCount++;
      plan.notImported.push({
        rowNumber: row.rowNumber,
        product: row.product,
        quantity: skippedQuantity(row),
        reason: HIDDEN_ROW,
        suggestions: [],
      });
      continue;
    }
    plan.rowCount++;
    if (matches.length === 0) {
      plan.notImported.push({
        rowNumber: row.rowNumber,
        product: row.product,
        quantity: skippedQuantity(row),
        reason: key === "" ? NO_PRODUCT : NOT_IN_PICK,
        suggestions: key === "" ? [] : (labelsByName.get(key) ?? []),
      });
      continue;
    }
    const [line, ...others] = matches;
    if (others.length > 0 || !line) {
      plan.errors.push({ rowNumber: row.rowNumber, product: row.product, message: AMBIGUOUS });
      continue;
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
          product: repeat.product,
          message: `המוצר מופיע בקובץ יותר מפעם אחת (גם בשורה ${first.rowNumber}). השאירו שורה אחת לכל מוצר.`,
        });
      }
      continue;
    }
    const quantity = parseQuantity(first.quantity, first.quantityIsDate === true);
    if (quantity.kind === "invalid") {
      plan.errors.push({ rowNumber: first.rowNumber, product: first.product, message: quantity.message });
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
        product: first.product,
        message: belowArrangedMessage(arranged, line.leftoverPallets, quantity.value),
      });
      continue;
    }
    plan.changes.push({
      rowNumber: first.rowNumber,
      lineId: line.id,
      product: formatVarietyName(line.name, line.sizes),
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
export function mostlyNotInPick(plan: PickImportPlan): boolean {
  const listed = (reason: string) => plan.notImported.filter((skip) => skip.reason === reason).length;
  const hidden = plan.hiddenProducts ?? { count: 0, notInPick: 0 };
  // The visible rows that name a product: every row shown, less those that
  // name none and the hidden ones, which hiddenProducts counts listed or not.
  const visibleNamed = plan.rowCount - listed(NO_PRODUCT) - listed(HIDDEN_ROW);
  return (listed(NOT_IN_PICK) + hidden.notInPick) * 2 > visibleNamed + hidden.count;
}

// Whether the plan made again from the lines as they are NOW (re-read when
// "אישור וקליטה" is pressed) would do anything the preview did not show —
// in which case nothing is saved, and the new plan is shown to be confirmed
// instead. A change the preview listed, now made by someone else already,
// simply drops out; that is not news. A line changed by someone else in the
// meantime is fine too, as long as the file's number for it is the one the
// preview showed being saved.
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

export const NO_HEADER_MESSAGE = `לא נמצאו בקובץ העמודות "${PICK_UPLOAD_HEADERS.product}" ו"${PICK_UPLOAD_HEADERS.picked}". ${USE_TEMPLATE} הכותרות נמצאות בשורה הראשונה של הגיליון "${PICK_UPLOAD_SHEET}".`;

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

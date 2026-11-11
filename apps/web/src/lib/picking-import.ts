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

export const PICK_UPLOAD_SHEET = "ליקוט";
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

function cut(cell: XlsxCellValue): XlsxCellValue {
  return typeof cell === "string" && cell.length > MAX_CELL_TEXT ? `${cell.slice(0, MAX_CELL_TEXT)}…` : cell;
}

function isBlank(cell: XlsxCellValue): boolean {
  return cell === null || (typeof cell === "string" && displayText(cell) === "");
}

// The rows under the template's header, by the header's own columns rather
// than by fixed letters — so a sheet with the columns moved, or a column
// added, still reads. The legend beside the table (column D) is never looked
// at. Rows with neither a product nor a quantity are left out; null when no
// row in the first few holds both headers.
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
    return sheet.rows
      .filter((row) => row.rowNumber > header.rowNumber)
      .flatMap((row) => {
        const product = cut(row.cells[productColumn] ?? null);
        const quantity = cut(row.cells[pickedColumn] ?? null);
        if (isBlank(product) && isBlank(quantity)) return [];
        return [
          {
            rowNumber: row.rowNumber,
            product: product === null ? "" : displayText(String(product)),
            quantity,
          },
        ];
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

// A number cell, or text that is a number ("7" typed into a cell formatted as
// text). Decimals are refused, never rounded: 2.5 pallets is a mistake to fix
// in the file, and rounding it either way would be the upload guessing.
function parseQuantity(cell: XlsxCellValue): Quantity {
  if (isBlank(cell)) return { kind: "blank" };
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
  /** Rows under the header that hold anything at all. */
  rowCount: number;
  /** Lines whose picked count the file changes — the only lines saved. */
  changes: PickImportChange[];
  /** Rows that leave their line as it is: a blank quantity, or the number already there. */
  unchanged: number;
  /** Rows that name no line of this pick. Shown, skipped, and they block nothing. */
  notImported: PickImportSkipped[];
  /** What must be fixed in the file first. Any one of them blocks the whole upload. */
  errors: PickImportError[];
}

export const NOT_IN_PICK = "לא נמצא בליקוט של המגדל";
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

  const plan: PickImportPlan = { rowCount: rows.length, changes: [], unchanged: 0, notImported: [], errors: [] };
  const rowsByLine = new Map<string, { line: PickLineForImport; rows: PickFileRow[] }>();

  for (const row of rows) {
    const key = normalizeLabel(row.product);
    const matches = key === "" ? [] : (linesByLabel.get(key) ?? []);
    if (matches.length === 0) {
      plan.notImported.push({
        rowNumber: row.rowNumber,
        product: row.product,
        quantity: writtenAs(row.quantity),
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
    const quantity = parseQuantity(first.quantity);
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
export function mostlyNotInPick(plan: PickImportPlan): boolean {
  const notInPick = plan.notImported.filter((skip) => skip.reason === NOT_IN_PICK).length;
  const named = plan.rowCount - plan.notImported.filter((skip) => skip.reason === NO_PRODUCT).length;
  return notInPick * 2 > named;
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

/** A failure to read the chosen file (readXlsxSheet's, or the browser's), in words. */
export function pickFileReadErrorMessage(error: unknown): string {
  if (!(error instanceof XlsxError)) return "לא ניתן היה לקרוא את הקובץ. בחרו אותו שוב.";
  switch (error.code) {
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

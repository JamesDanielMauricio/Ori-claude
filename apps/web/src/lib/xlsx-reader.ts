// Reads one sheet of an Excel workbook (.xlsx) into plain rows — the file
// reader behind the "בשם מגדל" picking upload (workbook Task 38).
//
// Hand-written rather than a spreadsheet package, on purpose. The upload
// needs one thing from a file: the text and numbers in one sheet's cells. The
// libraries that do that carry a whole spreadsheet engine (formulas, styles,
// writing, a dozen file formats) into the bundle, and they are exactly the
// kind of parser that has shipped prototype-pollution and zip-bomb bugs. What
// an .xlsx actually is fits in this file: a ZIP archive of XML parts, where
// xl/workbook.xml names the sheets, its relationships file says which part
// holds each one, and xl/sharedStrings.xml holds the text the sheets point to
// by number.
//
// Pure: no DOM. It runs the same in the browser and under vitest's node
// environment, which has no DOMParser — hence the small XML tokenizer below
// instead of one. The only platform piece it needs is DecompressionStream
// ("deflate-raw"), which every current browser and Node have.
//
// Built for files from people, so it defends itself:
//   - the ZIP is read through its central directory, the archive's own index,
//     and nothing it does not need is decompressed;
//   - encrypted entries and ZIP64 archives are refused (Excel writes neither
//     for a small workbook — a password-protected workbook is not even a ZIP);
//   - the total it will decompress, the number of entries, rows and columns
//     are all capped, and a part is decompressed a small slice at a time,
//     stopping as soon as it grows past its declared size or the cap — a
//     25 MB part hidden in a 26 KB file (a "zip bomb") is refused before it
//     is decompressed, or after its first slice when the archive understates
//     its size, not after it has filled memory;
//   - anything keyed by the file's own content lives in a Map, so a sheet or
//     an attribute named "__proto__" is just a name.

export type XlsxCellValue = string | number | boolean | null;

export interface XlsxRow {
  /** The row's own number, as Excel shows it (1-based). */
  rowNumber: number;
  /**
   * The row's cells by column, A = 0, up to its last non-empty cell. An empty
   * cell (missing, self-closing, or an empty string) is null. Text is as the
   * file holds it — not trimmed.
   */
  cells: XlsxCellValue[];
}

export interface XlsxSheet {
  /** The name of the sheet that was read. */
  name: string;
  /** True when `sheetName` was asked for, not found, and the first sheet was read instead. */
  isFallback: boolean;
  /** Only the rows with at least one non-empty cell, in the file's order. */
  rows: XlsxRow[];
}

export interface ReadXlsxOptions {
  /** The sheet to read, by its tab name. Falls back to the first sheet. */
  sheetName?: string;
  /** Bytes the whole read may decompress, across every part it opens. */
  maxUncompressedBytes?: number;
  /** Entries the archive may list at all. */
  maxEntries?: number;
  /** Non-empty rows the sheet may hold. */
  maxRows?: number;
  /** Columns read per row (A..); cells further right are ignored. */
  maxColumns?: number;
}

export type XlsxErrorCode =
  /** Not a ZIP archive at all — a CSV or a text file with an .xlsx name. */
  | "not_zip"
  /** An OLE compound file: an old-format .xls, or a password-protected workbook. */
  | "legacy_or_encrypted"
  /** A ZIP entry encrypted with a ZIP password. */
  | "encrypted"
  | "zip64"
  | "unsupported_compression"
  /** Over one of the caps above. */
  | "too_large"
  /** Truncated, damaged, or lying about its own sizes. */
  | "corrupt"
  /** A ZIP, but not a workbook (a .docx, an .ods). */
  | "not_xlsx"
  | "no_sheets"
  /** No DecompressionStream("deflate-raw") here — an outdated browser. */
  | "unsupported_runtime";

export class XlsxError extends Error {
  readonly code: XlsxErrorCode;

  constructor(code: XlsxErrorCode, message: string) {
    super(message);
    this.name = "XlsxError";
    this.code = code;
  }
}

// 20 MB is a hundred times what a filled-in picking template decompresses to,
// and well inside what a phone's browser tab can hold twice over (the bytes,
// then the text decoded from them).
const DEFAULT_LIMITS = {
  maxUncompressedBytes: 20 * 1024 * 1024,
  maxEntries: 1000,
  maxRows: 10_000,
  maxColumns: 100,
} as const;

type Limits = { -readonly [Key in keyof typeof DEFAULT_LIMITS]: number };

const corrupt = (detail: string) => new XlsxError("corrupt", `The file is damaged: ${detail}.`);
const tooLarge = (detail: string) => new XlsxError("too_large", `The file is too large: ${detail}.`);

// ---------------------------------------------------------------------- ZIP

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const END_OF_DIRECTORY_SIZE = 22;
// General-purpose flags meaning "encrypted": traditional encryption, strong
// encryption, and an encrypted central directory.
const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;
// An OLE compound file's first eight bytes — the container of an old .xls,
// and also of a modern workbook saved with a password (Excel encrypts the
// whole ZIP and wraps it in one of these).
const COMPOUND_FILE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

interface ZipEntry {
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

// The End Of Central Directory record closes every ZIP: the archive's own
// index of where each entry is and how big it is. It sits in the last 22
// bytes, unless the archive carries a comment (up to 64 KB) after it — so
// search backwards over at most that much.
function findEndOfDirectory(bytes: Uint8Array, view: DataView): number {
  const last = bytes.length - END_OF_DIRECTORY_SIZE;
  const first = Math.max(0, last - 0xffff);
  for (let offset = last; offset >= first; offset--) {
    if (bytes[offset] !== 0x50 || view.getUint32(offset, true) !== END_OF_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + END_OF_DIRECTORY_SIZE + commentLength <= bytes.length) return offset;
  }
  return -1;
}

// Entry names as one map key each: forward slashes, no leading slash, lower
// case — part names in an Office file are case-insensitive, and the paths a
// relationship names are compared against these.
function entryKey(name: string): string {
  return name.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
}

function readCentralDirectory(bytes: Uint8Array, limits: Limits): Map<string, ZipEntry> {
  if (startsWithBytes(bytes, COMPOUND_FILE_SIGNATURE)) {
    throw new XlsxError(
      "legacy_or_encrypted",
      "This is an old-format .xls workbook or a password-protected one, not an .xlsx.",
    );
  }
  if (bytes.length < END_OF_DIRECTORY_SIZE) throw new XlsxError("not_zip", "The file is not a ZIP archive.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfDirectory(bytes, view);
  if (end === -1) throw new XlsxError("not_zip", "The file is not a ZIP archive.");

  const disk = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const entriesOnDisk = view.getUint16(end + 8, true);
  const totalEntries = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);

  // ZIP64 marks its fields with all-ones and adds a locator just before this
  // record. Refused rather than supported: it exists for archives past 4 GB or
  // 65,535 entries, which no workbook this screen reads comes near.
  if (
    totalEntries === 0xffff ||
    entriesOnDisk === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    (end >= 20 && view.getUint32(end - 20, true) === ZIP64_LOCATOR_SIGNATURE)
  ) {
    throw new XlsxError("zip64", "ZIP64 archives are not supported.");
  }
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw corrupt("a multi-part archive");
  }
  if (totalEntries > limits.maxEntries) {
    throw tooLarge(`${totalEntries} entries, over the ${limits.maxEntries} allowed`);
  }
  if (directoryOffset + directorySize > end) throw corrupt("the directory runs past its end");

  const names = new TextDecoder("utf-8");
  const entries = new Map<string, ZipEntry>();
  let offset = directoryOffset;
  for (let index = 0; index < totalEntries; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw corrupt("a directory entry is missing");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > end) throw corrupt("a directory entry runs past its end");
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new XlsxError("zip64", "ZIP64 archives are not supported.");
    }
    if (flags & ENCRYPTION_FLAGS) {
      throw new XlsxError("encrypted", "The archive is encrypted.");
    }
    const name = names.decode(bytes.subarray(offset + 46, nameEnd));
    if (!name.endsWith("/")) {
      const key = entryKey(name);
      // Two entries under one name would leave "which one is the sheet?" to
      // whichever this reader happened to keep — refused instead of guessed.
      if (entries.has(key)) throw corrupt(`"${name}" appears twice`);
      entries.set(key, { method, crc32, compressedSize, uncompressedSize, localHeaderOffset });
    }
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc = crcTable[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// How much compressed data the decompressor is given at a time. The
// Compression Streams standard decompresses each chunk written to it in full
// before it hands on any of the output, and deflate expands up to about a
// thousandfold: an entry written as one chunk (as a Blob's stream may well
// deliver it) could reach gigabytes from a 2 MB file before a single size
// check below ran. A 16 KB slice yields at most about 16 MB, and the checks
// run between slices.
const INFLATE_SLICE_BYTES = 16 * 1024;

// Deflate, through the platform's own decompressor, fed a slice at a time
// while its output is read, so it can stop early: past `limit` (what is left
// of the read's budget) or past what the archive SAID this entry holds, the
// rest is never decompressed.
async function inflateRaw(
  compressed: Uint8Array<ArrayBuffer>,
  declaredSize: number,
  limit: number,
): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new XlsxError("unsupported_runtime", "This browser cannot decompress ZIP entries.");
  }
  let stream: DecompressionStream;
  try {
    stream = new DecompressionStream("deflate-raw");
  } catch {
    // A browser with DecompressionStream but without its "deflate-raw" format.
    throw new XlsxError("unsupported_runtime", "This browser cannot decompress ZIP entries.");
  }
  // Written alongside the reads below, not before them: a slice is only
  // decompressed once the output ahead of it has been read, so a write waits
  // on the reads. Whatever stops the writing (damaged data, the reads below
  // giving up) errors the output side too, which is where it is reported.
  const writer = stream.writable.getWriter();
  void (async () => {
    for (let offset = 0; offset < compressed.byteLength; offset += INFLATE_SLICE_BYTES) {
      await writer.write(compressed.subarray(offset, offset + INFLATE_SLICE_BYTES));
    }
    await writer.close();
  })().catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit || total > declaredSize) {
        reader.cancel().catch(() => undefined);
        throw total > limit
          ? tooLarge("it decompresses past the size allowed")
          : corrupt("an entry is larger than the archive says");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    throw corrupt("an entry could not be decompressed");
  }
  if (total !== declaredSize) throw corrupt("an entry is smaller than the archive says");
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

interface Archive {
  has(path: string): boolean;
  /** The part's text, or null when the archive has no such part. */
  readText(path: string): Promise<string | null>;
}

function openArchive(bytes: Uint8Array, limits: Limits): Archive {
  const entries = readCentralDirectory(bytes, limits);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let budget = limits.maxUncompressedBytes;

  // A relationship may name a part percent-encoded (it is a URI) while the
  // archive lists it plain, so both spellings are tried.
  function find(path: string): ZipEntry | undefined {
    const direct = entries.get(entryKey(path));
    if (direct) return direct;
    try {
      return entries.get(entryKey(decodeURIComponent(path)));
    } catch {
      return undefined;
    }
  }

  async function readBytes(entry: ZipEntry): Promise<Uint8Array> {
    // Checked before any work: an entry that admits to being too big is
    // refused without decompressing a byte of it.
    if (entry.uncompressedSize > budget) {
      throw tooLarge(`a part decompresses to ${entry.uncompressedSize} bytes`);
    }
    const header = entry.localHeaderOffset;
    if (header + 30 > bytes.length || view.getUint32(header, true) !== LOCAL_HEADER_SIGNATURE) {
      throw corrupt("an entry's header is missing");
    }
    // The sizes come from the central directory, not from this local header:
    // a writer that streams (flag bit 3) leaves the local copy zeroed.
    const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
    const end = start + entry.compressedSize;
    if (end > bytes.length) throw corrupt("an entry runs past the end of the file");

    let output: Uint8Array;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) throw corrupt("a stored entry's sizes disagree");
      output = bytes.subarray(start, end);
    } else if (entry.method === 8) {
      output = await inflateRaw(bytes.slice(start, end), entry.uncompressedSize, budget);
    } else {
      throw new XlsxError("unsupported_compression", `ZIP compression method ${entry.method} is not supported.`);
    }
    if (crc32(output) !== entry.crc32) throw corrupt("an entry's checksum does not match");
    budget -= output.byteLength;
    return output;
  }

  return {
    has: (path) => find(path) !== undefined,
    async readText(path) {
      const entry = find(path);
      if (!entry) return null;
      return decodeText(await readBytes(entry));
    },
  };
}

// UTF-8, which is what every spreadsheet program writes — with UTF-16 honoured
// when a part opens with its byte-order mark, as the XML spec allows.
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  // TextDecoder drops a UTF-8 byte-order mark by itself.
  return new TextDecoder("utf-8").decode(bytes);
}

// ---------------------------------------------------------------------- XML

// A deliberately small, forward-only tokenizer: start tags (with their
// attributes), end tags and text, in document order, with comments,
// processing instructions and DOCTYPE skipped and CDATA passed through as
// text. Each step finds its next landmark with indexOf from where the last
// one ended, and the two lookups that could otherwise run on past it (a
// declaration's `[`, an entity's `;`) look only a short way ahead — so a
// hostile file can make it slow only in proportion to its size, and there is
// no backtracking regex here to blow up. Element and attribute names keep
// their namespace prefix off (`x:c` is `c`): Excel writes no prefixes, but
// other generators prefix every element.
//
// It does not expand entities a DOCTYPE declares — the classic way an XML
// parser is made to swallow gigabytes — only XML's five predefined ones and
// numeric character references.
interface XmlVisitor {
  open?(name: string, attributes: ReadonlyMap<string, string>): void;
  close?(name: string): void;
  text?(value: string): void;
}

const malformed = () => corrupt("a part is not well-formed XML");

function localName(qualified: string): string {
  const colon = qualified.indexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function skipWhitespace(xml: string, index: number): number {
  while (index < xml.length && isWhitespace(xml.charCodeAt(index))) index++;
  return index;
}

// `<!DOCTYPE ...>`, including an internal subset in brackets, which may itself
// contain `>`. Only a `[` before the declaration's first `>` can open that
// subset, so that is as far as one is looked for: searched for to the end of
// the part instead, a part holding nothing but `<!x>` would cost a scan to its
// end for every one of them (a 3 KB file took 11 seconds).
function skipDeclaration(xml: string, start: number): number {
  const close = xml.indexOf(">", start);
  if (close === -1) throw malformed();
  for (let index = start; index < close; index++) {
    if (xml.charCodeAt(index) !== 0x5b /* [ */) continue;
    const subsetEnd = xml.indexOf("]", index);
    const end = subsetEnd === -1 ? -1 : xml.indexOf(">", subsetEnd);
    if (end === -1) throw malformed();
    return end + 1;
  }
  return close + 1;
}

function readStartTag(xml: string, start: number, visitor: XmlVisitor): number {
  let index = start + 1;
  while (index < xml.length) {
    const code = xml.charCodeAt(index);
    if (isWhitespace(code) || code === 0x2f /* / */ || code === 0x3e /* > */) break;
    index++;
  }
  const name = localName(xml.slice(start + 1, index));
  if (name === "") throw malformed();
  const attributes = new Map<string, string>();
  for (;;) {
    index = skipWhitespace(xml, index);
    if (index >= xml.length) throw malformed();
    const code = xml.charCodeAt(index);
    if (code === 0x3e /* > */) {
      visitor.open?.(name, attributes);
      return index + 1;
    }
    if (code === 0x2f /* / */) {
      if (xml.charCodeAt(index + 1) !== 0x3e) throw malformed();
      // Self-closing: reported as an open immediately followed by its close,
      // so a visitor sees `<c/>` and `<c></c>` the same way.
      visitor.open?.(name, attributes);
      visitor.close?.(name);
      return index + 2;
    }
    const attributeStart = index;
    while (index < xml.length) {
      const next = xml.charCodeAt(index);
      if (isWhitespace(next) || next === 0x3d /* = */ || next === 0x2f || next === 0x3e) break;
      index++;
    }
    const attributeName = xml.slice(attributeStart, index);
    index = skipWhitespace(xml, index);
    if (attributeName === "" || xml.charCodeAt(index) !== 0x3d) throw malformed();
    index = skipWhitespace(xml, index + 1);
    const quote = xml[index];
    if (quote !== '"' && quote !== "'") throw malformed();
    const valueEnd = xml.indexOf(quote, index + 1);
    if (valueEnd === -1) throw malformed();
    attributes.set(attributeName, decodeEntities(xml.slice(index + 1, valueEnd)));
    index = valueEnd + 1;
  }
}

function scanXml(xml: string, visitor: XmlVisitor): void {
  let index = 0;
  while (index < xml.length) {
    const lt = xml.indexOf("<", index);
    const textEnd = lt === -1 ? xml.length : lt;
    if (textEnd > index) visitor.text?.(decodeEntities(xml.slice(index, textEnd)));
    if (lt === -1) return;

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw malformed();
      index = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw malformed();
      visitor.text?.(xml.slice(lt + 9, end));
      index = end + 3;
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw malformed();
      index = end + 2;
    } else if (xml.startsWith("<!", lt)) {
      index = skipDeclaration(xml, lt);
    } else if (xml.charCodeAt(lt + 1) === 0x2f /* / */) {
      const end = xml.indexOf(">", lt + 2);
      if (end === -1) throw malformed();
      visitor.close?.(localName(xml.slice(lt + 2, end).trim()));
      index = end + 1;
    } else {
      index = readStartTag(xml, lt, visitor);
    }
  }
}

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

// The characters XML allows; a reference to anything else is left as written.
function isXmlCharacter(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

// An entity's body is at most a few characters, so its `;` is looked for only
// this far past the `&` — and never past another `&`, which no entity holds.
// Searched for wherever it is instead, a text of bare ampersands (or of
// `&&&…&;`) would cost a scan to the end, or to that far `;`, for each one.
const MAX_ENTITY_LENGTH = 32;

// The `;` closing the entity that starts at `amp`, or -1 when none can.
function entityEnd(text: string, amp: number): number {
  const limit = Math.min(text.length, amp + 1 + MAX_ENTITY_LENGTH);
  for (let index = amp + 1; index < limit; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x3b /* ; */) return index;
    if (code === 0x26 /* & */) return -1;
  }
  return -1;
}

function decodeEntities(text: string): string {
  let amp = text.indexOf("&");
  if (amp === -1) return text;
  let output = "";
  let copied = 0;
  while (amp !== -1) {
    const semicolon = entityEnd(text, amp);
    let decoded: string | undefined;
    if (semicolon !== -1) {
      const body = text.slice(amp + 1, semicolon);
      if (body.startsWith("#x") || body.startsWith("#X")) {
        decoded = fromCodePoint(body.slice(2), 16);
      } else if (body.startsWith("#")) {
        decoded = fromCodePoint(body.slice(1), 10);
      } else {
        decoded = NAMED_ENTITIES.get(body);
      }
    }
    if (decoded === undefined) {
      amp = text.indexOf("&", amp + 1);
      continue;
    }
    output += text.slice(copied, amp) + decoded;
    copied = semicolon + 1;
    amp = text.indexOf("&", copied);
  }
  return output + text.slice(copied);
}

function fromCodePoint(digits: string, radix: 10 | 16): string | undefined {
  if (digits === "" || !(radix === 16 ? /^[0-9a-f]+$/i : /^[0-9]+$/).test(digits)) return undefined;
  const codePoint = Number.parseInt(digits, radix);
  return isXmlCharacter(codePoint) ? String.fromCodePoint(codePoint) : undefined;
}

// Excel's own escape for characters XML cannot carry (a carriage return
// becomes `_x000D_`), applied to cell text on top of XML's.
function decodeOfficeEscapes(text: string): string {
  if (!text.includes("_x")) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

// ------------------------------------------------------------ workbook parts

interface Relationship {
  type: string;
  target: string;
}

function readRelationships(xml: string): Map<string, Relationship> {
  const relationships = new Map<string, Relationship>();
  scanXml(xml, {
    open(name, attributes) {
      if (name !== "Relationship" || attributes.get("TargetMode") === "External") return;
      const id = attributes.get("Id");
      const target = attributes.get("Target");
      if (id !== undefined && target !== undefined) {
        relationships.set(id, { type: attributes.get("Type") ?? "", target });
      }
    },
  });
  return relationships;
}

// Where a part's relationships live: xl/workbook.xml -> xl/_rels/workbook.xml.rels.
function relationshipsPathOf(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  return `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
}

// A relationship's target, as a path inside the archive. Relative to the
// folder of the part that declares it ("worksheets/sheet1.xml" from
// xl/workbook.xml), or absolute from the archive's root when it starts with a
// slash, as openpyxl writes them ("/xl/worksheets/sheet1.xml").
function resolveTarget(fromPart: string, target: string): string {
  const normalized = target.replaceAll("\\", "/");
  const base = normalized.startsWith("/") ? "" : fromPart.slice(0, fromPart.lastIndexOf("/") + 1);
  const segments: string[] = [];
  for (const segment of `${base}${normalized}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

interface SheetEntry {
  name: string;
  path: string;
  hidden: boolean;
}

function readWorkbookSheets(
  xml: string,
  workbookPath: string,
  relationships: ReadonlyMap<string, Relationship>,
): SheetEntry[] {
  const sheets: SheetEntry[] = [];
  let inSheets = false;
  scanXml(xml, {
    open(name, attributes) {
      if (name === "sheets") inSheets = true;
      if (name !== "sheet" || !inSheets) return;
      const sheetName = attributes.get("name");
      // The relationship id is `r:id`, under whatever prefix the file bound
      // the relationships namespace to.
      let relationshipId: string | undefined;
      for (const [attribute, value] of attributes) {
        if (attribute.endsWith(":id")) relationshipId = value;
      }
      const relationship = relationshipId === undefined ? undefined : relationships.get(relationshipId);
      // Worksheets only: a chart sheet in the tab strip has no cells to read.
      if (sheetName === undefined || !relationship || !relationship.type.endsWith("/worksheet")) return;
      sheets.push({
        name: sheetName,
        path: resolveTarget(workbookPath, relationship.target),
        hidden: (attributes.get("state") ?? "visible") !== "visible",
      });
    },
    close(name) {
      if (name === "sheets") inSheets = false;
    },
  });
  return sheets;
}

// Shared strings: every distinct text in the workbook, listed once, that a
// cell of type "s" points to by its index. An entry is plain (<t>) or rich
// text — runs (<r><t>) whose texts join into one. Phonetic runs (<rPh>, the
// reading aid for Japanese text) are not part of the text.
function readSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  let current: string | null = null;
  let phoneticDepth = 0;
  let capturing = false;
  scanXml(xml, {
    open(name) {
      if (name === "si") {
        current = "";
        phoneticDepth = 0;
      } else if (name === "rPh") {
        phoneticDepth++;
      } else if (name === "t") {
        capturing = current !== null && phoneticDepth === 0;
      }
    },
    close(name) {
      if (name === "si") {
        strings.push(decodeOfficeEscapes(current ?? ""));
        current = null;
      } else if (name === "rPh") {
        phoneticDepth = Math.max(0, phoneticDepth - 1);
      } else if (name === "t") {
        capturing = false;
      }
    },
    text(value) {
      if (capturing && current !== null) current += value;
    },
  });
  return strings;
}

// "B12" -> 1. Letters only; null for a reference without any.
function columnOf(reference: string): number | null {
  let column = 0;
  let letters = 0;
  for (; letters < reference.length && letters < 4; letters++) {
    const code = reference.charCodeAt(letters) | 0x20; // lower-cased
    if (code < 0x61 || code > 0x7a) break;
    column = column * 26 + (code - 0x60);
  }
  return letters === 0 || letters > 3 ? null : column - 1;
}

function cellValue(
  type: string,
  value: string | null,
  inlineText: string | null,
  sharedStrings: readonly string[],
): XlsxCellValue {
  // An inline string (<is>) is the cell's text whatever its type says.
  if (inlineText !== null) return decodeOfficeEscapes(inlineText);
  if (value === null) return null;
  switch (type) {
    case "s": {
      const index = Number(value.trim());
      return Number.isInteger(index) ? (sharedStrings[index] ?? null) : null;
    }
    // A formula's text result, cached by the program that last calculated it.
    case "str":
      return decodeOfficeEscapes(value);
    case "inlineStr":
      return null;
    case "b": {
      const flag = value.trim().toLowerCase();
      return flag === "1" || flag === "true" ? true : flag === "0" || flag === "false" ? false : null;
    }
    // An error ("#N/A") or an ISO date: the text, as written.
    case "e":
    case "d":
      return value;
    default: {
      const trimmed = value.trim();
      if (trimmed === "") return null;
      const number = Number(trimmed);
      return Number.isFinite(number) ? number : trimmed;
    }
  }
}

function readSheetRows(xml: string, sharedStrings: readonly string[], limits: Limits): XlsxRow[] {
  const rows: XlsxRow[] = [];
  let inSheetData = false;
  let rowNumber = 0;
  let rowCells: Map<number, XlsxCellValue> | null = null;
  let lastColumn = -1;

  // The cell being read.
  let cellColumn: number | null = null;
  let cellType = "n";
  let value: string | null = null;
  let inlineText: string | null = null;
  let capture: "value" | "inline" | null = null;
  let inInline = false;
  let phoneticDepth = 0;

  scanXml(xml, {
    open(name, attributes) {
      if (name === "sheetData") {
        inSheetData = true;
        return;
      }
      if (!inSheetData) return;
      if (name === "row") {
        const declared = Number(attributes.get("r"));
        rowNumber = Number.isInteger(declared) && declared > 0 ? declared : rowNumber + 1;
        rowCells = new Map();
        lastColumn = -1;
      } else if (name === "c" && rowCells) {
        const reference = attributes.get("r");
        const column = reference === undefined ? null : columnOf(reference);
        cellColumn = column ?? lastColumn + 1;
        lastColumn = cellColumn;
        cellType = attributes.get("t") ?? "n";
        value = null;
        inlineText = null;
        inInline = false;
        phoneticDepth = 0;
      } else if (cellColumn !== null) {
        if (name === "v") {
          value = "";
          capture = "value";
        } else if (name === "is") {
          inInline = true;
          inlineText = "";
        } else if (name === "rPh") {
          phoneticDepth++;
        } else if (name === "t" && inInline && phoneticDepth === 0) {
          capture = "inline";
        }
      }
    },
    close(name) {
      if (name === "sheetData") {
        inSheetData = false;
      } else if (name === "v" || name === "t") {
        capture = null;
      } else if (name === "rPh") {
        phoneticDepth = Math.max(0, phoneticDepth - 1);
      } else if (name === "is") {
        inInline = false;
      } else if (name === "c" && cellColumn !== null && rowCells) {
        const cell = cellValue(cellType, value, inlineText, sharedStrings);
        if (cell !== null && cell !== "" && cellColumn < limits.maxColumns) rowCells.set(cellColumn, cell);
        cellColumn = null;
        capture = null;
      } else if (name === "row" && rowCells) {
        if (rowCells.size > 0) {
          if (rows.length >= limits.maxRows) {
            throw tooLarge(`more than ${limits.maxRows} rows`);
          }
          const width = Math.max(...rowCells.keys()) + 1;
          const cells = rowCells;
          rows.push({ rowNumber, cells: Array.from({ length: width }, (_, column) => cells.get(column) ?? null) });
        }
        rowCells = null;
      }
    },
    text(text) {
      if (capture === "value" && value !== null) value += text;
      else if (capture === "inline" && inlineText !== null) inlineText += text;
    },
  });
  return rows;
}

function sameSheetName(a: string, b: string): boolean {
  const normalize = (name: string) => name.normalize("NFC").trim().toLowerCase();
  return normalize(a) === normalize(b);
}

// --------------------------------------------------------------------- read

export async function readXlsxSheet(
  data: ArrayBuffer | Uint8Array,
  options: ReadXlsxOptions = {},
): Promise<XlsxSheet> {
  const limits: Limits = {
    maxUncompressedBytes: options.maxUncompressedBytes ?? DEFAULT_LIMITS.maxUncompressedBytes,
    maxEntries: options.maxEntries ?? DEFAULT_LIMITS.maxEntries,
    maxRows: options.maxRows ?? DEFAULT_LIMITS.maxRows,
    maxColumns: options.maxColumns ?? DEFAULT_LIMITS.maxColumns,
  };
  const archive = openArchive(data instanceof Uint8Array ? data : new Uint8Array(data), limits);

  // The package's own relationships name the workbook part; every program
  // calls it xl/workbook.xml, which is the fallback when they don't say.
  const packageRelationships = await archive.readText("_rels/.rels");
  let workbookPath = "xl/workbook.xml";
  if (packageRelationships !== null) {
    for (const relationship of readRelationships(packageRelationships).values()) {
      if (relationship.type.endsWith("/officeDocument")) {
        workbookPath = resolveTarget("", relationship.target);
        break;
      }
    }
  }
  const workbook = await archive.readText(workbookPath);
  if (workbook === null) throw new XlsxError("not_xlsx", "The archive holds no workbook.");
  const workbookRelationshipsXml = await archive.readText(relationshipsPathOf(workbookPath));
  const relationships = workbookRelationshipsXml === null ? new Map<string, Relationship>() : readRelationships(workbookRelationshipsXml);

  const sheets = readWorkbookSheets(workbook, workbookPath, relationships);
  // "The first sheet" is the first tab a person can see: a hidden sheet ahead
  // of it is not the one they filled in.
  const firstSheet = sheets.find((sheet) => !sheet.hidden) ?? sheets[0];
  if (!firstSheet) throw new XlsxError("no_sheets", "The workbook has no worksheets.");
  const { sheetName } = options;
  const named = sheetName === undefined ? undefined : sheets.find((sheet) => sameSheetName(sheet.name, sheetName));
  const sheet = named ?? firstSheet;

  let sharedStringsPath = resolveTarget(workbookPath, "sharedStrings.xml");
  for (const relationship of relationships.values()) {
    if (relationship.type.endsWith("/sharedStrings")) {
      sharedStringsPath = resolveTarget(workbookPath, relationship.target);
      break;
    }
  }
  const sharedStringsXml = archive.has(sharedStringsPath) ? await archive.readText(sharedStringsPath) : null;
  const sharedStrings = sharedStringsXml === null ? [] : readSharedStrings(sharedStringsXml);

  const sheetXml = await archive.readText(sheet.path);
  if (sheetXml === null) throw corrupt(`the sheet "${sheet.name}" is missing`);
  return {
    name: sheet.name,
    isFallback: sheetName !== undefined && named === undefined,
    rows: readSheetRows(sheetXml, sharedStrings, limits),
  };
}

// The customer's preferred grower (workbook Task 36) — kept as words in the
// product line's own comment, and nowhere else: "מגדל מועדף: <name>", beside
// whatever else the comment says, joined with " · ". The rules it was built
// to (2026-11-11): other text in the comment is kept; choosing again replaces
// the earlier preference; "ללא העדפה" removes it; and the comment stays free
// text the customer may go on editing by hand. Nothing in the app or the
// database reads it back to act on it — the distributor reads it, where line
// comments already show on the arrangement board — so allocation cannot
// change with it (arrangement-engine-input.test.ts holds that).
//
// So the rules here are only about the text: find the preference again in
// whatever the comment has become, and change it without disturbing the
// rest. The hard part is where the name ends. The comment box is one plain
// line, and a customer adding to "מגדל מועדף: משק כהן" types ", בבוקר" or
// " בבוקר" far sooner than " · בבוקר" — words that a rule of "the name runs
// to the next ·" took for part of the name, so the next choice deleted them.
// So the name is matched against today's growers, the very names the chooser
// offers and writes: the label, its colon, then one of those names (in any
// spacing, the longest first), and whatever follows the name is the
// customer's own. Wherever it stands, too: "דחוף, מגדל מועדף: משק כהן" is
// still the preference, and choosing again replaces it rather than adding a
// second.
//
// A name that is not among today's (that grower has nothing left, say) can
// only be guessed at: it runs to the next comma, semicolon or spaced dash.
// And only where the label starts the comment or a clause of it, not where a
// sentence merely mentions the words: "בלי מגדל מועדף: כל אחד בסדר" is the
// customer's own, and is left alone.

export const PREFERRED_GROWER_LABEL = "מגדל מועדף";

const SEPARATOR = " · ";

// The label and its colon, in any spacing: the customer may have retyped it.
const LABEL = /מגדל\s+מועדף\s*:/gu;

// What a word is made of — letters, the marks on them, digits. A label right
// after one ("למגדל מועדף:") or a name running on into one ("משק כהנים" is
// not "משק כהן") belongs to some other word.
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

// The text before a label that starts a clause: nothing, or a mark that ends
// one, then any spacing.
const CLAUSE_START = /(?:^|[,;:.!?–—-])\s*$/u;

// Where a guessed name ends (see the top of the file). A dash only with a
// space before it: "כהן-לוי" is one name.
const GUESSED_NAME_END = /[,;\n]|\s[–—-](?=\s|$)/u;

// A preference found in one "·" part: from the label to the end of the name.
interface Preference {
  start: number;
  end: number;
  // The grower it names — as written in today's growers when it is one of
  // them, else as guessed — or "" for the label with nothing after it.
  name: string;
}

interface Option {
  name: string;
  // The name in any spacing, tried exactly where a label ends (sticky), and
  // only when it does not run on into a longer word.
  matcher: RegExp;
}

function parts(comment: string): string[] {
  return comment
    .split("·")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

// A grower's name as it is written into a comment and compared: single
// spaces, and no "·" — inside a name it would split the preference in two
// the next time the comment is read.
export function cleanGrowerName(name: string): string {
  return name.replace(/·/g, " ").replace(/\s+/g, " ").trim();
}

// Today's growers, the longest name first, so "משק כהן ובניו" is found whole
// rather than as "משק כהן" followed by the customer's own "ובניו".
function optionsOf(growers: readonly string[]): Option[] {
  return growers
    .map((name) => ({ name, clean: cleanGrowerName(name) }))
    .filter(({ clean }) => clean !== "")
    .sort((a, b) => b.clean.length - a.clean.length)
    .map(({ name, clean }) => {
      const words = clean.split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      return {
        name,
        matcher: new RegExp(`\\s*${words.join("\\s+")}(?![\\p{L}\\p{M}\\p{N}])`, "uy"),
      };
    });
}

function preferencesIn(part: string, options: readonly Option[]): Preference[] {
  const found: Preference[] = [];
  for (const label of part.matchAll(LABEL)) {
    const start = label.index;
    // Inside the name found before it, or the end of a longer word.
    if (start < (found.at(-1)?.end ?? 0)) continue;
    if (WORD_CHAR.test(part.charAt(start - 1))) continue;
    const afterLabel = start + label[0].length;
    const known = options.find(({ matcher }) => {
      matcher.lastIndex = afterLabel;
      return matcher.test(part);
    });
    if (known) {
      found.push({ start, end: known.matcher.lastIndex, name: known.name });
    } else if (CLAUSE_START.test(part.slice(0, start))) {
      const rest = part.slice(afterLabel);
      const stop = rest.search(GUESSED_NAME_END);
      const guess = (stop === -1 ? rest : rest.slice(0, stop)).trimEnd();
      found.push({ start, end: afterLabel + guess.length, name: cleanGrowerName(guess) });
    }
  }
  return found;
}

function scan(comment: string, growers: readonly string[]) {
  const options = optionsOf(growers);
  return parts(comment).map((text) => ({ text, found: preferencesIn(text, options) }));
}

// The two sides of a preference taken out of a part, joined. The customer's
// own mark before it stays and the one after it goes ("דחוף, מגדל מועדף: X,
// בבוקר" leaves "דחוף, בבוקר"); with nothing after it, the mark before it
// goes too ("דחוף, מגדל מועדף: X" leaves "דחוף").
function joinAround(before: string, after: string): string {
  const rest = after.replace(/^[\s,;.–—-]+/u, "");
  if (rest === "") return before.replace(/[\s,;–—-]+$/u, "");
  const kept = before.trimEnd();
  return kept === "" ? rest : `${kept} ${rest}`;
}

// A part with each preference in it replaced by what `replace` gives for it,
// or taken out where that is null. Everything around them is left as typed.
function rewrite(
  text: string,
  found: readonly Preference[],
  replace: (preference: Preference) => string | null,
): string {
  const pieces: string[] = [];
  let piece = "";
  let cursor = 0;
  for (const preference of found) {
    const replacement = replace(preference);
    piece += text.slice(cursor, preference.start);
    if (replacement === null) {
      pieces.push(piece);
      piece = "";
    } else {
      piece += replacement;
    }
    cursor = preference.end;
  }
  pieces.push(piece + text.slice(cursor));
  return pieces.reduce(joinAround);
}

// The grower the comment names as preferred, or null when it names none.
// `growers` are today's (the chooser's options), which is what tells the
// name apart from the customer's own words after it.
export function readPreferredGrower(comment: string, growers: readonly string[]): string | null {
  for (const { found } of scan(comment, growers)) {
    const named = found.find((preference) => preference.name !== "");
    if (named) return named.name;
  }
  return null;
}

// The comment with `growerName` as its preferred grower: an earlier
// preference is replaced where it stood (and any second one dropped), or the
// preference is added after the rest. Doing it twice changes nothing more.
export function setPreferredGrower(
  comment: string,
  growerName: string,
  growers: readonly string[],
): string {
  const name = cleanGrowerName(growerName);
  if (!name) return clearPreferredGrower(comment, growers);
  const preference = `${PREFERRED_GROWER_LABEL}: ${name}`;
  const scanned = scan(comment, growers);
  const first = scanned.find(({ found }) => found.length > 0)?.found[0];
  const next = scanned.map(({ text, found }) =>
    rewrite(text, found, (each) => (each === first ? preference : null)),
  );
  if (!first) next.push(preference);
  return next.filter((part) => part !== "").join(SEPARATOR);
}

// The comment without a preferred grower ("ללא העדפה"). A comment that names
// none comes back exactly as it was, so choosing "ללא העדפה" on it is not an
// edit at all.
export function clearPreferredGrower(comment: string, growers: readonly string[]): string {
  const scanned = scan(comment, growers);
  if (scanned.every(({ found }) => found.length === 0)) return comment;
  return scanned
    .map(({ text, found }) => rewrite(text, found, () => null))
    .filter((part) => part !== "")
    .join(SEPARATOR);
}

// What the chooser starts on: the grower the comment already names, when they
// are one of today's options; null ("ללא העדפה") when it names none; and
// undefined — nothing chosen yet — when it names a grower who is not among
// them (no longer in stock, say).
export function initialGrowerChoice(
  comment: string,
  growers: readonly string[],
): string | null | undefined {
  const current = readPreferredGrower(comment, growers);
  if (current === null) return null;
  const wanted = cleanGrowerName(current);
  return growers.find((name) => cleanGrowerName(name) === wanted);
}

// get_variety_growers_for_customer's rows (migration 0095) as the order
// screen uses them: each variety's grower names, sorted as Hebrew is, each
// once. Only varieties with two or more are kept — the server sends no
// others, and a single name would offer no choice anyway.
export function growersByVariety(
  rows: ReadonlyArray<{ variety_id: string; grower_name: string }>,
): Map<string, string[]> {
  const names = new Map<string, Set<string>>();
  for (const row of rows) {
    const name = cleanGrowerName(row.grower_name);
    if (!name) continue;
    let set = names.get(row.variety_id);
    if (!set) {
      set = new Set();
      names.set(row.variety_id, set);
    }
    set.add(name);
  }
  const byVariety = new Map<string, string[]>();
  for (const [varietyId, set] of names) {
    if (set.size >= 2) byVariety.set(varietyId, [...set].sort((a, b) => a.localeCompare(b, "he")));
  }
  return byVariety;
}

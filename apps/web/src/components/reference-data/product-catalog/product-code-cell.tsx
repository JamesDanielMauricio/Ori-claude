import { RowIconButton } from "@/components/reference-data/record-table";
import { useToast } from "@/components/ui/toast";

// A variety's product code — its id — as the products table shows it, with
// a button that copies it. The code is what a file's "קוד מוצר" column names
// a product by in the "בשם מגדל" picking upload (lib/picking-import.ts), so
// it is shown in full: a shortened one, copied by hand, would name nothing.
//
// Small and monospace, so 36 characters stay one compact line — and never
// wrapped at their hyphens. Set left to right in its own isolate (<bdi
// dir="ltr">, not direction marks, which a copy by hand would carry into the
// file), so the right-to-left table cannot reorder its groups. `select-all`,
// so one click selects the whole code for that copy by hand, which is the
// way left when the clipboard refuses the button.
//
// The button is the table's own row icon button: like edit and delete it
// sits on every row, and it stays live while a row is being edited, as
// copying changes nothing.
export function ProductCodeCell({ code }: { code: string }) {
  const { showToast } = useToast();
  return (
    <span className="flex items-center gap-1.5">
      <bdi dir="ltr" className="select-all whitespace-nowrap font-mono text-xs text-ink-muted">
        {code}
      </bdi>
      <RowIconButton
        icon="copy"
        label="העתקת קוד המוצר"
        tone="neutral"
        onClick={() => void copyProductCode(code, showToast)}
      />
    </span>
  );
}

type ShowToast = ReturnType<typeof useToast>["showToast"];

/** The copy button's work: the code to the clipboard, and a toast saying whether it got there. */
export async function copyProductCode(
  code: string,
  showToast: ShowToast,
  clipboard: Pick<Clipboard, "writeText"> | undefined = globalThis.navigator?.clipboard,
): Promise<void> {
  try {
    // No clipboard at all outside a secure context (plain http), and one
    // that refuses when the browser's permission says no.
    if (!clipboard) throw new Error("no clipboard");
    await clipboard.writeText(code);
    showToast("הקוד הועתק.", "success");
  } catch {
    showToast("לא ניתן היה להעתיק את הקוד. סמנו אותו והעתיקו ידנית.", "error");
  }
}

import { savePickLinesInputSchema, toSavePickLinesRpcArgs } from "@ori/domain/grower";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import {
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/error-message";
import {
  NO_HEADER_MESSAGE,
  PICK_UPLOAD_INSTRUCTIONS_SHEET,
  PICK_UPLOAD_TEMPLATE_URL,
  mostlyNotInPick,
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
} from "@/lib/picking-import";
import { fetchPickLines, growerQueries } from "@/lib/queries/grower";
import { fetchArrangedPalletsByLine } from "@/lib/queries/oversight";
import { submitPickIfStillDraft } from "@/lib/submit-pick-if-draft";
import { createClient } from "@/lib/supabase/client";
import { readXlsxSheet } from "@/lib/xlsx-reader";

export interface PickUploadTarget {
  pickId: string;
  growerName: string;
}

// The "בשם מגדל" picking upload (workbook Task 38): one grower's daily pick,
// filled in from Ori's own spreadsheet template instead of typed line by line
// into the pencil's editor. Opened from that grower's row, for that grower's
// pick on the open day — one file per grower, which is why the file has no
// grower column, and why the grower's name is what this dialog keeps saying:
// in its title, above the file, and beside the confirm button, with a warning
// when most of the file's products are not in this grower's pick. Those are
// the safeguard against a file uploaded on the wrong row.
//
// Nothing is written until the preview is confirmed. Choosing a file only
// reads it — in the browser (lib/xlsx-reader.ts), checked against the pick's
// lines and what is already arranged from them (lib/picking-import.ts holds
// every rule) — and shows what it would change, what it leaves alone, what it
// skips, and what has to be fixed first. Beside the file's name it shows the
// tab its numbers came from: the file's only visible one besides "הוראות",
// whatever it is called.
//
// Confirming saves the way the pencil's "שמור" does on this screen: one
// save_pick_lines call, then the pick is SENT if it is still a draft. The
// lines are read again first, so each line sent carries its leftover and
// comment as they are at that moment — save_pick_lines overwrites both on
// every line it is given.
export function PickUploadDialog({
  target,
  pickClosed,
  onClose,
  onSaved,
}: {
  target: PickUploadTarget | null;
  // The pick's live status, from the screen's own read of the day: a pick
  // closed (the arrangement board's truck) while this is open can no longer
  // be saved, so confirming is switched off with the reason, rather than
  // left to be refused.
  pickClosed: boolean;
  onClose: () => void;
  // After a save: the host re-reads the day's picks (the row's name turns
  // green once the pick is sent) and closes the dialog — if it is still open
  // on that pick. A save outlives the dialog when it is closed mid-save, and
  // by the time it lands another grower's upload may be the one open.
  onSaved: (pickId: string) => void;
}) {
  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={target ? `העלאת ליקוט — ${target.growerName}` : "העלאת ליקוט"}
      // The preview is a four-column table; at the default width it wraps.
      size="lg"
    >
      {/* Keyed by pick, so opening another grower's upload starts empty
          rather than showing the previous grower's file under the new name. */}
      {target && (
        <PickUploadForm
          key={target.pickId}
          target={target}
          pickClosed={pickClosed}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

type Stage =
  | { kind: "empty" }
  | { kind: "reading"; fileName: string }
  /** `sheetName`: the tab read, when the file got that far. */
  | { kind: "failed"; fileName: string; sheetName: string | null; message: string }
  | PreviewStage;

interface PreviewStage {
  kind: "preview";
  fileName: string;
  /** The tab the rows were read from, as the preview names it. */
  sheetName: string;
  /** The file's rows, kept so the plan can be made again over fresh lines. */
  rows: PickFileRow[];
  plan: PickImportPlan;
  /** Why the preview was replaced since the file was read, if it was. */
  notice: string | null;
}

const CHANGED_MEANWHILE =
  "הליקוט של המגדל השתנה מאז שהקובץ נקרא, ולכן התצוגה עודכנה ושום דבר עוד לא נשמר. בדקו אותה ואשרו שוב.";

function PickUploadForm({
  target,
  pickClosed,
  onClose,
  onSaved,
}: {
  target: PickUploadTarget;
  pickClosed: boolean;
  onClose: () => void;
  onSaved: (pickId: string) => void;
}) {
  const supabase = createClient();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const summaryId = useId();
  const [stage, setStage] = useState<Stage>({ kind: "empty" });
  const [saveError, setSaveError] = useState<string | null>(null);

  // Which file choice is the latest: reading one takes a moment, and a second
  // file chosen meanwhile must not be overtaken by the first one's result.
  const latestRead = useRef(0);

  // Still on screen? The dialog can be closed (Escape, ×) while a save is in
  // flight; its outcome then goes to a toast, since there is no dialog left
  // to show it in.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The plan, over the pick's lines and arranged pallets as they are right
  // now — read fresh every time, never from the cache.
  async function planNow(rows: PickFileRow[]) {
    const [pickLines, arranged] = await Promise.all([
      fetchPickLines(target.pickId),
      fetchArrangedPalletsByLine(target.pickId),
    ]);
    const lines = toImportLines(pickLines);
    return { lines, plan: planPickImport(rows, lines, arranged) };
  }

  async function readFile(file: File) {
    const read = ++latestRead.current;
    const isLatest = () => read === latestRead.current;
    setSaveError(null);

    const problem = pickFileProblem(file);
    if (problem) {
      setStage({ kind: "failed", fileName: file.name, sheetName: null, message: problem });
      return;
    }
    setStage({ kind: "reading", fileName: file.name });

    // Known once the tab is read, so a tab refused for its columns is named.
    let sheetName: string | null = null;
    let rows: PickFileRow[] | null;
    try {
      // The template's instructions are set aside; the one other visible tab
      // is read, whatever its name, and a file with more is refused.
      const sheet = await readXlsxSheet(new Uint8Array(await file.arrayBuffer()), {
        ignoreSheets: [PICK_UPLOAD_INSTRUCTIONS_SHEET],
      });
      sheetName = sheetLabel(sheet.name);
      rows = readPickFileRows(sheet);
    } catch (error) {
      if (isLatest()) {
        setStage({ kind: "failed", fileName: file.name, sheetName, message: pickFileReadErrorMessage(error) });
      }
      return;
    }
    if (!rows) {
      if (isLatest()) setStage({ kind: "failed", fileName: file.name, sheetName, message: NO_HEADER_MESSAGE });
      return;
    }

    try {
      const { plan } = await planNow(rows);
      if (isLatest()) setStage({ kind: "preview", fileName: file.name, sheetName, rows, plan, notice: null });
    } catch (error) {
      if (isLatest()) {
        setStage({
          kind: "failed",
          fileName: file.name,
          sheetName,
          message: `לא ניתן היה לקרוא את הליקוט של המגדל: ${errorMessage(error)}`,
        });
      }
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Emptied, so that choosing the same file again — after fixing it in
    // Excel — still counts as a change and is read again.
    event.target.value = "";
    if (file) void readFile(file);
  }

  const saveMutation = useMutation({
    mutationFn: async (preview: PreviewStage) => {
      // Fresh, at the moment of saving — not the lines the preview was read
      // from. save_pick_lines writes each line's leftover and comment back
      // along with its picked count, so a stale copy would undo a leftover or
      // comment someone changed while this was open.
      const { lines, plan } = await planNow(preview.rows);
      // Anything the preview didn't show (a line changed meanwhile, something
      // arranged meanwhile) is shown first, and nothing is saved.
      if (planChangedSince(preview.plan, plan)) return { kind: "review" as const, plan };

      const input = savePickLinesInputSchema.parse({
        dailyPickId: target.pickId,
        lines: toSavePickLines(plan, lines),
      });
      const { error } = await supabase.rpc("save_pick_lines", toSavePickLinesRpcArgs(input));
      if (error) throw error;
      // As the pencil's "שמור" on this screen: saving also sends a draft pick.
      return { kind: "saved" as const, submit: await submitPickIfStillDraft(supabase, target.pickId) };
    },
    // A previous attempt's failure no longer applies once this one starts.
    onMutate: () => setSaveError(null),
    onSuccess: (result, preview) => {
      if (result.kind === "review") {
        if (mounted.current) setStage({ ...preview, plan: result.plan, notice: CHANGED_MEANWHILE });
        else showToast("הקובץ לא נקלט: הליקוט של המגדל השתנה בינתיים. העלו אותו שוב.", "error");
        return;
      }
      const { submit } = result;
      if (submit.status === "failed") {
        // The lines did save. The pencil's "שמור" on a draft pick is the
        // retry: it sends the pick even with nothing left to change.
        showToast(
          `השורות נקלטו, אך שליחת הליקוט נכשלה: ${errorMessage(submit.error)}. פתחו את העיפרון ולחצו שמירה כדי לשלוח.`,
          "error",
        );
      } else {
        showToast(submit.status === "sent" ? "הליקוט נקלט ונשלח." : "הליקוט נקלט.", "success");
      }
      // The same refresh as the pencil's save: its own lines here, the day's
      // picks (and so the row's color) through the host.
      void queryClient.invalidateQueries({ queryKey: growerQueries.pickLines(target.pickId).queryKey });
      onSaved(target.pickId);
    },
    onError: (error, preview) => {
      const message = `הקליטה נכשלה: ${errorMessage(error)}`;
      // Shown in the dialog, not as a toast: toasts sit below the browser's
      // top layer, where a modal <dialog> lives, so one raised now would be
      // hidden behind the backdrop.
      if (!mounted.current) {
        showToast(message, "error");
        return;
      }
      setSaveError(message);
      // A refusal usually means the pick moved since the preview — most often
      // an arrangement made meanwhile (P0006), which the server reports
      // without saying which line. Re-planning names the row.
      void planNow(preview.rows).then(
        ({ plan }) => {
          if (!mounted.current) return;
          setStage((current) =>
            current.kind === "preview" && current.rows === preview.rows ? { ...current, plan } : current,
          );
        },
        () => undefined,
      );
    },
  });

  const saving = saveMutation.isPending;
  const plan = stage.kind === "preview" ? stage.plan : null;
  const fileName = stage.kind === "empty" ? null : stage.fileName;
  const sheetName = stage.kind === "preview" || stage.kind === "failed" ? stage.sheetName : null;
  const nothingToSave = plan !== null && plan.errors.length === 0 && plan.changes.length === 0;
  const readyToSave = plan !== null && plan.errors.length === 0 && plan.changes.length > 0 && !pickClosed;
  const canConfirm = readyToSave && !saving;

  return (
    <div className="flex flex-col gap-4">
      {/* The grower again, in the body: a title is easy to read past, and
          this is the one thing that must not be wrong. */}
      <p className="text-sm leading-relaxed text-ink-muted">
        הקובץ ייקלט לליקוט של <strong className="font-semibold text-ink">{target.growerName}</strong> ביום
        המסחר הפתוח. שום דבר לא נשמר לפני האישור, והעודף וההערות לא משתנים.
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={saving}
        >
          <Icon name="upload" className="h-3.5 w-3.5" />
          {fileName === null ? "בחירת קובץ" : "בחירת קובץ אחר"}
        </Button>
        {fileName !== null && (
          <span className="flex min-w-0 max-w-full flex-col">
            <bdi className="truncate text-sm font-medium text-ink">{fileName}</bdi>
            {/* Which tab the numbers come from, seen before confirming: the
                one visible tab besides the instructions is read, whatever
                it is called. */}
            {sheetName !== null && (
              <span className="truncate text-xs text-ink-muted">
                נקרא מהגיליון "<bdi className="font-medium text-ink">{sheetName}</bdi>"
              </span>
            )}
          </span>
        )}
        <a
          href={PICK_UPLOAD_TEMPLATE_URL}
          download="ori-picking-upload-template.xlsx"
          className="ms-auto inline-flex items-center gap-1.5 rounded-md text-sm font-semibold text-accent underline-offset-4 hover:underline"
        >
          <Icon name="download" className="h-4 w-4" />
          הורדת תבנית
        </a>
        {/* Opened by the button above. The dialog ignores the `cancel` event
            this input fires when its picker is dismissed (ui/dialog.tsx). */}
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {pickClosed && (
        <Alert>הליקוט סגור (סמל המשאית). פתחו אותו מחדש כדי להעלות קובץ.</Alert>
      )}

      {stage.kind === "reading" && (
        <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
          <span
            aria-hidden
            className="animate-spin-loop h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent"
          />
          קורא את הקובץ…
        </p>
      )}
      {stage.kind === "failed" && <Alert>{stage.message}</Alert>}
      {stage.kind === "preview" && (
        <>
          {stage.notice && <Notice>{stage.notice}</Notice>}
          {/* Another grower's file, most likely. It blocks nothing — a
              product the pick doesn't have never does — but every product
              the two growers share would be saved into this pick. */}
          {mostlyNotInPick(stage.plan) && (
            <Notice>
              רוב המוצרים בקובץ לא נמצאו בליקוט של{" "}
              <strong className="font-semibold">{target.growerName}</strong> — ייתכן שזה הקובץ של מגדל
              אחר. בדקו לפני האישור.
            </Notice>
          )}
          <PlanPreview plan={stage.plan} />
        </>
      )}
      {saveError && <Alert>{saveError}</Alert>}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        {nothingToSave && (
          <p className="me-auto text-sm font-medium text-ink-muted">אין שינויים לקליטה</p>
        )}
        {/* Where the decision is made, what confirming writes and into whose
            pick — and the confirm button's description, so a screen reader
            hears the grower's name with it too. */}
        {readyToSave && (
          <p id={summaryId} className="me-auto text-sm text-ink-muted">
            {count(plan.changes.length, "שינוי אחד ייקלט", (n) => `${n} שינויים ייקלטו`)} לליקוט של{" "}
            <strong className="font-semibold text-ink">{target.growerName}</strong>
          </p>
        )}
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          ביטול
        </Button>
        <Button
          type="button"
          onClick={() => stage.kind === "preview" && saveMutation.mutate(stage)}
          disabled={!canConfirm}
          aria-describedby={readyToSave ? summaryId : undefined}
        >
          {saving && (
            <span
              aria-hidden
              className="animate-spin-loop h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent"
            />
          )}
          {saving ? "קולט…" : "אישור וקליטה"}
        </Button>
      </div>
    </div>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger ring-1 ring-inset ring-danger/20"
    >
      <Icon name="alertCircle" className="mt-px h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="flex items-start gap-2.5 rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning ring-1 ring-inset ring-warning/25"
    >
      <Icon name="infoCircle" className="mt-px h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// Hebrew counts: "one" has its own wording, the rest take the number.
function count(value: number, one: string, many: (n: number) => string): string {
  return value === 1 ? one : many(value);
}

function PlanPreview({ plan }: { plan: PickImportPlan }) {
  if (plan.rowCount === 0) {
    return (
      <p className="text-sm text-ink-muted">
        אין בקובץ שורות מתחת לכותרות. ממלאים שורה לכל מוצר: שם המוצר בעמודה "מוצר", ומספר המשטחים
        בעמודה "משטחים שנקטפו".
      </p>
    );
  }
  return (
    // Its own scroll area, so the buttons under it stay on screen however
    // long the file is — the same arrangement as the pick's own
    // confirmation (pick-confirmation-dialog.tsx), and for the same reason.
    // The 4px padding offsets its negative margin to leave the table's
    // shadow room.
    <div className="-m-1 max-h-[50dvh] space-y-4 overflow-y-auto p-1">
      <p role="status" className="flex flex-wrap gap-2">
        <StatusPill tone="accent">
          {count(plan.changes.length, "שינוי אחד", (n) => `${n} שינויים`)}
        </StatusPill>
        <StatusPill>{count(plan.unchanged, "שורה אחת ללא שינוי", (n) => `${n} שורות ללא שינוי`)}</StatusPill>
        {plan.notImported.length > 0 && (
          <StatusPill tone="warning">
            {count(plan.notImported.length, "שורה אחת לא תיקלט", (n) => `${n} שורות לא ייקלטו`)}
          </StatusPill>
        )}
        {plan.errors.length > 0 && (
          <StatusPill tone="danger">{count(plan.errors.length, "שגיאה אחת", (n) => `${n} שגיאות`)}</StatusPill>
        )}
      </p>

      {plan.errors.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-danger">יש לתקן בקובץ לפני הקליטה — אף שורה לא תיקלט עד אז</h3>
          <ul className="mt-2 space-y-1.5 text-sm text-ink">
            {plan.errors.map((error) => (
              <li key={error.rowNumber}>
                <span className="font-semibold">שורה {error.rowNumber}: </span>
                {error.product && (
                  <>
                    <bdi className="font-medium">{error.product}</bdi>
                    {" — "}
                  </>
                )}
                {error.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.changes.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-ink">מה ישתנה</h3>
          <TableContainer className="mt-2">
            <TableHeader>
              <TableRow>
                <TableHead>שורה</TableHead>
                <TableHead>מוצר</TableHead>
                <TableHead>נקטף עכשיו</TableHead>
                <TableHead>אחרי הקליטה</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.changes.map((change) => (
                <TableRow key={change.lineId}>
                  <TableCell className="tabular-nums text-ink-muted">{change.rowNumber}</TableCell>
                  <TableCell className="font-medium text-ink">{change.product}</TableCell>
                  <TableCell className="tabular-nums text-ink-muted">{change.from}</TableCell>
                  <TableCell className="font-semibold tabular-nums text-accent">{change.to}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableContainer>
        </section>
      )}

      {plan.notImported.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-ink">לא ייקלטו</h3>
          <ul className="mt-2 space-y-1.5 text-sm text-ink">
            {plan.notImported.map((skip) => (
              <li key={skip.rowNumber}>
                <span className="font-semibold">שורה {skip.rowNumber}: </span>
                {skip.product && (
                  <>
                    <bdi className="font-medium">{skip.product}</bdi>
                    {" — "}
                  </>
                )}
                {skip.reason}
                {skip.quantity && (
                  <span className="text-ink-muted">
                    {" "}
                    (כמות: <bdi>{skip.quantity}</bdi>)
                  </span>
                )}
                {skip.suggestions.length > 0 && (
                  <span className="text-ink-muted">. אולי: {skip.suggestions.join(", ")}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.unchanged > 0 && (
        <p className="text-xs text-ink-subtle">
          ללא שינוי: שורות שתא הכמות שלהן ריק, או שהכמות בהן כבר רשומה באורי.
        </p>
      )}
    </div>
  );
}

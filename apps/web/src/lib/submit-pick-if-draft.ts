import type { Database } from "@ori/db/supabase-types";
import {
  LIFECYCLE_ERROR_CODES,
  submitPickInputSchema,
  toSubmitPickRpcArgs,
} from "@ori/domain/lifecycle-engine";
import type { SupabaseClient } from "@supabase/supabase-js";

export type SubmitPickOutcome =
  /** The pick was a draft, and this call sent it. */
  | { status: "sent" }
  /** Nothing to send: already submitted, or closed — by now, or in the instant before. */
  | { status: "not_draft" }
  | { status: "failed"; error: unknown };

// The second step of every save that also SENDS a pick (draft -> submitted):
// PickLinesEditor's `submitOnSave` (the grower's own screen and the pencil on
// "בשם מגדל") and the "בשם מגדל" picking upload. Run only after
// save_pick_lines has committed, so the pick is always sent with the numbers
// just saved, never the previous ones.
//
// It asks the server for the pick's status rather than trusting what the
// screen showed, because that can be stale: the pick's status can change under
// an open screen — the same pick sent from a second device, or by the
// distributor's save on "בשם מגדל", or closed (with the day, or by the
// distributor's truck icon). Trusting a stale "draft" would try a submit that
// is no longer needed.
//
// INVALID_STATE from submit_pick means the pick left draft between that read
// and this call — submitted by someone else in that instant, or closed (with
// the day, or by the truck). Either way it is no longer waiting to be sent,
// which is what this step exists to achieve, so it counts as success, not a
// failure.
//
// Returns the failure instead of throwing it — the try/catch included, for
// anything that throws rather than returning `{ error }`. By the time this
// runs the lines ARE saved, and a throw would send the caller's mutation down
// its error path, which reports "the save failed" over numbers that did in
// fact save.
export async function submitPickIfStillDraft(
  supabase: SupabaseClient<Database>,
  dailyPickId: string,
): Promise<SubmitPickOutcome> {
  try {
    const { data: pick, error: readError } = await supabase
      .from("daily_picks")
      .select("status")
      .eq("id", dailyPickId)
      .single();
    if (readError) return { status: "failed", error: readError };
    if (pick.status !== "draft") return { status: "not_draft" };

    const input = submitPickInputSchema.parse({ dailyPickId });
    const { error } = await supabase.rpc("submit_pick", toSubmitPickRpcArgs(input));
    if (!error) return { status: "sent" };
    return error.code === LIFECYCLE_ERROR_CODES.INVALID_STATE
      ? { status: "not_draft" }
      : { status: "failed", error };
  } catch (error) {
    return { status: "failed", error };
  }
}

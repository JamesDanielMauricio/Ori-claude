import { resolveHomeRoute } from "@ori/shared/roles";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { AuthCard } from "@/components/auth/auth-card";
import { PasswordInput } from "@/components/auth/password-input";
import { FormField, inputClassName } from "@/components/reference-data/form-field";
import { Button } from "@/components/ui/button";
import { INACTIVE_ACCOUNT_MESSAGE, readAccountActive } from "@/lib/auth-context";
import { INACTIVE_ACCOUNT_LOGIN } from "@/lib/require-role";
import { createClient } from "@/lib/supabase/client";
import { retryOnClockSkew } from "@/lib/supabase/retry-clock-skew";

const PROFILE_FAILED_MESSAGE = "ההתחברות הצליחה אך טעינת הפרופיל נכשלה. בדוק את החיבור ונסה שוב.";
const NO_PROFILE_MESSAGE = "החשבון אינו מקושר לפרופיל במערכת. פנה למנהל המערכת.";

// What the page says when it opens with a reason in the address: the route
// guard sends a user of an inactive company here with ?inactive=1 after
// signing them out (require-role.tsx), and a sign-in refused after a correct
// password comes back here with its own reason (handleSubmit's `refuse`).
function messageFromAddress(searchParams: URLSearchParams): string | null {
  if (searchParams.get("inactive") === "1") return INACTIVE_ACCOUNT_MESSAGE;
  switch (searchParams.get("reason")) {
    case "profile-failed":
      return PROFILE_FAILED_MESSAGE;
    case "no-profile":
      return NO_PROFILE_MESSAGE;
    default:
      return null;
  }
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Opens with the reason rather than an empty form when there is one.
  const [error, setError] = useState<string | null>(() => messageFromAddress(searchParams));
  // ...and ends the session here, not in the guard — see require-role.tsx.
  // Signing out when there is no session left does nothing.
  const arrivedInactive = searchParams.get("inactive") === "1";
  useEffect(() => {
    // This device only, like every sign-out (sign-out-button.tsx). Another
    // device of the same account is stopped by the same check when it next
    // loads: the database already refuses an inactive company everything.
    if (arrivedInactive) void createClient().auth.signOut({ scope: "local" });
  }, [arrivedInactive]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const supabase = createClient();
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    // A correct password, then a refusal: the user is signed in for a moment
    // and has to be signed straight back out. Signing out remounts every
    // screen, this one included (a new account scope — lib/providers.tsx), so
    // a message kept only in this page's state was lost with it: the form just
    // went blank. The reason goes into the address FIRST — the router sits
    // above that remount (main.tsx) — and the page that opens reads it from
    // there (messageFromAddress). setError shows it at once if nothing remounts.
    async function refuse(address: string, message: string) {
      navigate(address, { replace: true });
      await supabase.auth.signOut();
      setError(message);
      setIsSubmitting(false);
    }

    if (signInError || !data.user) {
      setError("אימייל או סיסמה שגויים.");
      setIsSubmitting(false);
      return;
    }

    // RLS-protected read: "profiles_select_own" is what permits this — see
    // docs/SCHEMA_DECISIONS.md.
    //
    // The first read made with the token sign-in just issued, which is
    // exactly the moment a database server whose clock runs a little behind
    // refuses it as "issued in the future" (PGRST303). That used to land in
    // the error branch below and sign a correct password straight back out;
    // retryOnClockSkew waits and asks again instead, while the button stays
    // disabled on "מתחבר…". Every other error reaches the branch below
    // exactly as before.
    const userId = data.user.id;
    // Beside it, for no extra wait: whether the user's company is active
    // (migration 0088) — see the check below.
    const [{ data: profile, error: profileError }, accountActive] = await Promise.all([
      retryOnClockSkew(() =>
        supabase
          .from("profiles")
          .select("role, must_change_password")
          .eq("user_id", userId)
          .single(),
      ),
      readAccountActive(),
    ]);

    // A failed READ and a genuinely missing row are different problems and no
    // longer collapse into the same silent outcome. Previously both ended in
    // a signOut() with no message, so a dropped connection right after a
    // correct password looked exactly like a rejected sign-in that forgot to
    // say why: the spinner stopped and nothing else happened, with no way to
    // tell whether retrying was worth it.
    //
    // PGRST116 is PostgREST's "no rows" for a .single(); anything else is a
    // transport or server failure, where the credentials were fine and a
    // retry is the right advice.
    if (profileError && profileError.code !== "PGRST116") {
      await refuse("/login?reason=profile-failed", PROFILE_FAILED_MESSAGE);
      return;
    }

    if (!profile) {
      // Authenticated with Supabase but no matching profiles row — a
      // corrupt/orphan account per the PRD's documented edge case
      // (reference/prd/role-based-routing.md). There is nowhere sensible to
      // route them, and the account needs an admin, not a retry — so say that
      // rather than leaving the form looking unresponsive.
      await refuse("/login?reason=no-profile", NO_PROFILE_MESSAGE);
      return;
    }

    // A correct password, but the user's company is inactive: the database
    // refuses them everything, so say why instead of opening empty screens.
    if (!accountActive) {
      await refuse(INACTIVE_ACCOUNT_LOGIN, INACTIVE_ACCOUNT_MESSAGE);
      return;
    }

    if (profile.must_change_password) {
      navigate("/change-password");
      return;
    }

    navigate(resolveHomeRoute(profile.role));
  }

  return (
    <AuthCard title="התחברות" subtitle="שיווק תוצרת חקלאית למגזר הסיטונאי">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <FormField label="אימייל" htmlFor="email">
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            className={`${inputClassName} w-full`}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </FormField>

        <FormField label="סיסמה" htmlFor="password">
          <PasswordInput id="password" value={password} onChange={setPassword} />
        </FormField>

        {error && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? "מתחבר…" : "התחברות"}
        </Button>
      </form>

      <p className="mt-4 text-center text-sm">
        {/* <Link>, not <a href>: a bare anchor triggers a full document load,
            which in an SPA throws away the running app and re-downloads the
            bundle to move between two screens the router already has. */}
        {/* `inline-flex min-h-10 px-3` rather than a bare inline link: as
            plain text this was a 76×18 target — the recovery route for
            someone who has already failed to sign in, usually on a phone,
            usually in a hurry. The box only grows the hit area; the
            centred paragraph keeps it looking the same. */}
        <Link
          to="/reset-password"
          className="inline-flex min-h-10 items-center justify-center rounded-md px-3 text-accent hover:underline"
        >
          שכחת סיסמה?
        </Link>
      </p>
    </AuthCard>
  );
}

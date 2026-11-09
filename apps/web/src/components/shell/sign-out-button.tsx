import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { createClient } from "@/lib/supabase/client";

export function SignOutButton({ className = "" }: { className?: string }) {
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    setIsSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    navigate("/login");
  }

  // Sign-out is deliberately NOT the accent green it used to be. Filled
  // accent is this app's "confirm / do the thing" signal (Save, Open Shop,
  // Submit Order), and spending it on the one control nobody is aiming for
  // made the loudest thing in the sidebar the thing you least want to hit by
  // accident.
  //
  // It still needs to be found on purpose, though — a plain gray button
  // blended into every other secondary control on the screen. This reuses
  // the app's existing "needs attention" idiom (danger-soft fill + danger
  // text + ring, the same treatment as an error banner) rather than the
  // solid `danger` Button variant used for delete confirmations: sign-out
  // isn't destructive, so it shouldn't read with the same alarm as one.
  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={isSigningOut}
      className={`w-full rounded-md border border-danger/25 bg-danger-soft px-3 py-2.5 text-center text-sm font-semibold text-danger ring-1 ring-inset ring-danger/15 transition-colors hover:bg-danger hover:text-danger-ink disabled:opacity-50 ${className}`}
    >
      {/* The source's one English-labelled control ("Log out") — its own
          PRD flags that as a likely copy oversight, so the rebuild uses
          Hebrew like every other control. */}
      {isSigningOut ? "…" : "התנתקות"}
    </button>
  );
}

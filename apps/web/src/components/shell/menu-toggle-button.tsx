import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useLocation } from "react-router-dom";

import { Icon } from "@/components/ui/icon";

// The phone header's hamburger, shared by BackofficeNav and RoleShell so the
// one way into navigation on that layout can't drift between the shells.
//
// It also closes the menu on any navigation, not only a click on one of the
// menu's own rows: an alert picked from the bell beside it, browser Back, or
// a link on the page would otherwise land on the new screen with the menu
// still covering it.
export function MenuToggleButton({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="תפריט"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        // 40px, matching the AlertsBell beside it — it was 36, the one
        // control in the phone header under the touch-target floor, and it
        // is the only way into navigation on that layout.
        className="flex h-10 w-10 items-center justify-center rounded-md text-ink-muted transition-[background-color,color,transform] duration-200 hover:bg-accent-soft hover:text-accent active:scale-95"
      >
        <Icon name={open ? "close" : "menu"} />
      </button>
      {open && <CloseOnNavigation onNavigate={() => setOpen(false)} />}
    </>
  );
}

// Mounted only while the menu is open, so the shells themselves still never
// read the location and never re-render on navigation. Pathname only, the
// same thing PageTransition keys on: a `?param` change is the same screen.
function CloseOnNavigation({ onNavigate }: { onNavigate: () => void }) {
  const { pathname } = useLocation();
  const [openedOn] = useState(pathname);

  useEffect(() => {
    if (pathname !== openedOn) onNavigate();
  }, [pathname, openedOn, onNavigate]);

  return null;
}

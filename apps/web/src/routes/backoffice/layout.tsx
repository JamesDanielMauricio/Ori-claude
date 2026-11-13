import { useQueryClient } from "@tanstack/react-query";
import { Suspense, useState, type ReactNode } from "react";
import { Outlet } from "react-router-dom";

import { UnsavedChangesProvider } from "@/components/arrangement/unsaved-changes";
import { BackofficeNav } from "@/components/shell/backoffice-nav";
import { PageTransition } from "@/components/shell/page-transition";
import { SelectedTradingDayProvider } from "@/lib/trading-day-view";
import { trpc, trpcClientConfig } from "@/lib/trpc-client";

import BackofficeLoading from "./loading";

// Here rather than app-wide: only backoffice admin screens talk to apps/api,
// so the tRPC client stays out of the entry chunk every grower and customer
// downloads. It uses the account's own cache from Providers, and this layout
// remounts with that cache when the account changes.
function TrpcProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [client] = useState(() => trpc.createClient(trpcClientConfig()));
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      {children}
    </trpc.Provider>
  );
}

// The role check that used to run here (`await requireRole("backoffice")`)
// now lives on the parent route in app-routes.tsx, so it is declared once
// for the whole group rather than executed on every render of this layout.
// See lib/require-role.tsx for what that guard does and does not protect.
export default function BackofficeLayout() {
  return (
    <TrpcProvider>
      {/* Wraps BOTH the nav (whose BusinessDayPanel holds the date picker) and
          the routed page (whichever of the date-aware screens is mounted) in
          one provider, so the picked date survives navigating from one
          backoffice screen to another instead of resetting to live on every
          click — see lib/trading-day-view.tsx. */}
      <SelectedTradingDayProvider>
        {/* Inside the date provider, around the same subtree: the grid's
            unsaved changes outlive each screen, keyed by trading day. It is
            emptied by the account-change remount, not by anything here — see
            components/arrangement/unsaved-changes.tsx. */}
        <UnsavedChangesProvider>
          {/* Column below `md`, row above it — BackofficeNav renders a sticky top
              strip on narrow viewports and the persistent rail on wide ones, and
              the two have to stack differently. Same shape RoleShell's own
              wrapper uses. */}
          <div className="flex min-h-dvh flex-col md:flex-row">
            <BackofficeNav />
            <main className="min-w-0 flex-1 overflow-x-hidden p-5 md:p-8 lg:p-10">
              {/* Suspense sits inside <main>, not around the whole layout, so a
                  sidebar click swaps only the content area and leaves the nav
                  mounted — the same boundary app/(backoffice)/loading.tsx drew. */}
              <Suspense fallback={<BackofficeLoading />}>
                <PageTransition>
                  <Outlet />
                </PageTransition>
              </Suspense>
            </main>
          </div>
        </UnsavedChangesProvider>
      </SelectedTradingDayProvider>
    </TrpcProvider>
  );
}

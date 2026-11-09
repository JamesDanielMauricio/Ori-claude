import { queryOptions } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";

// Server reads behind the bulk-import screen, defined once — key + fetch
// together; see lib/queries/trading-day.ts for why the keys matter. (The
// password-reset page reads referenceDataQueries.contactPersonProfiles.) The
// writes themselves go through apps/api (service-role operations), not
// through these.

export interface CompanyOption {
  id: string;
  name: string;
  type: string;
  status: "active" | "inactive";
}

export const usersAdminQueries = {
  // Every company, so an imported user's company is picked by name rather
  // than typed in as a UUID, which no screen shows. Readable by backoffice
  // through the companies RLS policies.
  importCompanies() {
    return queryOptions({
      queryKey: ["users-import", "companies"],
      queryFn: async (): Promise<CompanyOption[]> => {
        const { data, error } = await createClient()
          .from("companies")
          .select("id, name, type, status")
          .order("name");
        if (error) throw error;
        return data;
      },
    });
  },
};

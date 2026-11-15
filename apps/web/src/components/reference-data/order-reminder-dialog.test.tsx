import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { oversightQueries } from "@/lib/queries/oversight";

import { OrderReminderDialog } from "./order-reminder-dialog";

// The real Dialog portals into document.body, which the server renderer (and
// this node test environment) has no notion of. Stand in a plain element that
// keeps what matters here: the title and the content.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

const TARGET = { dailyOrderId: "o1", customerId: "c1", customerName: "מאפיית כהן" };

function render(rows: Array<{ user_id: string; display_name: string; phone_number: string | null }>) {
  const client = new QueryClient();
  client.setQueryData(oversightQueries.customerPeople("c1").queryKey, rows);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <OrderReminderDialog target={TARGET} onClose={() => undefined} sending={false} onSend={() => undefined} />
    </QueryClientProvider>,
  );
}

// The checkbox <input> inside the label that holds the given name.
function checkboxOf(html: string, name: string): string {
  const label = [...html.matchAll(/<label[^>]*>.*?<\/label>/gs)].find(([m]) => m.includes(name));
  const input = label?.[0].match(/<input[^>]*>/)?.[0];
  if (!input) throw new Error(`no checkbox for ${name}`);
  return input;
}

describe("OrderReminderDialog", () => {
  it("lists the people, ticking those who can receive and disabling the rest", () => {
    const html = render([
      { user_id: "u1", display_name: "אבי", phone_number: "0501234567" },
      { user_id: "u2", display_name: "בני", phone_number: null },
      { user_id: "u3", display_name: "גילה", phone_number: "12" },
    ]);
    expect(html).toContain("שליחת תזכורת — מאפיית כהן");
    expect(html).toContain("מקבלי ההודעה:");
    expect(checkboxOf(html, "אבי")).toContain('checked=""');
    expect(checkboxOf(html, "אבי")).not.toContain("disabled");
    expect(checkboxOf(html, "בני")).toContain('disabled=""');
    expect(checkboxOf(html, "בני")).not.toContain('checked=""');
    expect(html).toContain("אין טלפון");
    expect(html).toContain("מספר לא תקין");
    expect(html).toContain("•••4567");
    expect(html).not.toContain("לאף אחד מאנשי הלקוח");
  });

  it("with nobody reachable, says so and disables שלח", () => {
    const html = render([{ user_id: "u2", display_name: "בני", phone_number: null }]);
    expect(html).toContain(
      "לאף אחד מאנשי הלקוח אין מספר טלפון שאפשר לשלוח אליו הודעת WhatsApp. אפשר להוסיף מספר במסך המשתמשים.",
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>שלח<\/button>/);
  });
});

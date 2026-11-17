import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OrderReminderConfirmDialog } from "./order-reminder-confirm-dialog";

// The real Dialog portals into document.body, which the server renderer (and
// this node test environment) has no notion of. Stand in a plain element that
// keeps what matters here: whether it is open, the title and the content.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: string;
    children: React.ReactNode;
  }) => (
    <section data-open={String(open)}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

function render(target: { dailyOrderId: string; customerName: string } | null) {
  return renderToStaticMarkup(
    <OrderReminderConfirmDialog
      target={target}
      onClose={() => undefined}
      onConfirm={() => undefined}
    />,
  );
}

describe("OrderReminderConfirmDialog", () => {
  it("asks whether to remind the customer, with ביטול and שלח and no list of people", () => {
    const html = render({ dailyOrderId: "o1", customerName: "מאפיית כהן" });
    expect(html).toContain('data-open="true"');
    expect(html).toContain("<h2>שליחת תזכורת</h2>");
    expect(html).toContain("לשלוח למאפיית כהן תזכורת לשלוח הזמנה?");
    expect(html).toMatch(/<button[^>]*>ביטול<\/button>/);
    expect(html).toMatch(/<button[^>]*>שלח<\/button>/);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("מקבלי ההודעה:");
  });

  it("is closed when there is no target", () => {
    expect(render(null)).toContain('data-open="false"');
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ScreenCrashed, ScreenErrorBoundary, screenErrorText } from "./screen-error-boundary";

describe("ScreenErrorBoundary", () => {
  it("keeps what was thrown, and turns a thrown null into an error, so it never draws the screen again", () => {
    const error = new Error("boom");
    expect(ScreenErrorBoundary.getDerivedStateFromError(error).error).toBe(error);
    expect(ScreenErrorBoundary.getDerivedStateFromError(null).error).toBeInstanceOf(Error);
    expect(ScreenErrorBoundary.getDerivedStateFromError(undefined).error).toBeInstanceOf(Error);
  });

  it("draws the screen as it is while nothing has gone wrong", () => {
    expect(renderToStaticMarkup(<ScreenErrorBoundary>מסך</ScreenErrorBoundary>)).toBe("מסך");
  });
});

describe("the crash screen", () => {
  it("says what happened, offers a reload, and shows the error's own message left to right", () => {
    const html = renderToStaticMarkup(<ScreenCrashed error={new TypeError("x is not a function")} />);
    expect(html).toMatch(/^<div role="alert"/);
    expect(html).toContain("משהו השתבש במסך הזה");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>טעינה מחדש<\/button>/);
    expect(html).toContain('<bdi dir="ltr" class="break-all font-mono">x is not a function</bdi>');
  });

  it("lists the steps that led to the crash, when there are any (Crash Trail)", () => {
    const steps = [
      { at: "2026-11-12T10:00:01.000Z", what: "opened /backoffice/distributor-grower" },
      { at: "2026-11-12T10:00:05.000Z", what: 'clicked button "ערוך את מלאי מגדל"' },
    ];
    const html = renderToStaticMarkup(<ScreenCrashed error={new Error("boom")} steps={steps} />);
    expect(html).toContain("הצעדים האחרונים לפני התקלה");
    expect(html).toContain('<li><bdi dir="ltr">10:00:05</bdi> clicked button &quot;ערוך את מלאי מגדל&quot;</li>');
    expect(renderToStaticMarkup(<ScreenCrashed error={new Error("boom")} />)).not.toContain("<details");
  });

  it("names any thrown value", () => {
    expect(screenErrorText(new Error("boom"))).toBe("boom");
    expect(screenErrorText(new RangeError(""))).toBe("RangeError");
    expect(screenErrorText("plain text")).toBe("plain text");
    expect(screenErrorText(42)).toBe("42");
  });
});

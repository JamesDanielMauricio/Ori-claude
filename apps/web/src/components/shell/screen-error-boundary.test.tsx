import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  notifyScreenCrash,
  onScreenCrash,
  ScreenCrashed,
  ScreenErrorBoundary,
  screenErrorText,
} from "./screen-error-boundary";

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

describe("the crash hook", () => {
  it("with no listener, a crash is reported to nobody and adds nothing", () => {
    expect(notifyScreenCrash(new Error("boom"), null)).toEqual([]);
  });

  it("tells each listener the error, collects the lines they hand back, and stops when asked", () => {
    const heard: unknown[] = [];
    const stop = onScreenCrash((error, componentStack) => {
      heard.push([error, componentStack]);
      return ["a line"];
    });
    const error = new Error("boom");
    expect(notifyScreenCrash(error, "\n at Screen")).toEqual(["a line"]);
    expect(heard).toEqual([[error, "\n at Screen"]]);
    stop();
    expect(notifyScreenCrash(error, null)).toEqual([]);
  });

  it("skips a listener that throws, so reporting a crash never breaks the crash screen", () => {
    const stopBroken = onScreenCrash(() => {
      throw new Error("reporter broke");
    });
    const stopFine = onScreenCrash(() => ["still here"]);
    expect(notifyScreenCrash(new Error("boom"), null)).toEqual(["still here"]);
    stopBroken();
    stopFine();
  });
});

describe("the crash screen", () => {
  it("says what happened, offers a reload, and shows the error's own message left to right", () => {
    const html = renderToStaticMarkup(<ScreenCrashed error={new TypeError("x is not a function")} />);
    expect(html).toMatch(/^<div role="alert"/);
    expect(html).toContain("משהו השתבש במסך הזה");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>טעינה מחדש<\/button>/);
    expect(html).toContain('<bdi dir="ltr" class="break-all font-mono">x is not a function</bdi>');
    expect(html).not.toContain("<details");
  });

  it("lists a listener's lines under its details", () => {
    const html = renderToStaticMarkup(<ScreenCrashed error={new Error("boom")} lines={["10:00:05 clicked button", "10:00:06 opened /x"]} />);
    expect(html).toContain("פרטים נוספים");
    expect(html).toContain("<li>10:00:05 clicked button</li><li>10:00:06 opened /x</li>");
  });

  it("names any thrown value", () => {
    expect(screenErrorText(new Error("boom"))).toBe("boom");
    expect(screenErrorText(new RangeError(""))).toBe("RangeError");
    expect(screenErrorText("plain text")).toBe("plain text");
    expect(screenErrorText(42)).toBe("42");
  });
});

import { describe, expect, it } from "vitest";

import { replacedPhotoPath } from "./variety-photo";

const ours = (name: string) => `https://abc.supabase.co/storage/v1/object/public/product-photos/${name}`;

// Which stored file a variety save leaves behind — the one to remove,
// best-effort, after the row points elsewhere.
describe("replacedPhotoPath", () => {
  it("names our old file when the picture changed", () => {
    expect(replacedPhotoPath(ours("a.jpg"), ours("b.jpg"))).toBe("a.jpg");
  });

  it("names our old file when the picture was removed", () => {
    expect(replacedPhotoPath(ours("a.jpg"), null)).toBe("a.jpg");
  });

  it("names nothing when the picture is unchanged", () => {
    expect(replacedPhotoPath(ours("a.jpg"), ours("a.jpg"))).toBeNull();
  });

  it("names nothing when there was no picture before", () => {
    expect(replacedPhotoPath(null, ours("b.jpg"))).toBeNull();
  });

  it("never names a file outside Ori's storage — a Bubble link is not ours to delete", () => {
    expect(replacedPhotoPath("https://x.cdn.bubble.io/f/a.jpg", ours("b.jpg"))).toBeNull();
  });
});

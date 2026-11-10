import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkPicture,
  companyDetailsFromBubble,
  copyPicture,
  isBubblePictureUrl,
  loadExport,
  toHttpsUrl,
  type PictureStore,
} from "./bubble-extras";

describe("toHttpsUrl", () => {
  it("turns Bubble's protocol-relative link into https", () => {
    expect(toHttpsUrl("//abc.cdn.bubble.io/f1/a.jpg")).toBe("https://abc.cdn.bubble.io/f1/a.jpg");
  });

  it("leaves a full link as it is", () => {
    expect(toHttpsUrl("https://x.test/a.jpg")).toBe("https://x.test/a.jpg");
  });
});

describe("companyDetailsFromBubble", () => {
  it("trims each field and turns an empty one into null", () => {
    expect(companyDetailsFromBubble({ _id: "1", "Phone no.": " 050 ", City: "  " })).toEqual({
      phone: "050",
      address_line: null,
      city: null,
      tax_id: null,
      accounting_id: null,
    });
  });

  it("reads a number Bubble stored as a number", () => {
    expect(companyDetailsFromBubble({ _id: "1", "Tax ID": 514000000 }).tax_id).toBe("514000000");
  });
});

describe("isBubblePictureUrl", () => {
  it("matches Bubble's CDN and nothing that merely contains its name", () => {
    expect(isBubblePictureUrl("https://x.cdn.bubble.io/a.jpg")).toBe(true);
    expect(isBubblePictureUrl("https://abc.supabase.co/storage/v1/object/public/product-photos/a.jpg")).toBe(false);
    expect(isBubblePictureUrl("https://cdn.bubble.io.evil.test/a.jpg")).toBe(false);
  });
});

function fakeStore() {
  const uploads: Array<{ path: string; bytes: number; contentType: string; cacheControl: string }> = [];
  const store: PictureStore = {
    async upload(filePath, bytes, options) {
      uploads.push({ path: filePath, bytes: bytes.length, ...options });
      return `https://ori.test/storage/v1/object/public/product-photos/${filePath}`;
    },
    async remove() {},
  };
  return { store, uploads };
}
const answer =
  (status: number, contentType: string, size: number): typeof fetch =>
  async () =>
    new Response(new Uint8Array(size), { status, headers: { "content-type": contentType, "content-length": String(size) } });

describe("copyPicture", () => {
  it("uploads a JPEG under a fresh .jpg name with the one-year browser cache", async () => {
    const { store, uploads } = fakeStore();
    const result = await copyPicture("https://x.cdn.bubble.io/a.jpg", store, {
      fetchFn: answer(200, "image/jpeg; charset=binary", 10),
      newName: () => "fresh",
    });
    expect(result).toEqual({ ok: true, url: "https://ori.test/storage/v1/object/public/product-photos/fresh.jpg", path: "fresh.jpg" });
    expect(uploads).toEqual([{ path: "fresh.jpg", bytes: 10, contentType: "image/jpeg", cacheControl: "31536000" }]);
  });

  it("skips AVIF — the bucket refuses it — and uploads nothing", async () => {
    const { store, uploads } = fakeStore();
    expect(await copyPicture("https://x.cdn.bubble.io/a.avif", store, { fetchFn: answer(200, "image/avif", 10) })).toEqual({
      ok: false,
      reason: "unsupported-type",
    });
    expect(uploads).toEqual([]);
  });

  it("skips a picture over 5 MB", async () => {
    const { store, uploads } = fakeStore();
    expect(await copyPicture("https://x.cdn.bubble.io/big.png", store, { fetchFn: answer(200, "image/png", 5 * 1024 * 1024 + 1) })).toEqual({
      ok: false,
      reason: "too-big",
    });
    expect(uploads).toEqual([]);
  });

  it("skips a download that fails or is refused", async () => {
    const { store, uploads } = fakeStore();
    const failing: typeof fetch = async () => {
      throw new Error("network down");
    };
    expect(await copyPicture("https://x.cdn.bubble.io/a.jpg", store, { fetchFn: failing })).toEqual({ ok: false, reason: "download-failed" });
    expect(await copyPicture("https://x.cdn.bubble.io/a.jpg", store, { fetchFn: answer(404, "text/html", 5) })).toEqual({ ok: false, reason: "download-failed" });
    expect(uploads).toEqual([]);
  });
});

describe("checkPicture (the dry run's header-only check)", () => {
  it("accepts a WebP and flags what copyPicture would skip", async () => {
    expect(await checkPicture("https://x.cdn.bubble.io/a.webp", answer(200, "image/webp", 10))).toEqual({ ok: true });
    expect(await checkPicture("https://x.cdn.bubble.io/a.avif", answer(200, "image/avif", 10))).toEqual({ ok: false, reason: "unsupported-type" });
    expect(await checkPicture("https://x.cdn.bubble.io/b.png", answer(200, "image/png", 6 * 1024 * 1024))).toEqual({ ok: false, reason: "too-big" });
  });
});

describe("loadExport", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const exportWith = (bubbleEnv: string, counts: Record<string, number>, files: Record<string, unknown[]>) => {
    dir = mkdtempSync(path.join(tmpdir(), "bubble-export-test-"));
    writeFileSync(path.join(dir, "_manifest.json"), JSON.stringify({ bubbleEnv, exportedAt: "2026-11-10T00:00:00Z", counts }));
    for (const [type, records] of Object.entries(files)) writeFileSync(path.join(dir, `${type}.json`), JSON.stringify(records));
    return dir;
  };

  it("reads each requested type", async () => {
    const data = await loadExport(exportWith("live", { company: 1 }, { company: [{ _id: "c1" }] }), ["company"], "live");
    expect(data.company).toEqual([{ _id: "c1" }]);
  });

  it("refuses an export of the other Bubble environment", async () => {
    await expect(loadExport(exportWith("test", { company: 1 }, { company: [{ _id: "c1" }] }), ["company"], "live")).rejects.toThrow(/"test"/);
  });

  it("refuses a file whose record count is not the manifest's", async () => {
    await expect(loadExport(exportWith("live", { company: 2 }, { company: [{ _id: "c1" }] }), ["company"], "live")).rejects.toThrow(/company/);
  });
});

// What the fill script (fill-from-bubble.ts) and the importer
// (import-from-bubble.ts) share for Bubble column parity
// (docs/superpowers/specs/2026-11-10-bubble-column-parity-design.md §8.1):
// the field mapping, text cleaning, reading an export, and copying a
// picture from Bubble's CDN into Ori's own storage. One place, so the two
// scripts can't drift apart.
//
// Bubble is only ever READ here: the export files on disk, and a picture's
// public CDN link.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

export type BubbleRecord = { _id: string } & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

// Ori column -> Bubble Company field (migration 0092).
export const COMPANY_DETAIL_FIELDS = {
  phone: "Phone no.",
  address_line: "Address Line",
  city: "City",
  tax_id: "Tax ID",
  accounting_id: "Accounting ID",
} as const;
export type CompanyDetailColumn = keyof typeof COMPANY_DETAIL_FIELDS;

// A non-empty, trimmed value — Bubble returns "" and missing keys for the
// same "not set". A number (an ID Bubble kept as a number) reads as its digits.
export function bubbleText(record: BubbleRecord, field: string): string | null {
  const value = record[field];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function companyDetailsFromBubble(record: BubbleRecord): Record<CompanyDetailColumn, string | null> {
  return {
    phone: bubbleText(record, COMPANY_DETAIL_FIELDS.phone),
    address_line: bubbleText(record, COMPANY_DETAIL_FIELDS.address_line),
    city: bubbleText(record, COMPANY_DETAIL_FIELDS.city),
    tax_id: bubbleText(record, COMPANY_DETAIL_FIELDS.tax_id),
    accounting_id: bubbleText(record, COMPANY_DETAIL_FIELDS.accounting_id),
  };
}

// The Bubble user id behind a company's איש קשר.
export function mainContactBubbleId(record: BubbleRecord): string | null {
  return bubbleText(record, "Main Contact");
}

// A Daily Order's "הערה כללית" (migration 0093).
export function orderCommentFromBubble(record: BubbleRecord): string | null {
  return bubbleText(record, "comment");
}

// Bubble serves uploads from a protocol-relative CDN link ("//…").
export function toHttpsUrl(value: string): string {
  return value.startsWith("//") ? `https:${value}` : value;
}

// A variety's own picture (migration 0094), Bubble "Image".
export function varietyPictureFromBubble(record: BubbleRecord): string | null {
  const value = bubbleText(record, "Image");
  return value ? toHttpsUrl(value) : null;
}

// A family's picture, Bubble "image".
export function familyPictureFromBubble(record: BubbleRecord): string | null {
  const value = bubbleText(record, "image");
  return value ? toHttpsUrl(value) : null;
}

// Whether a link points at Bubble's CDN — the links the fill script replaces
// with Ori's own copies. By host, so a link that merely mentions the name
// elsewhere doesn't count.
export function isBubblePictureUrl(url: string): boolean {
  try {
    const host = new URL(toHttpsUrl(url)).hostname;
    return host === "cdn.bubble.io" || host.endsWith(".cdn.bubble.io");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The export on disk (scripts/bubble-export.ts)
// ---------------------------------------------------------------------------

// The requested record types, checked against the export's manifest: the
// right Bubble environment, and every file whole.
export async function loadExport(
  dir: string,
  types: readonly string[],
  expectEnv: "live" | "test",
): Promise<Record<string, BubbleRecord[]>> {
  const manifest = JSON.parse(await readFile(path.join(dir, "_manifest.json"), "utf8")) as {
    bubbleEnv: string;
    counts: Record<string, number>;
  };
  if (manifest.bubbleEnv !== expectEnv) {
    throw new Error(`${dir} holds a "${manifest.bubbleEnv}" export, not "${expectEnv}".`);
  }
  const data: Record<string, BubbleRecord[]> = {};
  for (const type of types) {
    const records = JSON.parse(await readFile(path.join(dir, `${type}.json`), "utf8")) as BubbleRecord[];
    if (records.length !== manifest.counts[type]) {
      throw new Error(`${type}.json has ${records.length} records but the manifest says ${manifest.counts[type]} — re-run the export.`);
    }
    data[type] = records;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

// What the product-photos bucket accepts (migration 0058): anything else it
// refuses, so it is skipped here first, with the reason reported.
export const PICTURE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
export const PICTURE_MAX_BYTES = 5 * 1024 * 1024;
// One year. Safe because a copy's file name is new on every upload, so a
// changed picture always has a new link and a browser never holds a stale one.
// Only these copies get it; uploads from the app keep the app's own settings.
export const PICTURE_CACHE_SECONDS = "31536000";

export type PictureSkip = "unsupported-type" | "too-big" | "download-failed";

export interface PictureStore {
  // Returns the public link of the stored file.
  upload(filePath: string, bytes: Uint8Array, options: { contentType: string; cacheControl: string }): Promise<string>;
  remove(paths: string[]): Promise<void>;
}

// The product-photos bucket through a service-role client. A failed upload
// throws: the caller's run must stop, not carry on without the picture.
export function supabasePictureStore(client: SupabaseClient, bucket = "product-photos"): PictureStore {
  return {
    async upload(filePath, bytes, { contentType, cacheControl }) {
      const { error } = await client.storage.from(bucket).upload(filePath, bytes, { contentType, cacheControl, upsert: false });
      if (error) throw new Error(`picture upload failed (${filePath}): ${error.message}`);
      return client.storage.from(bucket).getPublicUrl(filePath).data.publicUrl;
    },
    async remove(paths) {
      if (paths.length === 0) return;
      const { error } = await client.storage.from(bucket).remove(paths);
      if (error) throw new Error(`picture removal failed: ${error.message}`);
    },
  };
}

type PictureType = keyof typeof PICTURE_TYPES;
const isPictureType = (type: string): type is PictureType => type in PICTURE_TYPES;
const contentTypeOf = (response: Response) =>
  (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// The dry run's check: headers only, nothing downloaded, nothing stored.
export async function checkPicture(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: PictureSkip }> {
  try {
    const response = await withTimeout(15_000, (signal) => fetchFn(toHttpsUrl(url), { method: "HEAD", signal }));
    if (!response.ok) return { ok: false, reason: "download-failed" };
    if (!isPictureType(contentTypeOf(response))) return { ok: false, reason: "unsupported-type" };
    const size = Number(response.headers.get("content-length"));
    if (Number.isFinite(size) && size > PICTURE_MAX_BYTES) return { ok: false, reason: "too-big" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "download-failed" };
  }
}

// Downloads one picture and stores Ori's own copy under a fresh name.
export async function copyPicture(
  url: string,
  store: PictureStore,
  { fetchFn = fetch, newName = randomUUID }: { fetchFn?: typeof fetch; newName?: () => string } = {},
): Promise<{ ok: true; url: string; path: string } | { ok: false; reason: PictureSkip }> {
  let bytes: Uint8Array;
  let type: PictureType;
  try {
    const response = await withTimeout(30_000, (signal) => fetchFn(toHttpsUrl(url), { signal }));
    if (!response.ok) return { ok: false, reason: "download-failed" };
    const contentType = contentTypeOf(response);
    if (!isPictureType(contentType)) return { ok: false, reason: "unsupported-type" };
    type = contentType;
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { ok: false, reason: "download-failed" };
  }
  if (bytes.length > PICTURE_MAX_BYTES) return { ok: false, reason: "too-big" };
  const filePath = `${newName()}.${PICTURE_TYPES[type]}`;
  const publicUrl = await store.upload(filePath, bytes, { contentType: type, cacheControl: PICTURE_CACHE_SECONDS });
  return { ok: true, url: publicUrl, path: filePath };
}

import type { createClient } from "@/lib/supabase/client";

import { PHOTO_MIME_EXTENSIONS, PRODUCT_PHOTOS_BUCKET, productPhotoPathFromUrl } from "./catalog-form";

// A variety's own picture (migration 0094) in Storage. The steps are the
// family upload's (use-family-mutations.ts), which stays exactly as it is:
// a fresh random file name per upload — never the variety's id, or a CDN
// could keep serving the old picture from the same URL — and the file's own
// content type. The bucket (0058) refuses anything but JPEG/PNG/WebP up to
// 5 MB, whatever this code sends.

type Supabase = ReturnType<typeof createClient>;

export async function uploadVarietyPhoto(supabase: Supabase, file: File): Promise<string> {
  const extension = PHOTO_MIME_EXTENSIONS[file.type];
  const path = `${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage
    .from(PRODUCT_PHOTOS_BUCKET)
    .upload(path, file, { contentType: file.type });
  if (error) throw error;
  return supabase.storage.from(PRODUCT_PHOTOS_BUCKET).getPublicUrl(path).data.publicUrl;
}

// The stored file a save left behind: the previous picture, when it changed
// or was removed — and only when it lives in Ori's own storage
// (productPhotoPathFromUrl), never a link this app didn't upload.
export function replacedPhotoPath(previousUrl: string | null, nextUrl: string | null): string | null {
  if (!previousUrl || previousUrl === nextUrl) return null;
  return productPhotoPathFromUrl(previousUrl);
}

// Best-effort, as for families: the row is already saved, so a failed
// removal only leaves one unreferenced file behind.
export function removeVarietyPhotoFile(supabase: Supabase, path: string | null): void {
  if (!path) return;
  void supabase.storage
    .from(PRODUCT_PHOTOS_BUCKET)
    .remove([path])
    .then(({ error }) => {
      if (error) console.warn("[product-photos] failed to remove a variety's old photo", error);
    });
}

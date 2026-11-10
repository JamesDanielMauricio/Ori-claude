import type { RefObject } from "react";

import { Icon } from "@/components/ui/icon";
import { ProductThumbnail } from "@/components/ui/product-thumbnail";

// A variety's picture control (migration 0094), live only while its row is
// being edited: clicking the picture opens the file picker, and the × badge
// — shown only once there is a picture — removes it. The same control as the
// family header's own (family-header.tsx), with the variety's labels; that
// file is left exactly as it is.
export function VarietyPhotoButton({
  pendingPhotoFile,
  imageUrl,
  previewUrl,
  inputRef,
  disabled,
  onRemove,
}: {
  pendingPhotoFile: File | null;
  imageUrl: string;
  previewUrl: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  disabled: boolean;
  onRemove: () => void;
}) {
  const hasPhoto = Boolean(pendingPhotoFile || imageUrl.trim());
  return (
    <span className="group/photo relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label={hasPhoto ? "החלפת תמונת הזן" : "העלאת תמונת הזן"}
        className="block rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40"
      >
        <ProductThumbnail imageUrl={previewUrl ?? imageUrl} size="sm" />
      </button>
      {hasPhoto && (
        <button
          type="button"
          onClick={(event) => {
            // Otherwise the click bubbles up to the picture button and
            // reopens the file picker the instant the picture clears.
            event.stopPropagation();
            onRemove();
          }}
          disabled={disabled}
          aria-label="הסרת תמונה"
          className="absolute -end-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-danger-ink opacity-0 shadow-sm ring-1 ring-inset ring-border transition-opacity duration-150 group-hover/photo:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none"
        >
          <Icon name="close" className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}

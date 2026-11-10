import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { useToast } from "@/components/ui/toast";

import { PHOTO_MAX_BYTES, PHOTO_MIME_EXTENSIONS, type FormState } from "./catalog-form";

// The variety picture (migration 0094) a distributor has picked but not
// saved yet: the file, a local preview of it, the hidden file input, and the
// two handlers that change it. The same shape as useFamilyPhoto — kept
// separate so the family's code stays exactly as it is. Nothing here touches
// Storage: the upload happens on save (useVarietyMutations), so cancelling an
// edit after picking a file uploads nothing.
export function useVarietyPhoto({
  showToast,
  setForm,
}: {
  showToast: ReturnType<typeof useToast>["showToast"];
  setForm: Dispatch<SetStateAction<FormState>>;
}) {
  const [pendingPhotoFile, setPendingPhotoFile] = useState<File | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Local preview only, via a blob: URL — revoked on every change and on
  // unmount, so switching pictures never leaks memory.
  useEffect(() => {
    if (!pendingPhotoFile) {
      setPhotoPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(pendingPhotoFile);
    setPhotoPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingPhotoFile]);

  // The bucket's own limits (0058), checked here first so a refused file gets
  // a Hebrew toast instead of a raw Storage error after an upload attempt.
  function handlePhotoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    // Lets picking the exact same file again still fire this handler.
    event.target.value = "";
    if (!file) return;
    if (!(file.type in PHOTO_MIME_EXTENSIONS)) {
      showToast("ניתן להעלות תמונות מסוג JPEG, PNG או WebP בלבד.", "error");
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      showToast("התמונה גדולה מדי (עד 5MB).", "error");
      return;
    }
    setPendingPhotoFile(file);
  }

  function handleRemovePhoto() {
    setPendingPhotoFile(null);
    setForm((current) => ({ ...current, imageUrl: "" }));
  }

  return {
    pendingPhotoFile,
    setPendingPhotoFile,
    photoPreviewUrl,
    photoInputRef,
    handlePhotoFileChange,
    handleRemovePhoto,
  };
}

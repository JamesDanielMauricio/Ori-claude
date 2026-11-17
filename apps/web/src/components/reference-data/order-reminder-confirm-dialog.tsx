import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

// The question asked before a customer's order reminder goes out — the same
// box on the סידור board and on בשם לקוח.
//
// It asks first because a reminder is a real WhatsApp message to the customer
// and cannot be taken back. It lists nobody: Bubble's board does not, and James
// chose the same for בשם לקוח (2026-11-17). The server decides who receives
// it — the customer's WhatsApp group, otherwise each person with a usable
// phone.
//
// שלח hands the order to `onConfirm` and closes the box at once; the caller's
// bell shows the send in progress, and the result arrives as a toast.
export function OrderReminderConfirmDialog({
  target,
  onClose,
  onConfirm,
}: {
  // The order to remind about and the name the question shows; null keeps the
  // box closed.
  target: { dailyOrderId: string; customerName: string } | null;
  onClose: () => void;
  onConfirm: (dailyOrderId: string) => void;
}) {
  return (
    <Dialog open={target !== null} onClose={onClose} title="שליחת תזכורת">
      <p className="mb-4 text-sm">{`לשלוח ל${target?.customerName ?? ""} תזכורת לשלוח הזמנה?`}</p>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          ביטול
        </Button>
        <Button
          onClick={() => {
            if (!target) return;
            onConfirm(target.dailyOrderId);
            onClose();
          }}
        >
          שלח
        </Button>
      </div>
    </Dialog>
  );
}

import { sendOrderReminderInputSchema, toSendOrderReminderRpcArgs } from "@ori/domain/customer";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useRef } from "react";

import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/error-message";
import { nudgeWhatsAppDispatch } from "@/lib/nudge-whatsapp-dispatch";
import { optimisticUpdate } from "@/lib/optimistic-mutation";
import { failureNeedsToast, shouldResetOnClose } from "@/lib/order-reminder";
import type { DailyOrderForDay } from "@/lib/queries/oversight";
import { createClient } from "@/lib/supabase/client";

// Sends a customer's order reminder. With a list of people, only those people
// get it; with no list (the סידור board's bell), the server's rule decides: the
// customer's group, else each person with a usable phone. Shared by the
// "בשם לקוח" screen, which opens the reminder window, and the סידור board,
// which never opens one.
//
// `reminder_sent_at` is real, persisted state on the order row, so when the
// caller passes the key of the day's orders it is patched optimistically,
// like any other field; the invalidation afterwards is the source of truth.
//
// The hook also owns the window rules both screens share (see
// order-reminder.ts): call `openWindow()` when the reminder window opens and
// `closeWindow()` from its onClose. Closing while a send is in flight keeps
// the screen attached to it, and a failure that lands after the window closed
// is shown as a toast instead of being lost.
export function useSendOrderReminder(options?: { ordersForDayQueryKey?: QueryKey }) {
  const supabase = createClient();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const ordersKey = options?.ordersForDayQueryKey;
  const windowOpen = useRef(false);

  // Without a key there is nothing cached to patch: the placeholder key holds
  // no data, so the updater returns undefined and nothing is written.
  const optimistic = optimisticUpdate<
    DailyOrderForDay[],
    { dailyOrderId: string; recipientUserIds?: string[] }
  >(queryClient, ordersKey ?? ["order-reminder", "no-orders-cache"], (orders, { dailyOrderId }) =>
    orders?.map((order) =>
      order.id === dailyOrderId ? { ...order, reminder_sent_at: new Date().toISOString() } : order,
    ),
  );

  const mutation = useMutation<
    void,
    { message?: string },
    // No list = the server's routing rule decides (the customer's group, else
    // each person with a usable phone): what the סידור board's bell sends.
    { dailyOrderId: string; recipientUserIds?: string[] },
    { previous: DailyOrderForDay[] | undefined }
  >({
    mutationFn: async ({ dailyOrderId, recipientUserIds }) => {
      const input = sendOrderReminderInputSchema.parse({ dailyOrderId, recipientUserIds });
      const { error } = await supabase.rpc("send_order_reminder", toSendOrderReminderRpcArgs(input));
      if (error) throw error;
    },
    onMutate: optimistic.onMutate,
    onSuccess: () => {
      showToast("התזכורת נשלחה.", "success");
      if (ordersKey) void queryClient.invalidateQueries({ queryKey: ordersKey });
      // The RPC already queued the WhatsApp send durably — this just asks the
      // dispatcher to drain it now. Fire-and-forget; see
      // nudge-whatsapp-dispatch.ts.
      nudgeWhatsAppDispatch(supabase);
    },
    // The rollback, plus a toast only when no window is open to show the
    // refusal: while one is open the caller shows it inside the window
    // (OrderReminderDialog's `error`), and one failure gets one message. A
    // caller that never opens a window (the סידור board) always gets the toast.
    onError: (error, variables, context) => {
      optimistic.onError(error, variables, context);
      if (failureNeedsToast({ windowOpen: windowOpen.current })) {
        showToast(`שליחת התזכורת נכשלה: ${errorMessage(error)}`, "error");
      }
    },
  });

  return {
    ...mutation,
    // A fresh window never starts with the last one's refusal.
    openWindow: () => {
      windowOpen.current = true;
      mutation.reset();
    },
    // Harmless to call twice (the dialog's native close event calls onClose
    // again after Escape or the backdrop).
    closeWindow: () => {
      windowOpen.current = false;
      if (shouldResetOnClose({ sending: mutation.isPending })) mutation.reset();
    },
  };
}

import { sendOrderReminderInputSchema, toSendOrderReminderRpcArgs } from "@ori/domain/customer";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";

import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/error-message";
import { nudgeWhatsAppDispatch } from "@/lib/nudge-whatsapp-dispatch";
import { optimisticUpdate } from "@/lib/optimistic-mutation";
import type { DailyOrderForDay } from "@/lib/queries/oversight";
import { createClient } from "@/lib/supabase/client";

// Sends a customer's order reminder. It never carries a list of people, so the
// server's rule decides who gets it: the customer's WhatsApp group, otherwise
// each person with a usable phone. Shared by the "בשם לקוח" screen and the
// סידור board, which both ask first with OrderReminderConfirmDialog.
//
// `reminder_sent_at` is real, persisted state on the order row, so when the
// caller passes the key of the day's orders it is patched optimistically,
// like any other field; the invalidation afterwards is the source of truth.
//
// The question box closes as soon as "שלח" is pressed, so the result — sent or
// refused — is always a toast.
export function useSendOrderReminder(options?: { ordersForDayQueryKey?: QueryKey }) {
  const supabase = createClient();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const ordersKey = options?.ordersForDayQueryKey;

  // Without a key there is nothing cached to patch: the placeholder key holds
  // no data, so the updater returns undefined and nothing is written.
  const optimistic = optimisticUpdate<
    DailyOrderForDay[],
    { dailyOrderId: string }
  >(queryClient, ordersKey ?? ["order-reminder", "no-orders-cache"], (orders, { dailyOrderId }) =>
    orders?.map((order) =>
      order.id === dailyOrderId ? { ...order, reminder_sent_at: new Date().toISOString() } : order,
    ),
  );

  const mutation = useMutation<
    void,
    { message?: string },
    { dailyOrderId: string },
    { previous: DailyOrderForDay[] | undefined }
  >({
    mutationFn: async ({ dailyOrderId }) => {
      const input = sendOrderReminderInputSchema.parse({ dailyOrderId });
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
    // The rollback, then the refusal as a toast: the question box has already
    // closed, so there is nowhere else to show it.
    onError: (error, variables, context) => {
      optimistic.onError(error, variables, context);
      showToast(`שליחת התזכורת נכשלה: ${errorMessage(error)}`, "error");
    },
  });

  return mutation;
}

import { sendOrderReminderInputSchema, toSendOrderReminderRpcArgs } from "@ori/domain/customer";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";

import { useToast } from "@/components/ui/toast";
import { nudgeWhatsAppDispatch } from "@/lib/nudge-whatsapp-dispatch";
import { optimisticUpdate } from "@/lib/optimistic-mutation";
import type { DailyOrderForDay } from "@/lib/queries/oversight";
import { createClient } from "@/lib/supabase/client";

// Sends a customer's order reminder to the chosen people only. Shared by the
// "בשם לקוח" screen and any other screen that opens the reminder window.
//
// `reminder_sent_at` is real, persisted state on the order row, so when the
// caller passes the key of the day's orders it is patched optimistically,
// like any other field; the invalidation afterwards is the source of truth.
export function useSendOrderReminder(options?: { ordersForDayQueryKey?: QueryKey }) {
  const supabase = createClient();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const ordersKey = options?.ordersForDayQueryKey;

  // Without a key there is nothing cached to patch: the placeholder key holds
  // no data, so the updater returns undefined and nothing is written.
  const optimistic = optimisticUpdate<
    DailyOrderForDay[],
    { dailyOrderId: string; recipientUserIds: string[] }
  >(queryClient, ordersKey ?? ["order-reminder", "no-orders-cache"], (orders, { dailyOrderId }) =>
    orders?.map((order) =>
      order.id === dailyOrderId ? { ...order, reminder_sent_at: new Date().toISOString() } : order,
    ),
  );

  return useMutation<
    void,
    { message?: string },
    { dailyOrderId: string; recipientUserIds: string[] },
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
    // Only the rollback: a refusal is shown by the caller inside the reminder
    // window (OrderReminderDialog's `error`), not as a second message here.
    onError: optimistic.onError,
  });
}

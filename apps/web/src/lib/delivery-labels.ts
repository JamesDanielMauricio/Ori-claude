import type { StatusTone } from "@/components/ui/card";

// The states a queued WhatsApp message can be in. The rule that decides them
// lives in SQL, once (public.outbox_delivery_status, migration 0078) — the
// screen only names them.
export type DeliveryStatus = "sent" | "skipped" | "failed" | "expired" | "sending" | "retrying" | "waiting";

export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; tone: StatusTone; explain: string }> = {
  sent: { label: "נשלחה", tone: "accent", explain: "ההודעה הגיעה לכל הנמענים." },
  sending: { label: "בשליחה", tone: "neutral", explain: "נשלחת ממש עכשיו." },
  waiting: { label: "ממתינה", tone: "neutral", explain: "תישלח בהרצה הקרובה." },
  retrying: { label: "ניסיון חוזר", tone: "warning", explain: "השליחה נכשלה ותנוסה שוב בזמן המצוין." },
  failed: { label: "נכשלה", tone: "danger", explain: "חמשת הניסיונות נכשלו. אפשר לשלוח שוב אחרי תיקון הבעיה." },
  expired: {
    label: "פג תוקף",
    tone: "danger",
    explain: "לא נשלחה תוך 12 שעות ולכן לא תישלח לבד. אפשר לשלוח שוב אם היא עדיין רלוונטית.",
  },
  skipped: { label: "לא נשלחה — WhatsApp כבוי", tone: "neutral", explain: "המתג של הודעה זו היה כבוי כשהגיע תורה." },
};

// "Send again" (retry_outbox_row) is offered for every message that has not
// gone out and is not being sent this moment. A skipped one is never resent
// (the switch was off — migration 0048's rule); the database refuses it too.
export function canSendAgain(status: DeliveryStatus): boolean {
  return status === "failed" || status === "expired" || status === "retrying" || status === "waiting";
}

// Which message this is, in the office's words. Transporters get the
// grower's closing template (build_notification_outbox), so the recipient
// type tells the two apart.
const TEMPLATE_LABELS: Record<string, string> = {
  close_arrangement_customer: "סגירת סידור — ללקוח",
  close_arrangement_grower: "סגירת סידור — למגדל",
  order_reminder: "תזכורת להזמנה",
  pick_reminder: "תזכורת לקטיף",
  pick_updated: "מגדל עדכן קטיף",
  order_submitted: "לקוח שלח הזמנה",
  stock_overbooking_reached: "מלאי — כל הנקטף הוזמן",
  stock_fully_exhausted: "מלאי — אזל כולל אוברבוקינג",
  shop_open: "החנות נפתחה",
  business_day_open_grower: "יום מסחר נפתח — למגדלים",
};

export function templateLabel(templateKey: string, recipientType: string): string {
  if (templateKey === "close_arrangement_grower" && recipientType === "transporter") return "סגירת סידור — למוביל";
  return TEMPLATE_LABELS[templateKey] ?? templateKey;
}

export const RECIPIENT_TYPE_LABEL: Record<string, string> = {
  customer: "לקוח",
  grower: "מגדל",
  transporter: "מוביל",
  backoffice: "משרד",
};

// Run once a day by a scheduled job (see README). Emails students who registered more than a day ago,
// still haven't sent payment details, and have 2 days or less left before the deadline. Each student once.
import { db, getSettings, payLink, serve, todayIST, UserError } from "../_shared/common.ts";
import { emails, sendBatch } from "../_shared/email.ts";

serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) throw new UserError("Not allowed.");
  const s = await getSettings();
  if (!s.registration_open || !s.deadline) return { sent: 0, note: "registration closed or no deadline set" };
  const daysLeft = (Date.parse(s.deadline) - Date.parse(todayIST())) / 86400000;
  if (daysLeft < 0 || daysLeft > 2) return { sent: 0, note: `${daysLeft} days left` };

  const { data: rows } = await db.from("students")
    .select("id, reference, name, email, college_id, pay_token")
    .eq("status", "registered").is("reminded_at", null)
    .lt("created_at", new Date(Date.now() - 86400000).toISOString()).limit(500);
  const list = rows ?? [];
  const res = await sendBatch(list.map((st) => {
    const m = emails.reminder(st, payLink(s, st.pay_token), s);
    return { kind: "reminder", to: st.email, subject: m.subject, text: m.text, who: { student_id: st.id, college_id: st.college_id } };
  }));
  const sentIds = list.filter((_, i) => res[i] === "sent").map((st) => st.id);
  if (sentIds.length) await db.from("students").update({ reminded_at: new Date().toISOString() }).in("id", sentIds);
  return { sent: sentIds.length, failed: list.length - sentIds.length };
});

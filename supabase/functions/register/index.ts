// Public: a student registers. Saves them with status "registered" (or "payment_submitted" when their
// college pays), emails them, and returns the reference and their personal payment token.
import { db, getSettings, payLink, RATINGS, safeText, serve, str, todayIST, UserError, verifyTurnstile } from "../_shared/common.ts";
import { emails, sendEmail } from "../_shared/email.ts";

serve(async (req, b) => {
  const s = await getSettings();
  if (!s.registration_open || (s.deadline && todayIST() > s.deadline)) throw new UserError("Registration is closed.");
  if (!(await verifyTurnstile(str(b.captcha, 4000), req.headers.get("x-forwarded-for")))) {
    throw new UserError("Please complete the check that you are not a robot, then try again.");
  }

  const { data: col } = await db.from("colleges").select("*").eq("id", str(b.college_id, 40)).eq("active", true).maybeSingle();
  if (!col) throw new UserError("Choose your college from the list.");

  const st: Record<string, unknown> = {
    college_id: col.id,
    name: safeText(str(b.name, 80)),
    student_id: safeText(str(b.student_id, 30)).toUpperCase(),
    email: str(b.email, 100).toLowerCase(),
    phone: str(b.phone, 20).replace(/\D/g, "").replace(/^91(?=\d{10}$)/, ""),
    year: str(b.year, 30),
    // (checked against the list below)
    branch: safeText(str(b.branch, 60)),
    github: str(b.github, 39).replace(/^@/, "") || null,
    knows: safeText(str(b.knows, 300).toLowerCase()) || null,
    consent_share_phone: b.consent_share_phone === true,
    consent_startups: b.consent_startups === true,
    consent_data: b.consent_data === true,
    status: col.payer === "college" ? "payment_submitted" : "registered",
  };
  for (const k of RATINGS) st[k] = Number(b[k]);

  // the same checks as the form, because the form can be bypassed
  if ((st.name as string).length < 2) throw new UserError("Enter your full name.");
  if (!st.student_id) throw new UserError("Enter your college student ID.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(st.email as string)) throw new UserError("Enter a valid email address.");
  if (!/^[6-9]\d{9}$/.test(st.phone as string)) throw new UserError("Enter a 10-digit Indian mobile number.");
  if (!["1st year", "2nd year", "3rd year", "4th year", "5th year", "PG"].includes(st.year as string) || !st.branch) throw new UserError("Choose your year and branch.");
  if (st.github && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(st.github as string)) throw new UserError("That GitHub username is not valid.");
  if (RATINGS.some((k) => ![1, 2, 3].includes(st[k] as number))) throw new UserError("Rate yourself on every skill.");
  if (!st.consent_data) throw new UserError("Please agree to the data notice so we can process your registration.");

  if (col.seat_limit) {
    const { count } = await db.from("students").select("id", { count: "exact", head: true })
      .eq("college_id", col.id).neq("status", "withdrawn");
    if ((count ?? 0) >= col.seat_limit) throw new UserError(`All seats for ${col.name} are taken. Contact ${s.contact} to join the waiting list.`);
  }

  const { data: row, error } = await db.from("students").insert(st).select("id, reference, name, pay_token, college_id").single();
  if (error) {
    if (error.code === "23505" && error.message.includes("students_email_uq")) {
      // Already registered: resend their own link to their own inbox, reveal nothing here.
      const { data: old } = await db.from("students").select("id, reference, name, pay_token, college_id, status")
        .eq("email", st.email).single();
      // at most one resend per address every 15 minutes, so the form can't be used to flood an inbox
      const since = new Date(Date.now() - 15 * 60000).toISOString();
      const { count: recent } = await db.from("email_log").select("id", { count: "exact", head: true })
        .eq("to_email", st.email).eq("kind", "registered_again").gte("created_at", since);
      if (old && !recent) {
        const { data: oc } = await db.from("colleges").select("*").eq("id", old.college_id).single();
        const m = oc?.payer === "college" ? emails.registeredCollegePays(old, oc, s) : emails.registeredPay(old, oc, s, payLink(s, old.pay_token, req));
        await sendEmail("registered_again", st.email as string, m.subject, m.text, { student_id: old.id, college_id: old.college_id });
      }
      throw new UserError("This email is already registered. We've emailed its reference and payment link to that address (at most once every 15 minutes).");
    }
    if (error.code === "23505" && error.message.includes("students_sid_uq")) {
      throw new UserError(`This student ID is already registered at ${col.name}. If that's wrong, email ${s.contact}.`);
    }
    if (error.code === "23514") throw new UserError("Some details are not valid. Please check the form.");
    throw error;
  }

  const m = col.payer === "college" ? emails.registeredCollegePays(row, col, s) : emails.registeredPay(row, col, s, payLink(s, row.pay_token, req));
  await sendEmail("registered", st.email as string, m.subject, m.text, { student_id: row.id, college_id: col.id });

  return { reference: row.reference, pay_token: col.payer === "college" ? null : row.pay_token, payer: col.payer };
});

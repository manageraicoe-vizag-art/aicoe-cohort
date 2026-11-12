// Sending email (Resend) and the text of every email the programme sends.
import { db } from "./common.ts";

type Who = { student_id?: string | null; team_id?: string | null; college_id?: string | null };

export async function sendEmail(kind: string, to: string, subject: string, text: string, who: Who = {}) {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("MAIL_FROM") ?? "RTIH AI CoE <no-reply@rtih.co.in>";
  const replyTo = Deno.env.get("MAIL_REPLY_TO") ?? undefined;
  let status: "sent" | "failed" | "skipped" = "skipped";
  let error: string | null = key ? null : "RESEND_API_KEY not set";
  if (key) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text, reply_to: replyTo }),
      });
      if (r.ok) status = "sent";
      else {
        status = "failed";
        error = `${r.status}: ${(await r.text()).slice(0, 300)}`;
      }
    } catch (e) {
      status = "failed";
      error = String(e).slice(0, 300);
    }
  }
  // Never log the body: key emails contain secrets.
  await db.from("email_log").insert({
    kind, to_email: to, status, error,
    student_id: who.student_id ?? null, team_id: who.team_id ?? null, college_id: who.college_id ?? null,
  });
  return status;
}

/** Send many emails through Resend's batch endpoint (up to 100 per request), logging each one. */
export async function sendBatch(items: { kind: string; to: string; subject: string; text: string; who?: Who }[]) {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("MAIL_FROM") ?? "RTIH AI CoE <no-reply@rtih.co.in>";
  const replyTo = Deno.env.get("MAIL_REPLY_TO") ?? undefined;
  const results: ("sent" | "failed" | "skipped")[] = [];
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100);
    let status: "sent" | "failed" | "skipped" = "skipped";
    let error: string | null = key ? null : "RESEND_API_KEY not set";
    if (key) {
      try {
        const r = await fetch("https://api.resend.com/emails/batch", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(chunk.map((m) => ({ from, to: [m.to], subject: m.subject, text: m.text, reply_to: replyTo }))),
        });
        status = r.ok ? "sent" : "failed";
        if (!r.ok) error = `${r.status}: ${(await r.text()).slice(0, 300)}`;
      } catch (e) {
        status = "failed";
        error = String(e).slice(0, 300);
      }
      if (i + 100 < items.length) await new Promise((res) => setTimeout(res, 600)); // stay under the rate limit
    }
    await db.from("email_log").insert(chunk.map((m) => ({
      kind: m.kind, to_email: m.to, status, error,
      student_id: m.who?.student_id ?? null, team_id: m.who?.team_id ?? null, college_id: m.who?.college_id ?? null,
    })));
    results.push(...chunk.map(() => status));
  }
  return results;
}

type S = Record<string, any>;
const sign = (s: S) => `\n\nQuestions: ${s.contact}\n\nRTIH AI Centre of Excellence, Visakhapatnam`;
const first = (name: string) => name.split(/\s+/)[0];

export const emails = {
  registeredPay: (st: S, col: S, s: S, link: string) => ({
    subject: `${s.programme}: registration received (${st.reference})`,
    text: `Hi ${first(st.name)},

Thanks for registering for the ${s.programme}. Your reference is ${st.reference}.

One step left: pay the fee of Rs ${s.fee_inr} to ${col.name}. If you haven't finished it, use your personal payment link:
${link}
${s.deadline ? `\nPlease pay before ${s.deadline}.` : ""}
Pay only your college, using the details on that page. RTIH never asks you to pay anyone else.${sign(s)}`,
  }),

  registeredCollegePays: (st: S, col: S, s: S) => ({
    subject: `${s.programme}: registration received (${st.reference})`,
    text: `Hi ${first(st.name)},

Thanks for registering for the ${s.programme}. Your reference is ${st.reference}.

${col.name} is paying the fee for its students, so you don't need to pay anything. Your college will confirm your place, and we will email you when it does.${sign(s)}`,
  }),

  paymentReceived: (st: S, col: S, s: S) => ({
    subject: `${s.programme}: registration complete (${st.reference})`,
    text: `Hi ${first(st.name)},

Your registration is complete. We have your payment details:
  Reference: ${st.reference}
  Paid by: ${st.payment_mode}${st.payment_ref ? ` (${st.payment_mode === "Cash" ? "receipt" : "reference ending"} ${st.payment_ref})` : ""}

${st.payment_mode === "Cash"
      ? `If you haven't paid yet, pay Rs ${s.fee_inr} in cash at ${col.cash_at} and keep the receipt.`
      : `${col.name} will check your payment against its records.`} We will email you as soon as your place is confirmed.${sign(s)}`,
  }),

  confirmed: (st: S, s: S) => ({
    subject: `${s.programme}: your place is confirmed`,
    text: `Hi ${first(st.name)},

Your place in the ${s.programme} is confirmed (reference ${st.reference}).

What happens next:
  1. After registration closes we form mixed teams of four and email you your team, teammates and role.
  2. Live sessions: ${s.session_info}. Each week's guide covers everything, so attending is optional.
  3. Create a GitHub account now if you don't have one: https://github.com/signup${sign(s)}`,
  }),

  rejected: (st: S, reason: string, link: string, s: S) => ({
    subject: `${s.programme}: we could not confirm your payment`,
    text: `Hi ${first(st.name)},

Your college could not confirm your payment for reference ${st.reference}.

Reason: ${reason}

Please check the details and submit them again here:
${link}${sign(s)}`,
  }),

  reminder: (st: S, link: string, s: S) => ({
    subject: `${s.programme}: complete your payment by ${s.deadline}`,
    text: `Hi ${first(st.name)},

You registered for the ${s.programme} (reference ${st.reference}) but we don't have your payment details yet. Registration closes on ${s.deadline}.

Finish here:
${link}${sign(s)}`,
  }),

  team: (st: S, team: S, members: S[], holder: S, s: S) => ({
    subject: `${s.programme}: you're in ${team.name}`,
    text: `Hi ${first(st.name)},

Welcome to ${team.name}!

Your team:
${members.map((m) => `  - ${m.name} (${m.team_role ?? "member"}), ${m.email}${m.consent_share_phone ? `, +91 ${m.phone}` : ""}`).join("\n")}

Your role is ${st.team_role ?? "to be agreed with your team"}. Roles are a suggestion: swap them if you like, but every role needs one owner.

Your team's OpenAI API key goes to ${holder.name}, who looks after it. They will share it with you privately. Never post the key in a group chat, a screenshot or your repository.

How to start:
  1. Make a WhatsApp group for your team and agree a time for a 20-minute weekly call.
  2. Week 1 guide: ${s.guide_link ?? "coming before the first session"}
  3. Live session: ${s.session_info}${s.session_link ? `, ${s.session_link}` : ""}${sign(s)}`,
  }),

  key: (holder: S, team: S, key: string, s: S) => ({
    subject: `${s.programme}: ${team.name} API key (keep private)`,
    text: `Hi ${first(holder.name)},

You look after the OpenAI API key for ${team.name}.

  API key: ${key}
  Spending limit: about $10 for the whole programme. When it is used up, the key stops working.

Rules:
  - Share it with your teammates only in private messages, never in the group chat.
  - Keep it in a .env file that git ignores. Never commit it, screenshot it or put it in your deployed app.
  - If it leaks, tell us at once at ${s.contact} so we can replace it.

Delete this email once you have saved the key somewhere safe.${sign(s)}`,
  }),
};

// Signed-in staff only. Every change in the admin UI comes through here, so the role is checked on the
// server, the change is written to the audit log, and the right email goes out.
import { audit, db, getSettings, payLink, safeText, serve, str, UserError } from "../_shared/common.ts";
import { emails, sendBatch, sendEmail } from "../_shared/email.ts";

const KEY_ROLE = "Infra and testing";
type Staff = { email: string; role: "admin" | "coordinator"; college_id: string | null };

async function whoIs(req: Request): Promise<Staff> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = await db.auth.getUser(jwt);
  const email = data.user?.email?.toLowerCase();
  if (!email) throw new UserError("Please sign in again.");
  const { data: staff } = await db.from("staff").select("email, role, college_id").eq("email", email).maybeSingle();
  if (!staff) throw new UserError("This email is not on the staff list.");
  return staff as Staff;
}

const adminOnly = (me: Staff) => { if (me.role !== "admin") throw new UserError("Only RTIH admins can do this."); };
const ownCollege = (me: Staff, college: string) => {
  if (me.role !== "admin" && me.college_id !== college) throw new UserError("That student is not in your college.");
};

async function student(id: string) {
  const { data } = await db.from("students").select("*").eq("id", str(id, 40)).maybeSingle();
  if (!data) throw new UserError("Student not found.");
  return data;
}

/** Team emails for the given teams; `only` picks which members still need one. */
async function emailTeams(teams: any[], college: string, s: any, only: (m: any, t: any) => boolean = () => true) {
  if (!teams.length) return { emails_sent: 0, emails_failed: 0 };
  const { data: members } = await db.from("students").select("*").in("team_id", teams.map((t) => t.id));
  const items: Parameters<typeof sendBatch>[0] = [];
  for (const t of teams) {
    const ms = (members ?? []).filter((m) => m.team_id === t.id);
    const holder = ms.find((m) => m.team_role === KEY_ROLE) ?? ms[0];
    for (const m of ms) {
      if (!only(m, t)) continue;
      const e = emails.team(m, t, ms, holder, s);
      items.push({ kind: "team", to: m.email, subject: e.subject, text: e.text, who: { student_id: m.id, team_id: t.id, college_id: college } });
    }
  }
  const res = await sendBatch(items);
  return { emails_sent: res.filter((x) => x === "sent").length, emails_failed: res.filter((x) => x !== "sent").length };
}

serve(async (req, b) => {
  const me = await whoIs(req);
  const s = await getSettings();
  const a = str(b.action, 40);

  // ------------------------------------------------ payments
  if (a === "verify") {
    const st = await student(b.student_id);
    ownCollege(me, st.college_id);
    if (!["registered", "payment_submitted", "rejected"].includes(st.status)) throw new UserError(`This student is already ${st.status}.`);
    // Only act on the submission the staff member was looking at.
    const seen = typeof b.seen_submitted_at === "string" ? b.seen_submitted_at : null;
    const guarded = (q: any) => {
      q = q.eq("id", st.id).in("status", ["registered", "payment_submitted", "rejected"]);
      return seen ? q.eq("payment_submitted_at", seen) : q.is("payment_submitted_at", null);
    };
    const changed = new UserError("The student changed their payment details a moment ago. Reload and check again.");
    const { data: col } = await db.from("colleges").select("payer").eq("id", st.college_id).single();
    if (b.approve === true) {
      const { data: done } = await guarded(db.from("students").update({ status: "confirmed", rejected_reason: null, verified_by: me.email, verified_at: new Date().toISOString() })).select("id");
      if (!done?.length) throw changed;
      await audit(me.email, "payment_confirmed", st.reference);
      const m = emails.confirmed(st, s);
      await sendEmail("confirmed", st.email, m.subject, m.text, { student_id: st.id, college_id: st.college_id });
      return { status: "confirmed" };
    }
    if (col?.payer === "college") throw new UserError("This college pays for its students, so there is no payment to reject. Withdraw the student instead.");
    const reason = safeText(str(b.reason, 300));
    if (reason.length < 5) throw new UserError("Write a short reason the student will see.");
    const { data: done } = await guarded(db.from("students").update({ status: "rejected", rejected_reason: reason, verified_by: me.email, verified_at: new Date().toISOString() })).select("id");
    if (!done?.length) throw changed;
    await audit(me.email, "payment_rejected", st.reference, { reason });
    const m = emails.rejected(st, reason, payLink(s, st.pay_token, req), s);
    await sendEmail("rejected", st.email, m.subject, m.text, { student_id: st.id, college_id: st.college_id });
    return { status: "rejected" };
  }

  if (a === "withdraw") {
    const st = await student(b.student_id);
    ownCollege(me, st.college_id);
    if (st.team_id) {
      const { data: t } = await db.from("teams").select("status").eq("id", st.team_id).single();
      if (t?.status === "published") throw new UserError("This student is in a published team. Ask an RTIH admin.");
    }
    await db.from("students").update({ status: "withdrawn", team_id: null, team_role: null }).eq("id", st.id);
    await audit(me.email, "withdrawn", st.reference, { reason: safeText(str(b.reason, 300)) });
    return { status: "withdrawn" };
  }

  if (a === "resend") {
    const st = await student(b.student_id);
    ownCollege(me, st.college_id);
    const { data: col } = await db.from("colleges").select("*").eq("id", st.college_id).single();
    let m;
    if (st.status === "confirmed") m = emails.confirmed(st, s);
    else if (st.status === "rejected") m = emails.rejected(st, st.rejected_reason ?? "", payLink(s, st.pay_token, req), s);
    else if (col.payer === "college") m = emails.registeredCollegePays(st, col, s);
    else m = emails.registeredPay(st, col, s, payLink(s, st.pay_token, req));
    const status = await sendEmail("resend_" + st.status, st.email, m.subject, m.text, { student_id: st.id, college_id: st.college_id });
    await audit(me.email, "email_resent", st.reference);
    return { email: status };
  }

  // ------------------------------------------------ teams (admins)
  if (a === "save_teams") {
    adminOnly(me);
    const college = str(b.college_id, 40);
    const teams = Array.isArray(b.teams) ? b.teams : [];
    const { data: n, error } = await db.rpc("app_save_teams", { p_college: college, p_teams: teams });
    if (error) {
      if (error.code === "23505") throw new UserError("A team name is already used. Generate again or rename.");
      if (error.code === "P0001") throw new UserError(error.message);
      throw error;
    }
    await audit(me.email, "teams_saved", college, { teams: n });
    return { teams: n };
  }

  if (a === "publish_teams") {
    adminOnly(me);
    const college = str(b.college_id, 40);
    const { data: drafts } = await db.from("teams").select("id, name").eq("college_id", college).eq("status", "draft");
    if (!drafts?.length) throw new UserError("No draft teams to publish. Generate and save teams first.");
    const { data: dm } = await db.from("students").select("team_id").in("team_id", drafts.map((t) => t.id));
    const small = drafts.filter((t) => (dm ?? []).filter((m) => m.team_id === t.id).length < 2);
    if (small.length) throw new UserError(`These teams have fewer than 2 members: ${small.map((t) => t.name).join(", ")}`);
    // Claim the drafts first, so a second click or a parallel save can't email anyone twice or lose teams.
    const { data: teams } = await db.from("teams").update({ status: "published", published_at: new Date().toISOString() })
      .eq("college_id", college).eq("status", "draft").select("*");
    if (!teams?.length) throw new UserError("These teams were just published by someone else. Reload.");
    const r = await emailTeams(teams, college, s);
    await audit(me.email, "teams_published", college, { teams: teams.length, ...r });
    return { teams: teams.length, ...r };
  }

  if (a === "resend_team_emails") {
    adminOnly(me);
    const college = str(b.college_id, 40);
    const { data: teams } = await db.from("teams").select("*").eq("college_id", college).eq("status", "published");
    const { data: sentLog } = await db.from("email_log").select("student_id, team_id").eq("college_id", college).eq("kind", "team").eq("status", "sent");
    const done = new Set((sentLog ?? []).map((l) => `${l.student_id}|${l.team_id}`));
    const r = await emailTeams(teams ?? [], college, s, (m, t) => !done.has(`${m.id}|${t.id}`));
    await audit(me.email, "team_emails_resent", college, r);
    return r;
  }

  if (a === "set_key") {
    adminOnly(me);
    const key = str(b.key, 300);
    if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(key)) throw new UserError("That doesn't look like an OpenAI API key (it should start with sk-).");
    const { data: t } = await db.from("teams").select("id, name, status").eq("id", str(b.team_id, 40)).maybeSingle();
    if (!t) throw new UserError("Team not found.");
    if (t.status !== "published") throw new UserError("Publish the teams before adding keys.");
    const { error } = await db.rpc("app_store_team_key", { p_team: t.id, p_key: key });
    if (error) throw error;
    await audit(me.email, "key_saved", t.name, { last4: key.slice(-4) });
    return { last4: key.slice(-4) };
  }

  if (a === "send_keys") {
    adminOnly(me);
    const college = str(b.college_id, 40);
    const { data: teams } = await db.from("teams").select("*").eq("college_id", college).eq("status", "published")
      .is("key_sent_at", null).not("key_secret_id", "is", null);
    let sent = 0;
    const failed: string[] = [];
    for (const t of teams ?? []) {
      const { data: ms } = await db.from("students").select("*").eq("team_id", t.id);
      const holder = (ms ?? []).find((m) => m.team_role === KEY_ROLE) ?? (ms ?? [])[0];
      const { data: key } = await db.rpc("app_get_team_key", { p_team: t.id });
      if (!holder || !key) { failed.push(t.name); continue; }
      const e = emails.key(holder, t, key as string, s);
      const st = await sendEmail("api_key", holder.email, e.subject, e.text, { student_id: holder.id, team_id: t.id, college_id: college });
      if (st === "sent") {
        sent++;
        await db.from("teams").update({ key_sent_at: new Date().toISOString() }).eq("id", t.id);
      } else failed.push(t.name);
    }
    const { count: missing } = await db.from("teams").select("id", { count: "exact", head: true })
      .eq("college_id", college).eq("status", "published").is("key_secret_id", null);
    await audit(me.email, "keys_sent", college, { sent, failed });
    return { sent, failed, teams_without_key: missing ?? 0 };
  }

  if (a === "delete_keys") {
    adminOnly(me);
    const college = str(b.college_id, 40);
    const { data: n } = await db.rpc("app_delete_team_keys", { p_college: college });
    await audit(me.email, "keys_deleted", college, { keys: n });
    return { deleted: n };
  }

  // ------------------------------------------------ setup (admins)
  if (a === "save_college") {
    adminOnly(me);
    const c = b.college ?? {};
    const row = {
      id: str(c.id, 30).toLowerCase(), name: str(c.name, 120), payer: c.payer === "college" ? "college" : "students",
      payee_name: str(c.payee_name, 120) || null, upi_id: str(c.upi_id, 80) || null, qr_image_url: str(c.qr_image_url, 500) || null,
      bank_account_name: str(c.bank_account_name, 120) || null, bank_name: str(c.bank_name, 120) || null,
      bank_account_number: str(c.bank_account_number, 40) || null, bank_ifsc: str(c.bank_ifsc, 20).toUpperCase() || null,
      cash_at: str(c.cash_at, 200) || null, seat_limit: Number(c.seat_limit) > 0 ? Number(c.seat_limit) : null,
      active: c.active !== false,
    };
    if (!/^[a-z0-9-]{2,30}$/.test(row.id)) throw new UserError("College id: 2 to 30 lowercase letters, digits or hyphens.");
    if (!row.name) throw new UserError("College name is required.");
    if (row.payer === "students" && !row.upi_id && !row.bank_account_number && !row.cash_at) {
      throw new UserError("A college whose students pay needs a UPI ID, bank details or a cash counter.");
    }
    const { error } = await db.from("colleges").upsert(row);
    if (error) throw error;
    await audit(me.email, "college_saved", row.id, row);
    return { id: row.id };
  }

  if (a === "add_staff") {
    adminOnly(me);
    const row = {
      email: str(b.email, 120).toLowerCase(), name: str(b.name, 80) || null,
      role: b.role === "admin" ? "admin" : "coordinator", college_id: b.role === "admin" ? null : str(b.college_id, 40),
    };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(row.email)) throw new UserError("Enter a valid email.");
    if (row.role === "coordinator" && !row.college_id) throw new UserError("Choose the coordinator's college.");
    const { error } = await db.from("staff").upsert(row);
    if (error) throw error;
    await audit(me.email, "staff_added", row.email, row);
    return { email: row.email };
  }

  if (a === "remove_staff") {
    adminOnly(me);
    const email = str(b.email, 120).toLowerCase();
    if (email === me.email) throw new UserError("You can't remove yourself.");
    await db.from("staff").delete().eq("email", email);
    await audit(me.email, "staff_removed", email);
    return { email };
  }

  if (a === "save_settings") {
    adminOnly(me);
    const x = b.settings ?? {};
    const row = {
      programme: str(x.programme, 120) || s.programme,
      fee_inr: Number.isFinite(Number(x.fee_inr)) ? Math.max(0, Math.round(Number(x.fee_inr))) : s.fee_inr,
      registration_open: x.registration_open === true,
      deadline: /^\d{4}-\d{2}-\d{2}$/.test(str(x.deadline, 10)) ? x.deadline : null,
      contact: str(x.contact, 120) || s.contact,
      session_info: str(x.session_info, 200) || s.session_info,
      session_link: str(x.session_link, 300) || null,
      guide_link: str(x.guide_link, 300) || null,
      site_url: str(x.site_url, 200) || null,
      updated_at: new Date().toISOString(),
    };
    await db.from("settings").update(row).eq("id", 1);
    await audit(me.email, "settings_saved", null, row);
    return {};
  }

  throw new UserError("Unknown action.");
});

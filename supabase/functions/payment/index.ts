// Public, by personal token: shows a student their college's payment options, and takes their payment details.
import { db, decodeBase64, getSettings, MAX_PROOF_BYTES, PROOF_TYPES, serve, str, UserError } from "../_shared/common.ts";
import { emails, sendEmail } from "../_shared/email.ts";

const PUBLIC_COLLEGE = "id, name, payer, payee_name, upi_id, qr_image_url, bank_account_name, bank_name, bank_account_number, bank_ifsc, cash_at";

serve(async (_req, b) => {
  const token = str(b.token, 60);
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw new UserError("This payment link is not valid. Use the link from your email.");
  const { data: st } = await db.from("students")
    .select("id, reference, name, email, college_id, status, payment_mode, payment_ref, rejected_reason, payment_proof_path")
    .eq("pay_token", token).maybeSingle();
  if (!st) throw new UserError("This payment link is not valid. Use the link from your email.");
  const s = await getSettings();
  const { data: col } = await db.from("colleges").select(PUBLIC_COLLEGE).eq("id", st.college_id).single();

  if (b.action === "get") {
    return {
      student: { reference: st.reference, name: st.name, status: st.status, payment_mode: st.payment_mode, payment_ref: st.payment_ref, rejected_reason: st.rejected_reason },
      college: col,
      fee_inr: s.fee_inr, deadline: s.deadline, contact: s.contact, programme: s.programme,
    };
  }

  if (b.action !== "submit") throw new UserError("Unknown action.");
  if (col!.payer === "college") throw new UserError("Your college pays your fee; there is nothing to pay.");
  if (st.status === "confirmed") throw new UserError("Your payment is already confirmed.");
  if (st.status === "withdrawn") throw new UserError(`This registration was withdrawn. Contact ${s.contact}.`);

  const mode = str(b.mode, 20);
  const ref = str(b.ref, 20).replace(/\s/g, "").toUpperCase();
  const modes = ["UPI", "Bank transfer", ...(col!.cash_at ? ["Cash"] : [])];
  if (!modes.includes(mode)) throw new UserError("Choose how you are paying.");
  if (mode === "UPI" && !/^\d{6}$/.test(ref)) throw new UserError("Enter the last 6 digits of the UTR.");
  if (mode === "Bank transfer" && !/^[A-Z0-9]{6}$/.test(ref)) throw new UserError("Enter the last 6 characters of the bank reference.");
  if (mode === "Cash" && ref && !/^[A-Z0-9\-\/]{1,20}$/.test(ref)) throw new UserError("Use only letters and numbers from your receipt.");

  let path: string | null = null;
  const f = b.file;
  if (f) {
    const ext = PROOF_TYPES[str(f.type, 40)];
    if (!ext || typeof f.base64 !== "string") throw new UserError("Upload a JPG, PNG or PDF file.");
    const bytes = decodeBase64(f.base64);
    if (bytes.length > MAX_PROOF_BYTES) throw new UserError("The file is over 2 MB.");
    path = `${st.college_id}/${st.reference}-${Date.now()}.${ext}`;
    const { error } = await db.storage.from("payment-proofs").upload(path, bytes, { contentType: f.type });
    if (error) throw error;
  } else if (mode !== "Cash") {
    throw new UserError("Upload a screenshot of your payment.");
  }

  const { data: upd, error } = await db.from("students").update({
    status: "payment_submitted", payment_mode: mode, payment_ref: ref || null,
    payment_proof_path: path, payment_submitted_at: new Date().toISOString(), rejected_reason: null,
  }).eq("id", st.id).in("status", ["registered", "payment_submitted", "rejected"])
    .select("id, reference, name, payment_mode, payment_ref").maybeSingle();
  if (!error && !upd) {
    if (path) await db.storage.from("payment-proofs").remove([path]);
    throw new UserError("Your registration changed while you were submitting (it may have just been confirmed). Reload the page.");
  }
  if (error) {
    if (path) await db.storage.from("payment-proofs").remove([path]);
    if (error.code === "23505") {
      throw new UserError(`Another registration already used this payment reference. If two payments really share these characters, email ${s.contact}.`);
    }
    throw error;
  }

  if (st.payment_proof_path && st.payment_proof_path !== path) await db.storage.from("payment-proofs").remove([st.payment_proof_path]);
  const m = emails.paymentReceived(upd!, col!, s);
  await sendEmail("payment_received", st.email, m.subject, m.text, { student_id: st.id, college_id: st.college_id });
  return { reference: st.reference, status: "payment_submitted" };
});
